"""可靠性护栏：配置存取 + 止损判定。"""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.ext.asyncio import async_sessionmaker

from agent_studio.models import Base, Run
from agent_studio.reliability import get_reliability, set_reliability
from agent_studio.stop_loss import on_tool_exec_end


@pytest.fixture()
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as s:
        yield s


async def test_默认值与改档(session: AsyncSession):
    cfg = await get_reliability(session)
    assert cfg["stop_loss"]["value"] == 3
    assert cfg["soft_budget"]["value"] == 80
    assert cfg["partial"]["value"] == "on"
    # 非法值被忽略
    await set_reliability(session, {"stop_loss": 999, "partial": "on"})
    cfg = await get_reliability(session)
    assert cfg["stop_loss"]["value"] == 3
    # 合法值生效
    await set_reliability(session, {"stop_loss": 5, "dead_end": 8, "soft_budget": 0})
    cfg = await get_reliability(session)
    assert (cfg["stop_loss"]["value"], cfg["dead_end"]["value"], cfg["soft_budget"]["value"]) == (5, 8, 0)


def _mk_run(rid: str) -> Run:
    return Run(
        id=rid, agent_id="ag_x", agent_version=1, runtime="agentscope",
        status="running", input={}, started_at=1, origin="worker",
        parent_run_id="run_parent",
    )


async def test_止损计数与触发(session: AsyncSession, monkeypatch):
    await set_reliability(session, {"stop_loss": 2, "dead_end": 0, "soft_budget": 0})
    s = session
    s.add(_mk_run("run_w1"))
    await s.commit()

    fired: list[str] = []
    import agent_studio.steer as steer_mod

    async def fake_deliver(run_id: str, text: str) -> str:
        fired.append(text)
        return "ok"

    monkeypatch.setattr(steer_mod, "deliver", fake_deliver)

    ok_payload = {"tool_call_name": "fetch", "state": "success"}
    fail_payload = {"tool_call_name": "fetch", "state": "error", "error": "403"}

    await on_tool_exec_end(s, "run_w1", ok_payload)
    await on_tool_exec_end(s, "run_w1", fail_payload)
    assert not fired  # 1 连败 < 2

    await on_tool_exec_end(s, "run_w1", fail_payload)
    assert len(fired) == 1 and "连续失败 2 次" in fired[0]
    # 成功一次清零，再失败 1 次不触发
    await on_tool_exec_end(s, "run_w1", ok_payload)
    await on_tool_exec_end(s, "run_w1", fail_payload)
    assert len(fired) == 1


async def test_护栏全关零触发(session: AsyncSession, monkeypatch):
    await set_reliability(session, {"stop_loss": 0, "dead_end": 0})
    s = session
    s.add(_mk_run("run_w2"))
    await s.commit()
    fired: list[str] = []
    import agent_studio.steer as steer_mod

    async def fake_deliver(run_id: str, text: str) -> str:
        fired.append(text)
        return "ok"

    monkeypatch.setattr(steer_mod, "deliver", fake_deliver)
    for _ in range(6):
        await on_tool_exec_end(s, "run_w2", {"tool_call_name": "fetch", "state": "error", "error": "x"})
    assert not fired
