"""AG-UI 协议出口的护栏。

这一层唯一的价值是"**照规范发事件**"——所以守的都是规范里写死的东西：
① 事件名与字段名必须是 AG-UI 的那套（RUN_STARTED / TEXT_MESSAGE_CONTENT …）；
② 块必须**成对**（START → CONTENT* → END）：客户端按这个状态机渲染，
   少一个 END 它会一直转圈；
③ 先开的内容要先关：文本流着流着来工具调用时，必须先关文本消息；
④ 出错要发 RUN_ERROR（而不是干巴巴断流）；没开跑就失败也要先补 RUN_STARTED；
⑤ threadId → 平台会话是**确定性**的（同一 thread 多次调用落同一会话，多轮才接得上）。

规范来源：本地 @ag-ui/core（copilot-demo 里那份，版本见 AGUI_VERSION）。
另有一层真校验：把这里产出的事件喂给 @ag-ui 的 zod schema（见 tests 目录外的
`/tmp/agui_validate.cjs` 做的人工核验，schema 不符会直接报错）。
"""

from __future__ import annotations

import json

import pytest

from agent_studio.agui import (
    T_CUSTOM,
    T_RUN_ERROR,
    T_RUN_FINISHED,
    T_RUN_STARTED,
    T_STEP_FINISHED,
    T_STEP_STARTED,
    T_TEXT_CONTENT,
    T_TEXT_END,
    T_TEXT_START,
    T_THINK_END,
    T_THINK_MSG_CONTENT,
    T_THINK_MSG_END,
    T_THINK_MSG_START,
    T_THINK_START,
    T_TOOL_ARGS,
    T_TOOL_END,
    T_TOOL_RESULT,
    T_TOOL_START,
    AguiTranslator,
    last_user_text,
    session_id_for,
)

pytestmark = pytest.mark.asyncio


def _types(events: list[dict]) -> list[str]:
    return [e["type"] for e in events]


def _feed(tr: AguiTranslator, *events: tuple[str, dict]) -> list[str]:
    out: list[str] = []
    for etype, payload in events:
        out += _types(tr.feed({"type": etype, "payload": payload}))
    return out


def test_一轮文本_开闭成对():
    tr = AguiTranslator(thread_id="t1", run_id="r1")
    got = _feed(
        tr,
        ("run_start", {}),
        ("llm_call_start", {"model": "deepseek-v4-flash"}),
        ("text_delta", {"delta": "你"}),
        ("text_delta", {"delta": "好"}),
        ("llm_call_end", {}),
    )
    assert got == [
        T_RUN_STARTED,
        T_CUSTOM,          # platform_run：把平台 run id 带回给客户端
        T_STEP_STARTED,
        T_CUSTOM,          # llm_call：模型名
        T_TEXT_START,
        T_TEXT_CONTENT,
        T_TEXT_CONTENT,
        # 这一步的内容先收干净再收步（END 落在它所属的那一步里，客户端不会把消息挂到下一步）
        T_TEXT_END,
        T_STEP_FINISHED,
    ]
    tail = _types(tr.close(status="ok", usage={"input_tokens": 10, "output_tokens": 2}))
    assert tail == [T_RUN_FINISHED]

    ev = tr.close(status="ok")[0]  # 幂等：再收一次只剩结束事件
    assert ev["type"] == T_RUN_FINISHED
    # 规范要求 usage 是**数组**（一次运行可能跨多个模型/子 agent，各自一行）
    assert isinstance(tr.close(status="ok", usage={"input_tokens": 5, "output_tokens": 1})[-1].get("usage"), list)


def test_文本消息字段与顺序():
    tr = AguiTranslator(thread_id="t1", run_id="r1")
    tr.feed({"type": "run_start", "payload": {}})
    tr.feed({"type": "text_delta", "payload": {"delta": "甲"}})
    ev = tr.feed({"type": "text_delta", "payload": {"delta": "乙"}})
    assert ev == [{"type": T_TEXT_CONTENT, "messageId": "msg_r1_1", "delta": "乙"}]
    start = tr.close(status="ok")[0]
    assert start == {"type": T_TEXT_END, "messageId": "msg_r1_1"}


