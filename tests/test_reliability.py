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

    from agent_studio.models import Run

    async def _pending(rid: str) -> str:
        row = await s.get(Run, rid)
        return str(((row.usage or {}).get("pending_note")) or "")

    await on_tool_exec_end(s, "run_w1", ok_payload)
    await on_tool_exec_end(s, "run_w1", fail_payload)
    assert not fired and not await _pending("run_w1")  # 1 连败 < 2

    await on_tool_exec_end(s, "run_w1", fail_payload)
    # 不再立即注入（tool result 还没入上下文，注入会 400）—— 记 pending，等 flush
    assert not fired
    note = await _pending("run_w1")
    assert "连续失败 2 次" in note

    # flush（= 下一个 llm_call_start 时机）把 pending 送进上下文
    from agent_studio.stop_loss import flush_pending_note

    await flush_pending_note(s, "run_w1")
    assert len(fired) == 1 and "连续失败 2 次" in fired[0]
    assert not await _pending("run_w1")  # flush 后清空

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


async def test_硬停护栏_连败即中止(session: AsyncSession, monkeypatch):
    """连败到 hard_stop 档位：平台直接 abort（不再排提示），并上报 failed 事件。"""
    from agent_studio.models import now_ms

    await set_reliability(session, {"stop_loss": 0, "dead_end": 0, "hard_stop": 3})
    s = session
    s.add(_mk_run("run_w3"))
    s.add(Run(id="run_parent3", agent_id="ag_x", agent_version=1, runtime="agentscope",
              status="running", input={}, started_at=now_ms(), origin="chat"))
    await s.commit()

    aborted: list[str] = []

    class FakeRunService:
        async def abort(self, run_id: str) -> bool:
            aborted.append(run_id)
            return True

    import agent_studio.runner.service as svc_mod

    monkeypatch.setattr(svc_mod, "run_service", FakeRunService())
    emitted: list[dict] = []
    import agent_studio.worker_events as we_mod

    async def fake_emit(**kw):
        emitted.append(kw)
        return {}

    monkeypatch.setattr(we_mod, "emit_worker_event", fake_emit)

    fail = {"tool_call_name": "fetch", "state": "error", "error": "boom"}
    await on_tool_exec_end(s, "run_w3", fail)
    await on_tool_exec_end(s, "run_w3", fail)
    assert not aborted  # 2 连败 < 3：只计数，不打断

    await on_tool_exec_end(s, "run_w3", fail)
    assert aborted == ["run_w3"]  # 第 3 次连败 → 立即中止
    row = await s.get(Run, "run_w3")
    assert row.usage.get("hard_stop_reason")
    assert len(emitted) == 1 and emitted[0]["kind"] == "failed"

    # 计数已清零，再来失败不再触发（run 已终态，引擎也会跳过）
    await on_tool_exec_end(s, "run_w3", fail)
    assert len(aborted) == 1

    # hard_stop=0 关掉：不打断
    await set_reliability(session, {"hard_stop": 0})
    s2 = session
    s2.add(_mk_run("run_w4"))
    await s2.commit()
    monkeypatch.setattr(svc_mod, "run_service", FakeRunService())
    for _ in range(6):
        await on_tool_exec_end(s2, "run_w4", fail)
    assert aborted == ["run_w3"]


async def test_巡检间隔档位(session: AsyncSession):
    """巡检是「不断纠正」的节拍器：档位存 KV、可关、非法值忽略。"""
    cfg = await get_reliability(session)
    assert cfg["review"]["value"] == 180
    assert cfg["review"]["choices"] == [0, 90, 180, 300]
    await set_reliability(session, {"review": 999})
    assert (await get_reliability(session))["review"]["value"] == 180  # 非法值忽略
    await set_reliability(session, {"review": 90})
    assert (await get_reliability(session))["review"]["value"] == 90
    await set_reliability(session, {"review": 0})
    assert (await get_reliability(session))["review"]["value"] == 0


async def test_巡检画像_含动作与失败(session: AsyncSession, monkeypatch):
    """_live_digest 要把「正卡在哪个工具 / 最近动作 / 失败数」拼成人能读的一行行。"""
    from agent_studio.models import RunEvent, now_ms
    from agent_studio.supervisor import _live_digest

    s = session
    s.add(Run(id="run_rv1", agent_id="ag_x", agent_version=1, runtime="agentscope",
              status="running", input={}, started_at=now_ms() - 60_000, origin="worker",
              parent_run_id="run_p"))
    s.add_all([
        RunEvent(run_id="run_rv1", seq=1, ts=now_ms(), type="tool_call_start",
                 payload={"tool_call_id": "c1", "tool_call_name": "fetch"}),
        RunEvent(run_id="run_rv1", seq=2, ts=now_ms(), type="tool_exec_end",
                 payload={"tool_call_id": "c1", "state": "error"}),
        RunEvent(run_id="run_rv1", seq=3, ts=now_ms(), type="tool_call_start",
                 payload={"tool_call_id": "c2", "tool_call_name": "web_search"}),
    ])
    await s.commit()

    # _live_digest 自己开会话 —— 把 SessionLocal 指到测试库
    import agent_studio.db as db_mod

    class _Ctx:
        def __call__(self):
            return _Ctx()

        async def __aenter__(self):
            return s

        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(db_mod, "SessionLocal", _Ctx())
    text, seq = await _live_digest("run_rv1")
    assert seq == 3
    assert "fetch✗" in text and "web_search" in text
    assert "1 次工具失败" in text
    assert "当前在：web_search" in text


