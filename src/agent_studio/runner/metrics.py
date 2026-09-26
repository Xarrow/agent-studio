"""指标采集 —— 从统一事件流计算耗时与用量。

设计原则：**不额外埋点**。所有耗时来自事件配对：

- LLM 调用耗时 = llm_call_end.ts - llm_call_start.ts
- TTFT         = 首个 thinking/text delta.ts - llm_call_start.ts
- 工具耗时     = tool_exec_end.ts - tool_exec_start.ts

配对使用事件顺序（而非时间戳），并发工具调用也不会串。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..runtimes.base import UnifiedEvent

#: 工具结束事件里可能承载结果的字段
_RESULT_KEYS = ("result", "content", "text", "output", "chunk", "delta")


@dataclass
class LlmCallRecord:
    iteration: int
    started_at: int
    ended_at: int | None = None
    ttft_ms: int | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    tokens_cache_read: int = 0
    provider: str | None = None
    model: str | None = None
    status: str = "ok"
    error: str | None = None

    @property
    def duration_ms(self) -> int | None:
        if self.ended_at is None:
            return None
        return max(0, self.ended_at - self.started_at)


@dataclass
class ToolCallRecord:
    tool_name: str
    call_id: str | None
    iteration: int
    started_at: int
    args: dict[str, Any] = field(default_factory=dict)
    ended_at: int | None = None
    status: str = "ok"
    result_size: int = 0
    result_preview: str | None = None
    error: str | None = None

    @property
    def duration_ms(self) -> int | None:
        if self.ended_at is None:
            return None
        return max(0, self.ended_at - self.started_at)


def _first(payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in payload and payload[key] is not None:
            return payload[key]
    return None


def _extract_usage(payload: dict[str, Any]) -> dict[str, Any]:
    """从任意事件载荷里尽力提取 token 用量。

    兼容两种形态：

    1. 嵌套 —— ``{"usage": {"input_tokens": ...}}``（多数 provider）
    2. 平铺 —— ``{"input_tokens": ..., "output_tokens": ...}``
       （AgentScope 的 ``ModelCallEndEvent`` 就是这种）
    """
    usage = payload.get("usage")
    if isinstance(usage, dict) and usage:
        return usage

    flat_keys = {
        "input_tokens",
        "output_tokens",
        "total_tokens",
        "prompt_tokens",
        "completion_tokens",
        "cache_input_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
        "cached_tokens",
    }
    return {k: v for k, v in payload.items() if k in flat_keys}


class MetricsCollector:
    """消费统一事件流，产出一份 Run 的 LLM / 工具调用明细。"""

    def __init__(self, provider: str | None = None, model: str | None = None) -> None:
        self.default_provider = provider
        self.default_model = model

        self.iteration = 0
        #: 因为临时错误重试了几次（0 = 一次就过）—— 进 usage，界面上看得见
        self.retries = 0
        self.llm_calls: list[LlmCallRecord] = []
        self.tool_calls: list[ToolCallRecord] = []

        self._open_llm: LlmCallRecord | None = None
        self._ttft_done = False
        self._open_tools: dict[str, ToolCallRecord] = {}
        self._pending_args: dict[str, dict[str, Any]] = {}

        # ── span 树（瀑布图的数据源）───────────────────────────────────────
        # `span` 表一直是空的：schema 早就有、没人写。没有它，"这一步为什么慢了三分钟"
        # 只能靠翻日志。这里从**已经在消费的那份事件流**里顺手把树搭出来
        # （不要求运行时额外上报）：run → iteration（每轮）→ llm / tool。
        self._spans: list[dict[str, Any]] = []
        self._root_span: str | None = None
        self._iter_spans: dict[int, str] = {}
        self._open_llm_span: str | None = None
        self._tool_spans: dict[str, str] = {}

    # ------------------------------------------------------------------ #
    def on_event(self, ev: UnifiedEvent) -> None:
        self._ensure_root(ev.ts)
        handler = getattr(self, f"_on_{ev.type}", None)
        if handler is not None:
            handler(ev)

    # ------------------------------------------------------------------ #
    # span 树（瀑布图数据源）
    # ------------------------------------------------------------------ #
    def _add_span(
        self,
        *,
        kind: str,
        name: str,
        started_at: int,
        parent: str | None,
        attributes: dict[str, Any] | None = None,
    ) -> str:
        sid = f"s{len(self._spans)}"
        self._spans.append(
            {
                "id": sid,
                "parent": parent,
                "kind": kind,
                "name": name[:128],
                "started_at": started_at,
                "ended_at": None,
                "attributes": dict(attributes or {}),
            }
        )
        return sid

    def _close_span(self, sid: str | None, ts: int, **attrs: Any) -> None:
        if not sid:
            return
        for sp in self._spans:
            if sp["id"] == sid and sp["ended_at"] is None:
                sp["ended_at"] = ts
                if attrs:
                    sp["attributes"].update({k: v for k, v in attrs.items() if v is not None})
                return

    def _ensure_root(self, ts: int) -> None:
        if self._root_span is None:
            self._root_span = self._add_span(kind="run", name="", started_at=ts, parent=None)

    def _iter_span(self, ts: int) -> str:
        """每一轮 LLM 调用一个 iteration span（父 = run）。"""
        self._ensure_root(ts)
        if self.iteration not in self._iter_spans:
            self._iter_spans[self.iteration] = self._add_span(
                kind="iteration",
                name=f"第 {self.iteration} 轮",
                started_at=ts,
                parent=self._root_span,
                attributes={"iteration": self.iteration},
            )
        return self._iter_spans[self.iteration]

    def finish_spans(self, ts: int) -> None:
        """正常收尾：把还没闭合的 iteration 与根 span 收口（否则瀑布图上出现"永不结束"的条）。"""
        for sid in self._iter_spans.values():
            self._close_span(sid, ts)
        self._close_span(self._root_span, ts)

    def span_rows(self, *, root_name: str = "") -> list[dict[str, Any]]:
        """整理成可落库的形状。

        ``key_ 是本地引用（"s0"…）—— 落库时换成真 id；父 span 一定排在子之前，
        所以调用方一遍循环就能建好父子关系。
        """
        out: list[dict[str, Any]] = []
        for sp in self._spans:
            end = sp["ended_at"]
            start = sp["started_at"]
            out.append(
                {
                    "key": sp["id"],
                    "parent": sp["parent"],
                    "kind": sp["kind"],
                    "name": root_name if (sp["kind"] == "run" and root_name) else sp["name"],
                    "started_at": start,
                    "ended_at": end,
                    "duration_ms": max(0, end - start) if end is not None else None,
                    "attributes": sp["attributes"],
                }
            )
        return out

    # ------------------------------------------------------------------ #
    def _on_llm_call_start(self, ev: UnifiedEvent) -> None:
        self.iteration += 1
        self._open_llm = LlmCallRecord(
            iteration=self.iteration,
            started_at=ev.ts,
            provider=_first(ev.payload, "provider") or self.default_provider,
            model=_first(ev.payload, "model", "model_name") or self.default_model,
        )
        self._ttft_done = False
        # span：本轮 → 本次 LLM 调用
        self._open_llm_span = self._add_span(
            kind="llm",
            name=str(self._open_llm.model or "llm"),
            started_at=ev.ts,
            parent=self._iter_span(ev.ts),
            attributes={"iteration": self.iteration, "provider": self._open_llm.provider},
        )

    def _mark_ttft(self, ev: UnifiedEvent) -> None:
        if self._open_llm is not None and not self._ttft_done:
            self._open_llm.ttft_ms = max(0, ev.ts - self._open_llm.started_at)
            self._ttft_done = True

    def _on_thinking_delta(self, ev: UnifiedEvent) -> None:
        self._mark_ttft(ev)

    def _on_text_delta(self, ev: UnifiedEvent) -> None:
        self._mark_ttft(ev)

    def _on_llm_call_end(self, ev: UnifiedEvent) -> None:
        rec = self._open_llm
        if rec is None:
            return
        rec.ended_at = ev.ts
        usage = _extract_usage(ev.payload)
        rec.tokens_in = int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0)
        rec.tokens_out = int(usage.get("output_tokens") or usage.get("completion_tokens") or 0)
        rec.tokens_cache_read = int(
            usage.get("cache_read_input_tokens")
            or usage.get("cache_input_tokens")      # AgentScope 用这个
            or usage.get("cached_tokens")
            or 0
        )
        err = _first(ev.payload, "error")
        if err:
            rec.status = "error"
            rec.error = str(err)[:2000]
        self.llm_calls.append(rec)
        self._close_span(
            self._open_llm_span,
            ev.ts,
            tokens_in=rec.tokens_in,
            tokens_out=rec.tokens_out,
            ttft_ms=rec.ttft_ms,
            status=rec.status,
        )
        self._open_llm_span = None
        self._open_llm = None

    # ------------------------------------------------------------------ #
    def _tool_key(self, ev: UnifiedEvent) -> str:
        key = _first(ev.payload, "tool_call_id", "call_id", "tool_call")
        if isinstance(key, dict):
            key = key.get("id")
        return str(key) if key else f"#{len(self.tool_calls)}"

    def _on_tool_call_start(self, ev: UnifiedEvent) -> None:
        key = self._tool_key(ev)
        name = _first(ev.payload, "tool_name", "tool_call_name", "name") or "unknown"
        self._open_tools[key] = ToolCallRecord(
            tool_name=str(name),
            call_id=key,
            iteration=self.iteration,
            started_at=ev.ts,
        )

    def _on_tool_call_args(self, ev: UnifiedEvent) -> None:
        key = self._tool_key(ev)
        args = _first(ev.payload, "arguments", "args", "delta")
        if isinstance(args, dict):
            self._pending_args.setdefault(key, {}).update(args)

    def _on_tool_exec_start(self, ev: UnifiedEvent) -> None:
        key = self._tool_key(ev)
        rec = self._open_tools.get(key)
        if rec is None:
            name = _first(ev.payload, "tool_name", "tool_call_name", "name") or "unknown"
            rec = ToolCallRecord(
                tool_name=str(name), call_id=key, iteration=self.iteration, started_at=ev.ts
            )
            self._open_tools[key] = rec
        if key in self._pending_args:
            rec.args = {**rec.args, **self._pending_args.pop(key)}
        # 工具真正开始执行的时间（比 LLM 决定调用更准确）
        rec.started_at = ev.ts
        self._tool_spans[key] = self._add_span(
            kind="tool",
            name=str(rec.tool_name),
            started_at=ev.ts,
            parent=self._iter_span(ev.ts),
            attributes={"call_id": key, "iteration": rec.iteration},
        )

    def _on_tool_result_delta(self, ev: UnifiedEvent) -> None:
        key = self._tool_key(ev)
        rec = self._open_tools.get(key)
        if rec is None:
            return
        chunk = _first(ev.payload, *_RESULT_KEYS)
        if chunk is not None:
            text = chunk if isinstance(chunk, str) else str(chunk)
            rec.result_size += len(text.encode("utf-8"))
            if rec.result_preview is None:
                rec.result_preview = text[:500]

    def _on_tool_exec_end(self, ev: UnifiedEvent) -> None:
        key = self._tool_key(ev)
        rec = self._open_tools.pop(key, None)
        if rec is None:
            return
        rec.ended_at = ev.ts
        err = _first(ev.payload, "error")
        # AgentScope 用 state="success" 表示成功；其他值视为异常
        state = _first(ev.payload, "state")
        if err:
            rec.status = "error"
            rec.error = str(err)[:2000]
        elif state is not None and str(state).lower() not in ("success", "ok", "completed"):
            rec.status = "error"
            rec.error = f"state={state}"
        if rec.result_preview is None:
            chunk = _first(ev.payload, *_RESULT_KEYS)
            if chunk is not None:
                text = chunk if isinstance(chunk, str) else str(chunk)
                rec.result_size = len(text.encode("utf-8"))
                rec.result_preview = text[:500]
        self._close_span(
            self._tool_spans.pop(key, None), ev.ts, result_size=rec.result_size, status=rec.status
        )
        self.tool_calls.append(rec)

    def _on_error(self, ev: UnifiedEvent) -> None:
        message = _first(ev.payload, "error", "message") or "unknown error"
        if self._open_llm is not None:
            self._open_llm.status = "error"
            self._open_llm.error = str(message)[:2000]
            self._open_llm.ended_at = ev.ts
            self.llm_calls.append(self._open_llm)
            self._open_llm = None
        self._close_span(self._open_llm_span, ev.ts, status="error")
        self._open_llm_span = None
        for rec in list(self._open_tools.values()):
            rec.status = "error"
            rec.error = str(message)[:2000]
            rec.ended_at = ev.ts
            self.tool_calls.append(rec)
        for key in list(self._tool_spans):
            self._close_span(self._tool_spans.pop(key), ev.ts, status="error")
        self._open_tools.clear()

    # ------------------------------------------------------------------ #
    def summary(self) -> dict[str, Any]:
        """聚合指标（写进 run.usage，供列表页与看板使用）。"""
        llm_ms = sum(r.duration_ms or 0 for r in self.llm_calls)
        tool_ms = sum(r.duration_ms or 0 for r in self.tool_calls)
        ttfts = [r.ttft_ms for r in self.llm_calls if r.ttft_ms is not None]
        return {
            "iterations": self.iteration,
            "llm_calls": len(self.llm_calls),
            "tool_calls": len(self.tool_calls),
            "llm_ms": llm_ms,
            "tool_ms": tool_ms,
            "ttft_ms_avg": int(sum(ttfts) / len(ttfts)) if ttfts else None,
            "ttft_ms_max": max(ttfts) if ttfts else None,
            "tokens_in": sum(r.tokens_in for r in self.llm_calls),
            "tokens_out": sum(r.tokens_out for r in self.llm_calls),
            "tokens_cache_read": sum(r.tokens_cache_read for r in self.llm_calls),
            "errors": sum(1 for r in self.llm_calls if r.status != "ok")
            + sum(1 for r in self.tool_calls if r.status != "ok"),
            # 临时错误重试了几次（0 = 一次就过）—— 用户能从记录里看出"这次跑了两遍"
            "retries": self.retries,
        }

    def flush_open(self, ts: int) -> None:
        """流异常结束（无 end 事件）时，把未闭合的记录收尾。"""
        if self._open_llm is not None:
            self._open_llm.ended_at = ts
            self._open_llm.status = "error"
            self._open_llm.error = self._open_llm.error or "事件流未正常结束"
            self.llm_calls.append(self._open_llm)
            self._open_llm = None
        for rec in list(self._open_tools.values()):
            rec.ended_at = ts
            rec.status = "error"
            rec.error = rec.error or "事件流未正常结束"
            self.tool_calls.append(rec)
        self._open_tools.clear()
        # 流异常结束：把没闭合的 span 也收口（否则瀑布图上出现"永不结束"的条）
        self._close_span(self._open_llm_span, ts, status="error")
        self._open_llm_span = None
        for key in list(self._tool_spans):
            self._close_span(self._tool_spans.pop(key), ts, status="error")
        self.finish_spans(ts)
