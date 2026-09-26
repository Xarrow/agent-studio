"""护栏：span 树（耗时瀑布的数据源）。

`span` 表在这之前**一直是空的**（schema 早就有、没人写）——
没有它，"这一步为什么慢了三分钟"只能靠翻日志看时间戳。
这里钉三件事：
  ① 从事件流里能真的搭出 run → iteration → llm/tool 的树（父子关系正确）
  ② 层级 = 「第几轮调用的」，跨轮不错位（最容易做错的地方）
  ③ 落库后 /trace 能读出来，且**重复 finalize 不会出现重复条**（重试/HITL 续跑）
"""

from __future__ import annotations

import uuid

from agent_studio.runtimes.base import AgentRuntime, CompiledAgent, RuntimeCapabilities, UnifiedEvent
from agent_studio.runner.metrics import MetricsCollector

from test_gate_and_retry import _mk_agent, _wait_terminal


def ev(kind: str, ts: int, **payload) -> UnifiedEvent:
    return UnifiedEvent(type=kind, ts=ts, payload=payload)


def test_collector_builds_span_tree():
    c = MetricsCollector(provider="deepseek", model="deepseek-v4-flash")
    t = 1_000_000
    stream = [
        ev("run_start", t, agent="A"),
        ev("llm_call_start", t + 10, model="deepseek-v4-flash"),
        ev("text_delta", t + 60, content="你"),
        ev("llm_call_end", t + 100, usage={"input_tokens": 10, "output_tokens": 2}),
        ev("tool_call_start", t + 110, tool_name="read_file", call_id="c1"),
        ev("tool_exec_start", t + 130, tool_name="read_file", call_id="c1"),
        ev("tool_result_delta", t + 200, call_id="c1", content="x" * 40),
        ev("tool_exec_end", t + 230, call_id="c1", state="success"),
        ev("llm_call_start", t + 240, model="deepseek-v4-flash"),
        ev("text_delta", t + 260, content="好"),
        ev("llm_call_end", t + 300, usage={"input_tokens": 20, "output_tokens": 3}),
        ev("run_end", t + 320),
    ]
    for e in stream:
        c.on_event(e)
    c.finish_spans(t + 330)
    rows = {r["key"]: r for r in c.span_rows(root_name="测试助手")}

    kinds = sorted(r["kind"] for r in rows.values())
    assert kinds == ["iteration", "iteration", "llm", "llm", "run", "tool"], kinds

    root = next(r for r in rows.values() if r["kind"] == "run")
    assert root["name"] == "测试助手", "根 span 要有名字（瀑布图第一行的标签）"
    assert root["duration_ms"] == 330

    iters = {r["name"]: r for r in rows.values() if r["kind"] == "iteration"}
    assert set(iters) == {"第 1 轮", "第 2 轮"}
    for it in iters.values():
        assert it["parent"] == root["key"], "轮次必须挂在根 span 下"

    llms = [r for r in rows.values() if r["kind"] == "llm"]
    tools = [r for r in rows.values() if r["kind"] == "tool"]
    assert len(llms) == 2 and len(tools) == 1
    # **跨轮不错位**：第一次 LLM 挂在第 1 轮下，第二次挂第 2 轮下
    first, second = sorted(llms, key=lambda r: r["started_at"])
    assert first["parent"] == iters["第 1 轮"]["key"]
    assert second["parent"] == iters["第 2 轮"]["key"], "第 2 轮的 LLM 挂错了父（层级会整体错位）"
    assert tools[0]["parent"] == iters["第 1 轮"]["key"], "工具是第 1 轮发起的，不该挂到第 2 轮"

    assert first["duration_ms"] == 90
    assert first["attributes"]["tokens_in"] == 10
    assert first["attributes"]["ttft_ms"] == 50, "首字延迟要记进 span（这是体感的关键数字）"
    assert tools[0]["duration_ms"] == 100
    assert tools[0]["attributes"]["result_size"] == 40


