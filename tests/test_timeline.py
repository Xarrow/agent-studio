"""护栏：执行时间线（一次交互 = 一条）。

要钉住的是**配对正确**，因为整块界面的可信度都建立在这上面：
  ① 思考必须在第一段正文出现时收口（否则"思考 40 秒"是假的）
  ② 工具挂在它所属的那一轮下面（并行工具各自独立，不合并）
  ③ 用户点了确认要能闭合「等你确认」，等待时长是实测值
  ④ 崩了/被杀的执行不能让条永远张开
"""

from __future__ import annotations

from types import SimpleNamespace

from agent_studio.timeline import build_timeline


def ev(seq: int, type_: str, ts: int, **payload):
    return SimpleNamespace(seq=seq, type=type_, ts=ts, payload=payload)


def run(started=1000, ended=None):
    return SimpleNamespace(started_at=started, ended_at=ended, agent_id="ag_x", status="ok")


def call(id_=1, started=1000, model="deepseek-flash", tokens_in=None, tokens_out=None, ttft=800, cache=0, status="ok"):
    return SimpleNamespace(
        id=id_, started_at=started, model=model, provider="deepseek", tokens_in=tokens_in,
        tokens_out=tokens_out, tokens_cache_read=cache, ttft_ms=ttft, status=status, duration_ms=0,
    )


def tool(id_=1, call_id="c1", name="fetch", started=2000, status="ok", args=None, preview="200 OK", size=12):
    return SimpleNamespace(
        id=id_, call_id=call_id, tool_name=name, started_at=started, status=status,
        args=args or {"url": "https://example.com"}, result_preview=preview, result_size=size,
    )


def kinds(data):
    return [i["kind"] for i in data["items"]]


def test_一次交互四类都在_且父子正确():
    events = [
        ev(0, "run_start", 1000),
        ev(1, "llm_call_start", 1100, model="deepseek-flash", provider="deepseek"),
        ev(2, "thinking_delta", 1200, delta="我先看看这个 RFC 说了什么"),
        ev(3, "text_delta", 3000, delta="答案是"),
        ev(4, "tool_exec_start", 3100, tool_name="fetch", tool_call_id="c1"),
        ev(5, "tool_exec_end", 5200, tool_call_id="c1", state="success"),
        ev(6, "hitl_request", 5300, tool_name="Write"),
        ev(7, "hitl_decided", 9100, confirm=True, waited_ms=3800),
        ev(8, "llm_call_end", 9500, usage={"input_tokens": 1200, "output_tokens": 90}),
        ev(9, "run_end", 9600),
    ]
    data = build_timeline(
        run=run(ended=9600),
        events=events,
        llm_calls=[call(1, 1100, tokens_in=None, tokens_out=None)],
        tool_calls=[tool(1, "c1", started=3100)],
    )
    assert kinds(data) == ["llm", "think", "tool", "hitl"]

    llm, think, tool_item, hitl = data["items"]
    # 思考收口在正文出现的那一刻（3000），不是整轮结束
    assert think["started_at"] == 1200 and think["ended_at"] == 3000
    assert think["parent_id"] == llm["id"]
    assert think["attributes"]["chars"] == len("我先看看这个 RFC 说了什么")

    # 工具与等待都挂在这一轮下面
    assert tool_item["parent_id"] == llm["id"]
    assert tool_item["duration_ms"] == 2100
    assert tool_item["attributes"]["status"] == "ok"
    assert hitl["parent_id"] == llm["id"]
    assert hitl["duration_ms"] == 3800
    assert hitl["attributes"]["decision"] == "允许"
    assert hitl["attributes"]["waited_ms"] == 3800

    # 轮次条拿到 token / ttft / 关联的 llm_call
    assert llm["attributes"]["tokens_out"] == 90  # 事件里的 usage 覆盖
    assert llm["attributes"]["llm_call_id"] == 1
    assert data["slowest"]["kind"] == "hitl" or data["slowest"]["kind"] == "llm"


def test_思考不收口就不会被正文打断():
    """先思考 → 又思考（断续），中间没有正文：应合成一条。"""
    events = [
        ev(0, "run_start", 1000),
        ev(1, "llm_call_start", 1000),
        ev(2, "thinking_delta", 1100, delta="甲"),
        ev(3, "thinking_delta", 2100, delta="乙"),
        ev(4, "text_delta", 2600, delta="答"),
        ev(5, "llm_call_end", 3000),
    ]
    data = build_timeline(run=run(ended=3000), events=events, llm_calls=[call(1, 1000)])
    thinks = [i for i in data["items"] if i["kind"] == "think"]
    assert len(thinks) == 1
    assert thinks[0]["duration_ms"] == 1500


