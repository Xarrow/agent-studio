"""整理 Agent：把文档读一遍，产出「分类 / 标签 / 摘要」建议 —— 只产出草稿。

为什么要草稿区
==============
模型给出的分类和标签一定会有错的时候。让它们**直接生效**，用户第二天会发现
分类树被改得面目全非，而且很难知道"是谁改的、基于什么"。所以这里的边界是：
整理只写 `organize_draft`，人点「采纳」才动 `doc` 表。
skill 类草稿同理 —— 落盘到 workspace 命名空间之前必须有人看过正文。
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..llm import chat_once, extract_json
from .models import Doc, DocChunk, OrganizeDraft, OrganizeJob

logger = logging.getLogger(__name__)

PROMPT_VERSION = "org-1"
#: 单份文档送进模型的字符上限（够看清主题，又不至于把整本书塞进去）
MAX_INPUT_CHARS = 6000

SKILL_SYSTEM = """你是知识库的“技能提炼”助手。用户会给你一份文档的正文节选。
请把它提炼成一条**可复用的技能**（SKILL.md），只输出一个 JSON 对象，不要解释、不要代码块：
{"name":"技能名（中文，2~10 字）","description":"一句话说明什么时候用它（不超过 60 字）","body":"SKILL.md 正文（Markdown，200~1200 字）"}
body 必须包含这些小节：
## 适用场景   —— 什么任务该用它；
## 步骤       —— 3~7 步，每步是可直接照做的动作，写清判断条件和边界；
## 验收       —— 怎么算做对了；
## 来源要点   —— 从文档里提炼的关键规则/参数/阈值（数字要照抄，不许编）。
只写文档里能支撑的内容；文档没写的细节就写「文档未覆盖，需要现场确认」。"""

SYSTEM = """你是知识库整理助手。用户会给你一份文档的正文节选。
请只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码块，格式：
{"category":"分类名（2~6 字，尽量复用已有分类）","tags":["标签1","标签2"],"summary":"80 字以内的中文摘要","confidence":0~1}
要求：
- category 用中文短名词，不要带「类」「文档」这类后缀；
- tags 给 1~4 个，具体到主题/对象（如「采购」「甲方义务」），不要泛词（如「文档」「资料」）；
- summary 说清「这份文档讲什么、能用来做什么」，不要复述标题；
- 不确定就把 confidence 调低，不要编造正文里没有的内容。"""


def _text_of(chunks: list[DocChunk]) -> str:
    buf: list[str] = []
    total = 0
    for c in chunks:
        piece = (c.text or "").strip()
        if not piece:
            continue
        if total + len(piece) > MAX_INPUT_CHARS:
            piece = piece[: max(0, MAX_INPUT_CHARS - total)]
        buf.append(piece)
        total += len(piece)
        if total >= MAX_INPUT_CHARS:
            break
    return "\n\n".join(buf)


async def run_job(job_id: str) -> None:
    """后台跑一次整理：每份文档调一次模型，结果写成草稿。"""
    from ..db import SessionLocal
    from ..models import Agent
    from ..runner.service import resolve_credential
    from ..schemas import AgentDefinition

    async with SessionLocal() as session:
        job = await session.get(OrganizeJob, job_id)
        if job is None:
            return
        job.status = "running"
        await session.commit()

        agent = await session.get(Agent, job.agent_id) if job.agent_id else None
        if agent is None:
            job.status = "failed"
            job.error = {"code": "no_agent", "message": "没找到执行整理的助手"}
            job.finished_at = int(time.time() * 1000)
            await session.commit()
            return

        try:
            definition = AgentDefinition.model_validate(agent.definition or {})
            api_key, base_url = await resolve_credential(definition, session)
            model = (agent.definition or {}).get("model", {})
            model_name = str(model.get("name") or "")
            base = base_url or str(model.get("base_url") or "")
        except Exception as exc:  # noqa: BLE001
            job.status = "failed"
            job.error = {"code": "credential", "message": f"取不到可用的凭据：{exc}"[:300]}
            job.finished_at = int(time.time() * 1000)
            await session.commit()
            return

        if not model_name:
            job.status = "failed"
            job.error = {
                "code": "no_model",
                "message": "这个助手没有配置模型（A2A 影子助手只能转发，不能自己整理）",
            }
            job.finished_at = int(time.time() * 1000)
            await session.commit()
            return

        made = 0
        failed = 0
        for doc_id in job.doc_ids or []:
            doc = await session.get(Doc, doc_id)
            if doc is None:
                failed += 1
                continue
            chunks = (
                await session.execute(
                    select(DocChunk).where(DocChunk.doc_id == doc_id).order_by(DocChunk.ord).limit(12)
                )
            ).scalars().all()
            text = _text_of(list(chunks))
            if not text:
                failed += 1
                continue
            skill_mode = "skill" in (job.kinds or [])
            reply, err = await chat_once(
                base_url=base,
                api_key=api_key or "",
                model=model_name,
                messages=[
                    {"role": "system", "content": SKILL_SYSTEM if skill_mode else SYSTEM},
                    {"role": "user", "content": f"文档名：{doc.name}\n\n正文节选：\n{text}"},
                ],
                timeout=90.0,
                temperature=0.0,
            )
            if err:
                logger.warning("整理 %s 失败：%s", doc_id, err)
                failed += 1
                continue
            data = extract_json(reply)
            if not isinstance(data, dict):
                failed += 1
                continue
            if "skill" in (job.kinds or []):
                seeded = _skill_draft_of(doc, data)
                if seeded is not None:
                    session.add(
                        OrganizeDraft(
                            job_id=job.id, doc_id=doc.id, kind="skill", payload=seeded
                        )
                    )
                    made += 1
                continue
            for kind, payload in _drafts_of(doc, data):
                session.add(
                    OrganizeDraft(job_id=job.id, doc_id=doc.id, kind=kind, payload=payload)
                )
                made += 1

        job.status = "done" if made else ("failed" if failed else "done")
        job.error = {"code": "all_failed", "message": "所有文档都没整理成功，检查模型配置"} if not made and failed else {}
        job.finished_at = int(time.time() * 1000)
        job.made = made
        job.failed = failed
        await session.commit()
        logger.info("整理完成 %s：草稿 %d，失败 %d", job.id, made, failed)


def _drafts_of(doc: Doc, data: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    out: list[tuple[str, dict[str, Any]]] = []
    cat = str(data.get("category") or "").strip()
    if cat:
        out.append(("category", {"name": cat[:60], "confidence": _conf(data.get("confidence"))}))
    tags = [str(t).strip()[:40] for t in (data.get("tags") or []) if str(t).strip()]
    tags = [t for t in dict.fromkeys(tags) if t not in (doc.tags or [])][:6]
    if tags:
        out.append(("tags", {"add": tags, "confidence": _conf(data.get("confidence"))}))
    summary = str(data.get("summary") or "").strip()
    if summary:
        out.append(("summary", {"text": summary[:400], "confidence": _conf(data.get("confidence"))}))
    return out


def _skill_draft_of(doc: Doc, data: dict[str, Any]) -> dict[str, Any] | None:
    body = str(data.get("body") or "").strip()
    name = str(data.get("name") or "").strip()[:60]
    if not body or not name:
        return None
    desc = str(data.get("description") or "").strip()[:120]
    # 统一带上 frontmatter：parse_skill_md 靠它取名字与描述
    content = (
        "---\n"
        f"name: {name}\n"
        f"description: {desc}\n"
        "---\n\n"
        f"{body}\n\n"
        f"> 来源文档：{doc.name}（doc_id: {doc.id}）\n"
    )
    return {
        "name": name,
        "description": desc,
        "body": content,
        "doc_id": doc.id,
        "doc_name": doc.name,
    }


def _conf(v: Any) -> float:
    try:
        return max(0.0, min(1.0, float(v)))
    except (TypeError, ValueError):
        return 0.5


def draft_view(row: OrganizeDraft, doc_name: str = "") -> dict[str, Any]:
    return {
        "id": row.id,
        "job_id": row.job_id,
        "doc_id": row.doc_id,
        "doc_name": doc_name,
        "kind": row.kind,
        "payload": row.payload or {},
        "status": row.status,
        "created_at": row.created_at,
    }
