"""事件账本的只读接口：最近发生了什么、有多少卡住/进死信。

为什么要暴露：事件是平台内部的事实账本，但"某件事为什么没被处理"必须能一眼看到
（死信里躺着 3 条 = 有个处理器一直失败）。藏起来的队列等于没建。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..events import store as event_store
from ..events import worker as event_worker

router = APIRouter(prefix="/api/events", tags=["events"])


@router.get("", response_model=dict)
async def list_events(
    kind: str | None = Query(None, description="事件类型，如 fanout.blocked"),
    status: str | None = Query(None, description="queued / handling / done / dead"),
    limit: int = Query(50, ge=1, le=200),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    rows = await event_store.recent(session, kind=kind, status=status, limit=limit)
    return {
        "stats": await event_store.stats(session),
        "handlers": sorted(event_worker.handlers()),
        "items": [event_store.as_dict(e) for e in rows],
    }


@router.get("/dead", response_model=list)
async def list_dead(
    limit: int = Query(50, ge=1, le=200),
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, Any]]:
    """死信：试满次数还失败的、缺处理器的。这些需要人看一眼。"""
    return [event_store.as_dict(e) for e in await event_store.dead_letters(session, limit)]
