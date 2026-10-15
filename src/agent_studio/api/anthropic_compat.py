"""Anthropic Messages API 兼容出口（``/v1/messages``）。

与 ``openai_compat`` 的关系
--------------------------
两个模块是同一个能力的两种"外壳"：把本平台的 Session/Run/事件流翻译成外部客户端
认识的形状。``openai_compat`` 覆盖 OpenAI 生态（Open WebUI · LobeChat · Cherry
Studio · 各家 SDK），本模块覆盖 Anthropic 生态（Claude Code · Anthropic SDK ·
一切 ``ANTHROPIC_BASE_URL`` 可配的工具）。

因此**执行路径完全复用** openai_compat：同样解析 model → Agent、同样建 Run、
同样订阅统一事件流。这里只负责协议差异：

===========================  ==========================  ==================
概念                        OpenAI 形状                  Anthropic 形状
===========================  ==========================  ==================
请求体末尾的系统提示          messages 里 role=system     顶层 ``system`` 字段
鉴权头                      Authorization: Bearer        ``x-api-key``
必填参数                    无                           ``max_tokens``
流式帧                      ``data: {...}``（无 event）  ``event: X`` + ``data:``
用量字段                    prompt/completion_tokens     input/output_tokens
错误形状                    {"error":{"message":..}}     {"type":"error","error":{..}}
===========================  ==========================  ==================

鉴权
----
沿用 ``STUDIO_API_KEY``（见 openai_compat）：留空 = 不校验（内网现状）；
设了值 = 必须带 ``x-api-key``（Anthropic 客户端）或 ``Authorization: Bearer``。
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any, AsyncIterator

from fastapi import APIRouter, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse, StreamingResponse

from ..config import settings
from ..context import next_turn_index
from ..db import SessionLocal, get_session
from ..models import Agent, Run, now_ms
from ..runner import run_service
from ..schemas import AgentDefinition
from .openai_compat import (
    _resolve_agent,
    _sse,
    _title_from,
    _wait_for_run,
    check_auth,
    resolve_timeout,
)

router = APIRouter(prefix="/v1", tags=["anthropic-compat"])


# --------------------------------------------------------------------------- #
# 协议适配小工具
# --------------------------------------------------------------------------- #
def _check_key(x_api_key: str | None, authorization: str | None) -> None:
    """Anthropic 客户端用 ``x-api-key``，OpenAI 习惯用 Bearer。

    两者都接受——很多工具（如 Claude Code 接自定义 base_url）只发 x-api-key，
    只认 Bearer 会让它们一进来就 401。
    """
    if x_api_key and not authorization:
        check_auth(f"Bearer {x_api_key}")
        return
    check_auth(authorization)


def _blocks_to_text(content: Any) -> str:
    """把 Anthropic 的 content 归一成纯文本。

    content 允许是字符串，也允许是块数组（``[{type:"text",text:".."}]``）。
    非文本块（图片/工具结果）这里只取其中的文本，不丢整体语义。
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for b in content:
            if isinstance(b, dict):
                if b.get("type") == "text" and isinstance(b.get("text"), str):
                    out.append(b["text"])
                elif isinstance(b.get("content"), str):  # tool_result 里也可能带文本
                    out.append(b["content"])
            elif isinstance(b, str):
                out.append(b)
        return "".join(out)
    return ""


def _system_text(system: Any) -> str:
    """``system`` 可以是字符串或块数组（Anthropic 两种都允许）。"""
    return _blocks_to_text(system)


def _last_user_text(messages: list[dict[str, Any]]) -> str:
    for m in reversed(messages):
        if m.get("role") == "user":
            t = _blocks_to_text(m.get("content"))
            if t:
                return t
    return ""


def _err_body(msg: str, kind: str = "api_error") -> dict[str, Any]:
    """Anthropic 的错误形状（与 OpenAI 不同，客户端按 type 字段解析）。"""
    return {"type": "error", "error": {"type": kind, "message": msg}}


def _sse_event(name: str, payload: dict[str, Any]) -> str:
    return f"event: {name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _usage(usage: dict[str, Any]) -> dict[str, int]:
    return {
        "input_tokens": int(usage.get("input_tokens") or 0),
        "output_tokens": int(usage.get("output_tokens") or 0),
    }


