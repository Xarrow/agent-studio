"""MCP 的 env / headers 必须加密落盘。

为什么单开一个测试：这两个字段以前是明文进 SQLite 的 —— 备份、复制库、发个诊断包
都会把别人的 ``Authorization: Bearer ...`` 一起带走。凡是"存凭据"的地方都该有一条
断言盯着它：**数据库里搜不到那串明文**。

顺手锁住另外两件：
* 读接口仍然要把真值给回来（界面"测试连接"要用），只是库里的落盘形态变了
* 老库升级上来（明文列有值、密文列为空）启动时就地迁移
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select

from agent_studio.db import SessionLocal, init_db
from agent_studio.models import McpServer, now_ms


def _run(coro):
    return asyncio.run(coro)


async def _row(mcp_id: str) -> McpServer:
    await init_db()
    async with SessionLocal() as db:
        return await db.get(McpServer, mcp_id)


async def test_create_stores_ciphertext_only(client):
    body = {
        "name": "secrets-test",
        "transport": "http",
        "url": "https://example.com/mcp",
        "env": {"GITHUB_TOKEN": "ghp_supersecret123"},
        "headers": {"Authorization": "Bearer tok_live_abc987"},
        "enabled": True,
    }
    r = await client.post("/api/mcp", json=body)
    assert r.status_code == 201, r.text
    data = r.json()

    row = await _row(data["id"])
    assert row.env == {} and row.headers == {}, "明文列必须留空"
    assert row.env_enc and row.headers_enc
    # 密文里不该出现 token 的任何一段
    assert "supersecret123" not in row.env_enc
    assert "tok_live_abc987" not in row.headers_enc

    # 读接口仍给出真值（界面要能"测试连接"）
    assert data["env"]["GITHUB_TOKEN"] == "ghp_supersecret123"
    assert data["headers"]["Authorization"] == "Bearer tok_live_abc987"

    listed = (await client.get("/api/mcp")).json()
    again = next(x for x in listed if x["id"] == data["id"])
    assert again["headers"]["Authorization"] == "Bearer tok_live_abc987"


async def test_update_rotates_secret_without_touching_plaintext(client):
    body = {"name": "rotate-test", "transport": "http", "url": "https://e.com/mcp",
            "headers": {"Authorization": "Bearer old_tok"}, "enabled": True}
    created = (await client.post("/api/mcp", json=body)).json()
    r = await client.put(f"/api/mcp/{created['id']}",
                         json={"headers": {"Authorization": "Bearer new_tok"}})
    assert r.status_code == 200, r.text
    assert r.json()["headers"]["Authorization"] == "Bearer new_tok"

    row = await _row(created["id"])
    assert row.headers == {}
    assert "new_tok" not in row.headers_enc


async def test_startup_migration_encrypts_legacy_plaintext():
    await init_db()
    legacy_id = "mcp_legacy_plain"

    async def _seed():
        async with SessionLocal() as db:
            if await db.get(McpServer, legacy_id) is None:
                db.add(
                    McpServer(
                        id=legacy_id,
                        name="legacy-plain",
                        transport="http",
                        url="https://legacy.example/mcp",
                        headers={"X-Api-Key": "legacy_key_999"},
                        env={"TOKEN": "legacy_env_888"},
                        created_at=now_ms(),
                        updated_at=now_ms(),
                    )
                )
                await db.commit()

    await _seed()
    from agent_studio.api.mcp import migrate_plaintext_secrets

    moved = await migrate_plaintext_secrets()
    assert moved >= 1

    row = await _row(legacy_id)
    assert row.headers == {} and row.env == {}
    assert row.headers_enc and row.env_enc
    assert "legacy_key_999" not in row.headers_enc

    from agent_studio.api.mcp import open_io

    env, headers = open_io(row)
    assert headers["X-Api-Key"] == "legacy_key_999"
    assert env["TOKEN"] == "legacy_env_888"

    # 幂等：再跑一次不重复搬
    assert await migrate_plaintext_secrets() == 0
