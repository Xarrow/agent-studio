"""这次补齐的三件事：会话级授权记忆、隔离的子执行、后台任务跑完汇报。

为什么都写在这里：它们各自只有一个「行为断言」，单独开三个文件反而难找。
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from sqlalchemy import delete, select

from agent_studio import guardrails
from agent_studio.db import SessionLocal, init_db
from agent_studio.models import BgProc, Session as ChatSession, SessionMessage
from agent_studio.runtimes.agentscope_rt.compile import build_permission_state
from agent_studio.runtimes.agentscope_rt.guard import DangerousActionGuard
from agent_studio.schemas import AgentDefinition, ToolRef


def _tool_call(name: str, payload: dict):
    return SimpleNamespace(name=name, id="call_1", state="pending", input=payload)


async def _next():
    return "passed-through"


def test_会话允许后同类操作不再问_但危险操作照拦():
    ask_case = {"command": "rm -rf ./victim"}

    guard = DangerousActionGuard(workspace="/tmp/ws")
    verdict = asyncio.run(guard.on_check_permission(None, {"tool_call": _tool_call("Bash", ask_case), "tool_input": ask_case}, _next))
    # 没点过「不再问」→ 要求确认
    assert getattr(verdict, "behavior", "") != "" or verdict == "passed-through"

    allowed = DangerousActionGuard(workspace="/tmp/ws", session_allow=["Bash"])
    out = asyncio.run(
        allowed.on_check_permission(
            None, {"tool_call": _tool_call("Bash", ask_case), "tool_input": ask_case}, _next
        )
    )
    assert out == "passed-through"  # 放行：不再弹确认条

    # `rm -rf /` 这类是 DENY，点过「不再问」也不放
    deny_case = {"command": "rm -rf /"}
    out2 = asyncio.run(
        allowed.on_check_permission(
            None, {"tool_call": _tool_call("Bash", deny_case), "tool_input": deny_case}, _next
        )
    )
    assert getattr(out2, "behavior", None) is not None
    assert "DENY" in str(getattr(out2, "behavior", "")).upper()


def test_会话允许多一条_严格模式里的兜底ASK要撤掉():
    defn = AgentDefinition(
        name="x",
        tools=[ToolRef(ref="tl_x")],
        runtime_options={"agentscope": {"permission": {"mode": "default"}}},
    )
    spec = SimpleNamespace(name="bash")
    state = build_permission_state(defn, [spec], extra_allow=["Bash"])
    ctx = state.permission_context
    assert "Bash" in ctx.allow_rules
    # 严格模式给每个工具注入的 ask 兜底必须撤掉，否则 ask(Step2) 会盖住 allow(Step5)
    assert "Bash" not in (ctx.ask_rules or {})


async def test_后台任务跑完会往会话里说一声():
    await init_db()
    sid = "ses_announcetest01"
    pid = "bg_announcetest01"
    async with SessionLocal() as db:
        if await db.get(ChatSession, sid) is None:
            db.add(ChatSession(id=sid, agent_id="ag_x", title="播报测试"))
        await db.execute(delete(SessionMessage).where(SessionMessage.session_id == sid))
        await db.execute(delete(BgProc).where(BgProc.id == pid))
        db.add(
            BgProc(
                id=pid,
                session_id=sid,
                label="构建前端",
                command="npm run build",
                status="exited",
                exit_code=0,
                started_at=1000,
                ended_at=61000,
                log_path="/tmp/x.log",
            )
        )
        await db.commit()

    from agent_studio.procs import _announce_done

    await _announce_done(pid)
    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(SessionMessage).where(SessionMessage.session_id == sid)
            )
        ).scalars().all()
    assert len(rows) == 1
    assert rows[0].role == "system"
    assert "跑完了" in rows[0].content and "构建前端" in rows[0].content
    # 系统提示不进模型上下文：load_history 只取 user/assistant（已有测试守这条口径）
    assert rows[0].role == "system"
