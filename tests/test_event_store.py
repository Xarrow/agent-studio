"""事件账本：入队幂等、抢租约、过期回收、退避、死信。

这些断言不看代码写得多漂亮，只看**并发和崩溃时会不会出错**：
同一条事件被两个 worker 抢到 = 事情干两遍；租约过期不回收 = 事件永远卡住。
"""

from __future__ import annotations

from agent_studio.db import SessionLocal, init_db
from agent_studio.events import store
from agent_studio.models import Event, now_ms


async def test_同一件事只入队一次():
    await init_db()
    key = f"dup-{now_ms()}"
    async with SessionLocal() as s:
        a = await store.append(s, "t.dup", dedupe_key=key, payload={"n": 1})
        await s.commit()
        assert a is not None
    async with SessionLocal() as s:
        b = await store.append(s, "t.dup", dedupe_key=key, payload={"n": 2})
        await s.commit()
        assert b is None, "同一个 dedupe_key 不该入队两次"
    async with SessionLocal() as s:
        rows = await store.recent(s, kind="t.dup", limit=50)
    assert sum(1 for r in rows if r.dedupe_key == key) == 1


async def test_没有幂等键的重复事件各算一条():
    await init_db()
    async with SessionLocal() as s:
        await store.append(s, "t.nodedupe", payload={"x": 1})
        await store.append(s, "t.nodedupe", payload={"x": 1})
        await s.commit()
    async with SessionLocal() as s:
        rows = await store.recent(s, kind="t.nodedupe", limit=50)
    assert len(rows) >= 2


async def test_抢租约不会把同一条给两个人():
    await init_db()
    async with SessionLocal() as s:
        await store.append(s, "t.lease", payload={})
        await s.commit()
    async with SessionLocal() as s:
        first = await store.claim(s, limit=10)
        second = await store.claim(s, limit=10)
    ids1 = {e.id for e in first if e.kind == "t.lease"}
    ids2 = {e.id for e in second if e.kind == "t.lease"}
    assert ids1, "第一次应该抢到"
    assert not (ids1 & ids2), "同一条被抢了两次 = 事情会干两遍"


async def test_没到点的不抢():
    await init_db()
    async with SessionLocal() as s:
        ev = await store.append(s, "t.future", available_at=now_ms() + 60_000)
        await s.commit()
        ev_id = ev.id
    async with SessionLocal() as s:
        got = await store.claim(s, limit=50)
    assert ev_id not in {e.id for e in got}


async def test_租约过期自动回队且不扣次数():
    await init_db()
    async with SessionLocal() as s:
        ev = await store.append(s, "t.expire", payload={})
        await s.commit()
        ev_id = ev.id
    # 人为造一个"进程崩了"的场面：handling + 租约已过期
    async with SessionLocal() as s:
        row = await s.get(Event, ev_id)
        row.status = "handling"
        row.lease_until = now_ms() - 1000
        row.attempts = 0
        await s.commit()
    async with SessionLocal() as s:
        n = await store.sweep_leases(s)
        assert n >= 1
        row = await s.get(Event, ev_id)
        assert row.status == "queued"
        assert row.lease_until is None
        assert row.attempts == 0, "没干成不是因为处理逻辑有问题，别提前推它进死信"


async def test_失败会退避重试_试满进死信():
    await init_db()
    async with SessionLocal() as s:
        ev = await store.append(s, "t.fail", payload={})
        await s.commit()
        ev_id = ev.id

    for i in range(store.MAX_ATTEMPTS):
        async with SessionLocal() as s:
            row = await s.get(Event, ev_id)
            if i < store.MAX_ATTEMPTS - 1:
                assert row.status in ("queued", "handling")
            await store.fail(s, row, f"第 {i + 1} 次失败")

    async with SessionLocal() as s:
        row = await s.get(Event, ev_id)
    assert row.attempts == store.MAX_ATTEMPTS
    assert row.status == "dead"
    assert "失败" in (row.error or "")
    assert row.ended_at is not None


async def test_统计按状态分组():
    await init_db()
    async with SessionLocal() as s:
        await store.append(s, "t.stat", payload={})
        await s.commit()
    async with SessionLocal() as s:
        st = await store.stats(s)
    assert isinstance(st.get("queued", 0), int)
    assert sum(st.values()) >= 1
