"""远端 HITL 确认后，子 run 要被回填 —— 后台续轮询护栏。

真出过的缺口（自注册端到端验证时暴露）：远端平台的 agent 用工具要人确认，
``run_until_done`` 撞到 input-required 立即返回（父 run 不该干等），但远端
被确认后会继续跑出终态 —— 以前没人接着轮，子 run 永远停在 waiting_hitl，
用户在远端点了「同意」也看不到结果。

``_repoll_until_done`` 接管：出终态就回填子 run 并清 pending_hitl；
本地已重跑/中止的子 run 不覆盖。
"""

import asyncio

import pytest
from sqlalchemy import select

from agent_studio import a2a_client, fanout
from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Run, now_ms


@pytest.fixture(autouse=True)
async def _db():
    await init_db()


class _FakeTask(dict):
    pass


def _task(state: str, text: str = "") -> dict:
    # 与 A2A Task 结构一致：status.state + status.message.parts[].text（artifacts 优先）
    return {
        "status": {
            "state": state,
            "message": {"parts": [{"kind": "text", "text": text}]},
        }
    }


async def test_远端确认后子run被回填():
    rid = "run_repoll_guard_1"
    async with SessionLocal() as s:
        s.add(
            Run(
                id=rid,
                agent_id="ag_x",
                agent_version=1,
                runtime="a2a",
                status="waiting_hitl",
                input={"text": "x"},
                definition_snapshot={},
                started_at=now_ms(),
                pending_hitl={"remote": "http://10.0.0.1:1", "remote_task_id": "t1"},
            )
        )
        await s.commit()
    states = iter([_task("working"), _task("input-required"), _task("completed", "确认后的答案")])

    async def fake_get_task(base, task_id, headers=None):
        return next(states)

    async def fake_sleep(s_):
        return None

    orig_get, orig_sleep = a2a_client.get_task, asyncio.sleep
    a2a_client.get_task = fake_get_task
    asyncio.sleep = fake_sleep
    try:
        await fanout._repoll_until_done(rid, "http://10.0.0.1:1", "t1", 30.0, None, None)
    finally:
        a2a_client.get_task = orig_get
        asyncio.sleep = orig_sleep
    async with SessionLocal() as s:
        row = await s.get(Run, rid)
        try:
            assert row.status == "ok"
            assert (row.output or {}).get("content") == "确认后的答案"
            assert row.pending_hitl is None
        finally:
            await s.delete(row)
            await s.commit()


async def test_本地已重跑的子run不被覆盖():
    rid = "run_repoll_guard_2"
    async with SessionLocal() as s:
        s.add(
            Run(
                id=rid,
                agent_id="ag_x",
                agent_version=1,
                runtime="a2a",
                status="ok",  # 用户已重跑成功 —— 后台续轮询必须让位
                input={"text": "x"},
                definition_snapshot={},
                started_at=now_ms(),
                output={"content": "本地重跑的结果"},
            )
        )
        await s.commit()

    async def fake_get_task(base, task_id, headers=None):
        return _task("completed", "远端迟到的答案")

    orig = a2a_client.get_task
    a2a_client.get_task = fake_get_task
    try:
        await fanout._repoll_until_done(rid, "http://10.0.0.1:1", "t9", 30.0, None, None)
    finally:
        a2a_client.get_task = orig
    async with SessionLocal() as s:
        row = await s.get(Run, rid)
        try:
            assert row.status == "ok"
            assert (row.output or {}).get("content") == "本地重跑的结果"  # 没被覆盖
        finally:
            await s.delete(row)
            await s.commit()


async def test_远端连不上就放手():
    """远端彻底连不上：安静退出，子 run 保持 waiting_hitl（pending_hitl 里留着 task_id）。"""
    rid = "run_repoll_guard_3"
    async with SessionLocal() as s:
        s.add(
            Run(
                id=rid,
                agent_id="ag_x",
                agent_version=1,
                runtime="a2a",
                status="waiting_hitl",
                input={"text": "x"},
                definition_snapshot={},
                started_at=now_ms(),
                pending_hitl={"remote": "http://10.0.0.1:1", "remote_task_id": "t3"},
            )
        )
        await s.commit()

    async def fake_get_task(base, task_id, headers=None):
        raise a2a_client.A2AError("connection refused")

    orig = a2a_client.get_task
    a2a_client.get_task = fake_get_task
    try:
        await fanout._repoll_until_done(rid, "http://10.0.0.1:1", "t3", 30.0, None, None)
    finally:
        a2a_client.get_task = orig
    async with SessionLocal() as s:
        row = await s.get(Run, rid)
        try:
            assert row.status == "waiting_hitl"  # 如实保留，不乱改
        finally:
            await s.delete(row)
            await s.commit()


async def test_分发器不抢a2a子run():
    """dispatch_remote 建的 a2a 子 run（快照为空、由远端轮询推进）不该被
    本地分发器抢走 —— 它的空快照会被误判「定义快照无法解析」落死。
    真出过：dispatcher 的 pending 扫描没过滤 runtime，a2a 子 run 被打死。"""
    from sqlalchemy import select as _sel

    from agent_studio.models import Run
    from agent_studio.runner.dispatcher import Dispatcher

    rid = "run_a2a_nosteal_1"
    async with SessionLocal() as s:
        s.add(
            Run(
                id=rid,
                agent_id="ag_x",
                agent_version=1,
                runtime="a2a",
                status="pending",  # dispatch_remote 刚建、还没被 _one() 更新
                input={"text": "x"},
                definition_snapshot={},  # a2a 子 run 的快照就是空的
                started_at=now_ms(),
            )
        )
        await s.commit()

    d = Dispatcher()  # 只用扫描逻辑，不起后台循环
    d.is_running = lambda _id: False  # type: ignore[method-assign]
    started = await d.tick()

    async with SessionLocal() as s:
        row = await s.get(Run, rid)
        try:
            assert row.status == "pending"  # 没被抢、没被打死
            assert rid not in (started or [])
        finally:
            await s.delete(row)
            await s.commit()
