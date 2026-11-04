"""可靠性护栏：可配置的止损/软预算/门禁开关。

为什么是配置而不是代码常量：这几档的"对"的值跟任务形态强相关
（调研类要放宽失败次数，改文件类要收紧），不同部署的容忍度也不同。
放在 app_setting（KV），改完立刻生效、跟着数据备份 —— 与
quota.py 的日额度/树预算同一套机制。

每一档都带 ``choices``（枚举）：界面上只让选、不让手打，避免拍脑袋值。
``0`` / ``off`` 永远表示「关掉这个护栏」。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from .settings_store import get_setting, set_setting

#: 单个工具连续失败几次后注入「止损系统注」（0 = 关）
STOP_LOSS_KEY = "reliability_stop_loss_fails"
STOP_LOSS_CHOICES: tuple[int, ...] = (0, 2, 3, 5)

#: 全程多少次调用无任何成功就合成 blocked 上报（0 = 关）
DEAD_END_KEY = "reliability_dead_end_calls"
DEAD_END_CHOICES: tuple[int, ...] = (0, 5, 8, 12)

#: 软预算：用到超时的几成时注入「开始收尾」提示（0 = 关；100 = 永不触发）
SOFT_BUDGET_PCT_KEY = "reliability_soft_budget_pct"
SOFT_BUDGET_CHOICES: tuple[int, ...] = (0, 60, 80, 90)

#: 超时/中止时回收部分产出（partial 正文）供重派续跑（on / off）
PARTIAL_KEY = "reliability_partial_recovery"
PARTIAL_CHOICES: tuple[str, ...] = ("off", "on")


DEFAULTS: dict[str, Any] = {
    STOP_LOSS_KEY: 3,          # 连续 3 次同名工具失败 → 注入止损提示
    DEAD_END_KEY: 0,           # 默认关：死路判定保守一些，先只开提示
    SOFT_BUDGET_PCT_KEY: 80,   # 默认开：用到 80% 提示收尾
    PARTIAL_KEY: "on",         # 默认开：超时不再全损
}


async def get_reliability(session: AsyncSession) -> dict[str, Any]:
    """读全量（含 choices 与默认值）—— 界面和引擎共用这一份。"""
    raw = {k: await get_setting(session, k, DEFAULTS[k]) for k in DEFAULTS}
    return {
        "stop_loss": {
            "value": int(raw[STOP_LOSS_KEY]),
            "choices": list(STOP_LOSS_CHOICES),
        },
        "dead_end": {
            "value": int(raw[DEAD_END_KEY]),
            "choices": list(DEAD_END_CHOICES),
        },
        "soft_budget": {
            "value": int(raw[SOFT_BUDGET_PCT_KEY]),
            "choices": list(SOFT_BUDGET_CHOICES),
        },
        "partial": {
            "value": str(raw[PARTIAL_KEY]),
            "choices": list(PARTIAL_CHOICES),
        },
    }


async def set_reliability(session: AsyncSession, patch: dict[str, int | str]) -> dict[str, Any]:
    """改任意几档：只收 choices 里的值（非法值按默认处理，不抛错打回去 —— 界面只会发合法值）。"""
    allowed: dict[str, tuple] = {
        "stop_loss": STOP_LOSS_CHOICES,
        "dead_end": DEAD_END_CHOICES,
        "soft_budget": SOFT_BUDGET_CHOICES,
        "partial": PARTIAL_CHOICES,
    }
    key_of = {
        "stop_loss": STOP_LOSS_KEY,
        "dead_end": DEAD_END_KEY,
        "soft_budget": SOFT_BUDGET_PCT_KEY,
        "partial": PARTIAL_KEY,
    }
    for name, val in patch.items():
        if name in allowed and val in allowed[name]:
            await set_setting(session, key_of[name], val)
    await session.commit()
    return await get_reliability(session)
