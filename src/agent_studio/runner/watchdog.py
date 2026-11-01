"""Watchdog：把「在跑但没进展」的执行判死。

为什么要有
----------
分派树里最贵的失败不是"报错"，是"看起来还在跑"。一个在同一个工具上打转的执行
会把父执行一起拖到超时，而超时报告说的是"跑太久"——把人引到错误的排查方向。

判据是纯函数（``limits.stall_reason``），这里只负责取数据与落状态。

一条刻意的保守：**进程里还有它**就先不动。理由：真在跑的长任务被外部改状态，
等它自己写完库就会出现"状态 error 但产出正常"的岔子；而"进程里已经没有它、
库还写着 running"才是明确该判死的（和 boot 时的 reap_orphan_runs 是一类）。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy import select

from ..models import Run, ToolCall, now_ms
from ..limits import stall_reason

logger = logging.getLogger(__name__)

#: 只看跑够了这么久的执行（太新的还看不出停滞）
MIN_AGE_MS = 90_000


async def _marks_of(session: Any, run_id: str) -> list[dict[str, Any]]:
    rows = list(
        (
            await session.execute(
                select(ToolCall)
                .where(ToolCall.run_id == run_id)
                .order_by(ToolCall.iteration, ToolCall.id)
            )
        ).scalars()
    )
    return [
        {
            "tool": t.tool_name,
            "args": json.dumps(t.args or {}, ensure_ascii=False, sort_keys=True),
            "status": t.status,
        }
        for t in rows
    ]


async def sweep(session: Any, *, min_age_ms: int = MIN_AGE_MS) -> list[str]:
    """扫一遍 running 的执行，把停滞的判死；返回被判死的 run id。"""
    from ..runner import run_service

    now = now_ms()
    rows = list(
        (await session.execute(select(Run).where(Run.status == "running"))).scalars()
    )
    dead: list[str] = []
    for run in rows:
        if (now - int(run.started_at or now)) < min_age_ms:
            continue
        if run_service.is_running(run.id):
            # 进程里还在 —— 交给它自己收尾（外部改状态会和它的写入打架）
            continue
        reason = stall_reason(await _marks_of(session, run.id))
        if not reason:
            continue
        run.status = "error"
        run.error = f"停滞：{reason}（watchdog：进程已不在，状态判死）"
        run.ended_at = now
        dead.append(run.id)
    if dead:
        await session.commit()
        logger.warning("watchdog：判死 %d 条停滞执行（%s）", len(dead), "、".join(dead[:5]))
    return dead
