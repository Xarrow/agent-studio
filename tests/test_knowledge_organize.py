"""整理 Agent：草稿生成与采纳（不采纳绝不动文档）。

这一层用假的模型调用代替真实 API —— 判据是"边界"，不是"模型好不好用"。
"""

from __future__ import annotations

import asyncio


async def _fake_cred(*_a, **_k):
    return ("sk-test", "http://test.local/v1")


def _patch_creds(monkeypatch):
    """整理要用凭据解析；测试库没有真 key，直接给一对假的。"""
    from agent_studio.runner import service as runner_service

    monkeypatch.setattr(runner_service, "resolve_credential", _fake_cred)


async def _agent_id(client) -> str:
    """/api/agents 可能回 list 也可能回 {items: [...]}；测试库里没有就播一个。

    整理只用到助手的 model 配置（凭据解析在 run_job 里被假函数绕开也不影响这里）。
    """
    data = (await client.get("/api/agents")).json()
    rows = data["items"] if isinstance(data, dict) else data
    # 整个测试套件共用库：可能先被别的用例播了「没配模型」的助手，必须挑有模型的
    for r in rows:
        if ((r.get("definition") or {}).get("model") or {}).get("name"):
            return r["id"]
    from agent_studio.db import SessionLocal
    from agent_studio.models import Agent

    async with SessionLocal() as s:
        row = Agent(
            slug="organize-tester",
            name="整理测试助手",
            definition={"name": "整理测试助手", "model": {"name": "test-model", "provider": "openai"}},
        )
        s.add(row)
        await s.commit()
        await s.refresh(row)
        return row.id


async def _wait_job(client, job_id: str):
    for _ in range(80):
        items = (await client.get("/api/knowledge/organize/jobs")).json()["items"]
        hit = [j for j in items if j["id"] == job_id]
        if hit and hit[0]["status"] in ("done", "failed"):
            return hit[0]
        await asyncio.sleep(0.1)
    return hit[0] if hit else {}


async def _seed_doc(client, name: str, text: str) -> dict:
    r = await client.post(
        "/api/knowledge/documents",
        files={"files": (name, text.encode("utf-8"), "text/markdown")},
    )
    doc = r.json()["documents"][0]
    for _ in range(60):
        got = (await client.get(f"/api/knowledge/documents/{doc['id']}")).json()
        if got["status"] in ("ready", "failed"):
            return got
        await asyncio.sleep(0.1)
    return got


async def test_整理产出草稿_不采纳不动文档(client, tmp_path, monkeypatch):
    from agent_studio.config import settings
    from agent_studio.knowledge import organize

    monkeypatch.setattr(settings, "work_dir", tmp_path)
    doc = await _seed_doc(client, "采购合同.md", "# 采购合同\n\n甲方义务：按期付款。")

    async def fake_chat_once(**_: object):
        return (
            '{"category":"合同","tags":["采购","甲方义务"],"summary":"一份采购合同，讲甲方付款义务。","confidence":0.8}',
            "",
        )

    _patch_creds(monkeypatch)
    monkeypatch.setattr(organize, "chat_once", fake_chat_once)

    agent_id = await _agent_id(client)

    r = await client.post("/api/knowledge/organize", json={"agent_id": agent_id, "doc_ids": [doc["id"]]})
    assert r.status_code == 202, r.text
    job = await _wait_job(client, r.json()["job"]["id"])
    assert job["status"] == "done", job
    assert job["made"] >= 3  # category / tags / summary

    # 还没采纳：文档不动
    after = (await client.get(f"/api/knowledge/documents/{doc['id']}")).json()
    assert after["tags"] == []
    assert after["category_id"] == doc["category_id"]
    assert not (after["parsed"] or {}).get("aiSummary")

    drafts = (await client.get("/api/knowledge/organize/drafts")).json()["items"]
    mine = [d for d in drafts if d["job_id"] == job["id"]]
    assert {d["kind"] for d in mine} == {"category", "tags", "summary"}

    # 采纳分类 + 标签 + 摘要
    for d in mine:
        got = await client.post(f"/api/knowledge/organize/drafts/{d['id']}/accept")
        assert got.status_code == 200
        assert got.json()["ok"] is True

    final = (await client.get(f"/api/knowledge/documents/{doc['id']}")).json()
    assert set(final["tags"]) == {"采购", "甲方义务"}
    assert final["parsed"]["aiSummary"].startswith("一份采购合同")
    cats = (await client.get("/api/knowledge/categories")).json()["items"]
    assert any(c["name"] == "合同" and c["doc_count"] >= 1 for c in cats)

    # 幂等：再采纳一次不报错
    again = await client.post(f"/api/knowledge/organize/drafts/{mine[0]['id']}/accept")
    assert again.status_code == 200 and again.json().get("already") == "accepted"


async def test_拒绝草稿_文档不变(client, tmp_path, monkeypatch):
    from agent_studio.config import settings
    from agent_studio.knowledge import organize

    monkeypatch.setattr(settings, "work_dir", tmp_path)
    doc = await _seed_doc(client, "无关文档.md", "# 随手记\n\n今天下雨。")

    _patch_creds(monkeypatch)
    monkeypatch.setattr(
        organize,
        "chat_once",
        lambda **_: asyncio.sleep(0, result=('{"category":"随笔","tags":["天气"],"summary":"天气随笔。","confidence":0.4}', "")),
    )

    agent_id = await _agent_id(client)
    r = await client.post("/api/knowledge/organize", json={"agent_id": agent_id, "doc_ids": [doc["id"]]})
    job = await _wait_job(client, r.json()["job"]["id"])
    drafts = [d for d in (await client.get("/api/knowledge/organize/drafts")).json()["items"] if d["job_id"] == job["id"]]
    for d in drafts:
        assert (await client.post(f"/api/knowledge/organize/drafts/{d['id']}/reject")).status_code == 200

    final = (await client.get(f"/api/knowledge/documents/{doc['id']}")).json()
    assert final["tags"] == []
    assert not (final["parsed"] or {}).get("aiSummary")


async def test_模型失败时任务标记失败并给人话(client, tmp_path, monkeypatch):
    from agent_studio.config import settings
    from agent_studio.knowledge import organize

    monkeypatch.setattr(settings, "work_dir", tmp_path)
    doc = await _seed_doc(client, "坏模型.md", "# x\n\n内容")
    _patch_creds(monkeypatch)
    monkeypatch.setattr(organize, "chat_once", lambda **_: asyncio.sleep(0, result=("", "401 未授权")))

    agent_id = await _agent_id(client)
    r = await client.post("/api/knowledge/organize", json={"agent_id": agent_id, "doc_ids": [doc["id"]]})
    job = await _wait_job(client, r.json()["job"]["id"])
    assert job["status"] == "failed"
    assert job["error"]["message"]
