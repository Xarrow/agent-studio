"""运行时注册表 —— **纯注册表**，不 import 任何具体适配器。

这是"平台层零框架依赖"的关键：注册表只认识 ``AgentRuntime`` 抽象，
具体适配器由 ``discovery.discover_runtimes()`` 自动发现（约定 + entry points）。

因此接入一个新框架时，**平台代码一行都不用改**。
"""

from __future__ import annotations

from .base import AgentRuntime

_RUNTIMES: dict[str, AgentRuntime] = {}
_DISCOVERED = False


def register_runtime(runtime: AgentRuntime) -> AgentRuntime:
    """注册运行时（同名覆盖，便于测试注入）。"""
    if not runtime.name:
        raise ValueError("运行时必须有 name")
    _RUNTIMES[runtime.name] = runtime
    return runtime


def _ensure_discovered() -> None:
    """惰性触发自动发现。

    放在函数内 import 是为了避免 ``registry ↔ discovery`` 循环依赖，
    同时保证 import 期不加载任何框架（agentscope 没装也能起服务）。
    """
    global _DISCOVERED
    if _DISCOVERED:
        return
    _DISCOVERED = True
    try:
        from .discovery import discover_runtimes

        discover_runtimes()
    except Exception:  # pragma: no cover - 发现失败不应导致服务起不来
        import logging

        logging.getLogger(__name__).warning("运行时自动发现失败", exc_info=True)


def get_runtime(name: str) -> AgentRuntime:
    _ensure_discovered()
    if name not in _RUNTIMES:
        raise KeyError(f"未知运行时: {name}（可用: {sorted(_RUNTIMES)}）")
    return _RUNTIMES[name]


def get_runtime_or_none(name: str) -> AgentRuntime | None:
    _ensure_discovered()
    return _RUNTIMES.get(name)


def list_runtimes() -> list[AgentRuntime]:
    _ensure_discovered()
    return list(_RUNTIMES.values())


def _reset_for_tests() -> None:
    """清空注册表（测试隔离用）。"""
    global _DISCOVERED
    _RUNTIMES.clear()
    _DISCOVERED = False
