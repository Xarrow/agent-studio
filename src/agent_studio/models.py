"""ORM 模型 —— Agent Studio 的领域模型。

设计要点：
- 时间戳统一用 **毫秒整数**（``*_ms``），便于跨进程（pi 子进程）对齐与聚合查询
- 定义类字段用 ``JSON`` 存快照（agent.definition / run.definition_snapshot），保证可复现
- ``llm_call`` / ``tool_call`` 是可观测性的数据底座，从第一天就建
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from sqlalchemy import JSON, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex[:16]}"


# --------------------------------------------------------------------------- #
# 工作区
# --------------------------------------------------------------------------- #
class Workspace(Base):
    __tablename__ = "workspace"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("ws_"))
    name: Mapped[str] = mapped_column(String(128))
    created_at: Mapped[int] = mapped_column(Integer, default=now_ms)


# --------------------------------------------------------------------------- #
# Agent 定义（version 递增实现版本化）
# --------------------------------------------------------------------------- #
class Agent(Base):
    __tablename__ = "agent"
    __table_args__ = (UniqueConstraint("workspace_id", "slug", "version", name="uq_agent_slug_ver"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("ag_"))
    workspace_id: Mapped[str] = mapped_column(String(32), default="ws_default", index=True)
    slug: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str | None] = mapped_column(Text, default=None)
    runtime: Mapped[str] = mapped_column(String(32), default="agentscope")
    version: Mapped[int] = mapped_column(Integer, default=1)
    parent_id: Mapped[str | None] = mapped_column(String(32), default=None)  # 复制来源，血缘
    definition: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[int] = mapped_column(Integer, default=now_ms)
    updated_at: Mapped[int] = mapped_column(Integer, default=now_ms)


# --------------------------------------------------------------------------- #
# 工具（builtin / http / code）
# --------------------------------------------------------------------------- #
class Tool(Base):
    __tablename__ = "tool"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("tl_"))
    workspace_id: Mapped[str] = mapped_column(String(32), default="ws_default", index=True)
    kind: Mapped[str] = mapped_column(String(16))            # builtin | http | code
    name: Mapped[str] = mapped_column(String(64))
    description: Mapped[str] = mapped_column(Text, default="")
    input_schema: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    impl: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    flags: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[int] = mapped_column(Integer, default=now_ms)
    updated_at: Mapped[int] = mapped_column(Integer, default=now_ms)


# --------------------------------------------------------------------------- #
# Skill（SKILL.md + frontmatter）
# --------------------------------------------------------------------------- #
class Skill(Base):
    __tablename__ = "skill"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("sk_"))
    workspace_id: Mapped[str] = mapped_column(String(32), default="ws_default", index=True)
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)   # {type,url,ref,sha}
    content: Mapped[str] = mapped_column(Text, default="")               # SKILL.md 全文
    files: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)    # 附属文件
    created_at: Mapped[int] = mapped_column(Integer, default=now_ms)
    updated_at: Mapped[int] = mapped_column(Integer, default=now_ms)


class AgentTool(Base):
    __tablename__ = "agent_tool"
    agent_id: Mapped[str] = mapped_column(String(32), ForeignKey("agent.id", ondelete="CASCADE"), primary_key=True)
    tool_id: Mapped[str] = mapped_column(String(32), ForeignKey("tool.id", ondelete="CASCADE"), primary_key=True)


class AgentSkill(Base):
    __tablename__ = "agent_skill"
    agent_id: Mapped[str] = mapped_column(String(32), ForeignKey("agent.id", ondelete="CASCADE"), primary_key=True)
    skill_id: Mapped[str] = mapped_column(String(32), ForeignKey("skill.id", ondelete="CASCADE"), primary_key=True)


# --------------------------------------------------------------------------- #
# 执行实例
# --------------------------------------------------------------------------- #
class Run(Base):
    __tablename__ = "run"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("run_"))
    agent_id: Mapped[str] = mapped_column(String(32), index=True)
    agent_version: Mapped[int] = mapped_column(Integer, default=1)
    runtime: Mapped[str] = mapped_column(String(32), default="agentscope")

    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    # pending | running | ok | error | aborted | waiting_hitl

    input: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    output: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)
    definition_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)

    usage: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(Text, default=None)

    started_at: Mapped[int] = mapped_column(Integer, default=now_ms)
    ended_at: Mapped[int | None] = mapped_column(Integer, default=None)

    # HITL：等待人工确认时的载荷
    pending_hitl: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)

    #: 所属会话（NULL = 单轮执行，保持原有语义不变）
    session_id: Mapped[str | None] = mapped_column(String(32), default=None, index=True)
    #: 会话内第几轮（从 1 开始）
    turn_index: Mapped[int | None] = mapped_column(Integer, default=None)


class RunEvent(Base):
    """统一事件流（已归一化）。seq 单调递增，用于配对 start/end 算耗时。"""

    __tablename__ = "run_event"
    __table_args__ = (Index("idx_event_run", "run_id", "seq"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String(32), ForeignKey("run.id", ondelete="CASCADE"))
    seq: Mapped[int] = mapped_column(Integer)
    type: Mapped[str] = mapped_column(String(32))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    ts: Mapped[int] = mapped_column(Integer)              # 事件发生时间（毫秒）
    raw: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)  # 原始事件


# --------------------------------------------------------------------------- #
# 可观测性：LLM 调用 / 工具调用 / Span
# --------------------------------------------------------------------------- #
class LlmCall(Base):
    __tablename__ = "llm_call"
    __table_args__ = (Index("idx_llm_run", "run_id", "iteration"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String(32), ForeignKey("run.id", ondelete="CASCADE"))
    iteration: Mapped[int] = mapped_column(Integer, default=0)

    provider: Mapped[str | None] = mapped_column(String(32), default=None)
    model: Mapped[str | None] = mapped_column(String(64), default=None)

    started_at: Mapped[int] = mapped_column(Integer)
    ended_at: Mapped[int | None] = mapped_column(Integer, default=None)
    duration_ms: Mapped[int | None] = mapped_column(Integer, default=None)
    ttft_ms: Mapped[int | None] = mapped_column(Integer, default=None)   # 首 token 延迟

    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    tokens_cache_read: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(default=0.0)

    status: Mapped[str] = mapped_column(String(16), default="ok")        # ok | error | timeout
    error: Mapped[str | None] = mapped_column(Text, default=None)

    request_blob: Mapped[bytes | None] = mapped_column(default=None)     # zlib 压缩
    response_blob: Mapped[bytes | None] = mapped_column(default=None)
    payload_truncated: Mapped[int] = mapped_column(Integer, default=0)


class ToolCall(Base):
    __tablename__ = "tool_call"
    __table_args__ = (Index("idx_tool_run", "run_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String(32), ForeignKey("run.id", ondelete="CASCADE"))
    iteration: Mapped[int] = mapped_column(Integer, default=0)

    tool_name: Mapped[str] = mapped_column(String(64))
    args: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    call_id: Mapped[str | None] = mapped_column(String(64), default=None)

    started_at: Mapped[int] = mapped_column(Integer)
    ended_at: Mapped[int | None] = mapped_column(Integer, default=None)
    duration_ms: Mapped[int | None] = mapped_column(Integer, default=None)

    status: Mapped[str] = mapped_column(String(16), default="ok")        # ok | error | denied | timeout
    result_size: Mapped[int] = mapped_column(Integer, default=0)
    result_preview: Mapped[str | None] = mapped_column(Text, default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)


class Span(Base):
    """Span 树 —— 支撑瀑布图与跨运行时统一（kind: run|iteration|llm|tool|middleware）。"""

    __tablename__ = "span"
    __table_args__ = (Index("idx_span_run", "run_id", "started_at"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("sp_"))
    run_id: Mapped[str] = mapped_column(String(32), ForeignKey("run.id", ondelete="CASCADE"))
    parent_id: Mapped[str | None] = mapped_column(String(32), default=None)
    kind: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(128), default="")
    started_at: Mapped[int] = mapped_column(Integer)
    ended_at: Mapped[int | None] = mapped_column(Integer, default=None)
    duration_ms: Mapped[int | None] = mapped_column(Integer, default=None)
    attributes: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


# --------------------------------------------------------------------------- #
# 密钥（引用式存储，不落明文）
# --------------------------------------------------------------------------- #
class Secret(Base):
    """LLM Provider 凭据（引用式存储，不落明文）。

    一个 provider 可以有多套凭据（例如 DeepSeek 主号/备用号），
    Agent 定义通过 ``model.credential_ref`` 选用其中一套。
    """

    __tablename__ = "secret"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("sec_"))
    name: Mapped[str] = mapped_column(String(64))
    provider: Mapped[str] = mapped_column(String(32), default="deepseek", index=True)
    base_url: Mapped[str | None] = mapped_column(String(256), default=None)
    ciphertext: Mapped[bytes] = mapped_column()
    #: 最近一次连通性测试结果（缓存展示用）
    last_test_at: Mapped[int | None] = mapped_column(Integer, default=None)
    last_test_ok: Mapped[int | None] = mapped_column(Integer, default=None)
    last_test_error: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[int] = mapped_column(Integer, default=now_ms)


# --------------------------------------------------------------------------- #
# 会话 —— 多轮对话的容器（短期记忆）
#
# 设计取舍：**状态放在平台侧**，不缓存运行时内部对象。
# 好处：任何运行时（AgentScope / pi / 自研）都能多轮；历史可查询、可编辑、
# 可从任意轮次分叉重跑；进程重启不丢。代价是每轮要重放上下文，
# 因此配 ``summary`` 做压缩兜底（超阈值时把旧轮次压成摘要）。
# --------------------------------------------------------------------------- #
class Session(Base):
    __tablename__ = "session"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("ses_"))
    workspace_id: Mapped[str] = mapped_column(String(32), default="ws_default", index=True)
    agent_id: Mapped[str] = mapped_column(String(32), index=True)
    title: Mapped[str] = mapped_column(String(200), default="")
    #: active | archived
    status: Mapped[str] = mapped_column(String(16), default="active", index=True)

    #: 历史压缩摘要（轮次超阈值时由轻量模型生成，替代完整历史注入）
    summary: Mapped[str | None] = mapped_column(Text, default=None)
    #: 已被摘要覆盖的消息数（前端展示"已压缩 N 轮"）
    summarized_upto: Mapped[int] = mapped_column(Integer, default=0)

    message_count: Mapped[int] = mapped_column(Integer, default=0)
    #: 会话累计用量（跨多轮的总额，前端显示总量）
    usage: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)

    created_at: Mapped[int] = mapped_column(Integer, default=now_ms)
    last_active_at: Mapped[int] = mapped_column(Integer, default=now_ms, index=True)


class SessionMessage(Base):
    """会话消息 —— 多轮对话的历史（平台侧状态）。

    ``turn_index`` 从 1 开始；同一轮里 user 消息先于 assistant。
    ``run_id`` 关联到具体某次执行，方便从消息跳回该轮的完整观测。
    """

    __tablename__ = "session_message"
    __table_args__ = (Index("idx_sessmsg_session", "session_id", "turn_index"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("session.id", ondelete="CASCADE")
    )
    turn_index: Mapped[int] = mapped_column(Integer, default=1)
    #: user | assistant | system
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text, default="")
    run_id: Mapped[str | None] = mapped_column(String(32), default=None, index=True)
    ts: Mapped[int] = mapped_column(Integer, default=now_ms)


# --------------------------------------------------------------------------- #
# 长期记忆（跨会话的资产，独立于 Agent 生命周期）
# --------------------------------------------------------------------------- #
class Memory(Base):
    """一条可检索的记忆（事实 / 偏好 / 结论 / 指令）。

    几个关键字段的设计意图：

    - ``status``：自动沉淀先进 ``candidate``（候选态），用户确认后才 ``active``。
      这是"既自动化又不失控"的关键闸门。
    - ``importance`` / ``hits`` / ``last_hit_at``：支撑热度衰减 ——
      长期不被召回的记忆自动降权，避免记忆库只涨不消、召回质量劣化。
    - ``embedding_status``：为将来接向量检索预留，现在一律 ``none``（用 BM25）。
    - ``source_run_id``：可追溯到哪次执行产生，误沉淀可回滚。
    """

    __tablename__ = "memory"
    __table_args__ = (Index("idx_memory_agent", "agent_id", "status"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("mem_"))
    workspace_id: Mapped[str] = mapped_column(String(32), default="ws_default", index=True)

    #: 归属 Agent；NULL 表示不绑定任何 Agent（只有 scope=global 时才生效）
    agent_id: Mapped[str | None] = mapped_column(String(32), default=None, index=True)
    #: agent（只给该 Agent）| global（全部 Agent 可用）| session（只给某会话）
    scope: Mapped[str] = mapped_column(String(16), default="agent")
    session_id: Mapped[str | None] = mapped_column(String(32), default=None)

    #: fact | preference | summary | instruction
    kind: Mapped[str] = mapped_column(String(16), default="fact")
    content: Mapped[str] = mapped_column(Text, default="")

    #: manual（人工录入/确认）| auto（执行后自动提炼）| import
    source: Mapped[str] = mapped_column(String(16), default="manual")
    source_run_id: Mapped[str | None] = mapped_column(String(32), default=None)

    #: active | candidate（待确认）| archived
    status: Mapped[str] = mapped_column(String(16), default="active", index=True)

    importance: Mapped[float] = mapped_column(default=0.5)
    hits: Mapped[int] = mapped_column(Integer, default=0)
    last_hit_at: Mapped[int | None] = mapped_column(Integer, default=None)

    #: none | pending | ready  —— 预留向量检索，当前不使用
    embedding_status: Mapped[str] = mapped_column(String(16), default="none")
    #: NULL = 永久
    ttl_s: Mapped[int | None] = mapped_column(Integer, default=None)

    created_at: Mapped[int] = mapped_column(Integer, default=now_ms)
    updated_at: Mapped[int] = mapped_column(Integer, default=now_ms)


class AgentMemory(Base):
    """Agent ↔ 记忆 绑定（多对多）。

    用中间表而不是外键：一条记忆（如"用户在上海"）可被多个 Agent 复用，
    且**删除 Agent 不应级联删记忆** —— 记忆是资产，独立于配置的生命周期。
    """

    __tablename__ = "agent_memory"
    agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agent.id", ondelete="CASCADE"), primary_key=True
    )
    memory_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("memory.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[int] = mapped_column(Integer, default=now_ms)


class MemoryPolicy(Base):
    """每个 Agent 一套记忆策略（缺省即默认值，无需预建行）。"""

    __tablename__ = "memory_policy"

    agent_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("agent.id", ondelete="CASCADE"), primary_key=True
    )
    #: 执行结束后自动提炼记忆（进入候选态）
    auto_extract: Mapped[int] = mapped_column(Integer, default=0)
    #: 执行前召回并注入 System Prompt
    recall_enabled: Mapped[int] = mapped_column(Integer, default=1)
    recall_top_k: Mapped[int] = mapped_column(Integer, default=5)
    #: recent | keyword | hybrid
    recall_strategy: Mapped[str] = mapped_column(String(16), default="hybrid")
    #: 注入预算（字符数上限），防止记忆撑爆上下文
    max_inject_chars: Mapped[int] = mapped_column(Integer, default=2000)
    #: 提炼用的模型（留空则跟随 Agent 定义；建议用轻量模型控成本）
    extract_model: Mapped[str | None] = mapped_column(String(64), default=None)
    #: 多轮会话：轮次超过该值时压缩历史为摘要（0 = 不压缩）
    compress_after_turns: Mapped[int] = mapped_column(Integer, default=10)

    updated_at: Mapped[int] = mapped_column(Integer, default=now_ms)
