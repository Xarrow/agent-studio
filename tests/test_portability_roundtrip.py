"""导出/导入要「换台机器还能用」：引用必须重写成目标机的 id。

现场：把配置导到东京后，助手一保存就报一串「工具不存在：tl_xxx」，
因为这些 tl_ 是源机器的行 id —— 导出只带了名字列表，定义里的 ref 没换。
凭据同理：原先刻意剥掉 credential_ref，导入后助手根本跑不了。

这条测试守的就是：导出时把 ref 连同它的名字一起带上；导入时按名字换成
本机 id；凭据/会话一起搬过去。
"""

from __future__ import annotations

import pytest


async def _mk(client, name: str) -> dict:
    r = await client.post(
        "/api/agents", json={"name": name, "definition": {"runtime": "agentscope", "name": name}}
    )
    assert r.status_code in (200, 201), r.text
    return r.json()


async def _mk_tool(client, name: str) -> str:
    r = await client.post(
        "/api/tools",
        json={
            "kind": "http",
            "name": name,
            "description": "测试工具",
            "input_schema": {"type": "object", "properties": {}},
            "impl": {"method": "GET", "url": "https://example.com"},
        },
    )
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


@pytest.mark.asyncio
async def test_导出带引用名字_导入后重写成本机_id(client):
    agent = await _mk(client, "portability-src")
    tool_id = await _mk_tool(client, "portability-tool")

    # 把工具挂到助手上（定义里的 ref 指向这个 tl_ id）
    put = await client.put(
        f"/api/agents/{agent['id']}",
        json={
            "name": agent["name"],
            "definition": {
                "runtime": "agentscope",
                "name": agent["name"],
                "tools": [{"ref": tool_id, "enabled": True}],
            },
        },
    )
    assert put.status_code in (200, 201), put.text

    bundle = (await client.get("/api/export?include_secrets=1&include_sessions=0")).json()
    src = next(a for a in bundle["agents"] if a["name"] == "portability-src")
    # 导出必须带上「这个 ref 叫什么」，否则目标机无法按名字接
    assert src["tool_refs"] and src["tool_refs"][0]["name"] == "portability-tool"
    assert "portability-tool" in src["tools"]

    imp = await client.post("/api/import", json={"bundle": bundle})
    assert imp.status_code == 200, imp.text
    body = imp.json()
    assert body["ok"] is True
    created = next(a for a in body["agents"] if a["name"] == "portability-src")

    got = (await client.get(f"/api/agents/{created['id']}")).json()
    refs = got["definition"]["tools"]
    assert refs, "导入后的助手应当仍挂着工具"
    # 关键：ref 必须是本机存在的工具 id（不是源机器那个）
    tools = (await client.get("/api/tools")).json()
    ids = {t["id"] for t in tools}
    for r in refs:
        assert r["ref"] in ids, f"导入后的 ref 在本机不存在：{r['ref']}"
        assert r["ref"] != tool_id or tool_id in ids


@pytest.mark.asyncio
async def test_导出导入会话内容(client):
    agent = await _mk(client, "portability-chat")
    sess = await client.post("/api/sessions", json={"agent_id": agent["id"], "title": "带走这段对话"})
    sid = sess.json()["id"]

    from agent_studio.db import SessionLocal
    from agent_studio.models import SessionMessage

    async with SessionLocal() as db:
        db.add(SessionMessage(session_id=sid, turn_index=1, role="user", content="你好", ts=1700000000000))
        db.add(SessionMessage(session_id=sid, turn_index=1, role="assistant", content="在", ts=1700000000001))
        await db.commit()

    bundle = (await client.get("/api/export?include_sessions=1")).json()
    mine = next(s for s in bundle["sessions"] if s["title"] == "带走这段对话")
    assert len(mine["messages"]) == 2
    assert mine["agent"] == "portability-chat"

    imp = (await client.post("/api/import", json={"bundle": bundle})).json()
    assert imp["ok"] is True

    # 导入端应当出现一条同名会话，且消息条数一致
    sessions = (await client.get("/api/sessions?limit=200")).json()
    copies = [s for s in sessions if s["title"] == "带走这段对话"]
    assert len(copies) >= 2
    copy_id = max(copies, key=lambda s: s["created_at"])["id"]
    detail = (await client.get(f"/api/sessions/{copy_id}")).json()
    assert [m["content"] for m in detail["messages"]] == ["你好", "在"]


@pytest.mark.asyncio
async def test_导出带明文密钥_导入后可解密使用(client):
    from agent_studio.db import SessionLocal
    from agent_studio.models import Secret
    from agent_studio.security.crypto import encrypt, decrypt
    from agent_studio.models import now_ms

    async with SessionLocal() as db:
        db.add(
            Secret(
                name="portability-cred",
                provider="openai",
                base_url="https://example.com/v1",
                default_model="m",
                ciphertext=encrypt("sk-portable-test"),
                created_at=now_ms(),
            )
        )
        await db.commit()

    bundle = (await client.get("/api/export?include_secrets=1")).json()
    cred = next(c for c in bundle["credentials"] if c["name"] == "portability-cred")
    assert cred["api_key"] == "sk-portable-test"

    await client.post("/api/import", json={"bundle": bundle})
    async with SessionLocal() as db:
        rows = (await db.execute(__import__("sqlalchemy").select(Secret))).scalars().all()
    same = [r for r in rows if r.name == "portability-cred"]
    assert same and decrypt(same[0].ciphertext) == "sk-portable-test"
