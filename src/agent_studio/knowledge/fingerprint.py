"""Skill 的「来源指纹」：判断它生成之后来源有没有变。

为什么要它
==========
Skill 是从文档/标签里提炼出来的。文档出了新版本、标签下加了新文档之后，
旧 Skill 就过时了 —— 但这件事**不会报错**：它只是回答得越来越像上个月的合同。
指纹让"过时"变成可以显示的一个布尔值。

指纹算的是什么（只算事实，不算正文）
====================================
* 每份来源文档：``id:版本:更新时间``
* 每个来源标签：``id:该标签下已采纳的文档 id 集合``

正文没变但版本号变了也算变化 —— 这是有意的：宁可多提示一次，不要让用户拿着一份
跟原文对不上的技能去执行。
"""

from __future__ import annotations

import hashlib

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Doc, DocumentTag


async def fingerprint(
    session: AsyncSession, doc_ids: list[str], tag_ids: list[str]
) -> str:
    if not doc_ids and not tag_ids:
        return ""
    parts: list[str] = []
    if doc_ids:
        rows = (
            await session.execute(
                select(Doc.id, Doc.version, Doc.updated_at).where(Doc.id.in_(doc_ids))
            )
        ).all()
        for did, ver, ts in sorted(rows):
            parts.append(f"d:{did}:{ver}:{ts}")
    for tid in sorted(set(tag_ids)):
        docs = (
            await session.execute(
                select(DocumentTag.doc_id).where(
                    DocumentTag.tag_id == tid, DocumentTag.status == "accepted"
                )
            )
        ).scalars().all()
        parts.append(f"t:{tid}:{','.join(sorted(x for x in docs if x))}")
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:32]


async def stale_map(session: AsyncSession, skills: list[object]) -> dict[str, bool]:
    """给一批 Skill 算「来源是否已变化」。

    只算带来源的（人工手写的技能没有来源，永远不算过时）。
    一次查询拿全部来源文档，避免 N+1。
    """
    with_src = [
        s
        for s in skills
        if (getattr(s, "source_doc_ids", None) or getattr(s, "source_tag_ids", None))
    ]
    if not with_src:
        return {}
    all_doc_ids = {
        d for s in with_src for d in (getattr(s, "source_doc_ids", None) or [])
    }
    doc_rows = {}
    if all_doc_ids:
        rows = (
            await session.execute(
                select(Doc.id, Doc.version, Doc.updated_at).where(Doc.id.in_(all_doc_ids))
            )
        ).all()
        doc_rows = {r[0]: (r[1], r[2]) for r in rows}
    tag_docs: dict[str, list[str]] = {}
    all_tag_ids = {t for s in with_src for t in (getattr(s, "source_tag_ids", None) or [])}
    for tid in all_tag_ids:
        docs = (
            await session.execute(
                select(DocumentTag.doc_id).where(
                    DocumentTag.tag_id == tid, DocumentTag.status == "accepted"
                )
            )
        ).scalars().all()
        tag_docs[tid] = sorted(x for x in docs if x)

    out: dict[str, bool] = {}
    for s in with_src:
        parts: list[str] = []
        for did in sorted(getattr(s, "source_doc_ids", None) or []):
            ver_ts = doc_rows.get(did)
            if ver_ts is None:
                parts.append(f"d:{did}:gone")  # 来源文档被删：算变化
            else:
                parts.append(f"d:{did}:{ver_ts[0]}:{ver_ts[1]}")
        for tid in sorted(set(getattr(s, "source_tag_ids", None) or [])):
            parts.append(f"t:{tid}:{','.join(tag_docs.get(tid, []))}")
        now_fp = hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:32]
        saved = getattr(s, "source_fp", "") or ""
        out[getattr(s, "id")] = bool(saved) and saved != now_fp
    return out
