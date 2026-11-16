"""知识库检索工具：助手真的能在对话里查知识中心。"""

from __future__ import annotations

import asyncio


async def _wait_ready(client, doc_id: str) -> dict:
    got: dict = {}
    for _ in range(80):
        got = (await client.get(f"/api/knowledge/documents/{doc_id}")).json()
        if got["status"] in ("ready", "failed"):
            return got
        await asyncio.sleep(0.1)
    return got


async def test_助手能查知识库(client, tmp_path, monkeypatch):
    from agent_studio.config import settings
    from agent_studio.native_tools import _knowledge_search

    monkeypatch.setattr(settings, "work_dir", tmp_path)

    body = "# 采购合同\n\n付款期限为 30 天。".encode("utf-8")
    r = await client.post(
        "/api/knowledge/documents",
        files={"files": ("采购合同.md", body, "text/markdown")},
    )
    assert r.status_code in (200, 201), r.text
    doc = r.json()["documents"][0]
    got = await _wait_ready(client, doc["id"])
    assert got["status"] == "ready"

    out = await _knowledge_search("付款期限", 5)
    assert "采购合同.md" in out
    assert doc["id"] in out

    miss = await _knowledge_search("完全不存在的词xyzzy", 5)
    assert "没有" in miss

    empty = await _knowledge_search("   ", 5)
    assert "查询为空" in empty


async def test_知识检索工具已注册():
    from agent_studio.native_tools import NATIVE_TOOLS

    spec = NATIVE_TOOLS["knowledge_search"]
    assert spec["flags"]["read_only"] is True
    assert "query" in spec["schema"]["required"]
