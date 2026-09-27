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
)
from agent_studio.db import SessionLocal
from agent_studio.models import Agent, Tool


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
        assert {"list_agents", "read_agent", "fork_agent"} <= names


def test_registry_shape():
    for name in ("list_agents", "read_agent", "fork_agent"):
        e = AGENT_OPS_TOOLS[name]
        assert e["schema"].get("type") == "object"
        assert e["description"]
        assert callable(e["fn"])
