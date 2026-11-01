"""分派树的三道闸（结构环 / 树预算 / 语义重复）—— 真库、真判定。

为什么单独钉这三条：它们错了不会报错，只会**悄悄多花钱**——一棵写坏了的树
在十分钟里把一天的额度跑光是"看起来一切正常"的那种失败。
"""

from __future__ import annotations

import uuid

from sqlalchemy import select

from agent_studio import fanout
from agent_studio.db import SessionLocal, init_db
from agent_studio.limits import fingerprint_of
from agent_studio.models import Run, now_ms
from agent_studio.quota import TREE_BUDGET_KEY
from agent_studio.settings_store import set_setting

from test_spans import SpanRuntime  # 复用桩运行时（会发真事件流）


def uniq(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


async def _run(**kw) -> Run:
    """造一条 run（默认 runnning 的根）。"""
    async with SessionLocal() as s:
        run = Run(
            agent_id=kw.get("agent_id") or uniq("ag"),
            agent_version=1,
            runtime=SpanRuntime.name,
            status=kw.get("status", "running"),
            input={"text": kw.get("text", "任务")},
            definition_snapshot={"runtime": SpanRuntime.name, "name": "甲", "tools": []},
            started_at=kw.get("started_at", now_ms()),
            parent_run_id=kw.get("parent_run_id"),
            root_run_id=kw.get("root_run_id"),
            dispatch_path=kw.get("dispatch_path"),
            task_fingerprint=kw.get("task_fingerprint"),
            tree_budget=kw.get("tree_budget"),
            tree_spent=kw.get("tree_spent", 0),
            item_index=kw.get("item_index"),
        )
        s.add(run)
        await s.commit()
        await s.refresh(run)
        return run


async def test_结构环_派回链上游的助手被拦():
    await init_db()
    root = await _run(agent_id="ag_root", dispatch_path="ag_root")
    child = await _run(
        agent_id="ag_child",
        parent_run_id=root.id,
        root_run_id=root.id,
        dispatch_path="ag_root>ag_child",
    )
    # 子执行想把活派回 ag_root —— 这就是 A→B→A
    gate = await fanout._tree_gate(
        parent_run=child, agent_id="ag_root", picked=["再算一遍"], db_factory=SessionLocal
    )
    assert gate["blocked"] is True
    assert gate["kind"] == "cycle"
    assert "ag_root" in gate["reason"]


async def test_结构环_派给没出现过的助手放行():
    await init_db()
    root = await _run(agent_id="ag_r2", dispatch_path="ag_r2")
    child = await _run(
        agent_id="ag_c2", parent_run_id=root.id, root_run_id=root.id,
        dispatch_path="ag_r2>ag_c2",
    )
    gate = await fanout._tree_gate(
        parent_run=child, agent_id="ag_new", picked=["新活"], db_factory=SessionLocal
    )
    assert not gate.get("blocked")
    assert gate["root"].id == root.id


async def test_树预算_用完就拦():
    await init_db()
    root = await _run(agent_id="ag_b1", dispatch_path="ag_b1", tree_budget=1000, tree_spent=1200)
    child = await _run(
        agent_id="ag_b2", parent_run_id=root.id, root_run_id=root.id,
        dispatch_path="ag_b1>ag_b2",
    )
    gate = await fanout._tree_gate(
        parent_run=child, agent_id="ag_b3", picked=["再派一路"], db_factory=SessionLocal
    )
    assert gate["blocked"] is True
    assert gate["kind"] == "budget"
    assert "1000" in gate["reason"] and "1200" in gate["reason"]


async def test_树预算_没设上限不拦():
    await init_db()
    async with SessionLocal() as s:
        await set_setting(s, TREE_BUDGET_KEY, 0)
        await s.commit()
    root = await _run(agent_id="ag_u1", dispatch_path="ag_u1", tree_budget=None)
    gate = await fanout._tree_gate(
        parent_run=root, agent_id="ag_u2", picked=["随便派"], db_factory=SessionLocal
    )
    assert not gate.get("blocked")


async def test_树预算_老数据按平台设定补上():
    await init_db()
    async with SessionLocal() as s:
        await set_setting(s, TREE_BUDGET_KEY, 50_000)
        await s.commit()
    root = await _run(agent_id="ag_fill", dispatch_path="ag_fill", tree_budget=None)
    gate = await fanout._tree_gate(
        parent_run=root, agent_id="ag_x", picked=["活"], db_factory=SessionLocal
    )
    assert gate["root"].tree_budget == 50_000


async def test_语义重复_同树同助手同任务直接复用():
    await init_db()
    root = await _run(agent_id="ag_s1", dispatch_path="ag_s1", tree_budget=None)
    task = "总结这一份报告"
    fp = fingerprint_of("ag_s2", task)
    done = await _run(
        agent_id="ag_s2", parent_run_id=root.id, root_run_id=root.id,
        dispatch_path="ag_s1>ag_s2", task_fingerprint=fp, status="ok",
    )
    # 另一个分支又要派同样的活（措辞不同、标点不同）
    sibling = await _run(
        agent_id="ag_s3", parent_run_id=root.id, root_run_id=root.id,
        dispatch_path="ag_s1>ag_s3",
    )
    gate = await fanout._tree_gate(
        parent_run=sibling, agent_id="ag_s2", picked=["总结 这一份报告。"],
        db_factory=SessionLocal,
    )
    assert not gate.get("blocked")
    assert gate["reuse"].get(0) is not None
    assert gate["reuse"][0].id == done.id


async def test_语义重复_显式allow_duplicate就照派():
    await init_db()
    root = await _run(agent_id="ag_d1", dispatch_path="ag_d1")
    task = "再跑一次同样的活"
    fp = fingerprint_of("ag_d2", task)
    await _run(
        agent_id="ag_d2", parent_run_id=root.id, root_run_id=root.id,
        dispatch_path="ag_d1>ag_d2", task_fingerprint=fp, status="ok",
    )
    sibling = await _run(
        agent_id="ag_d3", parent_run_id=root.id, root_run_id=root.id,
        dispatch_path="ag_d1>ag_d3",
    )
    gate = await fanout._tree_gate(
        parent_run=sibling, agent_id="ag_d2", picked=[task],
        allow_duplicate=True, db_factory=SessionLocal,
    )
    assert not gate["reuse"]


async def test_树的token记账只记在根上():
    await init_db()
    root = await _run(agent_id="ag_t1", dispatch_path="ag_t1", tree_budget=10_000, tree_spent=0)
    await fanout._add_tree_spend(root.id, 1234)
    async with SessionLocal() as s:
        got = await s.get(Run, root.id)
        assert int(got.tree_spent) == 1234
        # 子执行不记账（各自记就等于没上限）
        kids = list((await s.execute(select(Run).where(Run.parent_run_id == root.id))).scalars())
        assert all(int(k.tree_spent or 0) == 0 for k in kids)
