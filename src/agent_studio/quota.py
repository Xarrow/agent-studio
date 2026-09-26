"""每日额度护栏：今天最多用多少 token，超了就不再起**新的**执行。

为什么需要它
------------
分派让"一个任务分几路跑"变得便宜，也让"把额度烧光"变得容易 ——
定时任务 + 外部触发 + 几路并行，而且**没人盯着**。这是平台自己的兜底护栏，
不是给用户看的指标：它不预估、不猜，只按**今天真花掉的 token** 掐真数。

语义（刻意选最不容易误伤的那种）
--------------------------------
· **按天**：本地时区 00:00 重置。
· **平台级**：这是单机自托管平台，不按人分账。
· **到顶只拦"新起的执行"**，正在跑的不打断 —— 把跑了一半的活砍掉更浪费，
  而且用户看到的会是"莫名失败"。被拦的那条会**写明原因和下一步**（何时重置、去哪调）。
· **默认不限**：不设上限 = 现状不变；由用户在界面上选一档（枚举，不让手打数字）。
"""

from __future__ import annotations

import logging
import time
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Run, now_ms
from .pricing import tokens_of
from .settings_store import get_setting, set_setting

logger = logging.getLogger(__name__)

#: 平台级配置键（存在 app_setting，改完立刻生效、跟着数据备份）
DAILY_LIMIT_KEY = "daily_token_limit"
DEPTH_LIMIT_KEY = "max_fanout_depth"

#: 界面上给的那几档（枚举 —— 让用户选，不让手打）
DAILY_LIMIT_CHOICES: tuple[int, ...] = (0, 10_000, 50_000, 200_000, 500_000, 1_000_000)

#: 分派深度：默认 1 层（实例不再分派）；2 层是可选项，代价明确写在界面上
DEPTH_CHOICES: tuple[int, ...] = (1, 2)


def _local_midnight_ms() -> int:
    """今天 00:00（本地时区）的时间戳 —— "今天用了多少"的口径必须与用户一致。"""
    lt = time.localtime()
    zero = time.struct_time((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, lt.tm_wday, lt.tm_yday, lt.tm_isdst))
    return int(time.mktime(zero) * 1000)


def _next_midnight_ms() -> int:
    return _local_midnight_ms() + 24 * 3600 * 1000


def human_tokens(n: int) -> str:
    """给用户看的数量：12.3万 / 1.05M —— 截图和日志里都得是人能读的。"""
    n = int(n or 0)
    if n >= 100_000_000:
        return f"{n / 100_000_000:.2f}亿"
    if n >= 10_000:
        return f"{n / 10_000:.1f}万"
    return str(n)


async def get_daily_limit(session: AsyncSession) -> int:
    """今天最多用多少 token；``0`` = 不限（默认）。"""
    raw = await get_setting(session, DAILY_LIMIT_KEY, 0)
    try:
        return max(0, int(raw or 0))
    except (TypeError, ValueError):
        return 0


async def set_daily_limit(session: AsyncSession, limit: int) -> int:
    limit = max(0, int(limit or 0))
    await set_setting(session, DAILY_LIMIT_KEY, limit)
    await session.commit()
    return limit


async def today_used(session: AsyncSession) -> int:
    """今天真花掉的 token（输入+输出）—— 按执行的开始时间归日。

    为什么用 ``tokens_of``：它同时认平台的 ``tokens_in/out`` 和 provider 原始字段，
    用别的口径算出来的数会和界面上"这条用了多少"对不上（用户一眼就看出矛盾）。
    """
    rows = (
        await session.execute(
            select(Run.usage).where(Run.started_at.is_not(None), Run.started_at >= _local_midnight_ms())
        )
    ).scalars()
    total = 0
    for usage in rows:
        tin, tout = tokens_of(usage or {})
        total += int(tin) + int(tout)
    return total


async def daily_quota(session: AsyncSession) -> dict[str, Any]:
    """给界面用的一份快照：用了多少 / 上限多少 / 到没到顶 / 什么时候重置。"""
    limit = await get_daily_limit(session)
    used = await today_used(session)
    exceeded = bool(limit) and used >= limit
    return {
        "used": used,
        "limit": limit,
        "exceeded": exceeded,
        "reset_at": _next_midnight_ms(),
        "message": (
            f"今日额度已用完（已用 {human_tokens(used)} / 上限 {human_tokens(limit)}）。"
            "已在跑的会跑完；新的执行要等明天 00:00 重置，或者到 Playground 顶栏把上限调高。"
            if exceeded
            else ""
        ),
    }


async def check_daily_quota(session: AsyncSession) -> dict[str, Any]:
    """执行**开始时**调一次：到顶就返回 ``exceeded=True``（调用方负责拦下并写原因）。"""
    return await daily_quota(session)


async def get_depth_limit(session: AsyncSession) -> int:
    """允许的分派层数（默认 1）。"""
    raw = await get_setting(session, DEPTH_LIMIT_KEY, 1)
    try:
        return max(1, min(2, int(raw or 1)))
    except (TypeError, ValueError):
        return 1


async def set_depth_limit(session: AsyncSession, depth: int) -> int:
    depth = max(1, min(2, int(depth or 1)))
    await set_setting(session, DEPTH_LIMIT_KEY, depth)
    await session.commit()
    return depth


def now_ms_export() -> int:
    """（给调用方图省事的小出口，避免各处再 import 一遍。）"""
    return now_ms()
