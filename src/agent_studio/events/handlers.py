"""事件处理器：把"发生了什么"翻译成"所以呢"。

这里的每个 handler 都要求一件东西：**跑完以后，人能在界面上多知道一件事**。
只往库里写一行、界面永远看不到的 handler 不算（那只是把日志换了个表）。
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Event, now_ms
from .worker import register

logger = logging.getLogger(__name__)

#: 三类拦截各自"下一步该做什么"。写在服务端而不是前端：
#: 前端拿到的 payload 里就有能直接显示的话，不用自己拼、也不用随前端改文案。
_HINTS = {
    "budget": "这棵树的额度用完了。到「Runs → 今日用量 → 每棵树」调高，或者先把已有产出收口。",
    "cycle": "它已经在这棵树的链上了，再派就是死循环。换一个助手，或者让这一步自己做完。",
    "duplicate": "同一棵树里同一个助手已经做过这个任务。要看新结果，得显式允许重复。",
}

_TITLES = {
    "budget": "派发被拦：树额度用完",
    "cycle": "派发被拦：会成环",
    "duplicate": "派发被拦：重复任务",
}


@register("worker.report")
async def _worker_report(session: AsyncSession, ev: Event) -> None:
    """worker 上报 → 投递给派活方（Router）。

    投递动作在 worker_events.deliver_to_router（steer 直注 / 唤醒轮 / 留账）。
    结果写回 payload：界面上能看到每条上报「走的是哪条路、到没到」。
    handler 抛异常会走账本重试（lease 回收后再投）——投递失败不丢事件。
    """
    from .. import worker_events

    payload = dict(ev.payload or {})
    result = await worker_events.deliver_to_router(payload)
    payload["delivery"] = result
    payload["surfaced"] = result.get("route") in ("steer", "wakeup")
    ev.payload = payload
    ev.status = "done"
    ev.ended_at = now_ms()
    await session.commit()
    logger.info(
        "worker 上报已投递：%s → %s（%s）",
        payload.get("agent_name", "?"), result.get("route"), result.get("note", "")[:60],
    )


@register("fanout.blocked")
async def _fanout_blocked(session: AsyncSession, ev: Event) -> None:
    """一次分派被护栏拦下 → 落一条待办（含"下一步怎么办"）。

    为什么必须落成待办：拦截发生在模型调工具的那一瞬间，用户看到的是
    "这一步失败了"；真正的原因（预算/成环/重复）只在日志里 —— 不搬到界面上，
    用户只会以为"助手又抽风了"，然后重试，再被拦，再重试。
    """
    payload = dict(ev.payload or {})
    kind = str(payload.get("blocked") or "")
    payload["title"] = _TITLES.get(kind, "派发被拦")
    payload["hint"] = _HINTS.get(kind, "去看这一路的输出，按提示调整后再派。")
    payload["surfaced"] = True
    ev.payload = payload
    ev.status = "done"
    ev.ended_at = now_ms()
    await session.commit()
    logger.info("待办：%s（%s）", payload["title"], payload.get("reason", "")[:80])
