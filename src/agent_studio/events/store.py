"""事件账本：入队 / 抢租约 / 收尾 / 死信。

三条硬规矩（都在并发下验过）：

1. **入队幂等**：``dedupe_key`` 唯一，撞了就返回 None，不抛错 ——
   重复投递是常态（重试、双写、用户点两下），让它报错等于逼调用方自己查重。
2. **抢租约用 UPDATE … RETURNING**，不是"先 SELECT 再 UPDATE"：
   两个 worker 同时 tick 时后者会拿到同一批，然后事情干两遍。
3. **过期租约自动回队**：进程被 kill 时它手上的事件不能永远卡在 handling。
   回队时**不扣 attempts** —— 没干成不是因为处理逻辑有问题，别让它提前进死信。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Event, now_ms

logger = logging.getLogger(__name__)

#: 重试用尽进死信（人工看一眼，别无限重试把日志刷满）
MAX_ATTEMPTS = 5
#: 退避：1min × 2^attempts，封顶 10 分钟。不封顶的话第 5 次已经是 16 分钟
BACKOFF_MS = 60_000
BACKOFF_CAP_MS = 600_000
#: 单次租约：够跑完一个 handler，又不至于进程崩了要等太久
LEASE_MS = 60_000


async def append(
    session: AsyncSession,
    kind: str,
    *,
    subject_kind: str | None = None,
    subject_id: str | None = None,
    payload: dict[str, Any] | None = None,
    dedupe_key: str | None = None,
    causation_id: str | None = None,
    hop: int = 0,
    available_at: int | None = None,
    status: str = "queued",
) -> Event | None:
    """记一条事件（幂等）。返回 None 表示这条之前已经记过了。"""
    ev = Event(
        kind=kind,
        subject_kind=subject_kind,
        subject_id=subject_id,
        payload=payload or {},
        dedupe_key=dedupe_key,
        causation_id=causation_id,
        hop=hop,
        available_at=available_at if available_at is not None else now_ms(),
        # 只记账的事实（例如"外部事件已收下"）直接标 done —— 否则 tick 会给它判
        # 「没有处理器」进死信，死信里堆满正常记录，真问题就看不见了
        status=status,
        ended_at=now_ms() if status == "done" else None,
    )
    session.add(ev)
    try:
        await session.flush()
    except Exception as exc:  # noqa: BLE001 —— 命中唯一键就是"已经记过"
        await session.rollback()
        if _is_dupe(exc):
            return None
        raise
    return ev


def _is_dupe(exc: Exception) -> bool:
    msg = str(exc).lower()
    return "unique" in msg or "duplicate" in msg


async def claim(
    session: AsyncSession, limit: int = 10, *, lease_ms: int = LEASE_MS
) -> list[Event]:
    """抢一批待处理事件（原子）。只认到点的、没人持有的。"""
    now = now_ms()
    stmt = text(
        """
        UPDATE event
           SET status = 'handling', lease_until = :until
         WHERE id IN (
               SELECT id FROM event
                WHERE status = 'queued'
                  AND available_at <= :now
                ORDER BY available_at ASC
                LIMIT :limit
         )
        RETURNING id
        """
    )
    rows = (
        await session.execute(
            stmt, {"until": now + lease_ms, "now": now, "limit": int(limit)}
        )
    ).all()
    await session.commit()
    ids = [r[0] for r in rows]
    if not ids:
        return []
    return list(
        (await session.execute(select(Event).where(Event.id.in_(ids)))).scalars()
    )


async def complete(session: AsyncSession, ev: Event) -> None:
    ev.status = "done"
    ev.ended_at = now_ms()
    ev.lease_until = None
    ev.error = None
    await session.commit()


async def fail(session: AsyncSession, ev: Event, error: str) -> None:
    """记一次失败：要么退避重试，要么进死信。"""
    ev.attempts = int(ev.attempts or 0) + 1
    ev.error = (error or "")[:2000]
    ev.lease_until = None
    if ev.attempts >= MAX_ATTEMPTS:
        ev.status = "dead"
        ev.ended_at = now_ms()
        logger.warning("事件进死信（%s，试了 %d 次）：%s", ev.kind, ev.attempts, ev.error)
    else:
        ev.status = "queued"
        ev.available_at = now_ms() + min(
            BACKOFF_MS * (2 ** (ev.attempts - 1)), BACKOFF_CAP_MS
        )
    await session.commit()


async def sweep_leases(session: AsyncSession) -> int:
    """回收过期租约（进程崩了留下的 handling）。返回回收条数。"""
    now = now_ms()
    res = await session.execute(
        update(Event)
        .where(Event.status == "handling", Event.lease_until.is_not(None), Event.lease_until < now)
        .values(status="queued", lease_until=None)
    )
    await session.commit()
    n = int(res.rowcount or 0)
    if n:
        logger.info("回收过期租约 %d 条", n)
    return n


async def stats(session: AsyncSession) -> dict[str, int]:
    rows = (
        await session.execute(select(Event.status, func.count()).group_by(Event.status))
    ).all()
    return {str(k): int(v) for k, v in rows}


async def recent(
    session: AsyncSession,
    *,
    kind: str | None = None,
    status: str | None = None,
    limit: int = 50,
) -> list[Event]:
    stmt = select(Event)
    if kind:
        stmt = stmt.where(Event.kind == kind)
    if status:
        stmt = stmt.where(Event.status == status)
    stmt = stmt.order_by(Event.created_at.desc()).limit(max(1, min(int(limit), 200)))
    return list((await session.execute(stmt)).scalars())


async def dead_letters(session: AsyncSession, limit: int = 50) -> list[Event]:
    return await recent(session, status="dead", limit=limit)


def as_dict(ev: Event) -> dict[str, Any]:
    """给接口/日志用的扁平形态（payload 原样带出，别二次编码）。"""
    payload = ev.payload
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:  # noqa: BLE001
            payload = {}
    return {
        "id": ev.id,
        "kind": ev.kind,
        "subject_kind": ev.subject_kind,
        "subject_id": ev.subject_id,
        "payload": payload or {},
        "status": ev.status,
        "attempts": ev.attempts,
        "hop": ev.hop,
        "causation_id": ev.causation_id,
        "created_at": ev.created_at,
        "ended_at": ev.ended_at,
        "error": ev.error,
    }
