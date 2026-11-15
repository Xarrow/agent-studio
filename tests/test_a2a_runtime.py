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
