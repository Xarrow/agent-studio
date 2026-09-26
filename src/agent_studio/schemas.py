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

    @field_validator("provider")
    @classmethod
    def _canon_provider(cls, v: str) -> str:
        """收敛 provider 写法：中文显示名 / 别称 / 大小写 → 规范 slug。

        用户界面上看到的是显示名（"火山引擎（豆包）"），提交上来若原样落库，
        运行时会报 "不支持的 provider" ✗ —— 用户照着界面填的却报错，是我们界面的问题。
        在这里统一收敛，所有入口（Agent 定义 / 凭据 / 测试运行）一次性生效。
        """
        from agent_studio.providers import canonical_provider

        return canonical_provider(v)
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
    #: 这个助手在流程里的**分类**：
    #:   worker（默认）= 干活的，按收到的任务做完就交出去
    #:   orchestrator  = **编排者**：分析任务 → 管理上下文 → 验证结果 → 归纳总结
    #:     适合放在流程的**首节点**（先把目标拆清楚再交下去）或**末节点**（收齐结果做验证与归纳）。
    role: str = "worker"
    #: **编排者的职责定义**（只在 role=orchestrator 时生效）。
    #: 留空 = 用平台内置的那份（分析任务 → 管理上下文 → 验证结果 → 归纳总结）；
    #: 想改口径就在这里覆盖 —— 用户："Orchestrator Agent 为什么没有定义？"
    #: → 定义必须**看得见、改得动**，不能只藏在运行时的注入里。
    orchestrator_brief: str = ""
    system_prompt: str = "You are a helpful assistant."
    model: ModelSpec = Field(default_factory=ModelSpec)
    tools: list[ToolRef] = Field(default_factory=list)
    skills: list[SkillRef] = Field(default_factory=list)
    middlewares: list[dict[str, Any]] = Field(default_factory=list)
    limits: Limits = Field(default_factory=Limits)
    runtime_options: dict[str, dict[str, Any]] = Field(default_factory=dict)
    #: 挂哪几个 MCP 服务器（存的是 McpServer 的 id）。工具清单由**探测**得到，
    #: 这里只记"用哪几台"，改服务器不用动助手。
    mcp_servers: list[str] = Field(default_factory=list)
    #: 这个助手自己的工作目录（平台沙箱内的**子目录名**；空 = 用平台那个共用的）。
    #: 它同时是**权限的边界**：权限 scope 里"工作目录内直接放行"指的就是这里，
    #: 越出这个目录的操作才需要人工确认。只允许名字，不允许绝对路径 / ``..``
    #: —— 后端 resolve_work_dir 会强制校验，非法就记 warning 并回退平台默认。
    workspace: str = ""

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


class ToolUpdate(BaseModel):
    """编辑工具：**只有显式传了的字段才会改**。

    刻意不含 ``kind`` —— 工具的类别（内置/HTTP/代码）是它的身份，
    改类别应该新建一个工具。而且 PUT 用全量替换的 ToolCreate 时，
    漏传 kind 会默认成 "http"，把内置工具静默降级。
    """

    name: str | None = None
    description: str | None = None
    input_schema: dict[str, Any] | None = None
    impl: dict[str, Any] | None = None
    flags: dict[str, Any] | None = None


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
    #: fork = 平台原生工具（执行体是平台自己的函数，不依赖任何运行时的内置清单）
    kind: Literal["builtin", "http", "code", "fork"] = "http"
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
    #: 发起来源：chat（对话页）/ preview（助手页试跑）/ playground（编排）。
    #: 只影响「运行记录」怎么分类展示，不影响执行逻辑。
    origin: str | None = None


class ModelTestRead(BaseModel):
    """一次「LLM 对话测试」的记录（LLM 配置页里点「对话测试」产生的）。"""

    id: str
    credential_id: str | None = None
    credential_name: str = ""
    provider: str = ""
    base_url: str | None = None
    model: str = ""
    messages: list[dict[str, Any]] = Field(default_factory=list)
    reply: str | None = None
    status: str = "ok"
    error: str | None = None
    started_at: int
    duration_ms: int | None = None
    tokens_in: int = 0
    tokens_out: int = 0


