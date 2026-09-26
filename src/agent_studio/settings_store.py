"""平台级小配置（键值对）。

为什么单独一张表而不是写进配置文件
----------------------------------
这些值要**能被界面改**（比如「单价用哪个币种」），而配置文件在部署侧、
改了要重启。放在库里 = 改完立刻生效、跟着数据一起备份/迁移。
它装的是**平台自己的偏好**，不是业务数据 —— 所以刻意做得很小：
一个键、一个 JSON 值、一个更新时间。业务实体（助手/流程/凭据）都各有自己的表。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import AppSetting, now_ms


async def get_setting(session: AsyncSession, key: str, default: Any = None) -> Any:
    """读一个配置；没有就返回 ``default``（不写库 —— 读操作不该有副作用）。"""
    row = (
        await session.execute(select(AppSetting).where(AppSetting.key == key))
    ).scalar_one_or_none()
    return default if row is None else row.value


async def set_setting(session: AsyncSession, key: str, value: Any) -> None:
    """写一个配置（有则改、无则建）。调用方负责 commit。"""
    row = (
        await session.execute(select(AppSetting).where(AppSetting.key == key))
    ).scalar_one_or_none()
    if row is None:
        session.add(AppSetting(key=key, value=value, updated_at=now_ms()))
    else:
        row.value = value
        row.updated_at = now_ms()
