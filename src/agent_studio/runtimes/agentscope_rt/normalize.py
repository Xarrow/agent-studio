"""AgentScope 事件流 → 统一事件（归一化层）。

这是"运行时无关"的关键一步：把 AgentScope 的 25 种事件映射到平台的 13 类
统一事件。未被映射的事件被跳过（但可通过 ``raw`` 回溯原始载荷）。

映射表刻意简单直白，方便对照 AgentScope 源码检查。
"""

from __future__ import annotations

from typing import Any

from ..base import UnifiedEvent

#: AgentScope 事件类名 → 统一事件类型（"_skip" 表示不产出统一事件）
EVENT_MAP: dict[str, str] = {
    # 生命周期
    "ReplyStartEvent": "run_start",
    "ReplyEndEvent": "run_end",
    "ExceedMaxItersEvent": "run_end",
    # 模型调用
    "ModelCallStartEvent": "llm_call_start",
    "ModelCallEndEvent": "llm_call_end",
    # 思考 / 文本（只取 delta，start/end 仅用于内部状态）
    "ThinkingBlockStartEvent": "_skip",
    "ThinkingBlockDeltaEvent": "thinking_delta",
    "ThinkingBlockEndEvent": "_skip",
    "TextBlockStartEvent": "_skip",
    "TextBlockDeltaEvent": "text_delta",
    "TextBlockEndEvent": "_skip",
    # 工具
    "ToolCallStartEvent": "tool_call_start",
    "ToolCallDeltaEvent": "tool_call_args",
    "ToolCallEndEvent": "_skip",
    "ToolResultStartEvent": "tool_exec_start",
    "ToolResultTextDeltaEvent": "tool_result_delta",
    "ToolResultDataDeltaEvent": "tool_result_delta",
    "ToolResultEndEvent": "tool_exec_end",
    # HITL
    "RequireUserConfirmEvent": "hitl_request",
    "RequireExternalExecutionEvent": "hitl_request",
    "UserConfirmResultEvent": "_skip",
    "ExternalExecutionResultEvent": "_skip",
    "UserInterruptEvent": "_skip",
    # 其他（结构化数据块 / 提示 / 自定义）
    "HintBlockEvent": "_skip",
    "DataBlockStartEvent": "_skip",
    "DataBlockDeltaEvent": "_skip",
    "DataBlockEndEvent": "_skip",
    "CustomEvent": "_skip",
}

#: 不该进入 payload 的通用字段（已由 UnifiedEvent 自身承载）
_STRIP_KEYS = {"id", "created_at", "metadata", "type"}


def to_ms(value: Any) -> int:
    """把 AgentScope 的 ``created_at`` 转成毫秒。

    兼容三种形态：毫秒整数 / 秒浮点 / ISO 字符串。
    """
    import datetime as _dt

    if value is None:
        return 0
    if isinstance(value, (int, float)):
        v = float(value)
        return int(v) if v > 1e11 else int(v * 1000)
    if isinstance(value, str):
        try:
            s = value.replace("Z", "+00:00")
            return int(_dt.datetime.fromisoformat(s).timestamp() * 1000)
        except Exception:
            return 0
    if isinstance(value, _dt.datetime):
        return int(value.timestamp() * 1000)
    return 0


def normalize_event(ev: Any, run_id: str = "", seq: int = 0) -> UnifiedEvent | None:
    """单个 AgentScope 事件 → 统一事件（未映射则返回 None）。"""
    etype = EVENT_MAP.get(type(ev).__name__)
    if etype is None or etype == "_skip":
        return None

    raw = ev.model_dump(mode="json")
    payload = {k: v for k, v in raw.items() if k not in _STRIP_KEYS}

    return UnifiedEvent(
        run_id=run_id,
        seq=seq,
        type=etype,  # type: ignore[arg-type]
        ts=to_ms(raw.get("created_at")),
        payload=payload,
        raw=raw,
    )


def is_final_message(ev: Any) -> bool:
    """``reply_stream(yield_final_msg=True)`` 会在末尾多 yield 一个 Msg。

    这不是事件，而是最终回复，应作为 run.output 而不是 run_event。
    """
    return type(ev).__name__ == "Msg"
