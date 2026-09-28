"""AG-UI 协议出口 —— 把平台的执行流翻译成 AG-UI 事件流，让任何 AG-UI 客户端直接驱动这些 Agent。

为什么要做这一层
----------------
平台自己那套 SSE（``/api/runs/stream/{run_id}``）发的是**无状态的增量事件**：
``{seq, type, payload}``，type 是 13 类统一事件（``text_delta`` / ``tool_call_args`` …）。
它够我们自己用，但**不是 AG-UI 协议** —— AG-UI 是"有开有闭"的事件流
（``TEXT_MESSAGE_START`` → ``TEXT_MESSAGE_CONTENT``* → ``TEXT_MESSAGE_END``），
字段名、事件名、必填项都有明确规定（见 ``@ag-ui/core`` 的 zod schema）。

所以这一层的唯一职责就是**补齐开闭与字段**，把增量喂成规范事件：

    run_start        → RUN_STARTED（+ 一条 CUSTOM 带上平台 run_id，便于对账）
    llm_call_start   → STEP_STARTED（一步 = 一次模型调用）
    thinking_delta   → THINKING_START / THINKING_TEXT_MESSAGE_START / …CONTENT
    text_delta       → TEXT_MESSAGE_START / …CONTENT（收尾时 TEXT_MESSAGE_END）
    tool_call_start  → TOOL_CALL_START
    tool_call_args   → TOOL_CALL_ARGS
    tool_exec_start  → TOOL_CALL_END（参数到齐了，AG-UI 在这里结束 tool call）
    tool_exec_end    → TOOL_CALL_RESULT（工具结果作为 tool 消息回给客户端）
    hitl_request     → CUSTOM(hitl_request) + 结束时 RUN_FINISHED{outcome: interrupt}
    error            → RUN_ERROR
    run_end          → 关闭未闭合的块 + RUN_FINISHED（带 usage）

多轮与线程
----------
AG-UI 的 ``threadId`` 是"一段对话"。平台的多轮靠 ``Session``，所以这里把
``threadId + agent`` 确定性哈希成平台会话 id —— 同一个 thread 反复调用会**落在同一个
会话里**（多轮上下文自然接上），不需要客户端存任何平台 id。

刻意不做的事
------------
· 不引任何第三方库（AG-UI 的 schema 只当规范对照，运行时零依赖）；
· 不把客户端带来的全部 messages 灌进平台会话：平台自己有会话历史，重复灌会
  让同一句话在上下文里出现两次。只取**最后一条 user 消息**作为这一轮的输入。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from typing import Any, AsyncIterator

from sqlalchemy import select

from .db import SessionLocal
from .models import Agent, Run, Session as ChatSession, new_id, now_ms
from .schemas import AgentDefinition

logger = logging.getLogger(__name__)

#: 对齐的 AG-UI 规范版本（本地 @ag-ui/core 那份的版本号，便于客户端核对）
AGUI_VERSION = "0.0.59"

#: 事件类型（AG-UI 规范里的名字，一个都不能改）
T_RUN_STARTED = "RUN_STARTED"
T_RUN_FINISHED = "RUN_FINISHED"
T_RUN_ERROR = "RUN_ERROR"
T_STEP_STARTED = "STEP_STARTED"
T_STEP_FINISHED = "STEP_FINISHED"
T_TEXT_START = "TEXT_MESSAGE_START"
T_TEXT_CONTENT = "TEXT_MESSAGE_CONTENT"
T_TEXT_END = "TEXT_MESSAGE_END"
T_THINK_START = "THINKING_START"
T_THINK_END = "THINKING_END"
T_THINK_MSG_START = "THINKING_TEXT_MESSAGE_START"
T_THINK_MSG_CONTENT = "THINKING_TEXT_MESSAGE_CONTENT"
T_THINK_MSG_END = "THINKING_TEXT_MESSAGE_END"
T_TOOL_START = "TOOL_CALL_START"
T_TOOL_ARGS = "TOOL_CALL_ARGS"
T_TOOL_END = "TOOL_CALL_END"
T_TOOL_RESULT = "TOOL_CALL_RESULT"
T_CUSTOM = "CUSTOM"

#: 平台 run 状态 → 是否已经跑完（可以收尾了）
TERMINAL = ("ok", "error", "aborted")


def session_id_for(thread_id: str, agent_id: str) -> str:
    """把 AG-UI 的 threadId 稳定映射成平台会话 id（同一个 thread 每次都落同一个会话）。

    带 agent_id 一起哈希：同一个 thread 换了助手时，平台那边是一条**新会话**
    （平台的规矩是"会话不能跨助手共享上下文"，硬接会上错上下文）。
    """
    raw = f"{thread_id}|{agent_id}".encode("utf-8")
    return "ses_" + hashlib.sha1(raw).hexdigest()[:24]


def last_user_text(messages: Any) -> str:
    """取最后一条 user 消息的文本（AG-UI 的 messages 可能是多模态数组）。"""
    if not isinstance(messages, list):
        return ""
    for m in reversed(messages):
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        content = m.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):  # [{type:"text", text:"…"}]
            parts = [
                str(p.get("text") or "")
                for p in content
                if isinstance(p, dict) and p.get("type") in ("text", "input_text")
            ]
            return "".join(parts)
    return ""


def _usage_of(raw: Any) -> dict[str, Any] | None:
    """平台 usage → AG-UI TokenUsage（字段名不一样，得翻译）。"""
    if not isinstance(raw, dict):
        return None
    tin = int(raw.get("input_tokens") or raw.get("prompt_tokens") or 0)
    tout = int(raw.get("output_tokens") or raw.get("completion_tokens") or 0)
    if not (tin or tout):
        return None
    out: dict[str, Any] = {
        "inputTokens": tin,
        "outputTokens": tout,
        "totalTokens": tin + tout,
    }
    if raw.get("model"):
        out["model"] = str(raw["model"])
    cached = (
        raw.get("cache_read_tokens")
        or raw.get("cached_input_tokens")
        or raw.get("cache_input_tokens")
    )
    if cached:
        out["cachedInputTokens"] = int(cached)
    reasoning = raw.get("reasoning_tokens")
    if reasoning:
        out["reasoningTokens"] = int(reasoning)
    return out


class AguiTranslator:
    """平台统一事件 → AG-UI 事件（有状态：谁开着、谁该关）。

    单个实例服务一次 run。``feed()`` 吃一条平台事件、吐 0..n 条 AG-UI 事件；
    ``close()`` 收尾（关闭未闭合的块 + RUN_FINISHED）。
    """

    def __init__(self, *, thread_id: str, run_id: str, agent: dict[str, Any] | None = None) -> None:
        self.thread_id = thread_id
        self.run_id = run_id
        self.agent = agent or {}
        self._text_open = False
        self._text_id = f"msg_{run_id}_1"
        self._msg_seq = 1
        self._think_open = False
        self._tool_open: str | None = None
        self._step: str | None = None
        self._steps = 0
        self._usage: dict[str, Any] | None = None
        self._error: str | None = None
        #: 工具输出是**流式**吐出来的（tool_result_delta），AG-UI 要一次给全文 →
        #: 按 tool_call_id 攒着，到 tool_exec_end 一次性发 TOOL_CALL_RESULT。
        self._tool_output: dict[str, list[str]] = {}
        #: 是否已经发过 RUN_STARTED（AG-UI 客户端靠它开始等待；出错时也要先补上）
        self.started = False

    # ── 内部：关闭正在开的块（AG-UI 要求成对） ────────────────────────────
    def _close_think(self) -> list[dict[str, Any]]:
        if not self._think_open:
            return []
        self._think_open = False
        return [{"type": T_THINK_MSG_END}, {"type": T_THINK_END}]

    def _close_text(self) -> list[dict[str, Any]]:
        if not self._text_open:
            return []
        self._text_open = False
        return [{"type": T_TEXT_END, "messageId": self._text_id}]

    def _close_tool(self) -> list[dict[str, Any]]:
        if self._tool_open is None:
            return []
        tid, self._tool_open = self._tool_open, None
        return [{"type": T_TOOL_END, "toolCallId": tid}]

    def _open_text(self) -> list[dict[str, Any]]:
        if self._text_open:
            return []
        self._text_open = True
        return [{"type": T_TEXT_START, "messageId": self._text_id, "role": "assistant"}]

    # ── 主入口 ────────────────────────────────────────────────────────────
    def feed(self, ev: dict[str, Any]) -> list[dict[str, Any]]:
        etype = str(ev.get("type") or "")
        p = ev.get("payload") or {}
        out: list[dict[str, Any]] = []

        if etype == "run_start":
            self.started = True
            out.append({"type": T_RUN_STARTED, "threadId": self.thread_id, "runId": self.run_id})
            # 平台自己的 run_id / 助手，用 CUSTOM 带过去（AG-UI 的 runId 是客户端给的，
            # 对账"这次到底是平台哪条执行"还得靠这个）
            out.append(
                {
                    "type": T_CUSTOM,
                    "name": "platform_run",
                    "value": {
                        "runId": self.run_id,
                        "agentId": self.agent.get("id"),
                        "agentName": self.agent.get("name"),
                        "threadId": self.thread_id,
                    },
                }
            )
            return out

        if etype == "llm_call_start":
            out += self._close_think() + self._close_text() + self._close_tool()
            self._steps += 1
            self._step = f"llm_{self._steps}"
            out.append({"type": T_STEP_STARTED, "stepName": self._step})
            model = p.get("model_name") or p.get("model")
            if isinstance(model, str):
                out.append({"type": T_CUSTOM, "name": "llm_call", "value": {"model": model}})
            return out

        if etype == "llm_call_end":
            # 这一步的内容先收干净再收步：文本消息的 END 应该落在它所属的那一步里
            # （否则客户端会看到"步已结束但消息还开着"，消息会挂到下一步去）。
            out += self._close_think() + self._close_text()
            out.append({"type": T_STEP_FINISHED, "stepName": self._step or f"llm_{self._steps}"})
            self._step = None
            # 用量直接写在 payload 里（input_tokens/output_tokens），不是 payload.usage
            got_usage = _usage_of(p) or _usage_of(p.get("usage"))
            if got_usage:
                self._usage = got_usage
            return out

        if etype == "thinking_delta":
            delta = str(p.get("delta") or p.get("text") or "")
            if not delta:
                return []
            if not self._think_open:
                out += self._close_text() + self._close_tool()
                self._think_open = True
                out += [
                    {"type": T_THINK_START, "title": "思考"},
                    {"type": T_THINK_MSG_START},
                ]
            out.append({"type": T_THINK_MSG_CONTENT, "delta": delta})
            return out

        if etype == "text_delta":
            delta = str(p.get("delta") or p.get("text") or "")
            if not delta:
                return []
            out += self._close_think() + self._close_tool()
            out += self._open_text()
            out.append({"type": T_TEXT_CONTENT, "messageId": self._text_id, "delta": delta})
            return out

        if etype == "tool_call_start":
            out += self._close_think() + self._close_text()
            tid = str(p.get("tool_call_id") or p.get("id") or new_id("call"))
            self._tool_open = tid
            start = {
                "type": T_TOOL_START,
                "toolCallId": tid,
                # 平台事件里的键是 tool_call_name（实测：写成 tool_name 会退化成字面量"tool"）
                "toolCallName": str(p.get("tool_call_name") or p.get("tool_name") or p.get("name") or "tool"),
            }
            if self._text_id:  # 挂在当前助手消息下（AG-UI 的可选字段）
                start["parentMessageId"] = self._text_id
            out.append(start)
            return out

        if etype == "tool_call_args":
            if self._tool_open is None:
                return []
            delta = p.get("delta")
            if isinstance(delta, str):
                out.append({"type": T_TOOL_ARGS, "toolCallId": self._tool_open, "delta": delta})
            elif delta is not None:
                out.append(
                    {
                        "type": T_TOOL_ARGS,
                        "toolCallId": self._tool_open,
                        "delta": json.dumps(delta, ensure_ascii=False),
                    }
                )
            return out

        if etype == "tool_exec_start":
            # 参数到齐、开始执行 → AG-UI 的 tool call 到此结束
            return self._close_tool()

        if etype == "tool_exec_end":
            tid = str(p.get("tool_call_id") or self._tool_open or p.get("name") or "tool")
            # 优先用流式攒下来的输出；平台这个事件的 payload 里**没有**结果
            # （实测 keys 只有 reply_id/tool_call_id/state），所以不能指望它。
            chunks = self._tool_output.pop(tid, None) or self._tool_output.pop("_", [])
            if chunks:
                content = "".join(chunks)
            else:
                result = p.get("result")
                if isinstance(result, str):
                    content = result
                elif result is None:
                    content = str(p.get("state") or "")
                else:
                    content = json.dumps(result, ensure_ascii=False)
            return [
                {
                    "type": T_TOOL_RESULT,
                    "messageId": f"tool_{tid}",
                    "toolCallId": tid,
                    "content": content,
                    "role": "tool",
                }
            ]

        if etype == "tool_result_delta":
            delta = p.get("delta")
            if delta is None:
                return []
            # 攒起来给 TOOL_CALL_RESULT 用（键按 tool_call_id；平台有时不给，退到 "_"）
            key = str(p.get("tool_call_id") or self._tool_open or "_")
            self._tool_output.setdefault(key, []).append(str(delta))
            self._tool_output.setdefault("_", []).append(str(delta))
            # 同时用 CUSTOM 透传（客户端想边跑边显示也有东西可用）
            return [
                {
                    "type": T_CUSTOM,
                    "name": "tool_output",
                    "value": {"toolCallId": self._tool_open, "delta": str(delta)},
                }
            ]

        if etype == "hitl_request":
            # 人工确认：AG-UI 用 interrupt 表达"跑完了但要你决定"
            return [{"type": T_CUSTOM, "name": "hitl_request", "value": p}]

        if etype == "error":
            msg = str(p.get("message") or p.get("error") or "执行出错")
            self._error = msg
            return [{"type": T_RUN_ERROR, "message": msg}]

        return out

    def bootstrap_error(self, message: str) -> list[dict[str, Any]]:
        """还没开跑就失败（没助手/没输入/建执行失败）：补一个 RUN_STARTED 再报错。

        为什么不直接只发 RUN_ERROR：AG-UI 客户端按"RUN_STARTED → … → RUN_FINISHED/
        RUN_ERROR"组织状态机，缺开头会让它把这次运行当成"另一个运行的迟到事件"。
        """
        out: list[dict[str, Any]] = []
        if not self.started:
            self.started = True
            out.append({"type": T_RUN_STARTED, "threadId": self.thread_id, "runId": self.run_id})
        out.append({"type": T_RUN_ERROR, "message": message})
        return out

    def close(self, *, status: str, usage: Any = None, error: str | None = None) -> list[dict[str, Any]]:
        """收尾：关掉没闭合的块，然后给一个结束事件（AG-UI 客户端靠它停止等待）。"""
        out: list[dict[str, Any]] = []
        out += self._close_think() + self._close_text() + self._close_tool()
        if self._step:
            out.append({"type": T_STEP_FINISHED, "stepName": self._step})
            self._step = None

        if status == "error":
            return out + [
                {
                    "type": T_RUN_ERROR,
                    "message": error or self._error or "执行失败",
                }
            ]

        final_usage = _usage_of(usage) or self._usage
        ev: dict[str, Any] = {"type": T_RUN_FINISHED, "threadId": self.thread_id, "runId": self.run_id}
        if final_usage:
            # 规范里 RUN_FINISHED.usage 是**数组**（一次运行可能跨多个模型/子 agent，
            # 各自一行用量）—— 实测被 schema 挡下来才发现（对象会被判为非法）。
            ev["usage"] = [final_usage]
        if status == "waiting_hitl":
            # 有人在等确认 —— AG-UI 的 interrupt 语义（客户端拿 resume 续跑）
            ev["outcome"] = {
                "type": "interrupt",
                "interrupts": [
                    {
                        "id": f"hitl_{self.run_id}",
                        "reason": "需要人工确认",
                        "message": "执行已暂停，等待你在平台上确认后继续",
                    }
                ],
            }
        else:
            ev["result"] = {"status": status}
        return out + [ev]


# --------------------------------------------------------------------------- #
# 落库 + 流：把上面的翻译器接到平台的 run 上
# --------------------------------------------------------------------------- #
async def resolve_agent(forwarded: Any) -> Agent | None:
    """挑这次要用的助手：forwardedProps.agentId / agent（名字）/ 默认第一个。"""
    fp = forwarded if isinstance(forwarded, dict) else {}
    want_id = fp.get("agentId") or fp.get("agent_id")
    want_name = fp.get("agent") or fp.get("agentName")
    async with SessionLocal() as session:
        if want_id:
            row = await session.get(Agent, str(want_id))
            if row is not None:
                return row
        if want_name:
            row = (
                await session.execute(select(Agent).where(Agent.name == str(want_name)))
            ).scalars().first()
            if row is not None:
                return row
        return (await session.execute(select(Agent).order_by(Agent.created_at.asc()))).scalars().first()


async def prepare_run(thread_id: str, agent: Agent, text: str) -> tuple[str, AgentDefinition]:
    """建（或复用）平台会话 + 建这次执行。返回 (run_id, definition)。"""
    from .context import next_turn_index

    sid = session_id_for(thread_id, agent.id)
    async with SessionLocal() as session:
        chat = await session.get(ChatSession, sid)
        if chat is None:
            session.add(
                ChatSession(
                    id=sid,
                    workspace_id=agent.workspace_id or "ws_default",
                    agent_id=agent.id,
                    title=f"AG-UI · {text.strip()[:24] or '对话'}",
                    status="active",
                    summary=None,
                    summarized_upto=0,
                    message_count=0,
                    usage={},
                    created_at=now_ms(),
                    last_active_at=now_ms(),
                )
            )
            await session.commit()
        turn_index = await next_turn_index(session, sid)

        definition = AgentDefinition.model_validate(agent.definition)
        run = Run(
            agent_id=agent.id,
            agent_version=agent.version,
            runtime=definition.runtime,
            status="pending",
            input={"text": text},
            definition_snapshot=definition.model_dump(mode="json", exclude={"model": {"api_key"}}),
            started_at=now_ms(),
            session_id=sid,
            turn_index=turn_index,
            # 来源归到"对话"：AG-UI 是外部客户端在用，但形态就是一次对话
            origin="chat",
        )
        session.add(run)
        await session.commit()
        await session.refresh(run)
    return run.id, definition


def sse(event: dict[str, Any]) -> str:
    """一条 AG-UI 事件 → 一个 SSE 帧（AG-UI 的默认传输就是 SSE，data 里是事件 JSON）。"""
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


async def agui_stream(payload: dict[str, Any], *, max_seconds: float = 1800.0) -> AsyncIterator[str]:
    """AG-UI 输入 → AG-UI 事件流（SSE）。

    流程：挑助手 → 建会话与执行 → 订阅事件总线 → 回放已落库事件 → 增量推送 →
    收尾（RUN_FINISHED / RUN_ERROR）。任何一步失败都要给出 **RUN_ERROR**，
    不能让客户端一直等（那是最难查的一种"卡住"）。
    """
    from .runner import run_service

    thread_id = str(payload.get("threadId") or "").strip() or new_id("thread_")
    client_run_id = str(payload.get("runId") or "").strip() or new_id("run_")
    text = last_user_text(payload.get("messages"))

    def boot_error(message: str) -> list[str]:
        """还没建出平台执行就失败：先补 RUN_STARTED，再 RUN_ERROR。"""
        return [
            sse(
                {
                    "type": T_RUN_STARTED,
                    "threadId": thread_id,
                    "runId": client_run_id,
                }
            ),
            sse({"type": T_RUN_ERROR, "message": message}),
        ]

    if not text.strip():
        for frame in boot_error("没有可执行的输入：messages 里没有 user 文本消息"):
            yield frame
        return

    agent = await resolve_agent(payload.get("forwardedProps"))
    if agent is None:
        for frame in boot_error("平台上还没有可用的助手：请先在「助手」页建一个"):
            yield frame
        return

    try:
        run_id, definition = await prepare_run(thread_id, agent, text)
    except Exception as exc:  # noqa: BLE001
        logger.exception("AG-UI 建执行失败")
        for frame in boot_error(f"建执行失败：{type(exc).__name__}: {exc}"):
            yield frame
        return

    tr = AguiTranslator(
        thread_id=thread_id,
        run_id=client_run_id,
        agent={"id": agent.id, "name": agent.name},
    )

    queue = run_service.bus.subscribe(run_id)
    last_seq = -1
    deadline = time.monotonic() + max_seconds
    try:
        from .models import RunEvent
        from sqlalchemy import select as _select

        # 订阅之后才回放：先订阅不会漏事件，回放负责补上订阅前已经发生的那部分
        async with SessionLocal() as session:
            rows = (
                await session.execute(
                    _select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq)
                )
            ).scalars().all()
        for row in rows:
            last_seq = row.seq
            for ev in tr.feed({"seq": row.seq, "type": row.type, "ts": row.ts, "payload": row.payload or {}}):
                yield sse(ev)

        try:
            await run_service.start(run_id, definition, text)
        except Exception as exc:  # noqa: BLE001
            logger.exception("AG-UI 启动执行失败")
            for ev in tr.bootstrap_error(f"启动执行失败：{type(exc).__name__}: {exc}"):
                yield sse(ev)
            return

        while True:
            if time.monotonic() > deadline:
                for ev in tr.close(status="error", error="AG-UI 流超时（服务端上限）"):
                    yield sse(ev)
                break
            try:
                item = await asyncio.wait_for(queue.get(), timeout=30)
            except (asyncio.TimeoutError, TimeoutError):
                yield ": keep-alive\n\n"
                # 心跳时顺手看执行是不是已经结束（哨兵可能因为连接问题丢了）
                status = await _run_status(run_id)
                if status in TERMINAL or status == "waiting_hitl":
                    for ev in tr.close(status=status, usage=await _run_usage(run_id)):
                        yield sse(ev)
                    break
                continue
            if item is None:  # 结束哨兵
                status = await _run_status(run_id)
                for ev in tr.close(status=status, usage=await _run_usage(run_id)):
                    yield sse(ev)
                break
            if item.get("seq", 0) <= last_seq:
                continue
            last_seq = item["seq"]
            for ev in tr.feed(item):
                yield sse(ev)
    finally:
        run_service.bus.unsubscribe(run_id, queue)


async def _run_status(run_id: str) -> str:
    async with SessionLocal() as session:
        row = await session.get(Run, run_id)
        return row.status if row is not None else "error"


async def _run_usage(run_id: str) -> Any:
    async with SessionLocal() as session:
        row = await session.get(Run, run_id)
        return (row.usage or {}) if row is not None else {}
