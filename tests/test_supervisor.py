"""Router 只派活：dispatch 开票 → 独立 worker 会话 → 报告回票。

要钉住三件事（错了就等于没换成 Router/Worker）：
1. worker 有**自己的**会话，不是复用 Router 那个（旧 fork 就是复用，所以被推翻）
2. 同一 thread 上反复派活，认的是**同一张票**
3. worker 回来只落一条报告，票的阶段由事实算出来
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Agent, Run, Session as ChatSession, Ticket
from agent_studio.schemas import AgentDefinition
from agent_studio.native_tools import _dispatch
from agent_studio.runner import ctx as run_ctx
from agent_studio.supervisor import ROUTER_SESSION_TITLE, WORKER_PREFIX, kick_summary, thread_of


def uniq(p: str) -> str:
    return f"{p}-{uuid.uuid4().hex[:8]}"


async def _agent(name: str, role: str = "worker") -> str:
    async with SessionLocal() as s:
        a = Agent(
            slug=uniq("slug"),
            name=uniq(name),
            description="",
            runtime="agentscope",
            definition={"runtime": "agentscope", "name": name, "role": role, "tools": [], "skills": []},
        )
        s.add(a)
        await s.commit()
        await s.refresh(a)
        return a.id


async def _names(agent_id: str) -> str:
    async with SessionLocal() as s:
        return (await s.get(Agent, agent_id)).name


async def test_派活用独立会话_不是复用router的(monkeypatch):
    await init_db()
    orch = await _agent("编排者", "orchestrator")
    worker_name = await _names(await _agent("干活的人"))

    started: list[str] = []

    async def fake_start(run_id, definition, text):
        started.append(run_id)

    async def fake_wait(session, run_id, timeout_s=900):
        return SimpleNamespace(id=run_id, status="ok", output={"content": "三句话写好了"}, error=None)

    monkeypatch.setattr("agent_studio.runner.run_service.start", fake_start)
    monkeypatch.setattr("agent_studio.supervisor.wait_run", fake_wait)

    token = run_ctx.set_run_ctx(agent_id=orch, session_id="ses_router_test", run_id="run_parent_router")
    try:
        out = await _dispatch(task="写三句话总结", agent=worker_name, title="总结一下", wait=True)
    finally:
        run_ctx.clear_run_ctx()
        _ = token

    assert "三句话写好了" in out
    async with SessionLocal() as s:
        tk = (await s.execute(select(Ticket).where(Ticket.thread_id == thread_of("ses_router_test")))).scalar_one()
        assert tk.session_id, "worker 会话要挂到票上"
        chat = await s.get(ChatSession, tk.session_id)
        assert chat.title.startswith(WORKER_PREFIX), f"worker 会话标题应是 {WORKER_PREFIX}…，实际 {chat.title}"
        assert chat.title != ROUTER_SESSION_TITLE
        assert tk.facts["reports"][-1]["kind"] == "ready"
        # 派活跑完要把 assignment 落成终态，否则票会永远显示"在干"
    assert tk.facts["assignment"]["status"] == "ok"


async def test_同一thread反复派活认同一张票(monkeypatch):
    await init_db()
    orch = await _agent("编排者", "orchestrator")
    w = await _names(await _agent("干活的人"))

    async def fake_start(*a, **k):
        return None

    async def fake_wait(session, run_id, timeout_s=900):
        return SimpleNamespace(id=run_id, status="ok", output={"content": "好"}, error=None)

    monkeypatch.setattr("agent_studio.runner.run_service.start", fake_start)
    monkeypatch.setattr("agent_studio.supervisor.wait_run", fake_wait)

    run_ctx.set_run_ctx(agent_id=orch, session_id="ses_same_thread")
    try:
        await _dispatch(task="第一件", agent=w, wait=True)
        await _dispatch(task="第二件", agent=w, wait=True)
    finally:
        run_ctx.clear_run_ctx()

    async with SessionLocal() as s:
        rows = (await s.execute(select(Ticket).where(Ticket.thread_id == thread_of("ses_same_thread")))).scalars().all()
    assert len(rows) == 1, "同一条串上不该开出第二张票"


async def test_默认不等_派完就回(monkeypatch):
    """dispatch 默认不阻塞：1 个 Router 要能同时派出 N 件活。"""
    await init_db()
    orch = await _agent("编排者", "orchestrator")
    w = await _names(await _agent("干活的人"))

    async def fake_start(*a, **k):
        return None

    watched: list[str] = []

    async def fake_watch(**kw):
        watched.append(kw.get("run_id") or "")

    monkeypatch.setattr("agent_studio.runner.run_service.start", fake_start)
    monkeypatch.setattr("agent_studio.supervisor.watch_worker", fake_watch)

    run_ctx.set_run_ctx(agent_id=orch, session_id="ses_async", run_id="run_parent_async")
    try:
        out = await _dispatch(task="查一下资料", agent=w)
    finally:
        run_ctx.clear_run_ctx()

    assert "已派给" in out and "worker_status" in out  # 派完不撒手：返回要引导巡检
    assert watched, "异步派活必须挂 watcher，否则结果永远回不来"


async def test_同一件活派给两个助手_各用一个会话(monkeypatch):
    """1 个 Router 对 N 个 worker：不同域的助手不能共用一个 worker 会话。"""
    await init_db()
    orch = await _agent("编排者", "orchestrator")
    w1 = await _names(await _agent("查行情的人"))
    w2 = await _names(await _agent("写文档的人"))

    async def fake_start(*a, **k):
        return None

    async def fake_wait(session, run_id, timeout_s=900):
        return SimpleNamespace(id=run_id, status="ok", output={"content": "好了"}, error=None)

    monkeypatch.setattr("agent_studio.runner.run_service.start", fake_start)
    monkeypatch.setattr("agent_studio.supervisor.wait_run", fake_wait)

    run_ctx.set_run_ctx(agent_id=orch, session_id="ses_multi", run_id="run_parent_multi")
    try:
        await _dispatch(task="查金价", agent=w1, wait=True)
        await _dispatch(task="写周报", agent=w2, wait=True)
    finally:
        run_ctx.clear_run_ctx()

    async with SessionLocal() as s:
        # 一张票=一块活：两个域各开一张票，各自一个会话
        tks = (await s.execute(select(Ticket).where(Ticket.thread_id == thread_of("ses_multi")))).scalars().all()
        assert len(tks) == 2, f"两个助手应各一张票，实际 {len(tks)}"
        sessions = [sid for tk in tks for sid in ((tk.facts or {}).get("sessions") or {}).values()]
        assert len(sessions) == 2, f"两个助手应各有一个 worker 会话，实际 {sessions}"
        rows = [await s.get(ChatSession, sid) for sid in sessions]
        assert len({r.agent_id for r in rows}) == 2


async def test_一批活都回来就叫router收口(monkeypatch):
    """事件驱动：最后一件汇报回来时，自动在该会话里起一轮收口。"""
    await init_db()
    orch = await _agent("编排者", "orchestrator")
    sid = uniq("ses_sum")
    async with SessionLocal() as s:
        s.add(ChatSession(id=sid, agent_id=orch, title="RDO 测试会话", status="active"))
        await s.commit()
        kid = Run(
            agent_id=orch,
            agent_version=1,
            runtime="agentscope",
            status="ok",
            input={"text": "查一下天气"},
            output={"content": "晴 16°C"},
            started_at=1,
            ended_at=2,
            parent_run_id="run_parent_sum",
            origin="worker",
        )
        s.add(kid)
        await s.commit()

    started: list[str] = []

    async def fake_start(run_id, definition, text):
        started.append(run_id)

    monkeypatch.setattr("agent_studio.runner.run_service.start", fake_start)
    await kick_summary(parent_run_id="run_parent_sum", session_id=sid)
    assert started, "一收尾就该起一轮收口"
    async with SessionLocal() as s:
        rows = (await s.execute(select(Run).where(Run.session_id == sid))).scalars().all()
        summ = [r for r in rows if r.origin == "router"]
        assert summ and "自动汇报" in ((summ[0].input or {}).get("text") or "")


async def test_没有可派的助手就说清楚(monkeypatch):
    await init_db()
    orch = await _agent("编排者", "orchestrator")

    async def _no_start(*a, **k):
        return None

    async def _no_wait(session, run_id, timeout_s=900):  # 真等起来会等 15 分钟
        return SimpleNamespace(id=run_id, status="ok", output={"content": "ok"}, error=None)

    monkeypatch.setattr("agent_studio.runner.run_service.start", _no_start)
    monkeypatch.setattr("agent_studio.supervisor.wait_run", _no_wait)
    run_ctx.set_run_ctx(agent_id=orch, session_id="ses_none")
    try:
        out = await _dispatch(task="干点什么")
    finally:
        run_ctx.clear_run_ctx()
    # 库里可能还有别的 worker（测试库共用），所以只断言"没炸、有话说"
    assert isinstance(out, str) and out


async def test_派给不存在的助手要报名字(monkeypatch):
    await init_db()
    orch = await _agent("编排者", "orchestrator")
    run_ctx.set_run_ctx(agent_id=orch, session_id="ses_ghost")
    try:
        out = await _dispatch(task="x", agent="这个人不存在")
    finally:
        run_ctx.clear_run_ctx()
    assert "没有叫" in out


async def test_同一对话同一人_默认复用他的会话(monkeypatch):
    """auto：他手上那件还开着、人闲着 → 续用同一个 worker 会话（上下文连续）。"""
    await init_db()
    orch = await _agent("编排者", "orchestrator")
    w = await _names(await _agent("干活的人"))

    async def fake_start(*a, **k):
        return None

    async def fake_wait(session, run_id, timeout_s=900):
        return SimpleNamespace(id=run_id, status="ok", output={"content": "好"}, error=None)

    monkeypatch.setattr("agent_studio.runner.run_service.start", fake_start)
    monkeypatch.setattr("agent_studio.supervisor.wait_run", fake_wait)

    run_ctx.set_run_ctx(agent_id=orch, session_id="ses_reuse", run_id="run_parent_reuse")
    try:
        out1 = await _dispatch(task="第一件", agent=w, wait=True)
        # 真跑时 runner 会把 run 置成终态；这里手动补上，否则第二件会被判成"他还在忙"
        async with SessionLocal() as s:
            for r in (await s.execute(select(Run).where(Run.parent_run_id == "run_parent_reuse"))).scalars().all():
                r.status = "ok"
            await s.commit()
        out2 = await _dispatch(task="接着同一件", agent=w, wait=True)
    finally:
        run_ctx.clear_run_ctx()

    assert "新开了一件" in out1
    assert "复用" in out2
    async with SessionLocal() as s:
        tk = (await s.execute(select(Ticket).where(Ticket.thread_id == thread_of("ses_reuse")))).scalar_one()
        sessions = (tk.facts or {}).get("sessions") or {}
        assert len(sessions) == 1, f"应复用一个会话，实际 {sessions}"
        runs = (await s.execute(select(Run).where(Run.parent_run_id == "run_parent_reuse"))).scalars().all()
        assert len({r.session_id for r in runs}) == 1


async def test_mode_new_同一对话里另起一件(monkeypatch):
    await init_db()
    orch = await _agent("编排者", "orchestrator")
    w = await _names(await _agent("干活的人"))

    async def fake_start(*a, **k):
        return None

    async def fake_wait(session, run_id, timeout_s=900):
        return SimpleNamespace(id=run_id, status="ok", output={"content": "好"}, error=None)

    monkeypatch.setattr("agent_studio.runner.run_service.start", fake_start)
    monkeypatch.setattr("agent_studio.supervisor.wait_run", fake_wait)

    run_ctx.set_run_ctx(agent_id=orch, session_id="ses_newmode", run_id="run_parent_newmode")
    try:
        await _dispatch(task="第一件", agent=w, wait=True)
        await _dispatch(task="另一件独立的事", agent=w, wait=True, mode="new")
    finally:
        run_ctx.clear_run_ctx()

    async with SessionLocal() as s:
        tks = (
            await s.execute(select(Ticket).where(Ticket.thread_id == thread_of("ses_newmode")))
        ).scalars().all()
    assert len(tks) == 2, f"mode=new 应另开一张票，实际 {len(tks)}"


async def test_手上还有活就不派第二件(monkeypatch):
    await init_db()
    orch = await _agent("编排者", "orchestrator")
    wid = await _agent("忙人")
    w = await _names(wid)

    async with SessionLocal() as s:
        s.add(
            Run(
                agent_id=wid,
                agent_version=1,
                runtime="agentscope",
                status="running",
                input={"text": "正在干的事"},
                started_at=1,
                origin="worker",
            )
        )
        await s.commit()

    async def fake_start(*a, **k):
        return None

    monkeypatch.setattr("agent_studio.runner.run_service.start", fake_start)
    run_ctx.set_run_ctx(agent_id=orch, session_id="ses_busy", run_id="run_parent_busy")
    try:
        out = await _dispatch(task="再来一件", agent=w)
    finally:
        run_ctx.clear_run_ctx()
    assert "手上还有一件在跑" in out


async def test_收口启动失败要退避重试_失败也要留话(monkeypatch):
    """worker 都干完了、票也结了，唯独"把结论送回去"失败 —— 不能静默。"""
    from agent_studio import supervisor as sup
    from agent_studio.models import SessionMessage

    await init_db()
    monkeypatch.setattr(sup, "SUMMARIZE_RETRY_DELAYS", (0.0, 0.0, 0.0))

    async with SessionLocal() as s:
        orch = await _agent("编排者", "orchestrator")
        sid = uniq("ses_sum_retry")
        s.add(ChatSession(id=sid, agent_id=orch, title="收口重试"))
        run = Run(agent_id=orch, agent_version=1, runtime="agentscope", status="pending",
                  input={"text": "汇总"}, started_at=1, session_id=sid, origin="router")
        s.add(run)
        await s.commit()
        await s.refresh(run)
        run_id = run.id
        definition = AgentDefinition.model_validate(
            {"runtime": "agentscope", "name": "编排者", "role": "orchestrator"}
        )

    calls: list[int] = []

    async def flaky(run_id_, definition_, text):
        calls.append(1)
        if len(calls) < 3:
            raise RuntimeError("dispatcher down")

    monkeypatch.setattr("agent_studio.runner.run_service.start", flaky)
    ok = await sup._start_with_retry(run_id, definition, "汇总", sid)
    assert ok is True and len(calls) == 3, f"应当重试到成功，实际 {len(calls)} 次"

    calls.clear()

    async def always_fail(run_id_, definition_, text):
        calls.append(1)
        raise RuntimeError("still down")

    monkeypatch.setattr("agent_studio.runner.run_service.start", always_fail)
    ok2 = await sup._start_with_retry(run_id, definition, "汇总", sid)
    assert ok2 is False and len(calls) == len(sup.SUMMARIZE_RETRY_DELAYS)

    async with SessionLocal() as s:
        row = await s.get(Run, run_id)
        assert row.status == "error" and "没能启动" in (row.error or "")
        msgs = (
            await s.execute(select(SessionMessage).where(SessionMessage.session_id == sid))
        ).scalars().all()
        assert any("收口那一轮没能启动" in (m.content or "") for m in msgs), "失败必须留一条能看见的消息"
