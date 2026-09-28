"""模型调用「完整请求与响应」记录的护栏。

背景：``llm_call`` 表早就建好、元数据也一直写，但 ``request_blob``/``response_blob``
**从来没被填过** —— 出问题时看不到"发出去的消息和工具定义、模型原样回了什么"。
现在由 runner/recorder.py 的 AgentScope 中间件在 ``on_model_call`` 钩子上补上。

守四条：
① 非流式：请求（messages/tools/生成参数）与响应（内容块/结束原因）都落库，能解回来；
② 流式：分片是**增量**，必须累加 —— 只取最后一片会丢正文（真踩过这类坑）；
③ 调用失败：也要留一条 error 记录（失败现场恰恰最需要原件）；
④ 记录本身失败不能影响执行（这里用"没有 run 上下文"模拟：静默跳过，不抛）。
"""

from __future__ import annotations

import json

import pytest
from sqlalchemy import select

from agent_studio.db import SessionLocal
from agent_studio.models import LlmCall, Run, new_id, now_ms
from agent_studio.runner.ctx import set_run_ctx
from agent_studio.runner.recorder import MAX_SIDE_CHARS, ModelCallRecorder, decode_payload


class _FakeModel:
    model_name = "fake-model"
    generate_kwargs = {"temperature": 0.3}


class _Block:
    def __init__(self, text: str = "", bid: str = "b1") -> None:
        self.id = bid
        self.text = text


class _FakeResponse:
    """够用的 ChatResponse 替身：content 块 + usage + finished_reason。"""

    def __init__(self, text: str = "", *, finished: str = "completed",
                 tokens_in: int = 0, tokens_out: int = 0) -> None:
        self.id = "r1"
        self.content = [_Block(text)]
        self.usage = {"input_tokens": tokens_in, "output_tokens": tokens_out, "cache_input_tokens": 0}
        self.finished_reason = finished

    def model_dump(self) -> dict:
        return {
            "id": self.id,
            "content": [{"id": b.id, "text": b.text} for b in self.content],
            "usage": self.usage,
            "finished_reason": self.finished_reason,
        }

    def model_copy(self, deep: bool = False) -> "_FakeResponse":
        return _FakeResponse(self.content[0].text, finished=self.finished_reason,
                             tokens_in=self.usage["input_tokens"],
                             tokens_out=self.usage["output_tokens"])

    def append_chat_response(self, other: "_FakeResponse") -> "_FakeResponse":
        """真实现是按 block id 把增量文本接上（这里照同一个语义）。"""
        for b in other.content:
            mine = next((x for x in self.content if x.id == b.id), None)
            if mine is None:
                self.content.append(_Block(b.text, b.id))
            else:
                mine.text += b.text
        self.usage["output_tokens"] += other.usage["output_tokens"]
        return self


async def _mk_run() -> str:
    async with SessionLocal() as s:
        rid = new_id("run")
        s.add(Run(id=rid, agent_id="ag_test", status="running", started_at=now_ms(),
                  input={"text": "记录测试"}))
        await s.commit()
    return rid


async def _rows(run_id: str) -> list[LlmCall]:
    async with SessionLocal() as s:
        return list(
            (await s.execute(select(LlmCall).where(LlmCall.run_id == run_id).order_by(LlmCall.id)))
            .scalars()
        )


@pytest.mark.asyncio
async def test_非流式请求与响应都留原文(client):
    rid = await _mk_run()
    set_run_ctx(run_id=rid, agent_id="ag_test", depth=0)
    rec = ModelCallRecorder(provider="deepseek", model="deepseek-chat")

    async def handler(**kwargs):
        return _FakeResponse("你好，世界", tokens_in=120, tokens_out=8)

    out = await rec.on_model_call(
        agent=None,
        input_kwargs={
            "current_model": _FakeModel(),
            "messages": [{"role": "user", "content": "打招呼"}],
            "tools": [{"name": "bash", "description": "跑命令"}],
            "tool_choice": "auto",
        },
        next_handler=handler,
    )
    assert out.content[0].text == "你好，世界"

    rows = await _rows(rid)
    assert len(rows) == 1
    row = rows[0]
    assert row.model == "deepseek-chat" and row.provider == "deepseek"
    assert (row.tokens_in, row.tokens_out) == (120, 8)
    assert row.status == "ok" and row.duration_ms is not None

    req = decode_payload(row.request_blob)
    assert req["messages"][0]["content"] == "打招呼"
    assert req["tools"][0]["name"] == "bash", "工具定义也要留证（模型能看到什么，排查时要能复原）"
    assert req["generate_kwargs"]["temperature"] == 0.3

    resp = decode_payload(row.response_blob)
    assert resp["content"][0]["text"] == "你好，世界"
    assert resp["finished_reason"] == "completed"


