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


#: 远端自注册用的口令（自注册端点对公网放行，靠它挡住随便乱塞）
REGISTER_TOKEN_KEY = "remote_register_token"


async def ensure_register_token(rotate: bool = False) -> str:
    """取自注册口令；没有就生成一个（``rotate=True`` 强制换新）。

    单独一把、和全站口令分开：把口令给远端，等于允许它往注册表里推**它自己**，
    不该连带着把整个平台的控制权递出去。轮换只需重取一次（旧的立刻失效）。
    """
    import secrets as _secrets

    from .db import SessionLocal

    async with SessionLocal() as session:
        cur = await get_setting(session, REGISTER_TOKEN_KEY, "")
        if isinstance(cur, str) and cur and not rotate:
            return cur
        token = _secrets.token_urlsafe(24)
        await set_setting(session, REGISTER_TOKEN_KEY, token)
        await session.commit()
        return token


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
