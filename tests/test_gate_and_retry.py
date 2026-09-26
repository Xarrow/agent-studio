"""护栏：并发闸 + 临时错误退避重试（都是真跑出来的证据，不是纸面）。

要防的两个真实故障：
  ① 没有并发上限 → 同层节点并发 + 多流程 + 定时一起打在同一个 key 上，自己把自己限流
  ② 临时错误（429 / 5xx / 连接断 / 读超时）直接报废 → 用户看到"模型不行"，其实等一下就好

**不能重试的**是用户自己设的执行超时（TimeoutError）—— 那是用户的上限，
重试只会更慢，还会掩盖真正的问题。这条单独钉一个断言。
"""

from __future__ import annotations

import asyncio
import uuid

import pytest

from agent_studio.config import settings
from agent_studio.runner.gate import Gate, GateTimeout, backoff_s, is_transient
from agent_studio.runtimes.base import AgentRuntime, CompiledAgent, RuntimeCapabilities


def uniq(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


# --------------------------------------------------------------------------- #
# 1. 纯逻辑：什么值得重试 / 退避多久
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "exc",
    [
        RuntimeError("HTTP 429 Too Many Requests"),
        RuntimeError("rate limit exceeded, please retry"),
        RuntimeError("503 Service Unavailable"),
        RuntimeError("502 Bad Gateway"),
        RuntimeError("Connection reset by peer"),
        RuntimeError("ReadTimeout: the read operation timed out"),
        RuntimeError("server is overloaded"),
    ],
)
def test_transient_errors_are_retried(exc):
    assert is_transient(exc) is True


@pytest.mark.parametrize(
    "exc",
    [
        TimeoutError("执行超时"),                      # **用户设的执行上限：不重试**
        asyncio.TimeoutError("执行超时"),
        asyncio.CancelledError(),                      # 用户主动中断
        ValueError("tool schema invalid"),             # 配置错误，重试也一样
        RuntimeError("model not found: deepseek-v999"),  # 永久性错误
    ],
)
def test_non_transient_errors_are_not_retried(exc):
    assert is_transient(exc) is False


def test_backoff_grows_and_caps():
    assert backoff_s(1, 1.5) == 1.5
    assert backoff_s(2, 1.5) == 3.0
    assert backoff_s(3, 1.5) == 6.0
    assert backoff_s(99, 1.5) == 30.0, "封顶，别退避到天荒地老"


# --------------------------------------------------------------------------- #
# 2. 并发闸：真的同时只跑 N 个
# --------------------------------------------------------------------------- #
async def test_gate_caps_concurrency():
    g = Gate(2)
    peak = 0
    running = 0

    async def worker() -> None:
        nonlocal peak, running
        await g.acquire()
        running += 1
        peak = max(peak, running)
        try:
            await asyncio.sleep(0.05)
        finally:
            running -= 1
            g.release()

    await asyncio.gather(*(worker() for _ in range(6)))
    assert peak == 2, f"并发上限没生效（峰值 {peak}）"
    assert running == 0, "槽位必须都还回去"


async def test_gate_size_zero_means_unlimited():
    g = Gate(0)
    peak = 0
    running = 0

    async def worker() -> None:
        nonlocal peak, running
        await g.acquire()
        running += 1
        peak = max(peak, running)
        await asyncio.sleep(0.01)
        running -= 1
        g.release()

    await asyncio.gather(*(worker() for _ in range(5)))
    assert peak == 5, "size=0 表示不限并发（老行为不能变）"


async def test_gate_wait_timeout_is_reported_clearly():
    g = Gate(1)
    await g.acquire()                      # 占住唯一的槽位
    with pytest.raises(GateTimeout) as ei:
        await g.acquire("run_x", wait_s=0.05)
    msg = str(ei.value)
    assert "排队太久" in msg and "并发上限 1" in msg, "要说清是排队而不是模型不行"
    g.release()


# --------------------------------------------------------------------------- #
# 3. 端到端：429 → 重试 → 成功（走真实的 RunService，只是运行时换成桩）
# --------------------------------------------------------------------------- #
class _Compiled(CompiledAgent):
    """最小编译产物（Runner 只用到 last_output 与 dispose/snapshot）。"""

    def __init__(self) -> None:
        self.last_output: dict | None = None

    async def dispose(self) -> None:  # pragma: no cover - 桩
        return None


