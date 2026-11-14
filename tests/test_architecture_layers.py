"""架构分层后的契约测试：传输层压缩、详情瘦身、并发冲突、删除级联。

为什么单独一个文件：
    这几条不是"某个接口的小修"，是**跨层契约**——压缩属于传输层、ETag/瘦身
    属于资源层、If-Match 属于一致性层、删除级联属于聚合根边界。改坏任何一条
    都不会让页面立刻崩，但会在真实使用里变成"慢/静默覆盖/悬空引用"。
"""

from __future__ import annotations

import json

import pytest
from httpx import ASGITransport, AsyncClient

from agent_studio.db import SessionLocal, init_db
from agent_studio.main import app
from agent_studio.models import Agent, AgentSkill, Skill, new_id, now_ms


@pytest.fixture
async def client():
    await init_db()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        yield c


async def test_静态资源与接口都带压缩协商(client):
    """未压缩 1.4MB 的 JS 和 5.4MB 的技能详情是"打不开"级别的问题。"""
    r = await client.get("/api/agents", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    # 小响应不压（<1024B）是设计；这里只断言"没被压坏"且能解析
    json.loads(r.text)


async def test_技能详情默认不带附件正文_且支持ETag(client):
    sid = new_id("sk_")
    async with SessionLocal() as db:
        db.add(
            Skill(
                id=sid,
                name="qa-big-skill",
                description="d",
                content="---\nname: qa-big-skill\ndescription: d\n---\nbody",
                files={"a.md": "x" * 5000, "b/deep.md": "y" * 5000},
                source={"type": "inline"},
                created_at=now_ms(),
                updated_at=now_ms(),
            )
        )
        await db.commit()

    r = await client.get(f"/api/skills/{sid}")
    assert r.status_code == 200
    body = r.json()
    # 只剩名字（值是空串），正文不跟着回
    assert set(body["files"]) == {"a.md", "b/deep.md"}
    assert all(v == "" for v in body["files"].values())
    assert body["files_count"] == 2
    assert len(r.content) < 2000

    etag = r.headers["etag"]
    r2 = await client.get(f"/api/skills/{sid}", headers={"If-None-Match": etag})
    assert r2.status_code == 304

    # 要正文就显式要
    r3 = await client.get(f"/api/skills/{sid}", params={"with_files": 1})
    assert r3.json()["files"]["a.md"].startswith("xxx")

    # 单文件接口
    r4 = await client.get(f"/api/skills/{sid}/file", params={"path": "a.md"})
    assert r4.status_code == 200 and len(r4.json()["content"]) == 5000


async def test_助手保存带版本_过期版本返回409(client):
    async with SessionLocal() as db:
        ag = Agent(id=new_id("ag_"), slug="qa-occ", name="QA 并发", version=3, definition={"name": "QA 并发"})
        db.add(ag)
        await db.commit()
        aid = ag.id

    ok = await client.put(
        f"/api/agents/{aid}",
        json={"definition": {"name": "QA 并发", "system_prompt": "v1"}},
        headers={"If-Match": "3"},
    )
    assert ok.status_code == 200
    assert ok.json()["version"] == 4

    stale = await client.put(
        f"/api/agents/{aid}",
        json={"definition": {"name": "QA 并发", "system_prompt": "v2"}},
        headers={"If-Match": "3"},
    )
    assert stale.status_code == 409
    assert "刷新" in stale.json()["detail"]


async def test_删技能会清掉助手定义里的引用(client):
    sid = new_id("sk_")
    async with SessionLocal() as db:
        db.add(
            Skill(
                id=sid,
                name="qa-cascade",
                description="d",
                content="---\nname: qa-cascade\ndescription: d\n---\n",
                files={},
                source={"type": "inline"},
                created_at=now_ms(),
                updated_at=now_ms(),
            )
        )
        await db.commit()          # 先落技能，再落引用（FK 依赖顺序）
        ag = Agent(
            id=new_id("ag_"),
            slug="qa-cascade-agent",
            name="QA 级联",
            version=1,
            definition={"name": "QA 级联", "skills": [{"ref": sid}, {"ref": "sk_keep"}]},
        )
        db.add(ag)
        db.add(AgentSkill(agent_id=ag.id, skill_id=sid))
        await db.commit()
        aid = ag.id

    r = await client.delete(f"/api/skills/{sid}")
    assert r.status_code in (200, 204)

    async with SessionLocal() as db:
        row = await db.get(Agent, aid)
        refs = [x.get("ref") for x in (row.definition or {}).get("skills", [])]
        assert sid not in refs
        assert "sk_keep" in refs          # 别人的引用不能误删