# --------------------------------------------------------------------------- #
# /v1/messages
# --------------------------------------------------------------------------- #
@router.post("/messages")
async def messages(
    payload: dict[str, Any],
    request: Request,
    x_api_key: str | None = Header(default=None, alias="x-api-key"),
    authorization: str | None = Header(default=None),
):
    """Anthropic Messages 入口。支持 ``stream: true/false``。

    会话续接与 openai_compat 一致：本地维护 messages（原生方式），
    或传 ``conversation_id``（本平台 Session id，只传本轮新消息）。
    """
    _check_key(x_api_key, authorization)

    model = payload.get("model")
    if not model:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "缺少 model 字段")

    messages_in = payload.get("messages") or []
    if not isinstance(messages_in, list) or not messages_in:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "messages 不能为空")

    # max_tokens 在 Anthropic 协议里是必填。这里不限制本平台（超时由助手配置决定），
    # 但缺了要明确报错——否则客户端以为自己传成功了。
    if payload.get("max_tokens") is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "缺少 max_tokens 字段")

    stream = bool(payload.get("stream"))

    system = _system_text(payload.get("system"))
    user_text = _last_user_text(messages_in)
    if not user_text:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "messages 里没有 user 内容")
    # 系统提示拼在用户输入之前（本平台 Run 的输入是单一文本）
    run_input = f"{system}\n\n{user_text}" if system else user_text

    async with SessionLocal() as session:
        agent = await _resolve_agent(session, str(model))
        defn = AgentDefinition.model_validate(agent.definition)

        conv_id = payload.get("conversation_id") or payload.get("session_id")
        session_id: str | None = None
        if conv_id:
            from ..models import Session as ChatSession

            chat = await session.get(ChatSession, str(conv_id))
            if chat is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, f"conversation_id 不存在: {conv_id}")
            if chat.agent_id != agent.id:
                raise HTTPException(status.HTTP_409_CONFLICT, "conversation_id 属于另一个 Agent")
            session_id = chat.id
        elif defn.limits:
            from ..models import Session as ChatSession, new_id

            session_id = new_id("ses_")
            session.add(
                ChatSession(id=session_id, agent_id=agent.id, title=_title_from(messages_in) or "API 对话")
            )

        turn_index = await next_turn_index(session, session_id) if session_id else None

        run = Run(
            agent_id=agent.id,
            agent_version=agent.version,
            runtime=defn.runtime,
            status="pending",
            input={"text": run_input},
            definition_snapshot=defn.model_dump(mode="json", exclude={"model": {"api_key"}}),
            started_at=now_ms(),
            session_id=session_id,
            turn_index=turn_index,
        )
        session.add(run)
        await session.commit()
        await session.refresh(run)
        run_id = run.id

    # 先订阅再启动（同 openai_compat：否则启动瞬间的事件会在订阅前丢失）
    stream_queue = run_service.bus.subscribe(run_id) if stream else None
    await run_service.start(run_id, defn, run_input)

    msg_id = f"msg_{uuid.uuid4().hex[:24]}"
    model_name = agent.id

    if not stream:
        _t = resolve_timeout(defn.limits.timeout_s, settings.default_timeout_s)
        _wait_s = _t if _t > 0 else 365 * 24 * 3600
        text, usage, err = await _wait_for_run(run_id, timeout_s=_wait_s)
        if err and not text:
            return JSONResponse(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                content=_err_body(err),
            )
        body: dict[str, Any] = {
            "id": msg_id,
            "type": "message",
            "role": "assistant",
            "model": str(model),
            "content": [{"type": "text", "text": text}],
            "stop_reason": "end_turn" if not err else "error",
            "stop_sequence": None,
            "usage": _usage(usage),
        }
        if session_id:
            body["conversation_id"] = session_id
        return body

    async def gen() -> AsyncIterator[str]:
        # Anthropic 的流式帧有固定序列：message_start → content_block_start →
        # 若干 content_block_delta → content_block_stop → message_delta → message_stop
        yield _sse_event(
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": msg_id,
                    "type": "message",
                    "role": "assistant",
                    "model": str(model),
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {"input_tokens": 0, "output_tokens": 0},
                },
            },
        )
        yield _sse_event(
            "content_block_start",
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        )

        queue = stream_queue
        assert queue is not None
        out_tokens = 0
        try:
            while True:
                ev = await asyncio.wait_for(queue.get(), timeout=600)
                if ev is None:
                    break
                etype = getattr(ev, "type", None) or (ev.get("type") if isinstance(ev, dict) else None)
                epayload = getattr(ev, "payload", None) or (ev.get("payload") if isinstance(ev, dict) else {}) or {}
                if etype == "text_delta":
                    piece = epayload.get("text")
                    if not isinstance(piece, str) or not piece:
                        piece = epayload.get("delta")
                    if isinstance(piece, str) and piece:
                        out_tokens += 1
                        yield _sse_event(
                            "content_block_delta",
                            {
                                "type": "content_block_delta",
                                "index": 0,
                                "delta": {"type": "text_delta", "text": piece},
                            },
                        )
                elif etype == "error":
                    m = str(epayload.get("message") or epayload.get("error") or "")
                    if m:
                        yield _sse_event(
                            "content_block_delta",
                            {
                                "type": "content_block_delta",
                                "index": 0,
                                "delta": {"type": "text_delta", "text": f"\n[错误] {m}"},
                            },
                        )
        except asyncio.TimeoutError:
            yield _sse_event(
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": "\n[错误] 等待执行结果超时"},
                },
            )
        finally:
            yield _sse_event("content_block_stop", {"type": "content_block_stop", "index": 0})
            yield _sse_event(
                "message_delta",
                {
                    "type": "message_delta",
                    "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                    "usage": {"output_tokens": out_tokens},
                },
            )
            yield _sse_event("message_stop", {"type": "message_stop"})

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.post("/messages/count_tokens")
async def count_tokens(payload: dict[str, Any]) -> dict[str, Any]:
    """Anthropic 客户端的 token 预估接口。

    我们没有客户端分词器，用字符数近似（Claude 客户端只把它当参考值，
    不参与计费）。返回结构必须对，否则部分客户端会直接报错。
    """
    system = _system_text(payload.get("system"))
    total = len(system)
    for m in payload.get("messages") or []:
        total += len(_blocks_to_text(m.get("content")))
    return {"input_tokens": max(1, total // 3)}
