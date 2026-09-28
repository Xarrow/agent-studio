"""批量操作护栏：记忆与工具的批量删除。

守三件事：
① 只删**明确列出的 id**（不做条件/模式批量 —— 删了什么必须可核对）；
② 平台/运行时提供的工具（builtin / native / fork）**一律跳过**并回报原因，
   不允许"删了又被同步回来"这种让人困惑的状态；
③ 空 id 列表必须被拒（防止一次误调用变成"删全部"）。
"""

import pytest


async def _mk_agent(client) -> str:
    r = await client.post(
        "/api/agents",
        json={
            "name": f"批量护栏助手-{pytest.__name__}",
            "definition": {"name": "批量护栏助手", "model": {"provider": "deepseek", "name": "deepseek-chat"}, "tools": []},
        },
    )
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def _mk_memory(client, text: str) -> str:
    r = await client.post("/api/memories", json={"content": text, "kind": "fact", "scope": "global", "active": True})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def _mk_tool(client, name: str, kind: str = "http") -> str:
    r = await client.post(
        "/api/tools",
        json={
            "kind": kind,
            "name": name,
            "description": "临时",
            "input_schema": {},
            "impl": {"method": "GET", "url": "https://example.com"},
            "flags": {},
        },
    )
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def _mk_tool_raw(client, name: str, kind: str) -> str:
    """直接落库造一个 builtin/native 工具 —— 接口层不允许创建这些 kind
    （它们是运行时同步/平台注册来的），但批量删除的跳过逻辑必须能测。"""
    from agent_studio.db import SessionLocal
    from agent_studio.models import Tool, new_id, now_ms

    async with SessionLocal() as s:
        row = Tool(id=new_id("tl_"), kind=kind, name=name, description="临时",
                   input_schema={}, impl={}, flags={}, created_at=now_ms(), updated_at=now_ms())
        s.add(row)
        await s.commit()
        return row.id


@pytest.mark.asyncio
async def test_bulk_delete_memories_only_listed_ids(client):
    keep = await _mk_memory(client, "【护栏】留着的那条")
    a = await _mk_memory(client, "【护栏】删掉A")
    b = await _mk_memory(client, "【护栏】删掉B")

    r = await client.post("/api/memories/bulk-delete", json={"ids": [a, b]})
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] == 2

    for mid in (a, b):
        assert (await client.get(f"/api/memories/{mid}")).status_code == 404
    assert (await client.get(f"/api/memories/{keep}")).status_code == 200


@pytest.mark.asyncio
async def test_bulk_delete_memories_rejects_empty_ids(client):
    r = await client.post("/api/memories/bulk-delete", json={"ids": []})
    assert r.status_code == 422, "空 id 列表必须被拒（防误删全部）"


@pytest.mark.asyncio
async def test_bulk_delete_tools_skips_protected_kinds(client):
    """平台/运行时工具跳过并说明原因；只有自定义工具真被删。"""
    builtin_id = await _mk_tool_raw(client, "【护栏】内建工具", "builtin")
    native_id = await _mk_tool_raw(client, "【护栏】平台工具", "native")
    mine = await _mk_tool(client, "【护栏】自定义工具")

    r = await client.post("/api/tools/bulk-delete", json={"ids": [builtin_id, native_id, mine]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["deleted"] == 1, "只该删掉自定义那一个"
    assert sorted(s["id"] for s in body["skipped"]) == sorted([builtin_id, native_id])
    assert all("不能删" in s["reason"] for s in body["skipped"])

    assert (await client.get(f"/api/tools/{mine}")).status_code == 404
    assert (await client.get(f"/api/tools/{builtin_id}")).status_code == 200
    assert (await client.get(f"/api/tools/{native_id}")).status_code == 200


@pytest.mark.asyncio
async def test_bulk_delete_tools_rejects_empty_ids(client):
    r = await client.post("/api/tools/bulk-delete", json={"ids": []})
    assert r.status_code == 422
