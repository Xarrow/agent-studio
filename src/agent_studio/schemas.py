"""Pydantic DTO —— API 契约与 Agent 定义结构。

``AgentDefinition`` 是整个平台的中心数据结构：前端编辑它、后端存储它、
各运行时适配器解释它。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

# --------------------------------------------------------------------------- #
# Agent 定义（通用层）
# --------------------------------------------------------------------------- #
class ModelSpec(BaseModel):
    """模型配置。API Key 不在此结构中落库，只存 credential_ref。"""

    provider: str = "deepseek"
    name: str = "deepseek-v4-flash"
    params: dict[str, Any] = Field(default_factory=dict)   # temperature / max_tokens ...
    credential_ref: str | None = None                     # Secret.id
    api_key: str | None = Field(default=None, exclude=True)  # 仅创建/测试时传入
    base_url: str | None = None


class ToolRef(BaseModel):
    ref: str                       # Tool.id
    enabled: bool = True


class SkillRef(BaseModel):
    ref: str                       # Skill.id


class Limits(BaseModel):
    """执行限制。

    - ``max_iters = -1`` 表示**不限制轮数**（平台会翻译成运行时的哨兵大值，
      因为 AgentScope 原生不支持 -1）。不限制时请务必依赖 ``timeout_s`` 兜底。
    - ``timeout_s = 0`` 表示**不超时**；默认 60 秒，完全交给用户定义。
    """

    max_iters: int = Field(
        default=50,
        ge=-1,
        le=100000,
        description="最大推理-行动轮数；-1 表示不限制",
    )
    timeout_s: int = Field(
        default=60,
        ge=0,
        le=86400,
        description="单次执行超时（秒）；0 表示不超时",
    )
    max_cost_usd: float | None = Field(default=None, ge=0)


class AgentDefinition(BaseModel):
    """统一的 Agent 定义。

    ``runtime_options`` 是命名空间化的逃生舱：通用层保证跨运行时一致性，
    专有层不牺牲各框架的能力。
    """

    runtime: str = "agentscope"
    name: str
    system_prompt: str = "You are a helpful assistant."
    model: ModelSpec = Field(default_factory=ModelSpec)
    tools: list[ToolRef] = Field(default_factory=list)
    skills: list[SkillRef] = Field(default_factory=list)
    middlewares: list[dict[str, Any]] = Field(default_factory=list)
    limits: Limits = Field(default_factory=Limits)
    runtime_options: dict[str, dict[str, Any]] = Field(default_factory=dict)

    @field_validator("system_prompt")
    @classmethod
    def _prompt_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("system_prompt 不能为空")
        return v

    def options_for(self, runtime: str) -> dict[str, Any]:
        return self.runtime_options.get(runtime, {})


# --------------------------------------------------------------------------- #
# Agent CRUD DTO
# --------------------------------------------------------------------------- #
class AgentCreate(BaseModel):
    name: str
    slug: str | None = None
    description: str | None = None
    definition: AgentDefinition


class AgentUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    definition: AgentDefinition | None = None
    bump_version: bool = True       # 默认生成新版本（可回滚）


class AgentRead(BaseModel):
    id: str
    workspace_id: str
    slug: str
    name: str
    description: str | None
    runtime: str
    version: int
    parent_id: str | None
    definition: dict[str, Any]
    created_at: int
    updated_at: int


class DuplicateRequest(BaseModel):
    name: str | None = None
    slug: str | None = None


# --------------------------------------------------------------------------- #
# Tool / Skill DTO
# --------------------------------------------------------------------------- #
class ToolCreate(BaseModel):
    kind: Literal["builtin", "http", "code"] = "http"
    name: str
    description: str = ""
    input_schema: dict[str, Any] = Field(default_factory=dict)
    impl: dict[str, Any] = Field(default_factory=dict)
    flags: dict[str, Any] = Field(default_factory=dict)


class ToolRead(BaseModel):
    id: str
    kind: str
    name: str
    description: str
    input_schema: dict[str, Any]
    impl: dict[str, Any]
    flags: dict[str, Any]
    created_at: int
    updated_at: int


class ToolSpec(BaseModel):
    """**平台中立**的工具描述 —— 运行时适配器接收它，而不是 ORM 行。

    这样做的意义：

    - 适配器不依赖数据库表结构（换存储、从配置构造都不影响适配器）
    - ``kind`` 是平台层语义（内置 / HTTP / 代码），各运行时自行决定如何实现
    - 未来从 API、YAML、甚至 Skill 附件里构造工具，走的都是这一个契约
    """

    id: str = ""
    name: str
    description: str = ""
    kind: Literal["builtin", "http", "code"] = "http"
    input_schema: dict[str, Any] = Field(default_factory=dict)
    impl: dict[str, Any] = Field(default_factory=dict)
    flags: dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def from_row(cls, row: Any) -> ToolSpec:
        """从 ORM 行 / 任意 duck-typed 对象构造（唯一的耦合点，且只在上边缘）。"""
        return cls(
            id=getattr(row, "id", "") or "",
            name=row.name,
            description=getattr(row, "description", "") or "",
            kind=getattr(row, "kind", "http"),
            input_schema=getattr(row, "input_schema", None) or {},
            impl=getattr(row, "impl", None) or {},
            flags=getattr(row, "flags", None) or {},
        )


class ToolTestRequest(BaseModel):
    args: dict[str, Any] = Field(default_factory=dict)


class SkillImportRequest(BaseModel):
    source: Literal["local", "url", "git", "inline"] = "local"
    path: str | None = None            # source=local
    url: str | None = None             # source=url / git
    ref: str | None = None             # git 分支/标签
    subpath: str | None = None         # git 仓库内子目录
    content: str | None = None         # source=inline：直接给 SKILL.md
    name: str | None = None            # inline 时的名字


class SkillRead(BaseModel):
    id: str
    name: str
    description: str
    source: dict[str, Any]
    content: str
    files: dict[str, Any]
    created_at: int
    updated_at: int


# --------------------------------------------------------------------------- #
# Run DTO
# --------------------------------------------------------------------------- #
class RunCreate(BaseModel):
    agent_id: str
    input: str | dict[str, Any]
    #: 覆盖定义里的限值（试跑时常用）
    timeout_s: int | None = None
    stream: bool = True
    #: 所属会话 —— 传了就是"多轮对话的第 N 轮"，不传即单轮执行（原行为）
    session_id: str | None = None


class RunRead(BaseModel):
    id: str
    agent_id: str
    agent_version: int
    runtime: str
    status: str
    input: dict[str, Any]
    output: dict[str, Any] | None
    usage: dict[str, Any]
    error: str | None
    started_at: int
    ended_at: int | None
    pending_hitl: dict[str, Any] | None = None
    #: 会话归属（试跑面板据此把多轮串起来）
    session_id: str | None = None
    turn_index: int | None = None


class RunEventRead(BaseModel):
    seq: int
    type: str
    ts: int
    payload: dict[str, Any]


class LlmCallRead(BaseModel):
    id: int
    iteration: int
    provider: str | None
    model: str | None
    started_at: int
    ended_at: int | None
    duration_ms: int | None
    ttft_ms: int | None
    tokens_in: int
    tokens_out: int
    tokens_cache_read: int
    cost_usd: float
    status: str
    error: str | None


class ToolCallRead(BaseModel):
    id: int
    iteration: int
    tool_name: str
    args: dict[str, Any]
    call_id: str | None
    started_at: int
    ended_at: int | None
    duration_ms: int | None
    status: str
    result_size: int
    result_preview: str | None
    error: str | None


class RunTrace(BaseModel):
    """Run 的完整可观测视图（瀑布图数据源）。"""

    run: RunRead
    events: list[RunEventRead]
    llm_calls: list[LlmCallRead]
    tool_calls: list[ToolCallRead]
    metrics: dict[str, Any]


# --------------------------------------------------------------------------- #
# Run 清理 DTO（危险操作分级）
# --------------------------------------------------------------------------- #
class RunDeleteResponse(BaseModel):
    deleted: int
    skipped: list[dict[str, Any]] = Field(default_factory=list)


class RunBulkDeleteRequest(BaseModel):
    """批量删除。只允许删**终态**记录，运行中的会被跳过并说明原因。"""

    ids: list[str] = Field(default_factory=list, min_length=1)


class RunPruneRequest(BaseModel):
    """按条件清理 —— 比"清空全部"实用得多。

    ``run_event`` 是大表（一条 Run 动辄几十上百个事件），长期会把 SQLite 撑大，
    所以按时间/状态清理是常规运维动作。
    """

    before_ts: int | None = Field(
        default=None, description="只处理此时刻之前开始的 Run（毫秒时间戳）"
    )
    status: list[str] | None = Field(
        default=None, description="只处理这些状态；默认仅终态(ok/error/aborted)"
    )
    agent_id: str | None = None
    dry_run: bool = Field(default=False, description="只统计不删除")


# --------------------------------------------------------------------------- #
# Runtime DTO
# --------------------------------------------------------------------------- #
class RuntimeRead(BaseModel):
    name: str
    display_name: str
    supports_hitl: bool
    supports_thinking: bool
    supports_structured_output: bool
    supports_skills: bool
    supports_middlewares: bool
    supports_unlimited_iters: bool = False
    supports_no_timeout: bool = True
    sandboxes_tool_paths: bool = True
    option_schema: dict[str, Any]
    notes: str


class ValidateRequest(BaseModel):
    definition: AgentDefinition


class ValidateResponse(BaseModel):
    ok: bool
    issues: list[dict[str, Any]]


class HitlResumeRequest(BaseModel):
    confirm: bool = True
    reason: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


# --------------------------------------------------------------------------- #
# LLM 凭据 / Provider DTO
# --------------------------------------------------------------------------- #
class CredentialCreate(BaseModel):
    """新增一套 provider 凭据（key）。同一 provider 可存多套。"""

    name: str
    provider: str
    api_key: str = ""
    base_url: str | None = None


class CredentialUpdate(BaseModel):
    name: str | None = None
    api_key: str | None = None       # 留空表示不修改
    base_url: str | None = None


class CredentialRead(BaseModel):
    """凭据列表项 —— **永不返回明文 key**。"""

    id: str
    name: str
    provider: str
    provider_display: str
    base_url: str | None
    masked_key: str
    last_test_at: int | None = None
    last_test_ok: bool | None = None
    last_test_error: str | None = None
    created_at: int


class CredentialTestRequest(BaseModel):
    """连通性测试：可选指定模型，默认用 provider 的首个推荐模型。"""

    model: str | None = None


class CredentialTestResult(BaseModel):
    ok: bool
    provider: str
    model: str | None = None
    latency_ms: int | None = None
    models: list[str] = Field(default_factory=list)
    error: str | None = None
    checked_at: int


class ProviderRead(BaseModel):
    name: str
    display_name: str
    default_base_url: str | None
    models: list[str]
    requires_key: bool
    allows_base_url: bool
    docs_url: str | None
    note: str = ""


# --------------------------------------------------------------------------- #
# 会话 DTO（多轮对话）
# --------------------------------------------------------------------------- #
class SessionCreate(BaseModel):
    agent_id: str
    title: str | None = None


class SessionUpdate(BaseModel):
    title: str | None = None
    status: Literal["active", "archived"] | None = None


class SessionRead(BaseModel):
    id: str
    workspace_id: str
    agent_id: str
    title: str
    status: str
    summary: str | None = None
    summarized_upto: int = 0
    message_count: int = 0
    usage: dict[str, Any] = Field(default_factory=dict)
    created_at: int
    last_active_at: int
    #: 派生：会话内已完成几轮问答
    turn_count: int = 0
    #: 派生：Agent 名称（列表展示用，避免前端再查一次）
    agent_name: str | None = None


class SessionMessageRead(BaseModel):
    id: int
    turn_index: int
    role: str
    content: str
    run_id: str | None = None
    ts: int


class SessionDetail(BaseModel):
    """会话详情 —— 含完整消息历史（前端按轮次分组渲染）。"""

    session: SessionRead
    messages: list[SessionMessageRead]


class SessionClearContextRequest(BaseModel):
    """清空会话上下文（保留会话本身，丢弃历史）。"""

    keep_summary: bool = False


# --------------------------------------------------------------------------- #
# 记忆 DTO（长期记忆）
# --------------------------------------------------------------------------- #
MemoryScope = Literal["agent", "global", "session"]
MemoryKind = Literal["fact", "preference", "summary", "instruction"]
MemoryStatus = Literal["active", "candidate", "archived"]


class MemoryCreate(BaseModel):
    content: str
    #: 绑定到哪个 Agent（scope=agent 时必填；scope=global 时可为空）
    agent_id: str | None = None
    scope: MemoryScope = "agent"
    kind: MemoryKind = "fact"
    importance: float = Field(default=0.5, ge=0.0, le=1.0)
    ttl_s: int | None = None
    #: 由哪次执行沉淀而来（可追溯、可回滚）
    source_run_id: str | None = None
    #: True 时直接 active；False 时进候选态待确认（自动沉淀用）
    active: bool = True


class MemoryUpdate(BaseModel):
    content: str | None = None
    kind: MemoryKind | None = None
    importance: float | None = Field(default=None, ge=0.0, le=1.0)
    status: MemoryStatus | None = None
    scope: MemoryScope | None = None
    ttl_s: int | None = None


class MemoryRead(BaseModel):
    id: str
    agent_id: str | None = None
    agent_name: str | None = None
    scope: str
    session_id: str | None = None
    kind: str
    content: str
    source: str
    source_run_id: str | None = None
    status: str
    importance: float
    hits: int
    last_hit_at: int | None = None
    embedding_status: str
    ttl_s: int | None = None
    created_at: int
    updated_at: int


class MemoryPolicyRead(BaseModel):
    """Agent 的记忆策略（无记录时返回默认值）。"""

    agent_id: str
    auto_extract: bool = False
    recall_enabled: bool = True
    recall_top_k: int = 5
    recall_strategy: str = "hybrid"
    max_inject_chars: int = 2000
    extract_model: str | None = None
    compress_after_turns: int = 10


class MemoryPolicyUpdate(BaseModel):
    auto_extract: bool | None = None
    recall_enabled: bool | None = None
    recall_top_k: int | None = Field(default=None, ge=1, le=50)
    recall_strategy: Literal["recent", "keyword", "hybrid"] | None = None
    max_inject_chars: int | None = Field(default=None, ge=100, le=20000)
    extract_model: str | None = None
    compress_after_turns: int | None = Field(default=None, ge=0, le=200)


class MemoryBindingRequest(BaseModel):
    """设置某个 Agent 绑定的记忆集合（全量覆盖）。"""

    memory_ids: list[str] = Field(default_factory=list)


class MemoryBulkStatusRequest(BaseModel):
    """候选区批量确认 / 丢弃。"""

    ids: list[str] = Field(default_factory=list, min_length=1)
    status: MemoryStatus = "active"


class MemoryExtractRequest(BaseModel):
    """从某次执行沉淀记忆。

    - ``items`` 为空：由平台用轻量模型从该 Run 提炼候选（返回候选，不落库）
    - ``items`` 非空：按用户编辑后的内容落库（active=True 直接生效）
    """

    run_id: str
    items: list[MemoryCreate] | None = None
    #: 自动沉淀：落库但进候选态
    as_candidate: bool = False


class MemoryExtractResult(BaseModel):
    """提炼结果：候选列表 + 实际入库条数。"""

    run_id: str
    candidates: list[MemoryRead] = Field(default_factory=list)
    created: int = 0
    skipped: list[dict[str, Any]] = Field(default_factory=list)
