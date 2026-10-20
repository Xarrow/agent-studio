"""备用模型（fallback）的护栏。

要防的现场：主模型的 key 被撤了 / 模型下线了 / 这家整体 503 ——
以前这条执行直接报废，用户看到"模型不行"，其实换一个模型就能答。
现在：整轮切到 `AgentDefinition.fallback` 重跑一次，并在事件与 usage 里留下痕迹。

**不该切的**：用户设的执行超时（预算，换了只会更慢）、排队太久（我们自己忙）、
工具/配置类错误（换了照样错）—— 每条都钉一个断言。
"""

from __future__ import annotations

import asyncio
import uuid

from agent_studio.config import settings
from agent_studio.runtimes.base import AgentRuntime, CompiledAgent, RuntimeCapabilities


class _Compiled(CompiledAgent):
    def __init__(self) -> None:
        self.last_output: dict | None = None
        self.model_name = ""

    async def dispose(self) -> None:  # pragma: no cover - 桩
        return None


class ModelSwitchRuntime(AgentRuntime):
    """按**模型名**决定失败还是成功：用来验证"换模型"这条路径真的换了。"""

    name = "model-switch-runtime"

    def __init__(self, fail_on: str = "broken-primary", error: str = "HTTP 401 Unauthorized: invalid api key") -> None:
        self.fail_on = fail_on
        self.error = error
        self.used: list[str] = []

    def capabilities(self) -> RuntimeCapabilities:
        return RuntimeCapabilities(name=self.name, display_name="模型切换桩")

    async def validate(self, definition):  # noqa: ANN001
        return []

    async def compile(self, definition, **ctx):  # noqa: ANN001
        c = _Compiled()
        c.model_name = definition.model.name
        return c

    def run(self, agent, run_input):  # noqa: ANN001
        async def gen():
            self.used.append(agent.model_name)
            if agent.model_name == self.fail_on:
                raise RuntimeError(self.error)
            agent.last_output = {"content": f"answered by {agent.model_name}"}
            if False:  # pragma: no cover - 生成器语法
                yield

        return gen()

    async def dispose(self, agent) -> None:  # noqa: ANN001
        return None


def _uniq(p: str) -> str:
    return f"{p}-{uuid.uuid4().hex[:6]}"


async def _mk_agent_with_fallback(client, name: str, fallback: dict | None) -> str:
    definition = {
        "runtime": ModelSwitchRuntime.name,
        "name": name,
        "system_prompt": "桩助手",
        "model": {"provider": "deepseek", "name": "broken-primary"},
        "tools": [],
        "skills": [],
        "limits": {"max_iters": 2, "timeout_s": 20},
    }
    if fallback:
        definition["fallback"] = fallback
    r = await client.post("/api/agents", json={"name": name, "definition": definition})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def _drive(client, run_id: str, timeout_s: float = 8.0) -> dict:
    """泵分发器直到终态（测试里没有 lifespan）。"""
    import time as _t

    from agent_studio.runner.dispatcher import dispatcher

    deadline = _t.monotonic() + timeout_s
    while _t.monotonic() < deadline:
        await dispatcher.tick()
        r = await client.get(f"/api/runs/{run_id}")
        if r.status_code == 200 and r.json()["status"] in ("ok", "error", "aborted"):
            return r.json()
        await asyncio.sleep(0.05)
    raise AssertionError(f"执行没有在 {timeout_s}s 内结束（{run_id}）")


async def test_主模型不可用_整轮切备用模型并留痕(client, monkeypatch):
    from agent_studio.runtimes import register_runtime

    rt = ModelSwitchRuntime()
    register_runtime(rt)
    monkeypatch.setattr(settings, "run_retry_max", 0)  # 这一条只验换模型，不掺重试
    monkeypatch.setattr(settings, "max_concurrent_runs", 0)

    aid = await _mk_agent_with_fallback(
        client, _uniq("备用模型"), {"provider": "deepseek", "name": "backup-good"}
    )
    r = await client.post("/api/runs", json={"agent_id": aid, "input": "hi"})
    assert r.status_code == 201, r.text
    run_id = r.json()["id"]
    data = await _drive(client, run_id)

    assert data["status"] == "ok", data
    assert rt.used == ["broken-primary", "backup-good"], f"应当先主后备，实际 {rt.used}"
    assert (data["output"] or {}).get("content") == "answered by backup-good"
    fb = (data["usage"] or {}).get("fallback") or {}
    assert fb.get("from") == "broken-primary" and fb.get("to") == "backup-good", data["usage"]

    # 事件流里要有这一步（用户看得到"切了模型"，而不是答案凭空出现）
    ev = await client.get(f"/api/runs/events/{run_id}")
    types = [e["type"] for e in ev.json()]
    assert "model_fallback" in types, types


async def test_没有备用模型时行为不变(client, monkeypatch):
    from agent_studio.runtimes import register_runtime

    rt = ModelSwitchRuntime()
    register_runtime(rt)
    monkeypatch.setattr(settings, "run_retry_max", 0)
    monkeypatch.setattr(settings, "max_concurrent_runs", 0)

    aid = await _mk_agent_with_fallback(client, _uniq("无备用"), None)
    r = await client.post("/api/runs", json={"agent_id": aid, "input": "hi"})
    data = await _drive(client, r.json()["id"])
    assert data["status"] == "error"
    assert rt.used == ["broken-primary"], "没配备用就不该偷偷跑第二次"
    assert "401" in (data["error"] or "")


async def test_配置类错误不切模型(client, monkeypatch):
    """工具/schema 这类错换了模型照样错，切过去只是多花一次钱。"""
    from agent_studio.runtimes import register_runtime

    rt = ModelSwitchRuntime(error="tool schema invalid: missing name")
    register_runtime(rt)
    monkeypatch.setattr(settings, "run_retry_max", 0)
    monkeypatch.setattr(settings, "max_concurrent_runs", 0)

    aid = await _mk_agent_with_fallback(
        client, _uniq("配置错"), {"provider": "deepseek", "name": "backup-good"}
    )
    r = await client.post("/api/runs", json={"agent_id": aid, "input": "hi"})
    data = await _drive(client, r.json()["id"])
    assert data["status"] == "error"
    assert rt.used == ["broken-primary"], f"不该切：{rt.used}"
    assert not (data["usage"] or {}).get("fallback")
