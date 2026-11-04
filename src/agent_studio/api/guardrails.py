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
from ..reliability import get_reliability
from ..quota import (
    DAILY_LIMIT_CHOICES,
    DEPTH_CHOICES,
    TREE_BUDGET_CHOICES,
    daily_quota,
    get_depth_limit,
    get_tree_budget,
    set_daily_limit,
    set_depth_limit,
    set_tree_budget,
)

router = APIRouter(prefix="/api/guardrails", tags=["guardrails"])


@router.get("")
async def read_guardrails(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """护栏现状：今日用量 + 两个上限（外加可选档位 —— 界面上只让选、不让手打）。"""
    daily = await daily_quota(session)
    depth = await get_depth_limit(session)
    tree = await get_tree_budget(session)
    return {
        "daily": {**daily, "choices": list(DAILY_LIMIT_CHOICES)},
        "depth": {"limit": depth, "choices": list(DEPTH_CHOICES)},
        # 一棵分派树最多花多少（0 = 不限）。为什么单独一档：日额度是"这一天"的闸，
        # 它是"这一件事"的闸 —— 一棵写坏了的树能在一小时里把一天用光。
        "tree": {"limit": int(tree or 0), "choices": list(TREE_BUDGET_CHOICES)},
        "reliability": await get_reliability(session),
    }


@router.get("/reliability")
async def read_reliability(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """可靠性护栏现状（止损/死路/软预算/partial 回收）—— 每档带可选枚举。"""
    from ..reliability import get_reliability

    return await get_reliability(session)


@router.put("/reliability")
async def update_reliability(
    patch: dict[str, int | str] = Body(..., description="要改的档位；只收界面给出的枚举值"),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """改可靠性护栏（改完立刻生效：下一次工具失败/预算检查就按新值判）。"""
    from ..reliability import set_reliability

    await set_reliability(session, patch)
    return await read_guardrails(session)  # 全量返回：前端直接覆盖状态，不做二次拼装


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


@router.put("/tree")
async def update_tree_budget(
    limit: int = Body(..., embed=True, description="一棵分派树最多花多少 token；0 = 不限"),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """设「一棵树最多花多少」。超了只拦**新的派发**，在跑的不打断。"""
    await set_tree_budget(session, limit)
    return await read_guardrails(session)
