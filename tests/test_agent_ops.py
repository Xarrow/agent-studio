"""P1.5 Agent 互操作工具（list_agents / read_agent / fork_agent）的护栏测试。

语义验收点：
  1. list_agents 列出全部助手（含默认的编排者/通用助手）
  2. read_agent 查详情；不存在的名字给出**可用名单**（模型能自纠）
  3. fork_agent 复制：名字自动顺延、血缘 parent_id 指回源、变体不带 fork 工具
  4. fork_agent 在**非执行上下文**调用被拒（与 fork 工具同一条纪律）
  5. sync_builtins 把三个工具注册进 Tool 表（kind=native）——Agents 页能挂载
"""

from __future__ import annotations

import json

from sqlalchemy import select

from agent_studio.agent_ops import (
    AGENT_OPS_TOOLS,
    _fork_agent,
    _list_agents,
    _read_agent,
    _worker_status,
    _worker_steer,
    _worker_stop,
)
from agent_studio.db import SessionLocal
from agent_studio.models import Agent, Run, Tool


async def _seed_agents() -> None:
    """直接落两个助手（不复用 defaults —— 那套带启动副作用，测试要最小依赖）。

    init_db 由 conftest 的环境变量单例管（临时库）；这里只确保表已建。
    """
    from agent_studio.db import init_db

    await init_db()
    async with SessionLocal() as s:
        for name, desc in (
            ("测试编排甲", "拆任务、派活、验收"),
            ("测试干活乙", "干活"),
        ):
            exists = (
                await s.execute(select(Agent).where(Agent.name == name))
            ).scalars().first()
            if exists is None:
                s.add(Agent(slug=name, name=name, description=desc, definition={"tools": ["fetch"]}))
        await s.commit()


async def test_list_agents_lists_all():
    await _seed_agents()
    out = await _list_agents()
    assert "测试编排甲" in out and "测试干活乙" in out
    assert out.startswith("共 ")


async def test_read_agent_returns_definition():
    await _seed_agents()
    out = await _read_agent("测试干活乙")
    data = json.loads(out)
    assert data["name"] == "测试干活乙"
    assert isinstance(data["tools"], list)


async def test_read_agent_unknown_name_gives_names():
    await _seed_agents()
    out = await _read_agent("不存在的助手")
    assert "没有叫" in out
    assert "测试干活乙" in out  # 名单可自纠


async def test_fork_agent_creates_variant_with_lineage():
    from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx

    await _seed_agents()
    set_run_ctx(run_id="run_ops_test", agent_id="ag_x", depth=0)
    try:
        out = await _fork_agent("测试干活乙")
    finally:
        clear_run_ctx()
    assert "已创建助手" in out and "测试干活乙-v2" in out

    async with SessionLocal() as s:
        src = (
            await s.execute(select(Agent).where(Agent.name == "测试干活乙"))
        ).scalars().first()
        v2 = (
            await s.execute(select(Agent).where(Agent.name == "测试干活乙-v2"))
        ).scalars().first()
        assert v2 is not None and src is not None
        assert v2.parent_id == src.id  # 血缘
        tools = [
            t if isinstance(t, str) else (t or {}).get("ref")
            for t in (v2.definition or {}).get("tools") or []
        ]
        # 剥 fork 的验收：变体的工具 ref 里不含 fork 工具行 id
        fork_ids = {
            t.id
            for t in (
                await s.execute(select(Tool).where(Tool.name == "fork"))
            ).scalars()
        }
        assert not (set(tools) & fork_ids)  # 变体不带分派工具


async def test_fork_agent_rejected_outside_run_context():
    from agent_studio.runner.ctx import clear_run_ctx

    await _seed_agents()
    clear_run_ctx()
    out = await _fork_agent("测试干活乙")
    assert "不在一次执行上下文" in out


