"""会话路由 —— 多轮对话的容器管理。

会话是"短期记忆"的载体：Run 记录单次执行，Session 把多次执行串成一段对话。
两者是一对多（``run.session_id``），删除会话会级联清掉其消息，
但**不删 Run** —— Run 是观测资产，会话是对话组织方式。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..context import clear_context
from ..db import get_session
from ..models import Agent, Run, Session as ChatSession, SessionMessage, new_id, now_ms
from ..schemas import (
    SessionClearContextRequest,
    SessionCreate,
    SessionDetail,
    SessionMessageRead,
    SessionRead,
    SessionUpdate,
)

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


async def _agent_names(session: AsyncSession, agent_ids: list[str]) -> dict[str, str]:
    if not agent_ids:
        return {}
    rows = (
        await session.execute(select(Agent.id, Agent.name).where(Agent.id.in_(set(agent_ids))))
    ).all()
    return {r[0]: r[1] for r in rows}


def _to_read(row: ChatSession, turn_count: int = 0, agent_name: str | None = None) -> SessionRead:
    return SessionRead(
        id=row.id,
        workspace_id=row.workspace_id,
        agent_id=row.agent_id,
        title=row.title or "",
        status=row.status,
        summary=row.summary,
        summarized_upto=row.summarized_upto or 0,
        message_count=row.message_count or 0,
        usage=row.usage or {},
        created_at=row.created_at,
        last_active_at=row.last_active_at,
        turn_count=turn_count,
        agent_name=agent_name,
    )


@router.post("", response_model=SessionRead, status_code=status.HTTP_201_CREATED)
async def create_session(
    payload: SessionCreate, session: AsyncSession = Depends(get_session)
) -> SessionRead:
    agent = await session.get(Agent, payload.agent_id)
    if agent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Agent 不存在: {payload.agent_id}")

    row = ChatSession(
        id=new_id("ses_"),
        agent_id=agent.id,
        title=(payload.title or "").strip()[:200],
        status="active",
        created_at=now_ms(),
        last_active_at=now_ms(),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _to_read(row, 0, agent.name)


@router.get("", response_model=list[SessionRead])
async def list_sessions(
    agent_id: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=50, le=200),
    session: AsyncSession = Depends(get_session),
) -> list[SessionRead]:
    stmt = select(ChatSession).order_by(ChatSession.last_active_at.desc()).limit(limit)
    if agent_id:
        stmt = stmt.where(ChatSession.agent_id == agent_id)
    if status_filter:
        stmt = stmt.where(ChatSession.status == status_filter)
    rows = list((await session.execute(stmt)).scalars().all())

    names = await _agent_names(session, [r.agent_id for r in rows])
    out: list[SessionRead] = []
    for r in rows:
        turns = (
            await session.execute(
                select(func.count(func.distinct(SessionMessage.turn_index))).where(
                    SessionMessage.session_id == r.id
                )
            )
        ).scalar_one()
        out.append(_to_read(r, int(turns or 0), names.get(r.agent_id)))
    return out


@router.get("/{session_id}", response_model=SessionDetail)
async def get_session_detail(
    session_id: str, session: AsyncSession = Depends(get_session)
) -> SessionDetail:
    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")

    rows = (
        await session.execute(
            select(SessionMessage)
            .where(SessionMessage.session_id == session_id)
            .order_by(SessionMessage.turn_index, SessionMessage.id)
        )
    ).scalars().all()
    names = await _agent_names(session, [row.agent_id])
    turns = len({r.turn_index for r in rows})
    return SessionDetail(
        session=_to_read(row, turns, names.get(row.agent_id)),
        messages=[
            SessionMessageRead(
                id=r.id, turn_index=r.turn_index, role=r.role,
                content=r.content, run_id=r.run_id, ts=r.ts,
            )
            for r in rows
        ],
    )


@router.patch("/{session_id}", response_model=SessionRead)
async def update_session(
    session_id: str, payload: SessionUpdate, session: AsyncSession = Depends(get_session)
) -> SessionRead:
    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")
    if payload.title is not None:
        row.title = payload.title.strip()[:200]
    if payload.status is not None:
        row.status = payload.status
    row.last_active_at = now_ms()
    await session.commit()
    await session.refresh(row)
    names = await _agent_names(session, [row.agent_id])
    return _to_read(row, 0, names.get(row.agent_id))


@router.delete("/{session_id}")
async def delete_session(
    session_id: str, session: AsyncSession = Depends(get_session)
) -> dict:
    """删除会话（消息级联清理；**不影响** Run 记录）。"""
    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")
    # 解绑 Run 的会话归属，避免留下悬空引用（Run 本身保留）
    runs = (
        await session.execute(select(Run).where(Run.session_id == session_id))
    ).scalars().all()
    for run in runs:
        run.session_id = None
    await session.delete(row)
    await session.commit()
    return {"deleted": 1, "unbound_runs": len(runs)}


@router.post("/{session_id}/clear-context")
async def clear_session_context(
    session_id: str,
    payload: SessionClearContextRequest | None = None,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """清空上下文（保留会话）—— "重新开始聊，但别新建会话"。"""
    row = await session.get(ChatSession, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")
    removed = await clear_context(
        session, session_id, keep_summary=bool(payload and payload.keep_summary)
    )
    return {"removed_messages": removed}
