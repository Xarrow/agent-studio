"""AG-UI 协议入口（``/api/agui``）。

客户端怎么用（与 AG-UI 规范一致）
---------------------------------
    POST /api/agui
    Content-Type: application/json
    {
      "threadId": "任意字符串（同一段对话用同一个）",
      "runId": "本次运行 id（客户端生成）",
      "messages": [{"id": "...", "role": "user", "content": "你好"}],
      "forwardedProps": {"agentId": "ag_xxx"}      ← 本平台扩展：挑用哪个助手
    }

响应是 **SSE**（AG-UI 的默认传输），每帧 ``data: {事件 JSON}``，事件名与字段
严格按 AG-UI 规范（RUN_STARTED / STEP_STARTED / TEXT_MESSAGE_* / TOOL_CALL_* /
THINKING_* / RUN_FINISHED / RUN_ERROR / CUSTOM）。

``GET /api/agui/info`` 用来做发现：协议版本、可用助手（当"model"用）、怎么调。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from ..agui import AGUI_VERSION, agui_stream
from ..db import SessionLocal
from ..models import Agent

router = APIRouter(tags=["agui"])


@router.post("")
async def agui_endpoint(payload: dict[str, Any] = Body(...)) -> StreamingResponse:
    """按 AG-UI 协议跑一次 Agent（SSE 事件流）。"""
    return StreamingResponse(
        agui_stream(payload),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # 反向代理（nginx/cloudflared）不缓冲，否则事件会被攒着一起发
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/info")
async def agui_info() -> dict[str, Any]:
    """发现用：协议版本 + 可用助手 + 调用示例。"""
    async with SessionLocal() as session:
        agents = list(
            (await session.execute(select(Agent).order_by(Agent.created_at.asc()))).scalars()
        )
    return {
        "protocol": "ag-ui",
        "version": AGUI_VERSION,
        "endpoint": "/api/agui",
        "transport": "sse",
        # 每个 Agent 当一个"agent"用；客户端用 forwardedProps.agentId 指定
        "agents": [
            {"id": a.id, "name": a.name, "description": a.description or ""} for a in agents
        ],
        "example": {
            "threadId": "demo-thread",
            "runId": "demo-run-1",
            "messages": [{"id": "m1", "role": "user", "content": "你好"}],
            "forwardedProps": {"agentId": agents[0].id if agents else "ag_xxx"},
        },
        "notes": (
            "同一 threadId 复用同一段平台会话（多轮上下文自动接上）；"
            "forwardedProps.agentId/agent 选助手，不传就用最早的助手；"
            "平台自己的 run id 会通过 CUSTOM(platform_run) 事件带回来，便于在「管理」里对账。"
        ),
    }