class FanoutItemRead(BaseModel):
    """分派出去的**一路**（在"运行记录"里收在容器那一行下面）。"""

    #: 这一路的执行 id —— 「重跑」按它精确重跑那一路
    run_id: str = ""
    index: int = 0
    label: str = ""
    status: str = "ok"
    duration_ms: int | None = None
    tokens_in: int = 0
    tokens_out: int = 0


class FanoutRead(BaseModel):
    """一步分派的汇总（记录页据此显示「分派 5 路 · 4 成功 1 失败 · 合计 6.3k token」）。

    为什么要收在容器行里：分派会让"一次执行"变成 N+1 条记录，平铺出来记录页会被
    同一件事刷屏（用户翻不完，也看不出"这几条其实是一批"）。所以记录页一条 = 一件事，
    展开才看每一路 —— 与画布上的叠卡是同一套语义。
    """

    total: int = 0
    ok: int = 0
    failed: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    items: list[FanoutItemRead] = Field(default_factory=list)


class ActivityItem(BaseModel):
    """「运行记录」里的一条 —— 把三类调用统一成同一个形状。

    为什么要统一
    -----------
    用户关心的是"我发起过哪些调用、结果如何"，而不是"它存在哪张表"。
    助手执行和裸模型调用在**存储**上分开（语义不同，见 models.ModelTest），
    但在**展示**上必须是一条连续的时间线，否则用户又要去两个地方看。

    kind 取值：
      chat       对话页的一轮
      preview    助手详情页「试跑与观测」的一次
      playground 多 Agent 编排里的一步/一次
      llm_test   LLM 配置页的「对话测试」
    """

    kind: Literal["chat", "preview", "playground", "llm_test"]
    id: str
    at: int                                  # 开始时间（毫秒）
    # 编排执行才有：点这一行可以「以流程查看」—— 前端据此深链到 Playground 的历史回放
    orchestration_id: str | None = None
    duration_ms: int | None = None
    status: str = "ok"
    #: 主体显示名：助手执行 → 助手名；LLM 测试 → "provider · model"
    title: str = ""
    subtitle: str | None = None
    agent_id: str | None = None
    credential_id: str | None = None
    model: str | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    #: 这一步分派出去的多路（有它就说明这一条是"分派容器"）；见 FanoutRead
    fanout: FanoutRead | None = None
    #: 这次调用折算的金额；``None`` = 这个模型**还没填单价**（界面显示「—」，
    #: 不能显示 0 —— "免费"和"不知道"是两件事）
    cost: float | None = None
    currency: str = "¥"
    #: 自动运行才有：``schedule``（定时） / ``webhook``（外部调用）——
    #: 界面据此给这条记录打上「定时」/「外部」小标，一眼分出哪些不是我点的
    trigger: str | None = None
    #: 一句话摘要（输入的前几十字），列表里就能看出"这条是什么"
    summary: str | None = None
    error: str | None = None


class ActivityList(BaseModel):
    items: list[ActivityItem] = Field(default_factory=list)
    #: 各类型的总数（用于筛选栏上的计数徽标，不用额外请求）
    counts: dict[str, int] = Field(default_factory=dict)
    #: 还有没有更早的记录（游标分页：界面据此显示「加载更多」）
    has_more: bool = False
    #: 当前筛选条件下的总条数（界面用它说"还有 N 条"，而不是让用户自己数）
    total: int = 0


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
    origin: str | None = None
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


class SpanRead(BaseModel):
    """一段耗时（瀑布图的一条）。

    ``kind``：run（整次执行）→ iteration（第几轮）→ llm / tool。
    层级靠 ``parent_id`` 表达，前端据此缩进；时间用绝对毫秒，横条按真实时间轴摆放。
    """

    id: str
    parent_id: str | None = None
    kind: str
    name: str = ""
    started_at: int
    ended_at: int | None = None
    duration_ms: int | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)