def test_思考流_按AGUI的THINKING事件发():
    tr = AguiTranslator(thread_id="t1", run_id="r1")
    got = _feed(
        tr,
        ("run_start", {}),
        ("thinking_delta", {"delta": "先"}),
        ("thinking_delta", {"delta": "想"}),
        ("text_delta", {"delta": "答"}),
    )
    assert got == [
        T_RUN_STARTED,
        T_CUSTOM,
        T_THINK_START,
        T_THINK_MSG_START,
        T_THINK_MSG_CONTENT,
        T_THINK_MSG_CONTENT,
        # 开始回答之前，思考块必须先关掉
        T_THINK_MSG_END,
        T_THINK_END,
        T_TEXT_START,
        T_TEXT_CONTENT,
    ]


def test_工具调用_参数到齐即结束_结果单独回一条():
    tr = AguiTranslator(thread_id="t1", run_id="r1")
    got = _feed(
        tr,
        ("run_start", {}),
        ("text_delta", {"delta": "我查一下"}),
        ("tool_call_start", {"tool_call_id": "call_1", "tool_name": "web_search"}),
        ("tool_call_args", {"delta": '{"q":'}),
        ("tool_call_args", {"delta": '"天气"}'}),
        ("tool_exec_start", {}),
        ("tool_exec_end", {"tool_call_id": "call_1", "result": {"ok": True, "items": 3}}),
    )
    assert got == [
        T_RUN_STARTED,
        T_CUSTOM,
        T_TEXT_START,
        T_TEXT_CONTENT,
        # 开工具调用前必须先关文本消息（不然客户端的文本块会一直开着）
        T_TEXT_END,
        T_TOOL_START,
        T_TOOL_ARGS,
        T_TOOL_ARGS,
        T_TOOL_END,
        T_TOOL_RESULT,
    ]
    events = []
    tr2 = AguiTranslator(thread_id="t1", run_id="r1")
    for e in (
        ("run_start", {}),
        ("tool_call_start", {"tool_call_id": "c", "tool_name": "t"}),
        ("tool_exec_end", {"tool_call_id": "c", "result": "纯文本结果"}),
    ):
        events += tr2.feed({"type": e[0], "payload": e[1]})
    result = [x for x in events if x["type"] == T_TOOL_RESULT][0]
    assert result["content"] == "纯文本结果" and result["role"] == "tool"
    assert result["toolCallId"] == "c"


def test_出错要发RUN_ERROR_而不是断流():
    tr = AguiTranslator(thread_id="t1", run_id="r1")
    got = _feed(tr, ("run_start", {}), ("error", {"message": "模型 429"}))
    assert T_RUN_ERROR in got
    err = [e for e in tr.feed({"type": "error", "payload": {"message": "再来一次"}}) if e["type"] == T_RUN_ERROR][0]
    assert err["message"] == "再来一次"
    # 收尾时如果状态是 error，也要给 RUN_ERROR（客户端才知道是失败结束）
    tail = _types(tr.close(status="error", error="模型 429"))
    assert tail[-1] == T_RUN_ERROR


def test_还没开跑就失败_要先补RUN_STARTED():
    tr = AguiTranslator(thread_id="t1", run_id="r1")
    events = tr.bootstrap_error("平台上没有助手")
    assert _types(events) == [T_RUN_STARTED, T_RUN_ERROR]
    # 已经开跑过就不该重复发 RUN_STARTED
    tr.feed({"type": "run_start", "payload": {}})
    assert _types(tr.bootstrap_error("又失败")) == [T_RUN_ERROR]


def test_线程映射是确定的_换助手就是另一段会话():
    a = session_id_for("thread-1", "ag_a")
    assert a == session_id_for("thread-1", "ag_a")
    assert a != session_id_for("thread-1", "ag_b"), "换了助手要新会话（平台不允许会话跨助手）"
    assert a != session_id_for("thread-2", "ag_a")
    assert a.startswith("ses_") and len(a) == 28, "平台会话 id 长度上限 32"


