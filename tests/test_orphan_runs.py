"""孤儿执行（orphan run）护栏 —— 这类记录会让"停不掉也删不掉"死结重现。

背景（实测踩到）：一条 ``pending`` 的执行如果**不在运行队列里**（重启前遗留、或由
别的进程建出来的），会同时卡住两条路：
  · ``abort`` 只作用于内存里的任务/队列 → 返回"没在跑"，什么也不做；
  · 删除接口要求终态 → 拒绝删除。
于是界面上永远挂着一条"待跑"。更糟的是分发器每轮（1 秒）扫到它都会刷一条
WARNING（定义快照坏了的话），一个坏行 ≈ 每天 8.6 万条日志。

守住两条：
① ``abort`` 对"不在队列里的 pending/running"必须直接落终态（之后可删）；
② 分发器遇到坏快照要**标成 error 收口**，不能每轮重扫重刷（也不再留在 pending）。
"""

import pytest
from sqlalchemy import select

from agent_studio.models import Agent, Run, new_id, now_ms


async def _mk_agent() -> str:
    from agent_studio.db import SessionLocal

    async with SessionLocal() as s:
        ag = Agent(
            id=new_id("ag"),
            workspace_id="default",
            slug=f"orphan-{new_id('x')[-6:]}",
            name=f"孤儿护栏-{new_id('x')[-6:]}",
            runtime="agentscope",
            definition={
                "name": "孤儿护栏",
                "model": {"provider": "deepseek", "name": "deepseek-chat"},
                "tools": [],
            },
            created_at=now_ms(),
            updated_at=now_ms(),
        )
        s.add(ag)
        await s.commit()
        return ag.id


@pytest.mark.asyncio
async def test_不在队列里的_pending_也能被中断_否则删不掉(client):
    from agent_studio.db import SessionLocal
    from agent_studio.runner.service import run_service

    aid = await _mk_agent()
    async with SessionLocal() as s:
        run = Run(id=new_id("run"), agent_id=aid, status="pending", started_at=now_ms(),
                  input={"text": "孤儿"}, definition_snapshot={"name": "孤儿护栏"})
        s.add(run)
        await s.commit()
        rid = run.id

    assert await run_service.abort(rid) is True, "不在队列里的 pending 也必须能中止"

    async with SessionLocal() as s:
        row = await s.get(Run, rid)
        assert row.status == "aborted"
        assert row.ended_at is not None, "落终态要带结束时间，否则界面上是'跑了几十年'"
        assert "不在运行队列" in (row.error or "")

    # 终态之后删除接口才放行（这里直接验库里的前置条件）
    async with SessionLocal() as s:
        assert (await s.get(Run, rid)).status in ("aborted", "error", "ok")


@pytest.mark.asyncio
async def test_坏快照的_pending_被标_error_收口_不再每轮重扫(client):
    from agent_studio.db import SessionLocal
    from agent_studio.runner.dispatcher import dispatcher

    aid = await _mk_agent()
    async with SessionLocal() as s:
        run = Run(id=new_id("run"), agent_id=aid, status="pending", started_at=now_ms(),
                  input={"text": "坏快照"}, definition_snapshot={"tools": []})  # 缺 name → 解析必失败
        s.add(run)
        await s.commit()
        rid = run.id

    await dispatcher.tick()

    async with SessionLocal() as s:
        row = await s.get(Run, rid)
        assert row.status == "error", "坏快照必须收口，不能永远留在 pending"
        assert "快照" in (row.error or "")
        assert row.ended_at is not None

    # 再 tick 一轮：已经不在 pending 里，不会被重复处理（日志不再刷）
    started = await dispatcher.tick()
    assert rid not in started


@pytest.mark.asyncio
async def test_坏快照收口后可以被删除(client):
    """end-to-end：坏快照 pending → tick 收口 → DELETE 接口放行。"""
    from agent_studio.db import SessionLocal
    from agent_studio.runner.dispatcher import dispatcher

    aid = await _mk_agent()
    async with SessionLocal() as s:
        run = Run(id=new_id("run"), agent_id=aid, status="pending", started_at=now_ms(),
                  input={"text": "坏快照2"}, definition_snapshot={})
        s.add(run)
        await s.commit()
        rid = run.id

    await dispatcher.tick()
    r = await client.delete(f"/api/runs/{rid}")
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] == 1

    async with SessionLocal() as s:
        assert (await s.execute(select(Run).where(Run.id == rid))).scalars().first() is None
