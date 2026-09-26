"""平台护栏：每日额度（最多花多少 token）+ 分派层数。

为什么放在一个端点里
--------------------
这两个都是**平台级护栏**（不是某个助手/某条流程的属性），而且用户会在同一个
心思下调整它们："别让它在没人看着的时候把额度烧光"。所以读写也放在一起，
界面上就是顶栏那一颗「今日用量」点开之后的两个枚举。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..quota import (
    DAILY_LIMIT_CHOICES,
    DEPTH_CHOICES,
    daily_quota,
    get_depth_limit,
    set_daily_limit,
    set_depth_limit,
)

router = APIRouter(prefix="/api/guardrails", tags=["guardrails"])


@router.get("")
async def read_guardrails(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """护栏现状：今日用量 + 两个上限（外加可选档位 —— 界面上只让选、不让手打）。"""
    daily = await daily_quota(session)
    depth = await get_depth_limit(session)
    return {
        "daily": {**daily, "choices": list(DAILY_LIMIT_CHOICES)},
        "depth": {"limit": depth, "choices": list(DEPTH_CHOICES)},
    }


@router.put("/daily")
async def update_daily_limit(
    limit: int = Body(..., embed=True, description="今日 token 上限；0 = 不限"),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """设「今天最多用多少」（改完立刻生效：下一次执行的入口就会按它判）。"""
    await set_daily_limit(session, limit)
    return await read_guardrails(session)


@router.put("/depth")
async def update_depth_limit(
    limit: int = Body(..., embed=True, description="允许的分派层数（1 或 2）"),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """设「允许分派几层」。默认 1；2 层会成倍放大调用量，界面上会说明代价。"""
    await set_depth_limit(session, limit)
    return await read_guardrails(session)
