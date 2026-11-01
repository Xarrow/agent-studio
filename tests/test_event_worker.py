"""事件消费骨架：注册 → 抢 → 跑 → 收尾/退避/死信/hop。

测的是"一条事件在真实循环里会走到哪个结局"，不是 handler 内部逻辑
（handler 各自有测试；这里只用临时注册的假 handler 把六个结局都走一遍）。
"""

from __future__ import annotations

import uuid

from agent_studio.db import SessionLocal, init_db
from agent_studio.events import store, worker
from agent_studio.models import now_ms


def uniq(prefix: str) -> str:
    return f"{prefix}.{uuid.uuid4().hex[:8]}"


async def test_正常处理走完_done():
    await init_db()
    kind = uniq("t.ok")
    seen: list[str] = []

    @worker.register(kind)
    async def _h(session, ev):  # noqa: ANN001
        seen.append(ev.id)
        ev.status = "done"
        ev.ended_at = now_ms()
        await session.commit()

    async with SessionLocal() as s:
        ev = await store.append(s, kind, payload={"a": 1})
        await s.commit()
        ev_id = ev.id
    async with SessionLocal() as s:
        out = await worker.tick(s, limit=50)
    from agent_studio.models import Event

    async with SessionLocal() as s:
        row = await s.get(Event, ev_id)
    assert row.status == "done"
    assert ev_id in seen
    assert out["done"] >= 1
    del worker.handlers()[kind]  # 别影响别的用例


async def test_处理器抛错_退回队列并记原因():
    await init_db()
    kind = uniq("t.boom")

    @worker.register(kind)
    async def _h(session, ev):  # noqa: ANN001
        raise RuntimeError("后端 500")

    async with SessionLocal() as s:
        ev = await store.append(s, kind, payload={})
        await s.commit()
        ev_id = ev.id
    async with SessionLocal() as s:
        out = await worker.tick(s, limit=50)
    from agent_studio.models import Event

    async with SessionLocal() as s:
        row = await s.get(Event, ev_id)
    assert out["failed"] >= 1
    assert row.status == "queued"
    assert row.attempts == 1
    assert "后端 500" in (row.error or "")
    assert row.available_at > now_ms(), "失败要退避，不能立刻重试"
    del worker.handlers()[kind]


async def test_没有处理器的类型直接进死信():
    await init_db()
    kind = uniq("t.orphan")
    async with SessionLocal() as s:
        ev = await store.append(s, kind, payload={})
        await s.commit()
        ev_id = ev.id
    async with SessionLocal() as s:
        await worker.tick(s, limit=50)
    from agent_studio.models import Event

    async with SessionLocal() as s:
        row = await s.get(Event, ev_id)
    assert row.status == "dead"
    assert "没有处理器" in (row.error or "")


async def test_hop达到2只记录不再处理():
    await init_db()
    kind = uniq("t.hop")
    called: list[str] = []

    @worker.register(kind)
    async def _h(session, ev):  # noqa: ANN001
        called.append(ev.id)

    async with SessionLocal() as s:
        ev = await store.append(s, kind, payload={}, hop=worker.HOP_RECORD_ONLY)
        await s.commit()
        ev_id = ev.id
    async with SessionLocal() as s:
        out = await worker.tick(s, limit=50)
    from agent_studio.models import Event

    async with SessionLocal() as s:
        row = await s.get(Event, ev_id)
    assert row.status == "done"
    assert "hop" in (row.error or "")
    assert ev_id not in called, "hop≥2 的事件不能再触发出下一跳（否则自激）"
    assert out["skipped"] >= 1
    del worker.handlers()[kind]


async def test_一条炸了不影响同批其它条():
    await init_db()
    bad = uniq("t.bad")
    good = uniq("t.good")
    ok_ids: list[str] = []

    @worker.register(bad)
    async def _bad(session, ev):  # noqa: ANN001
        raise ValueError("这条故意炸")

    @worker.register(good)
    async def _good(session, ev):  # noqa: ANN001
        ok_ids.append(ev.id)
        ev.status = "done"
        ev.ended_at = now_ms()
        await session.commit()

    async with SessionLocal() as s:
        b = await store.append(s, bad, payload={})
        g = await store.append(s, good, payload={})
        await s.commit()
        gid = g.id
    async with SessionLocal() as s:
        await worker.tick(s, limit=50)
    assert gid in ok_ids, "同批里好的那条必须照常跑完（队头阻塞会把整条队列卡死）"
    del worker.handlers()[bad]
    del worker.handlers()[good]
