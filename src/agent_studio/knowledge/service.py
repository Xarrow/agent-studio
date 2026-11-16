"""知识库服务层：存储配置解析、入库、解析、检索。

接口层只做参数校验与序列化，真正的东西都在这里，
这样后台任务（解析/抓取/迁移）与 HTTP 请求走同一套逻辑。
"""

from __future__ import annotations

import hashlib
import io
import logging
import time
from pathlib import Path
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..security.crypto import decrypt
from . import parsers, storage
from .models import Doc, DocChunk, StorageConfig

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# 存储配置
# --------------------------------------------------------------------------- #
def _decrypt_secrets(cfg: StorageConfig) -> dict[str, str]:
    if not cfg.secret_enc:
        return {}
    try:
        import json

        raw = decrypt(cfg.secret_enc) if isinstance(cfg.secret_enc, (bytes, bytearray)) else str(cfg.secret_enc)
        return json.loads(raw)
    except Exception:  # noqa: BLE001 —— 解不开就当没配，让测试连接报"密钥无效"
        return {}


def provider_of(cfg: StorageConfig) -> storage.BaseProvider:
    setattr(cfg, "_secrets", _decrypt_secrets(cfg))
    return storage.build_provider(cfg)


async def default_storage(session: AsyncSession) -> StorageConfig:
    """当前默认存储；没有就自动建一个本地默认（首次使用零配置）。"""
    row = (
        await session.execute(select(StorageConfig).where(StorageConfig.is_default == 1))
    ).scalars().first()
    if row is not None:
        return row
    row = (
        await session.execute(select(StorageConfig).order_by(StorageConfig.created_at))
    ).scalars().first()
    if row is not None:
        row.is_default = 1
        await session.commit()
        return row
    root = Path(settings.work_dir) / "knowledge"
    row = StorageConfig(
        name="本地存储（默认）",
        type="local",
        params={"root": str(root)},
        path_template="{category}/{year}/{name}",
        is_default=1,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    logger.info("已创建默认本地存储：%s", root)
    return row


# --------------------------------------------------------------------------- #
# 入库
# --------------------------------------------------------------------------- #
def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


async def ingest_bytes(
    session: AsyncSession,
    *,
    name: str,
    data: bytes,
    mime: str = "",
    source: str = "upload",
    source_url: str = "",
    category: str = "未分类",
    category_id: str = "",
) -> Doc:
    """存原件 + 建记录（解析交给调用方排队/后台跑）。"""
    cfg = await default_storage(session)
    prov = provider_of(cfg)
    digest = _sha(data)
    kind = parsers.detect_kind(name, mime, data[:8])
    key = storage.object_key(digest, name, category=category)
    put = prov.put_stream(key, io.BytesIO(data), content_type=mime)

    row = Doc(
        name=name,
        kind=kind,
        mime=mime,
        size=len(data),
        sha256=digest,
        source=source,
        source_url=source_url,
        storage_id=cfg.id,
        storage_key=put.key,
        storage_path=prov.display_path(put.key),
        category_id=category_id,
        status="parsing",
        parsed={},
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def resolve_category(session: AsyncSession, name: str) -> str:
    """按分类名拿 id；没有就建一个（用户显式选的分类直接算 user origin）。"""
    from .models import Category

    clean = (name or "未分类").strip() or "未分类"
    row = (
        await session.execute(select(Category).where(Category.name == clean, Category.parent_id == ""))
    ).scalars().first()
    if row is not None:
        return row.id
    row = Category(name=clean[:120], depth=1, origin="user", locked=1)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row.id


async def parse_doc(session: AsyncSession, doc_id: str) -> Doc | None:
    """读出原件 → 解析 → 写分块与状态。失败落 failed + 人话原因。"""
    stamp = time.time()
    doc = await session.get(Doc, doc_id)
    if doc is None:
        return None
    cfg = await session.get(StorageConfig, doc.storage_id) if doc.storage_id else None
    cfg = cfg or await default_storage(session)
    try:
        prov = provider_of(cfg)
        data = prov.get_bytes(doc.storage_key)
        parsed = parsers.parse_bytes(doc.kind, data, doc.name)
    except (storage.StorageError, parsers.ParseError, OSError) as exc:
        doc.status = "failed"
        doc.error = {"code": "parse_failed", "message": str(exc)[:300], "retryable": True}
        doc.updated_at = int(time.time() * 1000)
        await session.commit()
        return doc
    except Exception as exc:  # noqa: BLE001 —— 解析器的意外错误也要落终态
        doc.status = "failed"
        doc.error = {"code": "internal", "message": f"解析出错：{str(exc)[:200]}", "retryable": True}
        doc.updated_at = int(time.time() * 1000)
        await session.commit()
        return doc

    # 重解析：先清旧块（同 doc 只保留一份当前版本正文）
    from sqlalchemy import delete as _delete

    await session.execute(_delete(DocChunk).where(DocChunk.doc_id == doc.id))
    for i, c in enumerate(parsed.chunks):
        session.add(
            DocChunk(
                doc_id=doc.id,
                doc_version=doc.version,
                ord=i,
                text=c.get("text") or "",
                page=c.get("page"),
                sheet=c.get("sheet") or "",
            )
        )
    doc.status = "ready"
    doc.error = {}
    doc.parsed = parsed.summary(int((time.time() - stamp) * 1000))
    doc.updated_at = int(time.time() * 1000)
    await session.commit()
    await session.refresh(doc)
    return doc


# --------------------------------------------------------------------------- #
# 检索
# --------------------------------------------------------------------------- #
async def search(
    session: AsyncSession, q: str, *, limit: int = 30, kind: str = "", status: str = ""
) -> list[dict[str, Any]]:
    """按文档聚合的全文检索：返回命中片段（不返回整篇）。

    先用 SQL LIKE 落在 doc_chunk 上（当前数据量足够快），
    命中后按文档聚合、取第一条命中做片段。
    """
    text = (q or "").strip()
    conditions = []
    if text:
        like = f"%{text}%"
        conditions.append(or_(DocChunk.text.ilike(like), Doc.name.ilike(like)))
    if kind:
        conditions.append(Doc.kind == kind)
    if status:
        conditions.append(Doc.status == status)

    stmt = (
        select(DocChunk, Doc)
        .join(Doc, Doc.id == DocChunk.doc_id)
        .where(*conditions)
        .order_by(Doc.updated_at.desc())
        .limit(limit * 6)
    )
    rows = (await session.execute(stmt)).all()
    seen: dict[str, dict[str, Any]] = {}
    for chunk, doc in rows:
        if doc.id in seen:
            continue
        snippet = chunk.text or ""
        if text and text in snippet:
            i = snippet.find(text)
            snippet = snippet[max(0, i - 60) : i + 160]
        seen[doc.id] = {
            "id": doc.id,
            "name": doc.name,
            "kind": doc.kind,
            "status": doc.status,
            "snippet": snippet.replace("\n", " ")[:240],
            "page": chunk.page,
            "sheet": chunk.sheet,
            "updated_at": doc.updated_at,
        }
        if len(seen) >= limit:
            break
    return list(seen.values())
