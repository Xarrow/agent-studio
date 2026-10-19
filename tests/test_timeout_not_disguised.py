"""超时 / 停止 不能被伪装成「模型说它注意到中断了」。

现场一次真实故障（2026-10-19）：
  · 助手限制了 300 秒执行超时，一个「Bash 二十来次」的正常任务撞到上限；
  · AgentScope 收到取消后**不抛 CancelledError**，而是把工具标成 interrupted、
    补一句 "I notice the interruption. How can I help you?" 然后正常结束；
  · 于是 Run 被记成 ok、那句插话被当成模型回答写进会话 —— 用户看到的是
    "聊着聊着它忽然说注意到中断了"，还以为是切页面把对话弄断了。

这三条护栏钉住：
  ① 撞满上限 → status=error，error 说清是超时（可调大），output 不留插话
  ② 没撞满就被取消 → status=aborted，说清是用户停止
  ③ 没产出的那一轮**不写空的助手消息**（宁可不写，也不要空白气泡）
"""

from __future__ import annotations

import asyncio
import uuid

from agent_studio.context import append_turn
from agent_studio.db import SessionLocal
from agent_studio.runtimes.base import AgentRuntime, CompiledAgent, RuntimeCapabilities, UnifiedEvent


def uniq(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


class _Compiled(CompiledAgent):
    def __init__(self) -> None:
        self.last_output: dict | None = None

    async def dispose(self) -> None:  # pragma: no cover - 桩
        return None


class InterruptSwallowingRuntime(AgentRuntime):
    """模拟 AgentScope 的真实行为：被取消后**吞掉** CancelledError，
    补一句「我注意到中断了」，然后正常结束。"""

    name = "interrupt-swallow-test"

    def __init__(self, work_s: float) -> None:
        self.work_s = work_s

    def capabilities(self) -> RuntimeCapabilities:
        return RuntimeCapabilities(name=self.name, display_name="Swallow")

    async def validate(self, definition):  # noqa: ANN001
        return []

    async def compile(self, definition, **ctx):  # noqa: ANN001
        return _Compiled()

    def run(self, agent, run_input):  # noqa: ANN001
        async def gen():
            try:
                await asyncio.sleep(self.work_s)
                agent.last_output = {"content": "真的干完了"}
                yield UnifiedEvent(type="run_end", ts=1, payload={"finished_reason": "completed"})  # type: ignore[arg-type]
            except asyncio.CancelledError:
                # ← 这就是 AgentScope 干的事：吞掉取消，伪装成一次「正常结束」
                yield UnifiedEvent(type="run_end", ts=2, payload={"finished_reason": "interrupted"})  # type: ignore[arg-type]
                agent.last_output = {"content": "I notice the interruption. How can I help you?"}

        return gen()

    async def dispose(self, agent) -> None:  # noqa: ANN001
        return None


async def _mk_agent(client, name: str, timeout_s: int) -> str:
    r = await client.post(
        "/api/agents",
        json={
            "name": name,
            "definition": {
                "runtime": "interrupt-swallow-test",
                "name": name,
                "system_prompt": "桩助手",
                "model": {"provider": "deepseek", "name": "deepseek-v4-flash"},
                "tools": [],
                "skills": [],
                "limits": {"max_iters": 3, "timeout_s": timeout_s},
            },
        },
    )
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def _pump(client, run_id: str, limit_s: float = 12.0) -> dict:
    import time as _t

    from agent_studio.runner.dispatcher import dispatcher

    deadline = _t.time() + limit_s
    while _t.time() < deadline:
        await dispatcher.tick()
        r = await client.get(f"/api/runs/{run_id}")
        d = r.json()
        if d["status"] not in ("pending", "running"):
            return d
        await asyncio.sleep(0.05)
    return (await client.get(f"/api/runs/{run_id}")).json()


async def _register():
    from agent_studio.runtimes import register_runtime

    rt = InterruptSwallowingRuntime(work_s=30)
    register_runtime(rt)
    return rt


async def test_撞满超时上限不会被伪装成正常回答(client):
    await _register()
    aid = await _mk_agent(client, uniq("超时桩"), timeout_s=1)
    sess = (await client.post("/api/sessions", json={"agent_id": aid, "title": "超时"})).json()
    run = (
        await client.post(
            "/api/runs",
            json={"agent_id": aid, "session_id": sess["id"], "input": "跑一个很久的活"},
        )
    ).json()

    d = await _pump(client, run["id"])
    assert d["status"] == "error", d
    assert "执行超时" in (d.get("error") or ""), d.get("error")
    assert "1 秒" in (d.get("error") or ""), "得说清撞的是多少秒的上限"
    assert not d.get("output"), "那句「我注意到中断了」不能当回答留下来"

    msgs = (await client.get(f"/api/sessions/{sess['id']}")).json()["messages"]
    assert [m["role"] for m in msgs] == ["user"], "没产出就别写一条空的助手消息"
    assert all("interruption" not in (m["content"] or "") for m in msgs)


async def test_没撞满就被取消算用户停止(client):
    await _register()
    aid = await _mk_agent(client, uniq("停止桩"), timeout_s=120)
    sess = (await client.post("/api/sessions", json={"agent_id": aid, "title": "停止"})).json()
    run = (
        await client.post(
            "/api/runs",
            json={"agent_id": aid, "session_id": sess["id"], "input": "跑一个很久的活"},
        )
    ).json()

    # 先让它开跑，再中止
    from agent_studio.runner.dispatcher import dispatcher

    for _ in range(40):
        await dispatcher.tick()
        d = (await client.get(f"/api/runs/{run['id']}")).json()
        if d["status"] == "running":
            break
        await asyncio.sleep(0.05)

    assert (await client.post(f"/api/runs/abort/{run['id']}")).json()["aborted"] is True
    d = await _pump(client, run["id"])
    assert d["status"] == "aborted", d
    assert "停止" in (d.get("error") or ""), d.get("error")


async def test_空回答不写助手消息(client):
    """直接钉 append_turn：没产出的一轮只留用户那条。"""
    from sqlalchemy import select

    from agent_studio.models import SessionMessage

    aid = await _mk_agent(client, uniq("空答桩"), timeout_s=10)
    sess = (await client.post("/api/sessions", json={"agent_id": aid, "title": "空答"})).json()

    async with SessionLocal() as s:
        await append_turn(
            s, session_id=sess["id"], run_id=uniq("run"), user_text="问一句", assistant_text=""
        )

    detail = (await client.get(f"/api/sessions/{sess['id']}")).json()
    assert [m["role"] for m in detail["messages"]] == ["user"], detail["messages"]

    # 有内容的照旧写两条
    async with SessionLocal() as s:
        await append_turn(
            s, session_id=sess["id"], run_id=uniq("run"), user_text="再问一句",
            assistant_text="答上了",
        )
    detail = (await client.get(f"/api/sessions/{sess['id']}")).json()
    assert [m["role"] for m in detail["messages"]] == ["user", "user", "assistant"]