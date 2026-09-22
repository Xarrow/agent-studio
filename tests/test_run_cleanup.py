"""Run 清理接口测试 —— 删除 / 批量 / 按条件 / 清空，以及级联行为。

重点验证：删 Run 会连同 run_event / llm_call / tool_call 一起消失
（依赖 SQLite 的 ``PRAGMA foreign_keys=ON`` + 外键 CASCADE）。
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select

from agent_studio.db import SessionLocal
from agent_studio.models import LlmCall, Run, RunEvent, ToolCall, now_ms


def _aid() -> str:
    return f"ag_{uuid.uuid4().hex[:14]}"


async def _make_agent(client) -> str:
    r = await client.post(
        "/api/agents",
        json={
            "name": f"clean-{uuid.uuid4().hex[:6]}",
            "definition": {
                "runtime": "agentscope",
                "name": "clean",
                "model": {"provider": "deepseek", "name": "deepseek-v4-flash"},
            },
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _make_run(agent_id: str, status: str = "ok") -> str:
    """直接落库造一条 Run（不真跑模型），并附事件与调用明细。"""
    async with SessionLocal() as s:
        run = Run(
            id=_aid(),
            agent_id=agent_id,
            agent_version=1,
            runtime="agentscope",
            status=status,
            input={"text": "t"},
            output={"content": "o"},
            usage={"llm_calls": 1},
            started_at=now_ms(),
            ended_at=now_ms(),
        )
        s.add(run)
        await s.flush()
        rid = run.id
        s.add(RunEvent(run_id=rid, seq=0, type="run_start", payload={}, ts=1))
        s.add(
            LlmCall(
                run_id=rid, iteration=1, started_at=1, ended_at=2, duration_ms=1
            )
        )
        s.add(
            ToolCall(
                run_id=rid,
                iteration=1,
                tool_name="x",
                started_at=1,
                ended_at=2,
                duration_ms=1,
            )
        )
        await s.commit()
    return rid


async def _child_counts(rid: str) -> tuple[int, int, int]:
    async with SessionLocal() as s:
        ev = await s.scalar(
            select(func.count()).select_from(RunEvent).where(RunEvent.run_id == rid)
        )
        ll = await s.scalar(
            select(func.count()).select_from(LlmCall).where(LlmCall.run_id == rid)
        )
        tc = await s.scalar(
            select(func.count()).select_from(ToolCall).where(ToolCall.run_id == rid)
        )
    return int(ev or 0), int(ll or 0), int(tc or 0)


# --------------------------------------------------------------------------- #
async def test_delete_run_cascades(client):
    """删一条 Run，子表记录必须一起消失。"""
    agent_id = await _make_agent(client)
    rid = await _make_run(agent_id)
    assert await _child_counts(rid) == (1, 1, 1)

    r = await client.delete(f"/api/runs/{rid}")
    assert r.status_code == 200
    assert r.json()["deleted"] == 1

    assert (await client.get(f"/api/runs/{rid}")).status_code == 404
    assert await _child_counts(rid) == (0, 0, 0)


async def test_delete_missing_run_404(client):
    r = await client.delete("/api/runs/run_nonexistent")
    assert r.status_code == 404


async def test_delete_in_flight_run_is_skipped(client):
    """运行中的 Run 不能删（应先中断），要给出原因。"""
    agent_id = await _make_agent(client)
    rid = await _make_run(agent_id, status="running")

    r = await client.delete(f"/api/runs/{rid}")
    assert r.status_code == 200
    body = r.json()
    assert body["deleted"] == 0
    assert body["skipped"] and "中断" in body["skipped"][0]["reason"]


async def test_bulk_delete(client):
    agent_id = await _make_agent(client)
    ids = [await _make_run(agent_id) for _ in range(3)]

    r = await client.post("/api/runs/bulk-delete", json={"ids": ids})
    assert r.status_code == 200
    assert r.json()["deleted"] == 3
    for rid in ids:
        assert await _child_counts(rid) == (0, 0, 0)


async def test_bulk_delete_requires_ids(client):
    r = await client.post("/api/runs/bulk-delete", json={"ids": []})
    assert r.status_code == 422  # min_length=1


async def test_prune_dry_run_then_delete(client):
    """按条件清理：先 dry_run 看数量，再实删。"""
    agent_id = await _make_agent(client)
    ids = [await _make_run(agent_id) for _ in range(2)]

    dry = await client.post(
        "/api/runs/prune",
        json={"before_ts": now_ms() + 1000, "agent_id": agent_id, "dry_run": True},
    )
    assert dry.status_code == 200
    assert dry.json()["deleted"] == 0
    assert len(dry.json()["skipped"]) == 2
    # dry_run 不应真删
    for rid in ids:
        assert await _child_counts(rid) == (1, 1, 1)

    real = await client.post(
        "/api/runs/prune",
        json={"before_ts": now_ms() + 1000, "agent_id": agent_id},
    )
    assert real.json()["deleted"] == 2
    for rid in ids:
        assert await _child_counts(rid) == (0, 0, 0)


async def test_prune_only_touches_terminal_by_default(client):
    """默认只清终态，运行中的要留下。"""
    agent_id = await _make_agent(client)
    ok_id = await _make_run(agent_id, status="ok")
    running_id = await _make_run(agent_id, status="running")

    r = await client.post(
        "/api/runs/prune",
        json={"before_ts": now_ms() + 1000, "agent_id": agent_id},
    )
    assert r.json()["deleted"] == 1
    assert (await client.get(f"/api/runs/{ok_id}")).status_code == 404
    assert (await client.get(f"/api/runs/{running_id}")).status_code == 200


async def test_clear_requires_confirm_word(client):
    agent_id = await _make_agent(client)
    rid = await _make_run(agent_id)

    bad = await client.delete("/api/runs?confirm=yes")
    assert bad.status_code == 400
    assert (await client.get(f"/api/runs/{rid}")).status_code == 200  # 没被删

    good = await client.delete("/api/runs?confirm=DELETE")
    assert good.status_code == 200
    assert good.json()["deleted"] >= 1
    assert (await client.get(f"/api/runs/{rid}")).status_code == 404


async def test_clear_scoped_to_agent(client):
    a1 = await _make_agent(client)
    a2 = await _make_agent(client)
    r1 = await _make_run(a1)
    r2 = await _make_run(a2)

    r = await client.delete(f"/api/runs?confirm=DELETE&agent_id={a1}")
    assert r.status_code == 200
    assert (await client.get(f"/api/runs/{r1}")).status_code == 404
    assert (await client.get(f"/api/runs/{r2}")).status_code == 200  # 另一个 Agent 不受影响
