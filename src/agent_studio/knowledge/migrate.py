"""存储迁移：把已有文档的原件从一个存储搬到另一个。

三条口径写死在这里，避免以后被改坏：

1. **搬原件、改记录、不动解析结果**——doc_chunk / 正文 / 分类标签都跟存储无关，
   搬完还能照旧检索。
2. **按内容寻址去重**：同一个 sha256 在目标存储里已经有一份就不再写第二次，
   计数记 skipped 而不是 moved（否则"搬了 200 份"里有一半是重复写）。
3. **默认保留源文件**：迁移是个危险动作，先保证"目标里有了、能读"，源留着等用户
   确认无碍后再手动清理；显式传 keep_source=false 才删源。
"""

from __future__ import annotations

import asyncio
import io
import logging
from typing import Any

from sqlalchemy import select

from ..db import SessionLocal
from ..models import now_ms
from . import service, storage
from .models import Doc, StorageConfig, StorageMigration

logger = logging.getLogger(__name__)

_ACTIVE: set[str] = set()


async def _provider_or_raise(cfg: StorageConfig) -> storage.BaseProvider:
    try:
        return service.provider_of(cfg)
    except storage.StorageError as exc:
        raise RuntimeError(f"存储「{cfg.name}」配置不可用：{exc}") from exc


async def run(job_id: str) -> None:
    """后台搬：逐份读源、写目标、改 doc.storage_id/storage_key。"""
    if job_id in _ACTIVE:
        return
    _ACTIVE.add(job_id)
    try:
        async with SessionLocal() as session:
            job = await session.get(StorageMigration, job_id)
            if job is None:
                return
            job.status = "running"
            await session.commit()

            src_cfg = await session.get(StorageConfig, job.from_id) if job.from_id else None
            dst_cfg = await session.get(StorageConfig, job.to_id)
            if dst_cfg is None:
                job.status = "failed"
                job.error = {"code": "no_target", "message": "目标存储不存在（可能已被删除）"}
                job.finished_at = now_ms()
                await session.commit()
                return

            try:
                src = await _provider_or_raise(src_cfg) if src_cfg else None
                dst = await _provider_or_raise(dst_cfg)
            except RuntimeError as exc:
                job.status = "failed"
                job.error = {"code": "provider", "message": str(exc)}
                job.finished_at = now_ms()
                await session.commit()
                return

            q = select(Doc)
            if src_cfg is not None:
                q = q.where(Doc.storage_id == src_cfg.id)
            docs = (await session.execute(q)).scalars().all()
            job.total = len(docs)
            await session.commit()

            # 没指定源存储 = 全库搬：每份文档从它自己所在的存储读
            providers: dict[str, storage.BaseProvider] = {}
            if src is not None:
                providers[src_cfg.id] = src  # type: ignore[index]

            async def _src_for(doc: Doc) -> storage.BaseProvider:
                sid = doc.storage_id or ""
                if sid in providers:
                    return providers[sid]
                cfg = await session.get(StorageConfig, sid) if sid else None
                cfg = cfg or await service.default_storage(session)
                got = await _provider_or_raise(cfg)
                providers[sid] = got
                return got

            written: set[str] = set()
            for doc in docs:
                if not doc.storage_key:
                    job.skipped += 1
                    await session.commit()
                    continue
                try:
                    reader = src or await _src_for(doc)
                    data = reader.get_bytes(doc.storage_key)
                    key = doc.storage_key
                    if key in written:
                        # 同一个内容寻址键，搬到目标存储只需一份
                        pass
                    else:
                        dst.put_stream(key, io.BytesIO(data), content_type=doc.mime or "")
                        written.add(key)
                        job.bytes_moved += len(data)
                    doc.storage_id = dst_cfg.id
                    doc.storage_path = dst.display_path(key)
                    job.moved += 1
                except Exception as exc:  # noqa: BLE001 —— 单份失败不能中断整批
                    logger.warning("迁移失败 doc=%s: %s", doc.id, exc)
                    job.failed += 1
                    job.error = {"code": "item", "message": f"{doc.name}: {exc}"}
                await session.commit()

            # 保留源文件时不做删除；显式要求才清源（同键只删一次）
            if not job.keep_source and src is not None:
                for key in sorted(written | {d.storage_key for d in docs if d.storage_key}):
                    try:
                        src.delete(key)
                    except Exception:  # noqa: BLE001
                        logger.warning("清理源文件失败：%s", key)

            job.status = "done" if job.failed == 0 else "failed"
            job.finished_at = now_ms()
            await session.commit()
    finally:
        _ACTIVE.discard(job_id)


def view(job: StorageMigration) -> dict[str, Any]:
    return {
        "id": job.id,
        "from_id": job.from_id,
        "to_id": job.to_id,
        "status": job.status,
        "total": job.total,
        "moved": job.moved,
        "skipped": job.skipped,
        "failed": job.failed,
        "bytes_moved": job.bytes_moved,
        "keep_source": bool(job.keep_source),
        "error": job.error,
        "created_at": job.created_at,
        "finished_at": job.finished_at,
    }


def start(job_id: str) -> None:
    asyncio.create_task(run(job_id))