class RunTrace(BaseModel):
    """Run 的完整可观测视图（瀑布图数据源）。"""

    run: RunRead
    #: 助手名 —— 弹框从任意入口打开都要能显示"这是谁跑的"，
    #: 而 RunRead 里只有 agent_id，所以在这里带上名字，省得前端再查一次
    agent_name: str | None = None
    events: list[RunEventRead]
    llm_calls: list[LlmCallRead]
    tool_calls: list[ToolCallRead]
    #: 耗时瀑布（run → iteration → llm/tool）。老记录没有这一段，所以默认为空
    spans: list[SpanRead] = Field(default_factory=list)
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
    """恢复一次待确认的调用。

    ``payload`` 允许为 null：界面上万一没拿到明细（例如历史遗留记录），
    也不该让整个恢复请求 422 —— 服务端本来就有这份 payload，
    客户端传不传只是"能不能对上"，不是"必须由客户端提供"。
    """

    confirm: bool = True
    reason: str | None = None
    payload: dict[str, Any] | None = None


# --------------------------------------------------------------------------- #
# LLM 凭据 / Provider DTO
# --------------------------------------------------------------------------- #
class CredentialCreate(BaseModel):
    """新增一套 provider 凭据（key）。同一 provider 可存多套。"""

    name: str
    provider: str
    api_key: str = ""
    base_url: str | None = None
    # 新增时就能指定默认模型（有些服务商没有 /models 清单，只能手填 ✓）
    default_model: str | None = None


class CredentialUpdate(BaseModel):
    """编辑已有凭据。**只有显式传了的字段才会改**（None = 不动）。"""

    name: str | None = None
    provider: str | None = None      # 允许改（选错了可以纠正）
    api_key: str | None = None       # 留空表示不修改
    base_url: str | None = None
    #: 选定的默认模型：可来自探测清单，也可手填；空字符串 = 清空
    default_model: str | None = None


class CredentialRead(BaseModel):
    """凭据列表项 —— **永不返回明文 key**。"""

    id: str
    name: str
    provider: str
    provider_display: str
    base_url: str | None
    masked_key: str
    default_model: str | None = None
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


class CredentialChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class CredentialChatRequest(BaseModel):
    """在「LLM 配置」里直接试聊一段 —— 不经过任何 Agent。"""

    #: 留空 = 用该凭据配置的默认模型
    model: str | None = None
    messages: list[CredentialChatMessage] = Field(default_factory=list)


class CredentialChatResult(BaseModel):
    ok: bool
    model: str | None = None
    reply: str | None = None
    latency_ms: int | None = None
    usage: dict[str, Any] | None = None
    error: str | None = None


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
    #: 改归属。传 NULL 表示"不修改"，传 "" 表示改成全局（不绑任何 Agent）
    agent_id: str | None = None


class MemoryDuplicateRequest(BaseModel):
    """复制一条记忆并绑定到别处。

    平台刻意保持「一条记忆只属于一个 Agent」（共享用复制解决，而不是多对多）——
    这样一方改动不会牵动另一方，责任边界清楚，召回过滤也简单。
    """

    #: 副本绑定到哪个 Agent；None = 复制成全局记忆
    agent_id: str | None = None
    scope: MemoryScope = "agent"
    #: 可选：顺带改一下副本内容（默认与原件一致）
    content: str | None = None


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

