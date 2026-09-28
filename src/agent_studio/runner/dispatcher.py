"""执行分发器 —— 让「待跑的执行」落库排队，并且**重启后还能接着跑**。

为什么要这一层（原来的做法差在哪）
----------------------------------
原来 ``run_service.start()`` 直接 ``asyncio.create_task(_execute)``：推进执行的协程活在内存里，
服务一重启，那条记录就只剩「被标成中断」一条路（reap_orphan_runs 的注释里也写明了这个死结）。
没有队列还有两个副作用：
  · 并发无上限（同层节点 + 多流程 + 定时一起冲，自己把自己限流）
  · 队列不可见（「为什么我的任务还没开始跑」既没地方看，也没日志）

改成什么
--------
把执行拆成 **「提交」与「推进」** 两件事：
  · 提交（``submit``）：只把"这条要跑"记下来（内存提示 + 唤醒分发器）
  · 推进（``tick``）：分发器按**并发上限**取活干 ——
    ① 先看内存里刚提交的（带定义，省一次快照解析）
    ② 再看库里 ``pending`` 的执行 —— **这就是重启续跑的入口**：
       ``definition_snapshot`` 与 ``input`` 都已经落库，重启后照样能把这条跑起来，
       不需要任何外部 broker（自持原则）。

两条刻意的边界
--------------
* **编排（orchestration）里的执行不自动续跑**：重启时编排的推进协程也死了，
  而"从头再跑一遍"会把**已经完成的步骤重复执行**（有副作用就更糟）。所以编排内的执行
  一律标中断，并把编排也标中断、说明原因 —— 用户可以在画布上重新跑一次。
* **续跑有次数上限**（``STUDIO_RUN_MAX_RESUME``，默认 1）：反复重启不该变成无限重跑。
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from sqlalchemy import Text, cast, select

from ..config import settings
from ..db import SessionLocal
from ..schemas import AgentDefinition
from ..models import Run, now_ms

logger = logging.getLogger(__name__)

#: 分发器轮询间隔（秒）。有提交时会立刻被唤醒，这个间隔只是兜底 + 捡重启遗留。
TICK_SECONDS = 1.0


def resume_policy(
    *,
    status: str,
    orchestration_id: str | None,
    resumed: int,
    enabled: bool = True,
    max_resume: int = 1,
) -> str:
    """重启时对一条在途执行该怎么处理 —— **纯函数**，所以能被测试钉死。

    返回 ``"requeue"``（重新排队跑）/ ``"interrupt"``（标中断）。

    规则（每条都有理由，别随手改）：
      · 关了续跑功能 → interrupt
      · ``waiting_hitl``（等人工确认）→ interrupt：唤醒它靠内存里的事件，重启后接不回来
      · 属于编排的执行 → interrupt：编排的推进协程也死了，单跑这一步没有意义，
        而且"从头再跑"会让已完成的步骤重复执行
      · 已续跑过 ``max_resume`` 次 → interrupt：反复重启不该变成无限重跑
      · 其余（单步 / 对话 / 试跑 / 单步运行）→ requeue
    """
    if not enabled:
        return "interrupt"
    if status == "waiting_hitl":
        return "interrupt"
    if orchestration_id:
        return "interrupt"
    if resumed >= max_resume:
        return "interrupt"
    return "requeue"


def input_of(stored: Any) -> Any:
    """把落库的 ``run.input`` 还原成当初传给运行时的 ``run_input``。

    一致性的关键：``POST /api/runs`` 对字符串输入存的是 ``{"text": ...}``，
    对 dict 输入**原样存**。这里按同样的规则还原 —— 否则续跑时模型收到的输入
    会和第一次不一样（"续跑"就名不副实了）。
    """
    if isinstance(stored, dict) and set(stored.keys()) == {"text"}:
        return stored["text"]
    return stored


class Dispatcher:
    """进程内的执行分发器（同时管并发上限与排队顺序）。"""

    def __init__(self) -> None:
        #: 刚提交的执行（带定义，省一次快照解析）；被取走就删掉
        self._queue: dict[str, tuple[AgentDefinition, Any]] = {}
        #: 正在跑的（run_id → task）。abort / is_running 看它
        self._tasks: dict[str, asyncio.Task] = {}
        self._wake = asyncio.Event()
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ #
    # 提交 / 控制
    # ------------------------------------------------------------------ #
    async def submit(self, run_id: str, definition: AgentDefinition, run_input: Any) -> None:
        """登记一条要跑的执行并唤醒分发器（**不在调用方起协程**）。"""
        self._queue[run_id] = (definition, run_input)
        self._wake.set()

    async def abort(self, run_id: str) -> bool:
        task = self._tasks.get(run_id)
        if task is not None and not task.done():
            task.cancel()
            return True
        # 排队中（还没被取走）也要能取消：从队列里摘掉
        return self._queue.pop(run_id, None) is not None

    def is_running(self, run_id: str) -> bool:
        task = self._tasks.get(run_id)
        return task is not None and not task.done()

    @property
    def running_count(self) -> int:
        return sum(1 for t in self._tasks.values() if not t.done())

    @property
    def queued_count(self) -> int:
        return len(self._queue)

    # ------------------------------------------------------------------ #
    # 分发
    # ------------------------------------------------------------------ #
    def _capacity(self) -> int:
        n = int(settings.max_concurrent_runs or 0)
        return n if n > 0 else 10_000  # 0 = 不限（用一个足够大的数表示）

    async def tick(self) -> list[str]:
        """取一轮活干。返回这一轮启动的 run_id 列表（测试与日志都看它）。"""
        from .service import run_service  # 局部导入：避免与 service 的循环依赖

        started: list[str] = []
        free = self._capacity() - self.running_count
        if free <= 0:
            return started

        # ① 内存里刚提交的（保持提交顺序）
        while self._queue and free > 0:
            run_id, (definition, run_input) = next(iter(self._queue.items()))
            self._queue.pop(run_id, None)
            self._spawn(run_id, definition, run_input, resumed=False)
            started.append(run_id)
            free -= 1

        if free <= 0:
            return started

        # ② 库里 pending 的（**重启续跑**走这条；也可能包含上面正在起的那几条）
        #
        # ⚠️ 这里**按纯文本读列、自己解析**，不直接取 ORM 对象：JSON 列里一旦有
        # 非法 JSON（外部脚本/手工 SQL/写了一半就断），SQLAlchemy 读行时会抛
        # JSONDecodeError —— 那会让**整条 pending 扫描**炸掉（每秒一条堆栈），
        # 而且此刻别的正常 pending 执行也一条都起不来。实测撞到过（见 06:09 日志）。
        async with SessionLocal() as session:
            rows = (
                await session.execute(
                    select(
                        Run.id,
                        cast(Run.definition_snapshot, Text).label("snapshot_text"),
                        cast(Run.input, Text).label("input_text"),
                    )
                    .where(Run.status == "pending", Run.runtime != "a2a")
                    .order_by(Run.started_at.asc())
                    .limit(free)
                )
            ).all()
        for run_id, snapshot_text, input_text in rows:
            if self.is_running(run_id):
                continue
            try:
                snapshot = json.loads(snapshot_text) if snapshot_text else {}
                run_input = json.loads(input_text) if input_text else {}
                definition = AgentDefinition.model_validate(snapshot)
            except Exception:  # noqa: BLE001 —— 快照坏了不该让分发器停摆
                # 坏快照之前是"跳过、留在 pending" —— 实测这条路是死结：
                #   · 留在 pending 的行**每秒**被这里扫到一次，每次都刷一条 WARNING
                #     （一个坏行 ≈ 每天 8.6 万条日志，纯属日志/磁盘泄漏）；
                #   · 它既**中断不了**（abort 只作用于内存里的任务/队列，这里没任务）
                #     又**删不掉**（删除接口要求终态）—— 界面上永远挂着一条"待跑"。
                # 所以直接落终态：如实说明原因，让用户能删、日志闭嘴。
                await self._mark_broken(run_id, "定义快照无法解析")
                continue
            self._spawn(run_id, definition, input_of(run_input), resumed=True)
            started.append(run_id)
        return started

    async def _mark_broken(self, run_id: str, reason: str) -> None:
        """把读不出/解析不了的行落成终态（绕开 ORM 水合，坏 JSON 也改得动）。

        为什么不 ``session.get(Run, id)`` 再改：坏 JSON 的行**读都读不出来**，
        用 ORM 取行会再抛一次 —— 那就又回到"既改不掉也删不掉"的死结。
        这里用 core 的 UPDATE，只碰这一列。
        """
        from sqlalchemy import update

        try:
            async with SessionLocal() as session:
                await session.execute(
                    update(Run)
                    .where(Run.id == run_id, Run.status == "pending")
                    .values(
                        status="error",
                        error=f"这条执行的{reason}，未执行（可以直接删除）",
                        ended_at=now_ms(),
                    )
                )
                await session.commit()
            logger.warning("执行 %s 的%s → 已标为 error（不再每轮重扫）", run_id, reason)
        except Exception:  # noqa: BLE001 —— 落终态失败也不能让分发器停摆
            logger.exception("把执行 %s 标为 error 失败", run_id)

    def _spawn(self, run_id: str, definition: AgentDefinition, run_input: Any, *, resumed: bool) -> bool:
        from .service import run_service

        # **防重复起**：DB 扫描可能先一步捡到某条，随后 submit() 又把它放进队列；
        # 没有这道闸，同一条执行会被起两次（跑两遍、花两份钱）。
        if self.is_running(run_id):
            return False
        if resumed:
            logger.info("续跑：从 pending 里捡起执行 %s（服务重启前提交的）", run_id)
        task = asyncio.create_task(run_service.execute(run_id, definition, run_input, resumed=resumed))
        self._tasks[run_id] = task
        task.add_done_callback(lambda _t, rid=run_id: self._tasks.pop(rid, None))
        return True

    async def loop(self) -> None:
        """常驻循环（由 ``main.lifespan`` 起一个 task）。异常一律吞掉继续 ——
        分发器挂了就再也没有执行能跑起来，它必须比任何一次执行都耐活。"""
        logger.info("执行分发器已启动（并发上限 %s）", settings.max_concurrent_runs or "不限")
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("分发器这一轮出错（继续下一轮）")
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=TICK_SECONDS)
                self._wake.clear()
            except (asyncio.TimeoutError, TimeoutError):
                pass


#: 全局一个（进程内所有执行共用）
dispatcher = Dispatcher()


async def loop() -> None:
    """给 ``main.lifespan`` 用的入口（起一个 task 就行）。"""
    await dispatcher.loop()
