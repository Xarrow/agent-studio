"""zvec 索引：把「关键词检索」从 SQL LIKE 换成真 BM25。

为什么换
========
LIKE 只能回答"这段文字里有没有这个词"，给不出排序：查「违约金」时，
一份提到 5 次的合同和一份顺带提 1 次的文档并列返回，靠 updated_at 排序。
zvec 的原生 FTS 是真 BM25（词频 × 逆文档频 × 长度归一化），
并且支持中文两字词（SQLite FTS5 的 trigram 分词器在 2 字查询上直接失效，实测）。

设计要点
========
* **索引不是真源**：正文永远在 `doc_chunk`，zvec 只做索引，随时能 rebuild。
* **可回退**：任何异常（导入失败、集合损坏、写入超时）都退回 SQL 检索并记 warning，
  绝不让检索整体挂掉。
* **按文档收敛**：检索结果按 doc_id 聚合（一个文档只回一条），与旧的 search() 契约一致。
* **按工作区隔离**：一个工作区一个 collection，放 ``data/work/zvec/<ws>``。
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from .models import Doc, DocChunk

logger = logging.getLogger(__name__)

#: 集合里只放关键词索引需要的字段（向量路以后单独加，不强绑）
_STATUS: dict[str, Any] = {"ready": False, "reason": "未初始化", "docs": 0, "chunks": 0}


def index_dir(workspace_id: str = "ws_default") -> str:
    """集合目录**不要**在这里创建：zvec 的 create 要求路径不存在。"""
    from pathlib import Path

    return str(Path(str(getattr(settings, "work_dir", "data/work"))) / "zvec" / workspace_id)


def _schema():
    import zvec

    return zvec.CollectionSchema(
        name="kb",
        fields=[
            zvec.FieldSchema(name="doc_id", data_type=zvec.DataType.STRING),
            zvec.FieldSchema(name="ord", data_type=zvec.DataType.INT32),
            zvec.FieldSchema(
                name="text",
                data_type=zvec.DataType.STRING,
                index_param=zvec.FtsIndexParam(tokenizer_name="standard"),
            ),
        ],
    )


#: 进程内每个工作区一个句柄。zvec 是单写者锁：同一路径反复 open 会 "Can't lock"。
_COLLECTIONS: dict[str, Any] = {}


def _open(workspace_id: str = "ws_default"):
    """打开（没有就建）集合。任何异常都抛出去，由调用方降级。"""
    import os

    import zvec

    path = index_dir(workspace_id)
    # 缓存键必须是**绝对路径**而不是工作区名：测试与多实例下同一个 ws 会对应不同目录，
    # 按名字缓存会把上一个目录的句柄复用过来（实测导致全量跑时跨用例串数据）。
    got = _COLLECTIONS.get(path)
    if got is not None:
        return got
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    if os.path.isdir(path) and os.listdir(path):
        col = zvec.open(path=path)
    else:
        # 空目录也不行：zvec 的 create 要求路径**不存在**，先把空壳删掉
        if os.path.isdir(path):
            os.rmdir(path)
        col = zvec.create_and_open(path=path, schema=_schema())
    _COLLECTIONS[path] = col
    return col


async def _refresh_meta(session: AsyncSession, workspace_id: str = "ws_default") -> None:
    from sqlalchemy import func

    from .models import DocChunk

    docs = (
        await session.execute(
            select(func.count()).select_from(Doc).where(Doc.deleted_at.is_(None), Doc.status == "ready")
        )
    ).scalar_one()
    chunks = (await session.execute(select(func.count()).select_from(DocChunk))).scalar_one()
    _write_meta(int(docs), int(chunks), workspace_id)


def _doc_id_of(item_id: str) -> str:
    return item_id.split(":", 1)[0]


def _meta_path(workspace_id: str = "ws_default") -> str:
    import os

    return os.path.join(index_dir(workspace_id), "..", f"{workspace_id}.meta.json")


def _write_meta(docs: int, chunks: int, workspace_id: str = "ws_default") -> None:
    """索引条数落一个 sidecar：进程重启后状态还能如实显示（内存计数会归零）。"""
    import json
    import os
    import time

    try:
        path = os.path.abspath(_meta_path(workspace_id))
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"docs": docs, "chunks": chunks, "updated_at": int(time.time() * 1000)}, f)
    except Exception:  # noqa: BLE001
        logger.debug("写索引 meta 失败（忽略）", exc_info=True)


def status(workspace_id: str = "ws_default") -> dict[str, Any]:
    import json
    import os

    try:
        with open(os.path.abspath(_meta_path(workspace_id)), encoding="utf-8") as f:
            meta = json.load(f)
        return {
            "ready": True,
            "reason": "",
            "docs": int(meta.get("docs") or 0),
            "chunks": int(meta.get("chunks") or 0),
            "updated_at": meta.get("updated_at"),
        }
    except Exception:  # noqa: BLE001 —— 还没建过索引
        return dict(_STATUS)


async def upsert_document(session: AsyncSession, doc: Doc, workspace_id: str = "ws_default") -> int:
    """把一份文档的全部块写进索引（先删同 doc_id 的旧块，保证版本更新后不重复）。"""
    import zvec

    chunks = (
        await session.execute(
            select(DocChunk).where(DocChunk.doc_id == doc.id).order_by(DocChunk.ord)
        )
    ).scalars().all()
    if not chunks:
        return 0
    col = _open(workspace_id)
    try:
        col.delete_by_filter(f"doc_id = '{doc.id}'")
    except Exception:  # noqa: BLE001 —— 首次没有旧数据
        pass
    batch: list[Any] = []
    written = 0
    for c in chunks:
        batch.append(
            zvec.Doc(
                id=f"{doc.id}:{doc.version}:{c.ord}",
                fields={"doc_id": doc.id, "ord": int(c.ord), "text": (c.text or "")[:4000]},
            )
        )
        if len(batch) >= 512:  # zvec 单批上限 1024，留一半余量
            col.insert(batch)
            written += len(batch)
            batch = []
    if batch:
        col.insert(batch)
        written += len(batch)
    _STATUS.update(ready=True, reason="", chunks=_STATUS.get("chunks", 0) + written)
    try:
        await _refresh_meta(session, workspace_id)
    except Exception:  # noqa: BLE001
        pass
    return written


async def delete_document(doc_id: str, workspace_id: str = "ws_default") -> None:
    try:
        _open(workspace_id).delete_by_filter(f"doc_id = '{doc_id}'")
    except Exception:  # noqa: BLE001
        logger.warning("zvec 删除失败（忽略）：%s", doc_id, exc_info=True)


async def search(
    session: AsyncSession, query: str, *, limit: int = 20, workspace_id: str = "ws_default"
) -> list[dict[str, Any]]:
    """BM25 检索，按文档聚合。抛异常时调用方退回 SQL。"""
    import zvec

    text = (query or "").strip()
    if not text:
        return []
    col = _open(workspace_id)
    # 中文查询里去掉空白，保留原串；zvec 的 standard 分词器对中文按字/词处理
    q = zvec.Query(field_name="text", fts=zvec.Fts(match_string=text))
    hits = col.query(queries=q, topk=max(limit * 4, 20), output_fields=["doc_id", "ord"])
    if not hits:
        return []

    scored: dict[str, float] = {}
    first_ord: dict[str, int] = {}
    for h in hits:
        did = str(h.fields.get("doc_id") or _doc_id_of(h.id))
        score = float(getattr(h, "score", 0.0) or 0.0)
        if did not in scored:
            scored[did] = score
            first_ord[did] = int(h.fields.get("ord") or 0)
        else:
            scored[did] += score * 0.5  # 同一文档后续块给半权，避免长文档霸榜

    docs = {
        d.id: d
        for d in (
            await session.execute(select(Doc).where(Doc.id.in_(list(scored)), Doc.deleted_at.is_(None)))
        ).scalars().all()
    }
    out: list[dict[str, Any]] = []
    for did, score in sorted(scored.items(), key=lambda x: -x[1]):
        doc = docs.get(did)
        if doc is None:
            continue
        chunk = (
            await session.execute(
                select(DocChunk).where(DocChunk.doc_id == did, DocChunk.ord == first_ord[did]).limit(1)
            )
        ).scalars().first()
        snippet = (chunk.text if chunk else "") or ""
        if text in snippet:
            i = snippet.find(text)
            snippet = snippet[max(0, i - 60) : i + 160]
        out.append(
            {
                "id": doc.id,
                "name": doc.name,
                "kind": doc.kind,
                "status": doc.status,
                "snippet": snippet.replace("\n", " ")[:240],
                "page": chunk.page if chunk else None,
                "sheet": chunk.sheet if chunk else "",
                "updated_at": doc.updated_at,
                "score": round(score, 4),
                "matched_path": "keyword",
            }
        )
        if len(out) >= limit:
            break
    return out


async def rebuild(session: AsyncSession, workspace_id: str = "ws_default") -> dict[str, Any]:
    """从 doc_chunk 全量重灌（唯一可信来源是 SQLite）。"""
    import shutil
    from pathlib import Path

    path = Path(index_dir(workspace_id))
    _COLLECTIONS.pop(str(path), None)  # 句柄先断，否则删目录后旧句柄还锁着
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)
    _STATUS.update(ready=False, reason="重建中", docs=0, chunks=0)
    docs = (
        await session.execute(select(Doc).where(Doc.deleted_at.is_(None)))
    ).scalars().all()
    total = 0
    for d in docs:
        if d.status != "ready":
            continue
        try:
            total += await upsert_document(session, d, workspace_id)
        except Exception:  # noqa: BLE001
            logger.warning("重建索引失败：%s", d.id, exc_info=True)
    _STATUS.update(ready=True, reason="", docs=len(docs), chunks=total)
    _write_meta(len(docs), total, workspace_id)
    return {"docs": len(docs), "chunks": total}