def test_取最后一条用户文本_支持多模态数组():
    assert last_user_text([{"role": "assistant", "content": "x"}, {"role": "user", "content": "问"}]) == "问"
    assert (
        last_user_text(
            [{"role": "user", "content": [{"type": "text", "text": "看这张"}, {"type": "image", "url": "u"}]}]
        )
        == "看这张"
    )
    assert last_user_text([]) == ""
    assert last_user_text("不是列表") == ""


async def test_端点_没有用户消息时如实报错(client):
    got = await client.post(
        "/api/agui",
        json={"threadId": "t1", "runId": "r1", "messages": [{"role": "assistant", "content": "hi"}]},
    )
    assert got.status_code == 200
    text = got.text
    assert "RUN_STARTED" in text and "RUN_ERROR" in text
    assert "没有可执行的输入" in text


async def test_端点_info_给出助手与协议版本(client):
    got = await client.get("/api/agui/info")
    assert got.status_code == 200
    body = got.json()
    assert body["protocol"] == "ag-ui" and body["version"]
    assert isinstance(body["agents"], list)
    assert body["endpoint"] == "/api/agui"


async def test_端点_流是SSE且事件可解析(client):
    """哪怕只是一次失败，也必须是规范形状的 SSE 帧（客户端才能解析）。"""
    got = await client.post("/api/agui", json={"threadId": "t1", "runId": "r1", "messages": []})
    frames = [ln for ln in got.text.splitlines() if ln.startswith("data: ")]
    assert frames, "至少要有事件帧"
    for f in frames:
        ev = json.loads(f[6:])
        assert isinstance(ev.get("type"), str)

def test_真实事件形状_工具名与结果是流式攒起来的():
    """按线上实测的 payload 键名钉死：

    · ``tool_call_start`` 给的是 ``tool_call_name``（不是 tool_name）——
      读错键名会让客户端看到工具叫 "tool"；
    · ``tool_exec_end`` **不带结果**（只有 state），结果在 ``tool_result_delta`` 里流式吐出来 →
      必须攒起来一次性给 TOOL_CALL_RESULT，否则客户端拿到的结果是空的。
    """
    tr = AguiTranslator(thread_id="t", run_id="r")
    tr.feed({"type": "run_start", "payload": {}})
    tr.feed({"type": "llm_call_start", "payload": {"reply_id": "x", "model_name": "deepseek-v4-flash"}})
    started = tr.feed(
        {"type": "tool_call_start", "payload": {"tool_call_id": "call_1", "tool_call_name": "fetch"}}
    )
    call = [e for e in started if e["type"] == T_TOOL_START][0]
    assert call["toolCallName"] == "fetch"

    tr.feed({"type": "tool_call_args", "payload": {"tool_call_id": "call_1", "delta": '{"url":"u"}'}})
    tr.feed({"type": "tool_exec_start", "payload": {"tool_call_id": "call_1", "tool_call_name": "fetch"}})
    tr.feed({"type": "tool_result_delta", "payload": {"tool_call_id": "call_1", "delta": "第一段"}})
    tr.feed({"type": "tool_result_delta", "payload": {"tool_call_id": "call_1", "delta": "第二段"}})
    end = tr.feed({"type": "tool_exec_end", "payload": {"tool_call_id": "call_1", "state": "success"}})
    result = [e for e in end if e["type"] == T_TOOL_RESULT][0]
    assert result["content"] == "第一段第二段", "结果要从流式片段攒出来"
    assert result["role"] == "tool"
    # 攒完就清空，别在内存里越积越多
    assert tr._tool_output.get("call_1") in (None, [])


def test_用量取模型调用结束时的真实字段名():
    tr = AguiTranslator(thread_id="t", run_id="r")
    tr.feed({"type": "run_start", "payload": {}})
    tr.feed({"type": "llm_call_start", "payload": {"model_name": "deepseek-v4-flash"}})
    tr.feed(
        {"type": "llm_call_end",
         "payload": {"input_tokens": 120, "output_tokens": 8, "cache_input_tokens": 30}}
    )
    ev = tr.close(status="ok")[-1]
    assert ev["usage"][0]["inputTokens"] == 120 and ev["usage"][0]["outputTokens"] == 8
    assert ev["usage"][0]["cachedInputTokens"] == 30