async def test_sync_builtins_registers_agent_ops(client):
    from agent_studio.api.tools import sync_builtins
    from agent_studio.models import Tool

    async with SessionLocal() as session:
        await sync_builtins(runtime="agentscope", session=session)
        rows = (
            await session.execute(select(Tool).where(Tool.kind == "native"))
        ).scalars().all()
        names = {r.name for r in rows}
        assert {"list_agents", "read_agent", "fork_agent", "worker_stop"} <= names


def test_registry_shape():
    for name in ("list_agents", "read_agent", "fork_agent", "worker_stop"):
        e = AGENT_OPS_TOOLS[name]
        assert e["schema"].get("type") == "object"
        assert e["description"]
        assert callable(e["fn"])


# --------------------------------------------------------------------------- #
# worker_stop：Router 干预 worker 的硬通道（run_service.abort）
# --------------------------------------------------------------------------- #


async def _seed_running_worker_run() -> tuple[Agent, "Run"]:
    """落一个 worker 助手 + 一条 running 的 worker run（模拟 dispatch 派出去正在跑）。

    先清掉这个 agent 的旧 run：agent_busy 按 started_at 倒序找"在跑的"，
    之前用例留下的 running run 会串场（单跑绿、全套红就是它）。
    """
    from agent_studio.db import init_db
    from agent_studio.models import Run, now_ms
    from sqlalchemy import delete as _delete, select as _select

    await init_db()
    async with SessionLocal() as s:
        a = (
            await s.execute(_select(Agent).where(Agent.name == "测试干活乙"))
        ).scalars().first()
        if a is None:
            a = Agent(slug="测试干活乙", name="测试干活乙", description="干活", definition={"tools": []})
            s.add(a)
            await s.flush()
        else:
            await s.execute(_delete(Run).where(Run.agent_id == a.id))
        run = Run(
            agent_id=a.id,
            runtime="agentscope",
            status="running",
            input={"text": "测试任务"},
            definition_snapshot={"runtime": "agentscope"},
            started_at=now_ms(),
            origin="worker",
        )
        s.add(run)
        await s.commit()
        await s.refresh(a)
        await s.refresh(run)
        return a, run


async def test_worker_stop_aborts_running_run():
    """名字 → agent_busy 找到在跑的 run → run_service.abort 落终态。"""
    from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx
    from agent_studio.models import Run

    a, run = await _seed_running_worker_run()
    set_run_ctx(run_id="run_stopper", agent_id="ag_x", depth=0)
    try:
        out = await _worker_stop("测试干活乙", reason="方向不对")
    finally:
        clear_run_ctx()
    assert "已停止" in out and a.name in out
    async with SessionLocal() as s:
        row = await s.get(Run, run.id)
        assert row.status == "aborted"
        assert "已中止" in (row.error or "")


async def test_worker_stop_idle_worker_says_nothing_running():
    """没活可停要明说，不能假装停了。"""
    from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx
    from agent_studio.runner.service import run_service

    a, run = await _seed_running_worker_run()
    await run_service.abort(run.id)  # 先停掉，人就闲了
    set_run_ctx(run_id="run_stopper", agent_id="ag_x", depth=0)
    try:
        out = await _worker_stop(a.name)
    finally:
        clear_run_ctx()
    assert "没有在跑的活" in out


async def test_worker_stop_unknown_agent_lists_names():
    from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx

    await _seed_running_worker_run()
    set_run_ctx(run_id="run_stopper", agent_id="ag_x", depth=0)
    try:
        out = await _worker_stop("不存在的助手")
    finally:
        clear_run_ctx()
    assert "没有叫" in out and "测试干活乙" in out


async def test_worker_stop_rejected_outside_run_context():
    from agent_studio.runner.ctx import clear_run_ctx

    await _seed_running_worker_run()
    clear_run_ctx()
    out = await _worker_stop("测试干活乙")
    assert "正在运行的助手" in out


async def test_worker_stop_by_run_id():
    from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx

    _, run = await _seed_running_worker_run()
    set_run_ctx(run_id="run_stopper", agent_id="ag_x", depth=0)
    try:
        out = await _worker_stop(run.id)
    finally:
        clear_run_ctx()
    assert "已停止" in out
    async with SessionLocal() as s:
        row = await s.get(Run, run.id)
        assert row.status == "aborted"


