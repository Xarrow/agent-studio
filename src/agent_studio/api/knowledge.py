"""知识中心接口：文档上传/列表/详情/正文/原件、存储配置与检索。

分层：这里只做 HTTP 语义（参数、状态码、权限范围），
入库/解析/检索都在 knowledge.service 与 parsers/storage 里。
"""

from __future__ import annotations

import asyncio
import io
from urllib.parse import quote
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..security.crypto import encrypt
from ..knowledge import fetch_url, migrate as mig, service, storage
from ..knowledge import organize as org
from ..knowledge.models import (
    Category,
    Doc,
    DocChunk,
    DocTag,
    OrganizeDraft,
    OrganizeJob,
    StorageConfig,
)

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
            category_id=await service.resolve_category(session, category),
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
    # 中文文件名不能直接塞进 header（HTTP 头是 latin-1，中文会 500）：
    # ASCII 兜底 + RFC 5987 的 filename* 给浏览器里的真名
    ascii_name = "".join(ch if 32 <= ord(ch) < 127 else "_" for ch in row.name) or "download"
    quoted = quote(row.name, safe="")
    return StreamingResponse(
        io.BytesIO(data),
        media_type=row.mime or "application/octet-stream",
        headers={
            "Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quoted}"
        },
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


# --------------------------------------------------------------------------- #
# 分类与标签（阶段 3）
# --------------------------------------------------------------------------- #
@router.get("/categories")
async def list_categories(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    rows = (await session.execute(select(Category).order_by(Category.depth, Category.name))).scalars().all()
    counts = {
        cid: n
        for cid, n in (
            await session.execute(
                select(Doc.category_id, func.count()).group_by(Doc.category_id)
            )
        ).all()
    }
    return {
        "items": [
            {
                "id": r.id,
                "parent_id": r.parent_id,
                "name": r.name,
                "depth": r.depth,
                "origin": r.origin,
                "locked": bool(r.locked),
                "doc_count": counts.get(r.id, 0),
            }
            for r in rows
        ]
    }


@router.post("/categories", status_code=status.HTTP_201_CREATED)
async def create_category(payload: dict[str, Any], session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "分类名不能为空")
    parent_id = str(payload.get("parent_id") or "")
    depth = 1
    if parent_id:
        parent = await session.get(Category, parent_id)
        if parent is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "上级分类不存在")
        depth = int(parent.depth or 1) + 1
        if depth > 3:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "分类最多 3 层")
    row = Category(name=name[:120], parent_id=parent_id, depth=depth, origin=str(payload.get("origin") or "user"))
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return {"id": row.id, "name": row.name, "parent_id": row.parent_id, "depth": row.depth}


