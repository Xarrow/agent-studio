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

#: 收口那轮"投递"失败时的退避（秒）。2s 起翻倍，封顶 60s，共 5 次 ——
#: 派活的活都干完了、却没把结论送到，等于白干，所以宁可重试。
#: 测试里把它改成全 0，避免真睡。
SUMMARIZE_RETRY_DELAYS: tuple[float, ...] = (2.0, 4.0, 8.0, 16.0, 32.0)

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


async def ensure_ticket(
    session: AsyncSession,
    *,
    thread_id: str | None,
    title: str,
    agent_id: str | None = None,
    source: str | None = None,
    force_new: bool = False,
) -> Ticket:
    """按 thread 认票：同一条串上开着的票就复用。

    "一件事"的边界由 thread 定，不由调用方定 —— 否则同一个 PR 会被开成五张票，
    面板上永远看不出哪张是真的。
    """
    if thread_id and not force_new:
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


async def worker_session(session: AsyncSession, ticket: Ticket, agent: Agent) -> ChatSession:
    """这张票 + 这个助手 一个会话；已有就复用（续做同一件事，上下文才算连续）。

    **按 (票, 助手) 而不是按票**：一个 Router 对 N 个 worker，同一件跨域需求会同时派给
    好几个域的人。若按票共用一个会话，两个助手会在同一段历史里交替说话 ——
    上下文互相污染，等于又回到"一个人分身"。实测：简明助手和通用助手曾被塞进
    同一个 `worker-xxx` 会话里，turn 1 / turn 1 各说各话。
    """
    import re as _re

    facts = _facts(ticket)
    smap: dict[str, str] = dict(facts.get("sessions") or {})
    sid = smap.get(agent.id)
    if sid:
        row = await session.get(ChatSession, sid)
        if row is not None:
            return row
    # 老数据：ticket.session_id 是这张票最早那个 worker 的会话，只归它自己
    if ticket.session_id:
        old = await session.get(ChatSession, ticket.session_id)
        if old is not None and old.agent_id == agent.id:
            smap[agent.id] = old.id
            await record(session, ticket, sessions=smap)
            return old

    short = ticket.id.replace("tk_", "")[:8]
    suffix = ""
    if smap:  # 这张票已经有别的 worker 会话了：标题里带上助手名，别看起来像同一个
        suffix = "-" + (_re.sub(r"\W+", "", agent.name) or "w")[:4]
    row = ChatSession(
        id=new_id("ses_"),
        agent_id=agent.id,
        title=f"{WORKER_PREFIX}{short}{suffix}",
        status="active",
        created_at=now_ms(),
        last_active_at=now_ms(),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    smap[agent.id] = row.id
    if not ticket.session_id:
        ticket.session_id = row.id
    # 先单独提交：record() 一进来会 refresh(ticket)，未提交的字段改动会被冲掉
    await session.commit()
    await record(session, ticket, sessions=smap)
    await session.refresh(row)
    return row


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
    await session.flush()  # 先落 id：票上要记"这一票是哪几条 run 跑出来的"
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
        run_ids=[*((_facts(ticket).get("run_ids") or [])[-49:]), run.id],
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


# --------------------------------------------------------------------------- #
# 事件驱动：worker 跑完自己回来汇报，攒齐一批后叫 Router 收口
# --------------------------------------------------------------------------- #

#: 同一批（同一个 Router run 派出去的）只允许收口一次。进程内锁够用：
#: 部署是单进程 uvicorn；重启后即便重复触发，下面还会用"有没有在跑"再挡一层。
_summary_locks: dict[str, Any] = {}


def _run_text(run: Run) -> str:
    out = run.output or {}
    if isinstance(out, dict):
        return str(out.get("content") or "")
    return str(out or "")


async def watch_worker(
    *, parent_run_id: str, session_id: str, run_id: str, ticket_id: str, agent_name: str
) -> None:
    """盯住一个 worker：它收尾 → 写报告 → 同一批都回来了就叫 Router 收口。

    为什么要这样：dispatch 现在**不阻塞**（Router 派完就继续判断/继续派），
    所以"活干完了"这件事必须是**事件**推回来，而不是让 Router 在那儿等。
    另外 Router 可能还没结束自己的那一轮（它在巡检/继续派别的）——
    worker 一收尾就把状态**插话**进正在跑的 Router 轮（steer 通道），
    它下一步推理就能看到「谁回来了、结果是什么」，不用干等到 kick_summary。
    """
    import asyncio

    from sqlalchemy import select as _select

    #: 巡检节奏：worker 跑多久后做第一次中途巡检、之后每隔多久再看一眼
    #: （实测 Router 那轮常常 20 秒就自己结束了 —— 巡检必须由平台兜底，不能指望模型自觉）
    FIRST_PROBE_S = 45
    PROBE_EVERY_S = 90
    #: 最多中途巡检几次（收口轮才是终局；巡检轮不是无限循环）
    MAX_PROBES = 3

    async def _probe_once() -> bool:
        """worker 还在跑、Router 那轮已结束 → 起一轮巡检把真实画像喂给 Router。

        返回是否起了巡检轮。巡检轮起来后 Router 会用 worker_status/steer/stop 处置。
        """
        from .db import SessionLocal

        async with SessionLocal() as s:
            row = await s.get(Run, run_id)
            if row is None or row.status not in ("pending", "running"):
                return False  # 已经收尾，交给终态推送
            # Router 那轮还在跑 → 它自己能看见（steer 推送会来），不用替它起轮
            parent_busy = (
                await s.execute(
                    _select(Run).where(
                        Run.id == parent_run_id, Run.status.in_(("pending", "running"))
                    )
                )
            ).scalars().first()
            if parent_busy is not None:
                return False
            # 巡检轮别连环起：**排除刚结束的那一轮 Router 自己**（它就是派出活的这轮，
            # 一定在 3 分钟窗口内 —— 不排除的话探针永远被它挡住，巡检永远起不来）。
            # 只看「自动起过的轮」（收口/巡检都算）：人工消息起的轮不拦巡检。
            recent = (
                await s.execute(
                    _select(Run).where(
                        Run.session_id == session_id,
                        Run.origin == "router",
                        Run.id != parent_run_id,
                        Run.started_at >= now_ms() - 180_000,
                    )
                )
            ).scalars().first()
            if recent is not None:
                return False
        # 拿 worker 的真实画像（worker_status 文本），喂给 Router 巡检轮
        from .agent_ops import _worker_status

        profile = await _worker_status(agent_name)
        digest = (
            f"【自动巡检 · 你派的活还没回来，去看看】\n"
            f"你派给【{agent_name}】的活（run {run_id}）已经跑了一阵还没收尾，"
            f"你上一轮已经结束了 —— 现在由平台把你叫回来看一眼。\n\n"
            f"当前画像：\n{profile}\n\n"
            f"判断：方向对就继续等（什么也不用做，等回报）；绕路/卡住用 worker_steer 纠偏；"
            f"方向错了 worker_stop 停掉重派。只做处置动作，不用向用户长篇汇报。"
        )
        spawned = await _spawn_router_turn(session_id, digest)
        if spawned:
            logger.info(
                "worker 巡检轮已起 parent=%s worker=%s → run=%s", parent_run_id, run_id, spawned
            )
        return bool(spawned)

    async def _watch() -> None:
        from .db import SessionLocal

        # ── 中途巡检：worker 在跑期间定期看一眼 ──────────────────────
        # Router 那轮多半早就结束了 —— 那就由平台起巡检轮替它看（用户拍板的闭环语义）。
        try:
            elapsed = 0.0
            probes = 0
            while elapsed < 1800:
                await asyncio.sleep(FIRST_PROBE_S if probes == 0 else PROBE_EVERY_S)
                elapsed += FIRST_PROBE_S if probes == 0 else PROBE_EVERY_S
                probes += 1
                if probes > MAX_PROBES:
                    break
                try:
                    async with SessionLocal() as s:
                        row = await s.get(Run, run_id)
                        if row is None or row.status not in ("pending", "running"):
                            break  # 收尾了，跳出巡检循环走终态推送
                    await _probe_once()
                except Exception:  # noqa: BLE001
                    logger.exception("巡检探针失败 run=%s", run_id)
        except Exception:  # noqa: BLE001
            logger.exception("巡检循环异常 run=%s", run_id)

        # ── 终态：等收尾 → 推送/写报告/收口 ──────────────────────────
        try:
            async with SessionLocal() as poll:
                done = await wait_run(poll, run_id, timeout_s=1800)
                status, text = done.status, _run_text(done)
        except Exception:  # noqa: BLE001 - 盯人失败不能把进程带崩
            logger.exception("等 worker 收尾失败 run=%s", run_id)
            return
        # Router 那一轮还在跑 → 直接推给它（它正等着呢）；结束了 → 走收口通道
        mark = {"ok": "✅ 完成", "error": "❌ 失败", "aborted": "⏹ 被停"}.get(status, status)
        digest = (text or done.error or "").strip().replace("\n", " ")[:300]
        from . import steer as steer_registry

        result = await steer_registry.deliver(
            parent_run_id,
            f"[worker 回报] 【{agent_name}】{mark}（run {run_id}）。结果摘要：{digest or '（无产出）'}",
        )
        if result == steer_registry.SteerResult.DELIVERED:
            logger.info("worker 回报已推给在跑的 Router parent=%s worker=%s", parent_run_id, run_id)
        try:
            async with SessionLocal() as s:
                tk = await s.get(Ticket, ticket_id)
                if tk is not None:
                    # aborted 是「被停的」不是「干砸的」：单独标 kind，Router 收口时才分得清
                    kind = {"ok": "ready", "error": "failed"}.get(status, "stopped")
                    await report(
                        s,
                        tk,
                        kind,
                        text or (done.error if status == "aborted" else ""),
                        run_id=run_id,
                        run_status=status,
                    )
        except Exception:  # noqa: BLE001
            logger.exception("写报告失败 ticket=%s", ticket_id)
        try:
            await kick_summary(parent_run_id=parent_run_id, session_id=session_id, agent_name=agent_name)
        except Exception:  # noqa: BLE001
            logger.exception("触发收口失败 parent=%s", parent_run_id)

    asyncio.create_task(_watch())


async def _spawn_router_turn(session_id: str, digest: str, *, close_tickets: list[str] | None = None) -> str | None:
    """在 Router 会话里起一轮（收口/巡检共用）。

    判据（防重复起轮）：会话里已经有一轮在跑就不插队；5 分钟内同口径的自动轮已起过
    就不重复。返回新 run id，没起成返回 None。
    """
    import asyncio

    from sqlalchemy import select as _select

    from .db import SessionLocal

    if not session_id:
        return None
    async with SessionLocal() as s:
        chat = await s.get(ChatSession, session_id)
        if chat is None:
            return None
        busy = (
            await s.execute(
                _select(Run).where(
                    Run.session_id == session_id, Run.status.in_(("pending", "running"))
                )
            )
        ).scalars().first()
        if busy is not None:
            return None
        agent = await s.get(Agent, chat.agent_id)
        if agent is None:
            return None
        definition = AgentDefinition.model_validate(agent.definition)
        turn = await next_turn_index(s, chat.id)
        run = Run(
            agent_id=agent.id,
            agent_version=agent.version,
            runtime=definition.runtime,
            status="pending",
            input={"text": digest},
            definition_snapshot=definition.model_dump(mode="json", exclude={"model": {"api_key"}}),
            started_at=now_ms(),
            session_id=chat.id,
            turn_index=turn,
            origin="router",
        )
        s.add(run)
        for tk_id in close_tickets or []:
            tk = await s.get(Ticket, tk_id)
            if tk is not None and tk.status == "open":
                tk.status = "ended"
                tk.ended_at = now_ms()
                facts = _facts(tk)
                facts["closed_by"] = "router"
                tk.facts = facts
                tk.updated_at = now_ms()
        await s.commit()
        await s.refresh(run)
        ok = await _start_with_retry(run.id, definition, digest, chat.id)
        if ok:
            return run.id
        return None


async def kick_summary(*, parent_run_id: str, session_id: str, agent_name: str = "") -> None:
    """同一批 worker 全部收尾 → 在该会话里起一轮 Router，把结果收口。

    判断三件事：①这一批还有没有在跑的 ②会话里是不是已经有一轮在跑 ③这一批是不是
    已经收口过。
    """
    import asyncio

    from sqlalchemy import select as _select

    from .db import SessionLocal

    lock = _summary_locks.setdefault(parent_run_id, asyncio.Lock())
    if lock.locked():
        return
    async with lock:
        async with SessionLocal() as s:
            siblings = (
                await s.execute(_select(Run).where(Run.parent_run_id == parent_run_id))
            ).scalars().all()
            if not siblings:
                return
            if any(r.status in ("pending", "running") for r in siblings):
                return  # 还有活没交回来，等最后一个再来叫
            chat = await s.get(ChatSession, session_id) if session_id else None
            if chat is None:
                return
            # 会话里已经有一轮在跑（人工又发了话）—— 不插队，让那一轮自己看历史
            busy = (
                await s.execute(
                    _select(Run).where(
                        Run.session_id == session_id, Run.status.in_(("pending", "running"))
                    )
                )
            ).scalars().first()
            if busy is not None:
                return
            # 这一批 5 分钟内已经收口过就不再重复（防止两次收尾擦肩各触发一次）
            recent = (
                await s.execute(
                    _select(Run).where(
                        Run.session_id == session_id,
                        Run.origin == "router",
                        Run.started_at >= now_ms() - 300_000,
                    )
                )
            ).scalars().all()
            latest_child = max((r.ended_at or r.started_at for r in siblings), default=0)
            if any((r.started_at or 0) >= latest_child for r in recent):
                return

            # run → 票 一次建表，别在循环里反复扫票
            run_to_ticket: dict[str, str] = {}
            for tk_row in (await s.execute(_select(Ticket))).scalars().all():
                for rid in (tk_row.facts or {}).get("run_ids") or []:
                    run_to_ticket[str(rid)] = tk_row.id

            tickets_of_batch: list[tuple[str, str]] = []
            rows: list[str] = []
            for i, r in enumerate(siblings, 1):
                ag = await s.get(Agent, r.agent_id) if r.agent_id else None
                name = ag.name if ag else (agent_name or "worker")
                task = ((r.input or {}).get("text") or "").strip().replace("\n", " ")
                body = _run_text(r).strip().replace("\n", " ")
                head = "✅" if r.status == "ok" else "❌"
                rows.append(
                    f"{head} {i}. {name}｜任务：{task[:120]}\n   结果：{body[:600] or '（没有产出）'}"
                )
                # 这一条 run 属于哪张票（票上记过 run_ids）
                tk_id = run_to_ticket.get(r.id)
                if tk_id:
                    tickets_of_batch.append((tk_id, ""))
            digest = (
                "【自动汇报 · 你派的活都回来了】\n"
                + "\n".join(rows)
                + "\n\n现在收口：先一句结论，再列必要依据；哪件不合格就说清要重做什么。"
                " 不要复述整段产出，不要重新派已经做完的活。"
            )
            agent = await s.get(Agent, chat.agent_id)
            if agent is None:
                return
            definition = AgentDefinition.model_validate(agent.definition)
            turn = await next_turn_index(s, chat.id)
            run = Run(
                agent_id=agent.id,
                agent_version=agent.version,
                runtime=definition.runtime,
                status="pending",
                input={"text": digest},
                definition_snapshot=definition.model_dump(mode="json", exclude={"model": {"api_key"}}),
                started_at=now_ms(),
                session_id=chat.id,
                turn_index=turn,
                origin="router",
            )
            s.add(run)
            # 这一批活都回来了、收口也起了 —— 票的使命就结束了。
            # 不自动关的话，每派一次活就永久多一张「等你验收」，一天下来侧栏/运行页堆成山
            # （实测：测试跑几十轮就攒出 23 件"等你验收"）。人工验收由 Router 是否收口替代。
            for tk_id, _title in tickets_of_batch:
                tk = await s.get(Ticket, tk_id)
                if tk is not None and tk.status == "open":
                    tk.status = "ended"
                    tk.ended_at = now_ms()
                    facts = _facts(tk)
                    facts["closed_by"] = "router"
                    tk.facts = facts
                    tk.updated_at = now_ms()
            await s.commit()
            await s.refresh(run)
            await _start_with_retry(run.id, definition, digest, chat.id)
            logger.info("派活收口：parent=%s 汇总 %d 件 → run=%s", parent_run_id, len(siblings), run.id)


async def agent_busy(session: AsyncSession, agent_id: str) -> Run | None:
    """这个人手上还有没有没跑完的活（worker 执行）。"""
    return (
        await session.execute(
            select(Run)
            .where(Run.agent_id == agent_id, Run.origin == "worker", Run.status.in_(("pending", "running")))
            .order_by(Run.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def open_ticket_for(session: AsyncSession, thread_id: str | None, agent_id: str) -> Ticket | None:
    """这条串上，这个助手还开着的票（有就可能复用它那个 worker 会话）。"""
    if not thread_id:
        return None
    rows = (
        await session.execute(
            select(Ticket).where(Ticket.thread_id == thread_id, Ticket.status == "open").order_by(Ticket.updated_at.desc())
        )
    ).scalars().all()
    for tk in rows:
        if str(((tk.facts or {}).get("sessions") or {}).get(agent_id) or ""):
            return tk
        if (tk.facts or {}).get("assignment", {}).get("agent_id") == agent_id:
            return tk
    return None


# --------------------------------------------------------------------------- #
# 远端 A2A worker：同一条 dispatch 语义，只是"谁来干"在别的平台上
# --------------------------------------------------------------------------- #

async def start_remote_worker(
    session: AsyncSession,
    ticket: Ticket,
    agent: Agent,
    task: str,
    *,
    parent_run_id: str | None = None,
) -> Run:
    """给远端 A2A agent 开一次执行：本地只留一条 run（runtime=a2a）当记录与链路。"""
    d = agent.definition or {}
    remote_url = str(d.get("remote_url") or "")
    remote_id = str(d.get("remote_id") or "")
    if not remote_url:
        raise ValueError(f"远端助手 {agent.name} 缺 remote_url（注册表里重新解析一次）")

    chat = await worker_session(session, ticket, agent)
    turn = await next_turn_index(session, chat.id)
    run = Run(
        agent_id=agent.id,
        agent_version=agent.version,
        runtime="a2a",
        status="pending",
        input={"text": task, "remote": remote_url, "remote_name": agent.name},
        definition_snapshot={},
        started_at=now_ms(),
        session_id=chat.id,
        turn_index=turn,
        origin="worker",
        parent_run_id=parent_run_id,
    )
    session.add(run)
    await session.flush()  # 同上：先拿到 id
    await record(
        session,
        ticket,
        assignment={
            "run_id": run.id,
            "status": "running",
            "task": task[:500],
            "session_id": chat.id,
            "agent_id": agent.id,
            "remote": remote_url,
        },
        run_ids=[*((_facts(ticket).get("run_ids") or [])[-49:]), run.id],
    )
    await session.refresh(run)
    return run


async def exec_remote_worker(
    *,
    run_id: str,
    agent_id: str,
    ticket_id: str,
    parent_run_id: str,
    session_id: str,
) -> None:
    """后台把这条远端执行跑完：发消息 → 等终态 → 落 run → 写票 → 触发收口。"""
    import asyncio

    async def _go() -> None:
        from . import a2a_client, remote_agents as ra
        from .db import SessionLocal
        from .models import RemoteAgent, SessionMessage

        status, out, task_id = "error", "", ""
        try:
            async with SessionLocal() as s:
                ag = await s.get(Agent, agent_id)
                d = (ag.definition if ag else {}) or {}
                base = str(d.get("remote_url") or "")
                remote_agent_id = d.get("remote_agent_id")
                rid = str(d.get("remote_id") or "")
                row = await s.get(RemoteAgent, rid) if rid else None
                timeout = float((row.timeout_s if row else 900.0) or 900.0)
                headers = ra.auth_headers(row) if row is not None else None
                r = await s.get(Run, run_id)
                chat_id = str(r.session_id or "") if r is not None else ""
                task = str(((r.input or {}).get("text") if r is not None else "") or "")
                await s.commit()
            status, out, task_id = await a2a_client.run_until_done(
                base, task, agent_id=remote_agent_id, timeout_s=timeout, headers=headers
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("远端派活失败 run=%s", run_id)
            status, out = "error", str(exc)

        try:
            async with SessionLocal() as s2:
                r2 = await s2.get(Run, run_id)
                if r2 is not None:
                    r2.status = status
                    r2.output = {"content": out} if out else None
                    r2.error = None if status == "ok" else (out or "远端执行失败")
                    r2.ended_at = now_ms()
                    if task_id:
                        r2.usage = {**(r2.usage or {}), "remote_task_id": task_id}
                    # 会话里也留一条：用户点进这个 worker 会话时能看到它说了什么
                    if chat_id:
                        s2.add(
                            SessionMessage(
                                session_id=chat_id,
                                turn_index=int(r2.turn_index or 1),
                                role="assistant",
                                content=out or (r2.error or "（远端没有返回内容）"),
                                run_id=run_id,
                            )
                        )
                    await s2.commit()
        except Exception:  # noqa: BLE001
            logger.exception("远端执行落库失败 run=%s", run_id)

        try:
            async with SessionLocal() as s3:
                tk = await s3.get(Ticket, ticket_id)
                if tk is not None:
                    await report(
                        s3,
                        tk,
                        "ready" if status == "ok" else "failed",
                        out,
                        run_id=run_id,
                        run_status=status,
                    )
        except Exception:  # noqa: BLE001
            logger.exception("远端报告落票失败 ticket=%s", ticket_id)
        try:
            if parent_run_id:
                await kick_summary(parent_run_id=parent_run_id, session_id=session_id)
        except Exception:  # noqa: BLE001
            logger.exception("远端触发收口失败")

    asyncio.create_task(_go())


async def _start_with_retry(run_id: str, definition: AgentDefinition, digest: str, session_id: str) -> bool:
    """把收口那一轮投出去；失败按 2s→32s 退避重试，全失败就留一条能看见的消息。

    为什么要有：worker 都跑完了、票也结了，唯独"结论送回去"这一步失败 —— 用户那边
    什么都没发生，界面上只有一堆完成的活、没有总结。这种沉默比报错更糟。
    """
    import asyncio

    from .db import SessionLocal
    from .models import SessionMessage

    last: Exception | None = None
    for i, wait in enumerate(SUMMARIZE_RETRY_DELAYS, 1):
        try:
            await run_service.start(run_id, definition, digest)
            return True
        except Exception as exc:  # noqa: BLE001 - 任何启动失败都重试
            last = exc
            logger.warning("收口投递失败（第 %d 次）：%s", i, exc)
            if i < len(SUMMARIZE_RETRY_DELAYS):
                await asyncio.sleep(max(0.0, wait))
    # 全失败：把这件事写到会话里（界面能看见），并把 run 标成失败
    try:
        async with SessionLocal() as s:
            row = await s.get(Run, run_id)
            if row is not None:
                row.status = "error"
                row.error = f"收口那一轮没能启动：{last}"
                row.ended_at = now_ms()
            s.add(
                SessionMessage(
                    session_id=session_id,
                    turn_index=1,
                    role="system",
                    content=f"【自动汇报】这一批活都回来了，但收口那一轮没能启动：{last}。"
                    "运行记录里有每件的产出，可以手动再问一次。",
                    run_id=run_id,
                )
            )
            await s.commit()
    except Exception:  # noqa: BLE001
        logger.exception("收口失败也写不进会话 run=%s", run_id)
    return False