# --------------------------------------------------------------------------- #
# worker_status / worker_steer：Router 巡检与中途纠偏
# --------------------------------------------------------------------------- #


async def test_worker_status_shows_running_progress():
    """在跑的 run：报状态 + 已跑时长 + 最近动作（事件流里来）。"""
    from agent_studio.models import RunEvent, now_ms
    from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx

    a, run = await _seed_running_worker_run()
    async with SessionLocal() as s:
        s.add(RunEvent(run_id=run.id, seq=1, type="tool_exec_start",
                       payload={"tool_call_id": "c1", "tool_call_name": "Bash"}, ts=now_ms()))
        s.add(RunEvent(run_id=run.id, seq=2, type="tool_exec_end",
                       payload={"tool_call_id": "c1", "state": "success"}, ts=now_ms()))
        s.add(RunEvent(run_id=run.id, seq=3, type="tool_exec_start",
                       payload={"tool_call_id": "c2", "tool_call_name": "browser"}, ts=now_ms()))
        await s.commit()
    set_run_ctx(run_id="run_router", agent_id="ag_router", depth=0)
    try:
        out = await _worker_status(a.name)
    finally:
        clear_run_ctx()
    assert "执行中" in out
    assert "Bash" in out and "browser" in out  # 已完成的 + 正在跑的都可见
    assert run.id in out


async def test_worker_status_idle_shows_last_run():
    """没在跑：报最近一次执行的终态与产出摘要，不装作还在跑。"""
    from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx
    from agent_studio.runner.service import run_service

    a, run = await _seed_running_worker_run()
    async with SessionLocal() as s:
        row = await s.get(Run, run.id)
        row.status = "ok"
        row.output = {"content": "任务完成了"}
        await s.commit()
    set_run_ctx(run_id="run_router", agent_id="ag_router", depth=0)
    try:
        out = await _worker_status(a.name)
    finally:
        clear_run_ctx()
    assert "空闲" in out and "任务完成了" in out


async def test_worker_status_unknown_agent():
    from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx

    await _seed_running_worker_run()
    set_run_ctx(run_id="run_router", agent_id="ag_router", depth=0)
    try:
        out = await _worker_status("不存在的助手")
    finally:
        clear_run_ctx()
    assert "没有叫" in out and "测试干活乙" in out


async def test_worker_status_reports_tool_failures():
    """事件流里有失败的工具调用要标出来——Router 判断"要不要纠偏"的依据。"""
    from agent_studio.models import RunEvent, now_ms
    from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx

    a, run = await _seed_running_worker_run()
    async with SessionLocal() as s:
        s.add(RunEvent(run_id=run.id, seq=1, type="tool_exec_start",
                       payload={"tool_call_id": "c1", "tool_call_name": "Bash"}, ts=now_ms()))
        s.add(RunEvent(run_id=run.id, seq=2, type="tool_exec_end",
                       payload={"tool_call_id": "c1", "state": "error"}, ts=now_ms()))
        await s.commit()
    set_run_ctx(run_id="run_router", agent_id="ag_router", depth=0)
    try:
        out = await _worker_status(a.name)
    finally:
        clear_run_ctx()
    assert "失败" in out and "Bash" in out


async def test_worker_steer_idle_worker_says_nothing_running():
    from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx

    a, run = await _seed_running_worker_run()
    from agent_studio.runner.service import run_service
    await run_service.abort(run.id)
    set_run_ctx(run_id="run_router", agent_id="ag_router", depth=0)
    try:
        out = await _worker_steer(a.name, "改成用 API")
    finally:
        clear_run_ctx()
    assert "没有在跑的活" in out


async def test_worker_steer_rejected_outside_run_context():
    from agent_studio.runner.ctx import clear_run_ctx

    await _seed_running_worker_run()
    clear_run_ctx()
    out = await _worker_steer("测试干活乙", "改成用 API")
    assert "正在运行的助手" in out


