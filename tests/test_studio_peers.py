"""节点联邦：地址归一、内网判定、握手待接受、心跳维持在线、同步落库。

这一层最容易被"看起来能跑"骗过去（网络请求在测试里全是假的），
所以每条用例都断言**数据库里的最终状态**，而不是函数返回值。
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from agent_studio import peers, studio_identity
from agent_studio.db import SessionLocal, init_db
from agent_studio.models import RemoteAgent, StudioPeer


def test_normalize_base() -> None:
    assert peers.normalize_base("as.example.com") == "https://as.example.com"
    assert peers.normalize_base("https://as.example.com/a2a") == "https://as.example.com"
    assert (
        peers.normalize_base("https://as.example.com/.well-known/agent-card.json")
        == "https://as.example.com"
    )
    assert peers.normalize_base("http://1.2.3.4:8848/") == "http://1.2.3.4:8848"
    with pytest.raises(ValueError):
        peers.normalize_base("  ")


def test_is_private() -> None:
    # 内网 → 由对端发心跳（我方不发）
    assert peers.is_private("http://192.168.2.11:8848")
    assert peers.is_private("http://10.0.0.5:8848")
    assert peers.is_private("http://127.0.0.1:8848")
    assert peers.is_private("http://localhost:8848")
    # 公网域名/IP → 我方发心跳
    assert not peers.is_private("https://as.example.com")
    assert not peers.is_private("http://47.116.77.212")


async def test_inbound_handshake_creates_pending() -> None:
    await init_db()
    me = (await studio_identity.get_identity())["id"]
    out = await peers.inbound_handshake(
        {
            "studio": {"studio_id": "stu_remote_demo", "name": "客户 A 的 Studio", "version": "0.1.0"},
            "agents": [{"id": "ag_1", "name": "合同审查"}],
        }
    )
    assert out["status"] == "pending"

    async with SessionLocal() as s:
        row = (
            await s.execute(select(StudioPeer).where(StudioPeer.studio_id == "stu_remote_demo"))
        ).scalars().first()
        assert row is not None
        assert row.status == "pending"
        assert row.direction == "in"
        assert row.agents_count == 1

    # 自己发回来的握手要拒绝
    with pytest.raises(ValueError):
        await peers.inbound_handshake({"studio": {"studio_id": me}})


async def test_inbound_heartbeat_keeps_active() -> None:
    await init_db()
    async with SessionLocal() as s:
        row = StudioPeer(
            studio_id="stu_beat", name="心跳对端", base_url="https://x.example.com",
            direction="out", status="offline",
        )
        s.add(row)
        await s.commit()

    got = await peers.inbound_heartbeat({"studio_id": "stu_beat"})
    assert got["ok"] is True and got["flipped"] is True
    async with SessionLocal() as s:
        row = (await s.execute(select(StudioPeer).where(StudioPeer.studio_id == "stu_beat"))).scalars().first()
        assert row.status == "active"
        assert row.fail_count == 0
        assert row.last_seen_at

    # 未知节点的心跳不改任何东西
    assert (await peers.inbound_heartbeat({"studio_id": "stu_nobody"}))["ok"] is False


async def test_connect_and_sync(monkeypatch: pytest.MonkeyPatch) -> None:
    """连节点 → 同步助手：开放两个，其中一个解析失败也不该整次失败。"""
    await init_db()
    # 同一进程里的库里可能已有上一轮留下的同名节点（测试共享一个临时库）：
    # 用随机 id 保证这次一定是"新节点"，否则会走到"已经连过"的分支
    sid = f"stu_sync_{uuid.uuid4().hex[:8]}"

    async def fake_card(base: str, timeout: float = 6.0) -> dict:
        return {
            "studio_id": sid,
            "name": "同步演示节点",
            "version": "0.1.0",
            "agents_open": 2,
            "fingerprint": "sha256:abc",
        }

    async def fake_agents(base: str, timeout: float = 8.0) -> list[dict]:
        return [
            {"id": "ag_a", "name": "合同审查", "a2a_card_url": "https://p.example.com/.well-known/agents/ag_a/agent-card.json"},
            {"id": "ag_b", "name": "报价比对", "a2a_card_url": "https://p.example.com/.well-known/agents/ag_b/agent-card.json"},
        ]

    calls: list[str] = []

    async def fake_card_of(card_url: str, base: str) -> dict:
        # 同步时传的是 base（两个助手同一个 base），所以只能按调用次序区分：
        # 第一个成功、第二个模拟远端 500 —— 一个失败不该拖垮整次同步
        calls.append(card_url)
        if len(calls) == 2:
            raise RuntimeError("远端卡片 500")
        return {"base": "https://p.example.com", "parsed": {"name": "合同审查"}, "card": {"name": "合同审查"}}

    class _Tool:
        id = "tl_fake"

    async def fake_upsert(session, row):
        return _Tool()

    monkeypatch.setattr(peers, "fetch_card", fake_card)
    monkeypatch.setattr(peers, "fetch_agents", fake_agents)
    monkeypatch.setattr(peers, "_card_of", fake_card_of)
    monkeypatch.setattr(peers.remote_agents, "upsert_tool", fake_upsert)

    async with SessionLocal() as s:
        peer, notes = await peers.connect(s, "https://p.example.com", mutual=False)
        assert peer.studio_id == sid
        assert peer.status == "active"
        assert peer.direction == "out"
        # 公网地址 → 由我方发心跳
        assert peer.heartbeat is True
        assert any("已同步 1 个" in n for n in notes)
        assert peer.agents_count == 2

    async with SessionLocal() as s:
        rows = (await s.execute(select(RemoteAgent).where(RemoteAgent.peer_id == peer.id))).scalars().all()
        assert [r.name for r in rows] == ["合同审查"]
        assert rows[0].peer_studio_id == sid
        assert rows[0].enabled is True

    # 重连同一个节点不重复建 peer
    async with SessionLocal() as s:
        again, notes2 = await peers.connect(s, "https://p.example.com", mutual=False)
        assert again.id == peer.id
        assert any("已经连过" in n for n in notes2)


async def test_private_peer_gets_no_heartbeat(monkeypatch: pytest.MonkeyPatch) -> None:
    """内网对端：不发心跳（等它来找我）—— 这是用户拍板的那条规则。"""
    await init_db()

    async def fake_card(base: str, timeout: float = 6.0) -> dict:
        return {"studio_id": "stu_lan_demo", "name": "内网节点", "version": "0.1.0", "agents_open": 0}

    async def fake_agents(base: str, timeout: float = 8.0) -> list[dict]:
        return []

    monkeypatch.setattr(peers, "fetch_card", fake_card)
    monkeypatch.setattr(peers, "fetch_agents", fake_agents)

    async with SessionLocal() as s:
        peer, notes = await peers.connect(s, "http://192.168.2.11:8848", mutual=False)
        assert peer.heartbeat is False
        assert any("内网" in n for n in notes)


async def test_peer_agents_returns_remote_card_and_caches(monkeypatch: pytest.MonkeyPatch) -> None:
    """点开节点要能拿到"远程的详情"：名片读到就存快照，读不到就用快照并标 stale。"""
    await init_db()
    sid = f"stu_detail_{uuid.uuid4().hex[:8]}"

    async def fake_card(base: str, timeout: float = 6.0) -> dict:
        return {
            "studio_id": sid,
            "name": "详情节点",
            "version": "0.1.0",
            "protocol": "studio/1",
            "agents_total": 9,
            "agents_open": 1,
            "fingerprint": "sha256:abc",
        }

    async def fake_agents(base: str, timeout: float = 8.0) -> list[dict]:
        return []

    monkeypatch.setattr(peers, "fetch_card", fake_card)
    monkeypatch.setattr(peers, "fetch_agents", fake_agents)

    async with SessionLocal() as s:
        peer, _ = await peers.connect(s, "https://detail.example.com", mutual=False)
        peer_id = peer.id
        assert (peer.card or {}).get("studio_id") == sid

    # 读得到：remote 有内容、不 stale
    from agent_studio.api import studios as studios_api

    async with SessionLocal() as s:
        got = await studios_api.peer_agents(peer_id, session=s)
    assert got["remote"]["name"] == "详情节点"
    assert got["remote_stale"] is False

    # 读不到：降级用快照，标 stale，不抛错
    async def boom(base: str, timeout: float = 8.0) -> dict:
        raise ValueError("连不上（8 秒超时）")

    monkeypatch.setattr(peers, "fetch_card", boom)
    async with SessionLocal() as s:
        got2 = await studios_api.peer_agents(peer_id, session=s)
    assert got2["remote"]["name"] == "详情节点"
    assert got2["remote_stale"] is True
    assert "超时" in got2["remote_error"]
