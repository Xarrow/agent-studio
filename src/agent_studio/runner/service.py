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

from sqlalchemy import select, delete

from ..config import settings
from ..quota import check_daily_quota, get_depth_limit
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
    Span,
    Tool,
    ToolCall,
    now_ms,
)
from ..providers import get_provider
from ..runtimes import get_runtime
from ..runtimes.base import HitlResponse, TurnContext, UnifiedEvent
from ..schemas import AgentDefinition, MemoryPolicyRead, ToolSpec
from ..security.crypto import decrypt
from .gate import GateTimeout, backoff_s, gate, is_transient
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
        from .dispatcher import resume_policy

        now = now_ms()
        requeued = 0
        for r in rows:
            was = r.status
            resumed_n = int((r.usage or {}).get("resumed") or 0)
            policy = resume_policy(
                status=was,
                orchestration_id=r.orchestration_id,
                resumed=resumed_n,
                enabled=bool(settings.resume_runs_after_restart),
                max_resume=int(settings.run_max_resume or 0),
            )
            if policy == "requeue":
                # **续跑**：状态回到 pending = 队列里等着，分发器（最多 1 秒）会捡起来。
                # 顺手刷新 started_at —— 否则下一次重启时它又会被判成"重启前的在途"。
                r.status = "pending"
                r.error = None
                r.ended_at = None
                r.started_at = now
                # **不在这里计数**：计数交给真正跑起来的那次（execute(resumed=True)）——
                # 两边都加会让"续跑 1 次"显示成 2 次，那种数字比没有更糟。
                requeued += 1
                continue
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
        if requeued:
            logger.warning(
                "重启续跑：%d 条执行已重新排队（其余 %d 条标中断）", requeued, len(rows) - requeued
            )
        else:
            logger.warning("回收 %d 条因服务重启而中断的执行记录", len(rows))

        # 编排（orchestration）也要收尾：它的推进协程同样随重启消失，不收就永远停在
        # running（界面上一直转圈、还删不掉）。**不自动续跑** —— 从头再跑会把已完成的
        # 步骤重复执行（有副作用更糟）：明确标中断，让用户在画布上重跑。
        from ..models import Orchestration

        stuck = list(
            (
                await session.execute(
                    select(Orchestration).where(
                        Orchestration.status.in_(("pending", "running")),
                        Orchestration.started_at.is_not(None),
                        Orchestration.started_at < boot_ms,
                    )
                )
            ).scalars()
        )
        for o in stuck:
            o.status = "error"
            o.error = (
                "编排被中断：服务在它运行期间重启了。未完成的步骤已标为中断 —— "
                "可以在画布上重新跑一次（已完成的步骤不重复执行）"
            )
        if stuck:
            await session.commit()
            logger.warning("回收 %d 条因服务重启而中断的编排", len(stuck))
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
    specs = [ToolSpec.from_row(r) for r in rows]

    # 「分派」工具的说明里**带上可派的助手名单** —— 不然模型不知道 `agent` 参数该填谁，
    # 十有八九就派给自己了（用户的目标形态是"编排者开局、把活派给通用助手多路并行"）。
    if any(s.kind == "fork" for s in specs):
        me = (await session.execute(select(Agent.name).where(Agent.id == agent_id))).scalar_one_or_none()
        others = [
            n
            for n in (await session.execute(select(Agent.name).order_by(Agent.created_at))).scalars()
            if n != me
        ]
        hint = "、".join(others) if others else "（还没有别的助手）"
        specs = [
            s.model_copy(
                update={
                    "description": (s.description or "")
                    + f"【可派的助手：{hint}；想派给某个助手就把 agent 填成它的名字，不填=你自己】"
                }
            )
            if s.kind == "fork"
            else s
            for s in specs
        ]
    return specs


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
#: 「等子执行」的封顶：节点上把等待上限写得很大（或写错）时，别让执行真的挂到天亮
FANOUT_WAIT_CAP_S = 3600