# --------------------------------------------------------------------------- #
# 编排（Playground）—— 多助手协作
# --------------------------------------------------------------------------- #
class OrchestrationStep(BaseModel):
    """编排里的一个槽位。"""

    agent_id: str
    #: **串行模式下才有意义**：这一步要不要接收上一步的产出。
    #: 由用户在编排界面上逐个勾选；第一步会被忽略。
    carry_prev: bool = False
    #: 画布节点 id（界面按它精确回贴执行状态；直接调编排接口时可以不带）
    nid: str | None = None
    #: 这一跳最多等多久（秒）：不填=平台默认，-1=不限
    wait_timeout_s: int | None = None
    #: **分派多路**：`"list"` = 把上游产出的清单每项交给这个助手的一个实例并行处理
    fanout: str | None = None
    #: 最多几路（默认 5，内核硬上限 20）
    fanout_max: int | None = None
    #: 这一步最多花多少 token（0/不填 = 不限）
    fanout_budget: int | None = None
    #: 分派出去的那几路用什么工作目录：``share``（默认，同一个）/ ``isolate``（每路一个独立目录）
    fanout_workspace: str | None = None
    #: 派给谁：空 = 本槽位的助手；填 agent_id = 分派给那个助手干活
    fanout_agent: str | None = None


class OrchestrationCreate(BaseModel):
    """发起一次编排。"""

    #: single | serial | parallel | master_worker
    mode: str = "single"
    #: 主从模式下，干活的之间怎么跑：parallel（默认）| serial
    worker_mode: str | None = None
    #: 主从模式的主控
    master_agent_id: str | None = None
    #: 参与的助手（按槽位顺序）；主从模式下这里只放干活的
    steps: list[OrchestrationStep]
    #: 任务描述
    task: str
    #: 显示名（可空，服务端按模式自动起一个）
    name: str | None = None


class OrchestrationStepRead(BaseModel):
    """编排下的一个子步骤（就是一条 Run 的摘要）。"""

    run_id: str
    agent_id: str
    agent_name: str
    role: str | None
    order_index: int | None
    #: 画布节点 id —— 前端按它**精确**把这一步贴回节点（不再按 agent_id 猜）
    node_id: str | None = None
    #: 分派维度：第几路 + 那一路的名字 + 父执行（不是分派出来的就是 NULL）
    item_index: int | None = None
    item_label: str | None = None
    parent_run_id: str | None = None
    status: str
    usage: dict[str, Any] = {}
    error: str | None = None
    started_at: int
    ended_at: int | None = None
    #: 这个助手**领到的任务**（串行/主从模式下会和原任务不同：可能带了上一步的
    #: 产出，也可能是主控拆出来的子任务）。前端用它显示"它在做什么"。
    input_text: str = ""
    #: 它的产出（方便在不展开完整日志时也能一眼看到这一步的结论）
    output_text: str = ""


class OrchestrationRead(BaseModel):
    """编排摘要（列表用）。"""

    id: str
    name: str
    mode: str
    worker_mode: str | None
    status: str
    input: dict[str, Any]
    output: dict[str, Any] | None
    usage: dict[str, Any]
    error: str | None
    started_at: int
    ended_at: int | None
    #: 参与者数量（列表页展示"3 个助手"）
    step_count: int = 0


class OrchestrationDetail(OrchestrationRead):
    """编排详情（含每个子步骤）。"""

    spec: dict[str, Any]
    steps: list[OrchestrationStepRead] = []


