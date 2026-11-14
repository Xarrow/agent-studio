"""这个 Agent Studio 的"身份证"—— 节点联邦的第一块砖。

为什么要它
==========
两个 Studio 互相认领时，靠 URL 认人是不行的：同一台机器可能换了 IP、换了隧道域名，
靠地址判断"这是不是上次那台"必然出错。所以需要一个**生成后就不变**的 studio_id。

口径（用户拍板）
================
* 首次启动时算一个候选值（machine-id + 主机名 + 端口），**落库后永不改变**；
* 换机 = 新节点（这是明确接受的代价，不做自动迁移）；
* 名称默认取主机名，可在页面上改，改名字不影响 id。

为什么不把 IP 放进 id：家用宽带重拨一次就会换身份，对端列表里凭空多一台"陌生节点"，
历史调用记录全断。IP 只作为"候选种子"，落库后不再参与。
"""

from __future__ import annotations

import hashlib
import logging
import os
import socket
from typing import Any

from .db import SessionLocal
from .models import AppSetting, now_ms

logger = logging.getLogger(__name__)

KEY = "studio.identity"


def _machine_seed() -> str:
    """机器指纹：优先 /etc/machine-id（跨重启稳定），退到主机名 + MAC。"""
    for p in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        try:
            text = open(p, encoding="utf-8").read().strip()
            if text:
                return text
        except OSError:
            continue
    import uuid

    return f"{socket.gethostname()}-{uuid.getnode()}"


def _candidate() -> dict[str, Any]:
    port = os.getenv("PORT", "8848")
    seed = f"{_machine_seed()}|{socket.gethostname()}|{port}"
    sid = "stu_" + hashlib.sha256(seed.encode()).hexdigest()[:16]
    return {
        "id": sid,
        # 名称只是显示用：默认主机名，用户可改
        "name": socket.gethostname() or "Agent Studio",
        "created_at": now_ms(),
    }


async def get_identity() -> dict[str, Any]:
    """读身份；没有就生成并落库（幂等，并发下也只会有一个赢）。"""
    async with SessionLocal() as db:
        row = await db.get(AppSetting, KEY)
        if row is not None and isinstance(row.value, dict) and row.value.get("id"):
            return row.value
        ident = _candidate()
        if row is None:
            db.add(AppSetting(key=KEY, value=ident, updated_at=now_ms()))
        else:
            row.value = ident
            row.updated_at = now_ms()
        await db.commit()
        logger.info("节点身份已生成：%s（%s）", ident["id"], ident["name"])
        return ident


async def set_name(name: str) -> dict[str, Any]:
    """改显示名（id 不变——id 是对端认人的依据）。"""
    ident = await get_identity()
    clean = (name or "").strip()[:60]
    if not clean:
        return ident
    ident = {**ident, "name": clean}
    async with SessionLocal() as db:
        row = await db.get(AppSetting, KEY)
        if row is None:
            db.add(AppSetting(key=KEY, value=ident, updated_at=now_ms()))
        else:
            row.value = ident
            row.updated_at = now_ms()
        await db.commit()
    return ident
