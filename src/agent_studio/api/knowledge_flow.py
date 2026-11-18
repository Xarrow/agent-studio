"""知识库流程：文档版本、软删回收站、标签（模型候选/用户自定义）、按标签生成 Skill、召回埋点。

为什么单独一个文件
==================
``api/knowledge.py`` 已经 800+ 行、30 条路由，再往里塞会让「检索」和「文档生命周期」
混在一处。这里按**流程**归拢：文档怎么变（版本/删除）、标签怎么来（模型/用户）、
Skill 怎么从标签长出来。共用 ``knowledge.service`` 的存储与解析，不重复实现。

三条口径（与 docs/specs/knowledge-flow-spec.md 一致）
====================================================
1. 更新 = 新版本，不覆盖；旧版可下载、可回滚。
2. 删除 = 软删进回收站，恢复无损；彻底删除要显式传 ``hard=true``。
3. 模型产的标签是 ``candidate``，人点采纳才 ``accepted``；Skill 只出草稿，发布才落盘。
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import time
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy import delete as sa_delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..knowledge import parsers, service, storage
from ..knowledge.models import (
    Doc,
    DocChunk,
    DocTag,
    DocumentTag,
    DocumentVersion,
    RecallLog,
    SkillDraft,
    StorageConfig,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/knowledge", tags=["knowledge-flow"])

MAX_BYTES = 100 * 1024 * 1024
#: 一个文档最多保留的历史版本数（超出删最旧的记录，原件按内容寻址可留）
KEEP_VERSIONS = 10


def _now() -> int:
    return int(time.time() * 1000)


def _version_view(row: DocumentVersion) -> dict[str, Any]:
    return {
        "id": row.id,
        "version": row.version,
        "sha256": row.sha256,
        "size": row.size,
        "note": row.note,
        "created_at": row.created_at,
    }


# --------------------------------------------------------------------------- #
# 文档版本
# --------------------------------------------------------------------------- #
@router.post("/documents/{doc_id}/versions", status_code=status.HTTP_201_CREATED)
async def add_version(
    doc_id: str,
    file: UploadFile = File(...),
    note: str = Query(default=""),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """上传新版本：原件按内容寻址存，版本号 +1，随后重跑解析。"""
    doc = await session.get(Doc, doc_id)
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文档不存在")

    data = await file.read()
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "文件是空的")
    if len(data) > MAX_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "超过 100MB 上限")

    digest = hashlib.sha256(data).hexdigest()
    if digest == doc.sha256:
        raise HTTPException(status.HTTP_409_CONFLICT, "内容没变，不用传新版本")

    cfg = await session.get(StorageConfig, doc.storage_id) if doc.storage_id else None
    cfg = cfg or await service.default_storage(session)
    prov = service.provider_of(cfg)
    key = storage.object_key(digest, file.filename or doc.name, category=doc.category_id or "未分类")
    put = prov.put_stream(key, io.BytesIO(data), content_type=file.content_type or doc.mime)

    next_ver = int(doc.version or 1) + 1
    session.add(
        DocumentVersion(
            doc_id=doc.id,
            version=next_ver,
            sha256=digest,
            storage_key=put.key,
            storage_id=cfg.id,
            size=len(data),
            note=note[:200],
        )
    )
    # 历史版本裁剪：只留最近 KEEP_VERSIONS 条记录
    old = (
        await session.execute(
            select(DocumentVersion)
            .where(DocumentVersion.doc_id == doc.id)
            .order_by(DocumentVersion.version.desc())
        )
    ).scalars().all()
    for extra in old[KEEP_VERSIONS - 1 :]:
        await session.delete(extra)

    doc.version = next_ver
    doc.sha256 = digest
    doc.size = len(data)
    doc.mime = file.content_type or doc.mime
    doc.storage_id = cfg.id
    doc.storage_key = put.key
    doc.storage_path = prov.display_path(put.key)
    doc.status = "parsing"
    doc.error = {}
    doc.updated_at = _now()
    await session.commit()

    asyncio.create_task(_rerun_pipeline(doc.id))
    await session.refresh(doc)
    return {"document": _doc_brief(doc), "version": next_ver}


@router.get("/documents/{doc_id}/versions")
async def list_versions(doc_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    doc = await session.get(Doc, doc_id)
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文档不存在")
    rows = (
        await session.execute(
            select(DocumentVersion)
            .where(DocumentVersion.doc_id == doc_id)
            .order_by(DocumentVersion.version.desc())
        )
    ).scalars().all()
    current = {
        "id": "",
        "version": doc.version,
        "sha256": doc.sha256,
        "size": doc.size,
        "note": "当前版本",
        "created_at": doc.updated_at,
        "current": True,
    }
    items = [current] + [dict(_version_view(r), current=False) for r in rows if r.version != doc.version]
    return {"items": items, "current": doc.version}


@router.post("/documents/{doc_id}/versions/{version}/rollback")
async def rollback_version(
    doc_id: str, version: int, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """回滚到历史版本：指针指回去并重新解析（不删之后的版本）。"""
    doc = await session.get(Doc, doc_id)
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文档不存在")
    if int(doc.version) == version:
        raise HTTPException(status.HTTP_409_CONFLICT, "已经是这个版本了")
    row = (
        await session.execute(
            select(DocumentVersion).where(
                DocumentVersion.doc_id == doc_id, DocumentVersion.version == version
            )
        )
    ).scalars().first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "没有这个版本")

    cfg = await session.get(StorageConfig, row.storage_id) if row.storage_id else None
    cfg = cfg or await service.default_storage(session)
    prov = service.provider_of(cfg)

    doc.version = version
    doc.sha256 = row.sha256
    doc.size = row.size
    doc.storage_id = cfg.id
    doc.storage_key = row.storage_key
    doc.storage_path = prov.display_path(row.storage_key)
    doc.status = "parsing"
    doc.error = {}
    doc.updated_at = _now()
    await session.commit()
    asyncio.create_task(_parse_later(doc.id))
    await session.refresh(doc)
    return {"document": _doc_brief(doc), "version": version}


# --------------------------------------------------------------------------- #
# 入库流水线：上传 → 向量化 → 标签 → 技能（一个页面走完）
# --------------------------------------------------------------------------- #
@router.get("/pipeline")
async def pipeline(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """每份文档走到哪一步了，以及"下一步该做什么"。"""
    rows = (
        await session.execute(
            select(Doc).where(Doc.deleted_at.is_(None)).order_by(Doc.updated_at.desc()).limit(100)
        )
    ).scalars().all()
    tag_rows = (
        await session.execute(
            select(DocumentTag.doc_id, func.count()).group_by(DocumentTag.doc_id)
        )
    ).all()
    tag_count = {d: int(c) for d, c in tag_rows}
    skill_rows = (
        await session.execute(
            select(SkillDraft.doc_ids, SkillDraft.status).where(SkillDraft.status != "discarded")
        )
    ).all()
    skilled: set[str] = set()
    for doc_ids, _status in skill_rows:
        for d in doc_ids or []:
            skilled.add(str(d))

    items = []
    for d in rows:
        steps = {
            "uploaded": True,
            "parsed": d.status == "ready",
            "embedded": (d.embed_status or "none") == "ready",
            "tagged": tag_count.get(d.id, 0) > 0,
            "skilled": d.id in skilled,
        }
        if not steps["parsed"]:
            nxt = "wait_parse"
        elif not steps["embedded"]:
            nxt = "embed"
        elif not steps["tagged"]:
            nxt = "tag"
        elif not steps["skilled"]:
            nxt = "skill"
        else:
            nxt = "done"
        items.append(
            {
                "id": d.id,
                "name": d.name,
                "kind": d.kind,
                "size": d.size,
                "status": d.status,
                "version": d.version,
                "category_id": d.category_id,
                "tags": d.tags or [],
                "tag_count": tag_count.get(d.id, 0),
                "embed_status": d.embed_status or "none",
                "embed_model": d.embed_model or "",
                "embed_dim": d.embed_dim or 0,
                "steps": steps,
                "next": nxt,
                "updated_at": d.updated_at,
            }
        )
    return {"items": items, "embed_configured": (await _embed_cfg(session))["configured"]}


async def _embed_cfg(session: AsyncSession) -> dict[str, Any]:
    from ..knowledge.embedding import embed_config

    return await embed_config(session)


@router.get("/embed/status")
async def embed_status(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    cfg = await _embed_cfg(session)
    covered = (
        await session.execute(
            select(func.count()).select_from(Doc).where(
                Doc.deleted_at.is_(None), Doc.embed_status == "ready"
            )
        )
    ).scalar_one()
    total = (
        await session.execute(
            select(func.count()).select_from(Doc).where(Doc.deleted_at.is_(None))
        )
    ).scalar_one()
    from ..knowledge.models import DocEmbedding

    models = {
        r[0]
        for r in (await session.execute(select(DocEmbedding.model).distinct())).all()
        if r[0]
    }
    mismatch = bool(cfg["configured"] and models and cfg["model"] not in models)
    return {
        **cfg,
        "embedded_docs": int(covered),
        "total_docs": int(total),
        "index_models": sorted(models),
        "model_mismatch": mismatch,
    }


@router.post("/documents/{doc_id}/embed")
async def embed_one(doc_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """把一份文档的正文块向量化。没配端点 → 422 + 人话（不假装成功）。"""
    from ..knowledge.embedding import embed_document

    doc = await session.get(Doc, doc_id)
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文档不存在")
    if doc.status != "ready":
        raise HTTPException(status.HTTP_409_CONFLICT, "还没解析完成，等解析好再向量化")
    try:
        got = await embed_document(session, doc)
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    return {"ok": True, **got}



# --------------------------------------------------------------------------- #
# 粘贴入库
# --------------------------------------------------------------------------- #
@router.post("/documents/paste", status_code=status.HTTP_201_CREATED)
async def paste_document(
    payload: dict[str, Any], session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """贴一段文本直接入库（保 Markdown 语法；太短的拒掉，别把聊天碎片塞进知识库）。"""
    text = str(payload.get("text") or "")
    if len(text.strip()) < 20:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "正文太短（少于 20 字），不值得入库")
    title = str(payload.get("title") or "").strip()[:120] or f"粘贴 {time.strftime('%m-%d %H:%M')}"
    category = str(payload.get("category") or "未分类")
    doc = await service.ingest_bytes(
        session,
        name=f"{title}.md",
        data=text.encode("utf-8"),
        mime="text/markdown",
        source="paste",
        category=category,
        category_id=await service.resolve_category(session, category),
    )
    for name in payload.get("tags") or []:
        tag = await _ensure_tag(session, str(name), origin="user")
        session.add(DocumentTag(doc_id=doc.id, tag_id=tag.id, source="user", status="accepted"))
        doc.tags = sorted({*(doc.tags or []), tag.name})
    await session.commit()
    asyncio.create_task(_parse_later(doc.id))
    await session.refresh(doc)
    return {"document": _doc_brief(doc)}


# --------------------------------------------------------------------------- #
# 关键词：向量化之后自动出候选标签（不花 30 秒等 LLM）
# --------------------------------------------------------------------------- #
#: 中文停用词/虚词片段：出现在候选词里就丢掉（"的""了""我们""可以"这类）
_STOP = set(
    "的 了 和 与 及 或 是 在 有 为 对 从 到 由 并 而 但 等 这 那 我们 你们 他们 可以 需要 "
    "进行 通过 以及 如果 因为 所以 但是 一个 一种 没有 不是 就是 还有 什么 怎么 如何 哪些 "
    "不超过 以上 以下 以内 以外 按 每 各 其 该 此 若 则 且 另 首次 同时 相关 有关".split()
)


def extract_keywords(texts: list[str], top_k: int = 8, title: str = "") -> list[tuple[str, float]]:
    """从正文里抽候选关键词：中文 2~6 字片段 + 频次/覆盖度打分。

    为什么不用 LLM：这一步在流水线里紧跟向量化，用户点完就想看到结果；
    本地统计 <100ms，LLM 要 10~30 秒。质量不够的词由用户手动补/删。
    """
    import re
    from collections import Counter

    chunk_df: Counter = Counter()
    tf: Counter = Counter()
    for text in texts:
        pieces = re.split(r"[^\u4e00-\u9fa5A-Za-z0-9]+", text or "")
        seen_in_chunk: set[str] = set()
        for piece in pieces:
            if not piece:
                continue
            if re.fullmatch(r"[A-Za-z0-9]+", piece):
                if 2 <= len(piece) <= 20:
                    tf[piece] += 1
                    seen_in_chunk.add(piece)
                continue
            for n in (2, 3, 4):
                for i in range(len(piece) - n + 1):
                    cand = piece[i : i + n]
                    if cand in _STOP or any(w.startswith(cand) or cand.startswith(w) for w in _STOP):
                        continue
                    if any(w in cand for w in ("的", "了", "是", "在", "和", "与")):
                        continue
                    tf[cand] += 1
                    seen_in_chunk.add(cand)
        for w in seen_in_chunk:
            chunk_df[w] += 1

    total = max(1, len(texts))
    scored: list[tuple[str, float]] = []
    for word, count in tf.items():
        if count < 2:
            continue
        df = max(1, chunk_df[word])
        score = count * (1.0 + (total / df) ** 0.5) * (1.0 + 0.2 * (len(word) - 2))
        if title and word in title:
            score *= 2.5  # 标题里的词几乎一定是主题词
        scored.append((word, round(score, 2)))
    scored.sort(key=lambda x: (-x[1], -len(x[0])))
    # 去冗余：短词是长词子串且分数接近时只留长的
    out: list[tuple[str, float]] = []
    for word, score in scored:
        if any(word != w and word in w and score <= s * 1.15 for w, s in out):
            continue
        out.append((word, score))
        if len(out) >= top_k:
            break
    return out


@router.post("/documents/{doc_id}/keywords")
async def make_keywords(
    doc_id: str, payload: dict[str, Any] | None = None, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """给文档产候选关键词标签（写 document_tag，status=candidate）。"""
    doc = await session.get(Doc, doc_id)
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文档不存在")
    top_k = int(((payload or {}).get("top_k") or 8))
    chunks = (
        await session.execute(
            select(DocChunk.text).where(DocChunk.doc_id == doc_id).order_by(DocChunk.ord)
        )
    ).scalars().all()
    if not chunks:
        raise HTTPException(status.HTTP_409_CONFLICT, "还没有解析文本，先等解析完成")
    picks = extract_keywords(list(chunks), top_k=top_k, title=doc.name)
    if not picks:
        return {"items": [], "note": "正文太短，抽不出关键词，手动加更靠谱"}

    made = []
    for word, score in picks:
        tag = await _ensure_tag(session, word, origin="model")
        link = await session.get(DocumentTag, (doc_id, tag.id))
        if link is None:
            conf = min(0.95, 0.45 + score / 40.0)
            session.add(
                DocumentTag(
                    doc_id=doc_id, tag_id=tag.id, source="model", confidence=round(conf, 2),
                    status="candidate",
                )
            )
        made.append({"tag_id": tag.id, "name": tag.name})
    await session.commit()
    return {"items": made, "count": len(made)}


@router.post("/documents/{doc_id}/skill")
async def skill_from_doc(
    doc_id: str, payload: dict[str, Any] | None = None, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """用这份文档（及其已采纳标签）生成一条 Skill 草稿 —— 文档页一键入口。"""
    doc = await session.get(Doc, doc_id)
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文档不存在")
    if doc.status != "ready":
        raise HTTPException(status.HTTP_409_CONFLICT, "还没解析完成，等解析好再生成")
    tag_ids = list(
        (
            await session.execute(
                select(DocumentTag.tag_id).where(
                    DocumentTag.doc_id == doc_id, DocumentTag.status == "accepted"
                )
            )
        ).scalars().all()
    )
    body = {"doc_ids": [doc_id], "tag_ids": tag_ids}
    if payload and payload.get("agent_id"):
        body["agent_id"] = str(payload["agent_id"])
    return await create_skill_draft({**body, "doc_ids": [doc_id]}, session)


@router.get("/index/status")
async def index_status(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """关键词索引（zvec BM25）的状态：可用 / 降级 / 条数。"""
    from ..knowledge import index as _zidx

    info = _zidx.status()
    try:
        import zvec  # noqa: F401

        info["available"] = True
    except Exception:  # noqa: BLE001
        info["available"] = False
        info.setdefault("reason", "没装 zvec（检索仍在用 SQL LIKE）")
    return info


@router.post("/index/rebuild")
async def index_rebuild(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """从 doc_chunk 全量重建关键词索引（换机器、索引损坏、批量导入后用）。"""
    from ..knowledge import index as _zidx

    try:
        got = await _zidx.rebuild(session)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, f"重建失败：{exc}"[:300]) from exc
    return {"ok": True, **got}


@router.post("/recall/probe")
async def recall_probe(
    payload: dict[str, Any], session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """用一句话试打召回：返回命中列表、命中路径与延迟。"""
    query = str(payload.get("query") or "").strip()
    if not query:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "给一句想试的话")
    limit = int(payload.get("limit") or 5)
    stamp = time.time()
    hits = await service.hybrid_search(session, query, limit=limit)
    return {
        "query": query,
        "items": [
            {
                "id": h["id"],
                "name": h["name"],
                "snippet": h.get("snippet") or "",
                "score": h.get("score"),
                "matched_path": h.get("matched_path") or "keyword",
            }
            for h in hits
        ],
        "latency_ms": int((time.time() - stamp) * 1000),
    }


# --------------------------------------------------------------------------- #
# 软删 / 回收站
# --------------------------------------------------------------------------- #
@router.post("/documents/{doc_id}/restore")
async def restore_document(doc_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    doc = await session.get(Doc, doc_id)
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文档不存在")
    doc.deleted_at = None
    doc.updated_at = _now()
    await session.commit()
    await session.refresh(doc)
    return {"document": _doc_brief(doc)}


@router.get("/trash")
async def list_trash(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    rows = (
        await session.execute(
            select(Doc).where(Doc.deleted_at.is_not(None)).order_by(Doc.deleted_at.desc()).limit(200)
        )
    ).scalars().all()
    return {"items": [dict(_doc_brief(r), deleted_at=r.deleted_at) for r in rows]}


# --------------------------------------------------------------------------- #
# 标签：模型候选 + 用户自定义
# --------------------------------------------------------------------------- #
async def _ensure_tag(session: AsyncSession, name: str, *, origin: str = "user") -> DocTag:
    clean = (name or "").strip()[:80]
    if not clean:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "标签名不能为空")
    row = (await session.execute(select(DocTag).where(DocTag.name == clean))).scalars().first()
    if row is not None:
        return row
    row = DocTag(name=clean, origin="agent" if origin == "model" else "user", locked=0)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


@router.get("/documents/{doc_id}/tags")
async def list_doc_tags(doc_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    rows = (
        await session.execute(
            select(DocumentTag, DocTag)
            .join(DocTag, DocTag.id == DocumentTag.tag_id)
            .where(DocumentTag.doc_id == doc_id)
            .order_by(DocumentTag.status, DocTag.name)
        )
    ).all()
    items = [
        {
            "tag_id": t.id,
            "name": t.name,
            "source": link.source,
            "confidence": link.confidence,
            "status": link.status,
        }
        for link, t in rows
    ]
    return {
        "items": items,
        "accepted": [x for x in items if x["status"] == "accepted"],
        "candidates": [x for x in items if x["status"] == "candidate"],
    }


@router.post("/documents/{doc_id}/tags", status_code=status.HTTP_201_CREATED)
async def add_doc_tag(
    doc_id: str, payload: dict[str, Any], session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """加标签。``tag_id`` 与 ``name`` 二选一；``source`` 默认 user。"""
    doc = await session.get(Doc, doc_id)
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文档不存在")
    tag_id = str(payload.get("tag_id") or "")
    if tag_id:
        tag = await session.get(DocTag, tag_id)
        if tag is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "标签不存在")
    else:
        tag = await _ensure_tag(session, str(payload.get("name") or ""), origin=str(payload.get("source") or "user"))

    source = str(payload.get("source") or "user")
    link = await session.get(DocumentTag, (doc_id, tag.id))
    if link is None:
        link = DocumentTag(
            doc_id=doc_id,
            tag_id=tag.id,
            source=source,
            confidence=float(payload.get("confidence") or 1.0),
            status="candidate" if source == "model" and not payload.get("accept") else "accepted",
        )
        session.add(link)
    else:
        link.status = "accepted" if payload.get("accept") or source == "user" else link.status
    # doc.tags 是给人看的扁平数组，跟着同步
    names = {str(x) for x in (doc.tags or [])}
    if link.status == "accepted":
        names.add(tag.name)
    doc.tags = sorted(names)
    doc.updated_at = _now()
    await session.commit()
    return {"tag_id": tag.id, "name": tag.name, "status": link.status}


@router.post("/documents/{doc_id}/tags/{tag_id}/accept")
async def accept_doc_tag(
    doc_id: str, tag_id: str, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    link = await session.get(DocumentTag, (doc_id, tag_id))
    tag = await session.get(DocTag, tag_id)
    doc = await session.get(Doc, doc_id)
    if link is None or tag is None or doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "没有这条标签关系")
    link.status = "accepted"
    names = {str(x) for x in (doc.tags or [])}
    names.add(tag.name)
    doc.tags = sorted(names)
    doc.updated_at = _now()
    await session.commit()
    return {"ok": True, "name": tag.name}


@router.delete("/documents/{doc_id}/tags/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_doc_tag(
    doc_id: str, tag_id: str, session: AsyncSession = Depends(get_session)
) -> None:
    link = await session.get(DocumentTag, (doc_id, tag_id))
    tag = await session.get(DocTag, tag_id)
    doc = await session.get(Doc, doc_id)
    if link is not None:
        await session.delete(link)
    if doc is not None and tag is not None:
        doc.tags = [x for x in (doc.tags or []) if str(x) != tag.name]
        doc.updated_at = _now()
    await session.commit()


@router.post("/tags/{tag_id}/merge")
async def merge_tag(
    tag_id: str, payload: dict[str, Any], session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """把 tag_id 合并到 into_id：关系改指向，之后再删掉被合并的标签定义。"""
    into_id = str(payload.get("into_id") or "")
    if not into_id or into_id == tag_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "要选另一个标签作为合并目标")
    src = await session.get(DocTag, tag_id)
    dst = await session.get(DocTag, into_id)
    if src is None or dst is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "标签不存在")
    links = (
        await session.execute(select(DocumentTag).where(DocumentTag.tag_id == tag_id))
    ).scalars().all()
    moved = 0
    for link in links:
        exists = await session.get(DocumentTag, (link.doc_id, into_id))
        if exists is None:
            session.add(
                DocumentTag(
                    doc_id=link.doc_id,
                    tag_id=into_id,
                    source=link.source,
                    confidence=link.confidence,
                    status=link.status,
                )
            )
            moved += 1
        await session.delete(link)
    await session.delete(src)
    await session.commit()
    return {"moved": moved, "into": dst.name}


@router.get("/tags/usage")
async def tag_usage(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """标签使用数（图谱与标签页都读它）。"""
    rows = (
        await session.execute(
            select(DocTag.id, DocTag.name, DocTag.origin, func.count(DocumentTag.doc_id))
            .outerjoin(DocumentTag, DocumentTag.tag_id == DocTag.id)
            .group_by(DocTag.id)
            .order_by(func.count(DocumentTag.doc_id).desc())
            .limit(300)
        )
    ).all()
    return {
        "items": [
            {"id": i, "name": n, "origin": o, "doc_count": int(c)} for i, n, o, c in rows
        ]
    }


# --------------------------------------------------------------------------- #
# 由标签 / 文档生成 Skill 草稿
# --------------------------------------------------------------------------- #

QUERY_MAP_HEAD = "## 查询词映射"


def parse_query_map(body: str) -> dict[str, list[str]]:
    """从 SKILL.md 正文里抽出「查询词映射」表：用户说法 → 文档用词。

    为什么在图谱/发布时解析而不是每次检索现解析：检索是热路径，一次请求要查几次；
    发布是一次性动作，把它变成结构化数据后检索只做字典查表。
    """
    lines = (body or "").splitlines()
    try:
        start = next(i for i, l in enumerate(lines) if l.strip().startswith(QUERY_MAP_HEAD))
    except StopIteration:
        return {}
    out: dict[str, list[str]] = {}
    for raw in lines[start + 1 :]:
        line = raw.strip()
        if line.startswith("## "):
            break
        if not line.startswith("|") or set(line) <= set("|-: "):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 2:
            continue
        left, right = cells[0], cells[1]
        if left in ("用户可能说的词", "用户说法") or "用户" in left[:6]:
            continue
        keys = [k.strip() for k in left.replace("，", "、").replace(",", "、").split("、") if k.strip()]
        vals = [v.strip() for v in right.replace("，", "、").replace(",", "、").split("、") if v.strip()]
        for k in keys:
            if k and vals:
                out.setdefault(k, [])
                for v in vals:
                    if v not in out[k]:
                        out[k].append(v)
    return out


SKILL_SYSTEM = """你是知识库的"检索计划"生成器。用户会给你若干份文档的正文节选。

