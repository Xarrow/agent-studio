"""多助手编排（Playground）—— 把多个 Agent 按用户选的方式串起来跑。

对外只暴露 :class:`Orchestrator` 与全局单例 :data:`orchestrator`。
"""

from .service import Orchestrator, orchestrator

__all__ = ["Orchestrator", "orchestrator"]
