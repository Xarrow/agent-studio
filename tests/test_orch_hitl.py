"""护栏：编排里遇到「要你确认」的那一步，不能变成一条永远挂着的子任务。

现场（用户报）：子任务一直存在、主任务又没拿到它的结果。

review 出来的机制（当时的样子）：
  · worker 跑 bash 被权限闸门拦下 → run 进 ``waiting_hitl``
  · 编排的 ``_await`` 遇 ``waiting_hitl`` **立即返回**（文档里写着"让编排层标 partial"）
  · 但编排界面没有"点允许"的地方（入口在对话页/运行记录），也没有人再去管它
  → 编排以 partial 结束，那条 worker run **永久停在 waiting_hitl**，
     主控汇总里那一路只有"（无产出）"，用户完全不知道是"在等确认"。

现在的口径：编排不做中途确认，遇到就**判为中止**并写清原因（去哪跑、怎么改权限），
主控汇总里也能看到这条原因 —— 状态干净、原因可读、下一步明确。
"""

from __future__ import annotations

import pytest

from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Run, now_ms
from agent_studio.orchestrator.service import Orchestrator

pytestmark = pytest.mark.anyio

#: 本文件造过的记录 —— 测试之间共用同一个临时库，跑完必须清掉，
#: 否则「运行记录归组」这类按行数/归组断言的老测试会被这些残留带崩。
_PROBE_RUNS = ("run_hitl_probe", "run_policy_probe", "run_wait_timeout")


@pytest.fixture(autouse=True)
async def _cleanup():
    yield
    from sqlalchemy import delete

    from agent_studio.models import Orchestration

    async with SessionLocal() as s:
        for rid in _PROBE_RUNS:
            await s.execute(delete(Run).where(Run.id == rid))
        await s.execute(delete(Orchestration).where(Orchestration.id == "orc_hitl_probe"))
        await s.commit()


async def _make_waiting_run(run_id: str) -> Run:
    await init_db()
    async with SessionLocal() as s:
        r = Run(
            id=run_id,
            agent_id="ag_probe",
            runtime="agentscope",
            status="waiting_hitl",
            input={"text": "往 /etc/x 写一行"},
            definition_snapshot={},
            started_at=now_ms(),
            pending_hitl={"tool_calls": [{"name": "Bash", "arguments": {"command": "echo hi > /etc/x"}}]},
        )
        s.add(r)
        await s.commit()
        await s.refresh(r)
        return r


async def test_await_turns_waiting_into_aborted_with_reason(monkeypatch):
    rid = "run_hitl_probe"
    run = await _make_waiting_run(rid)

    async def fake_wait(run_id: str, timeout: float | None = None):
        return run

    monkeypatch.setattr("agent_studio.runner.service.run_service.wait", fake_wait)
    monkeypatch.setattr("agent_studio.runner.service.run_service.abort", lambda rid: _ok())

    got = await Orchestrator()._await(rid, 5)

    assert got is not None
    assert got.status == "aborted", "等确认的一步必须落终态，不能一直挂着"
    assert "确认" in (got.error or ""), "要说清是卡在确认上"
    assert "Bash" in (got.error or ""), "要点名是哪个工具要确认"
    assert got.pending_hitl is None, "待确认请求要清掉，否则界面上还挂着一条可点的允许/拒绝"
    assert got.ended_at, "终态必须有结束时间"

    async with SessionLocal() as s:
        row = await s.get(Run, rid)
    assert row.status == "aborted"


async def _ok() -> bool:
    return True


# ── 两种口径：等人点（默认）vs 直接中止 ──────────────────────────────────

from agent_studio.models import Orchestration  # noqa: E402


async def _make_orch(run_id: str, policy: str) -> None:
    """造一条编排 + 一条停在该编排里的 waiting run（同一测试里可能调两次 → 幂等）。"""
    await init_db()
    async with SessionLocal() as s:
        if await s.get(Orchestration, "orc_hitl_probe") is None:
            s.add(
                Orchestration(
                    id="orc_hitl_probe",
                    name="探针",
                    mode="single",
                    worker_mode=None,
                    spec={"on_hitl": policy, "steps": []},
                    input={"text": "x"},
                    status="running",
                    started_at=now_ms(),
                )
            )
        s.add(
            Run(
                id=run_id,
                agent_id="ag_probe",
                runtime="agentscope",
                status="waiting_hitl",
                input={"text": "写 /etc/x"},
                definition_snapshot={},
                started_at=now_ms(),
                orchestration_id="orc_hitl_probe",
                pending_hitl={"tool_calls": [{"name": "Bash", "input": {"command": "echo hi > /etc/x"}}]},
            )
        )
        await s.commit()


async def test_policy_defaults_to_wait():
    await _make_orch("run_policy_probe", "wait")
    async with SessionLocal() as s:
        run = await s.get(Run, "run_policy_probe")
    assert await Orchestrator()._hitl_policy(run) == "wait"


async def test_wait_mode_times_out_with_readable_reason(monkeypatch):
    """没人点 → 到点判中止，原因要说清「等了多久、卡在哪个操作」。"""
    import agent_studio.orchestrator.service as mod

    await _make_orch("run_wait_timeout", "wait")
    monkeypatch.setattr(mod, "HITL_WAIT_S", 1)
    monkeypatch.setattr("agent_studio.runner.service.run_service.abort", lambda rid: _ok())

    async with SessionLocal() as s:
        run = await s.get(Run, "run_wait_timeout")
    got = await Orchestrator()._wait_for_human(run)

    assert got.status == "aborted"
    assert "没人确认" in (got.error or "")
    assert "Bash" in (got.error or "")
    assert got.pending_hitl is None
