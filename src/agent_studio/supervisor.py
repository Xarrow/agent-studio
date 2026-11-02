"""Router / Worker：照着 dsh-superagent 重做的执行核心。

三句话概括这套东西
------------------
1. **Router 是入口，也是唯一对用户说话的会话**。它常驻（一份 title 固定的 session），
   工具只到"认路 + 派活"，绝不自己干活 —— 能力边界由平台给，不靠提示词劝。
2. **Worker 是隔离的执行**。每张票一个会话（``worker-<票短名>``），上下文、工作目录、
   工具集都是它自己的。它不直接回用户，只往票上写一条「报告」。
3. **Ticket 是那件持续的事**。它不记状态，只记事实（报告 / 举手 / 当前派活 / 未送达），
   阶段由 ``tickets_core.stage()`` 从事实算出来。

和旧实现的区别（旧的为什么被推翻）
----------------------------------
旧的 ``fork`` 把子执行塞在**同一个 session** 里（``session_id=parent_run.session_id``），
所谓"分派"只是同一条对话里多跑几个 run：上下文混在一起、谁说了什么都分不清，
最后仍然退化成一个能工巧匠式的大会话。这不是 Router/Worker，是"一个人分身"。
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .context import next_turn_index
from .models import Agent, Run, Session as ChatSession, Ticket, now_ms, new_id
from .runner import run_service
from .schemas import AgentDefinition
from .tickets_core import STAGE_LABEL, stage

logger = logging.getLogger(__name__)

#: Router 常驻会话的标题。同一份标题只留一个 —— 上下文连续是 Router 的全部价值
ROUTER_SESSION_TITLE = "Router · 常驻"

#: Worker 会话标题前缀：``worker-<票短名>``
WORKER_PREFIX = "worker-"

#: 线程前缀：对话即线程，一条会话就是一条串
SESSION_THREAD_PREFIX = "ses:"


def thread_of(session_id: str | None) -> str | None:
    return f"{SESSION_THREAD_PREFIX}{session_id}" if session_id else None


async def router_agent(session: AsyncSession) -> Agent | None:
    """谁是 Router：``role=orchestrator`` 的助手。"""
    rows = (await session.execute(select(Agent).order_by(Agent.created_at.asc()))).scalars().all()
    for a in rows:
        if ((a.definition or {}).get("role") or "") == "orchestrator":
            return a
    return None


async def router_session(session: AsyncSession, agent: Agent) -> ChatSession:
    row = (
        await session.execute(
            select(ChatSession)
            .where(ChatSession.agent_id == agent.id, ChatSession.title == ROUTER_SESSION_TITLE)
            .order_by(ChatSession.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if row is not None:
        return row
    row = ChatSession(id=new_id("ses_"), agent_id=agent.id, title=ROUTER_SESSION_TITLE, status="active",
                      created_at=now_ms(), last_active_at=now_ms())
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def worker_session(session: AsyncSession, ticket: Ticket, agent: Agent) -> ChatSession:
    """一张票一个会话；已有就复用（续做同一件事，上下文才算连续）。"""
    if ticket.session_id:
        existing = await session.get(ChatSession, ticket.session_id)
        if existing is not None:
            return existing
    short = ticket.id.replace("tk_", "")[:8]
    row = ChatSession(
        id=new_id("ses_"),
        agent_id=agent.id,
        title=f"{WORKER_PREFIX}{short}",
        status="active",
        created_at=now_ms(),
        last_active_at=now_ms(),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    ticket.session_id = row.id
    ticket.updated_at = now_ms()
    await session.commit()
    return row


async def ensure_ticket(
    session: AsyncSession, *, thread_id: str | None, title: str, agent_id: str | None = None, source: str | None = None
) -> Ticket:
    """按 thread 认票：同一条串上开着的票就复用。

    "一件事"的边界由 thread 定，不由调用方定 —— 否则同一个 PR 会被开成五张票，
    面板上永远看不出哪张是真的。
    """
    if thread_id:
        row = (
            await session.execute(
                select(Ticket).where(Ticket.thread_id == thread_id, Ticket.status == "open").limit(1)
            )
        ).scalar_one_or_none()
        if row is not None:
            return row
    tk = Ticket(id=new_id("tk_"), title=(title or "")[:200], thread_id=thread_id, agent_id=agent_id,
                source=source, status="open", facts={}, created_at=now_ms(), updated_at=now_ms())
    session.add(tk)
    await session.commit()
    await session.refresh(tk)
    return tk


async def _fresh(session: AsyncSession, ticket: Ticket) -> Ticket:
    """拿到这张票的**最新**事实。

    为什么必须 refresh：``wait_run`` 期间别的协程在建 run、写报告；外层持有的 ORM 实例
    会过期，直接读 ``ticket.facts`` 会触发一次**同步**懒加载 —— 在 async 会话上就是
    ``MissingGreenlet: greenlet_spawn has not been called``（现场踩到，dispatch 直接报错）。
    """
    try:
        await session.refresh(ticket)
    except Exception:  # noqa: BLE001 —— 票被删了就让调用方拿旧对象继续
        pass
    return ticket


def _facts(ticket: Ticket) -> dict[str, Any]:
    return dict(ticket.facts or {})


async def record(session: AsyncSession, ticket: Ticket, **patch: Any) -> Ticket:
    await _fresh(session, ticket)
    facts = _facts(ticket)
    facts.update(patch)
    ticket.facts = facts
    ticket.updated_at = now_ms()
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def report(
    session: AsyncSession, ticket: Ticket, kind: str, text: str, run_id: str | None = None, run_status: str | None = None
) -> Ticket:
    """Worker 往票上写一条报告：ready / blocked / failed / waiting。"""
    await _fresh(session, ticket)
    facts = _facts(ticket)
    rows = list(facts.get("reports") or [])
    rows.append({"kind": kind, "text": (text or "")[:4000], "run_id": run_id, "at": now_ms()})
    facts["reports"] = rows[-20:]
    # 这一次派活结束了 —— 把 assignment 也落成终态，否则票会永远显示"在干"
    if run_status:
        assignment = dict(facts.get("assignment") or {})
        assignment["status"] = run_status
        facts["assignment"] = assignment
    ticket.facts = facts
    ticket.updated_at = now_ms()
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def start_worker(
    session: AsyncSession,
    ticket: Ticket,
    agent: Agent,
    task: str,
    *,
    timeout_s: int | None = None,
    parent_run_id: str | None = None,
) -> Run:
    """给这张票开一次 worker 执行（独立会话、独立上下文）。"""
    chat = await worker_session(session, ticket, agent)
    definition = AgentDefinition.model_validate(agent.definition)
    if timeout_s:
        definition.limits.timeout_s = timeout_s
    turn = await next_turn_index(session, chat.id)
    run = Run(
        agent_id=agent.id,
        agent_version=agent.version,
        runtime=definition.runtime,
        status="pending",
        input={"text": task},
        definition_snapshot=definition.model_dump(mode="json", exclude={"model": {"api_key"}}),
        started_at=now_ms(),
        session_id=chat.id,
        turn_index=turn,
        origin="worker",
        # 记清「这次的活是谁派的」：界面上要能把 worker 的过程挂回派活那一条
        parent_run_id=parent_run_id,
    )
    session.add(run)
    await record(
        session,
        ticket,
        assignment={
            "run_id": run.id,
            "status": "running",
            "task": task[:500],
            # 票 ↔ worker 会话的对应关系：界面上要能从会话反查"这是哪件活"
            "session_id": chat.id,
            "agent_id": agent.id,
        },
    )
    await session.refresh(run)
    await run_service.start(run.id, definition, task)
    return run


async def wait_run(session: AsyncSession, run_id: str, timeout_s: float = 900) -> Run:
    """等一次执行收尾（轮询库，不靠内存回调 —— 重启后也能对上）。"""
    import asyncio

    import time as _t

    from .db import SessionLocal

    deadline = _t.monotonic() + timeout_s
    while _t.monotonic() < deadline:
        # 每次用**新会话**查：复用外层会话会把它的对象图搞过期，后面的读就变成同步懒加载
        async with SessionLocal() as poll:
            run = await poll.get(Run, run_id)
            if run is not None and run.status in ("ok", "error", "aborted"):
                return run
        await asyncio.sleep(1.0)
    async with SessionLocal() as poll:
        run = await poll.get(Run, run_id)
    if run is None:  # pragma: no cover - 理论上不会
        raise RuntimeError(f"执行不见了: {run_id}")
    return run


def summarize(run: Run) -> str:
    out = run.output or {}
    text = (out.get("content") if isinstance(out, dict) else str(out)) or ""
    return str(text).strip()


def stage_of(ticket: Ticket) -> tuple[str, str]:
    st = stage({**(ticket.facts or {}), "ended_at": ticket.ended_at})
    return st, STAGE_LABEL.get(st, st)
