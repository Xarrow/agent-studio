"""运行时自动发现 —— 平台层不 hard-code 任何具体适配器。

为什么单独一层？
----------------
``registry.py`` 必须是**纯注册表**（零框架依赖）。如果让它在模块里
``from .agentscope_rt import AgentScopeRuntime``，那么平台就静态依赖了
AgentScope —— 接入 pi 就得改平台代码，违反开闭原则。

发现策略（两条路，都不需要改平台代码）：

1. **约定**：``runtimes/<name>_rt/`` 包里导出 ``AgentRuntime`` 子类
2. **扩展**：第三方包装 entry point，组名 ``agent_studio.runtimes``

于是"接入一个新框架"= 新增一个 ``xxx_rt`` 包（或装一个第三方包），
平台其余部分自动获得支持（API、UI 下拉、能力表单全部自动出现）。
"""

from __future__ import annotations

import importlib
import logging
import pkgutil
from collections.abc import Iterator

from .base import AgentRuntime
from .registry import list_runtimes, register_runtime

logger = logging.getLogger(__name__)

#: 第三方运行时注册用的 entry point 组名
ENTRY_POINT_GROUP = "agent_studio.runtimes"

_PACKAGE = "agent_studio.runtimes"


def _iter_adapter_module_names() -> Iterator[str]:
    """扫描 ``runtimes/*_rt/`` 适配器包（约定：以 ``_rt`` 结尾）。"""
    package = importlib.import_module(_PACKAGE)
    for info in pkgutil.iter_modules(package.__path__):
        if info.ispkg and info.name.endswith("_rt"):
            yield f"{_PACKAGE}.{info.name}"


def _extract_runtime(module: object) -> AgentRuntime | None:
    """从适配器模块里找出第一个可实例化的 ``AgentRuntime`` 实现。"""
    for attr in dir(module):
        obj = getattr(module, attr)
        if (
            isinstance(obj, type)
            and issubclass(obj, AgentRuntime)
            and obj is not AgentRuntime
            and not getattr(obj, "__abstractmethods__", None)
        ):
            try:
                return obj()
            except Exception as exc:  # pragma: no cover
                logger.warning("运行时 %s 实例化失败: %s", attr, exc)
    return None


def _iter_entry_point_runtimes() -> Iterator[object]:
    """第三方扩展：entry point 里可以是类，也可以是工厂函数。"""
    from importlib.metadata import entry_points

    eps = entry_points()
    group = (
        eps.select(group=ENTRY_POINT_GROUP)
        if hasattr(eps, "select")
        else eps.get(ENTRY_POINT_GROUP, [])  # type: ignore[attr-defined]
    )
    for ep in group:
        try:
            yield ep.load()
        except Exception as exc:  # pragma: no cover
            logger.warning("entry point %s 加载失败: %s", ep.name, exc)


def discover_runtimes() -> list[str]:
    """发现并注册全部运行时，返回已注册的运行时名列表。"""
    for module_name in _iter_adapter_module_names():
        try:
            module = importlib.import_module(module_name)
        except Exception as exc:
            logger.warning("适配器模块 %s 导入失败: %s", module_name, exc)
            continue
        runtime = _extract_runtime(module)
        if runtime is not None:
            register_runtime(runtime)
            logger.info("发现运行时: %s ← %s", runtime.name, module_name)

    for loaded in _iter_entry_point_runtimes():
        try:
            runtime = loaded() if callable(loaded) and not isinstance(loaded, AgentRuntime) else loaded
            if isinstance(runtime, AgentRuntime):
                register_runtime(runtime)
                logger.info("发现运行时（entry point）: %s", runtime.name)
        except Exception as exc:  # pragma: no cover
            logger.warning("entry point 运行时注册失败: %s", exc)

    return [rt.name for rt in list_runtimes()]
