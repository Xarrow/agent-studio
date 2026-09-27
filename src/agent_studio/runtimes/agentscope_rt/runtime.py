"""AgentScope 运行时适配器。

把 AgentScope 的 ``Agent`` 包装成平台的 ``AgentRuntime`` 契约：

- ``capabilities()``  ← 声明能力（前端据此渲染表单）
- ``validate()``      ← 静态校验
- ``compile()``       ← 定义 → Agent 实例
- ``run()``           ← ``reply_stream`` 事件流 → 统一事件流

注意：``run()`` 产出的事件**不填** ``run_id``/``seq``，由 runner 统一分配，
保证跨运行时的一致性。
"""

from __future__ import annotations

import inspect
import json
import logging
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from ... import platform_env
from ...config import settings
from ...schemas import AgentDefinition
from ..base import (
    AgentRuntime,
    CompiledAgent,
    HitlResponse,
    Issue,
    RuntimeCapabilities,
    TurnContext,
    UnifiedEvent,
)
from .compile import (
    BUILTIN_PLATFORMS,
    BUILTIN_SAFETY,
    BUILTIN_TOOLS,
    PROVIDER_CREDENTIALS,
    build_agent,
    build_mcp_client,
)
from .normalize import is_final_message, normalize_event

logger = logging.getLogger(__name__)


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


class AgentScopeCompiled(CompiledAgent):
    """AgentScope 编译产物。"""

    def __init__(
        self,
        agent_id: str,
        agent: Any,
        model: Any,
        work_dir: str | None = None,
        mcp_clients: list[Any] | None = None,
    ) -> None:
        self.agent_id = agent_id
        self.runtime = "agentscope"
        self.agent = agent
        self.model = model
        self.work_dir = work_dir
        #: 这次运行开的 MCP 连接 —— 必须在 dispose 时关掉，否则每跑一次
        #: 就漏一个子进程（stdio server）或一条长连接，跑几十次机器就满了。
        self.mcp_clients: list[Any] = list(mcp_clients or [])
        #: 最后一次运行的最终消息（由 run 填充，runner 读取后写 run.output）
        self.last_output: dict[str, Any] | None = None
        self._disposed = False

    async def dispose(self) -> None:
        if self._disposed:
            return
        self._disposed = True
        for client in self.mcp_clients:
            try:
                close = getattr(client, "close", None)
                if callable(close):
                    await _maybe_await(close())
            except Exception as exc:  # pragma: no cover
                logger.debug("关闭 MCP 连接失败: %s", exc)
        self.mcp_clients = []
        for obj in (self.model, self.agent):
            for attr in ("aclose", "close", "shutdown"):
                fn = getattr(obj, attr, None)
                if callable(fn):
                    try:
                        await _maybe_await(fn())
                    except Exception as exc:  # pragma: no cover
                        logger.debug("dispose %s.%s 失败: %s", type(obj).__name__, attr, exc)
                    break


