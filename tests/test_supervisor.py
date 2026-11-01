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
from agent_studio.models import Agent, Session as ChatSession, Ticket
from agent_studio.native_tools import _dispatch
from agent_studio.runner import ctx as run_ctx
from agent_studio.supervisor import ROUTER_SESSION_TITLE, WORKER_PREFIX, thread_of


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

    token = run_ctx.set_run_ctx(agent_id=orch, session_id="ses_router_test")
    try:
        out = await _dispatch(task="写三句话总结", agent=worker_name, title="总结一下")
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
        await _dispatch(task="第一件", agent=w)
        await _dispatch(task="第二件", agent=w)
    finally:
        run_ctx.clear_run_ctx()

    async with SessionLocal() as s:
        rows = (await s.execute(select(Ticket).where(Ticket.thread_id == thread_of("ses_same_thread")))).scalars().all()
    assert len(rows) == 1, "同一条串上不该开出第二张票"


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
