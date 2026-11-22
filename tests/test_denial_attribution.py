"""拦截归因与审计分类 —— 缺陷 1 / 3 的护栏。

用户 2026-11 的两条现场：

1. 助手用 ``Bash ls ~/.hermes`` 被平台拦下，对话页却写「你拒绝了这一步」——
   他根本没点过拒绝。归因必须分得清：**用户点的** / **平台拦的** / **没人能点的**。
2. 审计里禁区 ``ls``（读尝试）被记成"写"；工作区外的成功读一条都没有。
   ``op`` 要按真实操作类型记（读就是读），读也要留痕。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from agent_studio import file_policy as fp
from agent_studio.runner import service as svc
from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx
from agent_studio.runtimes.agentscope_rt import guard as guard_mod
from agent_studio.runtimes.agentscope_rt.guard import DangerousActionGuard

WS = "/srv/src/agent-studio/data/work/sessions/ses_attr"


# --------------------------------------------------------------------------- #
# 缺陷 1：归因
# --------------------------------------------------------------------------- #
@pytest.fixture(autouse=True)
def _reset():
    guard_mod.clear_reasons()
    guard_mod.clear_denied_notes()
    fp.invalidate_skip_cache()
    yield
    clear_run_ctx()
    guard_mod.clear_denied_notes()


def test_平台拦截不说你拒绝了():
    guard_mod.note_denied(
        "tc_p",
        reason="该目录受保护（/root/.hermes 是 Hermes 自己的运行目录，助手不能读也不能写）",
        rule="protected-dir",
    )
    item = svc._denial_entry(name="Bash", call_id="tc_p")
    assert item["source"] == "guard"
    err = svc.denial_error([item])
    assert err.startswith("已拦截：该目录受保护"), err
    assert "不是你点的拒绝" in err
    assert "你拒绝了" not in err


def test_用户点的拒绝才说你拒绝了():
    item = svc._denial_entry(name="Bash", call_id="tc_u", assume_user=True)
    assert item["source"] == "user"
    err = svc.denial_error([item])
    assert "你拒绝了 Bash" in err, err


def test_工具结果原文也能当原因():
    """守卫记录丢失时，工具结果里那句「已拦截：…」就是给人看的原因。"""
    item = svc._denial_entry(
        name="Read",
        call_id="tc_x",
        result_text="已拦截：该目录受保护（/root/.hermes 是 Hermes 自己的运行目录）。要里面的内容请让用户贴给你。",
    )
    assert item["source"] == "guard"
    assert "该目录受保护" in item["reason"], item


def test_定时任务里不甩锅给用户():
    item = svc._denial_entry(name="bash", call_id="tc_s")
    err = svc.denial_error([item], origin="schedule")
    assert "需要人点头" in err
    assert "你拒绝了" not in err


# --------------------------------------------------------------------------- #
# 缺陷 3：审计分类 + 读留痕
# --------------------------------------------------------------------------- #
class _Handler:
    async def __call__(self, **_: object):
        from agentscope.permission import PermissionBehavior, PermissionDecision

        return PermissionDecision(behavior=PermissionBehavior.ALLOW, message="engine-allow")


async def _decide(name: str, inp: dict):
    set_run_ctx(workspace=WS, interactive=True, run_id="run_attr", agent_id="", session_id="ses_attr")
    return await DangerousActionGuard().on_check_permission(
        agent=None,
        input_kwargs={
            "tool_call": SimpleNamespace(name=name, id=f"tc_{name}", state="pending"),
            "tool_input": inp,
        },
        next_handler=_Handler(),
    )


async def _last_audit():
    from sqlalchemy import select

    from agent_studio.db import SessionLocal, init_db
    from agent_studio.models import FileAudit

    await init_db()
    async with SessionLocal() as s:
        rows = (
            (await s.execute(select(FileAudit).order_by(FileAudit.id.desc()).limit(1)))
            .scalars()
            .all()
        )
    return rows[0] if rows else None


async def test_禁区里的_ls_审计记读且结果是拦截(client):
    from agentscope.permission import PermissionBehavior

    d = await _decide("Bash", {"command": "ls -la ~/.hermes"})
    assert d.behavior == PermissionBehavior.DENY
    row = await _last_audit()
    assert row is not None
    assert row.op == fp.OP_READ, f"读尝试被记成了 {row.op!r}"
    assert row.result == fp.RESULT_BLOCKED
    assert row.path.endswith("/.hermes"), row.path


async def test_禁区文件工具的读也记读(client):
    from agentscope.permission import PermissionBehavior

    d = await _decide("Read", {"file_path": "/root/.hermes/config.yaml"})
    assert d.behavior == PermissionBehavior.DENY
    row = await _last_audit()
    assert row is not None and row.op == fp.OP_READ and row.result == fp.RESULT_BLOCKED
    assert row.path == "/root/.hermes/config.yaml"


async def test_工作区之外的读留一条读(client):
    from agentscope.permission import PermissionBehavior

    d = await _decide("Read", {"file_path": "/etc/hostname"})
    assert d.behavior == PermissionBehavior.ALLOW
    row = await _last_audit()
    assert row is not None
    assert row.op == fp.OP_READ and row.result == fp.RESULT_ALLOWED
    assert row.path == "/etc/hostname"
    assert row.rule == "read-outside"


async def test_工作区之外的命令读也留痕(client):
    from agentscope.permission import PermissionBehavior

    d = await _decide("Bash", {"command": "cat /etc/hostname"})
    assert d.behavior in (PermissionBehavior.ALLOW, PermissionBehavior.PASSTHROUGH)
    row = await _last_audit()
    assert row is not None and row.op == fp.OP_READ and row.path == "/etc/hostname"


async def test_工作区内的读不记(client):
    from sqlalchemy import func, select

    from agent_studio.db import SessionLocal
    from agent_studio.models import FileAudit

    async with SessionLocal() as s:
        before = int((await s.execute(select(func.count(FileAudit.id)))).scalar_one())
    await _decide("Read", {"file_path": f"{WS}/a.md"})
    async with SessionLocal() as s:
        after = int((await s.execute(select(func.count(FileAudit.id)))).scalar_one())
    assert after == before, "工作区内的读不该进审计（范围写在设置页文案里）"


# --------------------------------------------------------------------------- #
# 缺陷 2：一次拒绝即终局 —— 续跑没接上不能回 200、不能留假审计
# --------------------------------------------------------------------------- #
async def _mk_waiting_run(run_id: str, session_id: str = "") -> str:
    """造一条「停在等确认」的运行（pending_hitl 带一次越界写）。"""
    from agent_studio.db import SessionLocal, init_db
    from agent_studio.models import Run, now_ms

    await init_db()
    async with SessionLocal() as s:
        s.add(
            Run(
                id=run_id,
                agent_id="ag_attr",
                session_id=session_id or None,
                status="waiting_hitl",
                input={"text": "写一个文件"},
                started_at=now_ms(),
                pending_hitl={
                    "reply_id": "rep_attr",
                    "tool_calls": [{"id": "tc_write", "name": "write_file"}],
                    "file_actions": {
                        "tc_write": {"path": "/tmp/attr_out.txt", "op": fp.OP_OVERWRITE, "dir": "/tmp"}
                    },
                },
            )
        )
        await s.commit()
    return run_id


async def _audit_rows(path: str):
    from sqlalchemy import select

    from agent_studio.db import SessionLocal
    from agent_studio.models import FileAudit

    async with SessionLocal() as s:
        return (
            (await s.execute(select(FileAudit).where(FileAudit.path == path))).scalars().all()
        )


async def test_续跑没接上时回_409_也不要写假审计(client, monkeypatch):
    from agent_studio.runner import service as svc_mod

    async def _no(run_id, hitl):
        return False

    monkeypatch.setattr(svc_mod.run_service, "resume", _no)
    rid = await _mk_waiting_run("run_attr_stale")
    r = await client.post(f"/api/runs/resume/{rid}", json={"confirm": False})
    assert r.status_code == 409, r.text
    assert await _audit_rows("/tmp/attr_out.txt") == [], "没接上的点击不算「用户拒绝」"


async def test_一次拒绝只记一条审计_再点回_409(client, monkeypatch):
    from agent_studio.db import SessionLocal
    from agent_studio.models import Run
    from agent_studio.runner import service as svc_mod

    async def _ok(run_id, hitl):
        # 按真实 resume 的关键副作用：状态翻 running、待确认清空
        async with SessionLocal() as s:
            run = await s.get(Run, run_id)
            run.status = "running"
            run.pending_hitl = None
            await s.commit()
        return True

    monkeypatch.setattr(svc_mod.run_service, "resume", _ok)
    rid = await _mk_waiting_run("run_attr_once")

    first = await client.post(f"/api/runs/resume/{rid}", json={"confirm": False})
    assert first.status_code == 200, first.text
    rows = await _audit_rows("/tmp/attr_out.txt")
    assert len(rows) == 1 and rows[0].result == fp.RESULT_REJECTED, rows

    second = await client.post(f"/api/runs/resume/{rid}", json={"confirm": False})
    assert second.status_code == 409, "同一张卡点第二次必须明确说已经处理过"
    assert len(await _audit_rows("/tmp/attr_out.txt")) == 1, "第二次点击不该再记一条拒绝"


# --------------------------------------------------------------------------- #
# 缺陷 2 的另一半：上一轮的说明只跟一轮，别永远挂在后面每轮的 system prompt 上
# --------------------------------------------------------------------------- #
async def test_上一轮没做完的说明只带紧挨着的那一轮(client):
    from agent_studio.context import TURN_NOTE_PREFIX, build_turn_context
    from agent_studio.db import SessionLocal
    from agent_studio.models import Session as ChatSession, SessionMessage, now_ms
    from agent_studio.schemas import MemoryPolicyRead

    sid = "ses_note"
    async with SessionLocal() as s:
        s.add(ChatSession(id=sid, agent_id="ag_attr", title="note", created_at=now_ms(), last_active_at=now_ms()))
        s.add_all(
            [
                SessionMessage(session_id=sid, turn_index=1, role="user", content="写个文件"),
                SessionMessage(session_id=sid, turn_index=1, role="system", content=f"{TURN_NOTE_PREFIX}你拒绝了这个动作"),
                # 之后又正常聊完一轮
                SessionMessage(session_id=sid, turn_index=2, role="user", content="算了，回个收到"),
                SessionMessage(session_id=sid, turn_index=2, role="assistant", content="收到"),
            ]
        )
        await s.commit()

        policy = MemoryPolicyRead(agent_id="ag_attr", recall_enabled=False)
        ctx = await build_turn_context(s, agent_id="ag_attr", session_id=sid, query="再来", policy=policy)
        assert ctx.turn_note is None, "隔了一轮的失败提示不该继续注入"

        # 失败那一轮就是最后一轮 → 必须带上
        s.add(SessionMessage(session_id=sid, turn_index=3, role="user", content="再写一次"))
        s.add(SessionMessage(session_id=sid, turn_index=3, role="system", content=f"{TURN_NOTE_PREFIX}已拦截：该目录受保护"))
        await s.commit()
        ctx2 = await build_turn_context(s, agent_id="ag_attr", session_id=sid, query="继续", policy=policy)
        assert ctx2.turn_note and "已拦截" in ctx2.turn_note


# --------------------------------------------------------------------------- #
# 缺陷 3：认不出是读的命令不能顺手记成「读」
# --------------------------------------------------------------------------- #
async def test_非读类命令被拦不会记成读(client):
    from agentscope.permission import PermissionBehavior

    d = await _decide("Bash", {"command": "shutdown -h now"})
    assert d.behavior == PermissionBehavior.DENY
    row = await _last_audit()
    assert row is not None and row.result == fp.RESULT_BLOCKED
    assert row.op != fp.OP_READ, f"shutdown 不是读操作，不能记成 {row.op!r}"
