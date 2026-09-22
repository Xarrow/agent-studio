"""Runtime 抽象层 —— 平台的架构底座。

设计目标
--------
让 AgentScope / pi / 未来的自研运行时都能接入，而平台侧只认识两样东西：

1. ``AgentDefinition``（统一的 Agent 定义，纯数据）
2. ``UnifiedEvent``（统一的事件流）

各运行时负责把自身的 API 与事件"翻译"到这两个契约上。平台其余部分
（存储、API、UI）完全不感知具体框架。

耗时计算原则
------------
不额外埋点。所有耗时来自事件配对：

- LLM 调用耗时 = ``llm_call_end.ts - llm_call_start.ts``
- TTFT         = 第一个 ``thinking_delta``/``text_delta``.ts - ``llm_call_start.ts``
- 工具耗时     = ``tool_exec_end.ts - tool_exec_start.ts``

配对键用 ``seq``（单调递增）而不是时间戳 —— 并发工具调用时时间戳会交叉。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from typing import Any, Literal

from pydantic import BaseModel, Field

# --------------------------------------------------------------------------- #
# 统一事件
# --------------------------------------------------------------------------- #
EventType = Literal[
    "run_start",
    "llm_call_start",
    "thinking_delta",
    "text_delta",
    "llm_call_end",
    "tool_call_start",
    "tool_call_args",
    "tool_exec_start",
    "tool_result_delta",
    "tool_exec_end",
    "hitl_request",
    "error",
    "run_end",
]

TERMINAL_EVENTS: frozenset[str] = frozenset({"run_end", "error"})


class UnifiedEvent(BaseModel):
    """统一事件 —— UI 与落库的唯一输入。"""

    run_id: str = ""
    seq: int = 0
    type: EventType
    ts: int                                    # 事件发生时间（毫秒）
    payload: dict[str, Any] = Field(default_factory=dict)
    raw: dict[str, Any] | None = None          # 原始事件，调试与向后兼容用

    def with_seq(self, seq: int) -> UnifiedEvent:
        """由 runner 统一分配 seq，保证跨运行时一致。"""
        return self.model_copy(update={"seq": seq})


# --------------------------------------------------------------------------- #
# 运行时能力声明（驱动前端表单动态渲染）
# --------------------------------------------------------------------------- #
class RuntimeCapabilities(BaseModel):
    name: str
    display_name: str
    supports_hitl: bool = False
    supports_thinking: bool = False
    supports_structured_output: bool = False
    supports_skills: bool = False
    supports_middlewares: bool = False
    #: 是否支持"不限制轮数"（平台语义 max_iters=-1）。
    #: 由于底层框架未必原生支持，适配器可自行翻译（例如转成哨兵大值）。
    supports_unlimited_iters: bool = False
    #: 是否支持"不超时"（平台语义 timeout_s=0）
    supports_no_timeout: bool = True
    #: 是否支持多轮会话（能消费 TurnContext.history 里的历史消息）
    supports_multi_turn: bool = False
    #: 是否支持长期记忆注入（通常把记忆拼进 System Prompt 即可）
    supports_memory: bool = True
    #: 工具路径是否被限制在工作目录内（只读试运行的安全前提）
    sandboxes_tool_paths: bool = True
    option_schema: dict[str, Any] = Field(default_factory=dict)
    notes: str = ""


class Issue(BaseModel):
    """校验问题。level=error 阻止保存/运行。"""

    level: Literal["error", "warning"] = "error"
    field: str | None = None
    message: str


# --------------------------------------------------------------------------- #
# 编译产物
# --------------------------------------------------------------------------- #
class CompiledAgent(ABC):
    """运行时编译产物：持有该运行时特有的资源（实例 / 子进程 / 连接）。

    生命周期：``compile()`` → ``run()*`` → ``dispose()``
    """

    agent_id: str = ""
    runtime: str = ""
    #: 物化后的工作目录（Skill / 工具的落地点）
    work_dir: str | None = None

    @abstractmethod
    async def dispose(self) -> None:
        """释放资源。必须幂等。"""


class HitlResponse(BaseModel):
    """HITL（人工确认）回复。"""

    confirm: bool = True
    reason: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


# --------------------------------------------------------------------------- #
# 上下文注入（多轮会话 + 长期记忆的统一注入点）
#
# 这是平台与运行时之间的**第二个契约**（第一个是 UnifiedEvent）：
# 平台负责"算出该给这次执行什么上下文"，运行时只负责"把它放到该放的位置"。
#
# 关键约束：这个 DTO 里**只有纯数据**，不含任何框架对象 ——
# 因此换运行时（pi / 自研）时，上下文能力零改动复用。
# --------------------------------------------------------------------------- #
class TurnMessage(BaseModel):
    """一轮对话里的一条消息。"""

    role: Literal["user", "assistant", "system"] = "user"
    content: str = ""


class TurnContext(BaseModel):
    """一次执行要注入的上下文。"""

    #: 所属会话（None = 单轮执行，无上下文）
    session_id: str | None = None
    #: 会话内第几轮（从 1 开始；0 表示尚未计数）
    turn_index: int = 0

    #: 短期记忆：本会话此前的对话（已按预算裁剪）
    history: list[TurnMessage] = Field(default_factory=list)
    #: 更早轮次的压缩摘要（history 被裁剪时用它补位）
    summary: str | None = None

    #: 长期记忆：平台召回的条目（已渲染成可注入文本）
    memory_text: str | None = None
    #: 被注入的记忆 id —— 执行后据此累计 hits（热度衰减用）
    memory_ids: list[str] = Field(default_factory=list)

    def is_empty(self) -> bool:
        return not (self.history or self.summary or self.memory_text)


# --------------------------------------------------------------------------- #
# 运行时接口
# --------------------------------------------------------------------------- #
class AgentRuntime(ABC):
    """所有运行时适配器的基类。

    实现者只需实现这 6 个方法；平台其余部分（存储/API/UI）自动获得支持。
    """

    #: 运行时标识，需与 ``AgentDefinition.runtime`` 一致
    name: str = ""

    @abstractmethod
    def capabilities(self) -> RuntimeCapabilities:
        """声明能力：前端据此决定渲染哪些配置项。"""

    @abstractmethod
    async def validate(self, definition: Any) -> list[Issue]:
        """静态校验：模型/工具/参数合法性。不产生副作用。"""

    @abstractmethod
    async def compile(self, definition: Any, **ctx: Any) -> CompiledAgent:
        """定义 → 可执行产物。

        ``ctx`` 由 runner 注入运行时上下文：``api_key`` / ``tools``
        （``list[ToolSpec]``，平台中立描述）/ ``work_dir`` 等，实现方按需取用。

        约定：**ctx 里只允许出现平台 DTO**（如 ToolSpec），不得传 ORM 行 ——
        否则适配器会隐式依赖存储结构，抽象就漏了。
        """

    @abstractmethod
    def run(self, agent: CompiledAgent, run_input: Any) -> AsyncIterator[UnifiedEvent]:
        """执行并产出统一事件流。"""

    async def resume(self, agent: CompiledAgent, hitl: HitlResponse) -> AsyncIterator[UnifiedEvent]:
        """HITL 恢复。不支持时抛 ``NotImplementedError``。"""
        raise NotImplementedError(f"{self.name} 不支持 HITL 恢复")
        yield  # pragma: no cover  —— 让它是 async generator

    async def discover_tools(self) -> list[dict[str, Any]]:
        """该运行时可用哪些内置工具（供 UI 展示）。"""
        return []

    async def dispose(self, agent: CompiledAgent) -> None:
        """释放编译产物（默认委托给产物自身）。"""
        if agent is not None:
            await agent.dispose()
