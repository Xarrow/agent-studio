"""当前执行的上下文 —— 给工具用（模型不需要知道 run_id，工具需要）。

为什么必须走 contextvar
----------------------
``fork`` 工具是运行时按 FunctionTool 调用的**普通函数**，它拿不到"我在哪次执行的哪个节点上"。
而这些信息只在执行协程里知道（run_id / agent_id / node_id / 深度）。
contextvar 按 asyncio task 隔离，天然正确 —— 与 orchestrator 里 origin 那处的做法一致，
而且比"把 run_id 拼进工具参数"更安全（模型改不了、也不可能填错）。
"""

from __future__ import annotations

from contextvars import ContextVar
from typing import Any

_CTX: ContextVar[dict[str, Any]] = ContextVar("agent_studio_run_ctx", default={})


def set_run_ctx(**kw: Any) -> None:
    """执行开始时设一次（同一个 task 内可见；不同 run 是不同 task，互不串）。"""
    _CTX.set(dict(kw))


def current_run_ctx() -> dict[str, Any]:
    return dict(_CTX.get())


def clear_run_ctx() -> None:
    _CTX.set({})
