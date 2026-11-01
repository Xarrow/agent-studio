"""「待你处理」：只回答一个问题 —— 现在有什么在等我。

口径（少报 > 多报，列表本身已经能翻历史）：
* `waiting_hitl` 排最前：它在等你，不动就永远不动；
* 停滞判死的排第二（它已经烧过钱了，但至少停了）；
* 普通失败排第三；
* 分派子执行 / 编排 worker 不算（它们的失败已经在父行/编排里说过一次）；
* aborted 不算（人自己停的）；只看 24 小时内。
"""

from __future__ import annotations

from agent_studio.db import SessionLocal
from agent_studio.models import Run, now_ms


async def _mk(**kw) -> str:
    async with SessionLocal() as s:
        r = Run(
            agent_id=kw.get("agent_id", "ag_attn"),
            agent_version=1,
            runtime="agentscope",
            status=kw["status"],
            input={"text": "干活"},
            definition_snapshot={"runtime": "agentscope", "name": "甲"},
            started_at=kw.get("started_at", now_ms()),
            error=kw.get("error"),
            parent_run_id=kw.get("parent_run_id"),
            orchestration_id=kw.get("orchestration_id"),
        )
        s.add(r)
        await s.commit()
        await s.refresh(r)
        return r.id


async def test_三类待办按紧急度排序(client):
    hitl = await _mk(status="waiting_hitl")
    stalled = await _mk(status="error", error="停滞：同一步重复了 3 次没有新结果（bash pytest）")
    failed = await _mk(status="error", error="ValueError: api_key 缺失")

    d = (await client.get("/api/runs/attention")).json()
    kinds = [i["kind"] for i in d["items"]]
    assert kinds[:3] == ["hitl", "stalled", "failed"], kinds
    assert d["counts"]["hitl"] >= 1 and d["counts"]["stalled"] >= 1
    got = {i["run_id"] for i in d["items"]}
    assert {hitl, stalled, failed} <= got


async def test_子执行与编排worker不算待办(client):
    child = await _mk(status="error", error="子执行失败", parent_run_id="run_parent_x")
    worker = await _mk(status="error", error="步骤失败", orchestration_id="orc_x")
    d = (await client.get("/api/runs/attention")).json()
    ids = {i["run_id"] for i in d["items"]}
    assert child not in ids
    assert worker not in ids


async def test_中止的不算待办(client):
    aborted = await _mk(status="aborted", error="用户中止")
    d = (await client.get("/api/runs/attention")).json()
    assert aborted not in {i["run_id"] for i in d["items"]}


async def test_太老的不算待办(client):
    old = await _mk(status="error", error="三天前的失败", started_at=now_ms() - 3 * 24 * 3600 * 1000)
    d = (await client.get("/api/runs/attention")).json()
    assert old not in {i["run_id"] for i in d["items"]}


async def test_没有待办时是空列表而不是报错(client):
    async with SessionLocal() as s:
        from sqlalchemy import delete

        from agent_studio.models import Event

        await s.execute(delete(Run))
        # 待办还有一路来源是事件账本（护栏拦下的派发），一起清掉才能验"真的一条都没有"
        await s.execute(delete(Event))
        await s.commit()
    d = (await client.get("/api/runs/attention")).json()
    assert d["counts"]["total"] == 0
    assert d["items"] == []
