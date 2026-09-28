"""「LLM 配置」里那次对话测试也要留**完整请求与原始响应**。

为什么单独守这条：助手执行的原文走模型调用中间件（``llm_call`` 表），
而对话测试是**裸模型调用**（不经助手）—— 它以前只存了对话文本
（``messages``/``reply``）。用户换了 key/端点后想回看"上次究竟把什么参数
发给了对方、对方原样回了什么"，没有证据可查。

守住三件：
① 落库的原文能解回来，且请求里有 messages/model 这些关键字段；
② 失败调用也留证（状态码 + 响应体）—— 失败现场最需要原件；
③ 没原文的老记录要**如实标记**（``has_payload`` 为假），界面上不能给个
   点开必然空的入口。
"""

from __future__ import annotations

import json
import zlib

import pytest
from sqlalchemy import select

from agent_studio.db import SessionLocal
from agent_studio.models import ModelTest, Secret, new_id, now_ms

pytestmark = pytest.mark.asyncio


async def _mk_credential() -> Secret:
    async with SessionLocal() as s:
        row = Secret(
            id=new_id("cred"),
            name="原文护栏",
            provider="deepseek",
            ciphertext=b"x",
            base_url="https://api.deepseek.com",
            default_model="deepseek-chat",
            created_at=now_ms(),
        )
        s.add(row)
        await s.commit()
        return row


def _decode(blob: bytes | None):
    assert blob is not None
    return json.loads(zlib.decompress(blob).decode("utf-8"))


async def test_对话测试会把完整请求与原始响应一起落库(client):
    from agent_studio.api.credentials import _record_model_test

    cred = await _mk_credential()
    request = {
        "model": "deepseek-chat",
        "messages": [{"role": "user", "content": "你好"}],
        "stream": False,
    }
    response = {
        "id": "chatcmpl-1",
        "choices": [{"message": {"role": "assistant", "content": "你好呀"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 8, "completion_tokens": 5},
    }
    async with SessionLocal() as s:
        await _record_model_test(
            s, cred, model="deepseek-chat", base_url="https://api.deepseek.com",
            messages=request["messages"], reply="你好呀", status="ok", error=None,
            latency_ms=123, usage=response["usage"], request=request, response=response,
        )

    async with SessionLocal() as s:
        row = (
            await s.execute(select(ModelTest).where(ModelTest.credential_id == cred.id))
        ).scalars().first()
    assert row is not None
    assert _decode(row.request_blob)["messages"][0]["content"] == "你好"
    assert _decode(row.response_blob)["choices"][0]["message"]["content"] == "你好呀"
    assert _decode(row.response_blob)["usage"]["prompt_tokens"] == 8
    assert row.payload_truncated == 0


async def test_失败的对话测试也要留证(client):
    from agent_studio.api.credentials import _record_model_test

    cred = await _mk_credential()
    request = {"model": "m", "messages": [{"role": "user", "content": "hi"}], "stream": False}
    response = {"status": 401, "headers": {"content-type": "application/json"},
                "body": {"error": {"message": "invalid api key"}}}
    async with SessionLocal() as s:
        await _record_model_test(
            s, cred, model="m", base_url="https://x", messages=request["messages"],
            reply=None, status="error", error="HTTP 401：invalid api key",
            latency_ms=50, usage=None, request=request, response=response,
        )

    async with SessionLocal() as s:
        row = (
            await s.execute(select(ModelTest).where(ModelTest.credential_id == cred.id))
        ).scalars().first()
    assert row is not None and row.status == "error"
    assert _decode(row.response_blob)["status"] == 401
    assert "invalid api key" in json.dumps(_decode(row.response_blob), ensure_ascii=False)


async def test_原文接口能读回_老记录如实标记无原文(client):
    """列表项 ``has_payload`` 为真才给"看原文"入口；老记录点了要知道"为什么没有"。"""
    cred = await _mk_credential()
    with_blob = new_id("mt_")
    legacy = new_id("mt_")
    async with SessionLocal() as s:
        blob, _ = __import__("agent_studio.runner", fromlist=["compress_payload"]).compress_payload(
            {"model": "m", "messages": [{"role": "user", "content": "q"}]}
        )
        resp_blob, _ = __import__("agent_studio.runner", fromlist=["compress_payload"]).compress_payload(
            {"choices": [{"message": {"content": "a"}}]}
        )
        s.add_all([
            ModelTest(
                id=with_blob, credential_id=cred.id, credential_name="原文护栏",
                provider="deepseek", model="m", messages=[{"role": "user", "content": "q"}],
                reply="a", status="ok", started_at=now_ms(), duration_ms=10,
                tokens_in=1, tokens_out=1, request_blob=blob, response_blob=resp_blob,
            ),
            ModelTest(
                id=legacy, credential_id=cred.id, credential_name="原文护栏",
                provider="deepseek", model="m", messages=[{"role": "user", "content": "q"}],
                reply="a", status="ok", started_at=now_ms(), duration_ms=10,
            ),
        ])
        await s.commit()

    got = await client.get(f"/api/runs/model-tests/{with_blob}/payload")
    assert got.status_code == 200, got.text
    body = got.json()
    assert body["request"]["messages"][0]["content"] == "q"
    assert body["response"]["choices"][0]["message"]["content"] == "a"
    assert body["truncated"] is False

    # 老记录：接口本身不报错，但没有原文 → 前端据此给"为什么没有"的说明
    old = await client.get(f"/api/runs/model-tests/{legacy}/payload")
    assert old.status_code == 200
    assert old.json()["request"] is None and old.json()["response"] is None

    timeline = await client.get("/api/runs/timeline", params={"kind": "llm_test"})
    assert timeline.status_code == 200
    items = {it["id"]: it for it in timeline.json()["items"] if it["kind"] == "llm_test"}
    assert items[with_blob]["has_payload"] is True
    assert items[legacy]["has_payload"] is False
