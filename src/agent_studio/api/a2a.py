"""A2A（Agent2Agent）协议接入 —— 让**别的 agent 框架 / 别的平台**直接调用本平台的助手。

为什么要有它
------------
平台内部的助手协作已经能做（``fanout`` 指名派发 + ``list_agents``/``read_agent``/
``fork_agent`` 三个内核工具），但那是"自家孩子自己认识"。A2A 是行业标准
（Google 提出、现由 Linux Foundation 托管），第三方 agent / CopilotKit / LangGraph /
ADK 之类的实现都按它说话 —— 接上它，本平台的助手就能被外部直接当"远程 agent"用。

对齐的规范（v0.3.0）
--------------------
1. **发现**：``GET /.well-known/agent-card.json``
   （单助手卡片走 ``GET /.well-known/agents/{agent_id}/agent-card.json``）
2. **传输**：JSON-RPC 2.0 over HTTP，``POST /a2a``
   方法：``message/send``、``message/stream``、``tasks/get``、``tasks/cancel``
3. **流式**：SSE，每条是一个 JSON-RPC 响应，``result`` 为
   ``TaskStatusUpdateEvent`` / ``TaskArtifactUpdateEvent``（带 ``final`` 标记）
4. **上下文**：``contextId`` ↔ 本平台 ``session_id``（多轮对话天然可用）

任务生命周期映射（本平台 Run → A2A Task.state）
-----------------------------------------------
``pending → submitted`` / ``running → working`` / ``ok → completed`` /
``error → failed`` / ``aborted → canceled`` / ``waiting_hitl → input-required``

设计原则
--------
**薄适配**：本模块不复制任何执行逻辑，只把 A2A 的请求翻译成本平台既有的
Run 创建 / 中止 / 恢复 / 事件流四件事，再把结果翻译回 A2A 的结构。
零第三方依赖（不引 a2a-sdk，本平台的规矩）。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import SessionLocal, get_session
from ..models import Agent, Run, RunEvent, new_id, now_ms
from ..runner import load_skill_rows, load_tools, run_service
from ..schemas import AgentDefinition

router = APIRouter(tags=["a2a"])

PROTOCOL_VERSION = "0.3.0"

#: 本平台 Run.status → A2A Task.status.state
STATE_MAP: dict[str, str] = {
    "pending": "submitted",
    "running": "working",
    "ok": "completed",
    "error": "failed",
    "aborted": "canceled",
    "waiting_hitl": "input-required",
}

#: A2A 流式事件里的终态（送到就要收流）
FINAL_STATES = {"completed", "failed", "canceled", "input-required"}

#: JSON-RPC 错误码
E_PARSE = -32700
E_INVALID_REQUEST = -32600
E_METHOD_NOT_FOUND = -32601
E_INVALID_PARAMS = -32602
E_TASK_NOT_FOUND = -32001
E_TASK_TERMINAL = -32002


class RpcError(Exception):
    """JSON-RPC 层面的错误 —— 统一转成 ``{"error": {...}}`` 响应。"""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


# --------------------------------------------------------------------------- #
# A2A ← 本平台的翻译
# --------------------------------------------------------------------------- #
def _parts_of(message: dict[str, Any]) -> list[dict[str, Any]]:
    parts = message.get("parts") or []
    return [p for p in parts if isinstance(p, dict)]


def text_of_message(message: dict[str, Any]) -> str:
    """把 A2A Message 里的内容压成一段纯文本（本平台助手吃文本输入）。

    - ``text`` part：原样拼接
    - ``file`` / ``data`` part：转成路径/JSON 提示 —— 助手有 Read 工具时可以直接读
      本地路径；远程 uri 交给它自己判断（拿不到就如实说拿不到，不编造内容）
    """
    lines: list[str] = []
    for p in _parts_of(message):
        kind = p.get("kind")
        if kind == "text":
            t = p.get("text")
            if t:
                lines.append(str(t))
        elif kind == "file":
            f = p.get("file") or {}
            uri = f.get("uri") or f.get("name") or ""
            lines.append(f"（附件：{uri}）" if uri else "（附件）")
        elif kind == "data":
            lines.append("（结构化数据：" + json.dumps(p.get("data"), ensure_ascii=False) + "）")
    return "\n".join(lines).strip()


def _text_out(run: Run) -> str:
    """Run 的产出文本（A2A artifact 用）。"""
    out = run.output if isinstance(run.output, dict) else {}
    for key in ("text", "answer", "content", "summary"):
        v = out.get(key)
        if isinstance(v, str) and v.strip():
            return v
    return ""


def task_of(run: Run, agent_name: str | None = None) -> dict[str, Any]:
    """本平台 Run → A2A Task 对象。"""
    state = STATE_MAP.get(run.status, "unknown")
    task: dict[str, Any] = {
        "id": run.id,
        "contextId": run.session_id or run.id,
        "status": {
            "state": state,
            "timestamp": str(run.ended_at or run.started_at or now_ms()),
        },
    }
    if agent_name:
        task["metadata"] = {"agentName": agent_name, "agentId": run.agent_id}
    if run.status == "waiting_hitl" and run.pending_hitl:
        # input-required：把"要人确认什么"当一条 agent 消息带出去，外部才能答
        text = json.dumps(run.pending_hitl, ensure_ascii=False)
        task["status"]["message"] = {
            "role": "agent",
            "parts": [{"kind": "text", "text": text}],
            "messageId": new_id("msg_"),
            "taskId": run.id,
            "contextId": task["contextId"],
        }
    text = _text_out(run)
    if text:
        task["artifacts"] = [
            {
                "artifactId": f"{run.id}-out",
                "name": "回答",
                "parts": [{"kind": "text", "text": text}],
            }
        ]
    if run.error:
        task["metadata"] = {**(task.get("metadata") or {}), "error": run.error}
    return task


# --------------------------------------------------------------------------- #
# 助手卡片（发现）
# --------------------------------------------------------------------------- #
async def _agent_for_card(session: AsyncSession, agent_id: str | None) -> Agent | None:
    if agent_id:
        return await session.get(Agent, agent_id)
    # 没指定就用「通用助手」（平台默认干活的那个），退回最近更新的一个
    row = (
        await session.execute(select(Agent).where(Agent.name == "通用助手").limit(1))
    ).scalars().first()
    if row is not None:
        return row
    return (await session.execute(select(Agent).order_by(Agent.updated_at.desc()).limit(1))).scalars().first()


async def _card(session: AsyncSession, agent: Agent, base: str) -> dict[str, Any]:
    tools = await load_tools(session, agent.id)
    skills = await load_skill_rows(session, agent.id)
    capabilities = [
        {
            "id": f"tool:{t.name}",
            "name": t.name,
            "description": t.description or "",
            "tags": ["tool", getattr(t, "kind", "") or "native"],
        }
        for t in tools
    ]
    capabilities += [
        {
            "id": f"skill:{s.id}",
            "name": s.name,
            "description": (s.description or "")[:300],
            "tags": ["skill"],
        }
        for s in skills
    ]
    if not capabilities:
        capabilities = [
            {"id": "chat", "name": "对话", "description": "纯文本问答", "tags": ["chat"]}
        ]
    definition = agent.definition if isinstance(agent.definition, dict) else {}
    desc = definition.get("description") or definition.get("persona") or f"{agent.name}（agent-studio 助手）"
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "name": agent.name,
        "description": str(desc)[:500],
        "url": f"{base}/a2a",
        "preferredTransport": "JSONRPC",
        "additionalInterfaces": [{"url": f"{base}/a2a", "transport": "JSONRPC"}],
        "version": str(agent.version),
        "provider": {"organization": "agent-studio", "url": base},
        "capabilities": {
            "streaming": True,
            "pushNotifications": False,
            "stateTransitionHistory": True,
        },
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "skills": capabilities,
        "metadata": {
            "agentId": agent.id,
            "runtime": definition.get("runtime"),
            "model": (definition.get("model") or {}).get("name"),
            "taskEndpoint": f"{base}/a2a",
            "taskMethods": ["message/send", "message/stream", "tasks/get", "tasks/cancel"],
        },
    }


def _base_url(request: Request) -> str:
    return str(request.base_url).rstrip("/")


@router.get("/.well-known/agent-card.json")
async def platform_agent_card(
    request: Request,
    agent: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> JSONResponse:
    """平台级助手卡片（默认助手）。``?agent=<agent_id>`` 可指定某一个。"""
    row = await _agent_for_card(session, agent)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "平台里还没有任何助手")
    return JSONResponse(await _card(session, row, _base_url(request)))


@router.get("/.well-known/agents/{agent_id}/agent-card.json")
async def named_agent_card(
    agent_id: str, request: Request, session: AsyncSession = Depends(get_session)
) -> JSONResponse:
    """按 id 取某一个助手的卡片（多助手平台的发现入口）。"""
    row = await session.get(Agent, agent_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"助手不存在: {agent_id}")
    return JSONResponse(await _card(session, row, _base_url(request)))


# --------------------------------------------------------------------------- #
# 任务：建 / 查 / 停 / 流
# --------------------------------------------------------------------------- #
async def _pick_agent(session: AsyncSession, params: dict[str, Any], meta: dict[str, Any]) -> Agent:
    agent_id = params.get("agentId") or meta.get("agentId")
    if agent_id:
        row = await session.get(Agent, agent_id)
        if row is None:
            raise RpcError(E_INVALID_PARAMS, f"助手不存在: {agent_id}")
        return row
    row = await _agent_for_card(session, None)
    if row is None:
        raise RpcError(E_INVALID_PARAMS, "平台里还没有任何助手")
    return row


async def _create_task(
    session: AsyncSession, params: dict[str, Any], message: dict[str, Any]
) -> tuple[Run, str]:
    """按 A2A 的一次 message/send 建一条 Run（= 一个 Task）。"""
    from ..models import Session as ChatSession

    text = text_of_message(message)
    if not text:
        raise RpcError(E_INVALID_PARAMS, "message.parts 里没有可用的文本内容")

    agent = await _pick_agent(session, params, message.get("metadata") or {})
    definition = AgentDefinition.model_validate(agent.definition)

    # contextId → 复用本平台会话（多轮）；不存在/不属于该助手就新建一个
    context_id = params.get("contextId") or message.get("contextId")
    chat: ChatSession | None = None
    if context_id:
        chat = await session.get(ChatSession, context_id)
        if chat is not None and chat.agent_id != agent.id:
            raise RpcError(
                E_INVALID_PARAMS, "contextId 属于另一个助手，请为它单独开一个上下文"
            )
    if chat is None:
        chat = ChatSession(
            id=new_id("ses_"),
            agent_id=agent.id,
            title=text[:200],
            status="active",
            created_at=now_ms(),
            last_active_at=now_ms(),
        )
        session.add(chat)
        await session.flush()

    from ..context import next_turn_index

    run = Run(
        agent_id=agent.id,
        agent_version=agent.version,
        runtime=definition.runtime,
        status="pending",
        input={"text": text},
        definition_snapshot=definition.model_dump(mode="json", exclude={"model": {"api_key"}}),
        started_at=now_ms(),
        session_id=chat.id,
        turn_index=await next_turn_index(session, chat.id),
        origin="chat",
    )
    session.add(run)
    await session.commit()
    await session.refresh(run)
    await run_service.start(run.id, definition, text)
    return run, agent.name


async def _get_run(session: AsyncSession, task_id: str) -> Run:
    run = await session.get(Run, task_id)
    if run is None:
        raise RpcError(E_TASK_NOT_FOUND, f"Task 不存在: {task_id}")
    return run


async def _resume_task(session: AsyncSession, run: Run, message: dict[str, Any]) -> None:
    """input-required 的答复：文本里肯定/否定 → HITL 回复。"""
    from ..runtimes.base import HitlResponse

    text = text_of_message(message)
    lowered = text.strip().lower()
    confirm = not any(
        k in lowered for k in ("拒绝", "不同意", "no", "cancel", "reject", "停止")
    )
    ok = await run_service.resume(run.id, HitlResponse(confirm=confirm, reason=text or None))
    if not ok:
        raise RpcError(E_TASK_TERMINAL, "这条任务已经不在等待确认的状态了")


def _event_to_a2a(ev: dict[str, Any], run: Run, req_id: Any) -> dict[str, Any] | None:
    """本平台 UnifiedEvent → A2A 流式事件（None = 这一条不往外发）。"""
    etype = ev.get("type")
    payload = ev.get("payload") or {}
    ctx = run.session_id or run.id
    base = {"jsonrpc": "2.0", "id": req_id}

    def status(state: str, final: bool, text: str | None = None) -> dict[str, Any]:
        st: dict[str, Any] = {"state": state, "timestamp": str(now_ms())}
        if text:
            st["message"] = {
                "role": "agent",
                "parts": [{"kind": "text", "text": text}],
                "messageId": new_id("msg_"),
                "taskId": run.id,
                "contextId": ctx,
            }
        return {
            **base,
            "result": {
                "kind": "status-update",
                "taskId": run.id,
                "contextId": ctx,
                "status": st,
                "final": final,
            },
        }

    if etype == "run_start":
        return status("working", False)
    if etype == "text_delta":
        chunk = payload.get("text") or payload.get("delta") or ""
        if not chunk:
            return None
        return {
            **base,
            "result": {
                "kind": "artifact-update",
                "taskId": run.id,
                "contextId": ctx,
                "artifact": {
                    "artifactId": f"{run.id}-out",
                    "name": "回答",
                    "parts": [{"kind": "text", "text": chunk}],
                },
                "append": True,
                "lastChunk": False,
                "final": False,
            },
        }
    if etype == "tool_exec_start":
        return status("working", False, f"调用工具 {payload.get('name') or payload.get('tool') or ''}")
    if etype == "hitl_request":
        return status("input-required", True, json.dumps(payload, ensure_ascii=False))
    if etype == "error":
        return status("failed", True, str(payload.get("message") or "执行失败"))
    if etype == "run_end":
        return status("completed", True)
    return None


async def _stream_task(run_id: str, req_id: Any) -> StreamingResponse:
    """message/stream：把 Run 的事件流翻译成 A2A 的 SSE。"""

    async def gen():
        queue = run_service.bus.subscribe(run_id)
        last_seq = -1
        try:
            async with SessionLocal() as session:
                run = await session.get(Run, run_id)
                rows = (
                    await session.execute(
                        select(RunEvent)
                        .where(RunEvent.run_id == run_id)
                        .order_by(RunEvent.seq)
                    )
                ).scalars().all()
            if run is None:
                yield f"data: {json.dumps({'jsonrpc': '2.0', 'id': req_id, 'error': {'code': E_TASK_NOT_FOUND, 'message': 'Task 不存在'}}, ensure_ascii=False)}\n\n"
                return
            for row in rows:
                last_seq = row.seq
                out = _event_to_a2a(
                    {"type": row.type, "payload": row.payload or {}}, run, req_id
                )
                if out is not None:
                    yield f"data: {json.dumps(out, ensure_ascii=False)}\n\n"
                    if out["result"].get("final"):
                        yield "event: done\ndata: {}\n\n"
                        return
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
                out = _event_to_a2a(item, run, req_id)
                if out is None:
                    continue
                yield f"data: {json.dumps(out, ensure_ascii=False)}\n\n"
                if out["result"].get("final"):
                    break
            yield "event: done\ndata: {}\n\n"
        finally:
            run_service.bus.unsubscribe(run_id, queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --------------------------------------------------------------------------- #
# JSON-RPC 2.0 入口
# --------------------------------------------------------------------------- #
@router.post("/a2a")
async def jsonrpc(
    request: Request, session: AsyncSession = Depends(get_session)
) -> Any:
    """A2A 的任务入口。方法：message/send、message/stream、tasks/get、tasks/cancel。

    错误一律按 JSON-RPC 2.0 的 ``error`` 对象回（HTTP 状态仍是 200 —— 规范要求
    协议层错误走 body，而不是 HTTP 码，否则客户端会把"任务不存在"当成网络故障）。
    """
    req_id: Any = None
    try:
        return await _dispatch(request, session)
    except RpcError as err:
        try:
            body = getattr(request, "_a2a_body", None) or {}
            req_id = body.get("id")
        except Exception:  # noqa: BLE001
            req_id = None
        return JSONResponse(
            {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": err.code, "message": err.message},
            }
        )


async def _dispatch(request: Request, session: AsyncSession) -> Any:
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise RpcError(E_PARSE, f"请求体不是合法 JSON: {exc}") from exc
    request._a2a_body = body  # noqa: SLF001  （错误响应要带回请求 id）

    req_id = body.get("id")
    method = body.get("method")
    params = body.get("params") or {}
    if not isinstance(params, dict):
        raise RpcError(E_INVALID_PARAMS, "params 必须是对象")

    if method == "message/send":
        message = params.get("message") or {}
        task_id = params.get("taskId") or params.get("id") or message.get("taskId")
        if task_id:
            run = await _get_run(session, str(task_id))
            if run.status != "waiting_hitl":
                raise RpcError(
                    E_TASK_TERMINAL,
                    f"Task 当前状态是 {run.status}，不能再追加消息（只有 waiting_hitl 可答）",
                )
            await _resume_task(session, run, message)
            await session.refresh(run)
            agent = await session.get(Agent, run.agent_id)
            return {"jsonrpc": "2.0", "id": req_id, "result": task_of(run, agent.name if agent else None)}
        run, agent_name = await _create_task(session, params, message)
        return {"jsonrpc": "2.0", "id": req_id, "result": task_of(run, agent_name)}

    if method == "message/stream":
        message = params.get("message") or {}
        task_id = params.get("taskId") or message.get("taskId")
        if task_id:
            run = await _get_run(session, str(task_id))
        else:
            run, _ = await _create_task(session, params, message)
        return await _stream_task(run.id, req_id)

    if method == "tasks/get":
        task_id = params.get("id") or params.get("taskId")
        if not task_id:
            raise RpcError(E_INVALID_PARAMS, "缺少 id")
        run = await _get_run(session, str(task_id))
        agent = await session.get(Agent, run.agent_id)
        return {"jsonrpc": "2.0", "id": req_id, "result": task_of(run, agent.name if agent else None)}

    if method == "tasks/cancel":
        task_id = params.get("id") or params.get("taskId")
        if not task_id:
            raise RpcError(E_INVALID_PARAMS, "缺少 id")
        run = await _get_run(session, str(task_id))
        ok = await run_service.abort(run.id)
        if not ok and run.status in ("pending", "waiting_hitl"):
            # 挂起中的任务（等人工确认）不在执行循环里，abort 抓不到它 ——
            # 但外部调 tasks/cancel 的意图很明确：不要了。直接落终态。
            run.status = "aborted"
            run.ended_at = now_ms()
            run.pending_hitl = None
            await session.commit()
        await session.refresh(run)
        agent = await session.get(Agent, run.agent_id)
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            # canceled 以**落库后的真实状态**为准：abort 的返回值只说明"执行循环里
            # 有没有抓到它"，挂起中的任务是靠上面那条兜底落终态的
            "result": {
                "canceled": run.status == "aborted",
                "task": task_of(run, agent.name if agent else None),
            },
        }

    raise RpcError(E_METHOD_NOT_FOUND, f"不支持的方法: {method}")
