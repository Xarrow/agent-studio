"""「自动挑助手」发一句话：定助手 → 定会话 → 起 run，一次往返做完。

要守的底线：
- 认不出来就不猜（返回 needs_choice，让用户挑）
- 会话不能跨助手复用（A 的上下文喂给 B 是最难查的一类事故）
- 规则指向的助手真的会被选中
"""

from __future__ import annotations

import uuid

from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Agent, Session as ChatSession


def uniq(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


async def _agent(name: str, desc: str = "") -> str:
    async with SessionLocal() as s:
        a = Agent(
            slug=uniq("slug"),
            name=name,
            description=desc,
            runtime="agentscope",
            definition={"runtime": "agentscope", "name": name, "tools": [], "skills": []},
        )
        s.add(a)
        await s.commit()
        await s.refresh(a)
        return a.id


async def test_规则命中就自动开跑并建会话(client):
    await init_db()
    await _agent("编程助手", "写代码")
    report = await _agent("周报助手", "整理周报")
    await client.post("/api/routes", json={"agent_id": report, "pattern": "周报", "priority": 10})

    r = await client.post("/api/routes/preview", json={"text": "写个周报"})
    assert r.json()["agent_id"] == report  # 先确认规则本身生效

    resp = await client.post("/api/runs/auto-start", json={"input": "帮我写个周报，三条以内"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["kind"] == "started", body
    assert body["agent_id"] == report
    assert body["route"]["layer"] == 1
    assert body["session_id"].startswith("ses_")
    assert body["run"]["agent_id"] == report
    assert body["run"]["session_id"] == body["session_id"]


async def test_认不出来就问_不硬派(client):
    await init_db()
    await _agent("编程助手", "写代码")
    await _agent("周报助手", "整理周报")
    resp = await client.post("/api/runs/auto-start", json={"input": "今天天气不错"})
    body = resp.json()
    assert body["kind"] == "needs_choice", body
    d = body["decision"]
    assert d["agent_id"] is None
    assert d["alternatives"], "得把能选的助手摆出来"


async def test_会话属于别的助手时要新建而不是串台(client):
    await init_db()
    # 规则词带随机后缀：同一个测试库里别的用例也注册过"周报"，同优先级会抢在前面
    word = f"周报{uniq('w')}"
    code = await _agent("编程助手", "写代码")
    report = await _agent("周报助手", "整理周报")
    await client.post("/api/routes", json={"agent_id": report, "pattern": word, "priority": 10})

    async with SessionLocal() as s:
        other = ChatSession(agent_id=code, title="编程的对话", status="active")
        s.add(other)
        await s.commit()
        await s.refresh(other)
        other_id = other.id

    body = (
        await client.post(
            "/api/runs/auto-start",
            json={"input": f"把本周的{word}整理一下", "session_id": other_id},
        )
    ).json()
    assert body["kind"] == "started"
    assert body["session_id"] != other_id, "A 的会话不能拿来跑 B"
    assert body["run"]["agent_id"] == report


async def test_同一个助手的会话可以沿用(client):
    await init_db()
    word = f"月报{uniq('w')}"
    report = await _agent("月报助手", "整理月报")
    await client.post("/api/routes", json={"agent_id": report, "pattern": word, "priority": 10})

    first = (await client.post("/api/runs/auto-start", json={"input": f"写个{word}"})).json()
    second = (
        await client.post(
            "/api/runs/auto-start",
            json={"input": f"{word}再补一条", "session_id": first["session_id"]},
        )
    ).json()
    assert first["kind"] == "started" and second["kind"] == "started"
    assert second["session_id"] == first["session_id"], "同一个助手的追问应该接着上一个会话"
    assert second["run"]["session_id"] == first["session_id"]
