"""运行中插话（steer）—— 一轮还在跑时把话塞进去，而不是排到它后面。

三层都要钉住：
1. 注册表：送达 / 结束了要如实说 / 运行时不会就说不会 / 留痕只取一次
2. 接口：404、空内容 400、卡在授权 409、运行中 200 并真的到了运行时
3. 端到端：一条**正在跑**的 run 被插话 → 事件里留痕 + 会话历史里看得见
"""

from __future__ import annotations

import asyncio
import time
import uuid

import pytest

from agent_studio import steer as registry
from agent_studio.runtimes.base import AgentRuntime, CompiledAgent, RuntimeCapabilities, UnifiedEvent
from agent_studio.steer import SteerResult


class _FakeRuntime:
    def __init__(self, boom: Exception | None = None) -> None:
        self.calls: list[str] = []
        self.boom = boom

    async def steer(self, compiled, text: str) -> None:
        if self.boom is not None:
            raise self.boom
        self.calls.append(text)


class _NoSteerRuntime:
    """老运行时：压根没有 steer 这个方法。"""


@pytest.mark.asyncio
async def test_插话会塞进正在跑的那一轮并留痕():
    seen: list[str] = []

    async def _on_steer(text: str) -> None:
        seen.append(text)

    rt = _FakeRuntime()
    await registry.attach("run_1", rt, compiled=object(), on_delivered=_on_steer)

    result = await registry.deliver("run_1", "  别删那个目录  ")

    assert result == SteerResult.DELIVERED
    assert rt.calls == ["别删那个目录"]  # 前后空白要去掉
    assert seen == ["别删那个目录"]      # 留痕回调（写事件、推 SSE）
    await registry.detach("run_1")


@pytest.mark.asyncio
async def test_这一轮结束了就别假装送出去了():
    await registry.detach("run_gone")
    assert await registry.deliver("run_gone", "喂") == SteerResult.GONE
    assert registry.is_live("run_gone") is False


@pytest.mark.asyncio
async def test_运行时不会插话要如实说不会():
    await registry.attach("run_2", _NoSteerRuntime(), compiled=object())
    assert await registry.deliver("run_2", "喂") == SteerResult.UNSUPPORTED
    await registry.detach("run_2")


@pytest.mark.asyncio
async def test_运行时抛未实现也归到不会():
    await registry.attach("run_3", _FakeRuntime(NotImplementedError("x")), compiled=object())
    assert await registry.deliver("run_3", "喂") == SteerResult.UNSUPPORTED
    await registry.detach("run_3")


@pytest.mark.asyncio
async def test_塞的时候炸了不能当成送达():
    await registry.attach("run_4", _FakeRuntime(RuntimeError("钩子没了")), compiled=object())
    assert await registry.deliver("run_4", "喂") == SteerResult.FAILED
    await registry.detach("run_4")


@pytest.mark.asyncio
async def test_空话不送():
    rt = _FakeRuntime()
    await registry.attach("run_5", rt, compiled=object())
    assert await registry.deliver("run_5", "   ") == SteerResult.FAILED
    assert rt.calls == []
    await registry.detach("run_5")


@pytest.mark.asyncio
async def test_一轮里多次插话按顺序记下来且只取一次():
    registry.take_texts("run_6")  # 清掉可能的残留
    registry.remember("run_6", "第一句")
    registry.remember("run_6", "第二句")
    assert registry.take_texts("run_6") == ["第一句", "第二句"]
    # 取过就清 —— 否则收尾重复写进会话历史
    assert registry.take_texts("run_6") == []


# --------------------------------------------------------------------------- #
# 端到端：一个真的会停在那里等你的运行时
# --------------------------------------------------------------------------- #


class _Compiled(CompiledAgent):
    def __init__(self) -> None:
        self.last_output: dict | None = None

    async def dispose(self) -> None:  # pragma: no cover - 桩
        return None


