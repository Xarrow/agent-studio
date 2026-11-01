"""事件入口：环境里发生了一件事 → 谁去处理。

对齐《Super-agent》§3「Trigger 进来之后四件事」里最要紧的两条：

* **两级过滤**：程序层先做确定性准入（来源白名单 / 空文本 / 超长 / 重复投递），
  只把候选交给 LLM —— 省掉绝大多数无意义推理。这一层必须**纯函数**，
  因为它跑在每条事件上，而且错了会静默丢事件。
* **订阅与直通**：某个 thread（同一 PR / 同一 IM 话题 / 同一邮件串）已经认了人之后，
  后续事件由程序**直投**那个会话，不再过 Router。文章的实验：去掉直通后 Router
  决策数 +30%、读缓存 token +37%，而完成时间不变 —— 直通买的是成本不是质量。

为什么 Router 是「常驻会话」而不是每次新开会话：
连续性靠它。上一件事的结论、用户的口味、最近派过谁，都在这份上下文里；
每条事件新开会话等于把 Router 降级成一个无状态的分类器。
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..context import next_turn_index
from ..models import Agent, Run, Session as ChatSession, now_ms, new_id
from ..runner import run_service
from ..schemas import AgentDefinition

logger = logging.getLogger(__name__)

#: 单条事件正文上限：再长就该走附件/引用，而不是整段塞进上下文
MAX_TEXT = 8000

#: 来源白名单：空集合 = 不限制（自托管单机默认放开）
ALLOW_SOURCES: frozenset[str] = frozenset()

#: Router 的常驻会话标题。同一份标题只留一个，事件全落在这份上下文里
ROUTER_SESSION_TITLE = "事件入口 · 常驻"


def accept(source: str | None, text: str, meta: dict[str, Any] | None = None) -> tuple[bool, str]:
    """程序层准入（Fast Path）。返回 ``(是否接收, 拒收原因)``。

    纯函数：不查库、不看模型。它挡掉的是"根本不用想"的那一类：
    空事件、超长粘贴、不在白名单的来源。真正的语义判断交给 Router（它才是 LLM）。
    """
    body = (text or "").strip()
    if not body:
        return False, "空事件"
    if len(body) > MAX_TEXT:
        return False, f"正文太长（{len(body)} 字 > {MAX_TEXT}）"
    if ALLOW_SOURCES and (source or "") not in ALLOW_SOURCES:
        return False, f"来源不在白名单：{source or '(空)'}"
    return True, ""


def dedupe_key_of(source: str | None, thread_id: str | None, text: str, meta: dict[str, Any] | None) -> str:
    """重复投递是常态（重试、双写、用户点两下）—— 用内容 + 外部序号算幂等键。"""
    seq = str((meta or {}).get("seq") or "")
    blob = f"{source or ''}|{thread_id or ''}|{seq}|{(text or '').strip()}"
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:32]


async def _router_agent(session: AsyncSession) -> Agent | None:
    """谁是 Router：``role=orchestrator`` 的助手（没有就退回名字里带「编排」的）。"""
    rows = (await session.execute(select(Agent).order_by(Agent.created_at.asc()))).scalars().all()
    for a in rows:
        if ((a.definition or {}).get("role") or "") == "orchestrator":
            return a
    for a in rows:
        if "编排" in (a.name or ""):
            return a
    return None


async def _router_session(session: AsyncSession, agent: Agent) -> ChatSession:
    """Router 的常驻会话：有就复用，没有才建。"""
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
    row = ChatSession(
        id=new_id("ses_"),
        agent_id=agent.id,
        title=ROUTER_SESSION_TITLE,
        status="active",
        created_at=now_ms(),
        last_active_at=now_ms(),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def _start_run(session: AsyncSession, agent: Agent, chat: ChatSession, text: str, origin: str) -> Run:
    """在指定会话里起一条执行（与 /api/runs 的建法保持一致）。"""
    definition = AgentDefinition.model_validate(agent.definition)
    turn_index = await next_turn_index(session, chat.id)
    run = Run(
        agent_id=agent.id,
        agent_version=agent.version,
        runtime=definition.runtime,
        status="pending",
        input={"text": text},
        definition_snapshot=definition.model_dump(mode="json", exclude={"model": {"api_key"}}),
        started_at=now_ms(),
        session_id=chat.id,
        turn_index=turn_index,
        origin=origin,
    )
    session.add(run)
    chat.last_active_at = now_ms()
    await session.commit()
    await session.refresh(run)
    await run_service.start(run.id, definition, text)
    return run


def event_prompt(source: str | None, thread_id: str | None, text: str, meta: dict[str, Any] | None) -> str:
    """投给 Router 的一句话：说明"这是一条事件，不是有人在跟你聊天"。"""
    head = f"【外部事件】来源：{source or '未知'}"
    if thread_id:
        head += f" · thread：{thread_id}"
    if meta:
        small = {k: v for k, v in meta.items() if k in ("title", "url", "author", "seq", "kind")}
        if small:
            head += " · " + json.dumps(small, ensure_ascii=False)
    return (
        f"{head}\n\n{text.strip()}\n\n"
        "—— 这是一条环境事件，没有人正等着你回话（回复会进事件入口的常驻会话）。"
        "你自己判断：要不要处理、派给谁；不需要处理就一句话说明理由，别硬找活干。"
    )


async def ingest(
    session: AsyncSession,
    *,
    source: str | None,
    text: str,
    thread_id: str | None = None,
    meta: dict[str, Any] | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    """收一条事件并决定投给谁。

    三种结果：
      ``{"kind": "rejected", "reason": …}``   程序层就没过（不花钱）
      ``{"kind": "thread", …}``               thread 已认人 → 直投（不过 Router）
      ``{"kind": "router", …}``               交给常驻 Router 判断
    """
    ok, why = accept(source, text, meta)
    if not ok:
        return {"kind": "rejected", "reason": why}

    # ── 直通：这条 thread 已经认了人 ────────────────────────────────
    target_session = None
    if session_id:
        target_session = await session.get(ChatSession, session_id)
    if target_session is None and thread_id:
        from ..models import ThreadSub

        sub = await session.get(ThreadSub, thread_id)
        if sub is not None:
            target_session = await session.get(ChatSession, sub.session_id)

    if target_session is not None:
        agent = await session.get(Agent, target_session.agent_id)
        if agent is not None:
            run = await _start_run(
                session, agent, target_session, event_prompt(source, thread_id, text, meta), "event"
            )
            return {
                "kind": "thread",
                "run_id": run.id,
                "session_id": target_session.id,
                "agent_id": agent.id,
                "agent_name": agent.name,
                "dedupe_key": dedupe_key_of(source, thread_id, text, meta),
            }

    # ── 交给 Router（常驻会话）──────────────────────────────────────
    router_agent = await _router_agent(session)
    if router_agent is None:
        return {"kind": "error", "reason": "没有编排者：请先建一个 role=orchestrator 的助手"}
    chat = await _router_session(session, router_agent)
    run = await _start_run(session, router_agent, chat, event_prompt(source, thread_id, text, meta), "event")
    return {
        "kind": "router",
        "run_id": run.id,
        "session_id": chat.id,
        "agent_id": router_agent.id,
        "agent_name": router_agent.name,
        "dedupe_key": dedupe_key_of(source, thread_id, text, meta),
    }


async def bind_thread(session: AsyncSession, thread_id: str, session_id: str) -> dict[str, Any]:
    """把一条 thread 认给某个会话 —— 之后这条 thread 的事件直投，不再过 Router。"""
    from ..models import ThreadSub

    chat = await session.get(ChatSession, session_id)
    if chat is None:
        raise ValueError(f"会话不存在: {session_id}")
    row = await session.get(ThreadSub, thread_id)
    if row is None:
        row = ThreadSub(thread_id=thread_id, session_id=session_id, agent_id=chat.agent_id, created_at=now_ms())
        session.add(row)
    else:
        row.session_id = session_id
        row.agent_id = chat.agent_id
    await session.commit()
    return {"thread_id": thread_id, "session_id": session_id, "agent_id": chat.agent_id}