async def test_worker_steer_empty_message_rejected():
    from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx

    await _seed_running_worker_run()
    set_run_ctx(run_id="run_router", agent_id="ag_router", depth=0)
    try:
        out = await _worker_steer("测试干活乙", "  ")
    finally:
        clear_run_ctx()
    assert "message 不能为空" in out


async def test_worker_steer_delivers_via_registry():
    """ steer 通道真实投递：run 在注册表里挂着时，插话能到。"""
    from agent_studio import steer as steer_registry
    from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx

    a, run = await _seed_running_worker_run()

    class _FakeRuntime:
        async def steer(self, compiled, text):
            self.seen = text

    rt = _FakeRuntime()
    await steer_registry.attach(run.id, rt, object())
    try:
        set_run_ctx(run_id="run_router", agent_id="ag_router", depth=0)
        try:
            out = await _worker_steer(a.name, "改成用 API，别爬页面")
        finally:
            clear_run_ctx()
        assert "已向" in out and "插话纠偏" in out
        assert "[Router 纠偏]" in rt.seen and "改成用 API" in rt.seen
    finally:
        await steer_registry.detach(run.id)



async def test_删除助手_连带清掉它的会话():
    """删助手不能把它的会话留成孤儿——否则侧栏还会出现这些对话，点进去身份带/操作
    都落到不存在的 agent 上（生产实测攒了 7 条）。"""
    from agent_studio.db import init_db, SessionLocal
    from agent_studio.models import Agent, Session as ChatSession, new_id
    from agent_studio.api import agents as agents_api
    from sqlalchemy import select

    await init_db()
    async with SessionLocal() as s:
        a = Agent(id=new_id("ag"), slug="del-cascade", name="将被删", version=1, definition={})
        s.add(a)
        await s.commit()
        await s.refresh(a)
        sid = new_id("ses")
        s.add(ChatSession(id=sid, agent_id=a.id, title="孤儿候选"))
        await s.commit()
        aid = a.id

    class _S:  # 复用依赖注入的 session
        def __init__(self, s): self._s = s
        async def __aenter__(self): return self._s
        async def __aexit__(self, *a): pass

    async with SessionLocal() as s:
        await agents_api.delete_agent(aid, session=s)
        left = (await s.execute(select(ChatSession).where(ChatSession.agent_id == aid))).scalars().all()
        assert left == [], f"删除助手后不应再留下它的会话，实际还有 {len(left)} 条"


async def test_空白名字_超长名字_拒绝():
    """名字的边界：纯空白和超长都不该进库（此前 201 通过）。"""
    from agent_studio.db import init_db, SessionLocal
    from agent_studio.schemas import AgentCreate

    await init_db()
    # pydantic 直接校验
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        AgentCreate.model_validate({"name": "  ", "definition": {"runtime": "agentscope", "name": "x"}})
    with pytest.raises(ValidationError):
        AgentCreate.model_validate({"name": "x" * 300, "definition": {"runtime": "agentscope", "name": "x"}})


async def test_改名成重名_409():
    """改名时和别人撞名 → 409，不能悄悄变成同名两条。"""
    from agent_studio.db import init_db, SessionLocal
    from agent_studio.models import Agent, new_id
    from agent_studio.api import agents as agents_api
    from agent_studio.schemas import AgentUpdate
    import pytest
    from fastapi import HTTPException

    await init_db()
    async with SessionLocal() as s:
        a = Agent(id=new_id("ag"), slug="rename-a", name="助手A", version=1, definition={})
        b = Agent(id=new_id("ag"), slug="rename-b", name="助手B", version=1, definition={})
        s.add(a); s.add(b)
        await s.commit()
        await s.refresh(a); await s.refresh(b)
        aid, bid = a.id, b.id

    async with SessionLocal() as s:
        with pytest.raises(HTTPException) as ei:
            await agents_api.update_agent(bid, AgentUpdate(name="助手A"), session=s)
        assert ei.value.status_code == 409
