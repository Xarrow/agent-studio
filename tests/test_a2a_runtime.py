"""影子助手（runtime=a2a）的执行：转发给远端、把结果写回 run。

以前分发器把 a2a 排除在外，这类 run 永远停在 pending（界面上就是
"调用 A2A 远程 agent 失败"）。这里守住三条：
  1. 分发器不再跳过 a2a；
  2. 远端成功 → run.status=ok、output.content 是回答文本、usage 记远端任务号；
  3. 远端失败/没有远端地址 → 落终态 + 人话原因（不能留 pending）。
"""

from __future__ import annotations

import uuid

from sqlalchemy import select

from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Agent, Run
from agent_studio.runner.service import run_service


async def _seed_run(definition: dict, text: str = "你好") -> tuple[str, str]:
    await init_db()
    async with SessionLocal() as s:
        agent = Agent(
            # 每个用例一个独立 slug（共享库，撞 slug 会违反唯一约束）
            slug=f"a2a-{uuid.uuid4().hex[:10]}",
            name="影子助手",
            description="远端代理",
            runtime="a2a",
            definition=definition,
        )
        s.add(agent)
        await s.flush()
        run = Run(
            agent_id=agent.id,
            agent_version=1,
            runtime="a2a",
            status="pending",
            input={"text": text},
            definition_snapshot=definition,
            started_at=1,
            origin="preview",
        )
        s.add(run)
        await s.commit()
        return agent.id, run.id


async def test_a2a_run_success(monkeypatch) -> None:
    from agent_studio import a2a_client
    from agent_studio.schemas import AgentDefinition

    async def fake_run(base, text, *, agent_id=None, timeout_s=0, headers=None, callback=None):
        assert agent_id == "ag_remote_1"
        return "ok", "远端回答：我很好", "task_123"

    monkeypatch.setattr(a2a_client, "run_until_done", fake_run)

    definition = {
        "runtime": "a2a",
        "name": "影子助手",
        "role": "worker",
        "system_prompt": "（远端代理）",
        "model": {"provider": "deepseek", "name": "deepseek-flash"},
        "remote_url": "https://peer.example.com",
        "remote_agent_id": "ag_remote_1",
    }
    _, run_id = await _seed_run(definition)
    await run_service._execute_a2a(run_id, "你好")

    async with SessionLocal() as s:
        run = await s.get(Run, run_id)
        assert run.status == "ok"
        assert (run.output or {}).get("content") == "远端回答：我很好"
        assert (run.usage or {}).get("remote_task_id") == "task_123"


async def test_a2a_run_missing_remote_url(monkeypatch) -> None:
    definition = {
        "runtime": "a2a",
        "name": "影子助手",
        "role": "worker",
        "system_prompt": "（远端代理）",
        "model": {"provider": "deepseek", "name": "deepseek-flash"},
    }
    _, run_id = await _seed_run(definition)
    await run_service._execute_a2a(run_id, "你好")
    async with SessionLocal() as s:
        run = await s.get(Run, run_id)
        assert run.status == "error"
        assert "远端地址" in (run.error or "")


async def test_a2a_run_remote_error(monkeypatch) -> None:
    from agent_studio import a2a_client

    async def boom(*a, **kw):
        raise RuntimeError("连不上远端")

    monkeypatch.setattr(a2a_client, "run_until_done", boom)
    definition = {
        "runtime": "a2a",
        "name": "影子助手",
        "role": "worker",
        "system_prompt": "（远端代理）",
        "model": {"provider": "deepseek", "name": "deepseek-flash"},
        "remote_url": "https://peer.example.com",
        "remote_agent_id": "ag_remote_1",
    }
    _, run_id = await _seed_run(definition)
    await run_service._execute_a2a(run_id, "你好")
    async with SessionLocal() as s:
        run = await s.get(Run, run_id)
        assert run.status == "error"
        assert "远端调用失败" in (run.error or "")


async def test_waiting_hitl_is_taken_over(monkeypatch) -> None:
    """远端在等人确认时，本地不能停在 waiting_hitl：后台轮询到终态后回填。"""
    import asyncio

    from agent_studio import a2a_client
    from agent_studio.runner import a2a_watch

    async def fake_run_until_done(base, text, *, agent_id=None, timeout_s=0, headers=None, callback=None):
        return "waiting_hitl", "远端在等人确认", "task_hitl_1"

    # 第一次查还在等人，之后已跑完
    seq = {"n": 0}

    async def fake_get_task(base, task_id, *, timeout=30.0, headers=None):
        seq["n"] += 1
        if seq["n"] <= 1:
            return {"id": task_id, "status": {"state": "input-required"}}
        return {
            "id": task_id,
            "status": {"state": "completed"},
            "artifacts": [{"parts": [{"kind": "text", "text": "确认后的回答"}]}],
        }

    monkeypatch.setattr(a2a_client, "run_until_done", fake_run_until_done)
    monkeypatch.setattr(a2a_client, "get_task", fake_get_task)
    monkeypatch.setattr(a2a_client, "POLL_S", 0.01, raising=False)

    definition = {
        "runtime": "a2a",
        "name": "影子助手",
        "role": "worker",
        "system_prompt": "（远端代理）",
        "model": {"provider": "deepseek", "name": "deepseek-flash"},
        "remote_url": "https://peer.example.com",
        "remote_agent_id": "ag_remote_1",
    }
    _, run_id = await _seed_run(definition)
    await run_service._execute_a2a(run_id, "帮我删个文件")

    async with SessionLocal() as s:
        run = await s.get(Run, run_id)
        assert run.status == "waiting_hitl"
        assert (run.usage or {}).get("remote_base") == "https://peer.example.com"

    # 后台轮询应该把终态回填
    for _ in range(60):
        await asyncio.sleep(0.05)
        async with SessionLocal() as s:
            run = await s.get(Run, run_id)
            if run.status != "waiting_hitl":
                break
    async with SessionLocal() as s:
        run = await s.get(Run, run_id)
        assert run.status == "ok"
        assert (run.output or {}).get("content") == "确认后的回答"
    assert a2a_watch._ACTIVE == set()
