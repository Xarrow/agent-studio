"""事件 → 待办 的整条链：护栏拦下 → 入账 → 处理器补"怎么办" → 待办里看得见。

只测到"库里有一行"是不够的：用户看到的是待办面板，所以最后一步必须断言
``/api/runs/attention`` 里真的出现了这一条，并且带着能直接显示的话。
"""

from __future__ import annotations

import uuid

from agent_studio.db import SessionLocal, init_db
from agent_studio.events import store, worker
from agent_studio.models import Event, now_ms


def uniq(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


async def test_事件接口给出统计与已注册类型(client):
    r = await client.get("/api/events")
    assert r.status_code == 200
    d = r.json()
    assert "stats" in d and isinstance(d["stats"], dict)
    assert "fanout.blocked" in d["handlers"]
    assert isinstance(d["items"], list)


async def test_死信接口能列出缺处理器的事件(client):
    await init_db()
    kind = uniq("t.orphan.api")
    async with SessionLocal() as s:
        await store.append(s, kind, payload={"why": "没人认领"})
        await s.commit()
    async with SessionLocal() as s:
        await worker.tick(s, limit=50)
    r = await client.get("/api/events/dead")
    assert r.status_code == 200
    rows = r.json()
    assert any(e["kind"] == kind for e in rows), "缺处理器的类型必须能在死信里看到"


async def test_派发被拦_待办里出现并带下一步(client):
    await init_db()
    run_id = uniq("run_blk")
    async with SessionLocal() as s:
        ev = await store.append(
            s,
            "fanout.blocked",
            subject_kind="run",
            subject_id=run_id,
            payload={
                "blocked": "budget",
                "reason": "这棵树的预算已用完（上限 1000 token，已花 1500）",
                "agent_id": "ag_demo",
            },
            dedupe_key=f"fanout.blocked:{run_id}:budget:ag_demo",
        )
        await s.commit()
        ev_id = ev.id

    # 消费一轮（真 handler：把原因翻译成"下一步怎么办"）
    async with SessionLocal() as s:
        await worker.tick(s, limit=50)

    async with SessionLocal() as s:
        row = await s.get(Event, ev_id)
    assert row.status == "done"
    payload = row.payload or {}
    assert payload.get("title") == "派发被拦：树额度用完"
    assert "每棵树" in (payload.get("hint") or ""), "要给出具体去哪儿改，不能只说'失败了'"

    d = (await client.get("/api/runs/attention")).json()
    blocked = [i for i in d["items"] if i["kind"] == "blocked"]
    assert blocked, "被拦的派发必须出现在待办里"
    assert blocked[0]["run_id"] == run_id
    assert "预算已用完" in blocked[0]["reason"]
    assert d["counts"]["blocked"] >= 1


async def test_同一路重复被拦_待办只留一条(client):
    await init_db()
    run_id = uniq("run_blk2")
    async with SessionLocal() as s:
        for _ in range(5):
            await store.append(
                s,
                "fanout.blocked",
                subject_kind="run",
                subject_id=run_id,
                payload={"blocked": "cycle", "reason": "会成环", "agent_id": "ag_x"},
                dedupe_key=f"fanout.blocked:{run_id}:cycle:ag_x",
            )
        await s.commit()
    async with SessionLocal() as s:
        await worker.tick(s, limit=50)
    d = (await client.get("/api/runs/attention")).json()
    same = [i for i in d["items"] if i["kind"] == "blocked" and i["run_id"] == run_id]
    assert len(same) == 1, "同一件事刷屏 5 次等于教用户无视待办"
