"""知识中心阶段 3：分类 / 标签 / 链接抓取（含 SSRF 防护）。"""

from __future__ import annotations

import asyncio

import pytest


def _md(text: str) -> bytes:
    return text.encode("utf-8")


async def _wait_terminal(client, doc_id: str):
    for _ in range(60):
        got = (await client.get(f"/api/knowledge/documents/{doc_id}")).json()
        if got["status"] in ("ready", "failed"):
            return got
        await asyncio.sleep(0.1)
    return got


async def test_分类与标签_增删改(client, tmp_path, monkeypatch):
    from agent_studio.config import settings

    monkeypatch.setattr(settings, "work_dir", tmp_path)

    r = await client.post("/api/knowledge/categories", json={"name": "合同"})
    assert r.status_code == 201, r.text
    cat = r.json()
    assert cat["depth"] == 1

    sub = await client.post("/api/knowledge/categories", json={"name": "采购合同", "parent_id": cat["id"]})
    assert sub.status_code == 201
    assert sub.json()["depth"] == 2

    d3 = (await client.post("/api/knowledge/categories", json={"name": "三级", "parent_id": sub.json()["id"]})).json()
    too_deep = await client.post("/api/knowledge/categories", json={"name": "四级", "parent_id": d3["id"]})
    assert too_deep.status_code == 422

    renamed = await client.patch(f"/api/knowledge/categories/{cat['id']}", json={"name": "合同与协议"})
    assert renamed.status_code == 200
    assert any(c["name"] == "合同与协议" for c in (await client.get("/api/knowledge/categories")).json()["items"])

    tag = await client.post("/api/knowledge/tags", json={"name": "2026"})
    assert tag.status_code == 201
    again = await client.post("/api/knowledge/tags", json={"name": "2026"})
    assert again.json()["id"] == tag.json()["id"]

    assert (await client.delete(f"/api/knowledge/tags/{tag.json()['id']}")).status_code == 204
    assert all(t["name"] != "2026" for t in (await client.get("/api/knowledge/tags")).json()["items"])

    await client.delete(f"/api/knowledge/categories/{cat['id']}")
    items = (await client.get("/api/knowledge/categories")).json()["items"]
    assert all(c["id"] != cat["id"] for c in items)
    assert any(c["name"] == "采购合同" and c["parent_id"] == "" for c in items)


def test_SSRF_拒绝内网与非法协议():
    from agent_studio.knowledge import fetch_url

    for bad in (
        "file:///etc/passwd",
        "http://127.0.0.1:8848/api/health",
        "http://192.168.2.11:8848/",
        "http://169.254.169.254/latest/meta-data/",
        "http://localhost/admin",
        "http://10.0.0.1/",
        "not-a-url",
    ):
        with pytest.raises(fetch_url.FetchBlocked):
            fetch_url.assert_public_url(bad)


async def test_链接入库_内网被拒(client, tmp_path, monkeypatch):
    from agent_studio.config import settings

    monkeypatch.setattr(settings, "work_dir", tmp_path)
    r = await client.post("/api/knowledge/documents/from-url", json={"url": "http://127.0.0.1:8848/api/health"})
    assert r.status_code == 400
    assert "内网" in r.json()["detail"] or "拒绝" in r.json()["detail"]


async def test_链接入库_成功路径(client, tmp_path, monkeypatch):
    from agent_studio.config import settings
    from agent_studio.knowledge import fetch_url

    monkeypatch.setattr(settings, "work_dir", tmp_path)
    monkeypatch.setattr(
        fetch_url,
        "fetch_and_extract",
        lambda url: {
            "final_url": "https://example.com/a",
            "status": 200,
            "content_type": "text/html",
            "markdown": "# 标题\n\n正文内容在这里。",
            "snapshot": b"<html>raw</html>",
            "text_length": 12,
        },
    )

    r = await client.post(
        "/api/knowledge/documents/from-url", json={"url": "https://example.com/a", "name": "示例"}
    )
    assert r.status_code == 201, r.text
    doc = r.json()["document"]
    assert doc["source"] == "url"
    assert doc["source_url"] == "https://example.com/a"
    assert doc["name"] == "示例.md"

    got = await _wait_terminal(client, doc["id"])
    assert got["status"] == "ready"


async def test_上传时按分类归位(client, tmp_path, monkeypatch):
    from agent_studio.config import settings

    monkeypatch.setattr(settings, "work_dir", tmp_path)
    r = await client.post(
        "/api/knowledge/documents",
        files={"files": ("x.md", _md("分类测试"), "text/markdown")},
        data={"category": "合同与协议"},
    )
    assert r.status_code == 201
    doc = r.json()["documents"][0]
    cats = (await client.get("/api/knowledge/categories")).json()["items"]
    hit = [c for c in cats if c["name"] == "合同与协议"]
    assert hit and hit[0]["doc_count"] >= 1
    assert doc["category_id"] == hit[0]["id"]