def test_collector_closes_spans_on_abnormal_end():
    """流异常结束（没有 end 事件）时不能留下"永不结束"的条。"""
    c = MetricsCollector(provider="p", model="m")
    c.on_event(ev("run_start", 1000))
    c.on_event(ev("llm_call_start", 1010, model="m"))
    c.on_event(ev("tool_exec_start", 1020, tool_name="bash", call_id="c"))
    c.flush_open(1100)          # 流断了
    c.finish_spans(1100)
    rows = c.span_rows()
    assert rows, "至少要有根 span"
    assert all(r["ended_at"] is not None for r in rows), "有 span 没闭合（瀑布图上会悬空）"


class _Compiled(CompiledAgent):
    def __init__(self) -> None:
        self.last_output = {"content": "好"}

    async def dispose(self) -> None:  # pragma: no cover - 桩
        return None


class SpanRuntime(AgentRuntime):
    """桩运行时：吐一串事件（真跑一遍格式），用来验证 span 真的落库。"""

    name = "span-test-runtime"

    def capabilities(self) -> RuntimeCapabilities:
        return RuntimeCapabilities(name=self.name, display_name="Span")

    async def validate(self, definition):  # noqa: ANN001
        return []

    async def compile(self, definition, **ctx):  # noqa: ANN001
        return _Compiled()

    def run(self, agent, run_input):  # noqa: ANN001
        async def gen():
            t = 5_000_000
            yield ev("run_start", t)
            yield ev("llm_call_start", t + 10, model="deepseek-v4-flash")
            yield ev("text_delta", t + 50, content="好")
            yield ev("llm_call_end", t + 90, usage={"input_tokens": 7, "output_tokens": 1})
            yield ev("tool_call_start", t + 100, tool_name="read_file", call_id="c9")
            yield ev("tool_exec_start", t + 110, tool_name="read_file", call_id="c9")
            yield ev("tool_exec_end", t + 150, call_id="c9", state="success")
            yield ev("llm_call_start", t + 160, model="deepseek-v4-flash")
            yield ev("llm_call_end", t + 200, usage={"input_tokens": 8, "output_tokens": 2})
            agent.last_output = {"content": "好"}

        return gen()

    async def dispose(self, agent) -> None:  # noqa: ANN001
        return None


async def test_spans_are_persisted_and_readable_via_trace(client, monkeypatch):
    from agent_studio.config import settings
    from agent_studio.runtimes import register_runtime

    register_runtime(SpanRuntime())
    monkeypatch.setattr(settings, "max_concurrent_runs", 0)
    monkeypatch.setattr(settings, "run_retry_max", 0)

    aid = await _mk_agent(client, SpanRuntime.name, f"span-{uuid.uuid4().hex[:8]}")
    r = await client.post("/api/runs", json={"agent_id": aid, "input": "hi"})
    rid = r.json()["id"]
    data = await _wait_terminal(client, rid)
    assert data["status"] == "ok", data

    trace = (await client.get(f"/api/runs/trace/{rid}")).json()
    spans = trace["spans"]
    kinds = sorted(s["kind"] for s in spans)
    assert kinds == ["iteration", "iteration", "llm", "llm", "run", "tool"], kinds

    root = next(s for s in spans if s["kind"] == "run")
    ids = {s["id"] for s in spans}
    assert all(s["parent_id"] in ids or s["parent_id"] is None for s in spans)
    assert root["parent_id"] is None and root["duration_ms"] is not None

    # 重复 finalize（重试 / HITL 续跑）不该出现重复条
    from agent_studio.db import SessionLocal
    from agent_studio.runner.service import run_service
    from agent_studio.schemas import AgentDefinition

    async with SessionLocal() as s:
        from agent_studio.models import Run

        run = await s.get(Run, rid)
        snapshot = AgentDefinition.model_validate(run.definition_snapshot or {})
    await run_service.execute(rid, snapshot, "hi", resumed=True)
    trace2 = (await client.get(f"/api/runs/trace/{rid}")).json()
    assert len(trace2["spans"]) == len(spans), "重复 finalize 让 span 翻倍了（图上会出现两层重影）"
