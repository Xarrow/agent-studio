"""护栏：执行分发器 —— 队列、重启续跑、以及"什么不该续跑"。

背景：原来 ``run_service.start()`` 直接 ``asyncio.create_task`` —— 推进的协程活在内存里，
服务一重启这条执行就只剩"标中断"。现在执行统一由分发器取走（``pending`` = 队列），
重启前没跑完的**单步执行**会被重新排队跑起来。
这条链路上最容易做错的两件事，各钉一条断言：
  ① 编排内的执行**不能**续跑（从头再跑会把已完成的步骤重复执行）
  ② 同一条执行**不能**被起两次（否则跑两遍、花两份钱）
"""

from __future__ import annotations

import uuid

from agent_studio.config import settings
from agent_studio.models import Orchestration, Run, now_ms
from agent_studio.runner.dispatcher import dispatcher, input_of, resume_policy

from test_gate_and_retry import FlakyRuntime, _Compiled, _mk_agent, _wait_terminal  # noqa: F401


def uniq(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


# --------------------------------------------------------------------------- #
# 1. 纯函数：重启时该怎么处理一条在途执行
# --------------------------------------------------------------------------- #
def test_resume_policy_requeues_standalone_run():
    assert resume_policy(status="running", orchestration_id=None, resumed=0) == "requeue"


def test_resume_policy_never_resumes_orchestration_child():
    """编排里的执行不续跑：编排的推进协程也死了，单跑这一步没意义，
    而且"从头再跑"会让已完成的步骤重复执行（有副作用更糟）。"""
    assert resume_policy(status="running", orchestration_id="orc_x", resumed=0) == "interrupt"


def test_resume_policy_gives_up_after_max_resume():
    assert resume_policy(status="running", orchestration_id=None, resumed=1, max_resume=1) == "interrupt"
    assert resume_policy(status="running", orchestration_id=None, resumed=1, max_resume=2) == "requeue"


def test_resume_policy_never_resumes_hitl():
    """等人工确认靠内存里的事件唤醒 —— 重启后接不回来，续跑只会白跑一遍。"""
    assert resume_policy(status="waiting_hitl", orchestration_id=None, resumed=0) == "interrupt"


def test_resume_policy_respects_switch():
    assert resume_policy(status="running", orchestration_id=None, resumed=0, enabled=False) == "interrupt"


# --------------------------------------------------------------------------- #
# 2. 纯函数：把落库的 input 还原成当初的 run_input
# --------------------------------------------------------------------------- #
def test_input_of_roundtrip():
    # API 对字符串输入存 {"text": ...}，续跑时必须还原成原来的字符串
    assert input_of({"text": "你好"}) == "你好"
    # dict 输入**原样存**，也就原样还原（不能把 {"a":1} 当成 text 包装）
    assert input_of({"a": 1}) == {"a": 1}
    assert input_of({"text": "x", "other": 1}) == {"text": "x", "other": 1}


# --------------------------------------------------------------------------- #
# 3. 端到端：重启前没跑完的单步执行，重启后被续跑
# --------------------------------------------------------------------------- #
async def test_orphan_standalone_run_is_requeued_and_resumed(client, monkeypatch):
    from agent_studio.db import SessionLocal
    from agent_studio.runner.service import reap_orphan_runs
    from agent_studio.runtimes import register_runtime

    rt = FlakyRuntime(fail_times=0)
    register_runtime(rt)
    monkeypatch.setattr(settings, "max_concurrent_runs", 0)
    monkeypatch.setattr(settings, "run_retry_max", 0)

    aid = await _mk_agent(client, FlakyRuntime.name, uniq("续跑"))
    # 造一条"服务重启前就卡在 running 的单步执行"：定义快照 + 输入都已落库
    async with SessionLocal() as s:
        run = Run(
            agent_id=aid,
            agent_version=1,
            runtime=FlakyRuntime.name,
            status="running",
            input={"text": "重启前没跑完"},
            definition_snapshot={
                "runtime": FlakyRuntime.name,
                "name": "续跑",
                "system_prompt": "桩",
                "model": {"provider": "deepseek", "name": "deepseek-v4-flash"},
                "tools": [],
                "skills": [],
                "limits": {"max_iters": 3, "timeout_s": 30},
            },
            started_at=now_ms() - 60_000,     # 一分钟前（早于本进程启动）
        )
        s.add(run)
        await s.commit()
        await s.refresh(run)
        rid = run.id

    handled = await reap_orphan_runs(now_ms())   # boot_ms = 现在
    assert handled >= 1

    async with SessionLocal() as s:
        again = await s.get(Run, rid)
        assert again.status == "pending", "单步执行应当被**重新排队**（而不是标中断）"
        assert not again.error

    data = await _wait_terminal(client, rid, timeout_s=8)
    assert data["status"] == "ok", data
    # 续跑计数只在**真正跑起来**的那次加（reap 里再加一遍会让"1 次"显示成 2 次）
    assert int((data["usage"] or {}).get("resumed") or 0) == 1, data["usage"]
    assert rt.attempts == 1, "续跑的输入要原样交给运行时（不该被包装成 dict）"
    assert (data["output"] or {}).get("content", "").startswith("ok after 1"), data["output"]


async def test_orphan_orchestration_run_is_interrupted_not_requeued(client, monkeypatch):
    from agent_studio.db import SessionLocal
    from agent_studio.runner.service import reap_orphan_runs

    aid = await _mk_agent(client, FlakyRuntime.name, uniq("编排中断"))
    async with SessionLocal() as s:
        orc = Orchestration(name="重启中的编排", mode="serial", spec={}, status="running", started_at=now_ms() - 60_000)
        s.add(orc)
        await s.flush()
        run = Run(
            agent_id=aid,
            agent_version=1,
            runtime=FlakyRuntime.name,
            status="running",
            input={"text": "编排里的一步"},
            definition_snapshot={},
            started_at=now_ms() - 60_000,
            orchestration_id=orc.id,
        )
        s.add(run)
        await s.commit()
        await s.refresh(run)
        await s.refresh(orc)
        rid, oid = run.id, orc.id

    await reap_orphan_runs(now_ms())

    async with SessionLocal() as s:
        r = await s.get(Run, rid)
        o = await s.get(Orchestration, oid)
    assert r.status == "error", "编排内的执行不能续跑（会把已完成的步骤重复执行）"
    assert "重启" in (r.error or ""), "要说清是服务重启导致的中断"
    assert o.status == "error" and "重启" in (o.error or ""), "编排本身也要收尾，不能永远转圈"


# --------------------------------------------------------------------------- #
# 4. 同一条执行不会被起两次（防重复花的钱）
# --------------------------------------------------------------------------- #
async def test_dispatcher_does_not_double_start(client):
    from agent_studio.db import SessionLocal
    from agent_studio.runtimes import register_runtime

    rt = FlakyRuntime(fail_times=0, delay=0.2)
    register_runtime(rt)
    aid = await _mk_agent(client, FlakyRuntime.name, uniq("防重复"))
    r = await client.post("/api/runs", json={"agent_id": aid, "input": "hi"})
    rid = r.json()["id"]

    # 连续抽两轮：第二轮时它已经在跑，不该再起一遍
    started = await dispatcher.tick()
    started_again = await dispatcher.tick()
    assert rid in started
    assert rid not in started_again, "同一条执行被起了两次（会跑两遍、花两份钱）"
    data = await _wait_terminal(client, rid, timeout_s=8)
    assert data["status"] == "ok"
    assert rt.attempts == 1, f"只该跑一次，实际 {rt.attempts} 次"
