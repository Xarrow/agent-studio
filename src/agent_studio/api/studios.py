"""节点管理面（我自己怎么管对端）+ 对端来敲门的那两个端点。

分工
====
* ``/api/studios/*``  —— **管理面**：列表/连接/同步/接受/拒绝/移除。走全站口令。
* ``/api/studio/handshake``、``/api/studio/heartbeat`` —— **对端来敲门**：
  对端在别的机器上，拿不到我的口令，所以挂在``/api/studio/``这个免口令前缀下
  （与 /api/studio/card 同一口径）。它们的语义很窄：只写"待接受的连接"与"我还在"，
  不能读任何业务数据。
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import peers
from ..db import get_session
from ..models import RemoteAgent, StudioPeer, now_ms

logger = logging.getLogger(__name__)

router = APIRouter(tags=["studios"])
inbound = APIRouter(tags=["studio"])


def _view(peer: StudioPeer, agent_count: int) -> dict[str, Any]:
    return {
        "id": peer.id,
        "studio_id": peer.studio_id,
        "name": peer.name,
        "base_url": peer.base_url,
        "direction": peer.direction,
        "status": peer.status,
        "fingerprint": peer.fingerprint,
        "agents_count": peer.agents_count,
        "agents_synced": agent_count,
        "heartbeat": bool(peer.heartbeat),
        "fail_count": peer.fail_count or 0,
        "last_seen_at": peer.last_seen_at,
        "last_sync_at": peer.last_sync_at,
        "last_error": peer.last_error or "",
        "note": peer.note or "",
        "created_at": peer.created_at,
    }


@router.get("")
async def list_peers(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    rows = (await session.execute(select(StudioPeer).order_by(StudioPeer.created_at))).scalars().all()
    counts = {
        p: n
        for p, n in (
            await session.execute(
                select(RemoteAgent.peer_id, func.count())
                .where(RemoteAgent.peer_id.is_not(None))
                .group_by(RemoteAgent.peer_id)
            )
        ).all()
    }
    return {"peers": [_view(p, counts.get(p.id, 0)) for p in rows]}


@router.post("/preview")
async def preview_peer(payload: dict[str, Any]) -> dict[str, Any]:
    """连之前先看一眼：能不能连、它是谁、开放了哪些助手。不写库。"""
    url = str(payload.get("url") or "")
    try:
        base = peers.normalize_base(url)
        card = await peers.fetch_card(base)
        agents = await peers.fetch_agents(base)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return {
        "base_url": base,
        "studio_id": card.get("studio_id"),
        "name": card.get("name"),
        "version": card.get("version"),
        "agents_open": card.get("agents_open"),
        "agents": [
            {"id": a["id"], "name": a.get("name"), "description": a.get("description")}
            for a in agents
        ],
        "private": peers.is_private(base),
    }


@router.post("", status_code=status.HTTP_201_CREATED)
async def connect_peer(payload: dict[str, Any], session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    try:
        peer, notes = await peers.connect(
            session,
            str(payload.get("url") or ""),
            mutual=bool(payload.get("mutual", True)),
            name=payload.get("name"),
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return {"peer": _view(peer, peer.agents_count), "notes": notes}


@router.get("/{peer_id}/agents")
async def peer_agents(peer_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """点开一个节点时看它下面有哪些助手（已同步到本地的这些）。

    数据来自本地 remote_agent（带 peer_id），不打对端 —— 点开不该等网络。
    要最新的就点「同步」。
    """
    peer = await session.get(StudioPeer, peer_id)
    if peer is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "节点不存在")
    rows = (
        await session.execute(
            select(RemoteAgent).where(RemoteAgent.peer_id == peer.id).order_by(RemoteAgent.name)
        )
    ).scalars().all()

    # 点开节点要给"远程的详情"：顺手再读一次对端名片（带 __t 穿透缓存）。
    # 读不到不算失败 —— 详情页降级显示本地已知信息 + 一行原因，助手列表照常给。
    remote: dict[str, Any] | None = None
    remote_error = ""
    stale = False
    if not peer.base_url:
        # 对方连我但没给回连地址（内网节点就是这样：公网连不回去）——
        # 这不是错误，是网络模型决定的，页面上要说人话而不是报"连不上"
        remote_error = "对方没有提供可回连的地址（内网节点不会自报公网地址）"
    if peer.base_url:
        try:
            card = await peers.fetch_card(peer.base_url, timeout=8.0)
            peer.card = card          # 存快照：下次连不上也能看
            peer.updated_at = now_ms()
            await session.commit()
            remote = {
                "studio_id": card.get("studio_id"),
                "name": card.get("name"),
                "version": card.get("version"),
                "protocol": card.get("protocol"),
                "base_url": card.get("base_url"),
                "agents_total": card.get("agents_total"),
                "agents_open": card.get("agents_open"),
                "fingerprint": card.get("fingerprint"),
                "created_at": card.get("created_at"),
                "card_url": f"{peer.base_url.rstrip('/')}/api/studio/card",
                "agents_url": f"{peer.base_url.rstrip('/')}/api/studio/agents",
            }
        except ValueError as exc:
            remote_error = str(exc)
            cached = peer.card or {}
            if cached.get("studio_id"):
                stale = True
                remote = {
                    "studio_id": cached.get("studio_id"),
                    "name": cached.get("name"),
                    "version": cached.get("version"),
                    "protocol": cached.get("protocol"),
                    "base_url": cached.get("base_url") or peer.base_url,
                    "agents_total": cached.get("agents_total"),
                    "agents_open": cached.get("agents_open"),
                    "fingerprint": cached.get("fingerprint"),
                    "created_at": cached.get("created_at"),
                    "card_url": f"{peer.base_url.rstrip('/')}/api/studio/card",
                    "agents_url": f"{peer.base_url.rstrip('/')}/api/studio/agents",
                }

    return {
        "peer": _view(peer, len(rows)),
        "remote": remote,
        "remote_error": remote_error,
        "remote_stale": stale,
        "agents": [
            {
                "id": r.id,
                "name": r.name,
                "description": (r.parsed or {}).get("description") or "",
                "version": (r.parsed or {}).get("version"),
                "status": r.status,
                "enabled": bool(r.enabled),
                "url": r.url,
                "card_url": (r.parsed or {}).get("card_url") or "",
                "remote_agent_id": r.remote_agent_id,
                "skills": [
                    (k.get("name") if isinstance(k, dict) else str(k))
                    for k in ((r.parsed or {}).get("skills") or [])
                    if (k.get("name") if isinstance(k, dict) else k)
                ][:20],
                "note": r.note or "",
                "last_ok_at": r.last_ok_at,
                "last_checked_at": r.last_checked_at,
                "last_error": r.last_error or "",
            }
            for r in rows
        ],
    }


@router.post("/{peer_id}/sync")
async def sync_peer(peer_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    peer = await session.get(StudioPeer, peer_id)
    if peer is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "节点不存在")
    if not peer.base_url:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "还不知道这个节点的地址（等它先连过来）")
    try:
        touched = await peers.sync_peer(session, peer)
    except ValueError as exc:
        peer.last_error = str(exc)
        await session.commit()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return {"synced": touched, "count": len(touched)}


@router.post("/{peer_id}/accept")
async def accept_peer(
    peer_id: str,
    payload: dict[str, Any] | None = None,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """接受对方的连接请求。带 url 时顺手把它同步进来（它没自报地址时用）。"""
    body = payload or {}
    url = str(body.get("url") or "").strip()
    peer = await session.get(StudioPeer, peer_id)
    if peer is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "节点不存在")
    if url:
        peer.base_url = peers.normalize_base(url)
    peer.status = "active"
    peer.updated_at = now_ms()
    await session.commit()
    if peer.base_url:
        try:
            await peers.sync_peer(session, peer)
        except ValueError as exc:
            peer.last_error = str(exc)
            await session.commit()
    await session.refresh(peer)
    return {"peer": _view(peer, peer.agents_count)}


@router.post("/{peer_id}/reject")
async def reject_peer(peer_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    peer = await session.get(StudioPeer, peer_id)
    if peer is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "节点不存在")
    peer.status = "rejected"
    peer.updated_at = now_ms()
    await session.commit()
    return {"ok": True}


@router.delete("/{peer_id}")
async def remove_peer(peer_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """移除节点：连带把它同步过来的远端助手删掉（工具行与影子 agent 交给原有清理逻辑）。"""
    peer = await session.get(StudioPeer, peer_id)
    if peer is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "节点不存在")
    rows = (
        await session.execute(select(RemoteAgent).where(RemoteAgent.peer_id == peer.id))
    ).scalars().all()
    for row in rows:
        await session.delete(row)
    name = peer.name
    await session.delete(peer)
    await session.commit()
    return {"ok": True, "removed": len(rows), "name": name}


# --------------------------------------------------------------------------- #
# 对端来敲门（免口令；只写"待接受"与"我还在"）
# --------------------------------------------------------------------------- #
@inbound.post("/api/studio/handshake")
async def handshake(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return await peers.inbound_handshake(payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc


@inbound.post("/api/studio/heartbeat")
async def heartbeat(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return await peers.inbound_heartbeat(payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
