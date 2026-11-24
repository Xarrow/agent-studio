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
import os
from contextvars import ContextVar

from agentscope.middleware import MiddlewareBase
from agentscope.permission import PermissionBehavior, PermissionDecision

from ... import file_policy, guardrails
from ...runner.ctx import current_run_ctx

logger = logging.getLogger(__name__)

#: 只读原生工具白名单：不写盘、不执行命令，可以跳过"逐次确认"。
#: 只从 NATIVE_TOOLS 里按 flags.read_only 自动取，不在代码里另写一份名字，
#: 免得以后加了新工具忘记同步（漏一个就等于每次调用都弹窗）。
_READ_ONLY_NATIVE = {
    name
    for name, entry in __import__(
        "agent_studio.native_tools", fromlist=["NATIVE_TOOLS"]
    ).NATIVE_TOOLS.items()
    if (entry.get("flags") or {}).get("read_only")
}

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


#: 「这一步是平台拦下的」——按 tool_call id 记。和 ``reasons`` 分开：
#: 那条是给授权条看的（为什么要你点头），这条是给**收尾归因**用的
#: （被拦 ≠ 用户点了拒绝；把两者写成一句话会让用户以为是自己点错了）。
#: 值：``{"source": "guard", "rule": ..., "reason": ...}``
_DENY_NOTES: dict[str, dict[str, str]] = {}


