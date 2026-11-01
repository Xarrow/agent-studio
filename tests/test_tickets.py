"""票（Ticket）：阶段从事实算出来，接口只记事实。

要钉住的是那张优先级表 —— 它决定面板第一屏显示什么，判错就会"该找人的不找人"。
"""

from __future__ import annotations

import uuid

from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Agent
from agent_studio.tickets_core import (
    STAGE_ANSWER,
    STAGE_BLOCKED,
    STAGE_IDLE,
    STAGE_QUEUED,
    STAGE_REVIEW,
    STAGE_UNDELIVERED,
    STAGE_WORKING,
    needs_person,
    stage,
)


def uniq(p: str) -> str:
    return f"{p}-{uuid.uuid4().hex[:8]}"


# ── 阶段表（纯函数）──────────────────────────────────────────────────── #


def test_没开始干活算排队():
    assert stage({}) == STAGE_QUEUED


def test_消息没送到优先级最高():
    # 连话都没送到，就别谈后面的事
    assert stage({"undelivered": 1, "attention": {"question": "x"}, "reports": [{"kind": "ready"}]}) == STAGE_UNDELIVERED


def test_有没答的问题就等人():
    assert stage({"attention": {"question": "用哪个分支？"}}) == STAGE_ANSWER
    assert needs_person({"attention": {"question": "x"}}) is True


def test_做完等验收():
    assert stage({"reports": [{"kind": "ready", "at": 10}]}) == STAGE_REVIEW


def test_卡住了要人推一把_人说过话就不再卡():
    blocked = {"reports": [{"kind": "blocked", "at": 10}], "last_human_at": 5}
    assert stage(blocked) == STAGE_BLOCKED
    released = {"reports": [{"kind": "blocked", "at": 10}], "last_human_at": 12}
    assert stage(released) != STAGE_BLOCKED, "人已经回过话，不能还挂在那里"


def test_在跑就是在干():
    assert stage({"assignment": {"status": "running"}}) == STAGE_WORKING


def test_跑完了等下一个触发():
    assert stage({"assignment": {"status": "ok"}, "reports": [{"kind": "waiting", "at": 9}]}) == STAGE_IDLE


def test_结束的票不进第一屏():
    assert stage({"ended_at": 1, "attention": {"question": "x"}}) == STAGE_IDLE


# ── 接口 ─────────────────────────────────────────────────────────────── #


async def test_开一张票_同一线程复用(client):
    await init_db()
    tid = uniq("pr")
    a = (await client.post("/api/tickets", json={"title": "修 PR 的评审意见", "thread_id": tid})).json()
    b = (await client.post("/api/tickets", json={"title": "又开一张", "thread_id": tid})).json()
    assert a["id"] == b["id"], "同一条串不该开出两张票"


async def test_报一句_阶段跟着变(client):
    await init_db()
    tk = (await client.post("/api/tickets", json={"title": "跑一下"})).json()
    assert tk["stage"] == STAGE_QUEUED

    r = (await client.post(f"/api/tickets/{tk['id']}/report", json={"kind": "ready", "text": "改好了"})).json()
    assert r["stage"] == STAGE_REVIEW and r["needs_person"] is True

    q = (await client.post(f"/api/tickets/{tk['id']}/attention", json={"question": "要合并吗？"})).json()
    assert q["stage"] == STAGE_ANSWER, "问题比验收更要紧"

    an = (await client.post(f"/api/tickets/{tk['id']}/answer")).json()
    assert an["stage"] == STAGE_REVIEW, "答完回到验收"


async def test_只想看等人的那些(client):
    await init_db()
    t1 = (await client.post("/api/tickets", json={"title": "等人的"})).json()
    await client.post("/api/tickets", json={"title": "自己跑的"})
    await client.post(f"/api/tickets/{t1['id']}/attention", json={"question": "要不要这样？"})
    got = (await client.get("/api/tickets?needs_person=true")).json()
    ids = [i["id"] for i in got["items"]]
    assert t1["id"] in ids, "等人的票必须出现在第一屏"
    assert all(i["needs_person"] for i in got["items"]), "这个筛选里不许混进不需要人的"


async def test_结束的票默认不列(client):
    await init_db()
    tk = (await client.post("/api/tickets", json={"title": "要结束的"})).json()
    await client.post(f"/api/tickets/{tk['id']}/end", json={"by": "human"})
    got = (await client.get("/api/tickets")).json()
    assert tk["id"] not in [i["id"] for i in got["items"]]


async def test_报告类型写错要拒(client):
    await init_db()
    tk = (await client.post("/api/tickets", json={"title": "x"})).json()
    r = await client.post(f"/api/tickets/{tk['id']}/report", json={"kind": "done"})
    assert r.status_code == 422


async def test_助手不存在要报错(client):
    await init_db()
    r = await client.post("/api/tickets", json={"title": "x", "agent_id": "ag_ghost"})
    assert r.status_code == 404


async def test_一张票能挂一个干活的助手(client):
    await init_db()
    async with SessionLocal() as s:
        a = Agent(slug=uniq("slug"), name=uniq("助手"), description="", runtime="agentscope", definition={"runtime": "agentscope", "name": "x", "tools": [], "skills": []})
        s.add(a)
        await s.commit()
        await s.refresh(a)
        aid = a.id
    tk = (await client.post("/api/tickets", json={"title": "派给谁", "agent_id": aid})).json()
    assert tk["agent_id"] == aid
