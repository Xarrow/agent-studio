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
    }
    got = _fanout_of({"fanout": "list", "fanout_max": 10, "wait_timeout_s": 600, "fanout_agent": "ag_x", "fanout_budget": 20000})
    assert got == {"mode": "list", "max": 10, "agent": "ag_x", "wait_s": 600, "budget": 20000}


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
