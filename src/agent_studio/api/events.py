"""事件账本的只读接口：最近发生了什么、有多少卡住/进死信。

为什么要暴露：事件是平台内部的事实账本，但"某件事为什么没被处理"必须能一眼看到
（死信里躺着 3 条 = 有个处理器一直失败）。藏起来的队列等于没建。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..events import ingest as event_ingest
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


# --------------------------------------------------------------------------- #
# 事件入口：外部发生了什么 → 谁去处理（两级过滤 + 订阅直通）
# --------------------------------------------------------------------------- #

class IngestIn(BaseModel):
    """一条外部事件。``source`` 是来源（github/email/im/ci/…），``thread_id`` 是它属于哪条串。"""

    text: str
    source: str | None = None
    #: 同一 PR / 同一 IM 话题 / 同一邮件串 —— 认过人的 thread 后续事件直投
    thread_id: str | None = None
    #: 直接指定投给哪个会话（调用方已经知道去哪，就不要再过 Router）
    session_id: str | None = None
    meta: dict[str, Any] | None = None


@router.post("/ingest", response_model=dict)
async def ingest_event(payload: IngestIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """收一条事件：先记账（幂等），再决定投给 Router 还是直投某个会话。

    幂等做在**记账**这一步：同一条事件重投只会入队一次 —— 否则外部系统一重试，
    Router 就被叫起来好几次，每次都可能派出一批 worker。
    """
    key = event_ingest.dedupe_key_of(payload.source, payload.thread_id, payload.text, payload.meta)
    ev = await event_store.append(
        session,
        "event.ingested",
        subject_kind="thread" if payload.thread_id else "source",
        subject_id=payload.thread_id or payload.source,
        payload={
            "source": payload.source,
            "thread_id": payload.thread_id,
            "text": payload.text[:500],
        },
        dedupe_key=key,
        status="done",
    )
    if ev is None:
        return {"kind": "duplicate", "dedupe_key": key, "note": "这条事件之前已经收过了"}

    result = await event_ingest.ingest(
        session,
        source=payload.source,
        text=payload.text,
        thread_id=payload.thread_id,
        meta=payload.meta,
        session_id=payload.session_id,
    )
    result["dedupe_key"] = key
    # 记账：这条事件最后落到了谁手上（账本里能回答"为什么是它处理的"）
    await event_store.append(
        session,
        f"event.{result.get('kind') or 'unknown'}",
        subject_kind="run" if result.get("run_id") else None,
        subject_id=result.get("run_id"),
        payload={"dedupe_key": key, **{k: result.get(k) for k in ("kind", "agent_name", "session_id", "reason")}},
        causation_id=ev.id,
        hop=1,
        status="done",
    )
    await session.commit()
    return result


class BindIn(BaseModel):
    thread_id: str
    session_id: str


@router.post("/threads", response_model=dict)
async def bind_thread(payload: BindIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """把一条 thread 认给某个会话 —— 之后它的事件直投，不再过 Router。"""
    try:
        return await event_ingest.bind_thread(session, payload.thread_id, payload.session_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc


@router.get("/threads", response_model=list)
async def list_threads(session: AsyncSession = Depends(get_session)) -> list[dict[str, Any]]:
    from sqlalchemy import select

    from ..models import ThreadSub

    rows = (await session.execute(select(ThreadSub).order_by(ThreadSub.created_at.desc()).limit(200))).scalars().all()
    return [
        {"thread_id": r.thread_id, "session_id": r.session_id, "agent_id": r.agent_id, "created_at": r.created_at}
        for r in rows
    ]
