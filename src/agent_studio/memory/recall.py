"""平台级记忆召回 —— 与运行时完全无关。

为什么放在平台层而不是适配器里
------------------------------
记忆是**跨运行时资产**：换成 pi 或自研运行时，召回逻辑一行都不用改。
适配器只负责"把渲染好的文本放进 System Prompt"。

召回流程
--------
1. 取候选池：``status=active`` 且（本 Agent 的 ``scope=agent`` 或任意 ``scope=global``）
2. 按策略打分：

   - ``recent``：按最近召回/创建时间排序（简单、稳定，适合小库）
   - ``keyword``：轻量 BM25-ish 相关度（中文字符 bigram + 词命中）
   - ``hybrid``：两者归一化后加权 —— **默认**，兼顾"常用"与"相关"

3. 按 ``importance`` 与**时间衰减**加权（长期不被召回的记忆自动降权）
4. 取 top_k，并受 ``max_inject_chars`` 字符预算约束
5. 渲染成可注入文本 + 返回命中的 id（执行后据此累计 hits）

零第三方依赖：没有 numpy / rank_bm25 / 向量库 —— 用纯 Python 实现够用的相关度。
预留 ``embedding_status`` 字段，将来接向量检索时只需在此模块加一条分支。
"""

from __future__ import annotations

import math
import re
import time
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import AgentMemory, Memory

#: 时间衰减半衰期（天）—— 超过这个时长没被召回，权重减半
DECAY_HALF_LIFE_DAYS = 30.0

#: 中英文分词：中文按字取 bigram，英文/数字按词
_TOKEN_RE = re.compile(r"[a-zA-Z0-9_]+|[\u4e00-\u9fff]")


def tokenize(text: str) -> list[str]:
    """极简分词：英文词 + 单字 → 中文再补 bigram。

    中文没有空格，纯按词切需要词典；用 bigram（相邻两字）是与 BM25 配合的
    经典做法，召回质量足够，且**零依赖**。
    """
    raw = _TOKEN_RE.findall(text.lower())
    tokens: list[str] = list(raw)
    # 中文相邻字组合
    for i in range(len(raw) - 1):
        a, b = raw[i], raw[i + 1]
        if len(a) == 1 and len(b) == 1 and "\u4e00" <= a <= "\u9fff":
            tokens.append(a + b)
    return tokens


def keyword_score(content: str, query: str) -> float:
    """轻量 BM25-ish 相关度（0~1）。

    score = Σ(idf(term) * tf 饱和项) / 长度归一，再做 min-max 压缩到 0~1。
    """
    q_tokens = set(tokenize(query))
    if not q_tokens:
        return 0.0
    c_tokens = tokenize(content)
    if not c_tokens:
        return 0.0

    counts: dict[str, int] = {}
    for t in c_tokens:
        counts[t] = counts.get(t, 0) + 1

    # 用查询词长度做粗粒度 idf 代理：长词更具体，权重更高
    total = 0.0
    for term in q_tokens:
        tf = counts.get(term, 0)
        if tf == 0:
            continue
        idf = 1.0 + math.log(1.0 + len(term))
        tf_sat = tf / (tf + 1.2 * (1 + len(c_tokens) / 200.0))  # 长度归一
        total += idf * tf_sat

    if total <= 0:
        return 0.0
    # 压缩到 0~1：命中越多越接近 1，但饱和（避免长记忆无脑占优）
    return 1.0 - math.exp(-total)


def decay_factor(ts: int | None, now_ms: int) -> float:
    """时间衰减：指数半衰期。``ts`` 为空（从未召回）视为刚创建。"""
    if not ts:
        return 1.0
    age_days = max(0.0, (now_ms - ts) / 86_400_000.0)
    return 0.5 ** (age_days / DECAY_HALF_LIFE_DAYS)


@dataclass
class RecalledMemory:
    """一条被召回的记忆。"""

    id: str
    content: str
    kind: str
    score: float
    importance: float
    #: user（关于用户）| memory（助手笔记）—— 注入时分两段渲染
    layer: str = "memory"


@dataclass
class RecallResult:
    """召回结果。"""

    memories: list[RecalledMemory] = field(default_factory=list)
    text: str | None = None

    @property
    def ids(self) -> list[str]:
        return [m.id for m in self.memories]


def _recent_score(m: Memory, now: int) -> float:
    """最近活跃度（0~1）：以 7 天为尺度。"""
    ts = m.last_hit_at or m.created_at
    age_days = max(0.0, (now - ts) / 86_400_000.0)
    return 1.0 / (1.0 + age_days / 7.0)