@router.patch("/categories/{cat_id}")
async def rename_category(cat_id: str, payload: dict[str, Any], session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    row = await session.get(Category, cat_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "分类不存在")
    if str(payload.get("name") or "").strip():
        row.name = str(payload["name"]).strip()[:120]
        row.locked = 1 if payload.get("lock", True) else 0
        row.origin = "user"
    await session.commit()
    return {"ok": True}


@router.delete("/categories/{cat_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_category(cat_id: str, session: AsyncSession = Depends(get_session)) -> None:
    """删分类：文档不删，只是回到「未分类」；子分类一并清空归属。"""
    from sqlalchemy import update

    kids = (await session.execute(select(Category).where(Category.parent_id == cat_id))).scalars().all()
    for k in kids:
        k.parent_id = ""
        k.depth = 1
    await session.execute(update(Doc).where(Doc.category_id == cat_id).values(category_id=""))
    row = await session.get(Category, cat_id)
    if row is not None:
        await session.delete(row)
    await session.commit()


@router.get("/tags")
async def list_tags(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    rows = (await session.execute(select(DocTag).order_by(DocTag.name))).scalars().all()
    return {
        "items": [
            {"id": r.id, "name": r.name, "origin": r.origin, "locked": bool(r.locked)} for r in rows
        ]
    }


@router.post("/tags", status_code=status.HTTP_201_CREATED)
async def create_tag(payload: dict[str, Any], session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "标签名不能为空")
    same = (await session.execute(select(DocTag).where(DocTag.name == name))).scalars().first()
    if same is not None:
        return {"id": same.id, "name": same.name, "origin": same.origin}
    row = DocTag(name=name[:80], origin=str(payload.get("origin") or "user"))
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return {"id": row.id, "name": row.name, "origin": row.origin}


@router.delete("/tags/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tag(tag_id: str, session: AsyncSession = Depends(get_session)) -> None:
    row = await session.get(DocTag, tag_id)
    if row is None:
        return
    name = row.name
    docs = (await session.execute(select(Doc))).scalars().all()
    for d in docs:
        tags = [t for t in (d.tags or []) if t != name]
        if len(tags) != len(d.tags or []):
            d.tags = tags
    await session.delete(row)
    await session.commit()


# --------------------------------------------------------------------------- #
# 链接抓取（带 SSRF 防护）
# --------------------------------------------------------------------------- #
@router.post("/documents/from-url", status_code=status.HTTP_201_CREATED)
async def ingest_url(payload: dict[str, Any], session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """抓一页 → 存快照 + 正文 → 入库。安全校验在 fetch_url 里。"""
    url = str(payload.get("url") or "").strip()
    if not url:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "缺少 url")
    try:
        got = fetch_url.fetch_and_extract(url)
    except fetch_url.FetchBlocked as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    # 正文当作 md 入库，快照另存一份（同名 .snapshot.html）
    derived = got["final_url"].split("//")[-1].split("?")[0].split("#")[0].strip("/")
    # 网址末段为空（example.com/）时退回主机名，避免出现 ".md" 这种空名
    if not derived or derived.endswith("/"):
        derived = got["final_url"].split("//")[-1].split("/")[0]
    name = (payload.get("name") or derived[:120] or "网页").strip()
    md_name = name if name.endswith(".md") else f"{name}.md"
    category = str(payload.get("category") or "未分类")
    doc = await service.ingest_bytes(
        session,
        name=md_name,
        data=got["markdown"].encode("utf-8"),
        mime="text/markdown",
        source="url",
        source_url=got["final_url"],
        category=category,
        category_id=await service.resolve_category(session, category),
    )
    # 快照单独存（同名 .snapshot.html），详情页可下载
    try:
        cfg = await service.default_storage(session)
        svc = service.provider_of(cfg)
        snap_key = doc.storage_key + ".snapshot.html"
        svc.put_stream(snap_key, io.BytesIO(got["snapshot"]), content_type="text/html")
    except Exception:  # noqa: BLE001 —— 快照失败不影响正文入库
        logger.warning("网页快照保存失败：%s", url)
    asyncio.create_task(_parse_later(doc.id))
    return {"document": _doc_view(doc), "final_url": got["final_url"], "text_length": got["text_length"]}


# --------------------------------------------------------------------------- #
# 整理 Agent（只产出草稿，采纳才动 doc）
# --------------------------------------------------------------------------- #
@router.post("/organize", status_code=status.HTTP_202_ACCEPTED)
async def start_organize(payload: dict[str, Any], session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    agent_id = str(payload.get("agent_id") or "")
    doc_ids = [str(d) for d in (payload.get("doc_ids") or [])][:50]
    if not agent_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "要选一个执行整理的助手")
    if not doc_ids:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "至少要选一份文档")
    from ..models import Agent

    if await session.get(Agent, agent_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "助手不存在")

    job = OrganizeJob(
        agent_id=agent_id,
        doc_ids=doc_ids,
        kinds=[str(k) for k in (payload.get("kinds") or ["category", "tags", "summary"])],
    )
    session.add(job)
    await session.commit()
    await session.refresh(job)
    asyncio.create_task(org.run_job(job.id))
    return {"job": {"id": job.id, "status": job.status, "doc_count": len(doc_ids)}}


@router.get("/organize/jobs")
async def list_jobs(limit: int = Query(default=20, ge=1, le=100), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    rows = (
        await session.execute(select(OrganizeJob).order_by(OrganizeJob.created_at.desc()).limit(limit))
    ).scalars().all()
    pending = {
        jid: n
        for jid, n in (
            await session.execute(
                select(OrganizeDraft.job_id, func.count())
                .where(OrganizeDraft.status == "pending")
                .group_by(OrganizeDraft.job_id)
            )
        ).all()
    }
    return {
        "items": [
            {
                "id": r.id,
                "agent_id": r.agent_id,
                "doc_count": len(r.doc_ids or []),
                "status": r.status,
                "made": r.made,
                "failed": r.failed,
                "pending": pending.get(r.id, 0),
                "error": r.error or {},
                "created_at": r.created_at,
                "finished_at": r.finished_at,
            }
            for r in rows
        ]
    }


@router.get("/organize/drafts")
async def list_drafts(
    status_filter: str = Query(default="pending", alias="status"),
    job_id: str = Query(default=""),
    limit: int = Query(default=100, ge=1, le=300),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    conds = []
    if status_filter:
        conds.append(OrganizeDraft.status == status_filter)
    if job_id:
        conds.append(OrganizeDraft.job_id == job_id)
    rows = (
        await session.execute(
            select(OrganizeDraft).where(*conds).order_by(OrganizeDraft.created_at.desc()).limit(limit)
        )
    ).scalars().all()
    names = {
        d.id: d.name
        for d in (
            await session.execute(select(Doc).where(Doc.id.in_({r.doc_id for r in rows})))
        ).scalars().all()
    } if rows else {}
    return {"items": [org.draft_view(r, names.get(r.doc_id, "")) for r in rows]}


@router.post("/organize/drafts/{draft_id}/accept")
async def accept_draft(draft_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """采纳：这一条才真正改动文档。重复采纳是幂等的（status 已定就不再动）。"""
    import time

    row = await session.get(OrganizeDraft, draft_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "草稿不存在")
    if row.status != "pending":
        return {"ok": True, "already": row.status}

    doc = await session.get(Doc, row.doc_id)
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文档已删除")
    payload = row.payload or {}
    applied: dict[str, Any] = {}
    if row.kind == "category":
        name = str(payload.get("name") or "").strip()
        if name:
            cat_id = await service.resolve_category(session, name)
            doc.category_id = cat_id
            applied["category"] = name
    elif row.kind == "tags":
        add = [str(t)[:40] for t in (payload.get("add") or []) if str(t).strip()]
        merged = list(dict.fromkeys([*(doc.tags or []), *add]))
        doc.tags = merged[:30]
        for t in add:
            same = (await session.execute(select(DocTag).where(DocTag.name == t))).scalars().first()
            if same is None:
                session.add(DocTag(name=t, origin="agent", locked=0))
        applied["tags"] = add
    elif row.kind == "skill":
        from ..api.skills import _materialize, _upsert_skill

        content = str(payload.get("body") or "")
        name = str(payload.get("name") or "").strip()
        if not content or not name:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "这条 skill 草稿内容不完整，已跳过")
        skill_row, updated = await _upsert_skill(
            session,
            content=content,
            files={},
            fallback_name=name,
            source_meta={
                "type": "knowledge",
                "doc_ids": [doc.id],
                "doc_name": doc.name,
            },
        )
        # 沉淀到 workspace 命名空间（可写、可被 Agent 直接用），并记下溯源
        skill_row.ns = "workspace"
        skill_row.slug = skill_row.slug or skill_row.dir_name or name
        skill_row.source_doc_ids = list(dict.fromkeys([*(skill_row.source_doc_ids or []), doc.id]))
        await session.commit()
        await session.refresh(skill_row)
        await _materialize(skill_row)
        applied["skill"] = {"id": skill_row.id, "name": skill_row.name, "updated": updated}
    elif row.kind == "summary":
        parsed = dict(doc.parsed or {})
        parsed["aiSummary"] = str(payload.get("text") or "")[:400]
        doc.parsed = parsed
        applied["summary"] = parsed["aiSummary"][:60]
    doc.updated_at = int(time.time() * 1000)
    row.status = "accepted"
    row.decided_at = int(time.time() * 1000)
    await session.commit()
    return {"ok": True, "applied": applied}


@router.post("/organize/drafts/{draft_id}/reject")
async def reject_draft(draft_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    import time

    row = await session.get(OrganizeDraft, draft_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "草稿不存在")
    if row.status == "pending":
        row.status = "rejected"
        row.decided_at = int(time.time() * 1000)
        await session.commit()
    return {"ok": True}


@router.post("/documents/{doc_id}/skill-draft", status_code=status.HTTP_202_ACCEPTED)
async def make_skill_draft(
    doc_id: str, payload: dict[str, Any], session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """让助手把一份文档提炼成 SKILL.md 草稿（同样要人采纳才落盘）。"""
    doc = await session.get(Doc, doc_id)
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文档不存在")
    if doc.status != "ready":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "这份文档还没解析完，暂时不能提炼")
    agent_id = str(payload.get("agent_id") or "")
    from ..models import Agent

    if not agent_id or await session.get(Agent, agent_id) is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "要选一个执行提炼的助手")
    job = OrganizeJob(agent_id=agent_id, doc_ids=[doc_id], kinds=["skill"])
    session.add(job)
    await session.commit()
    await session.refresh(job)
    asyncio.create_task(org.run_job(job.id))
    return {"job": {"id": job.id, "status": job.status, "doc_count": 1}}


# --------------------------------------------------------------------------- #
# 关联图谱：文档 ↔ 分类 ↔ 技能 ↔ 助手
# --------------------------------------------------------------------------- #
@router.get("/graph")
async def knowledge_graph(limit_docs: int = Query(default=60, ge=1, le=200), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """一张引用关系的快照：谁引用了谁。

    只画真实存在的引用（文档的分类、技能来自哪份文档、助手挂了哪个技能），
    不做"相似度连线"——那种线看起来热闹，但说不清依据。
    """
    from ..models import Agent, Skill

    docs = (
        await session.execute(select(Doc).order_by(Doc.updated_at.desc()).limit(limit_docs))
    ).scalars().all()
    doc_ids = {d.id for d in docs}
    cats = {c.id: c for c in (await session.execute(select(Category))).scalars().all()}
    skills = (await session.execute(select(Skill))).scalars().all()
    agents = (await session.execute(select(Agent))).scalars().all()

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, str]] = []
    seen: set[str] = set()

    def add(kind: str, ident: str, label: str, **extra: Any) -> None:
        key = f"{kind}:{ident}"
        if key in seen:
            return
        seen.add(key)
        nodes.append({"id": key, "kind": kind, "label": label, **extra})

    for d in docs:
        add("doc", d.id, d.name, status=d.status)
        if d.category_id and d.category_id in cats:
            c = cats[d.category_id]
            add("category", c.id, c.name)
            edges.append({"from": f"doc:{d.id}", "to": f"category:{c.id}", "kind": "分类"})

    for s in skills:
        src = list(getattr(s, "source_doc_ids", None) or [])
        hits = [x for x in src if x in doc_ids]
        if not hits:
            continue
        add("skill", s.id, s.name, ns=getattr(s, "ns", "") or "")
        for doc_id in hits:
            edges.append({"from": f"skill:{s.id}", "to": f"doc:{doc_id}", "kind": "沉淀自"})

    for a in agents:
        names = {str(n) for n in ((a.definition or {}).get("skills") or [])}
        if not names:
            continue
        for s in skills:
            if s.name in names:
                add("agent", a.id, a.name)
                add("skill", s.id, s.name, ns=getattr(s, "ns", "") or "")
                edges.append({"from": f"agent:{a.id}", "to": f"skill:{s.id}", "kind": "挂载"})

    return {"nodes": nodes, "edges": edges, "truncated": len(docs) >= limit_docs}


# --------------------------------------------------------------------------- #
# 存储迁移：把已有文档从 A 存储搬到 B 存储
# --------------------------------------------------------------------------- #
@router.post("/storage/migrate", status_code=status.HTTP_202_ACCEPTED)
async def start_migration(payload: dict[str, Any], session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """起一次迁移。搬原件、按内容寻址去重、默认保留源文件。"""
    from ..knowledge.models import StorageMigration

    to_id = str(payload.get("to_id") or "")
    if not to_id or await session.get(StorageConfig, to_id) is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "要选一个目标存储")
    from_id = str(payload.get("from_id") or "")
    if from_id:
        if await session.get(StorageConfig, from_id) is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "源存储不存在")
        if from_id == to_id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "源和目标不能是同一个存储")

    running = (
        await session.execute(select(StorageMigration).where(StorageMigration.status.in_(["queued", "running"])))
    ).scalars().first()
    if running is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "已经有一次迁移在跑，等它结束再开始新的")

    job = StorageMigration(
        from_id=from_id,
        to_id=to_id,
        status="queued",
        keep_source=0 if payload.get("keep_source") is False else 1,
    )
    session.add(job)
    await session.commit()
    await session.refresh(job)
    mig.start(job.id)
    return {"job": mig.view(job)}


@router.get("/storage/migrations")
async def list_migrations(limit: int = Query(default=10, ge=1, le=50), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    from ..knowledge.models import StorageMigration

    rows = (
        await session.execute(
            select(StorageMigration).order_by(StorageMigration.created_at.desc()).limit(limit)
        )
    ).scalars().all()
    names = {
        c.id: c.name
        for c in (await session.execute(select(StorageConfig))).scalars().all()
    }
    items = []
    for r in rows:
        v = mig.view(r)
        v["from_name"] = names.get(r.from_id, "（全部）")
        v["to_name"] = names.get(r.to_id, "")
        items.append(v)
    return {"items": items}
