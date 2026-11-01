"""Watchdog：在跑但没进展的执行就地判死。

要点：
* 只判「进程里已经没有它」的（真在跑的不动 —— 外部改状态会和它的写入打架）；
* 只判跑够久的（刚起的还看不出停滞）；
* 判死要写清**原因**，别留一句"失败"。
"""

from __future__ import annotations

import uuid

from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Run, ToolCall, now_ms
from agent_studio.runner import watchdog

from test_spans import SpanRuntime


def uniq(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


async def _run(*, age_ms: int, status: str = "running") -> Run:
    async with SessionLocal() as s:
        run = Run(
            agent_id=uniq("ag"),
            agent_version=1,
            runtime=SpanRuntime.name,
            status=status,
            input={"text": "干活"},
            definition_snapshot={"runtime": SpanRuntime.name, "name": "甲", "tools": []},
            started_at=now_ms() - age_ms,
        )
        s.add(run)
        await s.commit()
        await s.refresh(run)
        return run


async def _calls(run_id: str, marks: list[tuple[str, str, str]]) -> None:
    async with SessionLocal() as s:
        for i, (tool, args, status) in enumerate(marks):
            s.add(
                ToolCall(
                    run_id=run_id,
                    iteration=i,
                    tool_name=tool,
                    args={"cmd": args},
                    started_at=now_ms(),
                    status=status,
                )
            )
        await s.commit()


async def test_同一步反复三次的僵尸执行被判死():
    await init_db()
    run = await _run(age_ms=10 * 60_000)
    await _calls(run.id, [("bash", "pytest", "error")] * 3)

    async with SessionLocal() as s:
        dead = await watchdog.sweep(s)
        assert run.id in dead
        got = await s.get(Run, run.id)
        assert got.status == "error"
        assert "停滞" in (got.error or "")
        assert "重复" in (got.error or "")
        assert got.ended_at is not None


async def test_刚起的执行不动它():
    await init_db()
    run = await _run(age_ms=1_000)
    await _calls(run.id, [("bash", "pytest", "error")] * 3)
    async with SessionLocal() as s:
        dead = await watchdog.sweep(s)
        assert run.id not in dead
        got = await s.get(Run, run.id)
        assert got.status == "running"


async def test_有进展的执行不误判():
    await init_db()
    run = await _run(age_ms=10 * 60_000)
    await _calls(
        run.id,
        [("read", "a.py", "ok"), ("grep", "x", "ok"), ("edit", "a.py", "ok")],
    )
    async with SessionLocal() as s:
        dead = await watchdog.sweep(s)
        assert run.id not in dead


async def test_进程里还在跑的不判死():
    await init_db()
    run = await _run(age_ms=10 * 60_000)
    await _calls(run.id, [("bash", "pytest", "error")] * 3)

    from agent_studio.runner import run_service

    orig = run_service.is_running
    run_service.is_running = lambda rid: True  # type: ignore[assignment]
    try:
        async with SessionLocal() as s:
            dead = await watchdog.sweep(s)
            assert run.id not in dead
    finally:
        run_service.is_running = orig  # type: ignore[assignment]
