"""粒度三修：拒绝范围覆盖整条命令、多动作逐个裁决、危险卡降噪。

现场（2026-11，公网真人路径，bash 助手，一条复合命令引发）：
1. 让助手写 ``/var/lib/agent-studio/b2fix2-a.txt``，它用
   ``mkdir -p /var/lib/agent-studio && printf … > …/b2fix2-a.txt``，
   弹出来的卡却是「覆盖 /var/lib/agent-studio」（mkdir 的目标），用户拒了它 ——
   真正的目标 A 没进拒绝名单，下一轮又弹一次。
2. 再让它写新文件 B，它把已拒绝的 A 和 B 打包在同一条命令里，平台因含 A 整包
   拦下，B 连自己的确认卡都没有。
3. ``ls … 2>/dev/null`` 被当成「覆盖 /dev/null」弹危险确认卡。

这里守的是三条口径：
· 一张卡被拒 → 卡上覆盖的**每个**文件目标都进会话拒绝名单；
· 一条命令里有多个动作 → 逐个分类（已拒绝/需确认/可放行），能拆分的只跑可执行段；
· 判据是**实际效果**：/dev/null 重定向、对已存在目录的 mkdir、纯读命令的
  无害重定向都不算写入。
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from agent_studio import file_policy as fp
from agent_studio import guardrails as gr
from agent_studio.db import SessionLocal
from agent_studio.models import FileAudit
from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx
from agent_studio.runtimes.agentscope_rt import guard as guard_mod
from agent_studio.runtimes.agentscope_rt.guard import DangerousActionGuard

WS = "/srv/src/agent-studio/data/work/sessions/ses_grains"
OUT = "/var/lib/agent-studio"


def _sid() -> str:
    return "ses_" + uuid.uuid4().hex[:12]


def _tmp(name: str = "") -> str:
    return f"{OUT}/grain-{uuid.uuid4().hex[:8]}{name}"


class _Handler:
    """引擎那边 —— 被调用就说明「交回引擎了」。"""

    def __init__(self) -> None:
        self.calls = 0

    async def __call__(self, **_: object):
        from agentscope.permission import PermissionBehavior, PermissionDecision

        self.calls += 1
        return PermissionDecision(behavior=PermissionBehavior.ALLOW, message="engine-allow")


async def _decide(command: str, *, session_id: str, user_text: str = "", tool: str = "bash"):
    set_run_ctx(
        workspace=WS,
        interactive=True,
        run_id="run_grains",
        agent_id="",
        session_id=session_id,
        input_text=user_text,
    )
    call_id = "tc_" + uuid.uuid4().hex[:8]
    handler = _Handler()
    decision = await DangerousActionGuard().on_check_permission(
        agent=None,
        input_kwargs={
            "tool_call": SimpleNamespace(name=tool, id=call_id, state="pending"),
            "tool": SimpleNamespace(name=tool),
            "tool_input": {"command": command},
        },
        next_handler=handler,
    )
    return decision, handler, call_id


@pytest.fixture(autouse=True)
def _reset():
    guard_mod.clear_reasons()
    guard_mod.clear_denied_notes()
    guard_mod.clear_trims()
    fp.invalidate_skip_cache()
    yield
    clear_run_ctx()
    guard_mod.clear_denied_notes()
    guard_mod.clear_trims()
    fp.invalidate_skip_cache()


async def _audit_rows(path: str) -> list[FileAudit]:
    async with SessionLocal() as s:
        rows = (await s.execute(select(FileAudit).where(FileAudit.path == path))).scalars().all()
        return list(rows)


# --------------------------------------------------------------------------- #
# 1) 降噪：按实际效果判，不按命令里有没有 `>`
# --------------------------------------------------------------------------- #
def test_重定向到_dev_null_不算写入():
    assert fp.actions_for_command(f"ls {OUT} 2>/dev/null", WS) == []
    assert fp.actions_for_command(f"cat {OUT}/x.txt > /dev/null 2>&1", WS) == []
    # 同一条命令里真有落点时才记那一个
    real = _tmp(".txt")
    acts = fp.actions_for_command(f"ls {OUT} > /dev/null && echo hi > {real}", WS)
    assert [a.path for a in acts] == [real]


def test_dev_null_不再被当成工作目录外的写入():
    """guardrails 那层也不能把 ``2>/dev/null`` 说成「要写工作目录外的文件」。"""
    verdict = gr.classify_command(f"ls {OUT} 2>/dev/null", WS)
    assert verdict.risk != gr.RISK_ASK, verdict.reason


def test_对已存在目录的_mkdir_p_没有动作(tmp_path):
    existing = str(tmp_path)
    assert fp.actions_for_command(f"mkdir -p {existing}", WS) == []
    # 真会新建的目录仍然要确认
    fresh = f"{existing}/sub-{uuid.uuid4().hex[:6]}"
    assert [a.path for a in fp.actions_for_command(f"mkdir -p {fresh}", WS)] == [fresh]


def test_复合命令解析出真实目标():
    """`mkdir -p 已存在目录 && printf > A` → 只有 A，不再单独为目录弹卡。"""
    a = _tmp("-a.txt")
    acts = fp.actions_for_command(f"mkdir -p /tmp && printf 'x' > {a}", WS)
    assert [x.path for x in acts] == [a]
    assert acts[0].op == fp.OP_CREATE


@pytest.mark.asyncio
async def test_纯读命令带无害重定向不弹卡也不进名单():
    from agentscope.permission import PermissionBehavior

    sid = _sid()
    d, handler, _cid = await _decide(f"ls {OUT} 2>/dev/null", session_id=sid)
    assert d.behavior != PermissionBehavior.ASK, d
    assert handler.calls == 1  # 交回引擎（= 按读放行）
    assert await _audit_rows("/dev/null") == []


# --------------------------------------------------------------------------- #
# 2) 多动作：逐个裁决，不许整包连坐
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_已拒绝与新动作同包_新动作单独弹卡_被拒的单独拦():
    from agentscope.permission import PermissionBehavior

    sid = _sid()
    a, b = _tmp("-a.txt"), _tmp("-b.txt")
    await fp.remember_denial(fp.Action(path=a, op=fp.OP_CREATE), session_id=sid, run_id="run_prev")

    cmd = f"mkdir -p /tmp && printf 'A' > {a} && printf 'B' > {b}"
    d, handler, call_id = await _decide(cmd, session_id=sid, user_text="回个收到")

    assert d.behavior == PermissionBehavior.ASK, "B 必须拿到自己的确认卡，不能被 A 连坐"
    assert handler.calls == 0
    assert b in d.message, d.message
    # 卡上要说清「另一部分已按拒绝名单拦下」，用户才知道这条命令不会写 A
    assert "拒绝名单" in d.message and a in d.message

    # 卡上只有 B（A 已经在这张卡之外被拦下，点允许不该顺手把它从名单里划掉）
    card = guard_mod.file_actions()[call_id]
    assert [x["path"] for x in card["actions"]] == [b]

    # A 记的是「重复发起已拦截」，不是又一条「用户拒绝」
    assert [r.result for r in await _audit_rows(a)] == [fp.RESULT_REPEAT_BLOCKED]

    # 执行时会改写命令：只跑含 B 的那段
    trimmed, note = guard_mod.pop_trim(call_id)
    assert b in trimmed and a not in trimmed, trimmed
    assert "拒绝" in note


@pytest.mark.asyncio
async def test_已拒绝的动作与工作区内写入同包_只跑可执行部分():
    from agentscope.permission import PermissionBehavior

    sid = _sid()
    a = _tmp("-a.txt")
    await fp.remember_denial(fp.Action(path=a, op=fp.OP_CREATE), session_id=sid)

    inside = f"{WS}/keep-{uuid.uuid4().hex[:6]}.txt"
    d, _handler, call_id = await _decide(f"printf 'A' > {a} && printf 'ok' > {inside}", session_id=sid)

    assert d.behavior == PermissionBehavior.ALLOW
    assert d.decision_reason == "file-write-partial-allow"
    trimmed, note = guard_mod.pop_trim(call_id)
    assert trimmed == f"printf 'ok' > {inside}"
    assert "拒绝" in note
    # 归因是「重复发起」：这一轮不该因此收尾
    assert guard_mod.denied_note(call_id)["source"] == "repeat"


@pytest.mark.asyncio
async def test_不能拆分的复合命令含已拒绝动作_整条拦下并说明():
    from agentscope.permission import PermissionBehavior

    sid = _sid()
    a, b = _tmp("-a.txt"), _tmp("-b.txt")
    await fp.remember_denial(fp.Action(path=a, op=fp.OP_CREATE), session_id=sid)

    # `||` 连接：丢掉左操作数会改变语义 → 判「不可拆分」，整条不执行
    d, _handler, call_id = await _decide(f"printf 'A' > {a} || printf 'B' > {b}", session_id=sid)
    assert d.behavior == PermissionBehavior.DENY
    assert d.decision_reason == "file-write-denied-repeat"
    assert "单独发起" in d.message
    assert guard_mod.pop_trim(call_id) == ("", "")


@pytest.mark.asyncio
async def test_多个新动作共用一张卡_全部目标都进卡():
    from agentscope.permission import PermissionBehavior

    sid = _sid()
    a, b = _tmp("-a.txt"), _tmp("-b.txt")
    d, _handler, call_id = await _decide(f"printf 'A' > {a} && printf 'B' > {b}", session_id=sid)

    assert d.behavior == PermissionBehavior.ASK
    card = guard_mod.file_actions()[call_id]
    assert [x["path"] for x in card["actions"]] == [a, b]
    assert "2 个位置" in d.message


@pytest.mark.asyncio
async def test_一条_rm_删两个文件_卡上两个目标都在():
    """现场（2026-11）：`rm -f a.txt b.txt` 卡上只列 a，实际两个都删了。

    命令只有一个目标时按第一段解析是对的；多目标命令要**每个参数一条动作**，
    才能让确认卡、审计、实际执行三者一致。
    """
    from agentscope.permission import PermissionBehavior

    a, b = _tmp("-a.txt"), _tmp("-b.txt")
    assert [x.path for x in fp.actions_for_command(f"rm -f {a} {b}", WS)] == [a, b]

    sid = _sid()
    d, _handler, call_id = await _decide(f"rm -f {a} {b}", session_id=sid)
    assert d.behavior == PermissionBehavior.ASK
    card = guard_mod.file_actions()[call_id]
    assert [(x["op"], x["path"]) for x in card["actions"]] == [(fp.OP_DELETE, a), (fp.OP_DELETE, b)]
    assert "2 个位置" in d.message


@pytest.mark.asyncio
async def test_代码通道不可拆分_含已拒绝动作时整条拦下():
    """python 工具的入参改不了执行内容（不像 bash 能改写 command）→ 不许半拆。"""
    from agentscope.permission import PermissionBehavior

    sid = _sid()
    a, b = _tmp("-a.py.txt"), _tmp("-b.py.txt")
    await fp.remember_denial(fp.Action(path=a, op=fp.OP_CREATE), session_id=sid)

    code = f"open('{a}','w').write('A')\nopen('{b}','w').write('B')"
    set_run_ctx(workspace=WS, interactive=True, run_id="r", agent_id="", session_id=sid, input_text="")
    call_id = "tc_" + uuid.uuid4().hex[:8]
    handler = _Handler()
    d = await DangerousActionGuard().on_check_permission(
        agent=None,
        input_kwargs={
            "tool_call": SimpleNamespace(name="python", id=call_id, state="pending"),
            "tool": SimpleNamespace(name="python"),
            "tool_input": {"code": code},
        },
        next_handler=handler,
    )
    assert d.behavior == PermissionBehavior.DENY, d
    assert d.decision_reason == "file-write-denied-repeat"
    assert guard_mod.pop_trim(call_id) == ("", ""), "代码通道不该给改写计划"


@pytest.mark.asyncio
async def test_同一段里既被拒又待确认_按不可拆分整条拦下(tmp_path):
    """`cat f | tee A | tee B`：丢掉整段会把该问的也一起丢掉 → 不半拆。"""
    from agentscope.permission import PermissionBehavior

    sid = _sid()
    a, b = str(tmp_path / "pipe-a.txt"), str(tmp_path / "pipe-b.txt")
    for path in (a, b):
        with open(path, "w") as fh:
            fh.write("x")
    await fp.remember_denial(fp.Action(path=a, op=fp.OP_OVERWRITE), session_id=sid)

    d, _h, call_id = await _decide(f"cat {a} | tee {a} {b}", session_id=sid)
    assert d.behavior == PermissionBehavior.DENY, d
    assert guard_mod.pop_trim(call_id) == ("", "")


# --------------------------------------------------------------------------- #
# 3) 拒绝范围：卡上每个目标都进名单
# --------------------------------------------------------------------------- #
def test_卡上的每个目标都会被登记():
    from agent_studio.api.runs import _card_actions_of

    a, b = _tmp("-a.txt"), _tmp("-b.txt")
    acts = _card_actions_of(
        {
            "tc_1": {
                "path": a,
                "op": fp.OP_CREATE,
                "actions": [
                    {"path": a, "op": fp.OP_CREATE},
                    {"path": b, "op": fp.OP_CREATE},
                    {"path": a, "op": fp.OP_CREATE},  # 重复不该记两遍
                ],
            }
        }
    )
    assert [(x["op"], x["path"]) for x in acts] == [
        (fp.OP_CREATE, a),
        (fp.OP_CREATE, b),
    ]
    # 老记录没有 actions 字段 → 退回卡上那一条
    assert [x["path"] for x in _card_actions_of({"tc_2": {"path": a, "op": fp.OP_CREATE}})] == [a]


# --------------------------------------------------------------------------- #
# 4) 例外放行：「还是把 A 写了吧」算明确重提
# --------------------------------------------------------------------------- #
def test_标识符式文件名允许用词元指代():
    act = fp.Action(path=f"{OUT}/b2fix2-a.txt", op=fp.OP_CREATE)
    assert fp.explicit_retry("还是把 A 写了吧", act) is True
    assert fp.explicit_retry("还是把 a 写了吧", act) is True
    assert fp.explicit_retry("回个收到", act) is False
    # 否定词仍然按拦截（不变）
    assert fp.explicit_retry("别写 A 了", act) is False
    # 英文冠词 a 不算点名（普通句子里到处都是 a）
    assert fp.names_path("write a file for me", act.path) is False
    # 提到**兄弟文件**不算重提这个（同一个前缀被多个文件共用 —— 实测把"写 B"
    # 误判成"重提 A"，结果 A 被写了出来）
    assert fp.explicit_retry(f"把 hello 写进 {OUT}/b2fix2-b.txt", act) is False


# --------------------------------------------------------------------------- #
# 5) 端到端的那半截：拒绝一张多目标卡 → 每个目标都进名单；重发只记「重复拦截」
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_拒绝一张多目标卡_每个目标都进名单_重发只记重复拦截(client, monkeypatch):
    from agentscope.permission import PermissionBehavior

    from agent_studio.db import SessionLocal
    from agent_studio.models import Run, now_ms
    from agent_studio.runner import service as svc_mod

    async def _ok(run_id, hitl):
        # 按真实 resume 的关键副作用来：状态翻 running、待确认清空
        async with SessionLocal() as s:
            run = await s.get(Run, run_id)
            run.status = "running"
            run.pending_hitl = None
            await s.commit()
        return True

    monkeypatch.setattr(svc_mod.run_service, "resume", _ok)

    sid = _sid()
    tag = uuid.uuid4().hex[:8]
    d = f"{OUT}/grain-{tag}"
    a, b = f"{d}/grain-{tag}-a.txt", f"{d}/grain-{tag}-b.txt"
    rid = f"run_grains_{tag}"
    async with SessionLocal() as s:
        s.add(
            Run(
                id=rid,
                agent_id="ag_grains",
                session_id=sid,
                status="waiting_hitl",
                input={"text": "写两个文件"},
                started_at=now_ms(),
                pending_hitl={
                    "reply_id": f"rep_{tag}",
                    "tool_calls": [{"id": "tc_grains", "name": "bash"}],
                    "file_actions": {
                        "tc_grains": {
                            "path": a,
                            "op": fp.OP_CREATE,
                            "dir": d,
                            "actions": [
                                {"path": a, "op": fp.OP_CREATE},
                                {"path": b, "op": fp.OP_CREATE},
                            ],
                        }
                    },
                },
            )
        )
        await s.commit()

    r = await client.post(f"/api/runs/resume/{rid}", json={"confirm": False})
    assert r.status_code == 200, r.text
    denied = {(x["op"], x["path"]) for x in await fp.denied_in_session(sid)}
    assert denied == {(fp.OP_CREATE, a), (fp.OP_CREATE, b)}, denied
    assert [row.result for row in await _audit_rows(a)] == [fp.RESULT_REJECTED]
    assert [row.result for row in await _audit_rows(b)] == [fp.RESULT_REJECTED]

    # 同一会话再发起任一个目标：不弹卡（交回引擎=0）、只多一条「重复发起已拦截」
    for path in (a, b):
        decision, handler, _cid = await _decide(
            f"printf 'x' > {path}", session_id=sid, user_text="回个收到"
        )
        assert decision.behavior == PermissionBehavior.DENY, decision
        assert handler.calls == 0, "已被拒的动作不该再弹卡"
        rows = [row.result for row in await _audit_rows(path)]
        assert rows == [fp.RESULT_REJECTED, fp.RESULT_REPEAT_BLOCKED], rows

    # 用户**明确重提**（消息里点了 A）→ 照常弹卡确认，不再按名单拦
    decision, _h, _cid = await _decide(
        f"printf 'x' > {a}", session_id=sid, user_text="还是把 A 写了吧"
    )
    assert decision.behavior == PermissionBehavior.ASK, decision


# --------------------------------------------------------------------------- #
# 6) 复合命令：真目录 + 真文件都在同一张卡上（降噪只针对**已存在**的目录）
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_新建目录与目录下的文件都在同一张卡上():
    from agentscope.permission import PermissionBehavior

    tag = uuid.uuid4().hex[:8]
    d = f"{OUT}/grain-{tag}"
    a = f"{d}/grain-{tag}-a.txt"
    decision, _handler, call_id = await _decide(f"mkdir -p {d} && printf 'x' > {a}", session_id=_sid())

    assert decision.behavior == PermissionBehavior.ASK, decision
    card = guard_mod.file_actions()[call_id]
    assert [(x["op"], x["path"]) for x in card["actions"]] == [
        (fp.OP_CREATE, d),
        (fp.OP_CREATE, a),
    ], card["actions"]
    assert a in decision.message, decision.message


# --------------------------------------------------------------------------- #
# 7) 执行钩子：改写真的落在执行那一刻（权限层改不动入参，靠 on_acting）
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_执行前改写命令_并给模型留一句说明():
    import json

    from agentscope.message import TextBlock
    from agentscope.tool import ToolResponse

    call_id = "tc_" + uuid.uuid4().hex[:8]
    trimmed = "printf 'B' > /tmp/grain-b.txt"
    guard_mod.note_trim(call_id, trimmed, "【平台】被拒绝的那一段没有执行")
    tool_call = SimpleNamespace(
        id=call_id,
        input=json.dumps({"command": "printf 'A' > /tmp/grain-a.txt && printf 'B' > /tmp/grain-b.txt", "timeout": 5}),
    )
    seen: dict[str, object] = {}

    async def _next(**_: object):
        seen["cmd"] = json.loads(tool_call.input)["command"]
        yield ToolResponse(content=[TextBlock(type="text", text="工具结果")])

    items = [
        item
        async for item in DangerousActionGuard().on_acting(
            agent=None, input_kwargs={"tool_call": tool_call}, next_handler=_next
        )
    ]
    assert seen["cmd"] == trimmed, "执行时必须是改写后的命令"
    assert json.loads(tool_call.input)["timeout"] == 5, "其它入参不能被改掉"
    assert isinstance(items[-1], ToolResponse)
    text = "".join(getattr(b, "text", "") for b in items[-1].content)
    assert "工具结果" in text and "没有执行" in text, text
    assert guard_mod.pop_trim(call_id) == ("", ""), "改写计划必须消费掉，不能漏到下一次"