@pytest.mark.asyncio
async def test_流式要累加增量而不是只留最后一片(client):
    rid = await _mk_run()
    set_run_ctx(run_id=rid, agent_id="ag_test", depth=0)
    rec = ModelCallRecorder(provider="deepseek", model="deepseek-chat")

    async def handler(**kwargs):
        async def gen():
            for piece in ("你", "好", "，世界"):
                yield _FakeResponse(piece, tokens_out=1)
        return gen()

    stream = await rec.on_model_call(
        agent=None,
        input_kwargs={"current_model": _FakeModel(), "messages": [], "tools": [], "tool_choice": None},
        next_handler=handler,
    )
    got = [chunk.content[0].text async for chunk in stream]
    assert got == ["你", "好", "，世界"], "流还是要原样透传给执行侧"

    rows = await _rows(rid)
    assert len(rows) == 1
    resp = decode_payload(rows[0].response_blob)
    assert resp["content"][0]["text"] == "你好，世界", (
        "必须累加：只取最后一片的话正文只剩「，世界」"
    )
    assert rows[0].tokens_out == 3, "用量也要按片累加"


@pytest.mark.asyncio
async def test_终片是完整快照_不能重复累加(client):
    """AgentScope 的流 = 增量片(is_last=False) + 完整快照片(is_last=True)。

    终片再 append 一次就会**把正文接两遍** —— 实测踩到过（记录里整段话出现两次，
    而平台自己的输出是单份）。这里把真形状摆出来钉住。
    """
    rid = await _mk_run()
    set_run_ctx(run_id=rid, agent_id="ag_test", depth=0)
    rec = ModelCallRecorder(provider="deepseek", model="deepseek-chat")

    class _Terminal(_FakeResponse):
        """终片：与真实现一致，is_last=True 且内容完整。"""

        is_last = True

    async def handler(**kwargs):
        async def gen():
            for piece in ("你", "好", "，世界"):
                part = _FakeResponse(piece, tokens_out=1)
                part.is_last = False
                yield part
            yield _Terminal("你好，世界", tokens_in=120, tokens_out=3)
        return gen()

    stream = await rec.on_model_call(
        agent=None,
        input_kwargs={"current_model": _FakeModel(), "messages": [], "tools": [], "tool_choice": None},
        next_handler=handler,
    )
    got = [c.content[0].text async for c in stream]
    assert len(got) == 4, "流要原样透传（含终片）"

    resp = decode_payload((await _rows(rid))[0].response_blob)
    text = resp["content"][0]["text"]
    assert text == "你好，世界", f"正文只能有一份，实际={text!r}"
    assert resp["usage"]["input_tokens"] == 120, "用量取终片的（终片带最终 usage）"


@pytest.mark.asyncio
async def test_流被打断也要留下已收到的部分(client):
    """没有终片（连线中断）时，用增量累加留下半截内容 —— 失败现场最需要原件。"""
    rid = await _mk_run()
    set_run_ctx(run_id=rid, agent_id="ag_test", depth=0)
    rec = ModelCallRecorder()

    async def handler(**kwargs):
        async def gen():
            for piece in ("半", "截"):
                part = _FakeResponse(piece)
                part.is_last = False
                yield part
            raise RuntimeError("连接断了")
        return gen()

    stream = await rec.on_model_call(
        agent=None,
        input_kwargs={"current_model": _FakeModel(), "messages": [], "tools": [], "tool_choice": None},
        next_handler=handler,
    )
    with pytest.raises(RuntimeError):
        async for _ in stream:
            pass

    row = (await _rows(rid))[0]
    assert row.status == "error" and "连接断了" in (row.error or "")
    assert decode_payload(row.response_blob)["content"][0]["text"] == "半截"


@pytest.mark.asyncio
async def test_调用失败也要留一条错误记录(client):
    rid = await _mk_run()
    set_run_ctx(run_id=rid, agent_id="ag_test", depth=0)
    rec = ModelCallRecorder(provider="deepseek", model="deepseek-chat")

    async def handler(**kwargs):
        raise RuntimeError("上游 500")

    with pytest.raises(RuntimeError):
        await rec.on_model_call(
            agent=None,
            input_kwargs={"current_model": _FakeModel(), "messages": [], "tools": [], "tool_choice": None},
            next_handler=handler,
        )

    rows = await _rows(rid)
    assert len(rows) == 1 and rows[0].status == "error"
    assert "上游 500" in (rows[0].error or "")
    assert decode_payload(rows[0].request_blob)["model"] == "deepseek-chat"


@pytest.mark.asyncio
async def test_没有执行上下文时静默跳过_不能影响执行(client):
    set_run_ctx()  # 清空
    rec = ModelCallRecorder()

    async def handler(**kwargs):
        return _FakeResponse("ok")

    out = await rec.on_model_call(
        agent=None,
        input_kwargs={"current_model": _FakeModel(), "messages": [], "tools": [], "tool_choice": None},
        next_handler=handler,
    )
    assert out.content[0].text == "ok", "没有上下文也不能抛，执行照常"


@pytest.mark.asyncio
async def test_超大请求会被截断并写明(client):
    rid = await _mk_run()
    set_run_ctx(run_id=rid, agent_id="ag_test", depth=0)
    rec = ModelCallRecorder()

    async def handler(**kwargs):
        return _FakeResponse("ok")

    await rec.on_model_call(
        agent=None,
        input_kwargs={
            "current_model": _FakeModel(),
            "messages": [{"role": "user", "content": "x" * (MAX_SIDE_CHARS + 500)}],
            "tools": [],
            "tool_choice": None,
        },
        next_handler=handler,
    )
    row = (await _rows(rid))[0]
    assert row.payload_truncated == 1
    req = decode_payload(row.request_blob)
    assert req.get("_truncated") is True
    assert req.get("_original_chars", 0) > MAX_SIDE_CHARS
