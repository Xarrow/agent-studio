"""知识中心：入库、解析、检索、存储配置（阶段 2 的护栏）。

这些用例都落临时工作目录，不动真实 data/work。
"""

from __future__ import annotations

import io


def _md(text: str) -> bytes:
    return text.encode("utf-8")


async def test_上传_md_能解析并检索(client, tmp_path, monkeypatch):
    from agent_studio.config import settings

    monkeypatch.setattr(settings, "work_dir", tmp_path)

    r = await client.post(
        "/api/knowledge/documents",
        files={"files": ("合同模板.md", _md("# 合同\n\n甲方：某某。\n\n乙方：另一家。"), "text/markdown")},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert len(body["documents"]) == 1
    doc = body["documents"][0]
    assert doc["kind"] == "md"
    assert doc["status"] in ("parsing", "ready")
    assert "knowledge" in doc["storage_path"]

    # 后台解析是 create_task 起的：轮询等它 ready
    import asyncio

    for _ in range(50):
        got = (await client.get(f"/api/knowledge/documents/{doc['id']}")).json()
        if got["status"] in ("ready", "failed"):
            break
        await asyncio.sleep(0.1)
    assert got["status"] == "ready", got
    assert got["parsed"]["textLength"] > 0
    assert got["chunks"] >= 1

    text = (await client.get(f"/api/knowledge/documents/{doc['id']}/text")).json()
    assert "甲方" in text["chunks"][0]["text"]

    found = (await client.get("/api/knowledge/search", params={"q": "乙方"})).json()
    assert any(item["id"] == doc["id"] for item in found["items"])


async def test_同内容去重(client, tmp_path, monkeypatch):
    from agent_studio.config import settings

    monkeypatch.setattr(settings, "work_dir", tmp_path)
    payload = _md("重复内容测试")
    r1 = await client.post("/api/knowledge/documents", files={"files": ("a.md", payload, "text/markdown")})
    assert r1.status_code == 201
    r2 = await client.post("/api/knowledge/documents", files={"files": ("b.md", payload, "text/markdown")})
    assert r2.status_code == 201
    assert r2.json()["documents"] == []
    assert len(r2.json()["duplicates"]) == 1


async def test_删除先软删_彻底删才清原件与分块(client, tmp_path, monkeypatch):
    """删除分两步：默认进回收站（记录还在），``?hard=true`` 才真删原件与分块。"""
    from agent_studio.config import settings

    monkeypatch.setattr(settings, "work_dir", tmp_path)
    r = await client.post(
        "/api/knowledge/documents",
        files={"files": ("要删的.md", _md("# 要删的\n\n正文留个记号。"), "text/markdown")},
    )
    doc = r.json()["documents"][0]
    detail = (await client.get(f"/api/knowledge/documents/{doc['id']}")).json()
    path = detail["storage_path"]

    # 第一步：软删
    assert (await client.delete(f"/api/knowledge/documents/{doc['id']}")).status_code == 204
    assert (await client.get(f"/api/knowledge/documents/{doc['id']}")).status_code == 200
    import os

    assert os.path.exists(path), "软删不该动原件"

    # 第二步：彻底删除
    assert (
        await client.delete(f"/api/knowledge/documents/{doc['id']}", params={"hard": "true"})
    ).status_code == 204
    assert (await client.get(f"/api/knowledge/documents/{doc['id']}")).status_code == 404
    assert not os.path.exists(path), "彻底删除要清原件"

async def test_存储配置与测试连接(client, tmp_path, monkeypatch):
    from agent_studio.config import settings

    monkeypatch.setattr(settings, "work_dir", tmp_path)
    items = (await client.get("/api/knowledge/storage")).json()["items"]
    assert items and items[0]["type"] == "local"

    got = (await client.post(f"/api/knowledge/storage/{items[0]['id']}/test")).json()
    assert got["ok"] is True
    assert "latency_ms" in got


async def test_不支持的类型落_failed_并给原因(client, tmp_path, monkeypatch):
    from agent_studio.config import settings

    monkeypatch.setattr(settings, "work_dir", tmp_path)
    import asyncio

    r = await client.post(
        "/api/knowledge/documents", files={"files": ("坏文件.bin", b"\x00\x01\x02\x03", "application/octet-stream")}
    )
    assert r.status_code == 201
    doc = r.json()["documents"][0]
    for _ in range(50):
        got = (await client.get(f"/api/knowledge/documents/{doc['id']}")).json()
        if got["status"] in ("ready", "failed"):
            break
        await asyncio.sleep(0.1)
    assert got["status"] == "failed"
    assert got["error"]["message"]