def note_denied(call_id: str, *, reason: str, rule: str = "", source: str = "guard") -> None:
    """记一条「平台/护栏拦下」的事实（不是用户点的拒绝）。

    ``source`` 默认 ``guard``（禁区、黑名单、护栏）；**重复发起被拒绝名单拦下**时
    传 ``repeat`` —— 收尾文案与是否中止这一轮都要按它分开（见 runner.service）。
    """
    if not call_id:
        return
    _DENY_NOTES[call_id] = {"source": source or "guard", "rule": rule or "", "reason": reason or ""}

    if len(_DENY_NOTES) > _FALLBACK_MAX:
        for old in list(_DENY_NOTES)[: _FALLBACK_MAX // 5]:
            _DENY_NOTES.pop(old, None)


def denied_note(call_id: str) -> dict[str, str] | None:
    if not call_id:
        return None
    return _DENY_NOTES.get(call_id)


def clear_denied_notes() -> None:
    _DENY_NOTES.clear()


#: 「这次调用要动哪个文件」的结构化细节，按 tool_call id 存。
#: 授权条上要写清：哪个助手、完整路径、操作类型、内容摘要/差异 ——
#: AgentScope 的确认事件只带工具名和参数，这些得我们从判定那一层带出来。
_FILE_ACTIONS: ContextVar[dict[str, dict]] = ContextVar("guard_file_actions", default={})
_FILE_ACTIONS_FALLBACK: dict[str, dict] = {}


def note_file_action(call_id: str, data: dict) -> None:
    if not call_id or not data:
        return
    payload = dict(data)
    cur = dict(_FILE_ACTIONS.get())
    cur[call_id] = payload
    _FILE_ACTIONS.set(cur)
    _FILE_ACTIONS_FALLBACK[call_id] = payload
    if len(_FILE_ACTIONS_FALLBACK) > _FALLBACK_MAX:
        for old in list(_FILE_ACTIONS_FALLBACK)[: _FALLBACK_MAX // 5]:
            _FILE_ACTIONS_FALLBACK.pop(old, None)


def file_actions() -> dict[str, dict]:
    return {**_FILE_ACTIONS_FALLBACK, **_FILE_ACTIONS.get()}


#: 「这条命令执行时只跑这些段」——按 tool_call id 记（值 = 改写后的命令原文）。
#: 用途：一条复合命令里有的动作已被用户拒绝、有的是新的，逐个裁决之后**不能整条
#: 执行**（会把被拒的那个再做一遍），也不能整条拦下（新动作就没机会了）。
#: 权限层拿到的入参是深拷贝（AgentScope 明确不让中间件改动执行内容），所以改写
#: 只能落在真正执行的那一刻 —— ``on_acting``。
_TRIM: dict[str, str] = {}
#: 改写时给模型看的一句话（告诉它哪一步被拦下了、没有执行）
_TRIM_NOTES: dict[str, str] = {}


def note_trim(call_id: str, command: str, note: str = "") -> None:
    if not call_id or not command:
        return
    _TRIM[call_id] = command
    if note:
        _TRIM_NOTES[call_id] = note
    if len(_TRIM) > _FALLBACK_MAX:
        for old in list(_TRIM)[: _FALLBACK_MAX // 5]:
            _TRIM.pop(old, None)
            _TRIM_NOTES.pop(old, None)


def pop_trim(call_id: str) -> tuple[str, str]:
    """取出（并消费）这条调用的改写计划：(命令, 给模型的话)。"""
    if not call_id:
        return "", ""
    return _TRIM.pop(call_id, ""), _TRIM_NOTES.pop(call_id, "")


def clear_trims() -> None:
    _TRIM.clear()
    _TRIM_NOTES.clear()


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

    @staticmethod
    def _unwrap_tool_call(name, tool_input):
        """把通用壳 ``tool_call`` 拆成（真工具名, 真参数）。

        延迟加载（lazy tools）时模型调的是壳，真名在 input 里：
        ``{"name": "read_document", "arguments": {...}}``。
        不拆开就会"每读一份文档点一次允许"——无人值守的工业场景直接不可用。
        只认这一种形状，其它原样返回：拆错比不拆更危险。
        """
        if name not in ("tool_call", "tool_use") or not isinstance(tool_input, dict):
            return name, tool_input
        inner = tool_input.get("name") or tool_input.get("tool")
        args = tool_input.get("arguments")
        if not isinstance(inner, str) or not inner.strip():
            return name, tool_input
        return inner.strip(), args if isinstance(args, dict) else {}

    # ------------------------------------------------------------------ #
    # 文件权限策略（用户定的四条语义，见 file_policy 文件头）
    # ------------------------------------------------------------------ #
    @staticmethod
    def _mode(agent) -> str:
        pc = getattr(getattr(agent, "state", None), "permission_context", None)
        mode = getattr(pc, "mode", "")
        return str(getattr(mode, "value", mode) or "")

    @staticmethod
    def _engine_has_deny(agent, name: str) -> bool:
        """助手自己配了针对这个工具的显式拒绝规则？有就不替他放行。"""
        pc = getattr(getattr(agent, "state", None), "permission_context", None)
        deny = getattr(pc, "deny_rules", None) or {}
        if not isinstance(deny, dict):
            return False
        short = _norm(name)
        for key, rules in deny.items():
            if _norm(str(key)) == short and rules:
                return True
        return False

    def _dir_allowed(self, path: str) -> bool:
        """「本会话内允许该目录」—— 存成 SessionAllow 的 ``dir:<realpath>``。"""
        if not path:
            return False
        target = os.path.realpath(path)
        for item in self._session_allow:
            if not isinstance(item, str) or not item.startswith("dir:"):
                continue
            root = os.path.realpath(item[4:])
            if target == root or target.startswith(root.rstrip("/") + "/"):
                return True
        return False

    async def _audit_blocked(self, tool_name: str, tool_input: dict, verdict, ws: str) -> None:
        """禁区拦截也要留一条 —— 用户要求"所有被拦的都要能查到"。

        审计里的 ``path`` 必须是**用户能认出来的那个路径**：读类工具没有"写动作"，
        ``file_action_for`` 返回 None，不能退成 ``verdict.snippet``（那只是命中项的
        最后一段，比如 ``.hermes``）—— 那样用户看到"被拦了 .hermes"，却不知道它想
        读的是 ``/root/.hermes/config.yaml``。

        操作类型按**真实意图**记：``ls``/``cat`` 这类是「读」，写命令才是「写」。
        以前一律空着，界面回退成"写"，读尝试被记成写（用户 2026-11 指出）。
        """
        ctx = current_run_ctx()
        act = guardrails.file_action_for(tool_name, tool_input, ws or None)
        if act is None:
            # 写动作解析不出来 → 按读的那条解析（禁区里的 ls/cat 走这里）
            act = guardrails.file_action_for_read(tool_name, tool_input, ws or None)
        if act is not None:
            data = act.as_dict()
        else:
            raw = ""
            for key in ("file_path", "path", "notebook_path", "target_file", "filePath", "dir", "directory", "cwd", "pattern"):
                val = (tool_input or {}).get(key) if isinstance(tool_input, dict) else None
                if isinstance(val, str) and val.strip():
                    raw = val
                    break
            command = self._command_text(tool_input)
            if not raw and command:
                # 命令通道：把命中的那个路径找出来（`cat /root/.hermes/x` → 那个文件）
                raw = file_policy.first_path_in(command, ws or None)
            data = {
                "path": raw or verdict.snippet or "",
                # 只有确实是只读命令才记「读」；`shutdown` 这类认不出的一律留空
                # （界面显示「—」）—— 谎报成读会把审计的可信度毁掉
                "op": file_policy.OP_READ if command and file_policy.is_read_command(command) else "",
                "command": command,
            }
        await file_policy.audit(
            data,
            result=file_policy.RESULT_BLOCKED,
            rule=verdict.rule,
            agent_id=str(ctx.get("agent_id") or ""),
            run_id=str(ctx.get("run_id") or ""),
            session_id=str(ctx.get("session_id") or ""),
        )

    async def _audit_read(self, tool_name: str, tool_input: dict, ws: str) -> None:
        """工作区**之外**的成功读记一条（工作区内的读不记 —— 太频繁）。

        读是放开策略（禁区除外），所以这里只留痕、不影响放行；
        与写分开：写有自己的四类结果，这条是「读 + 放行」。
        """
        # 这一条命令里要是有写动作，就归写那条去记（别把 `echo > f && cat f` 记两条）
        if guardrails.file_action_for(tool_name, tool_input, ws or None) is not None:
            return
        act = guardrails.file_action_for_read(tool_name, tool_input, ws or None)
        if act is None or act.inside:
            return
        ctx = current_run_ctx()
        await file_policy.audit(
            act,
            result=file_policy.RESULT_ALLOWED,
            rule="read-outside",
            agent_id=str(ctx.get("agent_id") or ""),
            run_id=str(ctx.get("run_id") or ""),
            session_id=str(ctx.get("session_id") or ""),
        )

    async def _classify_write(
        self, act: file_policy.Action, *, agent, tool_name: str, session_id: str, user_text: str
    ) -> str:
        """一条写动作归到哪一类（判据顺序与原 ``_decide_write`` 完全一致）。

        返回值：``engine``（交回引擎，尊重只读设置）/ ``workspace``（会话目录内）/
        ``dir-allow``（本会话允许过这个目录）/ ``danger-mode``（用户打开的危险模式）/
        ``repeat``（本会话拒绝过，平台拦）/ ``unattended``（没人看着）/ ``confirm``。
        """
        if act.inside:
            if self._mode(agent) == "explore" or self._engine_has_deny(agent, tool_name):
                return "engine"
            return "workspace"
        if self._dir_allowed(act.path):
            return "dir-allow"
        # 权限模式 = 全部放行：越界写也不再问（用户口径：选了它就别再弹卡）。
        # 仍留审计痕迹（走 danger-mode 分支），DENY 类（凭据路径/平台黑名单）照旧拦。
        if self._mode(agent) == "bypass":
            return "danger-mode"
        if await file_policy.skip_confirm():
            return "danger-mode"
        if await file_policy.denial_hit(act, session_id=session_id, user_text=user_text):
            return "repeat"
        if not current_run_ctx().get("interactive", True):
            return "unattended"
        return "confirm"

    async def _decide_write(
        self, act: file_policy.Action, *, agent, tool_name: str, call_id: str, next_handler, text: str = ""
    ):
        """一次「写」的最终裁决 —— 目录内放行 / 目录级允许 / 危险模式 / 弹卡。

        所有分支都要留审计（用户第 6 条）：被确认、被拒绝、被跳过、被拦，
        四类都能在「运行记录 → 文件操作」里查到。
        """
        ctx = current_run_ctx()
        ids = dict(
            agent_id=str(ctx.get("agent_id") or ""),
            run_id=str(ctx.get("run_id") or ""),
            session_id=str(ctx.get("session_id") or ""),
        )
        kind = await self._classify_write(
            act,
            agent=agent,
            tool_name=tool_name,
            session_id=ids["session_id"],
            user_text=str(ctx.get("input_text") or ""),
        )

        # ① 当前会话工作目录内：直接放行，不打扰（用户第 3 条上半句）
        if kind == "engine":
            # 助手被设成"只读"：那是更严的选择，尊重它（引擎会拒）
            return await next_handler()
        if kind == "workspace":
            await file_policy.audit(act, result=file_policy.RESULT_ALLOWED, rule="workspace", **ids)
            return PermissionDecision(
                behavior=PermissionBehavior.ALLOW,
                message="在当前会话的工作目录内，直接执行。",
                decision_reason="file-write-workspace",
            )

        # ② 本会话内已经允许过这个目录（进阶项：允许该目录）
        if kind == "dir-allow":
            await file_policy.audit(act, result=file_policy.RESULT_APPROVED, rule="dir-allow", **ids)
            return PermissionDecision(
                behavior=PermissionBehavior.ALLOW,
                message="你在本会话内已允许这个目录，直接执行。",
                decision_reason="file-write-dir-allow",
            )

        # ③ 危险模式：用户亲手打开过「跳过确认」—— 直接执行，但留痕
        if kind == "danger-mode":
            await file_policy.audit(act, result=file_policy.RESULT_SKIPPED, rule="danger-mode", **ids)
            logger.info("文件权限：危险模式下跳过确认（%s %s）", act.op, act.path)
            return PermissionDecision(
                behavior=PermissionBehavior.ALLOW,
                message="危险模式已开启：跳过确认直接执行。",
                decision_reason="file-write-danger-mode",
            )

        # ③.5 本会话里用户已经拒绝过这个动作：平台直接拦，**不再弹卡**
        # 现场（2026-11 公网真人路径）：拒绝一次之后，下一轮只说一句「回个收到」，
        # 模型又把同一个写入发了一遍 —— 同一张卡又弹出来，用户被迫点第二次、
        # 第三次。提示词劝不住，所以这里用**会话级拒绝名单**兜底：
        #   · 命中的这一条不记「用户拒绝」（那是上一次的事实，重复记就是假审计）
        #   · 模型收到明确结果：「该动作已被用户在本会话拒绝，不要再试」
        #   · 用户**这条消息**里明确重新要求同一个动作 → 不算命中，照常弹卡确认
        # 放在危险模式之后：危险模式是用户当场打开的「别问我」开关，不该被历史拒绝挡住。
        if kind == "repeat":
            _why = f"这个动作你在本会话里拒绝过：要{act.op} {act.path}"
            await file_policy.audit(
                act, result=file_policy.RESULT_REPEAT_BLOCKED, rule="denied-repeat", **ids
            )
            note_reason(call_id, _why)
            note_denied(call_id, reason=_why, rule="denied-repeat", source="repeat")
            logger.warning("文件权限：重复发起已拦截（%s %s）", act.op, act.path)
            return PermissionDecision(
                behavior=PermissionBehavior.DENY,
                message=(
                    f"{_why}。平台按这个会话的拒绝名单拦下了这次的重复发起："
                    "没有再次弹卡，也不再执行。除非用户在新消息里明确要求重做这个动作，"
                    "否则不要再试 —— 换个做法之前先问用户。"
                ),
                decision_reason="file-write-denied-repeat",
            )

        # ④ 没人看着（定时/无人值守）：没人点头就是不执行 —— 不能挂到超时
        if kind == "unattended":
            await file_policy.audit(act, result=file_policy.RESULT_REJECTED, rule="file-write-unattended", **ids)
            note_denied(
                call_id,
                reason=(
                    f"这一轮没有人在看着（定时/无人值守），所以没有执行：要{act.op} {act.path}"
                ),
                rule="file-write-unattended",
            )
            return PermissionDecision(
                behavior=PermissionBehavior.DENY,
                message=(
                    f"这一轮没有人在看着（定时/无人值守），所以没有执行：要{act.op} {act.path}。"
                    "需要它这么做的话，让用户手动跑一次并在确认卡上点头，或者在设置里打开危险模式。"
                ),
                decision_reason="file-write-unattended",
            )

        # ⑤ 弹确认卡：把"哪个助手、写到哪、干什么、写什么"一起带出去
        detail = act.as_dict()
        detail["agent"] = await file_policy.agent_name(ids["agent_id"])
        detail["agent_id"] = ids["agent_id"]
        detail["workspace"] = ctx.get("workspace") or self._workspace or ""
        detail["dir"] = os.path.dirname(act.path)
        detail["actions"] = [act.as_dict()]
        note_file_action(call_id, detail)
        note_reason(call_id, f"要{act.op} {act.path}")
        logger.info("文件权限：越界写入要确认（%s %s）", act.op, act.path)
        return PermissionDecision(
            behavior=PermissionBehavior.ASK,
            message=f"要{act.op} {act.path} —— 这个位置在当前会话目录之外，需要你点头",
            decision_reason=guardrails.FILE_WRITE_RULE,
            # 每一次越界写都要人看着：不能被"总是允许"规则静默掉
            bypass_immune=True,
        )

    async def _decide_writes(
        self,
        acts: list[file_policy.Action],
        *,
        agent,
        tool_name: str,
        call_id: str,
        next_handler,
        text: str = "",
    ):
        """一条调用里有**多个**文件动作：逐个裁决，不许整包连坐。

        用户 2026-11 的现场：让助手写新文件 B，它把之前**已被拒绝**的 A 打包进
        同一条命令 —— 平台一看见 A 就把整包拦下，B 连自己的确认卡都没得到。
        口径（需求 2）：
          · 已拒绝的：单独拦下、单独记「重复发起已拦截」、明确告诉模型；
          · 需确认的：照常单独弹卡（卡上只写这次要动的位置）；
          · 可放行的：跟着命令一起执行；
          · 能拆分的：把被拒的**那几段**从命令里去掉再执行（见 ``on_acting``）。
        返回 ``None`` = 交回引擎（和原来一样由引擎按工作目录判）。
        """
        ctx = current_run_ctx()
        ids = dict(
            agent_id=str(ctx.get("agent_id") or ""),
            run_id=str(ctx.get("run_id") or ""),
            session_id=str(ctx.get("session_id") or ""),
        )
        user_text = str(ctx.get("input_text") or "")
        ws = str(ctx.get("workspace") or self._workspace or "")

        # 单元 → 动作的映射：丢掉被拒的单元后还要拼回一条能执行的命令。
        # 只有**命令**通道能改写（``on_acting`` 改的是入参里的 command）；
        # 代码通道（python）改不了执行内容 —— 一律按"不可拆分"处理，
        # 否则会出现"卡上说只写 B、实际把 A 也写了"。
        units = (
            file_policy.command_units(text, ws or None)
            if text and _norm(tool_name) in file_policy.COMMAND_TOOLS
            else None
        )
        pairs: list[tuple[int, file_policy.Action]] = []
        if units:
            for ui, unit in enumerate(units):
                for act in unit.actions:
                    pairs.append((ui, act))
        if not pairs:
            units = None
            pairs = [(0, a) for a in acts]

        kinds: list[str] = []
        for _ui, act in pairs:
            kinds.append(
                await self._classify_write(
                    act, agent=agent, tool_name=tool_name, session_id=ids["session_id"], user_text=user_text
                )
            )

        # ── 自动放行/自动拦截的那几类：逐条留审计（结果分类沿用原来的四种）────
        for (_ui, act), kind in zip(pairs, kinds):
            if kind == "workspace":
                await file_policy.audit(act, result=file_policy.RESULT_ALLOWED, rule="workspace", **ids)
            elif kind == "dir-allow":
                await file_policy.audit(act, result=file_policy.RESULT_APPROVED, rule="dir-allow", **ids)
            elif kind == "danger-mode":
                await file_policy.audit(act, result=file_policy.RESULT_SKIPPED, rule="danger-mode", **ids)
            elif kind == "repeat":
                await file_policy.audit(
                    act, result=file_policy.RESULT_REPEAT_BLOCKED, rule="denied-repeat", **ids
                )

        repeat_at = [i for i, k in enumerate(kinds) if k == "repeat"]
        confirm_at = [i for i, k in enumerate(kinds) if k == "confirm"]
        unattended_at = [i for i, k in enumerate(kinds) if k == "unattended"]
        engine_at = [i for i, k in enumerate(kinds) if k == "engine"]
        # 同一段里既有被拒的、又有该问的（`cat f | tee A | tee B`）—— 丢掉整段会把
        # 该问的也一起丢掉（卡上写了 B、结果没执行）。这种按不可拆分处理。
        # 另外：只要有交给引擎判的动作，就没法只跑"可执行的那几段"（引擎判的是整条
        # 命令）—— 同时还有被拒动作时也按不可拆分处理。
        if repeat_at and engine_at:
            units = None
        for ui in {pairs[i][0] for i in repeat_at}:
            if any(pairs[i][0] == ui for i in confirm_at + engine_at):
                units = None
                break

        if unattended_at:
            # 没人能点头：这一次里还有没人确认的动作 → 整条不执行（不挂到超时）
            for i in unattended_at:
                act = pairs[i][1]
                await file_policy.audit(
                    act, result=file_policy.RESULT_REJECTED, rule="file-write-unattended", **ids
                )
            note_denied(
                call_id,
                reason="这一轮没有人在看着（定时/无人值守），所以没有执行这条命令里的写入",
                rule="file-write-unattended",
            )
            return PermissionDecision(
                behavior=PermissionBehavior.DENY,
                message=(
                    "这一轮没有人在看着（定时/无人值守），所以没有执行这条命令里的写入。"
                    "需要它这么做的话，让用户手动跑一次并在确认卡上点头，或者在设置里打开危险模式。"
                ),
                decision_reason="file-write-unattended",
            )

        # 被拒的那几段：先去重（同一条命令里可能重复写同一个文件）
        drop_units: set[int] = set()
        blocked_acts: list[file_policy.Action] = []
        for i in repeat_at:
            ui, act = pairs[i]
            drop_units.add(ui)
            if all(getattr(act, "path", "") != getattr(b, "path", "") for b in blocked_acts):
                blocked_acts.append(act)
        blocked_text = "、".join(f"要{a.op} {a.path}" for a in blocked_acts)

        # 不能安全拆分（heredoc / `||` / 括号不平衡）又同时含「已拒绝 + 新动作」：
        # 整条执行会把被拒的那个再做一遍 → 只能整条拦下，并让模型把新动作单独发起
        # （下一次调用会得到它自己的确认卡）。半拆半执行比不执行更糟。
        if repeat_at and (confirm_at or engine_at) and units is None:
            _why = (
                f"这条命令里有你在本会话里拒绝过的动作（{blocked_text}），"
                "而它和新动作连在同一条命令里、没法只跑后半段，所以整条没有执行"
            )
            note_reason(call_id, _why)
            note_denied(call_id, reason=_why, rule="denied-repeat", source="repeat")
            logger.warning("文件权限：命令不可拆分且含已拒绝动作，整条拦下（%s）", blocked_text)
            return PermissionDecision(
                behavior=PermissionBehavior.DENY,
                message=(
                    f"{_why}。平台没有弹卡、也没有再记一条「用户拒绝」。"
                    "要做的那个新动作请**单独发起一次**（不要和被拒的那步连在一起），"
                    "它会得到自己的确认卡；被拒的那个不要再试。"
                ),
                decision_reason="file-write-denied-repeat",
            )

        trimmed = ""
        if repeat_at and units:
            trimmed = file_policy.join_units(
                units, [i for i in range(len(units)) if i not in drop_units]
            )

        # ── 没有需要确认的：能跑的跑，被拒的跳过，模型收到说明 ────────────
        if not confirm_at:
            if engine_at and not repeat_at:
                return None  # 全交给引擎（只读助手的情况）
            if repeat_at:
                notice = (
                    f"【平台】这条命令里有你在本会话拒绝过的动作，已拦下没有执行：{blocked_text}。"
                    "其余部分正常执行了。不要再试这一步，除非用户明确要求重做。"
                )
                note_reason(call_id, notice)
                note_denied(call_id, reason=blocked_text, rule="denied-repeat", source="repeat")
                if not trimmed:
                    # 拆不出一段可执行的（整条都落在被拒的动作上）→ 整条不执行
                    logger.warning("文件权限：整条命令都落在已拒绝的动作上，不执行（%s）", blocked_text)
                    return PermissionDecision(
                        behavior=PermissionBehavior.DENY,
                        message=(
                            f"这个动作你在本会话里拒绝过：{blocked_text}。"
                            "平台按拒绝名单拦下了，没有执行、也没有再弹卡。"
                            "除非用户在新消息里明确要求重做这个动作，否则不要再试。"
                        ),
                        decision_reason="file-write-denied-repeat",
                    )
                # 命令里还有可执行的部分 → 改写后执行（不能整条跑，会把被拒的再做一遍）
                note_trim(call_id, trimmed, notice)
                logger.warning("文件权限：按拒绝名单跳过一段后执行剩余部分（%s）", blocked_text)
                return PermissionDecision(
                    behavior=PermissionBehavior.ALLOW,
                    message="其余部分可以执行；被拒绝的动作已拦下。",
                    decision_reason="file-write-partial-allow",
                )
            return None

        # ── 有需要确认的：卡上只写这次要动的位置（被拒的不再出现在卡上）────
        first = pairs[confirm_at[0]][1]
        confirm_acts = [pairs[i][1] for i in confirm_at]
        detail = first.as_dict()
        detail["agent"] = await file_policy.agent_name(ids["agent_id"])
        detail["agent_id"] = ids["agent_id"]
        detail["workspace"] = ctx.get("workspace") or self._workspace or ""
        detail["dir"] = os.path.dirname(str(detail.get("path") or ""))
        # 这张卡一共覆盖哪些目标：拒绝时要把**每一个**都记进拒绝名单，
        # 免得下一轮模型换个写法再拿同一个文件来问一遍（需求 1）。
        detail["actions"] = [
            a.as_dict() for a in [*confirm_acts, *[pairs[i][1] for i in range(len(pairs)) if kinds[i] == "workspace"]]
        ]
        note_file_action(call_id, detail)

        targets = "、".join(f"{a.op} {a.path}" for a in confirm_acts)
        why = f"要{first.op} {first.path}" if len(confirm_acts) == 1 else f"这条命令要动 {len(confirm_acts)} 个位置：{targets}"
        if repeat_at:
            why += f"（另外一部分已按本会话的拒绝名单拦下，不会执行：{blocked_text}）"
        note_reason(call_id, why)
        if trimmed:
            note_trim(
                call_id,
                trimmed,
                f"【平台】这条命令里有你在本会话拒绝过的动作，已拦下没有执行：{blocked_text}。"
                "其余部分按用户确认执行了。不要再试这一步，除非用户明确要求重做。",
            )
        logger.info("文件权限：多目标写入要确认（%s）", targets)
        return PermissionDecision(
            behavior=PermissionBehavior.ASK,
            message=f"{why} —— 这个位置在当前会话目录之外，需要你点头",
            decision_reason=guardrails.FILE_WRITE_RULE,
            bypass_immune=True,
        )

    async def on_check_permission(self, agent, input_kwargs: dict, next_handler):  # type: ignore[override]
        if not self.enabled:
            return await next_handler()

        tool_call = input_kwargs.get("tool_call")
        tool_input = input_kwargs.get("tool_input") or {}
        name = getattr(tool_call, "name", "") or ""
        # 延迟加载时真名在参数里（{"name": "...", "arguments": {...}}），
        # 不拆开就会拿 "tool_call" 去判权限 → 每个只读调用都要人点一次允许。
        name, tool_input = self._unwrap_tool_call(name, tool_input)

        call_id = str(getattr(tool_call, "id", "") or "")
        # 工作目录优先取本 run 的（compile 时还不知道会话目录），退到编译期给的
        ws = current_run_ctx().get("workspace") or self._workspace or ""
        read_scope: list[str] = ([ws] if ws else []) + list(self._read_roots)
        #: 引擎口径的写范围（会话目录 + 助手自己申请的额外根）—— 只用来决定"要不要
        #: 交回引擎"，**不再决定文件权限**：用户第 3 条说的是"只有当前会话的工作
        #: 目录内免确认"，助手自己申请的额外根目录不算（那是"允许它去"，不是"不用问"）。
        engine_scope: str | list[str] = ([ws] if ws else []) + list(self._roots)
        if len(engine_scope) == 1:
            engine_scope = engine_scope[0]

        # ── 0) 禁区（~/.hermes）：最先判，任何模式/任何放行都压不住 ──────────
        # 必须排在"只读直接放行"前面：读不限制是第 2 条，禁区是第 1 条的例外。
        blocked = guardrails.classify_protected(name, tool_input, read_scope or engine_scope)
        if blocked is not None:
            await self._audit_blocked(name, tool_input, blocked, ws)
            note_reason(call_id, blocked.reason)
            # 归因要记牢：这是**平台拦的**，不是用户点的拒绝（收尾文案靠它）
            note_denied(call_id, reason=blocked.reason, rule=blocked.rule)
            logger.warning("安全闸门：触碰禁区（%s）：%s", name, blocked.snippet)
            return PermissionDecision(
                behavior=PermissionBehavior.DENY,
                message=f"已拦截：{blocked.reason}。要里面的内容请让用户贴给你。",
                decision_reason=blocked.rule,
            )

        # 平台黑名单：任何模式、任何放行都拦 —— 所以放在最前面（禁区之后）：
        # 越界写要走确认卡，但"确认卡"不能变成绕过黑名单的路子。
        early_text = self._command_text(tool_input)
        if early_text:
            hit = next((p for p in self._deny_patterns if p in early_text), "")
            if hit:
                logger.warning("安全闸门：命中平台黑名单 %r，拒绝（%s）", hit, early_text[:120])
                note_reason(call_id, f"命中平台黑名单：{hit}")
                note_denied(
                    call_id,
                    reason=f"命令命中平台黑名单「{hit}」（平台统一配置，助手无法绕过）",
                    rule=f"platform-deny:{hit}",
                )
                return PermissionDecision(
                    behavior=PermissionBehavior.DENY,
                    message=f"已拦截：命令命中平台黑名单「{hit}」。这条由平台统一配置，助手无法绕过。",
                    decision_reason=f"platform-deny:{hit}",
                )

        # 用户已经点过「允许」的那一次调用，别再造一次确认 —— 中间件排在引擎前面，
        # 引擎本该在这里短路（state=allowed），但我们先跑了，不认这个状态就会
        # 无限循环：允许 → 又问 → 允许 → 又问（实测踩到）。
        state = getattr(tool_call, "state", "")
        state = getattr(state, "value", state)
        if str(state) in ("allowed", "submitted", "finished"):
            return await next_handler()

        # ── 1) 读：除禁区外不限制、不要确认（用户第 2 条）──────────────────
        # 只读的原生工具 + AgentScope 内置的读文件工具（Read/Glob/Grep）。
        # 引擎在 default 模式下每个操作都问；用户要的是"读别处别打扰我"，
        # 所以这里直接放行。唯一例外：助手自己配了针对这个工具的显式拒绝规则
        # —— 那是用户亲手加的边界，不能替他拆。
        short_name = _norm(name)
        if name in _READ_ONLY_NATIVE or short_name in file_policy.FILE_READ_TOOLS:
            if not self._engine_has_deny(agent, name):
                # 读也要留痕：工作区之外的成功读记一条（工作区内的不记）
                await self._audit_read(name, tool_input, ws)
                return PermissionDecision(
                    behavior=PermissionBehavior.ALLOW,
                    message="读文件不限制（禁区除外），直接执行。",
                    decision_reason="read-unrestricted",
                )

        # ── 2) 写：文件类工具在这里定；命令/代码先过破坏性规则再定 ──────────
        # 顺序很要命：`rm -rf /` 这种先被命令规则判成 DENY，绝不能因为"它也是
        # 一次写文件"被降级成"问你一句"。
        if short_name in file_policy.FILE_WRITE_TOOLS:
            act = guardrails.file_action_for(name, tool_input, ws or None)
            if act is not None:
                return await self._decide_write(
                    act,
                    agent=agent,
                    tool_name=name,
                    call_id=call_id,
                    next_handler=next_handler,
                    text=self._command_text(tool_input),
                )
            # 解析不出路径（工具签名变了？）→ 不当作没事，交回引擎问
            return await next_handler()

        verdict = guardrails.classify_tool_call(name, tool_input, engine_scope, read_scope)

        # ── 1.5) 一条命令里有多个文件动作：逐个裁决（需求 2：不许整包连坐）────
        # 现场（2026-11）：让助手写新文件 B，它把**已被拒绝**的 A 打包进同一条命令，
        # 平台一看见 A 就整包拦下 —— B 连自己的确认卡都没得到。这里按动作分类：
        # 被拒的单独拦、新的照常弹卡（能拆分的把被拒那几段剔掉再执行）。
        # DENY 除外：`rm -rf / && printf > B` 里的 rm 是规则级一票否决，绝不能
        # 因为"顺手把 B 写了"被放过（DENY 照旧走下面的原有分支）。
        if not (verdict is not None and verdict.risk == guardrails.RISK_DENY):
            if short_name in file_policy.COMMAND_TOOLS or short_name in file_policy.CODE_TOOLS:
                _acts = guardrails.file_actions_for(name, tool_input, ws or None)
                if len(_acts) >= 2:
                    _multi = await self._decide_writes(
                        _acts,
                        agent=agent,
                        tool_name=name,
                        call_id=call_id,
                        next_handler=next_handler,
                        text=self._command_text(tool_input),
                    )
                    if _multi is not None:
                        return _multi

        if verdict is None or verdict.risk == guardrails.RISK_ALLOW:
            # 只读命令（cat/ls/grep…）同样要留痕 —— 判类型用的是"读"
            await self._audit_read(name, tool_input, ws)
            return await next_handler()
        if verdict.risk == guardrails.RISK_ASK and verdict.rule == guardrails.FILE_WRITE_RULE:
            _acts = guardrails.file_actions_for(name, tool_input, ws or None)
            if len(_acts) >= 2:
                return await self._decide_writes(
                    _acts,
                    agent=agent,
                    tool_name=name,
                    call_id=call_id,
                    next_handler=next_handler,
                    text=verdict.snippet or self._command_text(tool_input),
                )
            act = _acts[0] if _acts else None
            if act is not None:
                return await self._decide_write(
                    act,
                    agent=agent,
                    tool_name=name,
                    call_id=call_id,
                    next_handler=next_handler,
                    text=verdict.snippet or self._command_text(tool_input),
                )

        text = self._command_text(tool_input)
        if (
            verdict.risk == guardrails.RISK_ASK
            and verdict.rule != guardrails.FILE_WRITE_RULE
            and run_allowed(str(current_run_ctx().get("run_id") or ""), name, rule=str(verdict.rule))
        ):
            # 本次运行里用户已经点过「允许」这个工具 —— 不再重复弹。
            # 循环调用同一个工具（实测：worker_status 被连问十几次）时这是唯一有
            # 效的止损；DENY 在前面就拦住了，这里放掉的只是 ASK。
            # **不含越界写**：用户点的是"允许这一次写这个文件"，不是"这一轮随便写"
            # （用户第 5 条的按钮就叫「允许一次」）。
            logger.info("安全闸门：本次运行已允许 %s，直接放行（%s）", name, verdict.rule)
            return PermissionDecision(
                behavior=PermissionBehavior.ALLOW,
                message="本次运行内已允许这个工具。",
                decision_reason=f"{verdict.rule}-run-allow",
            )
        if (
            verdict.risk == guardrails.RISK_ASK
            and verdict.rule != guardrails.FILE_WRITE_RULE
            and name in self._session_allow
        ):
            # 「本会话内不再问这类操作」生效点。必须**直接 ALLOW 短路**，
            # 不能 next_handler() 交给引擎：引擎里的 Bash 内建检查对
            # rm -rf 等发的是 bypass_immune ASK（allow 规则压不住），
            # 交回去等于白放行 —— 用户勾了「不再问」还会每次再问（实测踩到）。
            # 短路安全：能走到这的 verdict 已是 ASK（DENY 在后面拦着），不存在
            # 「放掉了本该 DENY 的」。
            # 越界写不在此列：那个确认是按次问的（要整目录放行走「允许该目录」）。
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
        # 全部放行 = **真的全部放行**（用户明确口径：选了它就别再问）。
        # 以前这里把"越界写 / 读到范围外"排除在外，理由是他早期说过"工作目录外一律确认"；
        # 现在他把两件事分开了：权限模式管"问不问"，黑名单管"能不能"。
        # DENY（平台黑名单、凭据路径）在后面照旧拦，不受这里影响。
        if (
            verdict.risk == guardrails.RISK_ASK
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
            await self._audit_blocked(name, tool_input, verdict, ws)
            note_denied(call_id, reason=verdict.reason, rule=verdict.rule)
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

    # ------------------------------------------------------------------ #
    # 执行前改写入参：把「已被用户拒绝的那几段」从命令里去掉
    # ------------------------------------------------------------------ #
    async def on_acting(self, agent, input_kwargs: dict, next_handler):
        """执行阶段的小手术：只跑**可执行的那几段**，并把被拦的告诉模型。

        为什么不能在权限层改：AgentScope 给中间件的 ``tool_call``/``tool_input``
        是深拷贝（源码注释写明"middleware cannot mutate what the agent consumes
        later"），改了执行时也看不到。真正执行前（``on_acting``）拿到的才是
        ``toolkit.call_tool`` 会用的那一份。

        没有改写计划时原样透传（绝大多数调用走这条）。
        """
        tool_call = input_kwargs.get("tool_call")
        call_id = str(getattr(tool_call, "id", "") or "")
        command, note = pop_trim(call_id)
        if not command:
            async for item in next_handler():
                yield item
            return

        raw = getattr(tool_call, "input", "")
        try:
            import json

            data = json.loads(raw) if isinstance(raw, str) else dict(raw or {})
            data["command"] = command
            tool_call.input = json.dumps(data, ensure_ascii=False)
            logger.warning("文件权限：执行前改写命令（去掉已拒绝的那一段）：%s", command[:200])
        except Exception:  # noqa: BLE001 —— 改不动就按原命令跑（拒绝名单在权限层已拦过）
            logger.warning("文件权限：改写命令失败，按原样执行", exc_info=True)
            note = ""

        if not note:
            async for item in next_handler():
                yield item
            return

        # 给模型留一句说明：哪一步被拦下了、没有执行（否则它以为整条都跑成功了）
        from agentscope.message import TextBlock
        from agentscope.tool import ToolResponse

        async for item in next_handler():
            if isinstance(item, ToolResponse):
                try:
                    item = ToolResponse(
                        content=[*item.content, TextBlock(type="text", text=note)],
                        state=item.state,
                        metadata=item.metadata,
                        id=item.id,
                    )
                except Exception:  # noqa: BLE001 —— 拼不上就少一句说明，别毁了工具结果
                    logger.warning("文件权限：给工具结果补说明失败", exc_info=True)
            yield item
