"""把危险动作闸门接进 AgentScope 的权限链（``on_check_permission``）。

为什么用中间件而不是改工具
--------------------------
AgentScope 的判定只按"在不在工作目录内"（``accept_edits``），于是工作目录里
``rm -rf .`` 是放行的 —— 用户真正怕的那批命令（递归删、格式化、关机、
``curl | sh``、``crontab -r``）照样能过。中间件夹在**引擎之前**：

    工具调用 → [本中间件] → AgentScope 引擎（工作目录边界）→ 执行

中间件说 DENY 就是执行不了（连 ``bypass`` 模式也绕不过：中间件包着引擎）；
说不表态（返回 ``next_handler()``）才轮到引擎按原有规则判 —— 所以这一层是
**叠加**，不是替换，原有的工作目录边界照旧生效。
"""

from __future__ import annotations

import logging
from contextvars import ContextVar

from agentscope.middleware import MiddlewareBase
from agentscope.permission import PermissionBehavior, PermissionDecision

from ... import guardrails
from ...runner.ctx import current_run_ctx

logger = logging.getLogger(__name__)

#: 本次执行里"为什么拦/为什么问"的理由，按 tool_call id 存 ——
#: 归一化层把它塞进 hitl_request 的 payload，授权条上才说得出人话
#: （AgentScope 的确认事件只带工具名和参数，没有我们的理由）。
_REASONS: ContextVar[dict[str, str]] = ContextVar("guard_reasons", default={})


def note_reason(call_id: str, reason: str) -> None:
    if not call_id:
        return
    data = dict(_REASONS.get())
    data[call_id] = reason
    _REASONS.set(data)


def guard_reasons() -> dict[str, str]:
    return dict(_REASONS.get())


def clear_reasons() -> None:
    _REASONS.set({})


class DangerousActionGuard(MiddlewareBase):
    """拦住不可逆的命令，把"破坏性但可能需要"的交给用户点头。"""

    def __init__(
        self,
        *,
        enabled: bool = True,
        allow: list[str] | tuple[str, ...] = (),
        workspace: str | None = None,
        roots: list[str] | tuple[str, ...] = (),
    ) -> None:
        self.enabled = enabled
        #: 用户显式放行的模式（只对 ask 生效，deny 永不放行）
        self.allow = tuple(a for a in allow if a)
        self._workspace = workspace
        #: 这个助手额外申请的地盘（会话目录之外）。``"/"`` = 全盘，
        #: 用来配出「和 Hermes 一样的权限」；破坏性命令的判定不受影响。
        self._roots = tuple(r for r in roots if r)

    # ------------------------------------------------------------------ #
    def _allowed_by_user(self, text: str) -> bool:
        return any(pat and pat in text for pat in self.allow)

    @staticmethod
    def _command_text(tool_input: dict | None) -> str:
        data = tool_input or {}
        if not isinstance(data, dict):
            return ""
        for key in ("command", "cmd", "script", "code", "source"):
            val = data.get(key)
            if isinstance(val, str) and val.strip():
                return val
        return ""

    async def on_check_permission(self, agent, input_kwargs: dict, next_handler):  # type: ignore[override]
        if not self.enabled:
            return await next_handler()

        tool_call = input_kwargs.get("tool_call")
        tool_input = input_kwargs.get("tool_input") or {}
        name = getattr(tool_call, "name", "") or ""

        # 用户已经点过「允许」的那一次调用，别再造一次确认 —— 中间件排在引擎前面，
        # 引擎本该在这里短路（state=allowed），但我们先跑了，不认这个状态就会
        # 无限循环：允许 → 又问 → 允许 → 又问（实测踩到）。
        state = getattr(tool_call, "state", "")
        state = getattr(state, "value", state)
        if str(state) in ("allowed", "submitted", "finished"):
            return await next_handler()

        # 工作目录优先取本 run 的（compile 时还不知道会话目录），退到编译期给的
        ws = current_run_ctx().get("workspace") or self._workspace
        scope: str | list[str] = ([ws] if ws else []) + list(self._roots)
        if len(scope) == 1:
            scope = scope[0]
        verdict = guardrails.classify_tool_call(name, tool_input, scope)
        if verdict is None or verdict.risk == guardrails.RISK_ALLOW:
            return await next_handler()

        text = self._command_text(tool_input)
        if verdict.risk == guardrails.RISK_ASK and self._allowed_by_user(text):
            # 用户在这个助手上显式放行过同类命令 → 不再打扰
            logger.info("安全闸门：按用户放行规则跳过确认（%s）", verdict.rule)
            return await next_handler()

        # 没人看着的时候，ask 等于挂到超时 —— 降成 deny
        if not current_run_ctx().get("interactive", True):
            verdict = guardrails.downgrade_if_unattended(verdict)

        call_id = str(getattr(tool_call, "id", "") or "")
        note_reason(call_id, verdict.reason)

        if verdict.risk == guardrails.RISK_DENY:
            logger.warning("安全闸门拒绝执行（%s）：%s", verdict.rule, text[:200])
            return PermissionDecision(
                behavior=PermissionBehavior.DENY,
                message=f"已拦截：{verdict.reason}。换一种不破坏数据的方式，或者先问用户能不能由他来做。",
                decision_reason=verdict.rule,
            )

        logger.info("安全闸门要求确认（%s）：%s", verdict.rule, text[:200])
        return PermissionDecision(
            behavior=PermissionBehavior.ASK,
            message=verdict.reason,
            decision_reason=verdict.rule,
            # 安全类 ASK 不被"总是允许"规则静默掉：破坏性命令每次都要人看着
            bypass_immune=True,
        )
