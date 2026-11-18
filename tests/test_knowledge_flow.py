"""知识库流程：版本、软删回收站、标签（候选/采纳）、Skill 草稿发布。

每条断言对着一份口径（docs/specs/knowledge-flow-spec.md §二 D1/D2/D3/D6）：
更新=新版本、删除=软删、模型标签要人采纳、Skill 先草稿后发布。
"""

from __future__ import annotations

import asyncio


def _md(text: str) -> bytes:
    return text.encode("utf-8")


async def _wait_ready(client, doc_id: str) -> dict:
    got: dict = {}
    for _ in range(80):
        got = (await client.get(f"/api/knowledge/documents/{doc_id}")).json()
        if got["status"] in ("ready", "failed"):
            return got
        await asyncio.sleep(0.1)
    return got


async def _upload(client, name: str, text: str) -> dict:
    r = await client.post(
        "/api/knowledge/documents",
        files={"files": (name, _md(text), "text/markdown")},
    )
    assert r.status_code == 201, r.text
    return r.json()["documents"][0]


async def test_更新文档产生新版本并可回滚(client, tmp_path, monkeypatch):
    from agent_studio.config import settings

    monkeypatch.setattr(settings, "work_dir", tmp_path)
    doc = await _upload(client, "规范.md", "# 规范 v1\n\n付款期限 30 天。")
    await _wait_ready(client, doc["id"])
    assert doc["version"] == 1

    r = await client.post(
        f"/api/knowledge/documents/{doc['id']}/versions",
        files={"file": ("规范.md", _md("# 规范 v2\n\n付款期限 60 天。"), "text/markdown")},
        params={"note": "客户要求延长"},
    )
    assert r.status_code == 201, r.text
    assert r.json()["version"] == 2

    listed = (await client.get(f"/api/knowledge/documents/{doc['id']}/versions")).json()
    assert listed["current"] == 2
    assert {v["version"] for v in listed["items"]} >= {2}

    # 同内容再传一次要被挡住（不该产生空版本）
    again = await client.post(
        f"/api/knowledge/documents/{doc['id']}/versions",
        files={"file": ("规范.md", _md("# 规范 v2\n\n付款期限 60 天。"), "text/markdown")},
    )
    assert again.status_code == 409

    back = await client.post(f"/api/knowledge/documents/{doc['id']}/versions/1/rollback")
    assert back.status_code == 200, back.text
    assert back.json()["version"] == 1
    got = await _wait_ready(client, doc["id"])
    assert got["version"] == 1


async def test_删除是软删_回收站可恢复(client, tmp_path, monkeypatch):
    from agent_studio.config import settings

    monkeypatch.setattr(settings, "work_dir", tmp_path)
    doc = await _upload(client, "临时.md", "# 临时\n\n用完就删。")
    await _wait_ready(client, doc["id"])

    assert (await client.delete(f"/api/knowledge/documents/{doc['id']}")).status_code == 204
    listed = (await client.get("/api/knowledge/documents")).json()["items"]
    assert all(x["id"] != doc["id"] for x in listed), "软删后列表不该还有"

    # 检索也要排除
    hits = (await client.get("/api/knowledge/search", params={"q": "用完就删"})).json()["items"]
    assert all(x["id"] != doc["id"] for x in hits)

    trash = (await client.get("/api/knowledge/trash")).json()["items"]
    assert any(x["id"] == doc["id"] for x in trash)

    assert (await client.post(f"/api/knowledge/documents/{doc['id']}/restore")).status_code == 200
    listed2 = (await client.get("/api/knowledge/documents")).json()["items"]
    assert any(x["id"] == doc["id"] for x in listed2)


