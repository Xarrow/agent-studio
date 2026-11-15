"""知识中心接口：文档上传/列表/详情/正文/原件、存储配置与检索。

分层：这里只做 HTTP 语义（参数、状态码、权限范围），
入库/解析/检索都在 knowledge.service 与 parsers/storage 里。
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..security.crypto import encrypt
from ..knowledge import service, storage
from ..knowledge.models import Doc, DocChunk, StorageConfig

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])

#: 单文件上限（100MB，可被设置覆盖；这里先固定）
MAX_BYTES = 100 * 1024 * 1024


def _doc_view(row: Doc, *, with_text: bool = False) -> dict[str, Any]:
    return {
        "id": row.id,
        "name": row.name,
        "kind": row.kind,
        "mime": row.mime,
        "size": row.size,
        "sha256": row.sha256,
        "source": row.source,
        "source_url": row.source_url,
        "storage_id": row.storage_id,
        "storage_path": row.storage_path,
        "category_id": row.category_id,
        "sub_category": row.sub_category,
        "tags": row.tags or [],
        "status": row.status,
        "error": row.error or {},
        "parsed": row.parsed or {},
        "version": row.version,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


@router.post("/documents", status_code=status.HTTP_201_CREATED)
async def upload_documents(
    files: list[UploadFile] = File(...),
    category: str = Form(default="未分类"),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """多文件上传：立即建记录（列表马上能看到），解析在后台跑。"""
    created: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []
    for f in files:
        data = await f.read()
        if not data:
            continue
        if len(data) > MAX_BYTES:
            raise HTTPException(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                f"「{f.filename}」超过 100MB 上限",
            )
        # 同内容去重：已存在就如实告诉用户（前端可提示"仍然作为新版本添加"）
        import hashlib

        digest = hashlib.sha256(data).hexdigest()
        same = (
            await session.execute(select(Doc).where(Doc.sha256 == digest))
        ).scalars().first()
        if same is not None:
            duplicates.append({"id": same.id, "name": same.name, "sha256": digest})
            continue
        doc = await service.ingest_bytes(
            session,
            name=f.filename or "未命名",
            data=data,
            mime=f.content_type or "",
            category=category,
        )
        created.append(_doc_view(doc))
        asyncio.create_task(_parse_later(doc.id))

    return {"documents": created, "duplicates": duplicates}


async def _parse_later(doc_id: str) -> None:
    """后台解析（独立 session，失败只记日志，状态由 parse_doc 落库）。"""
    from ..db import SessionLocal

    try:
        async with SessionLocal() as s:
            await service.parse_doc(s, doc_id)
    except Exception:  # noqa: BLE001
        logger.exception("文档解析任务失败：%s", doc_id)


@router.get("/documents")
async def list_documents(
    q: str = Query(default=""),
    status_filter: str = Query(default="", alias="status"),
    kind: str = Query(default=""),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    conds = []
    if q:
        like = f"%{q}%"
        conds.append(Doc.name.ilike(like))
    if status_filter:
        conds.append(Doc.status == status_filter)
    if kind:
        conds.append(Doc.kind == kind)
    total = (
        await session.execute(select(func.count()).select_from(Doc).where(*conds))
    ).scalar_one()
    rows = (
        await session.execute(
            select(Doc).where(*conds).order_by(Doc.updated_at.desc()).limit(limit).offset(offset)
        )
    ).scalars().all()
    return {"total": total, "items": [_doc_view(r) for r in rows]}


@router.get("/search")
async def search_docs(
    q: str = Query(default=""),
    limit: int = Query(default=30, ge=1, le=100),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return {"items": await service.search(session, q, limit=limit)}


@router.get("/documents/{doc_id}")
async def get_document(doc_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    row = await session.get(Doc, doc_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文档不存在")
    chunks = (
        await session.execute(
            select(func.count()).select_from(DocChunk).where(DocChunk.doc_id == doc_id)
        )
    ).scalar_one()
    out = _doc_view(row)
    out["chunks"] = chunks
    return out


@router.get("/documents/{doc_id}/text")
async def get_text(
    doc_id: str,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=200),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    rows = (
        await session.execute(
            select(DocChunk)
            .where(DocChunk.doc_id == doc_id)
            .order_by(DocChunk.ord)
            .limit(limit)
            .offset(offset)
        )
    ).scalars().all()
    return {
        "chunks": [
            {"ord": c.ord, "text": c.text, "page": c.page, "sheet": c.sheet} for c in rows
        ]
    }


@router.get("/documents/{doc_id}/original")
async def download_original(doc_id: str, session: AsyncSession = Depends(get_session)) -> StreamingResponse:
    row = await session.get(Doc, doc_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文档不存在")
    cfg = await session.get(StorageConfig, row.storage_id) if row.storage_id else None
    cfg = cfg or await service.default_storage(session)
    try:
        data = service.provider_of(cfg).get_bytes(row.storage_key)
    except storage.StorageError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, f"存储读不到原件：{exc}") from exc
    return StreamingResponse(
        io.BytesIO(data),
        media_type=row.mime or "application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{row.name}"'},
    )


@router.patch("/documents/{doc_id}")
async def patch_document(
    doc_id: str, payload: dict[str, Any], session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    row = await session.get(Doc, doc_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文档不存在")
    if "name" in payload and str(payload["name"]).strip():
        row.name = str(payload["name"]).strip()[:300]
    if "category" in payload:
        row.category_id = str(payload["category"])[:32]
    if "sub_category" in payload:
        row.sub_category = str(payload["sub_category"])[:120]
    if "tags" in payload and isinstance(payload["tags"], list):
        row.tags = [str(t)[:40] for t in payload["tags"]][:30]
    import time

    row.updated_at = int(time.time() * 1000)
    await session.commit()
    await session.refresh(row)
    return _doc_view(row)


@router.post("/documents/{doc_id}/reparse")
async def reparse(doc_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    row = await session.get(Doc, doc_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文档不存在")
    row.status = "parsing"
    row.error = {}
    await session.commit()
    asyncio.create_task(_parse_later(doc_id))
    return {"ok": True}


@router.delete("/documents/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(doc_id: str, session: AsyncSession = Depends(get_session)) -> None:
    row = await session.get(Doc, doc_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文档不存在")
    cfg = await session.get(StorageConfig, row.storage_id) if row.storage_id else None
    if cfg is not None:
        try:
            service.provider_of(cfg).delete(row.storage_key)
        except storage.StorageError:
            logger.warning("删除原件失败（记录照删）：%s", row.storage_key)
    await session.execute(delete(DocChunk).where(DocChunk.doc_id == doc_id))
    await session.delete(row)
    await session.commit()


# --------------------------------------------------------------------------- #
# 存储配置
# --------------------------------------------------------------------------- #
def _storage_view(cfg: StorageConfig) -> dict[str, Any]:
    params = dict(cfg.params or {})
    return {
        "id": cfg.id,
        "name": cfg.name,
        "type": cfg.type,
        "params": params,
        "path_template": cfg.path_template,
        "is_default": bool(cfg.is_default),
        "has_secret": bool(cfg.secret_enc),
        "last_test_ok": None if cfg.last_test_ok is None else bool(cfg.last_test_ok),
        "last_test_at": cfg.last_test_at,
        "last_test_error": cfg.last_test_error or "",
    }


@router.get("/storage")
async def list_storage(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    rows = (await session.execute(select(StorageConfig).order_by(StorageConfig.created_at))).scalars().all()
    if not rows:
        rows = [await service.default_storage(session)]
    return {"items": [_storage_view(r) for r in rows]}


@router.post("/storage", status_code=status.HTTP_201_CREATED)
async def create_storage(payload: dict[str, Any], session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    kind = str(payload.get("type") or "local")
    if kind not in ("local", "s3"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "首期只支持 local / s3")
    params = payload.get("params") or {}
    if not isinstance(params, dict):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "params 必须是对象")
    secrets = payload.get("secrets") or {}
    row = StorageConfig(
        name=str(payload.get("name") or ("本地存储" if kind == "local" else "S3 存储"))[:120],
        type=kind,
        params={k: str(v) for k, v in params.items()},
        path_template=str(payload.get("path_template") or "{category}/{year}/{name}"),
        secret_enc=encrypt(json.dumps(secrets)) if secrets else None,
        is_default=1 if payload.get("is_default") else 0,
    )
    if row.is_default:
        for other in (await session.execute(select(StorageConfig))).scalars().all():
            other.is_default = 0
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _storage_view(row)


@router.post("/storage/{cfg_id}/test")
async def test_storage(cfg_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    cfg = await session.get(StorageConfig, cfg_id)
    if cfg is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "存储配置不存在")
    import time

    try:
        got = service.provider_of(cfg).test()
        cfg.last_test_ok = 1
        cfg.last_test_error = ""
        cfg.last_test_at = int(time.time() * 1000)
        await session.commit()
        return {"ok": True, **got}
    except storage.StorageError as exc:
        cfg.last_test_ok = 0
        cfg.last_test_error = str(exc)[:500]
        cfg.last_test_at = int(time.time() * 1000)
        await session.commit()
        return {"ok": False, "error": str(exc)}


@router.post("/storage/{cfg_id}/default")
async def set_default_storage(cfg_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    cfg = await session.get(StorageConfig, cfg_id)
    if cfg is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "存储配置不存在")
    for other in (await session.execute(select(StorageConfig))).scalars().all():
        other.is_default = 1 if other.id == cfg.id else 0
    await session.commit()
    return {"ok": True}