# --------------------------------------------------------------------------- #
# 编排设计稿（Workflow）—— Playground 画布上保存下来的那张图
# --------------------------------------------------------------------------- #
class WorkflowNode(BaseModel):
    """画布上的一个节点：一个助手 + 它在画布上的位置。

    位置（x/y）**可选**：不填 = 由前端按拓扑自动排版（"一键整理"就是把它们清空）；
    用户拖过某个节点，它就会带上坐标存进来 —— 这样"我摆的位置"能跨会话保留。
    """

    nid: str
    agent_id: str
    x: float | None = None
    y: float | None = None
    #: 卡片宽度（画布上拖右边缘调过才有值）—— 和 x/y 一样属于"用户摆的版面"，
    #: 存进图里就能跨会话保留；不填 = 用前端的默认宽。
    w: float | None = None
    #: 卡片高度（拖右下角调过才有值）；不填 = 由内容决定（更自然，不会留一大片空）
    h: float | None = None

    #: **这一跳最多等多久**（秒）=「等上游跑完」的上限：
    #: 不填 = 平台默认 900s；-1 = 不限（一直等）；正数 = 到点就放弃这一步。
    #: 为什么放节点上：编排者"等其他人跑完再验证总结"时，等待上限属于**那个等待的人**；
    #: 上游自己跑太久则由上游节点的值兜住，两边都设得住，才不会出现"卡住不动"的流程。
    wait_timeout_s: int | None = None

    #: **分派多路**：`"list"` = 把**上游产出的清单**里每一项，交给这个助手的一个实例
    #: 并行处理（每项一条独立执行）。不填 = 不分派（原来的单实例行为）。
    #: ⚠️ 这三个字段必须在这里声明 —— pydantic 默认丢弃未声明的字段，
    #: 少了它前端配了也会在图里"消失"（wait_timeout_s 当年就是这么坑的）。
    fanout: str | None = None
    #: 最多几路（2/3/5/10/20，默认 5）；内核另有硬上限兜底（MAX_ITEMS_HARD=20）
    fanout_max: int | None = None
    #: 分派给**别的助手**（不填 = 本节点这个助手；P1 用，先留字段）
    fanout_agent: str | None = None
    #: 分派这一步最多花多少 token（0/不填 = 不限）。超了就停下，剩下的标「超出预算未跑」——
    #: 不做跑前预估（估出来的数是编的），只按**真花掉的**掐。
    fanout_budget: int | None = None
    #: 分派出去的那几路用什么工作目录：``share``（默认，同一个）/ ``isolate``（每路一个独立目录）
    fanout_workspace: str | None = None


class WorkflowEdge(BaseModel):
    """一条连线 —— 两个助手之间怎么配合。

    **两个维度，正交，可任意组合**（原来做成"四选一"是建模错误：
    并行的时候一样可以共享记忆/上下文，串行也可以）：

    ① ``order`` 时序二选一
       - ``serial``   串行接力：等它跑完，把结论交给下一个（默认）
       - ``parallel`` 并行：同时开始；这条线**不构成依赖**

    ② 共享开关（各自独立）
       - ``share_context`` 共享上下文：产出进同一个上下文池，组内谁先跑完都互相看得见
       - ``share_memory``  共享记忆：产出沉淀成记忆，而且**双方**都能想起来
    """

    from_: str = Field(alias="from")
    to: str
    order: str = "serial"
    share_context: bool = False
    share_memory: bool = False
    #: 旧字段（单一枚举）。保留只为老数据能读进来，会被映射到上面三项。
    rel: str | None = None

    model_config = {"populate_by_name": True}


class CardBox(BaseModel):
    """画布两端卡片（输入卡 / 输出卡）的版面。

    为什么和节点分开：节点（助手）是"流程的一部分"，而两端的卡是"画布的框"——
    但它们同属"用户摆的版面"，所以和节点一样存进图里，跨会话保留。
    不填 = 按拓扑自动排版（用户没动过就一直是自动的）。
    """

    x: float | None = None
    y: float | None = None
    w: float | None = None
    h: float | None = None


class WorkflowGraph(BaseModel):
    """整张图。前后端只有这一个格式。"""

    nodes: list[WorkflowNode] = Field(default_factory=list)
    edges: list[WorkflowEdge] = Field(default_factory=list)
    #: 主从里的"主"；不填 = 按连线自动判断
    master_nid: str | None = None
    #: 输入卡（发令区）的位置/宽度；用户拖过或调过才有值
    input_card: CardBox | None = None
    #: 输出卡（结论）的位置/宽度；同上
    output_card: CardBox | None = None


class ImportRequest(BaseModel):
    """导入一个导出包。

    ``bundle`` 就是 ``GET /api/export`` 的原样输出（直接贴进来即可）。
    刻意用**宽松的 dict** 而不是严格模型：导出包会跨版本（新版本多字段、老版本少字段），
    严格校验的结果是"老包永远导不进来" —— 导入侧自己做兼容更划算。
    """

    bundle: dict[str, Any] = Field(default_factory=dict)