async def test_纠偏观察_未生效上报(session: AsyncSession, monkeypatch):
    """steer 之后连续失败 → 上报「纠偏未生效」；插话后成功 → 撤观察不再报。"""
    from agent_studio.stop_loss import check_steer_watch

    s = session
    r1 = _mk_run("run_sw1")
    r1.usage = {"steer_watch": {"calls_after": 0, "fails_after": 0, "msg": "改用 A 接口"}}
    r2 = _mk_run("run_sw2")
    r2.usage = {"steer_watch": {"calls_after": 0, "fails_after": 0, "msg": "改用 A 接口"}}
    s.add_all([r1, r2])
    await s.commit()

    events: list[dict] = []
    import agent_studio.worker_events as we_mod

    async def fake_emit(**kw):
        events.append(kw)
        return {}

    monkeypatch.setattr(we_mod, "emit_worker_event", fake_emit)

    # 场景一：插话后两次都失败 → 报一次（且只报一次）
    await check_steer_watch(s, "run_sw1", True)
    assert not events  # 第一次还不够
    await check_steer_watch(s, "run_sw1", True)
    assert len(events) == 1 and "纠偏未生效" in events[0]["text"]
    row = await s.get(Run, "run_sw1")
    assert "steer_watch" not in (row.usage or {})
    await check_steer_watch(s, "run_sw1", True)
    assert len(events) == 1  # 不连环轰炸

    # 场景二：插话后第一次就成功 → 观察撤掉，不报
    await check_steer_watch(s, "run_sw2", True)
    await check_steer_watch(s, "run_sw2", False)
    assert len(events) == 1
    row2 = await s.get(Run, "run_sw2")
    assert "steer_watch" not in (row2.usage or {})


async def test_编排者拿得到管理工具(session: AsyncSession):
    """Router 必须拿得到 worker_status/steer/stop —— 否则巡检里提示它纠偏，它没手可用。"""
    from agent_studio.runtimes.agentscope_rt.compile import ORCHESTRATOR_ALLOW_TOOLS

    assert {"worker_status", "worker_steer", "worker_stop"} <= ORCHESTRATOR_ALLOW_TOOLS
    # 执行类工具仍不给（一给它就会自己干活，不派 worker 了）
    assert not ({"Read", "Bash", "fetch", "web_search", "Write"} & ORCHESTRATOR_ALLOW_TOOLS)


async def test_巡检合并画像_多worker一张图(session: AsyncSession, monkeypatch):
    """汇聚式巡检：一次给 Router 看所有在跑的 worker（并行时不再互相挤掉）。"""
    from agent_studio.models import RunEvent, now_ms
    from agent_studio.supervisor import _batch_digest

    s = session
    for rid, tool in (("run_b1", "fetch"), ("run_b2", "Bash")):
        s.add(Run(id=rid, agent_id="ag_x", agent_version=1, runtime="agentscope",
                  status="running", input={}, started_at=now_ms() - 30_000,
                  origin="worker", parent_run_id="run_bp"))
        s.add_all([
            RunEvent(run_id=rid, seq=1, ts=now_ms(), type="tool_call_start",
                     payload={"tool_call_id": "c1", "tool_call_name": tool}),
            RunEvent(run_id=rid, seq=2, ts=now_ms(), type="text_delta",
                     payload={"delta": f"我正在用 {tool} 查这个问题的答案"}),
        ])
    # 已收尾的 worker 不该出现在画像里
    s.add(Run(id="run_b3", agent_id="ag_x", agent_version=1, runtime="agentscope",
              status="ok", input={}, started_at=now_ms() - 90_000,
              origin="worker", parent_run_id="run_bp"))
    await s.commit()

    import agent_studio.db as db_mod

    class _Ctx:
        def __call__(self):
            return _Ctx()

        async def __aenter__(self):
            return s

        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(db_mod, "SessionLocal", _Ctx())
    text, seq = await _batch_digest("run_bp")
    assert "run_b1" in text and "run_b2" in text and "run_b3" not in text
    assert "它最近自己说" in text and "我正在用 fetch" in text
    assert seq > 0
