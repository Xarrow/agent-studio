"""运行时抽象层。"""

from .base import (
    TERMINAL_EVENTS,
    AgentRuntime,
    CompiledAgent,
    EventType,
    HitlResponse,
    Issue,
    RuntimeCapabilities,
    UnifiedEvent,
)
from .discovery import ENTRY_POINT_GROUP, discover_runtimes
from .registry import (
    get_runtime,
    get_runtime_or_none,
    list_runtimes,
    register_runtime,
)

__all__ = [
    "TERMINAL_EVENTS",
    "AgentRuntime",
    "CompiledAgent",
    "EventType",
    "HitlResponse",
    "Issue",
    "RuntimeCapabilities",
    "UnifiedEvent",
    "get_runtime",
    "get_runtime_or_none",
    "list_runtimes",
    "discover_runtimes",
    "ENTRY_POINT_GROUP",
    "register_runtime",
]