class ImportResult(BaseModel):
    """导入结果 —— 关键是"如实"：对不上的工具/Skill/节点都列出来，不静默丢。"""

    ok: bool = True
    detail: str = ""
    agents: list[dict[str, Any]] = Field(default_factory=list)
    workflows: list[dict[str, Any]] = Field(default_factory=list)
    memories: int = 0
    prices: int = 0
    #: 包里提到、本机没有的工具（名字）—— 用户据此去「工具」页补
    missing_tools: list[str] = Field(default_factory=list)
    missing_skills: list[str] = Field(default_factory=list)
    #: 流程里找不到对应助手的节点（保留原 id，流程能用但要人工修）
    unfixed_nodes: list[str] = Field(default_factory=list)


class AutoRunIn(BaseModel):
    """自动运行的设置（整份提交 —— 界面上就是一个对话框）。

    ``mode`` 用**枚举**而不是 cron：用户该选、不该填（cron 是"第二个术语"，
    写错了还看不出来）。留空 = 不定时。
    """

    mode: str = ""
    at: str = "09:00"
    weekdays: str = ""
    default_task: str = ""


class WorkflowCreate(BaseModel):
    name: str = "未命名编排"
    description: str = ""
    graph: WorkflowGraph = Field(default_factory=WorkflowGraph)
    #: 执行方式覆盖（NULL = 自动判断）
    mode_override: str | None = None


class WorkflowUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    graph: WorkflowGraph | None = None
    #: 用哨兵区分"不改"和"改成自动"：传 "" 表示清除覆盖
    mode_override: str | None = None


class WorkflowRead(BaseModel):
    id: str
    name: str
    description: str = ""
    graph: WorkflowGraph
    #: 用户覆盖（None = 自动）
    mode_override: str | None = None
    #: **服务端推导出来的**执行方式 + 人话说明 —— 界面直接显示，不自己算
    derived_mode: str = "single"
    derived_hint: str = ""
    #: 真正会用的那个（覆盖优先）
    effective_mode: str = "single"
    node_count: int = 0
    edge_count: int = 0
    updated_at: int = 0
    created_at: int = 0
    #: 用这份设计稿跑过多少次
    run_count: int = 0


class WorkflowRunRequest(BaseModel):
    """用这份设计稿跑一次。"""

    task: str
    #: 覆盖超时（不填用助手自己的）
    timeout_s: int | None = None


# ─────────────────────────────────────────────────────────────────────────────
# MCP（工具协议）—— 服务器注册表
# ─────────────────────────────────────────────────────────────────────────────
class McpServerBase(BaseModel):
    name: str = ""
    #: "stdio"（本地起进程）| "http"（远端 streamable-http / sse）
    transport: Literal["stdio", "http"] = "stdio"
    command: str = ""
    args: list[str] = Field(default_factory=list)
    url: str = ""
    env: dict[str, str] = Field(default_factory=dict)
    headers: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True


class McpServerCreate(McpServerBase):
    pass


class McpServerUpdate(BaseModel):
    """改名/改连接/启用停用都走它；字段缺省 = 不改。"""

    name: str | None = None
    transport: Literal["stdio", "http"] | None = None
    command: str | None = None
    args: list[str] | None = None
    url: str | None = None
    env: dict[str, str] | None = None
    headers: dict[str, str] | None = None
    enabled: bool | None = None


class McpToolInfo(BaseModel):
    """探测到的工具。名字和说明**都来自服务器**，不让人手填（手填一定漂移）。"""

    name: str
    description: str = ""


class McpServerRead(McpServerBase):
    id: str
    tools: list[McpToolInfo] = Field(default_factory=list)
    last_probe_ok: bool = False
    last_probe_at: int = 0
    last_probe_error: str = ""
    created_at: int = 0
    updated_at: int = 0


class McpProbeResult(BaseModel):
    ok: bool
    tools: list[McpToolInfo] = Field(default_factory=list)
    error: str = ""
