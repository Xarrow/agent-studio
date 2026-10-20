"""跨会话检索 —— "我以前跟你说过那个配置吗"。

为什么这是必需品
----------------
上下文只覆盖**当前**会话，长期记忆只记**事实**（偏好、结论）。中间那一层没人管：
"三个月前那次排查，最后是哪个参数救的？" —— 这类问题只有翻历史才答得出。
Hermes 的 session_search 就是干这个的；没有它，助手再聪明也只能说"我记不得了"。

实现取舍
--------
* **不引 FTS5**：SQLite 的 FTS5 要么额外建虚表 + 触发器保持同步（写入路径变复杂），
  要么 `content=` 外部表（还要处理重建）。当前量级（几万条消息）用 LIKE 足够快
  （单机 <50ms），而且**不需要迁移**、不会因为表不同步导致"搜不到"。
  等真的到十万级再换 —— 到那时也应该是引向量而不是 FTS。
* **多词 = AND**：拆成若干词，每个词都要命中（任意位置），再按命中次数 + 时间排序。
  这比"整串子串匹配"实用得多（用户不会把原话一字不差打出来）。
* **snippet 居中**：截命中词前后各一段，前端/模型都能直接读懂，不用自己再切。
* **会话是第一现场**：结果按消息给，但每条都带会话标题与时间 —— 人点的是会话，
  不是孤立的一句。
"""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy import or_, select

from .db import SessionLocal
from .models import Session, SessionMessage

#: 单个结果片段最多多少字（够读懂上下文，又不至于把回复撑爆）
SNIPPET_CHARS = 180
#: 一次最多返回多少条（再多就该收窄关键词了）
MAX_LIMIT = 30


def _tokens(q: str) -> list[str]:
    """查询拆词：按空白切，去掉太短的（单字匹配噪声太大）。"""
    parts = [p for p in re.split(r"\s+", (q or "").strip()) if p]
    toks = [p for p in parts if len(p) >= 2]
    return toks or parts


def _snippet(text: str, toks: list[str]) -> str:
    """截命中位置附近的一段（命中词尽量居中）。"""
    s = re.sub(r"\s+", " ", text or "").strip()
    if not s:
        return ""
    low = s.lower()
    pos = -1
    for t in toks:
        i = low.find(t.lower())
        if i >= 0 and (pos < 0 or i < pos):
            pos = i
    if pos < 0:
        return s[:SNIPPET_CHARS] + ("…" if len(s) > SNIPPET_CHARS else "")
    half = max(30, SNIPPET_CHARS // 2)
    start = max(0, pos - half)
    end = min(len(s), start + SNIPPET_CHARS)
    start = max(0, end - SNIPPET_CHARS)
    out = s[start:end]
    if start > 0:
        out = "…" + out
    if end < len(s):
        out = out + "…"
    return out


def _score(text: str, toks: list[str]) -> int:
    low = (text or "").lower()
    return sum(low.count(t.lower()) for t in toks)


async def search_messages(
    query: str,
    *,
    limit: int = 10,
    agent_id: str | None = None,
    session_id: str | None = None,
) -> list[dict[str, Any]]:
    """在所有会话的消息里找 ``query``。

    * ``agent_id`` 只搜这个助手聊过的会话
    * ``session_id`` 只搜这一个会话（"在本次对话里找"）
    """
    toks = _tokens(query)
    if not toks:
        return []
    n = max(1, min(int(limit or 10), MAX_LIMIT))

    async with SessionLocal() as db:
        stmt = (
            select(SessionMessage, Session)
            .join(Session, Session.id == SessionMessage.session_id)
            .where(SessionMessage.role.in_(("user", "assistant")))
        )
        for t in toks:  # 多词 AND：每个词都要出现
            stmt = stmt.where(SessionMessage.content.ilike(f"%{t}%"))
        if agent_id:
            stmt = stmt.where(Session.agent_id == agent_id)
        if session_id:
            stmt = stmt.where(SessionMessage.session_id == session_id)

        # 先按时间取一批候选，再按命中密度重排（相关性优先，但时间做平局裁决）
        rows = (
            (await db.execute(stmt.order_by(SessionMessage.ts.desc()).limit(n * 6))).all()
        )

    hits: list[dict[str, Any]] = []
    for msg, sess in rows:
        hits.append(
            {
                "message_id": msg.id,
                "session_id": msg.session_id,
                "session_title": sess.title or "未命名对话",
                "agent_id": sess.agent_id,
                "role": msg.role,
                "turn_index": msg.turn_index,
                "ts": msg.ts,
                "score": _score(msg.content, toks),
                "snippet": _snippet(msg.content, toks),
            }
        )
    hits.sort(key=lambda h: (-h["score"], -h["ts"]))
    return hits[:n]


async def search_sessions_titles(query: str, *, limit: int = 10) -> list[dict[str, Any]]:
    """只按会话标题找（侧栏搜索框的第一段）。"""
    q = (query or "").strip()
    if not q:
        return []
    async with SessionLocal() as db:
        rows = (
            (
                await db.execute(
                    select(Session)
                    .where(or_(Session.title.ilike(f"%{q}%")))
                    .order_by(Session.last_active_at.desc())
                    .limit(max(1, min(limit, MAX_LIMIT)))
                )
            )
            .scalars()
            .all()
        )
    return [{"session_id": s.id, "title": s.title or "未命名对话", "ts": s.last_active_at} for s in rows]