def effective_timeout(base_timeout: int, fanout_wait_s: int = 0) -> int:
    """算出这一次执行**真正**的超时时间。

    为什么需要它（现场踩到）
    ----------------------
    节点上有「最长等多久」（默认 15 分钟），而助手的执行超时（``limits.timeout_s``）可能是 2 分钟。
    两句配置互相矛盾时，现实里**执行超时先到** —— 于是「等 15 分钟」是句假话，
    用户看到的现象是「这一步超时了」，完全看不出其实是**分派在等子执行**（编排者 + 6 项批次实测）。

    · ``fanout_wait_s > 0``：取 max(助手超时, 等待上限)，封顶 :data:`FANOUT_WAIT_CAP_S`
      —— 这一步既然要等子执行，等的时间就该算进去。
    · ``fanout_wait_s < 0``（不限）：**不延长**，但大声提醒 —— 「不限」会让执行挂到进程结束，
      助手的执行超时是最后一层保护；真要等到底就调大助手的执行超时。
    · 助手超时 <= 0 表示不限（沿用平台既有语义）→ 原样返回。
    """
    if base_timeout <= 0:
        return base_timeout
    if fanout_wait_s > 0:
        extended = max(int(base_timeout), min(int(fanout_wait_s), FANOUT_WAIT_CAP_S))
        if extended != base_timeout:
            logger.info(
                "这一步要等子执行：执行超时 %ss -> %ss（节点上写的「最长等多久」）",
                base_timeout,
                extended,
            )
        return extended
    if fanout_wait_s < 0:
        logger.warning(
            "节点写了「最长等多久：不限」，但助手的执行超时是 %ss —— 到点仍会停。"
            "要真等到底，请调大这个助手的执行超时（limits.timeout_s）",
            base_timeout,
        )
    return base_timeout


def resolve_timeout(
    configured: int | None, default: int, fanout_wait_s: int = 0
) -> int:
    """把「助手上配的执行超时」解析成这次真正要用的值。

    现场踩到 ✗：原来写的是 ``definition.limits.timeout_s or settings.default_timeout_s``，
    而 Python 里 **``0 or X`` 等于 X** —— 界面上写着「0 = 不超时」的助手，
    实际仍套着默认超时：用户设了 0 还在超时（2026-09-26）。

    · ``None``（没配过）→ 用默认值
    · ``0`` / 负数（**不限**，界面既有语义）→ 原样返回；调用方**不能**塞进
      ``asyncio.wait_for``（timeout=0 是"立刻超时" ✗ 语义相反）
    · 正数 → 交给 :func:`effective_timeout`（含"等子执行"的延长 ✓）
    """
    if configured is None:
        return int(default)
    if configured <= 0:
        return int(configured)
    return effective_timeout(int(configured), fanout_wait_s)


