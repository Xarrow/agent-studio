"""跨轮任务清单（todo）—— 助手上一轮列的步骤，下一轮还记得。

要防的现场：用户上一轮看它列了五步、做到第二步；下一轮只说"继续"，
它完全不记得列过什么（平台每轮都重新编译 agent，清单本来是内存里的）。

口径：
  · 跑完一轮把清单存回库（按会话）；下一轮编译好先装回去
  · 清单空了就把那条记录删掉（别让界面挂着早就做完的清单）
  · 界面只拿最小结构（id / 标题 / 状态），不跟着某个框架的数据结构走
  · 运行时用自己那套任务工具（AgentScope 的 TaskCreate/Update…），平台只搬运
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import select

from agent_studio import todos
from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Agent, Run, Session, SessionPlan, now_ms
from agent_studio.runtimes.base import AgentRuntime, CompiledAgent, RuntimeCapabilities, UnifiedEvent


async def _seed(title: str = "清单验收") -> str:
    await init_db()
    now = now_ms()
    agent_id = "ag_todo_test"
    async with SessionLocal() as db:
        if await db.get(Agent, agent_id) is None:
            db.add(
                Agent(
                    id=agent_id,
                    slug=agent_id,
                    name="清单助手",
                    definition={"name": "清单助手", "model": {"provider": "custom", "name": "x"}},
                )
            )
        sid = f"ses_td{now % 1000000}"
        db.add(Session(id=sid, agent_id=agent_id, title=title, created_at=now, last_active_at=now))
        await db.commit()
    return sid


# --------------------------------------------------------------------------- #
# 存取
# --------------------------------------------------------------------------- #


async def test_存了能读回来_空清单要清掉():
    sid = await _seed()
    plan = {"tasks": [{"id": "t1", "subject": "读完文档", "state": "in_progress"}]}
    await todos.save(sid, plan)
    assert (await todos.load(sid))["tasks"][0]["subject"] == "读完文档"

    # 空清单 = 做完了 → 记录删掉（界面不该再挂一条早就完事的清单）
    await todos.save(sid, {"tasks": []})
    assert await todos.load(sid) is None
    async with SessionLocal() as db:
        assert await db.get(SessionPlan, sid) is None


async def test_摘要只要界面用得上的三样():
    tasks = todos.summarise(
        {
            "tasks": [
                {"id": "1", "subject": "写脚本", "state": "completed", "blocks": ["2"], "owner": "x"},
                {"id": "2", "subject": "跑一遍", "state": "pending"},
                "垃圾数据",
                {"id": "3", "title": "兼容标题字段", "state": "weird"},
            ]
        }
    )
    assert [t["subject"] for t in tasks] == ["写脚本", "跑一遍", "兼容标题字段"]
    assert tasks[0]["state"] == "completed"
    assert set(tasks[0]) == {"id", "subject", "state"}, "别把框架内部字段漏给界面"


# --------------------------------------------------------------------------- #
# 运行时钩子
# --------------------------------------------------------------------------- #


async def test_agentscope_的清单能来回导出装回():
    from agentscope.state import AgentState, Task

    from agent_studio.runtimes.agentscope_rt.runtime import AgentScopeCompiled

    rt = __import__(
        "agent_studio.runtimes.agentscope_rt.runtime", fromlist=["AgentScopeRuntime"]
    ).AgentScopeRuntime()

    class _A:
        def __init__(self) -> None:
            self.state = AgentState()

    compiled = AgentScopeCompiled(agent_id="a", agent=_A(), model=None)
    compiled.agent.state.tasks_context.tasks = [
        Task(subject="一", description="第一件事", metadata={}, state="in_progress")
    ]
    snap = rt.snapshot_plan(compiled)
    assert snap and snap["tasks"][0]["subject"] == "一"

    fresh = AgentScopeCompiled(agent_id="a", agent=_A(), model=None)
    await rt.restore_plan(fresh, snap)
    assert fresh.agent.state.tasks_context.tasks[0].subject == "一"
    assert fresh.agent.state.tasks_context.tasks[0].state == "in_progress"


async def test_没有清单的运行时_平台就不存():
    class _NoPlanCompiled(CompiledAgent):
        async def dispose(self) -> None:
            return None

    from agent_studio.runtimes.base import AgentRuntime

    class _R(AgentRuntime):
        name = "noplan"

        def capabilities(self):
            return RuntimeCapabilities(name="noplan", display_name="无清单")

        async def validate(self, definition):
            return []

        async def compile(self, definition, **ctx):
            return _NoPlanCompiled()

        def run(self, agent, run_input):
            raise NotImplementedError

    assert _R().snapshot_plan(_NoPlanCompiled()) is None


# --------------------------------------------------------------------------- #
# 端到端：第一轮列清单，第二轮装回来
# --------------------------------------------------------------------------- #


class _Compiled(CompiledAgent):
    def __init__(self, plan: dict | None = None) -> None:
        self.last_output: dict | None = None
        self.plan = plan
        self.restored: dict | None = None

    async def dispose(self) -> None:
        return None


class _TodoRuntime(AgentRuntime):
    """第一轮造一份清单，之后的轮次记录"装回来了什么"。"""

    name = "todo-runtime"

    def __init__(self) -> None:
        self.compiled: list[_Compiled] = []

    def capabilities(self) -> RuntimeCapabilities:
        return RuntimeCapabilities(name=self.name, display_name="清单桩")

    async def validate(self, definition):
        return []

    async def compile(self, definition, **ctx):
        c = _Compiled(plan={"tasks": [{"id": "t1", "subject": "第一步", "state": "completed"}]})
        self.compiled.append(c)
        return c

    def snapshot_plan(self, agent):
        return agent.plan

    async def restore_plan(self, agent, plan):
        agent.restored = plan

    def run(self, agent, run_input):
        async def gen():
            yield UnifiedEvent(type="run_start", ts=int(__import__("time").time() * 1000), payload={})
            agent.last_output = {"content": "做完了"}
            yield UnifiedEvent(
                type="run_end", ts=int(__import__("time").time() * 1000), payload={"finished_reason": "stop"}
            )

        return gen()

    async def dispose(self, agent):
        return None


async def _pump(client, run_id: str, timeout_s: float = 8.0) -> dict:
    import time as _t

    from agent_studio.runner.dispatcher import dispatcher

    deadline = _t.monotonic() + timeout_s
    while _t.monotonic() < deadline:
        await dispatcher.tick()
        r = await client.get(f"/api/runs/{run_id}")
        if r.status_code == 200 and r.json()["status"] in ("ok", "error", "aborted"):
            return r.json()
        await asyncio.sleep(0.05)
    raise AssertionError("执行没结束")


async def test_第二轮会装回上一轮的清单(client, monkeypatch):
    from agent_studio.config import settings
    from agent_studio.runtimes import register_runtime

    rt = _TodoRuntime()
    register_runtime(rt)
    monkeypatch.setattr(settings, "max_concurrent_runs", 0)

    name = f"清单桩-{uuid.uuid4().hex[:5]}"
    a = await client.post(
        "/api/agents",
        json={
            "name": name,
            "definition": {
                "runtime": rt.name,
                "name": name,
                "system_prompt": "桩",
                "model": {"provider": "custom", "name": "stub"},
                "tools": [],
                "skills": [],
                "limits": {"max_iters": 2, "timeout_s": 20},
            },
        },
    )
    assert a.status_code in (200, 201), a.text
    sid = (
        await client.post("/api/sessions", json={"agent_id": a.json()["id"], "title": "清单会话"})
    ).json()["id"]

    r1 = await client.post("/api/runs", json={"agent_id": a.json()["id"], "session_id": sid, "input": "第一步"})
    await _pump(client, r1.json()["id"])

    # 第一轮结束后清单已经落库
    got = await client.get(f"/api/sessions/{sid}/todos")
    assert got.status_code == 200, got.text
    assert got.json()["tasks"][0]["subject"] == "第一步"
    assert got.json()["done"] == 1

    # 第二轮：编译后必须把上一轮的清单装回去
    r2 = await client.post("/api/runs", json={"agent_id": a.json()["id"], "session_id": sid, "input": "继续"})
    await _pump(client, r2.json()["id"])
    assert rt.compiled[-1].restored is not None, "第二轮没装回清单 —— 它会装作没列过"
    assert rt.compiled[-1].restored["tasks"][0]["subject"] == "第一步"
