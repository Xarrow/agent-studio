"""远程 Agent 治理补齐：操作记录 + 调用记录 + 启停语义。

用户口径（2026-09-28）：远程 Agent 页要像专业商业产品的资源管理页 ——
开启、关闭、删除都要**留痕**（操作记录），每次真实调用可查（调用记录）。
"""

from __future__ import annotations

import pytest

from agent_studio.db import init_db
from agent_studio.models import RemoteAgent, Run, now_ms


@pytest.fixture(autouse=True)
async def _db():
    await init_db()


def _mk(session, name="远端甲", url="http://ra-test:9"):
    row = RemoteAgent(name=name, url=url, parsed={"name": name, "skills": []}, status="ok", enabled=True)
    session.add(row)
    from agent_studio import remote_agents as ra
    return row, ra


async def test_启停与删除都留操作记录():
    from agent_studio import remote_agents as ra
    from agent_studio.db import SessionLocal
    from agent_studio.api.remote_agents import list_remote_agent_events

    async with SessionLocal() as s:
        row, _ = _mk(s)
        await s.commit()
        rid = row.id
        # 启停
        await ra.log_event(s, row, "disable", f"停用远程 Agent「{row.name}」")
        await ra.log_event(s, row, "enable", f"启用远程 Agent「{row.name}」")
        # 删除：行删前记
        await ra.log_event(s, None, "delete", f"删除远程 Agent「{row.name}」",
                           {"url": row.url}, remote_id=rid, remote_name=row.name)
        await s.delete(row)
        await s.commit()

    from sqlalchemy import select
    from agent_studio.models import RemoteAgentEvent
    async with SessionLocal() as s:
        rows = (await s.execute(
            select(RemoteAgentEvent).where(RemoteAgentEvent.remote_id == rid)
            .order_by(RemoteAgentEvent.created_at)
        )).scalars().all()
    assert [r.action for r in rows] == ["disable", "enable", "delete"]
    # 删除事件有名字快照
    assert rows[-1].remote_name == "远端甲"
    assert "删除" in rows[-1].summary


async def test_调用记录按远端地址筛():
    from sqlalchemy import select
    from agent_studio.db import SessionLocal

    async with SessionLocal() as s:
        row, _ = _mk(s, url="http://ra-calls:9")
        s.add(Run(id="run_ra_a", runtime="a2a", status="ok", agent_id="ag_x", started_at=now_ms(),
                  input={"text": "问远端", "remote": "http://ra-calls:9"},
                  definition_snapshot={}, origin="chat"))
        s.add(Run(id="run_ra_b", runtime="a2a", status="ok", agent_id="ag_x", started_at=now_ms(),
                  input={"text": "问别人", "remote": "http://other:9"},
                  definition_snapshot={}, origin="chat"))
        await s.commit()
        rid = row.id

    from agent_studio.api.remote_agents import list_remote_agent_calls
    async with SessionLocal() as s:
        calls = await list_remote_agent_calls(rid, limit=30, session=s)
    ids = [c["run_id"] for c in calls]
    assert "run_ra_a" in ids and "run_ra_b" not in ids
    assert calls[0]["input"] == "问远端"