class _BlockingRuntime(AgentRuntime):
    """跑到一半停住，直到测试放行 —— 用来模拟"这一轮正在跑"。"""

    name = "blocking-runtime"

    def __init__(self) -> None:
        self.release = asyncio.Event()
        self.steers: list[str] = []

    def capabilities(self) -> RuntimeCapabilities:
        return RuntimeCapabilities(name=self.name, display_name="会停住的桩")

    async def validate(self, definition):  # noqa: ANN001
        return []

    async def compile(self, definition, **ctx):  # noqa: ANN001
        return _Compiled()

    def run(self, agent, run_input):  # noqa: ANN001
        async def gen():
            yield UnifiedEvent(type="run_start", ts=int(time.time() * 1000), payload={})
            await self.release.wait()
            agent.last_output = {"content": "跑完了"}
            yield UnifiedEvent(type="run_end", ts=int(time.time() * 1000), payload={"finished_reason": "stop"})

        return gen()

    async def steer(self, agent, text: str) -> None:  # noqa: ANN001
        self.steers.append(text)

    async def dispose(self, agent) -> None:  # noqa: ANN001
        return None


def _uniq(p: str) -> str:
    return f"{p}-{uuid.uuid4().hex[:6]}"


async def _pump(client, run_id: str, timeout_s: float = 10.0) -> dict:
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


async def _wait_status(client, run_id: str, want: str, timeout_s: float = 8.0) -> None:
    import time as _t

    deadline = _t.monotonic() + timeout_s
    while _t.monotonic() < deadline:
        r = await client.get(f"/api/runs/{run_id}")
        if r.status_code == 200 and r.json()["status"] == want:
            return
        await asyncio.sleep(0.05)
    raise AssertionError(f"状态没有变成 {want}（{run_id}）")


async def _setup(client, monkeypatch):
    from agent_studio.config import settings
    from agent_studio.runtimes import register_runtime

    rt = _BlockingRuntime()
    register_runtime(rt)
    monkeypatch.setattr(settings, "max_concurrent_runs", 0)

    name = _uniq("插话验收")
    definition = {
        "runtime": rt.name,
        "name": name,
        "system_prompt": "桩助手",
        "model": {"provider": "deepseek", "name": "stub-model"},
        "tools": [],
        "skills": [],
        "limits": {"max_iters": 3, "timeout_s": 30},
    }
    a = await client.post("/api/agents", json={"name": name, "definition": definition})
    assert a.status_code in (200, 201), a.text
    s = await client.post("/api/sessions", json={"agent_id": a.json()["id"], "title": "插话会话"})
    assert s.status_code in (200, 201), s.text
    return rt, a.json()["id"], s.json()["id"]


@pytest.mark.asyncio
async def test_运行中插话_事件留痕且写进会话历史(client, monkeypatch):
    rt, aid, sid = await _setup(client, monkeypatch)

    r = await client.post(
        "/api/runs", json={"agent_id": aid, "session_id": sid, "input": "先干着", "origin": "chat"}
    )
    assert r.status_code == 201, r.text
    run_id = r.json()["id"]

    pump = asyncio.create_task(_pump(client, run_id))
    await _wait_status(client, run_id, "running")

    steer = await client.post(f"/api/runs/{run_id}/steer", json={"text": "别爬页面，改用接口"})
    assert steer.status_code == 200, steer.text
    assert steer.json()["delivered"] is True
    assert rt.steers == ["别爬页面，改用接口"]

    rt.release.set()
    data = await pump
    assert data["status"] == "ok", data

    # 1) 事件里看得见"插过话"（回放/时间线靠它）
    ev = await client.get(f"/api/runs/events/{run_id}")
    steers = [e for e in ev.json() if e["type"] == "steer"]
    assert steers and steers[0]["payload"]["text"] == "别爬页面，改用接口", ev.json()

    # 2) 会话历史里也留着（刷新页面不会凭空消失）
    detail = await client.get(f"/api/sessions/{sid}")
    contents = [m["content"] for m in detail.json().get("messages", [])]
    assert any("（运行中插话）别爬页面，改用接口" == c for c in contents), contents


@pytest.mark.asyncio
async def test_一轮跑完了再插话会被拒(client, monkeypatch):
    rt, aid, sid = await _setup(client, monkeypatch)
    r = await client.post(
        "/api/runs", json={"agent_id": aid, "session_id": sid, "input": "干着", "origin": "chat"}
    )
    run_id = r.json()["id"]
    pump = asyncio.create_task(_pump(client, run_id))
    await _wait_status(client, run_id, "running")
    rt.release.set()
    await pump

    late = await client.post(f"/api/runs/{run_id}/steer", json={"text": "慢着"})
    assert late.status_code == 409, late.text
    assert "结束" in late.json()["detail"]