你的产物**不是操作指南**，而是一份给检索用的"找得到"计划：拿到它的人（或 Agent）
能据此拼出正确的查询词、选对过滤条件，快速在向量库里命中原文。

只输出一个 JSON 对象，不要解释、不要代码块：
{"name":"技能名（2~12 字，描述这批文档管什么）",
 "description":"一句话：什么问题该用它（不超过 60 字）",
 "body":"Markdown 正文"}

body 必须包含这四节：

## 适用问题
5~10 条**用户真实会怎么问**的短句（口语，不写文档标题）。例如「账期多久」「验收要几份材料」。

## 查询词映射
一张表：左边是用户可能说的词，右边是文档里实际用的词/同义词/缩写。
例：账期 / 回款周期 → 付款期限；验收材料 → 验收资料、交付物清单。
这一节是整份技能的核心：口语和文书写法对不上的地方，全靠它。

## 检索策略
- 关键词：3~8 个最能定位于本主题的词（名词优先，去掉"的、了、如何"这类虚词）
- 过滤建议：该限定在哪些标签或文档上（写标签名）
- 命中后：按哪一节/哪几段核对原文（写章节名或"第 N 条"）

## 边界
文档里没有的内容要明说"文档未覆盖"，不许推测数字、日期、条款。"""


#: 送进模型的正文上限（多份文档拼接后）
MAX_SOURCE_CHARS = 8000


@router.post("/skill-drafts", status_code=status.HTTP_201_CREATED)
async def create_skill_draft(
    payload: dict[str, Any], session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """按标签（该标签下全部文档）或按选中文档生成 Skill 草稿。"""
    tag_id = str(payload.get("tag_id") or "")
    doc_ids = [str(x) for x in (payload.get("doc_ids") or [])]
    agent_id = str(payload.get("agent_id") or "")

    if tag_id:
        rows = (
            await session.execute(
                select(DocumentTag.doc_id).where(
                    DocumentTag.tag_id == tag_id, DocumentTag.status == "accepted"
                )
            )
        ).scalars().all()
        doc_ids = [x for x in rows if x] or doc_ids
    doc_ids = [x for x in dict.fromkeys(doc_ids) if x]
    if not doc_ids:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "这个标签下还没有文档，先给文档打标签")

    docs = (
        await session.execute(
            select(Doc).where(Doc.id.in_(doc_ids), Doc.deleted_at.is_(None))
        )
    ).scalars().all()
    ready = [d for d in docs if d.status == "ready"]
    if not ready:
        raise HTTPException(status.HTTP_409_CONFLICT, "来源文档都还没解析完成，等解析完再生成")

    text = await _source_text(session, [d.id for d in ready])
    if not text.strip():
        raise HTTPException(status.HTTP_409_CONFLICT, "来源文档没有可用正文")

    draft = SkillDraft(
        name="",
        description="",
        body="",
        tag_ids=[tag_id] if tag_id else [],
        doc_ids=[d.id for d in ready],
        model="",
        status="draft",
    )
    session.add(draft)
    await session.commit()
    await session.refresh(draft)

    asyncio.create_task(_generate_skill_draft(draft.id, agent_id, text))
    return {"draft": _draft_view(draft), "queued": True}


@router.get("/skill-drafts")
async def list_skill_drafts(
    status_filter: str = Query(default="draft", alias="status"),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    stmt = select(SkillDraft).order_by(SkillDraft.created_at.desc()).limit(50)
    if status_filter:
        stmt = stmt.where(SkillDraft.status == status_filter)
    rows = (await session.execute(stmt)).scalars().all()
    return {"items": [_draft_view(r) for r in rows]}


@router.patch("/skill-drafts/{draft_id}")
async def update_skill_draft(
    draft_id: str, payload: dict[str, Any], session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    row = await session.get(SkillDraft, draft_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "草稿不存在")
    if "name" in payload:
        row.name = str(payload["name"])[:200]
    if "description" in payload:
        row.description = str(payload["description"])[:400]
    if "body" in payload:
        row.body = str(payload["body"])
    await session.commit()
    await session.refresh(row)
    return {"draft": _draft_view(row)}


@router.post("/skill-drafts/{draft_id}/publish")
async def publish_skill_draft(
    draft_id: str, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """发布：落 Skill（ns=workspace）+ 写磁盘 + 记来源。"""
    from ..api.skills import _materialize, _upsert_skill

    row = await session.get(SkillDraft, draft_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "草稿不存在")
    if row.status == "published":
        raise HTTPException(status.HTTP_409_CONFLICT, "这条草稿已经发布过了")
    if not (row.body or "").strip() or not (row.name or "").strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "草稿还没生成完（没有名字或正文）")

    content = f"---\nname: {row.name}\ndescription: \"{(row.description or '').replace(chr(34), '')}\"\n---\n\n{row.body}"
    skill, created = await _upsert_skill(
        session,
        content=content,
        files={},
        fallback_name=row.name,
        source_meta={"via": "skill_draft", "draft_id": row.id},
        source_key=f"draft:{row.id}",
        dir_name=None,
    )
    skill.ns = "workspace"
    skill.source_doc_ids = list(getattr(skill, "source_doc_ids", []) or []) + [
        d for d in (row.doc_ids or []) if d not in (getattr(skill, "source_doc_ids", []) or [])
    ]
    skill.source_tag_ids = list(getattr(skill, "source_tag_ids", []) or []) + [
        t for t in (row.tag_ids or []) if t not in (getattr(skill, "source_tag_ids", []) or [])
    ]
    from ..knowledge.fingerprint import fingerprint as _fp

    try:
        qmap = parse_query_map(skill.content or "")
        if qmap:
            src = dict(skill.source or {})
            src["query_map"] = qmap
            skill.source = src
    except Exception:  # noqa: BLE001 —— 解析失败不影响发布
        pass

    skill.source_fp = await _fp(session, list(skill.source_doc_ids or []), list(skill.source_tag_ids or []))
    await session.commit()
    await _materialize(skill)

    row.status = "published"
    await session.commit()
    return {"skill_id": skill.id, "name": skill.name, "created": created}


@router.post("/skill-drafts/{draft_id}/discard")
async def discard_skill_draft(
    draft_id: str, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    row = await session.get(SkillDraft, draft_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "草稿不存在")
    row.status = "discarded"
    await session.commit()
    return {"ok": True}


# --------------------------------------------------------------------------- #
# 召回埋点与统计
# --------------------------------------------------------------------------- #
@router.get("/recall")
async def recall_stats(
    days: int = Query(default=7, ge=1, le=90), session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """召回率面板：四个数 + 未召回清单。

    文档自召回 / 标签召回是"算出来的"（拿文档自己的特征去查），
    助手命中率来自 ``recall_log`` 真实埋点。三者口径不同，别混着看。
    """
    since = _now() - days * 86_400_000

    docs = (
        await session.execute(select(Doc).where(Doc.deleted_at.is_(None), Doc.status == "ready"))
    ).scalars().all()
    doc_total = len(docs)
    doc_hit = 0
    doc_miss: list[dict[str, str]] = []
    for d in docs[:200]:
        probes = await _probe_terms(session, d)
        if not probes:
            continue
        found = False
        for probe in probes:
            hits = await service.search(session, probe, limit=5)
            if any(h["id"] == d.id for h in hits):
                found = True
                break
        if found:
            doc_hit += 1
        else:
            doc_miss.append({"id": d.id, "name": d.name, "probe": " / ".join(probes)})

    tags = (
        await session.execute(
            select(DocTag.id, DocTag.name, func.count(DocumentTag.doc_id))
            .join(DocumentTag, DocumentTag.tag_id == DocTag.id)
            .where(DocumentTag.status == "accepted")
            .group_by(DocTag.id)
        )
    ).all()
    tag_total = len(tags)
    tag_hit = 0
    tag_miss: list[dict[str, Any]] = []
    for tid, name, cnt in tags[:100]:
        expected = set(
            (
                await session.execute(
                    select(DocumentTag.doc_id).where(
                        DocumentTag.tag_id == tid, DocumentTag.status == "accepted"
                    )
                )
            ).scalars().all()
        )
        hits = {h["id"] for h in await service.search(session, name, limit=10)}
        got = len(expected & hits)
        ratio = got / max(1, min(len(expected), 10))
        if ratio >= 0.999:
            tag_hit += 1
        else:
            tag_miss.append({"id": tid, "name": name, "expected": len(expected), "hit": got})

    logs = (
        await session.execute(select(RecallLog).where(RecallLog.created_at >= since))
    ).scalars().all()
    agent_logs = [x for x in logs if x.surface == "agent"]
    search_logs = [x for x in logs if x.surface == "search"]

    def _rate(hit: int, total: int) -> float:
        return round(hit / total, 4) if total else 0.0

    return {
        "days": days,
        "docs": {
            "total": doc_total,
            "hit": doc_hit,
            "rate": _rate(doc_hit, doc_total),
            "misses": doc_miss[:20],
        },
        "tags": {
            "total": tag_total,
            "hit": tag_hit,
            "rate": _rate(tag_hit, tag_total),
            "misses": tag_miss[:20],
        },
        "agent": {
            "queries": len(agent_logs),
            "hit": sum(1 for x in agent_logs if x.hit_count > 0),
            "rate": _rate(sum(1 for x in agent_logs if x.hit_count > 0), len(agent_logs)),
            "avg_latency_ms": round(sum(x.latency_ms for x in agent_logs) / len(agent_logs), 1)
            if agent_logs
            else 0.0,
        },
        "search": {
            "queries": len(search_logs),
            "hit": sum(1 for x in search_logs if x.hit_count > 0),
            "rate": _rate(sum(1 for x in search_logs if x.hit_count > 0), len(search_logs)),
        },
    }


# --------------------------------------------------------------------------- #
# 内部
# --------------------------------------------------------------------------- #
def _doc_brief(row: Doc) -> dict[str, Any]:
    return {
        "id": row.id,
        "name": row.name,
        "kind": row.kind,
        "size": row.size,
        "status": row.status,
        "version": row.version,
        "category_id": row.category_id,
        "tags": row.tags or [],
        "updated_at": row.updated_at,
    }


def _draft_view(row: SkillDraft) -> dict[str, Any]:
    return {
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "body": row.body,
        "tag_ids": row.tag_ids or [],
        "doc_ids": row.doc_ids or [],
        "model": row.model,
        "status": row.status,
        "error": row.error or {},
        "created_at": row.created_at,
    }


async def _probe_terms(session: AsyncSession, doc: Doc) -> list[str]:
    """给一份文档造查询词：先试标题（去扩展名），再试首块开头。

    必须**分开查**：拼成一整串去 LIKE 等于要求正文里逐字出现那句话，
    几乎必然查不到，算出来的召回率是假的（实测 0/3）。
    """
    probes: list[str] = []
    stem = doc.name.rsplit(".", 1)[0].strip()[:40]
    if stem:
        probes.append(stem)
    first = (
        await session.execute(
            select(DocChunk.text).where(DocChunk.doc_id == doc.id).order_by(DocChunk.ord).limit(1)
        )
    ).scalars().first()
    piece = (first or "").strip().replace("\n", " ")[:16]
    if piece and piece not in probes:
        probes.append(piece)
    return probes


async def _source_text(session: AsyncSession, doc_ids: list[str]) -> str:
    """按文档顺序拼正文节选，总量受 MAX_SOURCE_CHARS 限制。"""
    buf: list[str] = []
    total = 0
    for doc_id in doc_ids:
        doc = await session.get(Doc, doc_id)
        chunks = (
            await session.execute(
                select(DocChunk)
                .where(DocChunk.doc_id == doc_id)
                .order_by(DocChunk.ord)
                .limit(40)
            )
        ).scalars().all()
        body = "\n".join((c.text or "").strip() for c in chunks if (c.text or "").strip())
        if not body:
            continue
        head = f"【文档：{doc.name if doc else doc_id}】\n"
        piece = (head + body)[: max(0, MAX_SOURCE_CHARS - total)]
        buf.append(piece)
        total += len(piece)
        if total >= MAX_SOURCE_CHARS:
            break
    return "\n\n".join(buf)


async def _parse_later(doc_id: str) -> None:
    from ..db import SessionLocal

    try:
        async with SessionLocal() as s:
            await service.parse_doc(s, doc_id)
    except Exception:  # noqa: BLE001
        logger.exception("文档解析任务失败：%s", doc_id)


async def _generate_skill_draft(draft_id: str, agent_id: str, text: str) -> None:
    """后台调一次模型把节选提炼成 SKILL.md；失败落 error，不抛出。"""
    import json

    from ..db import SessionLocal
    from ..llm import chat_once, extract_json
    from ..models import Agent
    from ..runner.service import resolve_credential
    from ..schemas import AgentDefinition

    async with SessionLocal() as session:
        row = await session.get(SkillDraft, draft_id)
        if row is None:
            return
        agent = await session.get(Agent, agent_id) if agent_id else None
        if agent is None:
            ready = (
                await session.execute(select(Agent).order_by(Agent.created_at))
            ).scalars().all()
            agent = next(
                (
                    a
                    for a in ready
                    if ((a.definition or {}).get("model") or {}).get("name")
                    and (a.definition or {}).get("runtime") != "a2a"
                ),
                None,
            )
        if agent is None:
            row.error = {"code": "no_agent", "message": "没有可用的助手来提炼（先建一个配了模型的助手）"}
            await session.commit()
            return
        try:
            definition = AgentDefinition.model_validate(agent.definition or {})
            api_key, base_url = await resolve_credential(definition, session)
            model_cfg = (agent.definition or {}).get("model") or {}
            model_name = str(model_cfg.get("name") or "")
            base = base_url or str(model_cfg.get("base_url") or "")
            if not model_name:
                raise RuntimeError("这个助手没有配置模型")
        except Exception as exc:  # noqa: BLE001
            row.error = {"code": "credential", "message": f"取不到可用模型：{exc}"[:200]}
            await session.commit()
            return

        raw, err = await chat_once(
            base_url=base,
            api_key=str(api_key or ""),
            model=model_name,
            messages=[
                {"role": "system", "content": SKILL_SYSTEM},
                {"role": "user", "content": text[:MAX_SOURCE_CHARS]},
            ],
            timeout=180.0,
        )
        if err:
            row.error = {"code": "llm", "message": err[:300]}
            await session.commit()
            return
        data = extract_json(raw) or {}
        name = str(data.get("name") or "").strip()[:200]
        desc = str(data.get("description") or "").strip()[:400]
        body = str(data.get("body") or "").strip()
        if not name or not body:
            row.error = {"code": "bad_output", "message": f"模型没给出可用内容：{raw[:160]}"}
            await session.commit()
            return
        row.name = name
        row.description = desc
        row.body = body
        row.model = model_name
        row.error = {}
        await session.commit()


#: 自动重跑单并发（本地 embedding 峰值 375MB，并发会把小机器打爆）
_RERUN_LOCK = asyncio.Semaphore(1)


async def _rerun_pipeline(doc_id: str) -> None:
    """文档更新后重跑：解析 → 向量化 → 关键词。失败只记日志，不影响文档可用。"""
    from ..db import SessionLocal
    from ..knowledge.embedding import embed_document

    async with _RERUN_LOCK:
        try:
            async with SessionLocal() as s:
                await service.parse_doc(s, doc_id)
            async with SessionLocal() as s:
                doc = await s.get(Doc, doc_id)
                if doc is not None and doc.status == "ready":
                    try:
                        await embed_document(s, doc)
                    except Exception:  # noqa: BLE001 —— 没配向量化就跳过
                        logger.info("自动重跑：跳过向量化（%s）", doc_id)
            async with SessionLocal() as s:
                chunks = (
                    await s.execute(
                        select(DocChunk.text).where(DocChunk.doc_id == doc_id).order_by(DocChunk.ord)
                    )
                ).scalars().all()
                picks = extract_keywords(list(chunks), title=(doc.name if doc else ""))
                for word, score in picks:
                    tag = await _ensure_tag(s, word, origin="model")
                    if await s.get(DocumentTag, (doc_id, tag.id)) is None:
                        s.add(
                            DocumentTag(
                                doc_id=doc_id, tag_id=tag.id, source="model",
                                confidence=round(min(0.95, 0.45 + score / 40.0), 2),
                                status="candidate",
                            )
                        )
                await s.commit()
        except Exception:  # noqa: BLE001
            logger.warning("自动重跑失败：%s", doc_id, exc_info=True)


#: 回收站保留天数（软删后多久自动彻底删除）
TRASH_TTL_DAYS = 30


async def purge_expired_trash(ttl_days: int = TRASH_TTL_DAYS) -> int:
    """清掉回收站里超过保留期的文档（含原件）。返回删除条数。

    为什么放在进程内而不是 cron：这是**数据保留策略**，跟服务生命周期绑着更可靠；
    平台在别人机器上部署时没有我们的 cron，策略要自己带着走。
    """
    from ..knowledge import index as _zidx
    from ..knowledge import service as _svc

    cutoff = _now() - ttl_days * 86_400_000
    removed = 0
    from ..db import SessionLocal

    async with SessionLocal() as session:
        rows = (
            await session.execute(
                select(Doc).where(Doc.deleted_at.is_not(None), Doc.deleted_at < cutoff)
            )
        ).scalars().all()
        for doc in rows:
            try:
                cfg = await session.get(StorageConfig, doc.storage_id) if doc.storage_id else None
                cfg = cfg or await _svc.default_storage(session)
                prov = _svc.provider_of(cfg)
                for key in {doc.storage_key, getattr(doc, "snapshot_key", "")} - {""}:
                    try:
                        prov.delete(key)
                    except Exception:  # noqa: BLE001
                        pass
                try:
                    await _zidx.delete_document(doc.id)
                except Exception:  # noqa: BLE001
                    pass
                await session.execute(sa_delete(DocChunk).where(DocChunk.doc_id == doc.id))
                await session.execute(sa_delete(DocumentVersion).where(DocumentVersion.doc_id == doc.id))
                await session.execute(sa_delete(DocumentTag).where(DocumentTag.doc_id == doc.id))
                await session.delete(doc)
                await session.commit()
                removed += 1
            except Exception:  # noqa: BLE001 —— 单份失败不该中断整批
                logger.warning("清理回收站失败：%s", doc.id, exc_info=True)
                await session.rollback()
    return removed
