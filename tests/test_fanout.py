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
    while not task.done() and guard < 600:
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
