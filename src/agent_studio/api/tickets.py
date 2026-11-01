"""Ticket 的读写接口：开一张票、记事实、看阶段。

阶段不落库 —— 每次读都用 ``tickets_core.stage()`` 从事实算。
这样做的代价是每次读要算一遍（几微秒），换来的是**不可能出现"状态和事实不一致"**：
以前那种"跑完了但记录还是 running""人回话了可它还显示卡住"的 bug，
在这一层根本没有落脚点。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Agent, Session as ChatSession, Ticket, now_ms
from ..tickets_core import PERSON_STAGES, STAGE_LABEL, stage

router = APIRouter(prefix="/api/tickets", tags=["tickets"])

#: 报告的类型（对应 dsh-superagent 的 Report）
REPORT_KINDS = ("ready", "blocked", "failed", "waiting")


def to_read(tk: Ticket) -> dict[str, Any]:
    facts = tk.facts or {}
    st = stage({**facts, "ended_at": tk.ended_at})
    return {
        "id": tk.id,
        "title": tk.title,
        "thread_id": tk.thread_id,
        "session_id": tk.session_id,
        "agent_id": tk.agent_id,
        "source": tk.source,
        "status": tk.status,
        "ended_by": tk.ended_by,
        "stage": st,
        "stage_label": STAGE_LABEL.get(st, st),
        "needs_person": st in PERSON_STAGES,
        "facts": facts,
        "created_at": tk.created_at,
        "updated_at": tk.updated_at,
        "ended_at": tk.ended_at,
    }


class TicketIn(BaseModel):
    title: str = ""
    #: 属于哪条串（同一 PR / 同一 IM 话题 / 同一会话）
    thread_id: str | None = None
    agent_id: str | None = None
    session_id: str | None = None
    source: str | None = None


@router.post("", status_code=status.HTTP_201_CREATED)
async def open_ticket(payload: TicketIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """开一张票。

    同一 thread 上已经有开着的票就复用它 —— 同一条 PR / 同一个话题不该开出一堆票，
    「一件事」的口径由 thread 决定，不由调用方决定。
    """
    if payload.thread_id:
        existing = (
            await session.execute(
                select(Ticket).where(Ticket.thread_id == payload.thread_id, Ticket.status == "open").limit(1)
            )
        ).scalar_one_or_none()
        if existing is not None:
            return to_read(existing)

    if payload.agent_id and await session.get(Agent, payload.agent_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"助手不存在: {payload.agent_id}")
    if payload.session_id and await session.get(ChatSession, payload.session_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {payload.session_id}")

    tk = Ticket(
        title=(payload.title or "").strip()[:200],
        thread_id=payload.thread_id,
        agent_id=payload.agent_id,
        session_id=payload.session_id,
        source=payload.source,
        status="open",
        facts={},
        created_at=now_ms(),
        updated_at=now_ms(),
    )
    session.add(tk)
    await session.commit()
    await session.refresh(tk)
    return to_read(tk)


@router.get("")
async def list_tickets(
    stage_: str | None = Query(None, alias="stage", description="只看某个阶段"),
    needs_person: bool = Query(False, description="只看等人动手的"),
    open_only: bool = Query(True),
    limit: int = Query(50, ge=1, le=200),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    stmt = select(Ticket).order_by(desc(Ticket.updated_at)).limit(200 if (stage_ or needs_person) else limit)
    if open_only:
        stmt = stmt.where(Ticket.status == "open")
    rows = (await session.execute(stmt)).scalars().all()
    items = [to_read(r) for r in rows]
    if stage_:
        items = [i for i in items if i["stage"] == stage_]
    if needs_person:
        items = [i for i in items if i["needs_person"]]
    counts: dict[str, int] = {}
    for r in rows:
        s = to_read(r)["stage"]
        counts[s] = counts.get(s, 0) + 1
    return {"items": items[:limit], "counts": counts, "labels": STAGE_LABEL}


async def _get(session: AsyncSession, ticket_id: str) -> Ticket:
    tk = await session.get(Ticket, ticket_id)
    if tk is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"这张票不存在: {ticket_id}")
    return tk


class ReportIn(BaseModel):
    kind: str
    text: str = ""
    run_id: str | None = None


@router.post("/{ticket_id}/report")
async def add_report(ticket_id: str, payload: ReportIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """干活的报一句：做完了（ready）/ 卡住了（blocked）/ 失败了（failed）/ 等触发（waiting）。"""
    if payload.kind not in REPORT_KINDS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"kind 只能是 {', '.join(REPORT_KINDS)}")
    tk = await _get(session, ticket_id)
    facts = dict(tk.facts or {})
    reports = list(facts.get("reports") or [])
    reports.append(
        {"kind": payload.kind, "text": (payload.text or "")[:2000], "run_id": payload.run_id, "at": now_ms()}
    )
    facts["reports"] = reports[-20:]
    tk.facts = facts
    tk.updated_at = now_ms()
    await session.commit()
    return to_read(tk)


class AttentionIn(BaseModel):
    question: str = ""


@router.post("/{ticket_id}/attention")
async def raise_attention(ticket_id: str, payload: AttentionIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """举手问人一句 —— 阶段立刻变成「等你的回答」。"""
    tk = await _get(session, ticket_id)
    facts = dict(tk.facts or {})
    facts["attention"] = {"question": (payload.question or "").strip()[:1000], "at": now_ms()}
    tk.facts = facts
    tk.updated_at = now_ms()
    await session.commit()
    return to_read(tk)


@router.post("/{ticket_id}/answer")
async def answer_attention(ticket_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """人回了一句 —— 问题清掉，重新回到工作阶段。"""
    tk = await _get(session, ticket_id)
    facts = dict(tk.facts or {})
    facts.pop("attention", None)
    facts["last_human_at"] = now_ms()
    tk.facts = facts
    tk.updated_at = now_ms()
    await session.commit()
    return to_read(tk)


class EndIn(BaseModel):
    by: str = "human"


@router.post("/{ticket_id}/end")
async def end_ticket(ticket_id: str, payload: EndIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    tk = await _get(session, ticket_id)
    tk.status = "ended"
    tk.ended_by = payload.by
    tk.ended_at = now_ms()
    tk.updated_at = now_ms()
    await session.commit()
    return to_read(tk)