class AgentScopeRuntime(AgentRuntime):
    name = "agentscope"

    # ------------------------------------------------------------------ #
    # 能力声明
    # ------------------------------------------------------------------ #
    def capabilities(self) -> RuntimeCapabilities:
        return RuntimeCapabilities(
            name=self.name,
            display_name="AgentScope v2",
            supports_hitl=True,
            supports_thinking=True,
            supports_structured_output=True,
            supports_skills=True,
            supports_middlewares=True,
            # 平台把 max_iters=-1 翻译成哨兵大值，因此这里可以声明支持
            supports_unlimited_iters=True,
            supports_no_timeout=True,
            # 多轮：compile 时用 Agent.observe() 预置历史消息
            supports_multi_turn=True,
            # 记忆：拼接进 System Prompt
            supports_memory=True,
            # AgentScope 的内置工具默认不做路径沙箱（有权限机制但需显式配置）
            sandboxes_tool_paths=False,
            notes="Python 运行时，进程内直接构造 Agent；事件模型最完整（含 HITL 与内容块级 delta）。",
            option_schema={
                "type": "object",
                "properties": {
                    "react_config": {
                        "type": "object",
                        "title": "ReAct 循环",
                        "properties": {
                            "max_iters": {
                                "type": "integer",
                                "title": "最大迭代轮数",
                                "default": 50,
                                "minimum": 1,
                                "maximum": 500,
                            },
                            "structured_output_grace_iters": {
                                "type": "integer",
                                "title": "结构化输出宽限轮次",
                                "default": 5,
                                "minimum": 1,
                            },
                            "stop_on_reject": {
                                "type": "boolean",
                                "title": "用户拒绝时停止",
                                "default": False,
                            },
                        },
                    },
                    "context_config": {
                        "type": "object",
                        "title": "上下文压缩",
                        "properties": {
                            "trigger_ratio": {
                                "type": "number",
                                "title": "触发压缩比例",
                                "default": 0.8,
                                "minimum": 0.1,
                                "maximum": 0.9,
                            },
                            "reserve_ratio": {
                                "type": "number",
                                "title": "保留比例",
                                "default": 0.1,
                                "minimum": 0.01,
                                "maximum": 0.9,
                            },
                            "compression_tool_enabled": {
                                "type": "boolean",
                                "title": "启用压缩工具",
                                "default": True,
                            },
                        },
                    },
                    "injection_config": {
                        "type": "object",
                        "title": "运行时注入",
                        "properties": {
                            "inject_runtime_state": {
                                "type": "boolean",
                                "title": "注入运行时状态",
                                "default": True,
                            },
                            "timezone": {
                                "type": "string",
                                "title": "时区",
                                "default": "Asia/Shanghai",
                            },
                        },
                    },
                    "model_config": {
                        "type": "object",
                        "title": "模型容错",
                        "properties": {
                            "max_retries": {
                                "type": "integer",
                                "title": "重试次数",
                                "default": 0,
                                "minimum": 0,
                                "maximum": 10,
                            }
                        },
                    },
                },
            },
        )

    # ------------------------------------------------------------------ #
    # 校验
    # ------------------------------------------------------------------ #
    async def validate(self, definition: AgentDefinition) -> list[Issue]:
        issues: list[Issue] = []

        # 模型
        spec = definition.model
        if spec.provider not in PROVIDER_CREDENTIALS:
            issues.append(
                Issue(
                    level="error",
                    field="model.provider",
                    message=f"不支持的 provider: {spec.provider}",
                )
            )
        if not spec.name:
            issues.append(Issue(level="error", field="model.name", message="模型名不能为空"))
        if spec.provider not in {"ollama"} and not spec.credential_ref and not spec.api_key:
            issues.append(
                Issue(
                    level="warning",
                    field="model.credential_ref",
                    message="未配置凭据，运行时需要提供 api_key",
                )
            )

        # 参数
        params = spec.params or {}
        temp = params.get("temperature")
        if temp is not None and not (0 <= float(temp) <= 2):
            issues.append(
                Issue(level="error", field="model.params.temperature", message="temperature 应在 0~2")
            )

        # 限值
        limits = definition.limits
        if limits.max_iters < -1:
            issues.append(
                Issue(
                    level="error",
                    field="limits.max_iters",
                    message="max_iters 必须 ≥ -1（-1 表示不限制轮数）",
                )
            )
        if limits.max_iters == -1 and limits.timeout_s <= 0:
            issues.append(
                Issue(
                    level="warning",
                    field="limits.timeout_s",
                    message="轮数不限制且未设超时，执行可能失控（建议设置超时兜底）",
                )
            )
        if limits.timeout_s > 0 and limits.timeout_s < 10:
            issues.append(
                Issue(
                    level="warning",
                    field="limits.timeout_s",
                    message="超时过短（< 10s），复杂任务可能来不及完成",
                )
            )

        # 工具名冲突
        names = [t.ref for t in definition.tools if t.enabled]
        if len(names) != len(set(names)):
            issues.append(Issue(level="warning", field="tools", message="存在重复的工具引用"))

        return issues

    # ------------------------------------------------------------------ #
    # 编译
    # ------------------------------------------------------------------ #
    async def compile(self, definition: AgentDefinition, **ctx: Any) -> AgentScopeCompiled:
        api_key = ctx.get("api_key")
        specs = ctx.get("tools") or []
        work_dir = Path(ctx.get("work_dir") or settings.work_dir)
        skills_dir = work_dir / "skills" if work_dir else None
        context: TurnContext | None = ctx.get("context")

        # ── MCP：把挂在这个助手上的服务器的工具**探测回来**并进 toolkit ──
        # 连接在这里开、在 dispose 里关（stdio 会起子进程，漏关就跑一次漏一个）。
        # 失败只告警不中断：一台 MCP 连不上，不该让整个助手不可用。
        mcp_clients: list[Any] = []
        mcp_tools: list[Any] = []
        server_ids = [str(x) for x in (getattr(definition, "mcp_servers", None) or [])]
        if server_ids:
            try:
                from ...db import SessionLocal
                from ...models import McpServer

                async with SessionLocal() as session:
                    for sid in server_ids:
                        row = await session.get(McpServer, sid)
                        if row is None or not row.enabled:
                            continue
                        client = build_mcp_client(
                            {
                                "name": row.name,
                                "transport": row.transport,
                                "command": row.command,
                                "args": list(row.args or []),
                                "url": row.url,
                                "env": dict(row.env or {}),
                                "headers": dict(row.headers or {}),
                            }
                        )
                        if row.transport != "http":
                            await client.connect()
                        got = await client.list_tools()
                        mcp_tools.extend(got)
                        mcp_clients.append(client)
                        logger.info("MCP「%s」装载 %d 个工具", row.name, len(got))
            except Exception as exc:  # noqa: BLE001
                logger.warning("MCP 工具装载失败（这次照常跑，只是少那部分工具）: %s", exc)
                for c in mcp_clients:
                    try:
                        await c.close()
                    except Exception:  # pragma: no cover
                        pass
                mcp_clients, mcp_tools = [], []

        agent, model = build_agent(
            definition,
            api_key,
            specs,
            skills_dir,
            memory_text=context.memory_text if context else None,
            mcp_tools=mcp_tools,
        )

        # 多轮会话：把历史消息预置进 Agent。
        # 用 ``observe()`` 而不是 ``reply()`` —— 后者会触发模型回答（多花一次调用），
        # observe 只把消息写进上下文，等价于"这些是已经聊过的内容"。
        # 注意：**observe 是 async 方法**，漏 await 会静默不生效（只报 RuntimeWarning）
        if context is not None and context.history:
            await self._seed_history(agent, context)

        return AgentScopeCompiled(
            agent_id=ctx.get("agent_id", ""),
            agent=agent,
            model=model,
            work_dir=str(work_dir),
            mcp_clients=mcp_clients,
        )

    @staticmethod
    async def _seed_history(agent: Any, context: TurnContext) -> None:
        """把会话历史与压缩摘要写进 Agent 的上下文。"""
        from agentscope.message import Msg, TextBlock

        msgs: list[Any] = []
        if context.summary:
            # 注意角色必须是 user（或 assistant）：AgentScope 对输入消息有校验
            # （role=='system' 直接 ValueError: Invalid message in the input），
            # 而这份摘要会随快照（state.context）在 HITL 恢复时被回放校验 ——
            # 恢复时炸「点了允许却报 Invalid message」就是它。name 保留语义即可。
            msgs.append(
                Msg(
                    name="system",
                    role="user",
                    content=[
                        TextBlock(
                            type="text",
                            text=f"以下是本次会话较早内容的摘要（供参考）：\n{context.summary}",
                        )
                    ],
                )
            )
        for m in context.history:
            msgs.append(
                Msg(
                    name=m.role,
                    role=m.role,
                    content=[TextBlock(type="text", text=m.content)],
                )
            )
        if msgs:
            await agent.observe(msgs)

    # ------------------------------------------------------------------ #
    # 执行
    # ------------------------------------------------------------------ #
    async def run(self, agent: CompiledAgent, run_input: Any) -> AsyncIterator[UnifiedEvent]:
        from agentscope.message import Msg, TextBlock

        assert isinstance(agent, AgentScopeCompiled)

        text = (
            run_input
            if isinstance(run_input, str)
            else json.dumps(run_input, ensure_ascii=False)
        )
        # 注意：AgentScope 的 Msg.content 必须是内容块**列表**，不能直接给 str
        msg = Msg(name="user", role="user", content=[TextBlock(type="text", text=text)])

        async for ev in agent.agent.reply_stream(msg, yield_final_msg=True):
            if is_final_message(ev):
                agent.last_output = self._extract_final(ev)
                continue

            unified = normalize_event(ev, run_id="", seq=0)
            if unified is not None:
                yield unified

    async def resume(self, agent: CompiledAgent, hitl: HitlResponse) -> AsyncIterator[UnifiedEvent]:
        """HITL 恢复：把确认结果回灌给 Agent 继续跑。"""
        from agentscope.event import ConfirmResult, UserConfirmResultEvent

        assert isinstance(agent, AgentScopeCompiled)

        payload = dict(hitl.payload or {})
        reply_id = payload.get("reply_id", "")
        # AgentScope 的字段是 ``confirmed``（不是 confirm），且按 tool_call 逐条确认
        results = [
            ConfirmResult(
                confirmed=hitl.confirm,
                tool_call=tc,
                rules=payload.get("rules") or [],
            )
            for tc in (payload.get("tool_calls") or [])
        ]
        if not results:
            raise ValueError(
                "HITL 恢复需要 payload.tool_calls（取自 hitl_request 事件）"
            )

        event = UserConfirmResultEvent(reply_id=reply_id, confirm_results=results)

        async for ev in agent.agent.reply_stream(event, yield_final_msg=True):
            if is_final_message(ev):
                agent.last_output = self._extract_final(ev)
                continue
            unified = normalize_event(ev, run_id="", seq=0)
            if unified is not None:
                yield unified

    # ------------------------------------------------------------------ #
    # 中途暂停的状态快照
    # ------------------------------------------------------------------ #
    def snapshot_state(self, agent: CompiledAgent) -> dict[str, Any] | None:
        """导出 AgentState（含 context 与待确认的工具调用）。

        AgentScope 判断"我在不在等确认"看的是 ``state.context`` 最后一条消息里
        工具调用的状态（``ASKING``）。所以**上下文本身就是状态**，必须整份存下来。
        """
        assert isinstance(agent, AgentScopeCompiled)
        try:
            return agent.agent.state.model_dump(mode="json")
        except Exception:  # pragma: no cover
            logger.warning("导出 AgentScope 状态失败", exc_info=True)
            return None

    async def restore_state(self, agent: CompiledAgent, snapshot: dict[str, Any]) -> None:
        """把快照装回一个**新编译**的 Agent。

        不装的话，恢复时会得到一个没有上下文的空 agent，喂确认结果会被拒：
        ``Agent is not waiting for user confirmation, but received UserConfirmResultEvent``
        —— 表现就是"点了允许但报错"。
        """
        from agentscope.state import AgentState

        assert isinstance(agent, AgentScopeCompiled)
        try:
            agent.agent.state = AgentState.model_validate(snapshot)
        except Exception:  # pragma: no cover
            logger.warning("恢复 AgentScope 状态失败（本次确认可能无法继续）", exc_info=True)
            raise

    # ------------------------------------------------------------------ #
    # 辅助
    # ------------------------------------------------------------------ #
    @staticmethod
    def _extract_final(msg: Any) -> dict[str, Any]:
        """从最终 Msg 里提取平台关心的字段。"""
        data: dict[str, Any] = {}
        try:
            raw = msg.model_dump(mode="json")
        except Exception:  # pragma: no cover
            return {"content": str(msg)}

        content = raw.get("content")
        if isinstance(content, list):
            texts = [
                b.get("text", "")
                for b in content
                if isinstance(b, dict) and b.get("type") == "text"
            ]
            content = "\n".join(t for t in texts if t)
        data["content"] = content
        for key in ("usage", "finished_reason", "structured_output", "error"):
            if raw.get(key) is not None:
                data[key] = raw[key]
        return data

    async def discover_tools(self) -> list[dict[str, Any]]:
        """列出 AgentScope 可用的内置工具（供 UI 勾选）。

        每项都带**平台适用性**与**安全属性**，让 UI 能：

        - 在不适用的平台上置灰并说明原因（例如 Linux 服务器上的 PowerShell）
        - 标注哪些属于"写/执行类"（服务端不试跑，只在 Agent 运行时内执行）
        """
        out: list[dict[str, Any]] = []
        for key, class_name in BUILTIN_TOOLS.items():
            applicable, note = platform_env.check_platform(BUILTIN_PLATFORMS.get(key))
            safety = BUILTIN_SAFETY.get(key, {})
            read_only = bool(safety.get("read_only", False))
            out.append(
                {
                    "kind": "builtin",
                    "name": key,
                    "class_name": class_name,
                    "display_name": class_name,
                    "applicable": applicable,
                    "platform_note": note,
                    # 参数签名（供 UI 提示试跑需要填什么）
                    "args": _probe_tool_args(key),
                    "flags": {
                        "read_only": read_only,
                        "concurrency_safe": read_only,
                        "dangerous": bool(safety.get("dangerous", False)),
                        "platform_ok": applicable,
                        "platform_note": note,
                        "platforms": BUILTIN_PLATFORMS.get(key),
                    },
                }
            )
        return out


def _probe_tool_args(name: str) -> list[dict[str, Any]]:
    """探测内置工具的调用签名，告诉 UI 试跑要填哪些参数。"""
    import inspect

    from .compile import build_builtin_tool

    try:
        tool = build_builtin_tool(name)
        call = getattr(tool, "call", None)
        if call is None:
            return []
        out: list[dict[str, Any]] = []
        for pname, param in inspect.signature(call).parameters.items():
            if pname.startswith("_"):
                continue
            ann = param.annotation
            out.append(
                {
                    "name": pname,
                    "required": param.default is inspect.Parameter.empty,
                    "type": (
                        getattr(ann, "__name__", str(ann))
                        if ann is not inspect.Parameter.empty
                        else "any"
                    ),
                }
            )
        return out
    except Exception:  # pragma: no cover
        return []
