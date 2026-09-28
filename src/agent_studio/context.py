"""上下文组装 —— 把会话历史与长期记忆合成一个 ``TurnContext``。

这是「多轮会话」与「长期记忆」两条线的**汇合点**：两者最终都表现为一个
平台中立的 ``TurnContext``，运行时不需要知道它们分别来自哪张表。

裁剪哲学
--------
上下文预算是稀缺资源，所以**从最近往回取**：

1. 超预算时优先丢最旧的轮次（最近的对话最相关）
2. 更早的内容不直接消失，而是退化成 ``summary``（一句话顶多轮）
3. 长期记忆独立于对话历史，走自己的字符预算

压缩（``compress_after_turns``）是"防上下文爆炸"的兜底：
轮次超过阈值时把较旧的对话压成摘要，summary 顶替它们参与后续注入。
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from .memory import call_llm, recall
from .models import Run, Session as ChatSession, SessionMessage, now_ms
from .runtimes.base import TurnContext, TurnMessage
from .schemas import AgentDefinition, MemoryPolicyRead

logger = logging.getLogger(__name__)

#: 单条历史消息注入时的最大字符数（超长输出只保留开头与结尾）
MAX_MSG_CHARS = 2000

#: 历史部分的总字符预算（与记忆预算分开计）
HISTORY_BUDGET_CHARS = 8000


def _clip(text: str, limit: int = MAX_MSG_CHARS) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    head = limit // 2
    tail = limit - head - 20
    return f"{text[:head]}\n…（中间省略 {len(text) - limit} 字）…\n{text[-tail:]}"


async def next_turn_index(session: AsyncSession, session_id: str) -> int:
    """下一轮的序号（从 1 开始）。"""
    stmt = (
        select(SessionMessage.turn_index)
        .where(SessionMessage.session_id == session_id)
        .order_by(SessionMessage.turn_index.desc())
        .limit(1)
    )
    last = (await session.execute(stmt)).scalar_one_or_none()
    return (last or 0) + 1


async def load_history(
    session: AsyncSession,
    session_id: str,
    *,
    budget_chars: int = HISTORY_BUDGET_CHARS,
) -> list[TurnMessage]:
    """从最近往回取消息，直到字符预算用尽（保持时间正序返回）。"""
    rows = (
        await session.execute(
            select(SessionMessage)
            .where(SessionMessage.session_id == session_id)
            .order_by(SessionMessage.turn_index.desc(), SessionMessage.id.desc())
        )
    ).scalars().all()

    picked: list[SessionMessage] = []
    used = 0
    for row in rows:  # 已按新→旧
        cost = len(row.content or "") + 16
        if used + cost > budget_chars and picked:
            break
        picked.append(row)
        used += cost

    picked.reverse()  # 还原为旧→新
    return [TurnMessage(role=r.role, content=_clip(r.content)) for r in picked if r.role in ("user", "assistant", "system")]


async def build_turn_context(
    session: AsyncSession,
    *,
    agent_id: str,
    session_id: str | None,
    query: str,
    policy: MemoryPolicyRead,
) -> TurnContext:
    """组装一次执行的上下文（会话历史 + 长期记忆）。"""
    ctx = TurnContext(session_id=session_id)

    if session_id:
        sess = await session.get(ChatSession, session_id)
        if sess is not None:
            ctx.turn_index = await next_turn_index(session, session_id)
            ctx.summary = sess.summary
            ctx.history = await load_history(session, session_id)

    if policy.recall_enabled:
        result = await recall(
            session,
            agent_id,
            query,
            top_k=policy.recall_top_k,
            strategy=policy.recall_strategy,
            max_chars=policy.max_inject_chars,
            session_id=session_id,
        )
        if result.memories:
            ctx.memory_text = result.text
            ctx.memory_ids = result.ids

    return ctx


async def append_turn(
    session: AsyncSession,
    *,
    session_id: str,
    run_id: str,
    user_text: str,
    assistant_text: str,
    usage: dict[str, Any] | None = None,
) -> int:
    """把一轮问答写入会话历史（执行完成后调用）。"""
    sess = await session.get(ChatSession, session_id)
    if sess is None:
        return 0

    turn = await next_turn_index(session, session_id)
    ts = now_ms()
    session.add_all(
        [
            SessionMessage(
                session_id=session_id, turn_index=turn, role="user",
                content=user_text, run_id=run_id, ts=ts,
            ),
            SessionMessage(
                session_id=session_id, turn_index=turn, role="assistant",
                content=assistant_text, run_id=run_id, ts=now_ms(),
            ),
        ]
    )
    sess.message_count = (sess.message_count or 0) + 2
    sess.last_active_at = now_ms()
    if sess.title in ("", None):
        sess.title = (user_text or "").strip()[:60]

    # 会话累计用量（跨轮汇总，前端显示会话总量）
    if usage:
        acc = dict(sess.usage or {})
        for key in ("tokens_in", "tokens_out", "llm_ms", "tool_ms"):
            val = usage.get(key)
            if isinstance(val, (int, float)):
                acc[key] = (acc.get(key, 0) or 0) + val
        acc["runs"] = (acc.get("runs", 0) or 0) + 1
        sess.usage = acc

    await session.commit()
    return turn


async def clear_context(
    session: AsyncSession, session_id: str, *, keep_summary: bool = False
) -> int:
    """清空会话上下文（保留会话本身）—— 用于"重新开始，但别删会话"的场景。"""
    sess = await session.get(ChatSession, session_id)
    if sess is None:
        return 0
    removed = len(
        (
            await session.execute(
                select(SessionMessage.id).where(SessionMessage.session_id == session_id)
            )
        ).scalars().all()
    )
    await session.execute(delete(SessionMessage).where(SessionMessage.session_id == session_id))
    sess.message_count = 0
    if not keep_summary:
        sess.summary = None
        sess.summarized_upto = 0
    await session.commit()
    return removed


#: 会话压缩专用的人设：要的是**一段能接着聊的摘要**，不是结构化数据。
#: （记忆提炼那套 prompt 是「输出 JSON 候选」，两者不能混用。）
SUMMARY_SYSTEM_PROMPT = (
    "你是对话压缩助手。把给定的多轮对话压缩成一段**连贯的中文摘要**，"
    "供后续对话接着用。要求：\n"
    "1. 只输出摘要正文，不要标题、不要 JSON、不要列表符号、不要评论；\n"
    "2. 保留：关键事实与结论、用户的偏好与明确要求、正在做的事与未完成事项；\n"
    "3. 丢掉客套、重复与无关细节；\n"
    "4. 用第三人称叙述（\"用户\"\"助手\"），200~300 字。"
)


async def compress_if_needed(
    session: AsyncSession,
    *,
    session_id: str,
    threshold_turns: int,
    base_url: str,
    api_key: str,
    model: str,
) -> str | None:
    """轮次超阈值时把较早的对话压成摘要（替代它们参与后续注入）。

    只在 ``threshold_turns > 0`` 时生效。压缩后 ``summarized_upto`` 记录
    已覆盖的轮次，前端可提示"已压缩 N 轮"。
    """
    if threshold_turns <= 0:
        return None
    sess = await session.get(ChatSession, session_id)
    if sess is None:
        return None

    rows = (
        await session.execute(
            select(SessionMessage)
            .where(SessionMessage.session_id == session_id)
            .order_by(SessionMessage.turn_index, SessionMessage.id)
        )
    ).scalars().all()
    turns = max((r.turn_index for r in rows), default=0)
    if turns <= threshold_turns:
        return None

    # 只压缩"较旧的一半"，保留最近 threshold_turns/2 轮为原文（近因优先）
    cutoff = max(1, turns - max(1, threshold_turns // 2))
    old = [r for r in rows if r.turn_index <= cutoff]
    if not old:
        return None

    convo = "\n".join(f"{r.role}: {_clip(r.content, 800)}" for r in old)
    prev = f"（此前已有摘要：{sess.summary}）\n" if sess.summary else ""
    prompt = (
        f"{prev}请把下面这段对话压缩成不超过 300 字的摘要，"
        f"保留关键事实、结论、用户偏好与未完成事项，不要评论、不要加标题：\n\n{convo}"
    )
    try:
        # **必须传自己的 system prompt**：默认那套是「提炼记忆候选、输出 JSON」，
        # 用它来压缩会得到一堆 JSON（甚至空），写进会话摘要后又被当成
        # 「较早内容的摘要」注入给模型 —— 上下文里就成了 JSON 而不是摘要。
        summary = await call_llm(
            base_url=base_url,
            api_key=api_key,
            model=model,
            user_prompt=prompt,
            timeout=90.0,
            system_prompt=SUMMARY_SYSTEM_PROMPT,
        )
    except Exception:  # pragma: no cover - 压缩失败不该影响主流程
        logger.warning("会话压缩失败 session=%s", session_id, exc_info=True)
        return None

    if not summary.strip():
        return None
    sess.summary = summary.strip()[:2000]
    sess.summarized_upto = cutoff
    await session.commit()
    return sess.summary


async def run_dialogue(run: Run) -> tuple[str, str]:
    """从一次 Run 里取出 (用户输入, Agent 输出) —— 用于写会话历史。"""
    user_text = ""
    if isinstance(run.input, dict):
        user_text = str(run.input.get("text") or "")
        if not user_text:
            user_text = str(run.input)
    assistant_text = ""
    if isinstance(run.output, dict):
        assistant_text = str(run.output.get("content") or "")
    return user_text, assistant_text