async def test_标签分模型候选与用户自定义(client, tmp_path, monkeypatch):
    from agent_studio.config import settings

    monkeypatch.setattr(settings, "work_dir", tmp_path)
    doc = await _upload(client, "合同.md", "# 合同\n\n甲方乙方。")
    await _wait_ready(client, doc["id"])

    # 模型提的：默认候选，不进 doc.tags、不算 adopted
    r = await client.post(
        f"/api/knowledge/documents/{doc['id']}/tags",
        json={"name": "采购", "source": "model", "confidence": 0.72},
    )
    assert r.status_code == 201 and r.json()["status"] == "candidate"
    tags = (await client.get(f"/api/knowledge/documents/{doc['id']}/tags")).json()
    assert any(t["status"] == "candidate" and t["source"] == "model" for t in tags["candidates"])
    assert tags["accepted"] == []

    # 采纳后进 accepted + 同步 doc.tags
    tid = r.json()["tag_id"]
    assert (await client.post(f"/api/knowledge/documents/{doc['id']}/tags/{tid}/accept")).status_code == 200
    tags2 = (await client.get(f"/api/knowledge/documents/{doc['id']}/tags")).json()
    assert any(t["tag_id"] == tid for t in tags2["accepted"])
    detail = (await client.get(f"/api/knowledge/documents/{doc['id']}")).json()
    assert "采购" in detail["tags"]

    # 用户自己加的：直接 accepted
    r2 = await client.post(
        f"/api/knowledge/documents/{doc['id']}/tags", json={"name": "甲方义务", "source": "user"}
    )
    assert r2.json()["status"] == "accepted"

    # 使用数统计能看到
    usage = (await client.get("/api/knowledge/tags/usage")).json()["items"]
    assert any(x["name"] == "采购" and x["doc_count"] >= 1 for x in usage)


async def test_按标签生成Skill草稿_发布后落workspace(client, tmp_path, monkeypatch):
    from agent_studio.config import settings
    from agent_studio.db import SessionLocal
    from agent_studio.knowledge.models import SkillDraft
    from agent_studio.models import Skill

    monkeypatch.setattr(settings, "work_dir", tmp_path)
    doc = await _upload(client, "验收规范.md", "# 验收\n\n1. 逐条核对。2. 签字。")
    await _wait_ready(client, doc["id"])
    tag = (
        await client.post(
            f"/api/knowledge/documents/{doc['id']}/tags", json={"name": "验收流程", "source": "user"}
        )
    ).json()

    # 没有模型时后台会失败，但草稿本身必须先建出来（不阻塞用户）
    made = await client.post("/api/knowledge/skill-drafts", json={"tag_id": tag["tag_id"]})
    assert made.status_code == 201, made.text
    draft_id = made.json()["draft"]["id"]

    # 直接给草稿填内容（模拟模型生成完成），再发布
    async with SessionLocal() as s:
        row = await s.get(SkillDraft, draft_id)
        row.name = "验收流程执行"
        row.description = "验收时按此逐条核对"
        row.body = "## 适用场景\n项目验收\n\n## 步骤\n1. 逐条核对\n2. 签字\n\n## 验收\n全部签字\n"
        await s.commit()

    pub = await client.post(f"/api/knowledge/skill-drafts/{draft_id}/publish")
    assert pub.status_code == 200, pub.text
    skill_id = pub.json()["skill_id"]

    async with SessionLocal() as s:
        skill = await s.get(Skill, skill_id)
        assert skill is not None and skill.ns == "workspace"
        assert doc["id"] in (skill.source_doc_ids or [])
        assert tag["tag_id"] in (skill.source_tag_ids or [])
    # 重复发布要挡住
    assert (await client.post(f"/api/knowledge/skill-drafts/{draft_id}/publish")).status_code == 409


async def test_召回面板给出四个口径的数(client, tmp_path, monkeypatch):
    from agent_studio.config import settings

    monkeypatch.setattr(settings, "work_dir", tmp_path)
    doc = await _upload(client, "付款条款.md", "# 付款条款\n\n验收合格后 30 天内支付全款。")
    await _wait_ready(client, doc["id"])
    await client.post(
        f"/api/knowledge/documents/{doc['id']}/tags", json={"name": "付款", "source": "user"}
    )

    got = (await client.get("/api/knowledge/recall")).json()
    assert set(got) >= {"docs", "tags", "agent", "search"}
    assert got["docs"]["total"] >= 1
    # 面板里的比率必须是 0~1 的数，不是百分比字符串
    assert 0.0 <= got["docs"]["rate"] <= 1.0
    assert 0.0 <= got["tags"]["rate"] <= 1.0


