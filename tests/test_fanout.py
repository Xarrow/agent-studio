"""护栏：分派（fan-out）—— 一个助手把自己的任务拆成 N 份并行走。

这一批钉的是"错了不报错、只是行为悄悄不对"的地方：
  ① 每一路都必须是一条**独立 run**（带 node_id / item_index / parent_run_id）——
     否则界面上看不见、成本算不清、失败项没法单独重跑（需求本体）
  ② 上限必须在内核里硬生效（模型绕过界面调用工具也受同样限制）+ 截断要说清
  ③ 重跑要**幂等**：已成功的项跳过，不然父执行的重试会把整批重跑 = 钱翻倍
  ④ 深度 1：分派出来的实例不再具备分派能力
"""

from __future__ import annotations

import asyncio
import uuid

from sqlalchemy import select

import pytest

from agent_studio import fanout
from agent_studio.db import SessionLocal
from agent_studio.models import Run, now_ms
from agent_studio.runner.dispatcher import dispatcher

from test_spans import SpanRuntime  # 会发真事件流的桩运行时（复用，避免两套桩）


def uniq(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


# --------------------------------------------------------------------------- #
# 1. 纯函数：列表解析（节点入口"按上游列表"用）
# --------------------------------------------------------------------------- #
def test_parse_items_json_array():
    assert fanout.parse_items('["甲", "乙", "丙"]') == ["甲", "乙", "丙"]
    assert fanout.parse_items('[{"title": "甲"}, {"name": "乙"}]') == ["甲", "乙"]


def test_parse_items_bulleted_and_numbered():
    assert fanout.parse_items("- 甲\n- 乙\n- 丙") == ["甲", "乙", "丙"]
    assert fanout.parse_items("1. 甲\n2. 乙") == ["甲", "乙"]
    assert fanout.parse_items("第 1 项 甲\n第 2 项 乙") == ["甲", "乙"]


def test_parse_items_plain_lines_need_two():
    assert fanout.parse_items("甲\n乙\n丙") == ["甲", "乙", "丙"]
    # 只有一行 = "不是列表"，返回空 —— 宁可让用户显式给清单，也别猜出一堆垃圾项去跑
    assert fanout.parse_items("就一件事") == []
    assert fanout.parse_items("") == []


def test_item_label_and_prompt_are_bounded():
    lbl = fanout.item_label("报销单.pdf（2026 年 8 月）", 1)
    assert lbl.startswith("第 2 项 · ") and len(lbl) <= 24
    p = fanout.item_prompt("处理这张单据", 0, 5)
    assert "第 1 项" in p and "共 5 项" in p and "只处理这一项" in p


def test_render_summary_is_bounded():
    """摘要必须**有界**：30 路的全文塞回上下文 = token 爆炸，模型也读不完。"""
    result = {
        "ok": True,
        "total": 2,
        "succeeded": 1,
        "truncated": True,
        "capped_at": 5,
        "timed_out": False,
        "wait_s": 900,
        "failed": [{"index": 1, "status": "error"}],
        "items": [
            {"index": 0, "label": "第 1 项 · 甲", "status": "ok", "run_id": "run_a", "duration_ms": 1200, "summary": "做完了"},
            {"index": 1, "label": "第 2 项 · 乙", "status": "error", "run_id": "run_b", "duration_ms": None, "summary": "炸了"},
        ],
    }
    text = fanout.render_summary(result)
    assert "成功 1" in text and "失败 1" in text
    assert "只处理了前 5 项" in text, "截断必须明说"
    assert "第 2 项" in text and "失败项" in text
    assert len(text) < 1200


# --------------------------------------------------------------------------- #
# 2. 内核：分派 → N 条独立 run（真跑，走真实队列与执行）
# --------------------------------------------------------------------------- #
async def _parent_run(agent_id: str, node_id: str | None = "n1") -> Run:
    async with SessionLocal() as s:
        run = Run(
            agent_id=agent_id,
            agent_version=1,
            runtime=SpanRuntime.name,
            status="running",
            input={"text": "把这几项都办了"},
            definition_snapshot={
                "runtime": SpanRuntime.name,
                "name": "分派父",
                "system_prompt": "p",
                "model": {"provider": "deepseek", "name": "deepseek-v4-flash"},
                "tools": [{"ref": "tl_fork", "name": "fork"}],
                "skills": [],
                "limits": {"max_iters": 1, "timeout_s": 30},
            },
            started_at=now_ms(),
            node_id=node_id,
        )
        s.add(run)
        await s.commit()
        await s.refresh(run)
        return run


async def _dispatch_with_pump(**kwargs):
    """分派 + 手动泵分发器（测试里没有后台分发器循环）。"""
    task = asyncio.create_task(fanout.dispatch(**kwargs))
    guard = 0
    while not task.done() and guard < 2000:
        await dispatcher.tick()
        await asyncio.sleep(0.02)
        guard += 1
    assert task.done(), "分派没有在预期时间内结束（分发器没被泵起来？）"
    return await task


async def test_dispatch_creates_one_run_per_item(client):
    from agent_studio.config import settings
    from agent_studio.runtimes import register_runtime

    register_runtime(SpanRuntime())
    settings.max_concurrent_runs = 0
    settings.run_retry_max = 0

    aid = (await client.post(
        "/api/agents",
        json={
            "name": uniq("分派助手"),
            "definition": {
                "runtime": SpanRuntime.name,
                "name": "分派助手",
                "system_prompt": "p",
                "model": {"provider": "deepseek", "name": "deepseek-v4-flash"},
                "tools": [],
                "skills": [],
                "limits": {"max_iters": 1, "timeout_s": 30},
            },
        },
    )).json()["id"]
    parent = await _parent_run(aid, node_id="n7")

    result = await _dispatch_with_pump(
        parent_run=parent,
        agent_id=aid,
        definition_snapshot=dict(parent.definition_snapshot or {}),
        items=["甲", "乙", "丙"],
        wait_s=20,
    )

    assert result["total"] == 3 and result["succeeded"] == 3, result
    async with SessionLocal() as s:
        rows = list(
            (
                await s.execute(
                    Run.__table__.select().where(Run.parent_run_id == parent.id)
                )
            ).all()
        )
    assert len(rows) == 3, "每一项都该是一条独立 run（不然界面上看不见、也没法单独重跑）"
    idx = sorted(r._mapping["item_index"] for r in rows)
    assert idx == [0, 1, 2], f"item_index 必须从 0 起连续：{idx}"
    assert all(r._mapping["node_id"] == "n7" for r in rows), "实例要挂在**父执行所在的节点**下（画布据此叠卡）"
    assert all(r._mapping["item_label"].startswith("第 ") for r in rows), "每路要有可读标签"
    assert all(r._mapping["status"] == "ok" for r in rows)


async def test_dispatch_clamps_to_hard_limit_and_reports_truncation(client):
    from agent_studio.config import settings
    from agent_studio.runtimes import register_runtime

    register_runtime(SpanRuntime())
    settings.max_concurrent_runs = 0

    aid = (await client.post(
        "/api/agents",
        json={
            "name": uniq("上限助手"),
            "definition": {
                "runtime": SpanRuntime.name,
                "name": "上限助手",
                "system_prompt": "p",
                "model": {"provider": "deepseek", "name": "deepseek-v4-flash"},
                "tools": [],
                "skills": [],
                "limits": {"max_iters": 1, "timeout_s": 30},
            },
        },
    )).json()["id"]
    parent = await _parent_run(aid)

    # 让它以为上限是 999 —— 内核必须按 MAX_ITEMS_HARD 兜住
    result = await _dispatch_with_pump(
        parent_run=parent,
        agent_id=aid,
        definition_snapshot=dict(parent.definition_snapshot or {}),
        items=[f"第{i}项" for i in range(30)],
        max_items=999,
        wait_s=20,
    )
    assert result["capped_at"] == fanout.MAX_ITEMS_HARD, "上限必须在内核里硬生效（模型也绕不过）"
    assert result["truncated"] is True
    assert result["total"] == fanout.MAX_ITEMS_HARD, result
    assert "只处理了前" in fanout.render_summary(result)


async def test_dispatch_is_idempotent_on_rerun(client):
    """重跑（父执行被重试/用户再点运行）不该把钱花第二遍。"""
    from agent_studio.config import settings
    from agent_studio.runtimes import register_runtime

    rt = SpanRuntime()
    register_runtime(rt)
    settings.max_concurrent_runs = 0

    aid = (await client.post(
        "/api/agents",
        json={
            "name": uniq("幂等助手"),
            "definition": {
                "runtime": SpanRuntime.name,
                "name": "幂等助手",
                "system_prompt": "p",
                "model": {"provider": "deepseek", "name": "deepseek-v4-flash"},
                "tools": [],
                "skills": [],
                "limits": {"max_iters": 1, "timeout_s": 30},
            },
        },
    )).json()["id"]
    parent = await _parent_run(aid)
    args = dict(
        parent_run=parent,
        agent_id=aid,
        definition_snapshot=dict(parent.definition_snapshot or {}),
        items=["甲", "乙"],
        wait_s=20,
    )
    first = await _dispatch_with_pump(**args)
    assert first["succeeded"] == 2

    before = rt.calls if hasattr(rt, "calls") else None
    second = await _dispatch_with_pump(**args)
    assert second["total"] == 2 and second["succeeded"] == 2
    async with SessionLocal() as s:
        rows = list(
            (await s.execute(Run.__table__.select().where(Run.parent_run_id == parent.id))).all()
        )
    assert len(rows) == 2, f"重跑又建了新记录（会重复扣费）：{len(rows)} 条"


async def test_fork_tool_is_registered_and_schema_is_sane():
    """工具本身：能进库、参数说明是给模型看的、标记为平台原生。"""
    assert fanout.TOOL_SCHEMA["required"] == ["tasks"]
    assert "并行" in fanout.TOOL_DESCRIPTION
    flags = fanout.tool_flags()
    assert flags["platform"] is True and flags["concurrency_safe"] is False


async def test_fork_tool_rejects_outside_execution_context():
    """不在执行上下文里调用（ctx 为空）必须明确拒绝，而不是建出无主的执行。"""
    from agent_studio.runner.ctx import clear_run_ctx

    clear_run_ctx()
    out = await fanout.handle_tool_call(tasks=["甲"])
    assert "不在一次执行上下文中" in out


async def test_fork_tool_blocked_at_depth_one(monkeypatch):
    """深度 1：分派出来的实例不允许再次分派（内核兜底，不只靠工具清单）。"""
    from agent_studio.runner.ctx import set_run_ctx

    set_run_ctx(run_id="run_x", agent_id="ag_x", depth=1)
    out = await fanout.handle_tool_call(tasks=["甲", "乙"])
    assert "不允许再次分派" in out
    from agent_studio.runner.ctx import clear_run_ctx

    clear_run_ctx()


# --------------------------------------------------------------------------- #
# 5. 节点入口：画布上配的"按上游清单分派"必须一路活到执行层
#    （wait_timeout_s 当年就是在 normalise 被丢掉、界面设了等于没设 —— 同一个坑）
# --------------------------------------------------------------------------- #
def test_normalise_keeps_fanout_config():
    from agent_studio.orchestrator.graph import normalise
    from agent_studio.schemas import WorkflowGraph

    graph = WorkflowGraph.model_validate(
        {
            "nodes": [
                {"nid": "n1", "agent_id": "a1", "fanout": "list", "fanout_max": 3},
                {"nid": "n2", "agent_id": "a2"},
            ],
            "edges": [{"from": "n1", "to": "n2"}],
        }
    )
    nodes, _edges = normalise(graph.model_dump(by_alias=True))
    assert nodes[0]["fanout"] == "list" and nodes[0]["fanout_max"] == 3
    assert "fanout" not in nodes[1], "没配的节点不该被塞字段"


def test_spec_carries_fanout_to_execution_layer():
    from agent_studio.api.workflows import graph_to_spec
    from agent_studio.schemas import WorkflowGraph

    graph = WorkflowGraph.model_validate(
        {"nodes": [{"nid": "n1", "agent_id": "a1", "fanout": "list", "fanout_max": 5}], "edges": []}
    )
    spec = graph_to_spec(graph, "single", "把这 5 项都办了")
    assert spec["steps"][0]["fanout"] == "list"
    assert spec["steps"][0]["fanout_max"] == 5
    assert spec["steps"][0]["nid"] == "n1"


def test_fanout_of_helper_shape():
    from agent_studio.orchestrator.service import _fanout_of

    assert _fanout_of({}) is None
    assert _fanout_of({"fanout": "list"}) == {
        "mode": "list",
        "max": None,
        "agent": None,
        "wait_s": None,
        "budget": None,
        "workspace": None,
    }
    got = _fanout_of(
        {
            "fanout": "list",
            "fanout_max": 10,
            "wait_timeout_s": 600,
            "fanout_agent": "ag_x",
            "fanout_budget": 20000,
            "fanout_workspace": "isolate",
        }
    )
    assert got == {
        "mode": "list",
        "max": 10,
        "agent": "ag_x",
        "wait_s": 600,
        "budget": 20000,
        "workspace": "isolate",
    }


# --------------------------------------------------------------------------- #
# 6. 编排路径的护栏（这两条合起来，正是这次现场踩到的那个失误）
#    ——"分派分支插进 _start_step 时把常规路径的启动切掉了"
# --------------------------------------------------------------------------- #
async def _run_orchestration_with_pump(client, payload: dict) -> dict:
    """发起编排 + 手动泵分发器，等它跑完，返回详情。"""
    created = (await client.post("/api/orchestrations", json=payload)).json()
    oid = created["id"]
    task = asyncio.create_task(_poll_orc(client, oid))
    guard = 0
    while not task.done() and guard < 900:
        await dispatcher.tick()
        await asyncio.sleep(0.02)
        guard += 1
    assert task.done(), "编排没有在预期时间内结束"
    return await task


async def _poll_orc(client, oid: str) -> dict:
    for _ in range(400):
        d = (await client.get(f"/api/orchestrations/{oid}")).json()
        if d["status"] not in ("pending", "running"):
            return d
        await asyncio.sleep(0.05)
    return (await client.get(f"/api/orchestrations/{oid}")).json()


async def _agent_with_stub(client):
    return (await client.post(
        "/api/agents",
        json={
            "name": uniq("编排护栏"),
            "definition": {
                "runtime": SpanRuntime.name,
                "name": "编排护栏",
                "system_prompt": "p",
                "model": {"provider": "deepseek", "name": "deepseek-v4-flash"},
                "tools": [],
                "skills": [],
                "limits": {"max_iters": 1, "timeout_s": 30},
            },
        },
    )).json()["id"]


async def test_plain_step_still_runs(client):
    """没配分派的普通一步**必须照常启动** —— 这条守的是"改了 _start_step 别把常规路径切掉"。"""
    from agent_studio.config import settings
    from agent_studio.runtimes import register_runtime

    register_runtime(SpanRuntime())
    settings.max_concurrent_runs = 0
    aid = await _agent_with_stub(client)

    d = await _run_orchestration_with_pump(
        client, {"mode": "single", "steps": [{"agent_id": aid, "carry_prev": False}], "task": "随便做点什么"}
    )
    assert d["status"] == "ok", d
    assert d["steps"] and d["steps"][0]["status"] == "ok", d["steps"]


async def test_node_fanout_runs_one_instance_per_item(client):
    """节点上配了"按上游清单分派"→ 上游那一串清单每项一条独立执行（真跑）。"""
    from agent_studio.config import settings
    from agent_studio.runtimes import register_runtime

    register_runtime(SpanRuntime())
    settings.max_concurrent_runs = 0
    aid = await _agent_with_stub(client)

    d = await _run_orchestration_with_pump(
        client,
        {
            "mode": "single",
            "steps": [{"agent_id": aid, "carry_prev": False, "nid": "n1", "fanout": "list", "fanout_max": 5}],
            "task": "\n".join(f"- 第 {i} 项" for i in range(1, 4)),
        },
    )
    assert d["status"] == "ok", d
    steps = d["steps"]
    kids = [s for s in steps if s.get("parent_run_id")]
    box = [s for s in steps if not s.get("parent_run_id")]
    assert len(kids) == 3, f"三项清单应该派 3 路，实际 {len(kids)}"
    assert len(box) == 1 and box[0]["status"] == "ok"
    assert sorted(s["item_index"] for s in kids) == [0, 1, 2]
    assert all(s["node_id"] == "n1" for s in steps if s.get("node_id"))
    assert "## 第 1 项" in box[0]["output_text"], "合并产出要按项分节（下游编排者据此验证）"
    # 容器**不能**被当普通执行跑掉（跑了就会是桩运行时的「好」，把合并产出覆盖掉）
    assert box[0]["output_text"].strip().startswith("## "), (
        f"容器被真跑了一遍（产出成了模型输出）：{box[0]['output_text'][:60]!r}"
    )


# --------------------------------------------------------------------------- #
# 7. 重跑：只重跑分派出去的那一路（其它路不动）
# --------------------------------------------------------------------------- #
async def test_rerun_one_item_leaves_the_others_alone(client):
    from agent_studio.config import settings
    from agent_studio.models import Run
    from agent_studio.runtimes import register_runtime

    register_runtime(SpanRuntime())
    settings.max_concurrent_runs = 0
    aid = await _agent_with_stub(client)
    parent = await _parent_run(aid, node_id="n1")

    result = await _dispatch_with_pump(
        parent_run=parent,
        agent_id=aid,
        definition_snapshot=dict(parent.definition_snapshot or {}),
        items=["甲", "乙"],
        wait_s=20,
    )
    assert result["succeeded"] == 2
    kids = sorted(result["items"], key=lambda x: x["index"])
    other, bad = kids[0]["run_id"], kids[1]["run_id"]

    # 把第二路改成失败（模拟"这一路挂了"）
    async with SessionLocal() as s:
        row = await s.get(Run, bad)
        row.status = "error"
        row.error = "模拟失败"
        row.ended_at = now_ms()
        await s.commit()
        before_other = (await s.get(Run, other)).started_at

    r = await client.post(f"/api/runs/{bad}/rerun")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "pending"

    guard = 0
    while guard < 400:
        await dispatcher.tick()
        await asyncio.sleep(0.02)
        guard += 1
        async with SessionLocal() as s:
            now_status = (await s.get(Run, bad)).status
        if now_status in ("ok", "error", "aborted"):
            break

    async with SessionLocal() as s:
        redone = await s.get(Run, bad)
        untouched = await s.get(Run, other)
    assert redone.status == "ok", redone.status
    assert int((redone.usage or {}).get("reruns") or 0) == 1, "重跑要留痕（这条被重跑过几次）"
    assert redone.input and "第 2 项" in (redone.input or {}).get("text", ""), "重跑要带原来的输入"
    assert untouched.started_at == before_other, "别的路不该被动到"


async def test_rerun_refuses_while_still_running(client):
    from agent_studio.models import Run

    aid = await _agent_with_stub(client)
    parent = await _parent_run(aid, node_id="n1")
    async with SessionLocal() as s:
        row = await s.get(Run, parent.id)
        row.status = "running"
        await s.commit()
    r = await client.post(f"/api/runs/{parent.id}/rerun")
    assert r.status_code == 409
    assert "还没结束" in r.json()["detail"]


# --------------------------------------------------------------------------- #
# 8. 权限语义：分派工具在权限引擎里按"只读"对待
#    否则 AgentScope 每次分派前都要人确认：手动跑要点一次同意，
#    定时/外部触发直接卡死在 waiting_hitl（现场实测踩到过）
# --------------------------------------------------------------------------- #
def test_fanout_tool_is_read_only_for_permission_engine():
    from agent_studio.runtimes.agentscope_rt.compile import build_fanout_tool
    from agent_studio.schemas import ToolSpec

    spec = ToolSpec(name="fork", description="d", kind="fork", input_schema={"type": "object"})
    tool = build_fanout_tool(spec)
    assert getattr(tool, "is_read_only", None) is True, "分派工具必须按只读对待，否则会卡在等确认"
    assert getattr(tool, "is_concurrency_safe", None) is False, "分派占并发配额，不与其他工具并发"


# --------------------------------------------------------------------------- #
# 9. 记录页：分派出去的多路**不单独占一条**，收在容器那一行下面
#    （否则同一批会把列表刷满，用户翻不完也看不出"这几条是一批"）
# --------------------------------------------------------------------------- #
async def test_timeline_groups_fanout_under_container(client):
    from agent_studio.config import settings
    from agent_studio.runtimes import register_runtime

    register_runtime(SpanRuntime())
    settings.max_concurrent_runs = 0
    aid = await _agent_with_stub(client)
    parent = await _parent_run(aid, node_id="n1")
    result = await _dispatch_with_pump(
        parent_run=parent,
        agent_id=aid,
        definition_snapshot=dict(parent.definition_snapshot or {}),
        items=["甲", "乙", "丙"],
        wait_s=20,
    )
    assert result["succeeded"] == 3
    kid_ids = {x["run_id"] for x in result["items"]}

    d = (await client.get("/api/runs/timeline?limit=50")).json()
    ids = {x["id"] for x in d["items"]}
    assert parent.id in ids, "容器那一行要在列表里"
    assert not (kid_ids & ids), "分派出去的每一路**不该**单独占一条"

    box = next(x for x in d["items"] if x["id"] == parent.id)
    assert box["fanout"] is not None, "容器行要带上分派摘要"
    assert box["fanout"]["total"] == 3 and box["fanout"]["ok"] == 3
    assert [i["index"] for i in box["fanout"]["items"]] == [0, 1, 2]
    assert all(i["run_id"] for i in box["fanout"]["items"]), "每一路要带执行 id（重跑要用）"
    assert box["fanout"]["items"][0]["label"].startswith("第 1 项")


# --------------------------------------------------------------------------- #
# 10. 预算护栏：按**真花掉的** token 掐（不做跑前预估），剩下的如实标"未跑"
# --------------------------------------------------------------------------- #
class SlowSpanRuntime(SpanRuntime):
    """跑得慢一点的桩 —— 预算监控要"还有没开始的"才有可停的对象。

    真模型一路几秒到几十秒，本来就有富余；这里只是把测试变成确定的：
    并发上限 1 时，第一路跑完时后面两路还在排队（pending）。
    """

    name = "span-test-runtime"  # 同一个名字覆盖注册（这套测试自己的桩）

    def run(self, agent, run_input):  # noqa: ANN001
        inner = super().run(agent, run_input)

        async def gen():
            async for e in inner:
                yield e
                await asyncio.sleep(0.15)

        return gen()


async def test_budget_stops_the_tail_and_says_so(client):
    from agent_studio.config import settings
    from agent_studio.runtimes import register_runtime

    register_runtime(SlowSpanRuntime())
    settings.max_concurrent_runs = 1  # 一次一路 → 预算能卡在中间
    aid = await _agent_with_stub(client)
    parent = await _parent_run(aid, node_id="n1")

    result = await _dispatch_with_pump(
        parent_run=parent,
        agent_id=aid,
        definition_snapshot=dict(parent.definition_snapshot or {}),
        items=["甲", "乙", "丙"],
        wait_s=30,
        budget_tokens=10,  # 第一路（18 token）跑完就该停后面的
    )

    assert result["budget_stopped"] >= 1, f"该停至少一路，实际 {result['budget_stopped']}"
    assert result["succeeded"] >= 1
    stopped = [x for x in result["items"] if x["status"] == "aborted"]
    assert stopped and all("超出预算" in (x.get("error_text") or "") for x in stopped)
    text = fanout.render_summary(result)
    assert "没有执行" in text and "预算" in text, text

    # 停下的那几路仍是**独立执行**（所以能单独重跑）
    async with SessionLocal() as s:
        rows = list(
            (await s.execute(Run.__table__.select().where(Run.parent_run_id == parent.id))).all()
        )
    skipped = [r._mapping for r in rows if r._mapping["status"] == "aborted"]
    assert skipped and all("超出预算" in (r["error"] or "") for r in skipped)


async def test_no_budget_means_all_items_run(client):
    """不设预算 = 全跑（默认行为不能被护栏改掉）。"""
    from agent_studio.config import settings
    from agent_studio.runtimes import register_runtime

    register_runtime(SpanRuntime())
    settings.max_concurrent_runs = 0
    aid = await _agent_with_stub(client)
    parent = await _parent_run(aid, node_id="n1")
    result = await _dispatch_with_pump(
        parent_run=parent,
        agent_id=aid,
        definition_snapshot=dict(parent.definition_snapshot or {}),
        items=["甲", "乙", "丙"],
        wait_s=20,
        budget_tokens=0,
    )
    assert result["budget_stopped"] == 0
    assert result["succeeded"] == 3


# --------------------------------------------------------------------------- #
# 11. 某一路在等人工确认：**不傻等**（否则会被「最长等多久」拖成"超时"，原因还说错）
# --------------------------------------------------------------------------- #
async def test_waiting_item_ends_the_step_instead_of_burning_the_timeout(client):
    from agent_studio.config import settings
    from agent_studio.models import Run
    from agent_studio.runtimes import register_runtime

    register_runtime(SlowSpanRuntime())
    settings.max_concurrent_runs = 0
    aid = await _agent_with_stub(client)
    parent = await _parent_run(aid, node_id="n1")

    async def _flip_one_to_waiting(created_ids: list[str]) -> None:
        """把最后一路改成"等你确认"（模拟它挂上了需要点头的工具）。"""
        await asyncio.sleep(0.35)
        async with SessionLocal() as s:
            row = await s.get(Run, created_ids[-1])
            if row is not None and row.status not in ("ok", "error", "aborted"):
                row.status = "waiting_hitl"
                await s.commit()

    task = asyncio.create_task(
        fanout.dispatch(
            parent_run=parent,
            agent_id=aid,
            definition_snapshot=dict(parent.definition_snapshot or {}),
            items=["甲", "乙", "丙"],
            wait_s=600,  # 故意给一个很大的等待上限：不该等到它
            db_factory=SessionLocal,
        )
    )
    guard = 0
    while not task.done() and guard < 2000:
        await dispatcher.tick()
        # 第一次 tick 之后把最后一路翻成等待确认
        if guard == 6:
            async with SessionLocal() as s:
                rows = list(
                    (
                        await s.execute(
                            select(Run).where(Run.parent_run_id == parent.id)
                        )
                    ).scalars()
                )
            if rows:
                asyncio.create_task(_flip_one_to_waiting([r.id for r in rows]))
        await asyncio.sleep(0.02)
        guard += 1
    assert task.done(), "发现有人等确认就该收尾，不该耗到超时"
    result = await task
    waited_for = 0.02 * guard
    assert waited_for < 60, f"等太久了（{waited_for:.1f}s）：应该在发现 waiting_hitl 后立刻收尾"
    assert result["waiting"], "要如实报出哪几路在等确认"
    assert result["timed_out"] is False, "这不是超时，不该报成超时"
    text = fanout.render_summary(result)
    assert "等你确认" in text and "管理" in text, text


# --------------------------------------------------------------------------- #
# 12. 开局就有两个能用的角色（用户原话：一个任务分几路跑，应该由一个编排 agent 开始
#     → 应用最开始默认初始化"编排 agent"和"通用 agent"）
# --------------------------------------------------------------------------- #
async def test_default_agents_are_seeded_and_idempotent(client):
    """开局就有两个能用的角色；已存在的一个字都不动；编排者缺分派工具就补上。"""
    from agent_studio.db import SessionLocal
    from agent_studio.defaults import ORCHESTRATOR_NAME, WORKER_NAME, ensure_default_agents
    from agent_studio.models import Agent, AgentTool, Tool

    async with SessionLocal() as s:
        # 工具表里先有「分派」（生产里由「同步内置工具」建好）
        fork_id = (
            await s.execute(select(Tool.id).where(Tool.name == "fork"))
        ).scalar_one_or_none()
        if fork_id is None:
            s.add(
                Tool(
                    kind="fork",
                    name="fork",
                    description="分派",
                    input_schema={"type": "object"},
                    impl={},
                    flags={},
                )
            )
            await s.commit()
            fork_id = (await s.execute(select(Tool.id).where(Tool.name == "fork"))).scalar_one()

        first = await ensure_default_agents(s)
        assert ORCHESTRATOR_NAME in first["created"] and WORKER_NAME in first["created"]
        rows = {a.name: a for a in (await s.execute(select(Agent))).scalars()}
        assert rows[ORCHESTRATOR_NAME].definition["role"] == "orchestrator"
        assert rows[WORKER_NAME].definition["role"] == "worker"
        assert rows[ORCHESTRATOR_NAME].slug and rows[WORKER_NAME].slug, "agent 表要 slug"

        async def _has_fork(agent_id: str) -> bool:
            return (
                await s.execute(
                    select(AgentTool).where(
                        AgentTool.agent_id == agent_id, AgentTool.tool_id == fork_id
                    )
                )
            ).scalar_one_or_none() is not None

        # 编排者必须能"派"（无论是建的时候带上、还是后面补挂）
        assert await _has_fork(rows[ORCHESTRATOR_NAME].id) or first["attached_fork"]

        # 幂等：再调一次什么都不该动（用户可能已经改过提示词/模型）
        defn_before = dict(rows[WORKER_NAME].definition)
        second = await ensure_default_agents(s)
        assert second["created"] == [] and second["attached_fork"] is False
        again = {a.name: a for a in (await s.execute(select(Agent))).scalars()}
        assert dict(again[WORKER_NAME].definition) == defn_before


async def test_existing_orchestrator_without_fork_gets_it_attached(client):
    """老库里已经有「编排者」但没挂分派工具 → 只补这一个（这就是现在线上那台的情况）。"""
    from agent_studio.db import SessionLocal
    from agent_studio.defaults import ORCHESTRATOR_NAME, ensure_default_agents
    from agent_studio.models import Agent, AgentTool, Tool

    async with SessionLocal() as s:
        if (
            await s.execute(select(Tool.id).where(Tool.name == "fork"))
        ).scalar_one_or_none() is None:
            s.add(
                Tool(
                    kind="fork",
                    name="fork",
                    description="分派",
                    input_schema={"type": "object"},
                    impl={},
                    flags={},
                )
            )
        row = Agent(
            slug="orchestrator-old",
            name=ORCHESTRATOR_NAME,
            version=1,
            definition={
                "runtime": "agentscope",
                "name": ORCHESTRATOR_NAME,
                "role": "orchestrator",
                "system_prompt": "我自己改过的提示词",
                "model": {"provider": "deepseek", "name": "deepseek-v4-flash"},
                "tools": [],
                "skills": [],
            },
            created_at=now_ms(),
            updated_at=now_ms(),
        )
        s.add(row)
        await s.commit()
        await s.refresh(row)

        out = await ensure_default_agents(s)
        assert out["created"] == [] or WORKER_NAME_MARK in out["created"], out
        assert out["attached_fork"] is True, "老编排者缺分派工具时要补上"
        # 用户改过的提示词一个字不能动
        kept = await s.get(Agent, row.id)
        assert kept.definition["system_prompt"] == "我自己改过的提示词"
        fork_id = (await s.execute(select(Tool.id).where(Tool.name == "fork"))).scalar_one()
        assert (
            await s.execute(
                select(AgentTool).where(
                    AgentTool.agent_id == row.id, AgentTool.tool_id == fork_id
                )
            )
        ).scalar_one_or_none() is not None


WORKER_NAME_MARK = "通用助手"


async def test_default_orchestrator_can_dispatch_to_worker(client):
    """`fork` 工具带 agent 参数 → 子实例跑的是**那个助手**（编排者派给通用助手）。"""
    from agent_studio.config import settings
    from agent_studio.db import SessionLocal
    from agent_studio.defaults import ORCHESTRATOR_NAME, WORKER_NAME, ensure_default_agents
    from agent_studio.models import Agent, Run
    from agent_studio.runner.ctx import set_run_ctx
    from agent_studio.runtimes import register_runtime

    register_runtime(SpanRuntime())
    settings.max_concurrent_runs = 0
    async with SessionLocal() as s:
        await ensure_default_agents(s)
        orch = (
            await s.execute(select(Agent).where(Agent.name == ORCHESTRATOR_NAME))
        ).scalars().first()
        worker = (
            await s.execute(select(Agent).where(Agent.name == WORKER_NAME))
        ).scalars().first()
        # 让默认助手跑桩运行时（默认是 agentscope，测试里没有真 key）
        for a in (orch, worker):
            d = dict(a.definition)
            d["runtime"] = SpanRuntime.name
            a.definition = d
        await s.commit()
        orch_id, worker_id = orch.id, worker.id
        parent = Run(
            agent_id=orch_id,
            agent_version=1,
            runtime=SpanRuntime.name,
            status="running",
            input={"text": "把这批活派下去"},
            definition_snapshot=dict(orch.definition),
            started_at=now_ms(),
            node_id="n1",
        )
        s.add(parent)
        await s.commit()
        await s.refresh(parent)

    # 模型调用 fork 工具时，身份从 contextvar 来（这里手动模拟一次）
    set_run_ctx(run_id=parent.id, agent_id=orch_id, node_id="n1", depth=0)
    task = asyncio.create_task(
        fanout.handle_tool_call(tasks=["甲", "乙"], agent=WORKER_NAME, max_items=2)
    )
    guard = 0
    while not task.done() and guard < 2000:
        await dispatcher.tick()
        await asyncio.sleep(0.02)
        guard += 1
    text = await task
    assert "成功 2" in text, text

    async with SessionLocal() as s:
        kids = list(
            (
                await s.execute(select(Run).where(Run.parent_run_id == parent.id))
            ).scalars()
        )
        assert len(kids) == 2
        assert all(k.agent_id == worker_id for k in kids), "子实例要跑**被派的那个助手**"
        assert all((k.definition_snapshot or {}).get("name") == WORKER_NAME for k in kids), (
            "定义快照也必须是目标助手的（否则拿错提示词/模型）"
        )
        assert all(
            "fork" not in [str(t.get("name") or t.get("ref")) for t in (k.definition_snapshot or {}).get("tools") or []]
            for k in kids
        ), "深度 1：子实例的清单里不能有分派工具"


async def test_node_fanout_to_another_agent_uses_its_snapshot(client):
    """节点入口的「派给谁」同理：子实例跑目标助手、且用它的定义快照。"""
    from agent_studio.config import settings
    from agent_studio.defaults import WORKER_NAME
    from agent_studio.runtimes import register_runtime

    register_runtime(SpanRuntime())
    settings.max_concurrent_runs = 0
    owner = await _agent_with_stub(client)  # 本节点的助手（发起方）
    target = (await client.post(
        "/api/agents",
        json={
            "name": uniq(WORKER_NAME),
            "definition": {
                "runtime": SpanRuntime.name,
                "name": uniq(WORKER_NAME),
                "system_prompt": "干活的",
                "model": {"provider": "deepseek", "name": "deepseek-v4-flash"},
                "tools": [],
                "skills": [],
                "limits": {"max_iters": 1, "timeout_s": 30},
            },
        },
    )).json()

    d = await _run_orchestration_with_pump(
        client,
        {
            "mode": "single",
            "steps": [
                {
                    "agent_id": owner,
                    "carry_prev": False,
                    "nid": "n1",
                    "fanout": "list",
                    "fanout_max": 3,
                    "fanout_agent": target["id"],
                }
            ],
            "task": "- 甲\n- 乙",
        },
    )
    assert d["status"] == "ok", d
    kids = [s for s in d["steps"] if s.get("parent_run_id")]
    assert len(kids) == 2
    assert all(k["agent_id"] == target["id"] for k in kids), "子实例要跑被派的那个助手"


# --------------------------------------------------------------------------- #
# 13. 「派给谁」不靠模型自觉：① 工具说明里列出可派的助手 ② 节点配了就当默认
# --------------------------------------------------------------------------- #
async def test_fork_tool_description_lists_dispatchable_agents(client):
    from agent_studio.db import SessionLocal
    from agent_studio.defaults import ensure_default_agents
    from agent_studio.models import AgentTool, Tool
    from agent_studio.runner.service import load_tools

    me = await _agent_with_stub(client)  # 一个"本助手"
    async with SessionLocal() as s:
        # 测试库是空的：先把「分派」工具行建出来（生产里由"同步内置工具"建）
        fork_id = (await s.execute(select(Tool.id).where(Tool.name == "fork"))).scalar_one_or_none()
        if fork_id is None:
            s.add(
                Tool(
                    kind="fork",
                    name="fork",
                    description="分派",
                    input_schema={"type": "object"},
                    impl={},
                    flags={},
                )
            )
            await s.commit()
            fork_id = (await s.execute(select(Tool.id).where(Tool.name == "fork"))).scalar_one()
        await ensure_default_agents(s)
        s.add(AgentTool(agent_id=me, tool_id=fork_id))
        await s.commit()
        specs = await load_tools(s, me)
    fork = [x for x in specs if x.kind == "fork"][0]
    assert "可派的助手" in (fork.description or ""), fork.description
    assert "通用助手" in fork.description, "名单里要有默认的通用助手（模型才知道能派给谁）"


async def test_node_configured_agent_is_the_default_for_the_fork_tool(client):
    """节点上配了「派给谁」，模型调 fork 时没填 agent → 用节点配的那个（人定死的默认）。"""
    from agent_studio.config import settings
    from agent_studio.db import SessionLocal
    from agent_studio.defaults import WORKER_NAME, ensure_default_agents
    from agent_studio.models import Agent, Run
    from agent_studio.runner.ctx import set_run_ctx
    from agent_studio.runtimes import register_runtime

    register_runtime(SpanRuntime())
    settings.max_concurrent_runs = 0
    boss_id = await _agent_with_stub(client)
    async with SessionLocal() as s:
        await ensure_default_agents(s)
        worker = (await s.execute(select(Agent).where(Agent.name == WORKER_NAME))).scalars().first()
        d = dict(worker.definition)
        d["runtime"] = SpanRuntime.name
        worker.definition = d
        boss = await s.get(Agent, boss_id)
        assert boss is not None
        parent = Run(
            agent_id=boss.id,
            agent_version=1,
            runtime=SpanRuntime.name,
            status="running",
            # 节点上配的「派给谁」（编排者节点预置 = 通用助手）
            input={"text": "把这批活派下去", "fanout_agent": worker.id},
            definition_snapshot=dict(boss.definition),
            started_at=now_ms(),
            node_id="n1",
        )
        s.add(parent)
        await s.commit()
        await s.refresh(parent)
        worker_id = worker.id

    set_run_ctx(run_id=parent.id, agent_id=boss.id, node_id="n1", depth=0)
    task = asyncio.create_task(fanout.handle_tool_call(tasks=["甲", "乙"], max_items=2))  # 注意：不填 agent
    guard = 0
    while not task.done() and guard < 2000:
        await dispatcher.tick()
        await asyncio.sleep(0.02)
        guard += 1
    text = await task
    assert "成功 2" in text, text
    async with SessionLocal() as s:
        kids = list(
            (await s.execute(select(Run).where(Run.parent_run_id == parent.id))).scalars()
        )
        assert kids and all(k.agent_id == worker_id for k in kids), (
            "节点配了「派给谁」就该派给它，而不是派给自己"
        )


def test_spec_keeps_fanout_agent_even_without_list_mode():
    """「派给谁」与分派模式无关：非容器的编排者节点也要把它带到 spec（白名单陷阱）。"""
    from agent_studio.api.workflows import graph_to_spec
    from agent_studio.schemas import WorkflowGraph

    graph = WorkflowGraph.model_validate(
        {
            "nodes": [{"nid": "n1", "agent_id": "ag_x", "fanout_agent": "ag_worker"}],
            "edges": [],
        }
    )
    spec = graph_to_spec(graph, "single", "任务")
    step = spec["steps"][0]
    assert step.get("fanout_agent") == "ag_worker", step
    assert "fanout" not in step or not step.get("fanout"), "别顺手把模式也塞进去"


# --------------------------------------------------------------------------- #
# 14. 分派等待不该被 agent 超时误杀（节点上「最长等多久」与「执行超时」不再自相矛盾）
# --------------------------------------------------------------------------- #
def test_effective_timeout_counts_the_dispatch_wait():
    from agent_studio.runner.service import FANOUT_WAIT_CAP_S, effective_timeout

    # 助手超时 120s、节点说最多等 15 分钟 → 真正该等 900s（否则那句配置是假的）
    assert effective_timeout(120, 900) == 900
    # 助手超时比等待上限还大 → 以助手超时为准（不缩短）
    assert effective_timeout(1200, 900) == 1200
    # 没有分派 → 原样
    assert effective_timeout(120, 0) == 120
    # 「不限」(-1) → 不延长（执行超时是最后一层保护），但也不能变成负数/无限
    assert effective_timeout(120, -1) == 120
    # 助手超时=不限(<=0) → 原样
    assert effective_timeout(0, 900) == 0
    # 写错成很大的值 → 封顶，别把执行挂到天亮
    assert effective_timeout(120, 10**9) == FANOUT_WAIT_CAP_S


async def test_step_records_how_long_it_may_wait_for_children(client):
    """这一步会等子执行时，把「最多等多久」随 run.input 带下去（执行层据此放宽超时）。"""
    from agent_studio.config import settings
    from agent_studio.db import SessionLocal
    from agent_studio.models import Run
    from agent_studio.runtimes import register_runtime

    register_runtime(SpanRuntime())
    settings.max_concurrent_runs = 0
    owner = await _agent_with_stub(client)
    d = await _run_orchestration_with_pump(
        client,
        {
            "mode": "single",
            "steps": [
                {
                    "agent_id": owner,
                    "carry_prev": False,
                    "nid": "n1",
                    "fanout": "list",
                    "fanout_max": 2,
                    "wait_timeout_s": 900,
                }
            ],
            "task": "- 甲\n- 乙",
        },
    )
    assert d["status"] == "ok", d
    box = [s for s in d["steps"] if not s.get("parent_run_id")][0]
    async with SessionLocal() as s:
        row = await s.get(Run, box["run_id"])
        assert (row.input or {}).get("fanout_wait_s") == 900, row.input


# --------------------------------------------------------------------------- #
# 15. 分派目录隔离：并行实例各写各的文件，不互相覆盖
# --------------------------------------------------------------------------- #
def test_isolated_snapshot_names_are_single_level_and_distinct():
    from agent_studio.fanout import _isolated_snapshot

    class _P:
        id = "run_abcdef123456"

    base = {"name": "通用助手", "workspace": "reports"}
    a = _isolated_snapshot(base, _P(), 0)["workspace"]
    b = _isolated_snapshot(base, _P(), 1)["workspace"]
    assert a != b and a.endswith("-1") and b.endswith("-2")
    # 必须是**单层名字**：resolve_work_dir 只认平台沙箱下的子目录名
    assert "/" not in a and ".." not in a
    assert a.startswith("reports-") and "3456" in a, a
    # 原快照不能被改（同一份快照要复用给别的路）
    assert base["workspace"] == "reports"
    # 没配工作目录的助手 → 落到 fanout- 前缀，同样是单层
    assert _isolated_snapshot({"name": "x"}, _P(), 0)["workspace"].startswith("fanout-")


async def test_isolated_fanout_gives_every_item_its_own_workspace(client):
    from agent_studio.config import settings
    from agent_studio.db import SessionLocal
    from agent_studio.models import Run
    from agent_studio.runtimes import register_runtime

    register_runtime(SpanRuntime())
    settings.max_concurrent_runs = 0
    owner = await _agent_with_stub(client)
    d = await _run_orchestration_with_pump(
        client,
        {
            "mode": "single",
            "steps": [
                {
                    "agent_id": owner,
                    "carry_prev": False,
                    "nid": "n1",
                    "fanout": "list",
                    "fanout_max": 3,
                    "fanout_workspace": "isolate",
                }
            ],
            "task": "- 甲\n- 乙\n- 丙",
        },
    )
    assert d["status"] == "ok", d
    kids = sorted(
        [s for s in d["steps"] if s.get("parent_run_id")], key=lambda x: x.get("item_index") or 0
    )
    assert len(kids) == 3
    async with SessionLocal() as s:
        spaces = []
        for k in kids:
            row = await s.get(Run, k["run_id"])
            spaces.append((row.definition_snapshot or {}).get("workspace") or "")
    assert len(set(spaces)) == 3, f"每一路的工作目录必须互不相同：{spaces}"
    assert all(sp and "/" not in sp for sp in spaces), spaces


async def test_shared_workspace_stays_the_default(client):
    """不配就是老行为（同一目录），不能悄悄改掉既有语义。"""
    from agent_studio.config import settings
    from agent_studio.db import SessionLocal
    from agent_studio.models import Run
    from agent_studio.runtimes import register_runtime

    register_runtime(SpanRuntime())
    settings.max_concurrent_runs = 0
    owner = await _agent_with_stub(client)
    d = await _run_orchestration_with_pump(
        client,
        {
            "mode": "single",
            "steps": [
                {"agent_id": owner, "carry_prev": False, "nid": "n1", "fanout": "list", "fanout_max": 2}
            ],
            "task": "- 甲\n- 乙",
        },
    )
    assert d["status"] == "ok", d
    kids = [s for s in d["steps"] if s.get("parent_run_id")]
    async with SessionLocal() as s:
        spaces = [(await s.get(Run, k["run_id"])).definition_snapshot.get("workspace") for k in kids]
    assert len(set(spaces)) == 1, f"默认应当是共享目录：{spaces}"


def test_spec_keeps_workspace_mode_too():
    """白名单第 4 次：新节点字段必须活着到 spec（这次是分派目录）。"""
    from agent_studio.api.workflows import graph_to_spec
    from agent_studio.schemas import WorkflowGraph

    graph = WorkflowGraph.model_validate(
        {
            "nodes": [
                {
                    "nid": "n1",
                    "agent_id": "ag_x",
                    "fanout": "list",
                    "fanout_max": 2,
                    "fanout_workspace": "isolate",
                }
            ],
            "edges": [],
        }
    )
    step = graph_to_spec(graph, "single", "t")["steps"][0]
    assert step.get("fanout_workspace") == "isolate", step


async def test_workflow_api_persists_every_fanout_field(client):
    """画布存进去的**每一个**分派字段都必须能读回来。

    为什么要一条这种"蠢"测试：pydantic 会**静默丢掉**没在模型里声明的字段，
    而这个坑在本项目已经踩了四次（wait_timeout_s → fanout → fanout_agent → fanout_workspace）。
    逐字段点名断言，比"我以为加上了"可靠。
    """
    agent_id = await _agent_with_stub(client)
    fields = {
        "fanout": "list",
        "fanout_max": 3,
        "fanout_agent": agent_id,
        "fanout_budget": 5000,
        "fanout_workspace": "isolate",
        "wait_timeout_s": 900,
    }
    made = await client.post(
        "/api/workflows",
        json={
            "name": uniq("字段探针"),
            "graph": {"nodes": [{"nid": "n1", "agent_id": agent_id, **fields}], "edges": []},
        },
    )
    assert made.status_code == 201, made.text
    wid = made.json()["id"]
    got = (await client.get(f"/api/workflows/{wid}")).json()["graph"]["nodes"][0]
    for key, want in fields.items():
        assert got.get(key) == want, f"字段 {key} 被丢掉了（拿到 {got.get(key)!r}）：{got}"
    # 而且必须能一路带到 spec（画布 → 执行）
    from agent_studio.api.workflows import graph_to_spec
    from agent_studio.schemas import WorkflowGraph

    spec = graph_to_spec(WorkflowGraph.model_validate({"nodes": [{"nid": "n1", "agent_id": agent_id, **fields}], "edges": []}), "single", "t")
    step = spec["steps"][0]
    for key, want in fields.items():
        assert step.get(key) == want, f"字段 {key} 没带到 spec：{step}"


async def test_each_item_runs_with_its_own_definition_snapshot(client, monkeypatch):
    """每一路交给运行时的定义必须是**它自己**那份（否则目录隔离/目标助手全白配）。"""
    from agent_studio.config import settings
    from agent_studio.db import SessionLocal
    from agent_studio.runner import run_service as rs
    from agent_studio.runtimes import register_runtime

    register_runtime(SpanRuntime())
    settings.max_concurrent_runs = 0
    owner = await _agent_with_stub(client)
    seen: list[str] = []
    orig = rs.start

    async def _spy(run_id, definition, run_input):  # noqa: ANN001
        seen.append(str(getattr(definition, "workspace", "") or ""))
        return await orig(run_id, definition, run_input)

    monkeypatch.setattr(rs, "start", _spy)
    d = await _run_orchestration_with_pump(
        client,
        {
            "mode": "single",
            "steps": [
                {
                    "agent_id": owner,
                    "carry_prev": False,
                    "nid": "n1",
                    "fanout": "list",
                    "fanout_max": 3,
                    "fanout_workspace": "isolate",
                }
            ],
            "task": "- 甲\n- 乙\n- 丙",
        },
    )
    assert d["status"] == "ok", d
    assert len(seen) == 3 and len(set(seen)) == 3, f"每路必须拿到自己的工作目录：{seen}"
    assert all(seen), seen


def test_work_dir_hint_is_told_to_the_model():
    """把「你的工作目录在哪」写进模型看到的任务文本 —— 写文件要用绝对路径，模型不能靠猜。"""
    from agent_studio.runner.service import _with_work_dir_hint

    out = _with_work_dir_hint("做点事", "/srv/x/data/work/fanout-abc-1")
    assert "做点事" in out and "/srv/x/data/work/fanout-abc-1" in out
    assert "绝对路径" in out
    # dict 形态（分派子执行的 input）同样要带上
    out2 = _with_work_dir_hint({"text": "做点事", "fanout_agent": "ag_x"}, "/tmp/w")
    assert out2["text"].startswith("做点事") and "/tmp/w" in out2["text"]
    assert out2["fanout_agent"] == "ag_x", "别把别的字段弄丢"
    # 其它类型原样返回（不炸）
    assert _with_work_dir_hint(None, "/tmp/w") is None


def test_item_prompt_tells_the_instance_where_its_work_dir_is():
    """每一路必须**被告知**自己的工作目录 —— 否则模型自己编绝对路径（/result.md），
    越出沙箱就要人工确认，无人值守的分派会整步卡在"等你确认"（实测）。"""
    from agent_studio.fanout import item_prompt

    plain = item_prompt("甲", 0, 2)
    assert "工作目录" not in plain, "不隔离时不该多嘴（不改变原行为）"
    hinted = item_prompt("甲", 0, 2, "fanout-abc-1")
    assert "fanout-abc-1" in hinted
    assert "相对路径" in hinted and "/result.md" not in hinted.replace("例如", "")


async def test_isolated_children_are_told_their_own_dir(client):
    from agent_studio.config import settings
    from agent_studio.db import SessionLocal
    from agent_studio.models import Run
    from agent_studio.runtimes import register_runtime

    register_runtime(SpanRuntime())
    settings.max_concurrent_runs = 0
    owner = await _agent_with_stub(client)
    d = await _run_orchestration_with_pump(
        client,
        {
            "mode": "single",
            "steps": [
                {
                    "agent_id": owner,
                    "carry_prev": False,
                    "nid": "n1",
                    "fanout": "list",
                    "fanout_max": 2,
                    "fanout_workspace": "isolate",
                }
            ],
            "task": "- 甲\n- 乙",
        },
    )
    assert d["status"] == "ok", d
    async with SessionLocal() as s:
        for child in [
            await s.get(Run, x["run_id"]) for x in d["steps"] if x.get("parent_run_id")
        ]:
            ws = (child.definition_snapshot or {}).get("workspace") or ""
            assert ws and ws in (child.input or {}).get("text", ""), (
                f"子执行 {child.id} 的提示词里必须写出它自己的目录 {ws!r}"
            )


async def test_isolated_items_do_not_clobber_each_others_files(client):
    """两路写**同名文件**：隔离模式下两份都在（共享模式会互相覆盖）—— 用真实 work_dir 验。"""
    from pathlib import Path

    from agent_studio.config import settings
    from agent_studio.db import SessionLocal
    from agent_studio.models import Run
    from agent_studio.runtimes import register_runtime

    class WritingRuntime(SpanRuntime):
        """跑的时候往**真实工作目录**里写一个同名文件（模拟"各自产出各自的结果"）。"""

        name = "span-test-runtime"

        def run(self, agent, run_input):  # noqa: ANN001
            wd = Path(str(getattr(self, "work_dir", "") or "."))
            wd.mkdir(parents=True, exist_ok=True)
            text = str((run_input or {}).get("text") or "")
            (wd / "result.md").write_text(text[:30], encoding="utf-8")
            return super().run(agent, run_input)

    register_runtime(WritingRuntime())
    settings.max_concurrent_runs = 0
    owner = await _agent_with_stub(client)
    d = await _run_orchestration_with_pump(
        client,
        {
            "mode": "single",
            "steps": [
                {
                    "agent_id": owner,
                    "carry_prev": False,
                    "nid": "n1",
                    "fanout": "list",
                    "fanout_max": 2,
                    "fanout_workspace": "isolate",
                }
            ],
            "task": "- 甲项\n- 乙项",
        },
    )
    assert d["status"] == "ok", d
    kids = sorted(
        [s for s in d["steps"] if s.get("parent_run_id")], key=lambda x: x.get("item_index") or 0
    )
    contents = []
    async with SessionLocal() as s:
        for k in kids:
            row = await s.get(Run, k["run_id"])
            ws = (row.definition_snapshot or {}).get("workspace")
            p = Path(settings.work_dir) / str(ws) / "result.md"
            assert p.exists(), f"第 {k['item_index'] + 1} 路没在自己的目录里写出文件：{p}"
            contents.append(p.read_text(encoding="utf-8"))
    assert len(contents) == 2 and len(set(contents)) == 2, f"两份产物必须各有内容：{contents}"