class FlakyRuntime(AgentRuntime):
    """前 ``fail_times`` 次抛 429，之后成功；顺带记录并发峰值。"""

    name = "flaky-test-runtime"

    def __init__(self, fail_times: int = 2, delay: float = 0.0, broken: bool = False) -> None:
        self.fail_times = fail_times
        self.delay = delay
        self.broken = broken
        self.attempts = 0
        self.peak = 0
        self._running = 0

    def capabilities(self) -> RuntimeCapabilities:
        return RuntimeCapabilities(name=self.name, display_name="Flaky")

    async def validate(self, definition):  # noqa: ANN001
        return []

    async def compile(self, definition, **ctx):  # noqa: ANN001
        return _Compiled()

    def run(self, agent, run_input):  # noqa: ANN001
        async def gen():
            self._running += 1
            self.peak = max(self.peak, self._running)
            self.attempts += 1
            try:
                if self.attempts <= self.fail_times:
                    raise RuntimeError("HTTP 429 Too Many Requests（桩：模拟限流）")
                if self.broken:
                    raise ValueError("tool schema invalid（桩：不可重试的错误）")
                if self.delay:
                    await asyncio.sleep(self.delay)
                agent.last_output = {"content": f"ok after {self.attempts} attempts"}
                if False:  # pragma: no cover - 生成器语法需要
                    yield
            finally:
                self._running -= 1

        return gen()

    async def dispose(self, agent) -> None:  # noqa: ANN001
        return None


async def _mk_agent(client, runtime: str, name: str) -> str:
    r = await client.post(
        "/api/agents",
        json={
            "name": name,
            "definition": {
                "runtime": runtime,
                "name": name,
                "system_prompt": "桩助手",
                "model": {"provider": "deepseek", "name": "deepseek-v4-flash"},
                "tools": [],
                "skills": [],
                "limits": {"max_iters": 3, "timeout_s": 30},
            },
        },
    )
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def _wait_terminal(client, run_id: str, timeout_s: float = 8.0) -> dict:
    import time as _t

    deadline = _t.monotonic() + timeout_s
    while _t.monotonic() < deadline:
        r = await client.get(f"/api/runs/{run_id}")
        if r.status_code == 200:
            data = r.json()
            if data["status"] in ("ok", "error", "aborted"):
                return data
        await asyncio.sleep(0.05)
    raise AssertionError(f"执行没有在 {timeout_s}s 内结束（run={run_id}）")


async def test_run_retries_transient_error_and_records_it(client, monkeypatch):
    from agent_studio.runtimes import register_runtime

    rt = FlakyRuntime(fail_times=2)
    register_runtime(rt)
    monkeypatch.setattr(settings, "run_retry_max", 2)
    monkeypatch.setattr(settings, "run_retry_backoff_s", 0.01)   # 测试别真等 1.5s+3s
    monkeypatch.setattr(settings, "max_concurrent_runs", 0)      # 本用例只验重试

    aid = await _mk_agent(client, FlakyRuntime.name, uniq("重试"))
    r = await client.post("/api/runs", json={"agent_id": aid, "input": "hi"})
    assert r.status_code == 201, r.text
    data = await _wait_terminal(client, r.json()["id"])

    assert data["status"] == "ok", data
    assert rt.attempts == 3, f"应当是 1 次原始 + 2 次重试，实际 {rt.attempts}"
    assert data["usage"].get("retries") == 2, "重试次数要落进 usage（用户能从记录里看出来）"
    assert (data["output"] or {}).get("content", "").startswith("ok after 3"), data["output"]


async def test_run_does_not_retry_permanent_error(client, monkeypatch):
    from agent_studio.runtimes import register_runtime

    rt = FlakyRuntime(fail_times=0, broken=True)
    register_runtime(rt)
    monkeypatch.setattr(settings, "run_retry_max", 3)
    monkeypatch.setattr(settings, "run_retry_backoff_s", 0.01)
    monkeypatch.setattr(settings, "max_concurrent_runs", 0)

    aid = await _mk_agent(client, FlakyRuntime.name, uniq("不可重试"))
    r = await client.post("/api/runs", json={"agent_id": aid, "input": "hi"})
    data = await _wait_terminal(client, r.json()["id"])

    assert data["status"] == "error"
    assert rt.attempts == 1, "配置类错误一次就够，重试只是浪费时间和钱"
    assert "tool schema invalid" in (data["error"] or "")


async def test_run_queue_is_gated_end_to_end(client, monkeypatch):
    """并发闸在真实执行路径上生效：3 个执行、上限 2 → 峰值 2，且都跑完。"""
    from agent_studio.runner.gate import gate
    from agent_studio.runtimes import register_runtime

    rt = FlakyRuntime(fail_times=0, delay=0.25)
    register_runtime(rt)
    monkeypatch.setattr(settings, "run_retry_max", 0)
    monkeypatch.setattr(settings, "max_concurrent_runs", 2)
    monkeypatch.setattr(gate, "_size", 2)
    monkeypatch.setattr(gate, "_sem", None, raising=False)
    monkeypatch.setattr(gate, "_lock", asyncio.Lock(), raising=False)

    aid = await _mk_agent(client, FlakyRuntime.name, uniq("闸"))
    ids = []
    for _ in range(3):
        r = await client.post("/api/runs", json={"agent_id": aid, "input": "hi"})
        ids.append(r.json()["id"])

    for rid in ids:
        data = await _wait_terminal(client, rid, timeout_s=10)
        assert data["status"] == "ok", data
    assert rt.peak <= 2, f"并发闸没生效（峰值 {rt.peak}）"