async def test_来源变化后技能标记为过时(client, tmp_path, monkeypatch):
    """发布时记来源指纹；文档出新版本后 /api/skills 要标 source_stale。"""
    from agent_studio.config import settings
    from agent_studio.db import SessionLocal
    from agent_studio.knowledge.models import SkillDraft

    monkeypatch.setattr(settings, "work_dir", tmp_path)
    doc = await _upload(client, "变更规范.md", "# 变更\n\n第一条 先评估影响。")
    await _wait_ready(client, doc["id"])

    made = await client.post("/api/knowledge/skill-drafts", json={"doc_ids": [doc["id"]]})
    assert made.status_code == 201, made.text
    draft_id = made.json()["draft"]["id"]
    async with SessionLocal() as s:
        row = await s.get(SkillDraft, draft_id)
        row.name = "变更评估流程"
        row.description = "改需求前先评估影响"
        row.body = "## 适用场景\n需求变更\n\n## 步骤\n1. 评估影响\n"
        await s.commit()
    pub = await client.post(f"/api/knowledge/skill-drafts/{draft_id}/publish")
    assert pub.status_code == 200, pub.text
    skill_id = pub.json()["skill_id"]

    rows = (await client.get("/api/skills")).json()
    mine = next(r for r in rows if r["id"] == skill_id)
    assert mine["source_stale"] is False, "刚发布不该是过时"

    # 出新版本 → 指纹变化
    r = await client.post(
        f"/api/knowledge/documents/{doc['id']}/versions",
        files={"file": ("变更规范.md", _md("# 变更\n\n第一条 先评估影响。\n\n第二条 通知相关方。"), "text/markdown")},
    )
    assert r.status_code == 201
    await _wait_ready(client, doc["id"])

    rows2 = (await client.get("/api/skills")).json()
    mine2 = next(r for r in rows2 if r["id"] == skill_id)
    assert mine2["source_stale"] is True, "来源出了新版本，应标过时"


async def test_粘贴入库_自动关键词_试打召回(client, tmp_path, monkeypatch):
    """一页流程的三步：粘贴 → 关键词 → 试打。向量化需要模型，这里只验不依赖模型的环节。"""
    from agent_studio.config import settings

    monkeypatch.setattr(settings, "work_dir", tmp_path)
    text = (
        "# 差旅报销规范\n\n第一条 出差前须提交申请。\n\n"
        "第二条 住宿标准：一线城市每晚不超过 600 元。\n\n第三条 报销时限 15 个工作日。"
    )
    made = await client.post(
        "/api/knowledge/documents/paste",
        json={"title": "差旅报销", "text": text, "tags": ["报销"]},
    )
    assert made.status_code == 201, made.text
    doc = made.json()["document"]
    assert doc["name"].startswith("差旅报销")
    assert "报销" in doc["tags"]

    # 太短的拒掉
    short = await client.post("/api/knowledge/documents/paste", json={"text": "太短"})
    assert short.status_code == 422

    await _wait_ready(client, doc["id"])
    kw = await client.post(f"/api/knowledge/documents/{doc['id']}/keywords")
    assert kw.status_code == 200, kw.text
    names = [x["name"] for x in kw.json()["items"]]
    assert names, "应至少抽出一个关键词"
    assert any("报销" in n or "出差" in n or "差旅" in n for n in names), names

    # 没有向量时走关键词路：用正文里确实出现的词（"报销"）来验通道
    probe = await client.post("/api/knowledge/recall/probe", json={"query": "报销"})
    assert probe.status_code == 200
    body = probe.json()
    assert "latency_ms" in body and isinstance(body["items"], list)
    assert any(x["id"] == doc["id"] for x in body["items"]), "同主题查询应命中刚入库的文档"
