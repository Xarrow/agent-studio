"""指标采集测试 —— 平台的"可观测性"底座。

这些测试验证的核心命题：**耗时完全可以从事件流推导出来，无需额外埋点**。
"""

from __future__ import annotations

from agent_studio.runner.metrics import MetricsCollector
from agent_studio.runtimes.base import UnifiedEvent


def ev(type_: str, ts: int, **payload) -> UnifiedEvent:
    return UnifiedEvent(type=type_, ts=ts, payload=payload)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# LLM 调用：耗时与 TTFT
# --------------------------------------------------------------------------- #
def test_llm_duration_and_ttft():
    c = MetricsCollector(provider="deepseek", model="deepseek-v4-flash")
    c.on_event(ev("llm_call_start", 1000))
    c.on_event(ev("thinking_delta", 1200, delta="思考中"))
    c.on_event(ev("text_delta", 1300, delta="你好"))
    c.on_event(
        ev("llm_call_end", 2000, usage={"input_tokens": 10, "output_tokens": 5})
    )

    assert len(c.llm_calls) == 1
    rec = c.llm_calls[0]
    assert rec.duration_ms == 1000          # 2000 - 1000
    assert rec.ttft_ms == 200               # 首个 delta 在 1200
    assert rec.tokens_in == 10
    assert rec.tokens_out == 5
    assert rec.provider == "deepseek"
    assert rec.model == "deepseek-v4-flash"
    assert rec.iteration == 1


def test_ttft_uses_first_delta_only():
    """TTFT 必须取**首个**增量，后续 delta 不能覆盖。"""
    c = MetricsCollector()
    c.on_event(ev("llm_call_start", 0))
    c.on_event(ev("text_delta", 100))
    c.on_event(ev("text_delta", 500))
    c.on_event(ev("thinking_delta", 900))
    c.on_event(ev("llm_call_end", 1000))
    assert c.llm_calls[0].ttft_ms == 100


def test_cache_tokens_variants():
    """不同 provider 的缓存 token 字段名不同，都要能识别。"""
    for field in ("cache_read_input_tokens", "cached_tokens"):
        c = MetricsCollector()
        c.on_event(ev("llm_call_start", 0))
        c.on_event(ev("llm_call_end", 10, usage={field: 42}))
        assert c.llm_calls[0].tokens_cache_read == 42


# --------------------------------------------------------------------------- #
# 工具调用
# --------------------------------------------------------------------------- #
def test_tool_duration():
    c = MetricsCollector()
    c.on_event(ev("tool_call_start", 1000, tool_call_id="t1", tool_name="read"))
    c.on_event(ev("tool_exec_start", 1100, tool_call_id="t1", tool_name="read"))
    c.on_event(ev("tool_result_delta", 1400, tool_call_id="t1", result="hello"))
    c.on_event(ev("tool_exec_end", 1500, tool_call_id="t1", tool_name="read"))

    assert len(c.tool_calls) == 1
    rec = c.tool_calls[0]
    assert rec.tool_name == "read"
    # 耗时从 tool_exec_start 起算（1100 → 1500），不含 LLM 决策时间
    assert rec.duration_ms == 400
    assert rec.result_size == 5             # "hello"
    assert rec.status == "ok"


def test_concurrent_tools_paired_by_key():
    """并发工具调用必须按 id 正确配对，不能串。"""
    c = MetricsCollector()
    c.on_event(ev("tool_call_start", 100, tool_call_id="A", tool_name="read"))
    c.on_event(ev("tool_call_start", 110, tool_call_id="B", tool_name="grep"))
    c.on_event(ev("tool_exec_start", 120, tool_call_id="A"))
    c.on_event(ev("tool_exec_start", 130, tool_call_id="B"))
    c.on_event(ev("tool_exec_end", 300, tool_call_id="B"))
    c.on_event(ev("tool_exec_end", 500, tool_call_id="A"))

    by_id = {r.call_id: r for r in c.tool_calls}
    assert by_id["A"].duration_ms == 380     # 500 - 120
    assert by_id["B"].duration_ms == 170     # 300 - 130
    assert by_id["A"].tool_name == "read"
    assert by_id["B"].tool_name == "grep"


def test_tool_args_accumulated():
    c = MetricsCollector()
    c.on_event(ev("tool_call_start", 0, tool_call_id="t1", tool_name="write"))
    c.on_event(ev("tool_call_args", 10, tool_call_id="t1", delta={"path": "a.txt"}))
    c.on_event(ev("tool_call_args", 20, tool_call_id="t1", delta={"content": "hi"}))
    c.on_event(ev("tool_exec_start", 30, tool_call_id="t1"))
    c.on_event(ev("tool_exec_end", 40, tool_call_id="t1"))
    assert c.tool_calls[0].args == {"path": "a.txt", "content": "hi"}


def test_tool_error_captured():
    c = MetricsCollector()
    c.on_event(ev("tool_call_start", 0, tool_call_id="t1", tool_name="http"))
    c.on_event(ev("tool_exec_start", 10, tool_call_id="t1"))
    c.on_event(ev("tool_exec_end", 20, tool_call_id="t1", error="HTTP 500"))
    assert c.tool_calls[0].status == "error"
    assert "500" in (c.tool_calls[0].error or "")


