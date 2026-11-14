"""节点级对外接口：让另一个 Agent Studio 知道"我是谁、我有哪些助手可以调"。

为什么单独一组端点（不塞进 remote_agents）
=========================================
``/api/remote-agents/*`` 是**管理面**（我这边怎么管远端），需要全站口令；
而这里是对端来读的**发现面**：对方在别的机器上、拿不到我的全站口令，
所以按前缀放行（与 /api/hooks、/api/remote-agents/self 同一口径）。

两个端点就够了：
* ``GET /api/studio/card``   —— 我是谁（id/名字/版本/地址/指纹）
* ``GET /api/studio/agents`` —— 我开放了哪些助手（含各自的 A2A 地址）

按用户口径：**不追求鉴权强度**，节点身份本身就是凭据；开放的助手才出现，
没开的一个字节都不给。
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import studio_identity
from ..db import get_session
from ..models import Agent

logger = logging.getLogger(__name__)

router = APIRouter(tags=["studio"])


def _base_url(request: Request) -> str:
    """对端看到的我的地址。优先 X-Forwarded-*（隧道/反代后取不到真实 scheme）。"""
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}".rstrip("/")


def _agent_view(agent: Agent, base: str) -> dict[str, Any]:
    defn = agent.definition or {}
    return {
        "id": agent.id,
        "name": agent.name,
        "description": agent.description or defn.get("role") or "",
        "version": agent.version,
        "updated_at": agent.updated_at,
        # 发现入口（卡片）+ 执行入口（JSON-RPC）
        "a2a_card_url": f"{base}/.well-known/agents/{agent.id}/agent-card.json",
        "a2a_endpoint": f"{base}/a2a",
        "note": agent.expose_note or "",
        "skills": [
            s.get("name") for s in (defn.get("skills") or []) if isinstance(s, dict) and s.get("name")
        ][:12],
    }


def _fingerprint(agents: list[dict[str, Any]]) -> str:
    """开放助手的指纹：对端拿它判断"要不要重新同步"，比时间戳可靠。"""
    raw = json.dumps(
        sorted((a["id"], a["version"], a["name"]) for a in agents), ensure_ascii=False
    )
    return "sha256:" + hashlib.sha256(raw.encode()).hexdigest()[:16]


async def _open_agents(session: AsyncSession) -> list[Agent]:
    rows = (
        await session.execute(
            select(Agent).where(Agent.expose_remote.is_(True)).order_by(Agent.name)
        )
    ).scalars().all()
    return list(rows)


@router.get("/api/studio/card")
async def studio_card(request: Request, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """节点名片：对端握手时先读这个。"""
    ident = await studio_identity.get_identity()
    opened = await _open_agents(session)
    views = [_agent_view(a, _base_url(request)) for a in opened]
    total = (await session.execute(select(Agent))).scalars().all()
    from .. import __version__

    return {
        "studio_id": ident["id"],
        "name": ident["name"],
        "version": __version__,
        "base_url": _base_url(request),
        "protocol": "studio/1",
        "agents_total": len(list(total)),
        "agents_open": len(views),
        "fingerprint": _fingerprint(views),
        "created_at": ident.get("created_at"),
    }


@router.get("/api/studio/agents")
async def studio_agents(
    request: Request,
    open_only: bool = Query(default=True, description="只回开放的（对端默认口径）"),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """我这边可被远程调用的助手清单。

    ``open_only=0`` 只在**本机管理页**用（看自己全量），对端拿不到。
    """
    base = _base_url(request)
    rows = await _open_agents(session) if open_only else (
        await session.execute(select(Agent).order_by(Agent.name))
    ).scalars().all()
    views = [_agent_view(a, base) for a in rows]
    return {
        "studio_id": (await studio_identity.get_identity())["id"],
        "count": len(views),
        "fingerprint": _fingerprint(views),
        "agents": views,
    }


@router.post("/api/studio/name")
async def rename_studio(payload: dict[str, Any]) -> dict[str, Any]:
    """改节点显示名（id 不变 —— 对端靠 id 认人）。"""
    return await studio_identity.set_name(str(payload.get("name") or ""))
