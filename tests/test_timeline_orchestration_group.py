"""管理页时间线：一次编排执行必须只显示一行（不被步骤拆分）。

现场（2026-09-26/27）：3 步的编排执行在「管理 → 运行记录」里出现 3 行
（编排者/通用助手/编程助手各一行）——数据库里它本来就是
orchestration 1 行 + N 条 worker run，列表把 worker 平铺了 ✗。
用户口径：**我发起了哪些执行**，一次一行 ✓ 步骤明细在画布回放里看。
"""

from __future__ import annotations

import pytest
from agent_studio.db import SessionLocal

pytestmark = pytest.mark.asyncio

ORC_BASE = "orc_test_group"
AG = "ag_test_group"
NOW = 1790450000000


async def _seed(n_steps: int = 3, orc_status: str = "ok", run_status: str = "ok", orc_id: str | None = None) -> None:
    """往测试库塞一次「1 编排 + N worker run」的执行。"""
    orc_id = orc_id or f"{ORC_BASE}_{n_steps}_{orc_status}"
    from agent_studio.models import Orchestration, Run

    async with SessionLocal() as s:
        s.add(
            Orchestration(
                id=orc_id,
                name="测试编排 · 你好",
                mode="serial",
                status=orc_status,
                input={"text": "你好"},
                output={"content": "总结"},
                usage={},
                started_at=NOW,
                ended_at=NOW + 30_000,
                workflow_id=None,
            )
        )
        for i in range(n_steps):
            s.add(
                Run(
                    id=f"run_{orc_id}_{i}",
                    agent_id=AG,
                    runtime="agentscope",
                    status=run_status,
                    input={"text": "你好"},
                    output={"content": f"步骤 {i}"},
                    usage={"tokens_in": 100, "tokens_out": 10},
                    started_at=NOW + i * 1000,
                    ended_at=NOW + i * 1000 + 500,
                    orchestration_id=orc_id,
                    orch_role="worker",
                    node_id=f"n{i + 1}",
                    order_index=i,
                )
            )
        await s.commit()


async def test_timeline_groups_orchestration_into_one_row(client):
    orc_id = f"{ORC_BASE}_3_ok"
    await _seed(n_steps=3, orc_id=orc_id)
    r = await client.get("/api/runs/timeline?kind=playground")
    assert r.status_code == 200
    items = r.json()["items"]
    hits = [x for x in items if x["orchestration_id"] == orc_id]
    assert len(hits) == 1, f"应折叠成 1 行，实际 {len(hits)}（worker 被平铺 ✗）"
    it = hits[0]
    assert it["id"] == orc_id          # 行 id = 编排本体（详情/回放都好定位）
    assert it["subtitle"] == "3 步"    # 多步要给「N 步」
    assert it["tokens_in"] == 300      # token 是各步之和
    assert it["tokens_out"] == 30


async def test_timeline_group_status_follows_orchestration(client):
    """worker 各步 ok、编排本体 error → 整次按失败算（不能报喜）。"""
    orc_id = f"{ORC_BASE}_2_error"
    await _seed(n_steps=2, orc_status="error", orc_id=orc_id)
    r = await client.get("/api/runs/timeline?kind=playground&status=error")
    assert r.status_code == 200
    ids = [x["id"] for x in r.json()["items"]]
    assert orc_id in ids, "编排本体失败 → 归组行应出现在 error 筛选里"


async def test_timeline_solo_runs_not_affected(client):
    """非编排的普通执行（对话/试跑）不受归组影响，照旧一条一条。"""
    await _seed(n_steps=1, orc_id=f"{ORC_BASE}_1_ok")
    from agent_studio.models import Run

    async with SessionLocal() as s:
        s.add(
            Run(
                id="run_solo_1",
                agent_id=AG,
                runtime="agentscope",
                status="ok",
                input={"text": "单独一次"},
                usage={"tokens_in": 5, "tokens_out": 5},
                started_at=NOW + 100_000,
                ended_at=NOW + 101_000,
            )
        )
        await s.commit()
    r = await client.get("/api/runs/timeline?kind=preview")
    assert r.status_code == 200
    items = r.json()["items"]
    assert any(x["id"] == "run_solo_1" for x in items)
