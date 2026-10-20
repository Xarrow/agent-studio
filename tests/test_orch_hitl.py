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
