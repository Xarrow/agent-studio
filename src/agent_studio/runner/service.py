"""Run 编排服务 —— 编译、执行、落库、广播（SSE）。"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
import zlib
from typing import Any

from sqlalchemy import select

from ..config import settings
from ..context import append_turn, build_turn_context, compress_if_needed, run_dialogue
from ..db import SessionLocal
from ..memory import (
    get_policy,
    mark_hit,
    parse_candidates,
    dedupe as dedupe_candidates,
    call_llm as call_extract_llm,
)
from ..memory.extract import build_user_prompt
from ..models import (
    Agent,
    AgentSkill,
    AgentTool,
    LlmCall,
    Memory,
    Run,
    RunEvent,
    Secret,
    Skill,
    Tool,
    ToolCall,
    now_ms,
)
from ..providers import get_provider
from ..runtimes import get_runtime
from ..runtimes.base import HitlResponse, TurnContext, UnifiedEvent
from ..schemas import AgentDefinition, MemoryPolicyRead, ToolSpec
from ..security.crypto import decrypt
from .metrics import MetricsCollector

logger = logging.getLogger(__name__)

#: Run 的终态（与 api/runs.py 的 TERMINAL_STATUSES 保持同义；
#: 这里单独定义是为了不让 runner 反向依赖 api 层）
RUN_TERMINAL: frozenset[str] = frozenset({"ok", "error", "aborted"})

#: 在途（尚未收尾）的状态。这些状态的记录**必须**有人在内存里推进它。
RUN_IN_FLIGHT: frozenset[str] = frozenset({"pending", "running", "waiting_hitl"})


async def reap_orphan_runs(boot_ms: int) -> int:
    """把「本进程启动前就处于在途状态」的执行记录判为中断。

    为什么必须做
    ------------
    执行状态存在数据库里，但**推进它的协程在内存里**。服务一重启（部署、
    崩溃、手动重启），那些记录仍停在 ``running`` / ``waiting_hitl``，而协程
    已经不存在了 —— 于是陷入死结：

      · Runs 页永远转圈（● running 一直亮，哪怕已经过去十几个小时）
      · 「中断」按钮无效：它要操作内存里那个早已消失的任务
      · 「删除」被拒：界面对在途状态一律不许删（"运行中的记录需先中断"）
      → **卡死，在界面上谁也清不掉**。重启一次服务就中招，真实可复现。

    判定依据（保守、安全）
    ----------------------
    ``started_at`` 早于本进程启动时间的在途记录，其协程必然已经不存在 ——
    不可能还有人在推进它，所以标记为中断是准确的，不会误伤刚提交的新执行。
    ``waiting_hitl`` 也一并回收：人工确认靠内存里的事件唤醒，重启后同样失效
    （留着只会是一条永远等不到回应、又删不掉的记录）。

    返回回收条数。
    """
    async with SessionLocal() as session:
        rows = (
            (
                await session.execute(
                    select(Run).where(
                        Run.status.in_(RUN_IN_FLIGHT),
                        Run.started_at.is_not(None),
                        Run.started_at < boot_ms,
                    )
                )
            )
            .scalars()
            .all()
        )
        if not rows:
            return 0
        now = now_ms()
        for r in rows:
            was = r.status
            r.status = "error"
            r.pending_hitl = None
            # **不设 ended_at**：我们并不知道它究竟何时停的（进程是被重启带走的）。
            # 早先这里写成 `= now`，结果列表里出现"耗时 13 小时"这种荒唐数字 ——
            # 那是回收时刻减开始时刻，跟真实执行时长毫无关系。
            # 留 None，展示层会显示"—"，比编一个假数字诚实。
            r.ended_at = None
            r.error = (
                f"执行被中断：服务在它运行期间重启了（原状态 {was}）。"
                "这条记录由启动时的自动回收标记，现在可以正常删除。"
            )
        await session.commit()
        logger.warning("回收 %d 条因服务重启而中断的执行记录", len(rows))
        return len(rows)


def query_text(run_input: Any) -> str:
    """把 run_input 转成用于召回打分的查询文本。"""
    if isinstance(run_input, str):
        return run_input
    if isinstance(run_input, dict):
        return str(run_input.get("text") or run_input)
    return str(run_input)


def _default_base_url(definition: AgentDefinition) -> str | None:
    """端点兜底：定义 ＞ 服务商元数据里的默认。

    原来这里**写死** ``https://api.deepseek.com/v1`` —— 于是非 DeepSeek 的助手
    （比如火山引擎）在做历史压缩、记忆提炼时会打到 DeepSeek 去。
    """
    if definition.model.base_url:
        return definition.model.base_url
    meta = get_provider(definition.model.provider)
    return meta.default_base_url if meta else None


# --------------------------------------------------------------------------- #
# 事件总线（SSE 实时推送）
# --------------------------------------------------------------------------- #
class EventBus:
    """按 run_id 分发的内存 pub/sub。

    订阅者（SSE 连接）拿到队列；Run 结束后收到 ``None`` 哨兵。
    """

    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue]] = {}

    def subscribe(self, run_id: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=2000)
        self._subs.setdefault(run_id, set()).add(queue)
        return queue

    def unsubscribe(self, run_id: str, queue: asyncio.Queue) -> None:
        subs = self._subs.get(run_id)
        if subs is not None:
            subs.discard(queue)
            if not subs:
                self._subs.pop(run_id, None)

    def publish(self, run_id: str, event: dict[str, Any]) -> None:
        for queue in list(self._subs.get(run_id, ())):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:  # pragma: no cover
                logger.warning("SSE 队列满，丢弃事件 run=%s", run_id)

    def close(self, run_id: str) -> None:
        for queue in list(self._subs.get(run_id, ())):
            try:
                queue.put_nowait(None)
            except asyncio.QueueFull:  # pragma: no cover
                pass


bus = EventBus()


# --------------------------------------------------------------------------- #
# 辅助
# --------------------------------------------------------------------------- #
def resolve_work_dir(definition: Any) -> Path:
    """把「这个助手的工作目录」解析成绝对路径，需要时建出来。

    **安全边界就在这里**：workspace 只能是平台沙箱根目录下的子目录名 ——
    绝对路径、``..``、解析后越出沙箱的，一律记 warning 并回退平台默认目录。
    这不是洁癖：目录就是权限边界（accept_edits 放行的正是"工作目录内"），
    能跳出目录，权限 scope 就形同虚设。
    """
    root = Path(settings.work_dir).resolve()
    raw = str(getattr(definition, "workspace", "") or "").strip()
    if not raw:
        return root
    # 先按**用户原样**判非法，再规整：否则 "/tmp/x" 会被 strip 成 "tmp/x"
    # 静默当成子目录 —— 没逃出沙箱，但和用户写的语义不符，不如明确拒绝。
    if os.path.isabs(raw) or ".." in Path(raw).parts:
        logger.warning("助手工作目录非法（%r），回退平台默认", raw)
        return root
    name = raw.strip("/")
    if not name:
        return root
    target = (root / name).resolve()
    if target != root and root not in target.parents:
        logger.warning("助手工作目录越出沙箱（%r），回退平台默认", name)
        return root
    target.mkdir(parents=True, exist_ok=True)
    return target


async def resolve_api_key(definition: AgentDefinition, session: Any) -> str | None:
    """只取 key、不要端点。

    ⚠️ **执行路径请用 ``resolve_credential``** —— 只取 key 会把凭据上配的
    base_url 丢掉，退回到框架自带默认端点。火山方舟那类"按套餐分端点"的 key
    （只受理 ``/api/plan/v3``）就会 401，而且症状是"第一轮正常、续跑才报 key 无效"，
    极难往端点方向想。留这个薄封装只为确实不需要端点的调用方。
    """
    key, _ = await resolve_credential(definition, session)
    return key


async def resolve_credential(
    definition: AgentDefinition, session: Any
) -> tuple[str | None, str | None]:
    """解析执行凭据：返回 ``(api_key, base_url)``。

    为什么 base_url 必须跟 key 一起解析
    ----------------------------------
    有些服务商的 key 是**分套餐/分区域**的，端点不同 —— 典型是火山引擎方舟的
    Agent Plan key：它只受理 ``/api/plan/v3``，打到 ``/api/v3`` 直接 401。
    "这把 key 该往哪个端点打"属于**凭据的属性**，所以 base_url 配在凭据上。

    但执行路径原来只看 ``definition.model.base_url``（助手定义里通常是空的），
    于是退回到框架自带的默认端点，**凭据上配好的 base_url 被完全无视**。
    症状特别有迷惑性：配置页「测试连接」是通的（那条路径确实用了凭据的
    base_url），一执行就 401 —— 让人以为 key 坏了。

    优先级：助手定义里显式写的 base_url ＞ 凭据上的 base_url。
    """
    if definition.model.api_key:
        return definition.model.api_key, definition.model.base_url
    if definition.model.credential_ref:
        secret = await session.get(Secret, definition.model.credential_ref)
        if secret is not None:
            return (
                decrypt(secret.ciphertext),
                secret.base_url or definition.model.base_url,
            )
    return os.environ.get("STUDIO_DEFAULT_API_KEY"), definition.model.base_url


def _with_base_url(definition: AgentDefinition, base_url: str | None) -> AgentDefinition:
    """把解析出的 base_url 补进定义（定义里已有则不覆盖）。

    补在定义上，是为了让**三条用到端点的路径**都拿到正确的值：
    模型编译、历史压缩、记忆提炼 —— 它们原来各自读
    ``definition.model.base_url``，值不对就一起错。
    """
    if not base_url or definition.model.base_url:
        return definition
    return definition.model_copy(
        update={"model": definition.model.model_copy(update={"base_url": base_url})}
    )


async def load_tools(session: Any, agent_id: str) -> list[ToolSpec]:
    """加载 Agent 挂载的工具，并转成**平台中立**的 ToolSpec。

    这里是 ORM → DTO 的唯一转换点：运行时适配器只会看到 ToolSpec，
    因此不依赖数据库结构。
    """
    stmt = (
        select(Tool)
        .join(AgentTool, AgentTool.tool_id == Tool.id)
        .where(AgentTool.agent_id == agent_id)
        .order_by(Tool.name)
    )
    rows = list((await session.execute(stmt)).scalars())
    return [ToolSpec.from_row(r) for r in rows]


async def load_skill_rows(session: Any, agent_id: str) -> list[Skill]:
    stmt = (
        select(Skill)
        .join(AgentSkill, AgentSkill.skill_id == Skill.id)
        .where(AgentSkill.agent_id == agent_id)
        .order_by(Skill.name)
    )
    return list((await session.execute(stmt)).scalars())


def compress_payload(obj: Any) -> tuple[bytes, bool]:
    """json → zlib，超限截断。返回 (blob, 是否被截断)。"""
    raw = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
    truncated = len(raw) > settings.llm_payload_limit_bytes
    if truncated:
        raw = raw[: settings.llm_payload_limit_bytes]
    return zlib.compress(raw), truncated


# --------------------------------------------------------------------------- #
# Run 服务
# --------------------------------------------------------------------------- #
class RunService:
    """执行编排：compile → run → 落库 → 广播。

    每个 Run 是一个后台 asyncio task，与 HTTP 请求生命周期解耦 ——
    因此前端可以断线重连（从 run_event 表回放）。
    """

    def __init__(self) -> None:
        self.bus = bus
        self._tasks: dict[str, asyncio.Task] = {}

    # ------------------------------------------------------------------ #
    async def start(self, run_id: str, definition: AgentDefinition, run_input: Any) -> None:
        task = asyncio.create_task(self._execute(run_id, definition, run_input))
        self._tasks[run_id] = task
        task.add_done_callback(lambda _t, rid=run_id: self._tasks.pop(rid, None))

    async def abort(self, run_id: str) -> bool:
        task = self._tasks.get(run_id)
        if task is not None and not task.done():
            task.cancel()
            return True
        return False

    def is_running(self, run_id: str) -> bool:
        task = self._tasks.get(run_id)
        return task is not None and not task.done()

    async def wait(self, run_id: str, timeout: float | None = None) -> Run:
        """等这次执行结束，返回结束时的 Run 快照。

        给编排层（Playground）串联多个 Run 用 —— ``start()`` 是 fire-and-forget
        的，编排需要知道"这一步什么时候能进下一步"。

        两个刻意的设计：
        - **轮询查库而不是等内存里的 asyncio.Task**：子 Run 有可能由另一个
          进程接管（服务重启后继续），查库才是唯一可靠的真相来源。
          0.3 秒间隔对秒级的 LLM 调用完全够。
        - **``waiting_hitl`` 也立即返回**：Playground 不支持中途人工确认，
          与其无限等下去，不如让编排层把这次编排标成 partial 并说明原因。
        """
        deadline = time.monotonic() + timeout if timeout else None
        while True:
            async with SessionLocal() as session:
                run = await session.get(Run, run_id)
                if run is None:
                    raise LookupError(f"Run 不存在: {run_id}")
                if run.status in RUN_TERMINAL or run.status == "waiting_hitl":
                    return run
            if deadline is not None and time.monotonic() > deadline:
                raise TimeoutError(f"等待 Run {run_id} 超时（{timeout}s）")
            await asyncio.sleep(0.3)

    # ------------------------------------------------------------------ #
    async def _execute(self, run_id: str, definition: AgentDefinition, run_input: Any) -> None:
        runtime = get_runtime(definition.runtime)
        collector = MetricsCollector(
            provider=definition.model.provider, model=definition.model.name
        )
        seq = 0
        compiled = None
        status = "ok"
        error: str | None = None
        hitl_payload: dict[str, Any] | None = None
        # 这两个在 try 内赋值，但在 finally 的收尾里要用 —— 先声明避免 unbound
        context: TurnContext | None = None
        api_key: str | None = None

        try:
            async with SessionLocal() as session:
                run = await session.get(Run, run_id)
                if run is None:  # pragma: no cover
                    return
                tools = await load_tools(session, run.agent_id)
                api_key, cred_base_url = await resolve_credential(definition, session)
                # 凭据上的 base_url 必须补进定义 —— 否则 compile / 压缩 / 提炼
                # 都会用错端点（火山引擎 plan key 打 /api/v3 会 401）
                definition = _with_base_url(definition, cred_base_url)
                # 组装上下文：短期记忆（会话历史）+ 长期记忆（召回注入）
                # 注意：这里只产出**平台中立**的 TurnContext，不含任何框架对象
                policy = await get_policy(session, run.agent_id)
                context = await build_turn_context(
                    session,
                    agent_id=run.agent_id,
                    session_id=run.session_id,
                    query=query_text(run_input),
                    policy=policy,
                )
                run.status = "running"
                await session.commit()

            compiled = await runtime.compile(
                definition,
                api_key=api_key,
                tools=tools,
                agent_id=run.agent_id,
                work_dir=str(resolve_work_dir(definition)),
                context=context,
            )

            timeout = definition.limits.timeout_s or settings.default_timeout_s

            async def consume() -> None:
                nonlocal seq, status, hitl_payload
                async for ev in runtime.run(compiled, run_input):
                    ev = ev.model_copy(update={"run_id": run_id, "seq": seq})
                    seq += 1
                    collector.on_event(ev)
                    await self._persist_event(run_id, ev)
                    self.bus.publish(run_id, ev.model_dump(mode="json", exclude={"raw"}))
                    # 注意：**不能**在 run_end 时提前 return —— AgentScope 在
                    # ReplyEndEvent 之后还会 yield 一个最终 Msg
                    # （reply_stream(yield_final_msg=True)），提前退出会丢掉它，
                    # 导致 run.output 为空。让它自然结束即可。
                    if ev.type == "hitl_request":
                        status = "waiting_hitl"
                        hitl_payload = dict(ev.payload)

            await asyncio.wait_for(consume(), timeout=timeout)

            if status == "waiting_hitl":
                async with SessionLocal() as session:
                    run = await session.get(Run, run_id)
                    run.status = "waiting_hitl"
                    run.pending_hitl = hitl_payload or {}
                    # 状态快照必须**赶在 dispose 之前**取 —— dispose 会收掉编译产物，
                    # 而"我在等谁确认"这件事只记在它体内。恢复时靠它把新 agent
                    # 带回同一个处境，否则确认结果会被拒。
                    run.pending_state = (
                        runtime.snapshot_state(compiled) if compiled is not None else None
                    )
                    await session.commit()
                return

        except asyncio.CancelledError:
            status, error = "aborted", "用户中断"
        except TimeoutError:
            status, error = "error", f"执行超时（>{definition.limits.timeout_s}s）"
        except Exception as exc:
            logger.exception("Run %s 失败", run_id)
            status, error = "error", f"{type(exc).__name__}: {exc}"
        finally:
            if compiled is not None:
                try:
                    await runtime.dispose(compiled)
                except Exception:  # pragma: no cover
                    logger.debug("dispose 失败", exc_info=True)
            # 先落终态（写 output / usage），再做收尾（会话历史、记忆）
            await self._finalize(run_id, collector, compiled, status, error)
            await self._post_run(run_id, definition, context, api_key)
            self.bus.close(run_id)

    # ------------------------------------------------------------------ #
    async def _post_run(
        self,
        run_id: str,
        definition: AgentDefinition,
        context: TurnContext | None,
        api_key: str | None,
    ) -> None:
        """执行收尾 —— 会话历史、上下文压缩、记忆命中统计、自动沉淀。

        全部包在 try 里：**收尾失败不能影响 Run 本身的终态**（Run 已经成
        功/失败了，记忆或会话写不进去是次要问题，记日志即可）。
        """
        try:
            async with SessionLocal() as session:
                run = await session.get(Run, run_id)
                if run is None:  # pragma: no cover
                    return

                # 1) 多轮会话：把这一轮问答写入历史
                if run.session_id:
                    user_text, assistant_text = await run_dialogue(run)
                    await append_turn(
                        session,
                        session_id=run.session_id,
                        run_id=run_id,
                        user_text=user_text,
                        assistant_text=assistant_text,
                        usage=run.usage or {},
                    )
                    # 2) 轮次超阈值时压缩较早历史（防上下文爆炸）
                    policy = await get_policy(session, run.agent_id)
                    if api_key and policy.compress_after_turns > 0:
                        await compress_if_needed(
                            session,
                            session_id=run.session_id,
                            threshold_turns=policy.compress_after_turns,
                            base_url=_default_base_url(definition),
                            api_key=api_key,
                            model=definition.model.name,
                        )
                else:
                    policy = await get_policy(session, run.agent_id)

                # 3) 记忆命中统计（热度衰减依据）
                if context is not None and context.memory_ids:
                    await mark_hit(session, context.memory_ids)
                    await session.commit()

                # 4) 自动沉淀（按策略；落候选态，等用户确认）
                if policy.auto_extract and run.status == "ok" and api_key:
                    await self._auto_extract(session, run, definition, api_key, policy)
        except Exception:  # pragma: no cover - 收尾不影响主流程
            logger.warning("Run %s 收尾处理失败", run_id, exc_info=True)

    async def _auto_extract(
        self,
        session: Any,
        run: Run,
        definition: AgentDefinition,
        api_key: str,
        policy: MemoryPolicyRead,
    ) -> None:
        """自动沉淀：从本次执行提炼记忆，**一律进候选态**。

        为什么强制候选态：自动提炼难免有噪音，如果直接 active 就会污染
        后续召回。先进候选区、由用户确认，才能"自动化但不失控"。
        """
        try:
            raw = await call_extract_llm(
                base_url=_default_base_url(definition),
                api_key=api_key,
                model=policy.extract_model or definition.model.name,
                user_prompt=build_user_prompt(run.input, run.output),
            )
        except Exception:  # pragma: no cover
            logger.warning("自动沉淀失败 run=%s", run.id, exc_info=True)
            return

        candidates = parse_candidates(raw)
        if not candidates:
            return
        kept, _skipped = await dedupe_candidates(session, run.agent_id, candidates)
        ts = now_ms()
        for c in kept:
            session.add(
                Memory(
                    agent_id=run.agent_id,
                    scope="agent",
                    kind=c.kind,
                    content=c.content,
                    source="auto",
                    source_run_id=run.id,
                    status="candidate",
                    importance=0.5,
                    created_at=ts,
                    updated_at=ts,
                )
            )
        await session.commit()

    # ------------------------------------------------------------------ #
    async def resume(self, run_id: str, hitl: HitlResponse) -> bool:
        """HITL 恢复：读出定义快照 + 待确认载荷，继续跑。"""
        async with SessionLocal() as session:
            run = await session.get(Run, run_id)
            if run is None or run.status != "waiting_hitl":
                return False
            definition = AgentDefinition.model_validate(run.definition_snapshot)
            payload = dict(run.pending_hitl or {})
            run.status = "running"
            run.pending_hitl = None
            await session.commit()

        hitl.payload = {**payload, **(hitl.payload or {})}
        task = asyncio.create_task(self._resume_execute(run_id, definition, hitl))
        self._tasks[run_id] = task
        task.add_done_callback(lambda _t, rid=run_id: self._tasks.pop(rid, None))
        return True

    async def _resume_execute(
        self, run_id: str, definition: AgentDefinition, hitl: HitlResponse
    ) -> None:
        runtime = get_runtime(definition.runtime)
        collector = MetricsCollector(
            provider=definition.model.provider, model=definition.model.name
        )
        # 续接已有 seq
        async with SessionLocal() as session:
            stmt = select(RunEvent.seq).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.desc()).limit(1)
            last = (await session.execute(stmt)).scalar_one_or_none()
            seq = (last or -1) + 1
            run = await session.get(Run, run_id)
            tools = await load_tools(session, run.agent_id)
            # 续跑（人工确认之后）也必须**连 base_url 一起**解析凭据：
            # 只看 api_key 的话，凭据上配的端点会被丢掉，退回框架自带默认端点 ——
            # 火山方舟的 Agent Plan key 打到 /api/v3 直接 401，
            # 症状是"第一轮正常、点了允许续跑就报 key 无效"，极难往端点方向想。
            # 与正常执行路径（见 resolve_credential 的说明）保持同一套解析。
            api_key, _cred_base_url = await resolve_credential(definition, session)
            definition = _with_base_url(definition, _cred_base_url)

        compiled = None
        status, error = "ok", None
        try:
            compiled = await runtime.compile(
                definition, api_key=api_key, tools=tools,
                agent_id=run.agent_id, work_dir=str(resolve_work_dir(definition)),
            )
            # 把暂停那一刻的状态装回去 —— 否则新编译的 agent 不认为自己
            # 有待确认的调用，AgentScope 会直接拒绝确认事件
            # （表现：点了「允许」却报 Agent is not waiting for user confirmation）
            async with SessionLocal() as session:
                _run = await session.get(Run, run_id)
                _snap = (_run.pending_state if _run else None) or None
            if _snap:
                await runtime.restore_state(compiled, _snap)
                # 已装回内存，落库那份可以清掉（再次暂停会重新写）
                async with SessionLocal() as session:
                    _run = await session.get(Run, run_id)
                    if _run is not None:
                        _run.pending_state = None
                        await session.commit()

            timeout = definition.limits.timeout_s or settings.default_timeout_s

            async def consume() -> None:
                nonlocal seq, status
                async for ev in runtime.resume(compiled, hitl):
                    ev = ev.model_copy(update={"run_id": run_id, "seq": seq})
                    seq += 1
                    collector.on_event(ev)
                    await self._persist_event(run_id, ev)
                    self.bus.publish(run_id, ev.model_dump(mode="json", exclude={"raw"}))
                    # 同上：不提前 return，保证最终 Msg 被消费
                    if ev.type == "hitl_request":
                        status = "waiting_hitl"

            await asyncio.wait_for(consume(), timeout=timeout)
        except asyncio.CancelledError:
            status, error = "aborted", "用户中断"
        except Exception as exc:  # pragma: no cover
            logger.exception("Run %s 恢复失败", run_id)
            status, error = "error", f"{type(exc).__name__}: {exc}"
        finally:
            if compiled is not None:
                try:
                    await runtime.dispose(compiled)
                except Exception:  # pragma: no cover
                    pass
            await self._finalize(run_id, collector, compiled, status, error)
            self.bus.close(run_id)

    # ------------------------------------------------------------------ #
    async def _persist_event(self, run_id: str, ev: UnifiedEvent) -> None:
        async with SessionLocal() as session:
            session.add(
                RunEvent(
                    run_id=run_id,
                    seq=ev.seq,
                    type=ev.type,
                    payload=ev.payload,
                    ts=ev.ts,
                    raw=ev.raw,
                )
            )
            await session.commit()

    async def _finalize(
        self,
        run_id: str,
        collector: MetricsCollector,
        compiled: Any,
        status: str,
        error: str | None,
    ) -> None:
        ts = now_ms()
        collector.flush_open(ts)
        usage = collector.summary()
        output = getattr(compiled, "last_output", None) if compiled is not None else None

        async with SessionLocal() as session:
            run = await session.get(Run, run_id)
            if run is None:  # pragma: no cover
                return
            if run.status != "waiting_hitl":
                run.status = status
            run.error = error or run.error
            # 合并 usage（HITL 场景下多次 finalize 累加）
            prev = run.usage or {}
            run.usage = {k: (prev.get(k, 0) or 0) + (usage.get(k, 0) or 0)
                         if isinstance(usage.get(k), (int, float)) and k != "ttft_ms_avg"
                         else usage.get(k, prev.get(k))
                         for k in set(prev) | set(usage)}
            if output:
                run.output = output
            if run.status != "waiting_hitl":
                run.ended_at = ts

            for r in collector.llm_calls:
                session.add(
                    LlmCall(
                        run_id=run_id,
                        iteration=r.iteration,
                        provider=r.provider,
                        model=r.model,
                        started_at=r.started_at,
                        ended_at=r.ended_at,
                        duration_ms=r.duration_ms,
                        ttft_ms=r.ttft_ms,
                        tokens_in=r.tokens_in,
                        tokens_out=r.tokens_out,
                        tokens_cache_read=r.tokens_cache_read,
                        status=r.status,
                        error=r.error,
                    )
                )
            for r in collector.tool_calls:
                session.add(
                    ToolCall(
                        run_id=run_id,
                        iteration=r.iteration,
                        tool_name=r.tool_name,
                        args=r.args,
                        call_id=r.call_id,
                        started_at=r.started_at,
                        ended_at=r.ended_at,
                        duration_ms=r.duration_ms,
                        status=r.status,
                        result_size=r.result_size,
                        result_preview=r.result_preview,
                        error=r.error,
                    )
                )
            await session.commit()


run_service = RunService()
