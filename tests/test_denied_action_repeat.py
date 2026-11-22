"""拒绝过的动作不许被重发 —— 会话级拒绝名单（平台层兜底，不靠提示词劝模型）。

现场（2026-11，公网真人路径 —— 上次用 API 直接续跑没测出来）：
让助手写 ``/var/lib/agent-studio/b2fix-test.txt`` → 用户点一次拒绝，当轮正常终结。
之后同一会话只说一句「回个收到」，模型又把**同一个写入**发了出来，同一张卡再弹；
再让它写新文件，它把已被拒的那个一起带上，卡第三次弹出 —— 审计里三条「用户拒绝」。

修法（平台层）：
1. 拒绝 → 记进（会话, 操作类型, 规范化路径）名单；
2. 同会话内完全一致的动作直接拦：不弹卡、不再新增「用户拒绝」审计、明确告诉模型别重试；
3. 用户在新消息里**明确重新要求**同一个动作 → 例外放行（仍弹卡确认）；
4. 换路径 / 换操作 / 换会话都不受影响。
"""

from __future__ import annotations

import os
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from agent_studio import file_policy as fp
from agent_studio.db import SessionLocal
from agent_studio.models import FileAudit
from agent_studio.runner import service as svc
from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx
from agent_studio.runtimes.agentscope_rt import guard as guard_mod
from agent_studio.runtimes.agentscope_rt.compile import render_denied_actions
from agent_studio.runtimes.agentscope_rt.guard import DangerousActionGuard

WS = "/srv/src/agent-studio/data/work/sessions/ses_deny"


def _sid() -> str:
    return "ses_" + uuid.uuid4().hex[:12]


def _target() -> str:
    """每个用例一条独有的路径 —— 审计表是整个测试库共用的，不能拿同一条比。"""
    return f"/var/lib/agent-studio/deny-{uuid.uuid4().hex[:8]}.txt"


class _Handler:
    """引擎那边 —— 被调用就说明「这次交回给引擎（= 会弹卡）」了。"""

    def __init__(self) -> None:
        self.calls = 0

    async def __call__(self, **_: object):
        from agentscope.permission import PermissionBehavior, PermissionDecision

        self.calls += 1
        return PermissionDecision(behavior=PermissionBehavior.ALLOW, message="engine-allow")


async def _decide(
    path: str,
    *,
    session_id: str,
    user_text: str = "",
    content: str = "hello",
    tool: str = "write",
):
    set_run_ctx(
        workspace=WS,
        interactive=True,
        run_id="run_deny",
        agent_id="",
        session_id=session_id,
        input_text=user_text,
    )
    handler = _Handler()
    decision = await DangerousActionGuard().on_check_permission(
        agent=None,
        input_kwargs={
            "tool_call": SimpleNamespace(name=tool, id="tc_" + uuid.uuid4().hex[:6], state="pending"),
            "tool": SimpleNamespace(name=tool),
            "tool_input": {"file_path": path, "content": content},
        },
        next_handler=handler,
    )
    return decision, handler


@pytest.fixture(autouse=True)
def _reset():
    guard_mod.clear_reasons()
    guard_mod.clear_denied_notes()
    fp.invalidate_skip_cache()
    yield
    clear_run_ctx()
    guard_mod.clear_denied_notes()
    fp.invalidate_skip_cache()


async def _audit_rows(path: str) -> list[FileAudit]:
    async with SessionLocal() as s:
        rows = (
            await s.execute(select(FileAudit).where(FileAudit.path == path))
        ).scalars().all()
        return list(rows)


# --------------------------------------------------------------------------- #
# 1) 名单本身：记 / 查 / 划掉
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_拒绝后记进名单_不同操作与不同会话不受影响():
    sid, target = _sid(), _target()
    act = fp.Action(path=target, op=fp.OP_CREATE)
    await fp.remember_denial(act, session_id=sid, run_id="run_1")

    hit = await fp.denial_hit(fp.Action(path=target, op=fp.OP_CREATE), session_id=sid)
    assert hit is not None and hit["path"] == target

    # 换会话：不受影响
    assert await fp.denial_hit(fp.Action(path=target, op=fp.OP_CREATE), session_id=_sid()) is None
    # 换路径：不受影响
    other = target.replace(".txt", "-2.txt")
    assert await fp.denial_hit(fp.Action(path=other, op=fp.OP_CREATE), session_id=sid) is None
    # 换操作（新建 → 删除）：不受影响
    assert await fp.denial_hit(fp.Action(path=target, op=fp.OP_DELETE), session_id=sid) is None

    # 用户点了允许 → 划掉
    await fp.forget_denial(act, session_id=sid)
    assert await fp.denial_hit(act, session_id=sid) is None


@pytest.mark.asyncio
async def test_名单按会话持久化_可被读出来注入提示():
    sid, target = _sid(), _target()
    await fp.remember_denial(fp.Action(path=target, op=fp.OP_CREATE), session_id=sid, run_id="r")
    rows = await fp.denied_in_session(sid)
    assert [r["path"] for r in rows] == [target]
    assert rows[0]["op"] == fp.OP_CREATE


