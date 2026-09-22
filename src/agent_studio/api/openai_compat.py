"""OpenAI 兼容 API（``/v1/*``）—— 让任何 OpenAI 客户端直接使用这些 Agent。

为什么选"OpenAI 兼容"而不是 A2A / AG-UI
----------------------------------------
2026-09 调研了对标项目后的判断：**最高杠杆的"标准化"不是实现新协议，而是蹭
已有生态**。一旦暴露 OpenAI 兼容接口，下面这些客户端/工具**零改动**即可接入：

  Open WebUI · LobeChat · Cherry Studio · NextChat · ChatBox · 各种语言 SDK
  （以及 curl / 脚本 / 任何 ``base_url`` 可配的东西）

代价只是把我们的 Session/Run/事件流**翻译**成 OpenAI 的请求响应形状。

映射关系
--------
=================  ==============================
OpenAI 概念         本平台
=================  ==============================
model              Agent（每个 Agent 当作一个 model）
messages[]         会话历史（可用 conversation_id 续接）
choices[].delta    统一事件流里的 text_delta
=================  ==============================

鉴权
----
``STUDIO_API_KEY`` 留空 = 不校验（保持内网无认证的现状）；
设了值 = 必须带 ``Authorization: Bearer <key>``。
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any, AsyncIterator

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..context import next_turn_index
from ..db import SessionLocal, get_session
from ..models import Agent, Run, now_ms
from ..runner import run_service
from ..schemas import AgentDefinition

router = APIRouter(prefix="/v1", tags=["openai-compat"])


# --------------------------------------------------------------------------- #
# 鉴权
# --------------------------------------------------------------------------- #
def check_auth(authorization: str | None) -> None:
    """校验 Bearer token。未配置 ``STUDIO_API_KEY`` 时放行（内网现状）。"""
    expected = (settings.api_key or "").strip()
    if not expected:
        return
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "缺少 Authorization: Bearer <key>",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if authorization[7:].strip() != expected:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "API key 无效",
            headers={"WWW-Authenticate": "Bearer"},
        )


# --------------------------------------------------------------------------- #
# /v1/models
# --------------------------------------------------------------------------- #
@router.get("/models")
async def list_models(
    authorization: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """把每个 Agent 作为一个 model 暴露出去。"""
    check_auth(authorization)
    agents = list((await session.execute(select(Agent).order_by(Agent.name))).scalars().all())
    return {
        "object": "list",
        "data": [
            {
                "id": a.id,
                "object": "model",
                "created": int((a.created_at or 0) / 1000),
                "owned_by": "agent-studio",
                "permission": [],
                # 非标准字段：客户端可以忽略，我们的 UI/脚本用得上
                "name": a.name,
                "description": a.description,
            }
            for a in agents
        ],
    }


@router.get("/models/{model_id}")
async def get_model(
    model_id: str,
    authorization: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    check_auth(authorization)
    agent = await _resolve_agent(session, model_id)
    defn = AgentDefinition.model_validate(agent.definition)
    caps: dict[str, Any] = {}
    try:
        from ..runtimes import get_runtime

        c = get_runtime(defn.runtime).capabilities()
        caps = {
            "supports_multi_turn": c.supports_multi_turn,
            "supports_memory": c.supports_memory,
            "supports_hitl": c.supports_hitl,
        }
    except Exception:  # pragma: no cover - 运行时未注册时忽略
        pass
    return {
        "id": agent.id,
        "object": "model",
        "created": int((agent.created_at or 0) / 1000),
        "owned_by": "agent-studio",
        "name": agent.name,
        "description": agent.description,
        "runtime": defn.runtime,
        "model": defn.model.name,
        "tools": [t.ref for t in defn.tools if t.enabled],
        "capabilities": caps,
    }


async def _resolve_agent(session: AsyncSession, model: str) -> Agent:
    """model 参数既接受 agent_id，也接受 Agent 名字（客户端不方便记 id）。"""
    agent = await session.get(Agent, model)
    if agent is None:
        agent = (
            await session.execute(select(Agent).where(Agent.name == model).limit(1))
        ).scalar_one_or_none()
    if agent is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"model 不存在: {model}（可用 GET /v1/models 查看）",
        )
    return agent


# --------------------------------------------------------------------------- #
# /v1/chat/completions
# --------------------------------------------------------------------------- #
@router.post("/chat/completions")
async def chat_completions(
    payload: dict[str, Any],
    request: Request,
    authorization: str | None = Header(default=None),
):
    """对话补全。支持 ``stream: true/false``。

    会话续接两种方式（都支持，客户端按习惯选）：
      1. 本地维护 messages（OpenAI 原生方式）—— 把历史都传进来
      2. 传 ``conversation_id``（= 本平台 Session id）—— 只传本轮新消息
    """
    check_auth(authorization)

    model = payload.get("model")
    if not model:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "缺少 model 字段")

    messages = payload.get("messages") or []
    if not isinstance(messages, list) or not messages:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "messages 不能为空")

    stream = bool(payload.get("stream"))

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
                raise HTTPException(
                    status.HTTP_409_CONFLICT, "conversation_id 属于另一个 Agent"
                )
            session_id = chat.id
        elif defn.limits and payload.get("store", True):
            # 没有 conversation_id 但允许多轮 → 建一个新会话，响应里回传 id
            from ..models import Session as ChatSession, new_id

            session_id = new_id("ses_")
            session.add(ChatSession(id=session_id, agent_id=agent.id, title=_title_from(messages)))

        # 取最后一条 user 消息作为本轮输入
        user_text = _last_user_text(messages)
        if not user_text:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "messages 里没有 user 内容")

        turn_index = await next_turn_index(session, session_id) if session_id else None

        run = Run(
            agent_id=agent.id,
            agent_version=agent.version,
            runtime=defn.runtime,
            status="pending",
            input={"text": user_text},
            definition_snapshot=defn.model_dump(mode="json", exclude={"model": {"api_key"}}),
            started_at=now_ms(),
            session_id=session_id,
            turn_index=turn_index,
        )
        session.add(run)
        await session.commit()
        await session.refresh(run)
        run_id = run.id

    # 流式：**先订阅、再启动** —— 否则 run 启动后立刻推的事件会在订阅前丢失
    # （表现：SSE 只收到 role 帧和 DONE，没有任何 delta）
    stream_queue = run_service.bus.subscribe(run_id) if stream else None
    await run_service.start(run_id, defn, user_text)

    completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())
    model_name = agent.id

    if not stream:
        text, usage, err = await _wait_for_run(run_id, timeout_s=defn.limits.timeout_s or 300)
        if err and not text:
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, err)
        return _completion_body(completion_id, created, model_name, text, usage, session_id, err)

    async def gen() -> AsyncIterator[str]:
        # 首帧：声明角色（OpenAI 客户端普遍期待）
        yield _sse(
            {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model_name,
                "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
            }
        )
        # 复用启动前就订阅好的队列（见上面的竞态说明）
        queue = stream_queue
        if queue is None:  # pragma: no cover - gen() 只在 stream=True 时构造
            yield _sse({"error": "内部错误：流式队列未初始化"})
            return
        last_seq = -1
        try:
            # 回放已产生的事件（断线/竞态时防止丢字）
            async with SessionLocal() as s2:
                from ..models import RunEvent

                rows = (
                    await s2.execute(
                        select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq)
                    )
                ).scalars().all()
                for row in rows:
                    last_seq = row.seq
                    chunk = _delta_chunk(completion_id, created, model_name, row.type, row.payload)
                    if chunk:
                        yield _sse(chunk)

            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=30)
                except TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                if item is None:
                    break
                if item.get("seq", 0) <= last_seq:
                    continue
                last_seq = item["seq"]
                chunk = _delta_chunk(completion_id, created, model_name, item.get("type"), item.get("payload") or {})
                if chunk:
                    yield _sse(chunk)
        finally:
            run_service.bus.unsubscribe(run_id, queue)

        # 结束帧（带 finish_reason 与 usage）
        text, usage, err = await _wait_for_run(run_id, timeout_s=5)
        final: dict[str, Any] = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model_name,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop" if not err else "error"}],
        }
        if usage:
            final["usage"] = _usage_obj(usage)
        if session_id:
            final["conversation_id"] = session_id
        yield _sse(final)
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --------------------------------------------------------------------------- #
# 辅助
# --------------------------------------------------------------------------- #
def _last_user_text(messages: list[dict[str, Any]]) -> str:
    for m in reversed(messages):
        if m.get("role") != "user":
            continue
        c = m.get("content")
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            # OpenAI 多模态格式：[{type: "text", text: "..."}]
            parts = [b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text"]
            return "".join(parts)
    return ""


def _title_from(messages: list[dict[str, Any]]) -> str:
    return _last_user_text(messages)[:40] or "API 对话"


async def _wait_for_run(run_id: str, timeout_s: int = 300) -> tuple[str, dict[str, Any], str | None]:
    """轮询到 Run 终态，返回 (文本, usage, 错误)。"""
    deadline = time.monotonic() + max(1, timeout_s)
    while time.monotonic() < deadline:
        async with SessionLocal() as s:
            run = await s.get(Run, run_id)
            if run is None:
                return "", {}, "Run 不存在"
            if run.status in ("ok", "error", "aborted"):
                text = str(((run.output or {}).get("content")) or "").strip()
                return text, dict(run.usage or {}), run.error
        await asyncio.sleep(0.25)
    return "", {}, "等待执行结果超时"


def _delta_chunk(
    cid: str, created: int, model: str, ev_type: str | None, payload: dict[str, Any]
) -> dict[str, Any] | None:
    """把统一事件翻译成 OpenAI 的 delta chunk。只转发文本增量与错误。

    注意字段名：统一事件里文本增量的键是 ``delta``（不是 ``text``）——
    AgentScope 的 TextBlock 增量落在 ``delta`` 上。两个都试，避免因
    事件来源不同而静默丢弃全部内容。
    """
    if ev_type == "text_delta":
        text = payload.get("text")
        if not isinstance(text, str) or not text:
            text = payload.get("delta")
        if isinstance(text, str) and text:
            return {
                "id": cid,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
            }
    elif ev_type == "error":
        msg = str(payload.get("message") or payload.get("error") or "")
        if msg:
            return {
                "id": cid,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": {"content": f"\n[错误] {msg}"}, "finish_reason": None}],
            }
    return None


def _usage_obj(usage: dict[str, Any]) -> dict[str, Any]:
    return {
        "prompt_tokens": int(usage.get("input_tokens") or 0),
        "completion_tokens": int(usage.get("output_tokens") or 0),
        "total_tokens": int(usage.get("total_tokens") or 0),
    }


def _completion_body(
    cid: str,
    created: int,
    model: str,
    text: str,
    usage: dict[str, Any],
    conversation_id: str | None,
    err: str | None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "id": cid,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop" if not err else "error",
            }
        ],
        "usage": _usage_obj(usage),
    }
    if conversation_id:
        body["conversation_id"] = conversation_id
    if err:
        body["error"] = err
    return body


def _sse(obj: dict[str, Any]) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"
