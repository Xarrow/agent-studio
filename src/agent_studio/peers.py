"""节点联邦：把一个**别的 Agent Studio** 接进来，并把它开放的助手同步成本地的远端助手。

和原有「单个远端 agent 注册」的关系
====================================
原来的办法是"粘一个 agent 的卡片地址 → 解析 → 落一条 remote_agent"。
节点是它的**上一层**：连上一个节点，就把它所有开放的助手一次性同步过来，
以后再同步只拉差异。两者写同一张 remote_agent 表，靠 ``peer_id`` 区分来源 ——
所以助手页的绑定、影子 agent、调用记录、探活全都不用改。

三条用户拍板的规则（写在这里，免得以后改代码时忘掉）
====================================================
1. **心跳方向**：对方的地址是内网（192.168./10./172.16-31/localhost）就**不发心跳** ——
   内网地址从公网侧根本连不进去，发了也是白发。反过来，由对端主动发心跳给我，
   那一刻就证明"它已经感知到我的存在，可以调我的助手"，我据此把它标成在线。
2. **双向注册**：握手时我带上自己的名片与开放助手；对端收到后落一条 **pending** 记录，
   由对端的人在页面上点"接受"才成立（不是谁都能把自己塞进别人的列表）。
3. **各自的成本各自记**：同步与调用都不涉及计费换算。
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
import time
from typing import Any
from urllib.parse import urlparse

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import remote_agents, studio_identity
from .db import SessionLocal
from .models import Agent, RemoteAgent, StudioPeer, now_ms

logger = logging.getLogger(__name__)

#: 心跳间隔（秒）。对端在线状态 60s 内可见，够用又不吵。
HEARTBEAT_S = 60
#: 连续失败几次才标离线（沿用远端探活的口径：一次抖动不算）
OFFLINE_AFTER = 2


# --------------------------------------------------------------------------- #
# 地址判定
# --------------------------------------------------------------------------- #
def normalize_base(url: str) -> str:
    """把用户粘的地址归一成 base（去掉 /a2a、卡片路径、多余斜杠）。"""
    raw = (url or "").strip()
    if not raw:
        raise ValueError("地址不能为空")
    if not raw.startswith(("http://", "https://")):
        raw = "https://" + raw
    p = urlparse(raw)
    path = p.path.rstrip("/")
    for tail in ("/.well-known/agent-card.json", "/a2a"):
        if path.endswith(tail):
            path = path[: -len(tail)]
    return f"{p.scheme}://{p.netloc}{path}".rstrip("/")


def is_private(base_url: str) -> bool:
    """对方是不是内网地址 —— 决定要不要由我发心跳。

    口径：IP 字面量按私有网段判；主机名解析不到就**当公网**（宁可多发一次心跳，
    也不要因为 DNS 抖动就让对方一直显示"离线"）。
    """
    host = urlparse(base_url).hostname or ""
    if not host:
        return True
    if host in ("localhost", "127.0.0.1", "::1"):
        return True
    try:
        ip = ipaddress.ip_address(host)
        return bool(ip.is_private or ip.is_loopback or ip.is_link_local)
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        if not (ip.is_private or ip.is_loopback or ip.is_link_local):
            return False
    return bool(infos)


# --------------------------------------------------------------------------- #
# 读取对端
# --------------------------------------------------------------------------- #
async def fetch_card(base: str, timeout: float = 6.0) -> dict[str, Any]:
    """读对端名片。失败一律给**人话**（页面上要能直接显示）。"""
    # 带 __t 穿透 CDN 缓存：隧道后面可能坐着 Cloudflare，GET 会被边缘缓存
    url = f"{base}/api/studio/card?__t={int(time.time() * 1000)}"
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp = await client.get(url, headers={"Cache-Control": "no-cache"})
    except httpx.TimeoutException as exc:
        raise ValueError(f"连不上（{timeout:.0f} 秒超时）：{base}") from exc
    except httpx.HTTPError as exc:
        raise ValueError(f"连不上：{exc}") from exc
    if resp.status_code == 401 or resp.status_code == 403:
        raise ValueError("对方拒绝访问（可能开了访问口令）—— 需要在同一个网络里直连")
    if resp.status_code == 404:
        raise ValueError("这个地址上没有 /api/studio/card —— 它可能不是 Agent Studio，或版本太旧")
    if resp.status_code >= 400:
        raise ValueError(f"对方返回 {resp.status_code}")
    try:
        card = resp.json()
    except ValueError as exc:
        raise ValueError("对方返回的不是 JSON（大概率不是 Agent Studio）") from exc
    if not card.get("studio_id"):
        raise ValueError("对方名片里没有 studio_id —— 版本太旧，无法建立节点关系")
    return card


async def fetch_agents(base: str, timeout: float = 8.0) -> list[dict[str, Any]]:
    url = f"{base}/api/studio/agents?__t={int(time.time() * 1000)}"
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        resp = await client.get(url, headers={"Cache-Control": "no-cache"})
    if resp.status_code >= 400:
        raise ValueError(f"读对方助手清单失败：HTTP {resp.status_code}")
    return list((resp.json() or {}).get("agents") or [])


# --------------------------------------------------------------------------- #
# 连接 / 同步
# --------------------------------------------------------------------------- #
async def connect(
    session: AsyncSession, url: str, *, mutual: bool = True, name: str | None = None
) -> tuple[StudioPeer, list[str]]:
    """连上一个节点：读名片 → 落 peer → 同步开放助手。

    返回 (peer, 提示行)。提示行给页面显示"少了什么"（比如双向没推成功）。
    """
    base = normalize_base(url)
    card = await fetch_card(base)
    if card["studio_id"] == (await studio_identity.get_identity())["id"]:
        raise ValueError("这是当前这个节点自己的地址")

    peers = (await session.execute(select(StudioPeer))).scalars().all()
    same = next((p for p in peers if p.studio_id == card["studio_id"]), None)
    if same is not None and same.status in ("active", "pending"):
        return same, [f"已经连过了：{same.name}"]

    notes: list[str] = []
    heartbeat = not is_private(base)
    if not heartbeat:
        notes.append("对方是内网地址：不会由我发心跳，等它来感知我")

    if same is None:
        peer = StudioPeer(
            studio_id=card["studio_id"],
            name=(name or card.get("name") or base)[:120],
            base_url=base,
            direction="both" if mutual else "out",
            status="active",
            fingerprint=card.get("fingerprint") or "",
            agents_count=int(card.get("agents_open") or 0),
            heartbeat=heartbeat,
            last_seen_at=now_ms(),
        )
        session.add(peer)
        await session.flush()
    else:  # 之前被撤销/拒绝过，这里重连 = 复活
        peer = same
        peer.base_url = base
        peer.status = "active"
        peer.heartbeat = heartbeat
        peer.updated_at = now_ms()
    await session.commit()

    added = await sync_peer(session, peer)
    notes.append(f"已同步 {len(added)} 个开放助手")

    if mutual:
        try:
            await push_self(peer)
            notes.append("已把我的名片推给对端（等对方接受）")
        except ValueError as exc:
            peer.direction = "out"
            await session.commit()
            notes.append(f"没能推给对端（改为一向）：{exc}")
    return peer, notes


async def push_self(peer: StudioPeer) -> dict[str, Any]:
    """把我的名片 + 开放助手推给对端，让对方那边出现一条待接受的连接。"""
    ident = await studio_identity.get_identity()
    async with SessionLocal() as s:
        opened = (
            await s.execute(select(Agent).where(Agent.expose_remote.is_(True)))
        ).scalars().all()
    agents = [
        {"id": a.id, "name": a.name, "description": a.description or "", "version": a.version}
        for a in opened
    ]
    payload = {
        "studio": {
            "studio_id": ident["id"],
            "name": ident["name"],
            "version": "0.1.0",
        },
        "agents": agents,
    }
    try:
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            resp = await client.post(f"{peer.base_url}/api/studio/handshake", json=payload)
    except httpx.HTTPError as exc:
        raise ValueError(f"推不过去：{exc}") from exc
    if resp.status_code >= 400:
        raise ValueError(f"对方返回 {resp.status_code}")
    return resp.json() if resp.content else {}


async def sync_peer(session: AsyncSession, peer: StudioPeer) -> list[str]:
    """把对端**开放**的助手同步到本地 remote_agent（按 peer_id 归属）。

    语义：
    * 新增 → 建 remote_agent（走原有 resolve，卡片快照一致）+ 建工具行 + 影子 agent
    * 已在 → 更新名字/版本/说明（不覆盖用户改过的本地名字）
    * 对端不再开放 → 置 enabled=False（不删：历史调用记录还挂着它）
    """
    agents = await fetch_agents(peer.base_url)
    existing = {
        (r.remote_agent_id or r.url): r
        for r in (
            await session.execute(select(RemoteAgent).where(RemoteAgent.peer_id == peer.id))
        ).scalars()
    }
    touched: list[str] = []
    for item in agents:
        card_url = item.get("a2a_card_url") or ""
        endpoint = item.get("a2a_endpoint") or ""
        # resolve() 期望的是**base**（它自己拼 /.well-known/agent-card.json）；
        # 直接把卡片地址塞进去会拼成 .../agent-card.json/.well-known/agent-card.json
        base = endpoint[:-4] if endpoint.endswith("/a2a") else card_url.split("/.well-known/")[0]
        if not base:
            continue
        row = existing.pop(item["id"], None)
        if row is not None:
            row.name = row.name or item.get("name") or row.name
            row.parsed = {
                **(row.parsed or {}),
                "name": item.get("name"),
                "description": item.get("description"),
                "version": item.get("version"),
            }
            row.enabled = True
            row.updated_at = now_ms()
            touched.append(row.name)
            continue
        try:
            got = await remote_agents.resolve(base)
        except Exception as exc:  # noqa: BLE001 —— 一个助手失败不该毁掉整次同步
            logger.warning("同步远端助手失败：%s（%s）", item.get("name"), exc)
            continue
        parsed = got["parsed"]
        fresh = RemoteAgent(
            name=(item.get("name") or parsed["name"] or got["base"])[:120],
            url=got["base"],
            card=got["card"],
            parsed=parsed,
            remote_agent_id=item["id"],
            peer_id=peer.id,
            peer_studio_id=peer.studio_id,
            status="ok",
            last_checked_at=now_ms(),
            last_ok_at=now_ms(),
            enabled=True,
            note=item.get("note") or "",
        )
        session.add(fresh)
        await session.flush()
        tool = await remote_agents.upsert_tool(session, fresh)
        fresh.tool_id = tool.id
        touched.append(fresh.name)

    # 对端已经不再开放的：停用（留着历史）
    for row in existing.values():
        row.enabled = False
        row.updated_at = now_ms()

    peer.agents_count = len(agents)
    peer.fingerprint = "sha256:" + str(abs(hash(tuple(sorted(a["id"] for a in agents)))))[:16]
    peer.last_sync_at = now_ms()
    peer.updated_at = now_ms()
    await session.commit()
    return touched


# --------------------------------------------------------------------------- #
# 心跳
# --------------------------------------------------------------------------- #
async def heartbeat_tick() -> dict[str, Any]:
    """定时任务里的一步：给"我能连上、且它是公网"的对端发心跳。

    内网对端一律不发（用户拍板的口径）：那种关系由**对端主动发心跳**来维持，
    收到即代表"它已经感知到我、可以调我的助手"。
    """
    stamp = now_ms()
    sent = 0
    flipped: list[dict[str, Any]] = []
    async with SessionLocal() as session:
        peers = (
            await session.execute(
                select(StudioPeer).where(StudioPeer.status.in_(("active", "offline")))
            )
        ).scalars().all()
        if not peers:
            return {"sent": 0, "flipped": []}

        ident = await studio_identity.get_identity()
        payload = {"studio_id": ident["id"], "name": ident["name"], "at": stamp}

        async def _beat(peer: StudioPeer) -> None:
            nonlocal sent
            if not peer.heartbeat:
                return
            if peer.last_seen_at and stamp - peer.last_seen_at < HEARTBEAT_S * 1000:
                return
            try:
                async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
                    resp = await client.post(f"{peer.base_url}/api/studio/heartbeat", json=payload)
                if resp.status_code >= 400:
                    raise ValueError(f"HTTP {resp.status_code}")
                sent += 1
                before = peer.status
                peer.status = "active"
                peer.last_seen_at = stamp
                peer.fail_count = 0
                if before != "active":
                    flipped.append({"name": peer.name, "before": before, "after": "active"})
            except Exception as exc:  # noqa: BLE001
                peer.fail_count = (peer.fail_count or 0) + 1
                if peer.fail_count >= OFFLINE_AFTER and peer.status != "offline":
                    flipped.append({"name": peer.name, "before": peer.status, "after": "offline"})
                    peer.status = "offline"
                logger.info("节点心跳失败：%s（%s）", peer.name, exc)

        await asyncio.gather(*[_beat(p) for p in peers], return_exceptions=True)
        await session.commit()
    return {"sent": sent, "flipped": flipped}


async def inbound_handshake(payload: dict[str, Any]) -> dict[str, Any]:
    """收到别的 Studio 的握手：落一条 **pending**，等本机的人点接受。"""
    studio = payload.get("studio") or {}
    sid = (studio.get("studio_id") or "").strip()
    if not sid:
        raise ValueError("握手缺少 studio_id")
    me = (await studio_identity.get_identity())["id"]
    if sid == me:
        raise ValueError("这是自己发回来的握手")

    async with SessionLocal() as session:
        row = (
            await session.execute(select(StudioPeer).where(StudioPeer.studio_id == sid))
        ).scalars().first()
        if row is None:
            row = StudioPeer(
                studio_id=sid,
                name=(studio.get("name") or sid)[:120],
                base_url="",  # 对端没告诉我它的地址：等它自报，或我从来源推断
                direction="in",
                status="pending",
                agents_count=len(payload.get("agents") or []),
            )
            session.add(row)
        elif row.status != "active":
            row.status = "pending"  # 被拒绝过又来找：重新进待办
        row.last_seen_at = now_ms()
        row.updated_at = now_ms()
        await session.commit()
        name = row.name
    logger.info("收到节点握手：%s（%s）", name, sid)
    return {"ok": True, "studio_id": (await studio_identity.get_identity())["id"], "status": "pending"}


async def inbound_heartbeat(payload: dict[str, Any]) -> dict[str, Any]:
    """收到对端心跳 = 它已经感知到我、可以调我的助手。据此维持在线。"""
    sid = (payload.get("studio_id") or "").strip()
    if not sid:
        raise ValueError("心跳缺少 studio_id")
    async with SessionLocal() as session:
        row = (
            await session.execute(select(StudioPeer).where(StudioPeer.studio_id == sid))
        ).scalars().first()
        if row is None:
            return {"ok": False, "reason": "unknown_studio"}
        before = row.status
        row.status = "active"
        row.last_seen_at = now_ms()
        row.fail_count = 0
        if not row.base_url:
            row.base_url = ""
        await session.commit()
        flipped = before != "active"
    return {"ok": True, "flipped": flipped}
