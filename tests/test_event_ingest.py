"""事件入口：两级过滤 + 订阅直通 + 常驻 Router。

照《Super-agent》§3 落地的最小一份。要盯住三件事：
1. 程序层就该挡掉的，不许惊动模型（空/超长/重复投递）
2. thread 认过人之后，后续事件**不过 Router**（实验：省 30% 决策、37% 读缓存 token）
3. Router 是同一份常驻会话，不是每条事件新开一个
"""

from __future__ import annotations

import uuid

from agent_studio.db import SessionLocal, init_db
from agent_studio.events.ingest import (
    MAX_TEXT,
    accept,
    bind_thread,
    dedupe_key_of,
    ingest,
    ROUTER_SESSION_TITLE,
)
from agent_studio.models import Agent, Session as ChatSession


def uniq(p: str) -> str:
    return f"{p}-{uuid.uuid4().hex[:8]}"


def _definition(name: str, role: str = "worker") -> dict:
    return {
        "runtime": "agentscope",
        "name": name,
        "role": role,
        "tools": [],
        "skills": [],
        "model": {"provider": "deepseek", "name": "deepseek-flash", "params": {}, "credential_ref": None},
    }


async def _agent(name: str, role: str = "worker") -> str:
    async with SessionLocal() as s:
        a = Agent(slug=uniq("slug"), name=name, description="", runtime="agentscope", definition=_definition(name, role))
        s.add(a)
        await s.commit()
        await s.refresh(a)
        return a.id


# ── 程序层准入（纯函数）──────────────────────────────────────────────── #


def test_空事件不进去():
    assert accept("github", "   ")[0] is False


def test_超长事件不进去():
    ok, why = accept("github", "x" * (MAX_TEXT + 1))
    assert ok is False and "太长" in why


def test_正常事件进去():
    assert accept("github", "PR #12 有新的评审评论")[0] is True


def test_幂等键看内容和外部序号():
    a = dedupe_key_of("github", "pr-12", "hello", {"seq": 1})
    b = dedupe_key_of("github", "pr-12", "hello", {"seq": 1})
    c = dedupe_key_of("github", "pr-12", "hello", {"seq": 2})
    d = dedupe_key_of("github", "pr-13", "hello", {"seq": 1})
    assert a == b and a != c and a != d


# ── 交给 Router ──────────────────────────────────────────────────────── #


async def test_没有编排者就明确说没有(monkeypatch):
    await init_db()
    # 平台默认会种一个编排者，这里把解析打桩成"一个都没有"，专测这条退路
    from agent_studio.events import ingest as mod

    async def none(_session):
        return None

    monkeypatch.setattr(mod, "_router_agent", none)
    async with SessionLocal() as s:
        r = await ingest(s, source="github", text="有新的 PR 评论")
    assert r["kind"] == "error"
    assert "编排者" in r["reason"]


async def test_事件投给常驻的Router会话():
    await init_db()
    # 名字用唯一的：测试库整会话共用一个，平台默认还会种一个叫「编排者」的
    rid = await _agent(uniq("总协调"), role="orchestrator")
    async with SessionLocal() as s:
        r1 = await ingest(s, source="github", text="PR #12 有新评论")
    assert r1["kind"] == "router", r1
    async with SessionLocal() as s:
        chat = await s.get(ChatSession, r1["session_id"])
        assert chat is not None and chat.title == ROUTER_SESSION_TITLE
        assert chat.agent_id == r1["agent_id"]
        picked = await s.get(Agent, r1["agent_id"])
        assert (picked.definition or {}).get("role") == "orchestrator", "Router 必须是编排者角色"
    _ = rid
    # 第二条事件必须落回**同一份**会话 —— 常驻上下文才是 Router 的价值
    async with SessionLocal() as s:
        r2 = await ingest(s, source="email", text="一封新邮件：预算要确认")
    assert r2["session_id"] == r1["session_id"]


# ── 订阅直通 ─────────────────────────────────────────────────────────── #


async def test_thread_认过人之后直投_不过_Router():
    await init_db()
    await _agent("编排者", role="orchestrator")
    worker_id = await _agent("干活的人")
    async with SessionLocal() as s:
        chat = ChatSession(id=f"ses_{uuid.uuid4().hex[:12]}", agent_id=worker_id, title="PR-77")
        s.add(chat)
        await s.commit()
        await bind_thread(s, "pr-77", chat.id)

        r = await ingest(s, source="github", thread_id="pr-77", text="同一条 PR 又来了一条评论")
    assert r["kind"] == "thread", r
    assert r["session_id"] == chat.id
    assert r["agent_id"] == worker_id, "直投给认领它的人，不再回 Router"


# ── 接口层 ───────────────────────────────────────────────────────────── #


async def test_同一条事件重投只处理一次(client):
    await init_db()
    await _agent(uniq("事件编排"), role="orchestrator")
    body = {"source": "ci", "text": "构建 #31 失败了", "meta": {"seq": 31}}
    first = (await client.post("/api/events/ingest", json=body)).json()
    assert first["kind"] == "router", first
    second = (await client.post("/api/events/ingest", json=body)).json()
    assert second["kind"] == "duplicate", second

    # 账本里能查到这条事件，以及它落到了谁手上
    evs = (await client.get("/api/events?limit=20")).json()["items"]
    kinds = [e["kind"] for e in evs]
    assert "event.ingested" in kinds
    assert any(k.startswith("event.router") for k in kinds)


async def test_接口层_thread_直投(client):
    await init_db()
    await _agent(uniq("事件编排"), role="orchestrator")
    wid = await _agent("盯 PR 的人")
    async with SessionLocal() as s:
        chat = ChatSession(id=f"ses_{uuid.uuid4().hex[:12]}", agent_id=wid, title="PR-99")
        s.add(chat)
        await s.commit()
    r = await client.post("/api/events/threads", json={"thread_id": "pr-99", "session_id": chat.id})
    assert r.status_code == 200, r.text

    got = (await client.post("/api/events/ingest", json={"source": "github", "thread_id": "pr-99", "text": "新评论"})).json()
    assert got["kind"] == "thread" and got["session_id"] == chat.id
