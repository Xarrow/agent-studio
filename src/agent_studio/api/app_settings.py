"""平台级小配置的读写出口。

为什么要有这一层
----------------
`app_setting` 表里躺着好几个模块自己的开关（币种、外部记忆地址…）。前端不能
拿着「任意键随便改」的通行证，所以这里只放**白名单**：想开放一个键，就在
`ALLOWED` 里加一行，键不存在直接 404。

目前只有对话页的快捷标签（quick tags）—— 它们要跟着人走（换设备还在），
放 localStorage 就丢了。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..settings_store import get_setting, set_setting

router = APIRouter(prefix="/api/app-settings", tags=["app-settings"])

# 键 -> 期望的 JSON 类型；同时也是「能不能被界面改」的白名单
ALLOWED: dict[str, type] = {
    "chat_quick_tags": list,
}

# 没设过时的默认值（前端拿到的就是它，不需要自己写一份默认）
DEFAULTS: dict[str, Any] = {
    "chat_quick_tags": ["询问是否完成", "先给结论", "详细说说", "整理成文档"],
}


class SettingValue(BaseModel):
    value: Any


@router.get("/{key}")
async def read_setting(
    key: str, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    if key not in ALLOWED:
        raise HTTPException(status_code=404, detail="unknown setting")
    value = await get_setting(session, key, None)
    if value is None:
        value = DEFAULTS.get(key)
    return {"key": key, "value": value}


@router.put("/{key}")
async def write_setting(
    key: str, body: SettingValue, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    if key not in ALLOWED:
        raise HTTPException(status_code=404, detail="unknown setting")
    expect = ALLOWED[key]
    if not isinstance(body.value, expect):
        raise HTTPException(status_code=400, detail=f"value must be {expect.__name__}")
    await set_setting(session, key, body.value)
    await session.commit()
    return {"key": key, "value": body.value}