def _with_work_dir_hint(run_input: Any, work_dir: Any) -> Any:
    """把「你的工作目录在哪」明确告诉模型。

    为什么必须显式说（实测踩到）
    --------------------------
    平台的写文件工具要求**绝对路径**，而模型并不知道自己的工作目录，于是它自己猜一个
    （实测它猜了 ``/mnt/data/result.md``）→ 越出权限边界 → 不是"等人确认"就是直接报错。
    "分几路跑、各写各的文件"这种最典型的用法会因此直接废掉。
    这句提示进的是**模型看到的任务文本**，不影响编排层记录的原始任务。
    """
    hint = (
        f"\n\n【平台信息】你的工作目录：{work_dir}\n"
        f"读写文件请用这个目录下的**绝对路径**（例如 {work_dir}/result.md）。"
    )
    if isinstance(run_input, str):
        return run_input + hint
    if isinstance(run_input, dict) and isinstance(run_input.get("text"), str):
        return {**run_input, "text": run_input["text"] + hint}
    return run_input


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
        """提交一条执行 —— **不再直接起协程**，交给分发器。

        为什么必须这样（原来是 ``asyncio.create_task``）：
          · 推进的协程活在内存里 → 服务一重启，这条执行就只剩"标中断"一条路
          · 并发没有上限 → 同层节点 + 多流程 + 定时一起冲，自己把自己限流
          · 队列不可见 → "为什么我的任务还没开始跑"没地方查
        交给分发器之后：pending 就是队列，重启后照样被捡起来（见 runner/dispatcher.py）。
        """
        from .dispatcher import dispatcher

        await dispatcher.submit(run_id, definition, run_input)

    async def abort(self, run_id: str) -> bool:
        from .dispatcher import dispatcher

        return await dispatcher.abort(run_id)

    def is_running(self, run_id: str) -> bool:
        from .dispatcher import dispatcher

        return dispatcher.is_running(run_id)

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
    async def _blocked_by_quota(self, run_id: str) -> bool:
        """每日额度到顶就把这条执行判掉（写明原因与下一步），返回"是否被拦下"。

        为什么写在执行入口、而不是在界面上禁止点"运行"：
        定时任务、外部触发、分派出来的实例都不经过界面 —— 只在界面上拦等于没拦。
        """
        async with SessionLocal() as session:
            quota = await check_daily_quota(session)
            if not quota["exceeded"]:
                return False
            run = await session.get(Run, run_id)
            if run is not None:
                run.status = "error"
                run.error = quota["message"]
                run.ended_at = now_ms()
                await session.commit()
        logger.warning("执行 %s 被每日额度拦下：%s", run_id, quota["message"])
        return True

    async def execute(
        self, run_id: str, definition: AgentDefinition, run_input: Any, *, resumed: bool = False
    ) -> None:
        if resumed:
            # 续跑：这件事要**落进 usage**（界面上看得出"这条是重启后接着跑的"），
            # 否则用户只会看到一条"莫名其妙又跑起来"的记录。
            async with SessionLocal() as _s:
                _r = await _s.get(Run, run_id)
                if _r is not None:
                    _u = dict(_r.usage or {})
                    _u["resumed"] = int(_u.get("resumed") or 0) + 1
                    _r.usage = _u
                    _r.error = None
                    await _s.commit()
        # ── 每日额度护栏 ────────────────────────────────────────────────
        # 拦在**执行的最开始**这一处：编排、单跑、定时、外部触发、分派出来的实例
        # 全都经过它 —— 单点收口，不会漏掉某条新加的执行路径。
        # 到顶只拦"新起的"，正在跑的不打断（砍掉跑了一半的活更浪费）。
        if await self._blocked_by_quota(run_id):
            return

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

        #: 并发闸的槽位拿没拿到（finally 里据此决定要不要还）
        _gated = False
        try:
            async with SessionLocal() as session:
                run = await session.get(Run, run_id)
                if run is None:  # pragma: no cover
                    return
                # **并发闸**：同时跑太多会把 provider key 打到限流，用户看到的却是"这一步失败"。
                # 拿不到槽位就在**这里等**（run 状态还是 pending，界面上显示「排队中」），
                # 等到超过 run_gate_wait_s 才失败，并说清是"排队太久"而不是模型不行。
                if settings.max_concurrent_runs > 0:
                    _waited = await gate.acquire(run_id, settings.run_gate_wait_s)
                    _gated = True
                    if _waited > 1:
                        logger.info("执行 %s 排队 %.1fs 后拿到槽位", run_id, _waited)
                # ── 让工具知道"我在哪次执行的哪个节点上"（分派工具要用）───────
                # 深度：**走父链算真实层数** —— 不能只看"有没有父"：
                # 平台允许两层时，第一层实例仍要能继续往下分派。
                _depth = 0
                _cur = run
                while _cur.parent_run_id and _depth < 8:
                    _cur = await session.get(Run, _cur.parent_run_id)
                    if _cur is None:
                        break
                    _depth += 1
                _depth_limit = await get_depth_limit(session)
                from .ctx import set_run_ctx

                set_run_ctx(
                    run_id=run_id,
                    agent_id=run.agent_id,
                    node_id=run.node_id,
                    orchestration_id=run.orchestration_id,
                    depth=_depth,
                )

                tools = await load_tools(session, run.agent_id)
                # 到允许的层数就不再给分派工具（内核另有兜底；这里让工具清单一致，
                # 免得模型"看得见工具却调不动"）
                if _depth >= _depth_limit:
                    tools = [t for t in tools if getattr(t, 'kind', '') != 'fork']
                api_key, cred_base_url = await resolve_credential(definition, session)
                # 凭据上的 base_url 必须补进定义 —— 否则 compile / 压缩 / 提炼
                # 都会用错端点（火山引擎 plan key 打 /api/v3 会 401）
                definition = _with_base_url(definition, cred_base_url)
                # 工作目录两处都要用：编译时告诉运行时（=权限边界），以及**告诉模型**它在哪
                work_dir = resolve_work_dir(definition)
                run_input = _with_work_dir_hint(run_input, work_dir)
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

            # ── 重试：429 / 5xx / 连接断 / provider 侧读超时，都是「等一下就好」的事 ——
            #    不该让这一步直接报废（用户看到的会是「模型不行」，其实是我们在限流里）。
            #    **用户自己设的执行超时不在重试之列**（is_transient 会拒掉）：
            #    那是用户的上限，重试只会让它更慢，还会掩盖真正的问题。
            for _attempt in range(1, settings.run_retry_max + 2):
                try:
                    compiled = await runtime.compile(
                        definition,
                        api_key=api_key,
                        tools=tools,
                        agent_id=run.agent_id,
                        work_dir=str(work_dir),
                        context=context,
                    )

                    # 这一步要「派出去并等结果」时，等子执行的时间也算进执行超时 ——
                    # 否则节点上写「最长等多久 15 分钟」、助手超时 2 分钟，执行超时先到，
                    # 那句配置就是假的（现场：编排者 + 6 项批次整步超时，看不出是分派在等）。
                    timeout = resolve_timeout(
                        definition.limits.timeout_s,
                        settings.default_timeout_s,
                        int((run.input or {}).get("fanout_wait_s") or 0),
                    )

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

                    if timeout and timeout > 0:
                        # 不限（0 / 负数）时**不能**包 wait_for ✗ —— timeout=0 是"立刻超时"，语义正好相反 ✓
                        await asyncio.wait_for(consume(), timeout=timeout)
                    else:
                        await consume()
                    break
                except asyncio.CancelledError:
                    raise
                except Exception as _exc:  # noqa: BLE001
                    if _attempt > settings.run_retry_max or not is_transient(_exc):
                        raise
                    collector.retries = _attempt
                    _wait = backoff_s(_attempt, settings.run_retry_backoff_s)
                    logger.warning(
                        "执行 %s 第 %s 次遇到临时错误（%s: %s），%.1fs 后重试",
                        run_id, _attempt, type(_exc).__name__, _exc, _wait,
                    )
                    if compiled is not None:
                        try:
                            await runtime.dispose(compiled)
                        except Exception:  # noqa: BLE001, pragma: no cover
                            logger.debug("重试前 dispose 失败", exc_info=True)
                        compiled = None
                    await asyncio.sleep(_wait)

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
        except GateTimeout as exc:
            # 拿不到并发槽位：说清是「排队太久」，别让用户以为是模型不行
            logger.warning("Run %s 排队超时：%s", run_id, exc)
            status, error = "error", str(exc)
        except Exception as exc:
            logger.exception("Run %s 失败", run_id)
            status, error = "error", f"{type(exc).__name__}: {exc}"
        finally:
            # 不管成功失败都要**归还并发槽位**，否则跑几次之后闸就被占死了
            if _gated:
                gate.release()
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
            # 顺手取出「这一步要等子执行多久」—— 恢复执行同样受它影响
            fanout_wait_s = int((run.input or {}).get("fanout_wait_s") or 0)
            run.status = "running"
            run.pending_hitl = None
            await session.commit()

        hitl.payload = {**payload, **(hitl.payload or {})}
        task = asyncio.create_task(
            self._resume_execute(run_id, definition, hitl, fanout_wait_s=fanout_wait_s)
        )
        self._tasks[run_id] = task
        task.add_done_callback(lambda _t, rid=run_id: self._tasks.pop(rid, None))
        return True

    async def _resume_execute(
        self,
        run_id: str,
        definition: AgentDefinition,
        hitl: HitlResponse,
        fanout_wait_s: int = 0,
    ) -> None:
        # ── 每日额度护栏 ────────────────────────────────────────────────
        # 拦在**执行的最开始**这一处：编排、单跑、定时、外部触发、分派出来的实例
        # 全都经过它 —— 单点收口，不会漏掉某条新加的执行路径。
        # 到顶只拦"新起的"，正在跑的不打断（砍掉跑了一半的活更浪费）。
        if await self._blocked_by_quota(run_id):
            return

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

            timeout = resolve_timeout(
                definition.limits.timeout_s,
                settings.default_timeout_s,
                int(fanout_wait_s or 0),
            )

            hitl_payload: dict[str, Any] = {}

            async def consume() -> None:
                nonlocal seq, status, hitl_payload
                async for ev in runtime.resume(compiled, hitl):
                    ev = ev.model_copy(update={"run_id": run_id, "seq": seq})
                    seq += 1
                    collector.on_event(ev)
                    await self._persist_event(run_id, ev)
                    self.bus.publish(run_id, ev.model_dump(mode="json", exclude={"raw"}))
                    # 同上：不提前 return，保证最终 Msg 被消费
                    if ev.type == "hitl_request":
                        status = "waiting_hitl"
                        hitl_payload = dict(ev.payload)

            if timeout and timeout > 0:
                # 不限（0 / 负数）时**不能**包 wait_for ✗ —— timeout=0 是"立刻超时"，语义正好相反 ✓
                await asyncio.wait_for(consume(), timeout=timeout)
            else:
                await consume()

            # 恢复之后**又**要授权（模型连着要两步是常事：先写脚本、再跑脚本）：
            # 这里必须和正常执行路径一样，把待确认内容 + 状态快照一起落库。
            # 少了这一步会留下一条"状态在等确认、内容却是空的"运行 ——
            # 界面只能显示"（没有解析出具体调用）"，回灌时空 payload 还被接口拒收，
            # 而且**再也恢复不了**（没有快照，AgentScope 不认这次确认）。
            if status == "waiting_hitl":
                async with SessionLocal() as session:
                    _r = await session.get(Run, run_id)
                    if _r is not None:
                        _r.status = "waiting_hitl"
                        _r.pending_hitl = hitl_payload or {}
                        _r.pending_state = (
                            runtime.snapshot_state(compiled) if compiled is not None else None
                        )
                        await session.commit()
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
        # 最后一轮的 iteration span 也要收口（否则它没有结束时间、瀑布图上悬空）
        collector.finish_spans(ts)
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
            # ── span 树落库（瀑布图的数据源）────────────────────────────────
            # 先删这个 run 已有的 span：重试 / HITL 续跑会多次 finalize，
            # 不删就会出现重复条（同一段时间在图上出现两次）。
            await session.execute(delete(Span).where(Span.run_id == run_id))
            key_to_id: dict[str, str] = {}
            # 根 span 用助手名（_finalize 里没有 definition，从库里取一次就够了）
            _agent = await session.get(Agent, run.agent_id)
            for row in collector.span_rows(
                root_name=(_agent.name if _agent is not None else run.runtime)
            ):
                span = Span(
                    run_id=run_id,
                    # 父一定排在子之前 → 一遍循环就能接好父子关系
                    parent_id=key_to_id.get(row["parent"]) if row["parent"] else None,
                    kind=row["kind"],
                    name=row["name"] or "",
                    started_at=row["started_at"],
                    ended_at=row["ended_at"],
                    duration_ms=row["duration_ms"],
                    attributes=row["attributes"],
                )
                session.add(span)
                await session.flush()
                key_to_id[row["key"]] = span.id
            await session.commit()


run_service = RunService()
