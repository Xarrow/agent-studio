"""知识中心阶段 5：文档 → Skill 沉淀 + 来源溯源。

判据是边界与溯源：草稿不采纳不落盘，采纳后 disk 上有 SKILL.md、库里记着来源文档。
"""

from __future__ import annotations

import asyncio
from pathlib import Path


async def _agent_with_model(client) -> str:
    data = (await client.get("/api/agents")).json()
    rows = data["items"] if isinstance(data, dict) else data
    for r in rows:
        if ((r.get("definition") or {}).get("model") or {}).get("name"):
            return r["id"]
    from agent_studio.db import SessionLocal
    from agent_studio.models import Agent

    async with SessionLocal() as s:
        row = Agent(
            slug="skill-seed-tester",
            name="提炼测试助手",
            definition={"name": "提炼测试助手", "model": {"name": "test-model", "provider": "openai"}},
        )
        s.add(row)
        await s.commit()
        await s.refresh(row)
        return row.id


async def _seed_doc(client, name: str, text: str) -> dict:
    r = await client.post(
        "/api/knowledge/documents", files={"files": (name, text.encode("utf-8"), "text/markdown")}
    )
    doc = r.json()["documents"][0]
    for _ in range(60):
        got = (await client.get(f"/api/knowledge/documents/{doc['id']}")).json()
        if got["status"] in ("ready", "failed"):
            return got
        await asyncio.sleep(0.1)
    return got


async def _wait_draft(client, job_id: str):
    for _ in range(80):
        rows = (await client.get("/api/knowledge/organize/drafts", params={"status": "pending"})).json()["items"]
        hit = [d for d in rows if d["job_id"] == job_id]
        if hit:
            return hit[0]
        await asyncio.sleep(0.1)
    return None


async def test_文档沉淀为skill_采纳后才落盘(client, tmp_path, monkeypatch):
    from agent_studio.config import settings
    from agent_studio.knowledge import organize
    from agent_studio.runner import service as runner_service

    monkeypatch.setattr(settings, "work_dir", tmp_path)

    async def fake_cred(*_a, **_k):
        return ("sk-test", "http://test.local/v1")

    monkeypatch.setattr(runner_service, "resolve_credential", fake_cred)

    async def fake_chat(**_: object):
        return (
            '{"name":"采购合同审阅","description":"审采购合同时用，抓付款与验收条款",'
            '"body":"## 适用场景\\n签采购合同前。\\n\\n## 步骤\\n1. 看付款节点\\n2. 看验收标准\\n\\n'
            '## 验收\\n条款齐全\\n\\n## 来源要点\\n付款不超过 30 天"}',
            "",
        )

    monkeypatch.setattr(organize, "chat_once", fake_chat)

    doc = await _seed_doc(client, "采购合同要点.md", "# 采购合同\n\n付款节点不超过 30 天，验收需双方签字。")
    agent_id = await _agent_with_model(client)

    r = await client.post(f"/api/knowledge/documents/{doc['id']}/skill-draft", json={"agent_id": agent_id})
    assert r.status_code == 202, r.text
    draft = await _wait_draft(client, r.json()["job"]["id"])
    assert draft is not None, "没产出 skill 草稿"
    assert draft["kind"] == "skill"
    assert draft["payload"]["name"] == "采购合同审阅"

    # 采纳前：磁盘上没有任何 workspace 技能
    before = list((Path(tmp_path) / "skills" / "workspace").glob("*/SKILL.md")) if (Path(tmp_path) / "skills" / "workspace").exists() else []
    assert before == []

    ok = await client.post(f"/api/knowledge/organize/drafts/{draft['id']}/accept")
    assert ok.status_code == 200, ok.text
    applied = ok.json()["applied"]["skill"]
    assert applied["name"] == "采购合同审阅"

    # 采纳后：库里 ns=workspace + 溯源到这份文档
    row = (await client.get(f"/api/skills/{applied['id']}")).json()
    assert row["ns"] == "workspace"
    assert row["source_doc_ids"] == [doc["id"]]
    assert "## 步骤" in row["content"]

    # 磁盘上真的有一份 SKILL.md（运行时 LocalSkillLoader 读这里）
    files = list((Path(tmp_path) / "skills" / "workspace").glob("*/SKILL.md"))
    assert len(files) == 1, files
    assert "采购合同审阅" in files[0].read_text(encoding="utf-8")
