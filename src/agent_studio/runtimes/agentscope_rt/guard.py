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

#: ContextVar 的兜底：插话/审批事件由引擎在**另一个任务**里归一化，
#: 那边读不到我们这里设的 ContextVar（实测授权条上只有工具名，没有理由）。
#: 所以再存一份进程级映射，按 call_id 取；call_id 全局唯一，用完不清也不会串。
_REASONS_FALLBACK: dict[str, str] = {}
_FALLBACK_MAX = 500


def note_reason(call_id: str, reason: str) -> None:
    if not call_id:
        return
    data = dict(_REASONS.get())
    data[call_id] = reason
    _REASONS.set(data)
    _REASONS_FALLBACK[call_id] = reason
    if len(_REASONS_FALLBACK) > _FALLBACK_MAX:
        for old in list(_REASONS_FALLBACK)[: _FALLBACK_MAX // 5]:
            _REASONS_FALLBACK.pop(old, None)


def guard_reasons() -> dict[str, str]:
    return {**_REASONS_FALLBACK, **_REASONS.get()}


def clear_reasons() -> None:
    _REASONS.set({})


#: 「这次运行里，用户已经点过允许这个工具」——进程内记录，run 结束就清。
#: 为什么需要它：会话级白名单（SessionAllow）只在**编译期**读一次，用户在同一次
#: 运行中途点「允许」写进库也不会影响正在跑的这轮 —— 结果就是模型每调一次工具
#: 就再弹一次确认，用户点十次也停不下来（实测踩到）。这里按 (run_id, 工具名)
#: 记一份，同一次运行内后续同名调用直接放行。
_RUN_ALLOW: dict[str, set[str]] = {}


def _norm(name: str) -> str:
    """工具名归一：去掉命名空间前缀、统一小写。

    实测踩到：同一个工具在不同路径下来的是 ``browser_navigate`` / ``Navigate`` /
    ``functions.bash``，只按原样字符串记，用户点了允许下一次还是不认识 —— 表现就是
    「允许了还一直弹」。
    """
    n = (name or "").strip().lower()
    for pref in ("functions.", "tool:", "tools."):
        if n.startswith(pref):
            n = n[len(pref) :]
    return n


def allow_for_run(run_id: str, tool_name: str, *, rule: str = "") -> None:
    """记下"这次运行里这个工具已允许"。``rule`` 给了就一并记规则名 —— 同一条规则
    在本次运行内不再问（引擎对每次 bash 调用都会重新判一次，只记工具名不够）。"""
    if not run_id:
        return
    keys = _RUN_ALLOW.setdefault(run_id, set())
    if tool_name:
        keys.add(_norm(tool_name))
    if rule:
        keys.add(f"rule:{rule}")


def clear_run_allow(run_id: str) -> None:
    _RUN_ALLOW.pop(run_id, None)


def run_allowed(run_id: str, tool_name: str, *, rule: str = "") -> bool:
    if not run_id:
        return False
    keys = _RUN_ALLOW.get(run_id, set())
    n = _norm(tool_name)
    if n and (n in keys or n.rsplit(".", 1)[-1] in keys):
        return True
    return bool(rule) and f"rule:{rule}" in keys


def run_allowed_tools(run_id: str) -> set[str]:
    """这次运行里用户已经点过允许的工具（续跑重编译时并进白名单）。"""
    return set(_RUN_ALLOW.get(run_id, set()))


class DangerousActionGuard(MiddlewareBase):
    """拦住不可逆的命令，把"破坏性但可能需要"的交给用户点头。"""

    def __init__(
        self,
        *,
        enabled: bool = True,
        allow: list[str] | tuple[str, ...] = (),
        workspace: str | None = None,
        roots: list[str] | tuple[str, ...] = (),
        read_roots: list[str] | tuple[str, ...] = (),
        session_allow: list[str] | tuple[str, ...] = (),
        deny_patterns: list[str] | tuple[str, ...] = (),
    ) -> None:
        self.enabled = enabled
        #: 平台级命令黑名单（子串匹配，跨助手共享）。优先级最高：
        #: bypass 模式、会话内允许、用户放行规则都压不住 —— 黑名单就是底线。
        self._deny_patterns = tuple(p for p in deny_patterns if p)
        #: 用户显式放行的模式（只对 ask 生效，deny 永不放行）
        self.allow = tuple(a for a in allow if a)
        self._workspace = workspace
        #: 这个助手额外申请的地盘（会话目录之外）。``"/"`` = 全盘，
        #: 用来配出「和 Hermes 一样的权限」；破坏性命令的判定不受影响。
        self._roots = tuple(r for r in roots if r)
        #: **可读范围**（比写范围窄）：默认只有会话目录；要看别处就在助手配置里
        #: 加目录，或者运行时点一次同意。含 ``/`` 等于放弃这一层（全盘可读）。
        self._read_roots = tuple(r for r in read_roots if r)
        #: 用户在这个会话里点过「不再问这个工具」的（AgentScope 工具名）。
        #: 只降级 ASK —— ``rm -rf /`` 这类 DENY 永不放行（点过也不放）。
        self._session_allow = {t for t in session_allow if t}

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
        read_scope: list[str] = ([ws] if ws else []) + list(self._read_roots)
        verdict = guardrails.classify_tool_call(name, tool_input, scope, read_scope)
        if verdict is None or verdict.risk == guardrails.RISK_ALLOW:
            return await next_handler()

        text = self._command_text(tool_input)
        # 平台黑名单：最先判，任何模式/任何放行都拦（找不到子串就是没命中）
        if text and any(p in text for p in self._deny_patterns):
            hit = next(p for p in self._deny_patterns if p in text)
            logger.warning("安全闸门：命中平台黑名单 %r，拒绝（%s）", hit, text[:120])
            note_reason(str(getattr(tool_call, "id", "") or ""), f"命中平台黑名单：{hit}")
            return PermissionDecision(
                behavior=PermissionBehavior.DENY,
                message=f"已拦截：命令命中平台黑名单「{hit}」。这条由平台统一配置，助手无法绕过。",
                decision_reason=f"platform-deny:{hit}",
            )
        if verdict.risk == guardrails.RISK_ASK and run_allowed(
            str(current_run_ctx().get("run_id") or ""), name, rule=str(verdict.rule)
        ):
            # 本次运行里用户已经点过「允许」这个工具 —— 不再重复弹。
            # 循环调用同一个工具（实测：worker_status 被连问十几次）时这是唯一有
            # 效的止损；DENY 在前面就拦住了，这里放掉的只是 ASK。
            logger.info("安全闸门：本次运行已允许 %s，直接放行（%s）", name, verdict.rule)
            return PermissionDecision(
                behavior=PermissionBehavior.ALLOW,
                message="本次运行内已允许这个工具。",
                decision_reason=f"{verdict.rule}-run-allow",
            )
        if verdict.risk == guardrails.RISK_ASK and name in self._session_allow:
            # 「本会话内不再问这类操作」生效点。必须**直接 ALLOW 短路**，
            # 不能 next_handler() 交给引擎：引擎里的 Bash 内建检查对
            # rm -rf 等发的是 bypass_immune ASK（allow 规则压不住），
            # 交回去等于白放行 —— 用户勾了「不再问」还会每次再问（实测踩到）。
            # 短路安全：能走到这的 verdict 已是 ASK（DENY 在后面拦着），不存在
            # 「放掉了本该 DENY 的」。
            logger.info("安全闸门：本会话已允许 %s，直接放行（%s）", name, verdict.rule)
            return PermissionDecision(
                behavior=PermissionBehavior.ALLOW,
                message="用户在本会话内已允许这类操作。",
                decision_reason=f"{verdict.rule}-session-allow",
            )
        if verdict.risk == guardrails.RISK_ASK and self._allowed_by_user(text):
            # 用户在这个助手上显式放行过同类命令 → 不再打扰
            logger.info("安全闸门：按用户放行规则跳过确认（%s）", verdict.rule)
            return await next_handler()

        # 没人看着的时候，ask 等于挂到超时 —— 降成 deny
        if not current_run_ctx().get("interactive", True):
            verdict = guardrails.downgrade_if_unattended(verdict)

        # bypass 模式 = 用户声明"全信任，黑名单兜底"：引擎会跳过全部安全 ASK
        # （bypass_immune 无效），我们这层再发 ASK 就和模式矛盾 —— 用户选了
        # bypass 还是每次被问。这里对齐：只保留 DENY 拦截，ASK 放行。
        #
        # 唯一例外是"读到文件范围外"：bypass 免的是"在你自己的地盘上别问我"，
        # 不免"翻到机器别处去"。真需要看别的目录，就在助手配置里加可读范围。
        if (
            verdict.risk == guardrails.RISK_ASK
            and verdict.rule != "read-scope"
            and getattr(agent, "state", None) is not None
        ):
            _mode = getattr(
                getattr(getattr(agent, "state", None), "permission_context", None),
                "mode",
                "",
            )
            if str(getattr(_mode, "value", _mode)) == "bypass":
                logger.info("安全闸门：bypass 模式，ASK 放行（%s）", verdict.rule)
                return PermissionDecision(
                    behavior=PermissionBehavior.ALLOW,
                    message="权限模式为全部放行，黑名单规则仍生效。",
                    decision_reason=f"{verdict.rule}-bypass",
                )

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
