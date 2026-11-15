"""影子助手（runtime=a2a）在**远端等人确认**之后的收尾。

场景：本地把消息转给远端，远端 agent 要调工具、按策略要人点确认（HITL）。
这时 `run_until_done` 会一直等到超时，然后返回 `waiting_hitl` —— 本地这条 run
就停在"等待确认"。人对面点了确认之后，远端会继续跑出终态，但**本地已经没人轮它了**，
答案就永远丢了（界面上看起来就是"卡住不动"）。

这里做两件事：
1. `arm()`：run 落成 waiting_hitl 时起一个后台轮询，出终态就把结果回填这条 run；
2. `sweep()`：进程重启后，把还没回填的 waiting_hitl 重新接上（定时任务里调）。

去重靠进程内集合：同一条 run 只起一个轮询，避免重启扫描和原轮询各写一次。
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select

from ..db import SessionLocal
from ..models import Run

logger = logging.getLogger(__name__)

#: 已经有人盯着轮询的 run（进程内去重）
_ACTIVE: set[str] = set()

#: 接手多久：默认 6 小时（人可能隔很久才回来点确认）
DEFAULT_WINDOW_S = 6 * 3600


def arm(run_id: str, remote_base: str, task_id: str, timeout_s: float = DEFAULT_WINDOW_S) -> bool:
    """给一条 waiting_hitl 的 run 起后台轮询。已有轮询在跑就不重复起。"""
    if not remote_base or not task_id:
        return False
    if run_id in _ACTIVE:
        return False
    _ACTIVE.add(run_id)

    async def _go() -> None:
        from .. import fanout

        try:
            await fanout._repoll_until_done(run_id, remote_base, task_id, timeout_s, None, None)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 —— 轮询失败不该影响别的执行
            logger.exception("A2A 等待确认的轮询出错（run=%s）", run_id)
        finally:
            _ACTIVE.discard(run_id)

    asyncio.create_task(_go())
    logger.info("A2A 接住等待确认的执行 %s（远端任务 %s）", run_id, task_id)
    return True


async def sweep() -> int:
    """重启后把还停在 waiting_hitl 的 a2a 执行重新接上。返回接手条数。"""
    armed = 0
    async with SessionLocal() as session:
        rows = (
            await session.execute(
                select(Run).where(Run.runtime == "a2a", Run.status == "waiting_hitl")
            )
        ).scalars().all()
    for row in rows:
        usage = row.usage or {}
        base = str(usage.get("remote_base") or "")
        task_id = str(usage.get("remote_task_id") or "")
        if arm(row.id, base, task_id):
            armed += 1
    if armed:
        logger.info("A2A 重新接手 %d 条等待确认的执行", armed)
    return armed
