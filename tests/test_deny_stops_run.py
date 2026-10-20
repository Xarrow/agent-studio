"""拒绝就停：用户点了「拒绝」，这一轮不该换个工具再试一遍。

现场（8850 实测）：拒绝 `proc_start rm -rf ./victim` 之后，模型改用 `python`
`os.chdir(...); subprocess...` 删同一个目录 —— 用户得连点两次拒绝，
而且第二次它已经换了条路。

口径：任何一次工具调用被拒（用户点的 / 权限引擎判的），这一轮**当场收尾**，
状态 aborted，理由写清楚"不会换个工具再试一遍"。
"""

from __future__ import annotations

import asyncio
import time
import uuid

from agent_studio.runner.dispatcher import dispatcher
from agent_studio.runtimes import register_runtime
from agent_studio.runtimes.base import (
    AgentRuntime,
    CompiledAgent,
    RuntimeCapabilities,
    UnifiedEvent,
)


class _Compiled(CompiledAgent):
    async def dispose(self) -> None:
        return None


class _DenyRuntime(AgentRuntime):
    name = "deny-runtime"

    def __init__(self) -> None:
        self.emitted: list[str] = []

    def capabilities(self) -> RuntimeCapabilities:
        return RuntimeCapabilities(name=self.name, display_name="拒绝桩")

    async def validate(self, definition):
        return []

    async def compile(self, definition, **ctx):
        return _Compiled()

    def run(self, agent, run_input):
        rt = self

        async def gen():
            def ev(t: str, **p):
                rt.emitted.append(t)
                return UnifiedEvent(type=t, ts=int(time.time() * 1000), payload=p)

            yield ev("run_start")
            yield ev("tool_call_start", tool_call_name="proc_start")
            yield ev("tool_exec_end", tool_call_name="proc_start", state="denied")
            # 下面这些**不该**发生：模型换工具再试 → 又一次授权请求
            yield ev("tool_call_start", tool_call_name="python")
            yield ev("hitl_request", tool_calls=[{"name": "python"}])
            yield ev("run_end", finished_reason="completed")

        return gen()

    async def dispose(self, agent):
        return None


async def _pump(client, run_id: str, timeout_s: float = 20.0) -> dict:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        await dispatcher.tick()
        r = await client.get(f"/api/runs/{run_id}")
        if r.status_code == 200 and r.json()["status"] in ("ok", "error", "aborted"):
            return r.json()
        await asyncio.sleep(0.05)
    raise AssertionError("执行没结束")


async def test_拒绝之后这一轮当场收尾_不再换工具重试(client, monkeypatch):
    from agent_studio.config import settings

    rt = _DenyRuntime()
    register_runtime(rt)
    monkeypatch.setattr(settings, "max_concurrent_runs", 0)

    name = f"拒绝桩-{uuid.uuid4().hex[:5]}"
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
    r = await client.post("/api/runs", json={"agent_id": a.json()["id"], "input": "删掉那个目录"})
    final = await _pump(client, r.json()["id"])

    assert final["status"] == "aborted", final
    assert "拒绝了" in (final.get("error") or ""), final.get("error")
    assert "proc_start" in (final.get("error") or "")

    ev = await client.get(f"/api/runs/events/{r.json()['id']}")
    types = [e["type"] for e in ev.json()]
    assert "hitl_request" not in types, "被拒绝后不该再弹出第二次授权"


async def test_拒绝信息写进会话的是一条人话(client, monkeypatch):
    """用户回看时要知道"为什么这轮什么都没做完"。"""
    from agent_studio.config import settings

    rt = _DenyRuntime()
    register_runtime(rt)
    monkeypatch.setattr(settings, "max_concurrent_runs", 0)

    name = f"拒绝桩2-{uuid.uuid4().hex[:5]}"
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
    sid = (
        await client.post("/api/sessions", json={"agent_id": a.json()["id"], "title": "拒绝会话"})
    ).json()["id"]
    r = await client.post(
        "/api/runs", json={"agent_id": a.json()["id"], "session_id": sid, "input": "删掉那个目录"}
    )
    final = await _pump(client, r.json()["id"])
    assert final["status"] == "aborted"
    # 会话历史由收尾任务写（status 先落终态）—— 等它写进来，别抢跑
    text = ""
    for _ in range(40):
        detail = await client.get(f"/api/sessions/{sid}")
        text = " ".join(m["content"] for m in detail.json()["messages"])
        if "本轮未完成" in text:
            break
        await asyncio.sleep(0.1)
    assert "拒绝了" in text, text[-300:]
    assert any(m["role"] == "system" and "本轮未完成" in m["content"] for m in detail.json()["messages"]), (
        "刷新页面时这一轮不该凭空消失"
    )


async def test_暂停时那句等我授权的话不能变成回答(client, monkeypatch):
    """现场：拒绝之后会话里留下 "I'm waiting for your permission…" —— 像它说过这句话。

    暂停那一刻 output 被存了一份占位文本；收尾时不清，就被当成回答写进历史。
    """
    from agent_studio.db import SessionLocal
    from agent_studio.models import Run, now_ms
    from agent_studio.runner.metrics import MetricsCollector
    from agent_studio.runner.service import run_service

    async with SessionLocal() as db:
        db.add(
            Run(
                id="run_placeholder",
                agent_id="ag_deny",
                # 续跑时状态已经翻回 running（暂停时是 waiting_hitl，finalize 不会覆盖它）
                status="running",
                input={"text": "删掉"},
                output={"content": "I'm waiting for your permission or the external execution to finish."},
                started_at=now_ms(),
            )
        )
        await db.commit()

    await run_service._finalize(
        "run_placeholder",
        MetricsCollector(),
        None,
        "aborted",
        "你拒绝了这一步，本轮就停在这里",
        clear_output=True,
    )
    async with SessionLocal() as db:
        row = await db.get(Run, "run_placeholder")
        assert row is not None
        assert not row.output, f"占位文本被当成了回答：{row.output}"
        assert row.status == "aborted"