def test_未答复的等待_不永远张开():
    events = [
        ev(0, "run_start", 1000),
        ev(1, "llm_call_start", 1000),
        ev(2, "hitl_request", 1200, tool_name="Bash"),
    ]
    # run 被中断，没有 hitl_decided、也没有 run_end
    data = build_timeline(run=run(ended=4000), events=events, llm_calls=[call(1, 1000)])
    hitl = [i for i in data["items"] if i["kind"] == "hitl"][0]
    assert hitl["ended_at"] == 4000
    assert hitl["attributes"]["decision"] == "未答复"


def test_并行工具各占一条_不合并():
    events = [
        ev(0, "run_start", 1000),
        ev(1, "llm_call_start", 1000),
        ev(2, "tool_exec_start", 1100, tool_name="fetch", tool_call_id="a"),
        ev(3, "tool_exec_start", 1150, tool_name="fetch", tool_call_id="b"),
        ev(4, "tool_exec_end", 2100, tool_call_id="a", state="success"),
        ev(5, "tool_exec_end", 3100, tool_call_id="b", state="success"),
    ]
    data = build_timeline(
        run=run(ended=3200), events=events, llm_calls=[call(1, 1000)],
        tool_calls=[tool(1, "a", started=1100), tool(2, "b", started=1150)],
    )
    tools = [i for i in data["items"] if i["kind"] == "tool"]
    assert len(tools) == 2
    assert [t["duration_ms"] for t in tools] == [1000, 1950]


def test_多轮_第二轮未闭合的上一轮要收口():
    events = [
        ev(0, "run_start", 1000),
        ev(1, "llm_call_start", 1000),
        ev(2, "text_delta", 2000, delta="一"),
        ev(3, "llm_call_start", 2500),          # 上一轮没收到 end 就又开了一轮
        ev(4, "text_delta", 3000, delta="二"),
        ev(5, "llm_call_end", 3500),
    ]
    data = build_timeline(run=run(ended=3600), events=events, llm_calls=[call(1, 1000), call(2, 2500)])
    llms = [i for i in data["items"] if i["kind"] == "llm"]
    assert len(llms) == 2
    assert llms[0]["ended_at"] == 2500 and llms[0]["duration_ms"] == 1500
    assert llms[1]["attributes"]["iteration"] == 2


def test_空执行不报错():
    data = build_timeline(run=run(), events=[])
    assert data["items"] == [] and data["total_ms"] == 0 and data["slowest"] is None


def test_工具失败标_error():
    events = [
        ev(0, "run_start", 1000),
        ev(1, "tool_exec_start", 1100, tool_name="fetch", tool_call_id="c1"),
        ev(2, "tool_exec_end", 1600, tool_call_id="c1", error="timeout"),
    ]
    data = build_timeline(
        run=run(ended=1700), events=events, tool_calls=[tool(1, "c1", started=1100, status="error")]
    )
    t = [i for i in data["items"] if i["kind"] == "tool"][0]
    assert t["attributes"]["status"] == "error"


def test_轮次结束后才跑的工具_仍归那一轮():
    """真实时序：LLM 说完要调工具 → 这一轮结束 → 工具才执行。"""
    events = [
        ev(0, "run_start", 1000),
        ev(1, "llm_call_start", 1000),
        ev(2, "text_delta", 1500, delta="我来抓一下"),
        ev(3, "llm_call_end", 2000),
        ev(4, "tool_exec_start", 2100, tool_name="fetch", tool_call_id="c1"),
        ev(5, "tool_exec_end", 4200, tool_call_id="c1"),
        ev(6, "llm_call_start", 4300),
        ev(7, "llm_call_end", 5000),
    ]
    data = build_timeline(run=run(ended=5000), events=events, llm_calls=[call(1, 1000), call(2, 4300)],
                          tool_calls=[tool(1, "c1", started=2100)])
    llm1 = [i for i in data["items"] if i["kind"] == "llm"][0]
    tool_item = [i for i in data["items"] if i["kind"] == "tool"][0]
    assert tool_item["parent_id"] == llm1["id"], "工具要缩进在派它的那一轮下面"