@pytest.mark.asyncio
async def test_重复拒绝不产生重复条目():
    sid, target = _sid(), _target()
    act = fp.Action(path=target, op=fp.OP_CREATE)
    await fp.remember_denial(act, session_id=sid)
    await fp.remember_denial(act, session_id=sid)
    assert len(await fp.denied_in_session(sid)) == 1


# --------------------------------------------------------------------------- #
# 2) 「明确重新要求」的判定：判断不准时按拦截处理
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "name,text,expected",
    [
        ("deny-abcdef12.txt", "还是把 deny-abcdef12.txt 写了吧", True),
        ("deny-abcdef12.txt", "重试一下 deny-abcdef12 那个文件", True),
        ("deny-abcdef12.txt", "把 /var/lib/agent-studio/deny-abcdef12.txt 写出来", True),
        # 没提到这个文件 → 不算（宁可拦截）
        ("deny-abcdef12.txt", "回个收到", False),
        ("deny-abcdef12.txt", "帮我把结论整理一下", False),
        # 提到了但有否定词 → 不算
        ("deny-abcdef12.txt", "别写 deny-abcdef12.txt 了", False),
        ("deny-abcdef12.txt", "算了，不要写 deny-abcdef12.txt", False),
    ],
)
def test_明确重新要求的判定(name, text, expected):
    act = fp.Action(path=f"/var/lib/agent-studio/{name}", op=fp.OP_CREATE)
    assert fp.explicit_retry(text, act) is expected


def test_短名字不算提到文件():
    """「a」这种一两个字符的主干命中任意一句话 —— 不叫「明确提到那个文件」。"""
    assert fp.names_path("回个收到", "/tmp/a.txt") is False


# --------------------------------------------------------------------------- #
# 3) 中间件：命中名单直接拦（不弹卡、不记「用户拒绝」）
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_同会话重发同一动作被拦下且不弹卡():
    from agentscope.permission import PermissionBehavior

    sid, target = _sid(), _target()
    await fp.remember_denial(fp.Action(path=target, op=fp.OP_CREATE), session_id=sid, run_id="run_a")

    d, handler = await _decide(target, session_id=sid, user_text="回个收到")
    assert d.behavior == PermissionBehavior.DENY, d
    assert d.decision_reason == "file-write-denied-repeat"
    assert handler.calls == 0, "命中了拒绝名单就不该再交回引擎（= 不该弹卡）"
    assert "拒绝" in d.message and "不要再试" in d.message

    # 归因：这是「重复发起」，不是用户此刻又拒了一次 → 本轮不收尾
    note = next(v for v in guard_mod._DENY_NOTES.values() if v.get("rule") == "denied-repeat")
    assert note["source"] == "repeat"

    # 审计：记的是「重复发起已拦截」，不是「用户拒绝」
    rows = await _audit_rows(target)
    assert [r.result for r in rows] == [fp.RESULT_REPEAT_BLOCKED]


@pytest.mark.asyncio
async def test_新文件照常弹卡():
    from agentscope.permission import PermissionBehavior

    sid = _sid()
    denied = _target()
    await fp.remember_denial(fp.Action(path=denied, op=fp.OP_CREATE), session_id=sid)

    d, _ = await _decide(_target(), session_id=sid, user_text="回个收到")
    assert d.behavior == PermissionBehavior.ASK


@pytest.mark.asyncio
async def test_用户明确重新要求时例外放行照常弹卡():
    from agentscope.permission import PermissionBehavior

    sid, target = _sid(), _target()
    await fp.remember_denial(fp.Action(path=target, op=fp.OP_CREATE), session_id=sid)

    d, _ = await _decide(target, session_id=sid, user_text=f"还是把 {os.path.basename(target)} 写了吧")
    assert d.behavior == PermissionBehavior.ASK, d
    assert d.bypass_immune is True


@pytest.mark.asyncio
async def test_别的会话不受这份名单影响():
    from agentscope.permission import PermissionBehavior

    target = _target()
    await fp.remember_denial(fp.Action(path=target, op=fp.OP_CREATE), session_id=_sid())
    d, _ = await _decide(target, session_id=_sid(), user_text="回个收到")
    assert d.behavior == PermissionBehavior.ASK


# --------------------------------------------------------------------------- #
# 4) 收尾文案与提示注入
# --------------------------------------------------------------------------- #
def test_重复发起拦下时收尾不说你拒绝了():
    target = _target()
    guard_mod.note_denied(
        "tc_rep",
        reason=f"这个动作你在本会话里拒绝过：要新建 {target}",
        rule="denied-repeat",
        source="repeat",
    )
    item = svc._denial_entry(name="Write", call_id="tc_rep")
    assert item["source"] == "repeat"
    err = svc.denial_error([item])
    assert "没有再次弹卡" in err and "你拒绝了" not in err, err


def test_提示注入写死不要重新发起且不复述任务():
    target = _target()
    text = render_denied_actions([{"op": fp.OP_CREATE, "path": target, "ts": 0}])
    assert "以下动作已被用户拒绝，本会话内不要重新发起" in text
    assert f"新建 {target}" in text
    # 不是任务清单：不许出现「未完成 / 请继续」这类诱导重试的说法
    assert "未完成" not in text and "请继续" not in text
    # 没有拒绝记录时整段不出现
    assert render_denied_actions([]) == ""
