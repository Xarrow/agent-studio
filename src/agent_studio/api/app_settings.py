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
    "guard_deny_patterns": list,
    # tool_search 稠密路的 embedding 端点（native_tools._toolsearch_embed_fn 读）
    "toolsearch_embedding": dict,
}

# 没设过时的默认值（前端拿到的就是它，不需要自己写一份默认）
DEFAULTS: dict[str, Any] = {
    "chat_quick_tags": ["询问是否完成", "先给结论", "详细说说", "整理成文档"],
    # 平台级命令黑名单：所有助手的 Bash/execute 都会拦（子串匹配）。
    # 与助手自己的 deny 规则叠加，谁也放不开。
    "guard_deny_patterns": ["shutdown", "reboot", "mkfs", "dd if=", ":(){", "crontab -r", "> /dev/sda"],
    # tool_search 的 embedding 端点：空 = 稠密路关闭，纯 BM25 照常工作
    "toolsearch_embedding": {},
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
    # toolsearch_embedding 的 api_key 是密文落库的（同凭据表标准）——
    # 读取侧永不回明文，也不回密文（密文出去=拿到 db 的人就能解），只回
    # 「已配置 + 掩码」；前端留空 = 保持原值。
    if key == "toolsearch_embedding" and isinstance(value, dict):
        value = _redact_embed_conf(value)
    return {"key": key, "value": value}


def _redact_embed_conf(conf: dict[str, Any]) -> dict[str, Any]:
    """把 toolsearch_embedding 配置里的密钥抹掉，只留可读特征。"""
    out = {k: v for k, v in conf.items() if k not in ("api_key", "api_key_enc")}
    enc = conf.get("api_key_enc")
    masked = ""
    if enc:
        try:
            from ..security.crypto import decrypt, mask

            masked = mask(decrypt(enc.encode() if isinstance(enc, str) else enc))
        except Exception:  # noqa: BLE001 —— 解不开就只报"已配置"
            masked = "已配置"
    out["api_key_masked"] = masked
    out["api_key_set"] = bool(enc)
    return out


@router.put("/{key}")
async def write_setting(
    key: str, body: SettingValue, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    if key not in ALLOWED:
        raise HTTPException(status_code=404, detail="unknown setting")
    expect = ALLOWED[key]
    if not isinstance(body.value, expect):
        raise HTTPException(status_code=400, detail=f"value must be {expect.__name__}")
    value = body.value
    # toolsearch_embedding：api_key 明文进门就加密（与 LLM 凭据同一套主密钥），
    # 明文不落库、不落日志；api_key 为空/缺省 = 保持原密钥。
    if key == "toolsearch_embedding" and isinstance(value, dict):
        value = await _merge_embed_conf(session, value)
    await set_setting(session, key, value)
    await session.commit()
    if key == "toolsearch_embedding":
        value = _redact_embed_conf(value)
    return {"key": key, "value": value}


async def _merge_embed_conf(
    session: AsyncSession, incoming: dict[str, Any]
) -> dict[str, Any]:
    from ..security.crypto import encrypt

    base_url = str(incoming.get("base_url") or "").strip()
    model = str(incoming.get("model") or "").strip()
    plain_key = str(incoming.get("api_key") or "").strip()
    if not (base_url and model):
        # 停用（回纯 BM25）：整体清空
        return {}
    merged: dict[str, Any] = {"base_url": base_url, "model": model}
    if plain_key:
        merged["api_key_enc"] = encrypt(plain_key).decode()
    else:
        prev = await get_setting(session, "toolsearch_embedding", None)
        prev = prev or {}
        if not prev.get("api_key_enc"):
            raise HTTPException(
                status_code=400, detail="api_key 为空且原配置无密钥——首次启用必须填 api_key"
            )
        merged["api_key_enc"] = prev["api_key_enc"]
    return merged
