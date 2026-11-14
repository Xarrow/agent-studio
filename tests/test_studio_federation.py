"""节点联邦（Studio ↔ Studio）第一层：身份、名片、开放开关。

语义验收点：
  1. studio_id 生成后**不变**（重复读同一个 id，即使进程内换了名字）
  2. `/api/studio/card` 报出 id/名字/开放数量/指纹，且**不需要全站口令**
  3. `/api/studio/agents` 默认只回**开放**的助手（未开放的一个字节都不给）
  4. 助手未开放时，按 id 取卡片 403；开放后 200
  5. 只改 expose_remote **不产生新版本**（否则每点一次开关就是一次"版本变更"）
  6. A2A 执行入口对未开放助手给 E_NOT_EXPOSED，而不是"助手不存在"
"""

from __future__ import annotations

from agent_studio import studio_identity
from agent_studio.api.a2a import E_NOT_EXPOSED
from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Agent


async def _seed() -> tuple[str, str]:
    """幂等播种：同一个测试库里多次调用只落一份（名字唯一约束）。"""
    from sqlalchemy import select

    await init_db()
    async with SessionLocal() as s:
        existing = {
            r.name: r.id
            for r in (await s.execute(select(Agent).where(Agent.name.in_(["开放助手甲", "封闭助手乙"])))).scalars()
        }
        if len(existing) == 2:
            return existing["开放助手甲"], existing["封闭助手乙"]
        ids = []
        for name, expose in (("开放助手甲", True), ("封闭助手乙", False)):
            if name in existing:
                ids.append(existing[name])
                continue
            row = Agent(
                slug=name,
                name=name,
                description=f"{name} 的说明",
                runtime="agentscope",
                version=3,
                definition={"name": name, "role": f"{name} 的说明", "skills": [{"name": "web-search"}]},
                expose_remote=expose,
                expose_note="仅限文档解析" if expose else "",
            )
            s.add(row)
            ids.append(row.id)
        await s.commit()
        return ids[0], ids[1]


async def test_identity_is_stable() -> None:
    a = await studio_identity.get_identity()
    b = await studio_identity.get_identity()
    assert a["id"].startswith("stu_")
    assert a["id"] == b["id"]
    # 改名不动 id —— 对端靠 id 认人
    renamed = await studio_identity.set_name("测试节点")
    assert renamed["id"] == a["id"]
    assert renamed["name"] == "测试节点"


async def test_card_and_open_agents(client) -> None:
    await _seed()
    card = (await client.get("/api/studio/card")).json()
    assert card["studio_id"].startswith("stu_")
    assert card["protocol"] == "studio/1"
    assert card["agents_open"] >= 1
    assert card["fingerprint"].startswith("sha256:")

    listed = (await client.get("/api/studio/agents")).json()
    names = [a["name"] for a in listed["agents"]]
    assert "开放助手甲" in names
    assert "封闭助手乙" not in names
    item = next(a for a in listed["agents"] if a["name"] == "开放助手甲")
    assert item["a2a_card_url"].endswith("/agent-card.json")
    assert item["a2a_endpoint"].endswith("/a2a")
    assert item["note"] == "仅限文档解析"

    # 本机管理口径可以看全量
    everything = (await client.get("/api/studio/agents?open_only=false")).json()
    assert "封闭助手乙" in [a["name"] for a in everything["agents"]]


async def test_card_gate_follows_switch(client) -> None:
    open_id, closed_id = await _seed()
    ok = await client.get(f"/.well-known/agents/{open_id}/agent-card.json")
    assert ok.status_code == 200

    blocked = await client.get(f"/.well-known/agents/{closed_id}/agent-card.json")
    assert blocked.status_code == 403
    assert "开放" in blocked.json()["detail"]

    # 打开开关 → 立刻可读；且**版本号不变**
    before = (await client.get(f"/api/agents/{closed_id}")).json()["version"]
    put = await client.put(
        f"/api/agents/{closed_id}",
        json={"expose_remote": True, "expose_note": "只读问答"},
    )
    assert put.status_code == 200
    assert put.json()["version"] == before
    assert put.json()["expose_remote"] is True
    assert put.json()["expose_note"] == "只读问答"

    assert (await client.get(f"/.well-known/agents/{closed_id}/agent-card.json")).status_code == 200

    # 再关掉 → 立刻 403（开关即权限，不等缓存过期）
    await client.put(f"/api/agents/{closed_id}", json={"expose_remote": False})
    assert (await client.get(f"/.well-known/agents/{closed_id}/agent-card.json")).status_code == 403


async def test_a2a_dispatch_rejects_unexposed(client) -> None:
    _, closed_id = await _seed()
    resp = await client.post(
        "/a2a",
        json={
            "jsonrpc": "2.0",
            "id": "1",
            "method": "message/send",
            "params": {
                "agentId": closed_id,
                "message": {"role": "user", "parts": [{"kind": "text", "text": "你好"}]},
            },
        },
    )
    body = resp.json()
    assert body["error"]["code"] == E_NOT_EXPOSED
    assert "开放" in body["error"]["message"]