# --------------------------------------------------------------------------- #
# 异常与收尾
# --------------------------------------------------------------------------- #
def test_error_event_closes_open_records():
    c = MetricsCollector()
    c.on_event(ev("llm_call_start", 0))
    c.on_event(ev("tool_call_start", 5, tool_call_id="t1", tool_name="x"))
    c.on_event(ev("error", 100, error="boom"))

    assert c.llm_calls[0].status == "error"
    assert c.tool_calls[0].status == "error"
    assert c.tool_calls[0].duration_ms == 95


def test_flush_open_records_on_stream_end():
    """流异常结束（没有 end 事件）也要收尾，否则指标会漏。"""
    c = MetricsCollector()
    c.on_event(ev("llm_call_start", 0))
    c.on_event(ev("tool_call_start", 0, tool_call_id="t1", tool_name="x"))
    c.flush_open(1000)
    assert len(c.llm_calls) == 1
    assert c.llm_calls[0].status == "error"
    assert len(c.tool_calls) == 1


# --------------------------------------------------------------------------- #
# 聚合
# --------------------------------------------------------------------------- #
def test_summary_aggregates():
    c = MetricsCollector()
    # 两轮 LLM
    c.on_event(ev("llm_call_start", 0))
    c.on_event(ev("text_delta", 100))
    c.on_event(ev("llm_call_end", 1000, usage={"input_tokens": 10, "output_tokens": 2}))
    c.on_event(ev("llm_call_start", 1000))
    c.on_event(ev("text_delta", 1100))
    c.on_event(ev("llm_call_end", 3000, usage={"input_tokens": 20, "output_tokens": 4}))
    # 一次工具
    c.on_event(ev("tool_call_start", 3000, tool_call_id="t", tool_name="read"))
    c.on_event(ev("tool_exec_start", 3000, tool_call_id="t"))
    c.on_event(ev("tool_exec_end", 3500, tool_call_id="t"))

    s = c.summary()
    assert s["iterations"] == 2
    assert s["llm_calls"] == 2
    assert s["tool_calls"] == 1
    assert s["llm_ms"] == 3000            # 1000 + 2000
    assert s["tool_ms"] == 500
    assert s["ttft_ms_avg"] == 100        # (100 + 100) / 2
    assert s["tokens_in"] == 30
    assert s["tokens_out"] == 6
    assert s["errors"] == 0


def test_summary_counts_errors():
    c = MetricsCollector()
    c.on_event(ev("llm_call_start", 0))
    c.on_event(ev("llm_call_end", 10, error="rate limited"))
    s = c.summary()
    assert s["errors"] == 1


# --------------------------------------------------------------------------- #
# 阶段耗时占比（用于判断"模型瓶颈 vs 工具瓶颈"）
# --------------------------------------------------------------------------- #
def test_stage_breakdown_ratio():
    c = MetricsCollector()
    c.on_event(ev("llm_call_start", 0))
    c.on_event(ev("llm_call_end", 8000))
    c.on_event(ev("tool_call_start", 8000, tool_call_id="t", tool_name="slow_tool"))
    c.on_event(ev("tool_exec_start", 8000, tool_call_id="t"))
    c.on_event(ev("tool_exec_end", 10000, tool_call_id="t"))

    s = c.summary()
    total = 10000
    assert s["llm_ms"] / total == 0.8     # 80% 花在模型
    assert s["tool_ms"] / total == 0.2    # 20% 花在工具


# --------------------------------------------------------------------------- #
# 用 AgentScope 的**真实字段名**回归（实测得来，防止再次踩坑）
# --------------------------------------------------------------------------- #
def test_agentscope_real_field_names():
    """AgentScope 用的是 tool_call_name / delta / state，不是通用命名。"""
    c = MetricsCollector()
    c.on_event(ev("tool_call_start", 100, tool_call_id="call_1", tool_call_name="get_health"))
    c.on_event(ev("tool_exec_start", 120, tool_call_id="call_1", tool_call_name="get_health"))
    c.on_event(ev("tool_result_delta", 150, tool_call_id="call_1", delta='{"status":"ok"}'))
    c.on_event(ev("tool_exec_end", 200, tool_call_id="call_1", state="success"))

    assert len(c.tool_calls) == 1
    rec = c.tool_calls[0]
    assert rec.tool_name == "get_health", "工具名不能是 unknown"
    assert rec.result_size == 15          # len('{"status":"ok"}')
    assert rec.status == "ok"
    assert rec.duration_ms == 80          # 200 - 120


def test_agentscope_tool_error_state():
    """state != success 要判为错误。"""
    c = MetricsCollector()
    c.on_event(ev("tool_call_start", 0, tool_call_id="c", tool_call_name="x"))
    c.on_event(ev("tool_exec_start", 0, tool_call_id="c"))
    c.on_event(ev("tool_exec_end", 10, tool_call_id="c", state="error"))
    assert c.tool_calls[0].status == "error"
    assert "state=error" in (c.tool_calls[0].error or "")


def test_agentscope_usage_flat_fields():
    """ModelCallEndEvent 的 token 是**平铺**字段（实测）。"""
    c = MetricsCollector()
    c.on_event(ev("llm_call_start", 0))
    c.on_event(
        ev(
            "llm_call_end",
            500,
            input_tokens=101,
            output_tokens=24,
            cache_input_tokens=7,
            finished_reason="completed",
        )
    )
    rec = c.llm_calls[0]
    assert rec.tokens_in == 101
    assert rec.tokens_out == 24
    assert rec.tokens_cache_read == 7
    assert rec.duration_ms == 500
