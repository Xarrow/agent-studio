"""跨会话检索的 HTTP 接口。

界面上的搜索框用它：标题命中（第一段）+ 对话内容命中（第二段，带片段）。
和助手的 ``session_search`` 工具共用同一份实现（``agent_studio.search``），
所以"人搜到的"和"助手搜到的"永远是同一批结果。
"""

from __future__ import annotations

from fastapi import APIRouter, Query

from ..search import search_messages, search_sessions_titles

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("")
async def search(
    q: str = Query(..., min_length=1, description="关键词（空格分开 = 都要命中）"),
    limit: int = Query(12, ge=1, le=30),
    agent_id: str | None = Query(None, description="只看这个助手的会话"),
    session_id: str | None = Query(None, description="只在某一个会话里找"),
) -> dict:
    titles = await search_sessions_titles(q, limit=limit)
    messages = await search_messages(
        q, limit=limit, agent_id=agent_id, session_id=session_id
    )
    return {"query": q, "sessions": titles, "messages": messages}
