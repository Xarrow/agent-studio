"""事件消费骨架：注册处理器 → 抢一批 → 逐个跑 → 收尾/退避/死信。

为什么不是"每条事件起一个任务"
------------------------------
事件是**可靠**的活儿：跑一半进程挂了要能接着跑。所以用"抢租约 + 到点重试"，
而不是 fire-and-forget。代价是有一个 tick（20s），换来的是不丢、不双跑、能回放。

回声防护（这一层就做，别等到出事）
---------------------------------
``hop`` ≥ 2 的事件**只记录不再扇出**：A 引起 B、B 引起 C，C 再喂回 A 就是自激。
"自己产的事件不喂自己"在路由层实现（下一刀），这里先守住 hop 这条底线。
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Event, now_ms
from . import store

logger = logging.getLogger(__name__)

#: 类型只作为注解用；真正的签名在 register 的文档里
Handler = Callable[[AsyncSession, Event], Awaitable[None]]

_HANDLERS: dict[str, Handler] = {}

#: 传过这么多手的事件只记账不处理
HOP_RECORD_ONLY = 2


def register(kind: str) -> Callable[[Handler], Handler]:
    """注册处理器：``@register("fanout.blocked")`` + ``async def h(session, ev)``。"""

    def deco(fn: Handler) -> Handler:
        if kind in _HANDLERS:
            raise RuntimeError(f"事件类型 {kind} 已经有处理器了")
        _HANDLERS[kind] = fn
        return fn

    return deco


def handlers() -> dict[str, Handler]:
    """当前已注册的处理器（测试与 /api/events/handlers 用）。"""
    return dict(_HANDLERS)


async def tick(session: AsyncSession, limit: int = 10) -> dict[str, int]:
    """跑一轮：回收过期租约 → 抢一批 → 逐个处理。

    每个 handler 单独 try：一条炸了不能带崩这一批（否则同批其它事件会被
    反复重试，而问题那条永远卡在队头 —— 队头阻塞是这类系统最常见的死法）。
    """
    recovered = await store.sweep_leases(session)
    events = await store.claim(session, limit=limit)
    done = failed = skipped = 0

    for ev in events:
        if int(ev.hop or 0) >= HOP_RECORD_ONLY:
            # 回声治理：这个手数已经只记录，不再往下扇出
            ev.status = "done"
            ev.ended_at = now_ms()
            ev.error = "hop≥%d：只记录不处理" % HOP_RECORD_ONLY
            await session.commit()
            skipped += 1
            continue

        fn = _HANDLERS.get(ev.kind)
        if fn is None:
            # 没人认领的类型别在队里躺着：直接判死，让人在死信里看到"缺处理器"
            ev.status = "dead"
            ev.ended_at = now_ms()
            ev.error = f"没有处理器：{ev.kind}"
            await session.commit()
            failed += 1
            continue

        try:
            await fn(session, ev)
            # handler 自己 commit 过就不再 commit（避免把它的改动重复提交）；
            # 这里只兜"handler 什么都没做"的情况。
            if ev.status == "handling":
                await store.complete(session, ev)
            done += 1
        except Exception as exc:  # noqa: BLE001 —— 任何异常都要落成"这条失败了"
            logger.warning("事件处理失败（%s %s）：%s", ev.kind, ev.id, exc)
            await store.fail(session, ev, f"{type(exc).__name__}: {exc}")
            failed += 1

    return {
        "recovered": recovered,
        "claimed": len(events),
        "done": done,
        "failed": failed,
        "skipped": skipped,
    }
