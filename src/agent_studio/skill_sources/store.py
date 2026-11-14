"""仓库来源（SourceDef）的存储与读写。

存库里而不是配置文件：它要能被界面改、跟着数据一起备份/迁移，并且**导出时
绝不带凭据**（令牌单独加密存 token_enc，导出只给"需要重填"的清单）。

与官方 CLI 锁文件的关系：两套记录互不覆盖 —— 我们的记录写在技能的
``source`` JSON 里（skill.source），不写任何 ``skills-lock.json``。
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Boolean, Integer, JSON, LargeBinary, String, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from ..models import Base, now_ms, new_id

KINDS = ("git", "archive", "local", "index")


class SkillSource(Base):
    __tablename__ = "skill_source"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("ss_"))
    workspace_id: Mapped[str] = mapped_column(String(32), default="ws_default", index=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    kind: Mapped[str] = mapped_column(String(16), default="git")
    address: Mapped[str] = mapped_column(String(600), default="")
    host: Mapped[str] = mapped_column(String(200), default="")
    owner: Mapped[str] = mapped_column(String(200), default="")
    repo: Mapped[str] = mapped_column(String(200), default="")
    ref: Mapped[str] = mapped_column(String(120), default="")
    subpath: Mapped[str] = mapped_column(String(400), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    priority: Mapped[int] = mapped_column(Integer, default=100)
    #: 令牌密文（AES-GCM，见 security/crypto.py）—— 导出时不带
    token_enc: Mapped[bytes | None] = mapped_column(LargeBinary, default=None)
    #: 该来源自己的网络策略覆盖（空 = 用全局）
    net_policy: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    tags: Mapped[list[Any]] = mapped_column(JSON, default=list)
    note: Mapped[str] = mapped_column(String(600), default="")
    created_at: Mapped[int] = mapped_column(Integer, default=now_ms)
    updated_at: Mapped[int] = mapped_column(Integer, default=now_ms)


@dataclass
class SourceInput:
    name: str = ""
    kind: str = "git"
    address: str = ""
    ref: str = ""
    subpath: str = ""
    enabled: bool = True
    priority: int = 100
    token: str = ""
    net_policy: dict[str, Any] | None = None
    tags: list[str] | None = None
    note: str = ""


def public(row: SkillSource) -> dict[str, Any]:
    """给界面/API：**不含令牌**，只说有没有。"""
    return {
        "id": row.id,
        "name": row.name,
        "kind": row.kind,
        "address": row.address,
        "host": row.host,
        "owner": row.owner,
        "repo": row.repo,
        "ref": row.ref,
        "subpath": row.subpath,
        "enabled": bool(row.enabled),
        "priority": int(row.priority or 0),
        "has_token": bool(row.token_enc),
        "net_policy": dict(row.net_policy or {}),
        "tags": list(row.tags or []),
        "note": row.note,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


async def list_sources(session: AsyncSession, *, enabled_only: bool = False) -> list[SkillSource]:
    q = select(SkillSource).order_by(SkillSource.priority.asc(), SkillSource.created_at.asc())
    if enabled_only:
        q = q.where(SkillSource.enabled.is_(True))
    return list((await session.execute(q)).scalars())


async def get_source(session: AsyncSession, sid: str) -> SkillSource | None:
    return await session.get(SkillSource, sid)


async def create_source(session: AsyncSession, data: SourceInput, *, host: str, owner: str, repo: str) -> SkillSource:
    row = SkillSource(
        name=data.name.strip() or f"{owner}/{repo}" or host or "来源",
        kind=data.kind,
        address=data.address,
        host=host,
        owner=owner,
        repo=repo,
        ref=data.ref,
        subpath=data.subpath,
        enabled=data.enabled,
        priority=data.priority,
        net_policy=data.net_policy or {},
        tags=list(data.tags or []),
        note=data.note,
    )
    if data.token:
        from ..security.crypto import encrypt

        row.token_enc = encrypt(data.token)
    session.add(row)
    await session.flush()
    return row


async def update_source(session: AsyncSession, row: SkillSource, data: SourceInput) -> SkillSource:
    row.name = data.name.strip() or row.name
    row.kind = data.kind or row.kind
    row.address = data.address or row.address
    row.ref = data.ref
    row.subpath = data.subpath
    row.enabled = data.enabled
    row.priority = data.priority
    row.net_policy = data.net_policy or {}
    row.tags = list(data.tags or [])
    row.note = data.note
    if data.token == "__clear__":
        row.token_enc = None
    elif data.token:
        from ..security.crypto import encrypt

        row.token_enc = encrypt(data.token)
    row.updated_at = now_ms()
    await session.flush()
    return row


def token_of(row: SkillSource) -> str:
    if not row.token_enc:
        return ""
    try:
        from ..security.crypto import decrypt

        return decrypt(row.token_enc)
    except Exception:  # noqa: BLE001 - 解不开就按没有处理，不让整个操作崩
        return ""


# --------------------------------------------------------------------------- #
# 设置项键名（存 AppSetting，界面可改）
# --------------------------------------------------------------------------- #
MODE_KEY = "skills_mode"                 # auto | npx | native
NPX_PIN_KEY = "skills_npx_pin"           # 空 = 未配置固定版本（auto 时优先原生）
NPX_ALLOW_LATEST_KEY = "skills_npx_latest"
NET_KEY = "skills_net_policy"
PLATFORMS_KEY = "skills_platforms"
CHECK_INTERVAL_KEY = "skills_check_interval_h"   # 默认 6 小时
TELEMETRY_OFF_KEY = "skills_telemetry_off"       # 委托模式是否关遥测

DEFAULT_CHECK_INTERVAL_H = 6


def epoch_ms() -> int:
    return int(time.time() * 1000)