async def recall(
    session: AsyncSession,
    agent_id: str,
    query: str,
    *,
    top_k: int = 5,
    strategy: str = "hybrid",
    max_chars: int = 2000,
    session_id: str | None = None,
) -> RecallResult:
    """召回该 Agent 可用的长期记忆。

    候选池 = ``active`` 且（显式绑定到本 Agent 的 ∪ ``scope=global`` 的）
    ∪ ``scope=session`` 且 session_id 匹配的。
    """
    now = int(time.time() * 1000)

    # 显式绑定优先（用户明确挑了这些），但也纳入 global
    bound_stmt = select(Memory.id).join(AgentMemory, AgentMemory.memory_id == Memory.id).where(
        AgentMemory.agent_id == agent_id
    )
    bound_ids = set((await session.execute(bound_stmt)).scalars().all())

    stmt = select(Memory).where(Memory.status == "active")
    rows = list((await session.execute(stmt)).scalars().all())

    candidates: list[Memory] = []
    for m in rows:
        if m.agent_id == agent_id or m.id in bound_ids:
            candidates.append(m)
        elif m.scope == "global":
            candidates.append(m)
        elif m.scope == "session" and session_id and m.session_id == session_id:
            candidates.append(m)

    if not candidates:
        return RecallResult()

    scored: list[RecalledMemory] = []
    for m in candidates:
        kw = keyword_score(m.content, query) if query else 0.0
        rec = _recent_score(m, now)
        if strategy == "keyword":
            base = kw
        elif strategy == "recent":
            base = rec
        else:  # hybrid
            base = 0.65 * kw + 0.35 * rec

        # importance 与时间衰减调制
        score = base * (0.5 + 0.5 * float(m.importance or 0.5)) * decay_factor(m.last_hit_at, now)
        if score <= 0:
            continue
        scored.append(
            RecalledMemory(id=m.id, content=m.content, kind=m.kind, score=score, importance=float(m.importance or 0.5))
        )

    scored.sort(key=lambda x: x.score, reverse=True)
    picked = scored[: max(1, top_k)]

    # 字符预算：超出则截断（宁可少注入，不撑爆上下文）
    kept: list[RecalledMemory] = []
    used = 0
    for m in picked:
        cost = len(m.content) + 8
        if used + cost > max_chars:
            break
        kept.append(m)
        used += cost

    return RecallResult(memories=kept, text=render(kept) if kept else None)


async def pinned_for(
    session: AsyncSession,
    agent_id: str,
    *,
    max_chars: int = 1200,
    session_id: str | None = None,
) -> list[RecalledMemory]:
    """**常驻层**：pinned 的记忆，不参与相似度排序，每轮整段注入。

    对应 Hermes 的 MEMORY.md / USER.md。为什么要单独一层：
    检索召回是"你问什么，我找像的"；而「用户在上海」「凭据都在 .env」这类事实，
    用户问「帮我部署个服务」时和问题**一点也不像**，top_k 永远排不上 ——
    但它必须每轮都在。这类事实放这里，检索那层只管任务相关的细节。

    预算按 importance 从高到低吃，超了截断（常驻也不能无限长，否则挤掉正文）。
    """
    stmt = select(Memory).where(Memory.status == "active", Memory.pinned == 1)
    rows = list((await session.execute(stmt)).scalars().all())
    if not rows:
        return []
    mine: list[Memory] = []
    for m in rows:
        if m.agent_id == agent_id or m.scope == "global":
            mine.append(m)
        elif m.scope == "session" and session_id and m.session_id == session_id:
            mine.append(m)
    mine.sort(key=lambda m: float(m.importance or 0.5), reverse=True)

    kept: list[RecalledMemory] = []
    used = 0
    for m in mine:
        cost = len(m.content) + 8
        if used + cost > max_chars:
            break
        kept.append(
            RecalledMemory(
                id=m.id, content=m.content, kind=m.kind,
                score=float(m.importance or 0.5), importance=float(m.importance or 0.5),
                layer=getattr(m, "layer", None) or "memory",
            )
        )
        used += cost
    return kept


def render_pinned(memories: list[RecalledMemory]) -> str:
    """常驻段的渲染，**按层分开** —— 对应 Hermes 的 USER.md / MEMORY.md。

    为什么要分两段而不是一个列表：两层是不同来源的知识。
    上层是「用户告诉过我/我从对话里确认的关于他的事」，改成任何说法都要尊重；
    下层是「我自己摸索出来的环境与做法」，可以被后来的验证推翻。
    混在一段里，模型容易把后者当成用户的要求来引用。
    """
    if not memories:
        return ""
    user_side = [m for m in memories if getattr(m, "layer", "memory") == "user"]
    mine = [m for m in memories if getattr(m, "layer", "memory") != "user"]
    out: list[str] = []

    def _block(title: str, items: list[RecalledMemory], note: str) -> None:
        if not items:
            return
        out.append(f"## {title}")
        out.append(f"（{note}）")
        for m in items:
            label = {
                "fact": "事实",
                "preference": "偏好",
                "summary": "结论",
                "instruction": "要求",
            }.get(m.kind, "信息")
            out.append(f"- [{label}] {m.content}")
        out.append("")

    _block("关于用户", user_side, "这些是用户的身份、偏好与约定，按此说话和做事")
    _block("我记的笔记", mine, "环境事实与做法；与后来的实测冲突时以实测为准")
    return "\n".join(out).strip()


def render(memories: list[RecalledMemory]) -> str:
    """把记忆渲染成注入 System Prompt 的文本块。

    用明确的标题与无序列表，让模型知道这是"已知信息"而不是用户的话。
    """
    if not memories:
        return ""
    lines = ["## 已知信息（来自长期记忆，可直接使用）"]
    for m in memories:
        label = {
            "fact": "事实",
            "preference": "偏好",
            "summary": "结论",
            "instruction": "要求",
        }.get(m.kind, "信息")
        lines.append(f"- [{label}] {m.content}")
    return "\n".join(lines)


async def mark_hit(session: AsyncSession, memory_ids: list[str], now: int | None = None) -> None:
    """累计命中次数（热度衰减的依据）。由 runner 在执行后调用。"""
    if not memory_ids:
        return
    ts = now or int(time.time() * 1000)
    stmt = select(Memory).where(Memory.id.in_(memory_ids))
    for m in (await session.execute(stmt)).scalars().all():
        m.hits = (m.hits or 0) + 1
        m.last_hit_at = ts


def openai_tools_schema() -> dict[str, Any]:
    """（可选）把记忆暴露成工具 —— 预留给"Agent 主动检索记忆"的能力。"""
    return {
        "type": "object",
        "properties": {"query": {"type": "string", "description": "检索关键词"}},
        "required": ["query"],
    }
