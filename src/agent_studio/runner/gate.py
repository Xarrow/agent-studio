"""并发闸 + 临时错误退避重试 —— 别把自己打爆。

要解决的两个真实故障（都会让用户看到"模型不行"，其实是我们自己的问题）
---------------------------------------------------------------------
① **没有并发上限**：画布上同层节点并发（asyncio.gather）+ 多条流程并发 + 定时触发，
   全都打在同一个 provider key 上 → 一限流，用户看到的是"这一步失败"。
   这里加一个全局信号量：拿不到槽位就**排队等**（run 状态留在 ``pending``，
   界面上本来就显示「排队中」），而不是拒绝或直接失败。

② **临时错误直接报废**：429 / 5xx / 连接被掐 / provider 侧读超时，都是**等一下就好**的事。
   原来一次失败就把这一步标成 error。这里按退避重试（1.5s / 3s / 6s…），
   重试次数记进 ``run.usage.retries``（界面上能看出"这次跑了 2 遍"），不静默。

两条刻意的边界
--------------
* **用户设的执行超时（``limits.timeout_s``）不重试**：那是用户自己的上限，
  重试只会让它更慢 —— 该报"超时"，不该偷偷再多跑两轮。
* **拿不到槽位等太久也不无限等**：超过 ``gate_wait_s`` 就明确失败并说明原因
  （"排队太久"是能查的事实，比一直转圈强）。
"""

from __future__ import annotations

import asyncio
import logging
import re

from ..config import settings

logger = logging.getLogger(__name__)

#: 这些字样代表"等一会再来就行"（429 / 5xx / 连接与读超时 / 过载）
_TRANSIENT = re.compile(
    r"429|too many requests|rate ?limit|"
    r"\b50[0234]\b|bad gateway|service unavailable|gateway time-?out|"
    r"overload|temporar|try again|"
    r"connection (reset|aborted|closed|error)|read ?timeout|connect(error|timeout)|"
    r"remotedisconnected|incomplete ?read",
    re.I,
)


class GateTimeout(RuntimeError):
    """排队等不到并发槽位。单独一个异常类型，是为了让外层能把它与
    用户设的"执行超时"分开报（前者是"我们太忙"，后者是"这次跑太久"）。"""


class Gate:
    """全局并发闸。

    为什么用信号量而不是队列：我们要的是"最多 N 个同时跑"，不是严格的先进先出 ——
    信号量最简、不引入第二个调度器（自持原则）。
    """

    def __init__(self, size: int = 0) -> None:
        self._size = size
        self._sem: asyncio.Semaphore | None = None
        self._lock = asyncio.Lock()
        self.waiting = 0

    @property
    def size(self) -> int:
        return self._size

    async def _semaphore(self) -> asyncio.Semaphore | None:
        # 懒建：size<=0（不限并发）时完全不碰它。
        if self._size <= 0:
            return None
        if self._sem is None:
            async with self._lock:
                if self._sem is None:
                    self._sem = asyncio.Semaphore(self._size)
        return self._sem

    async def acquire(self, run_id: str = "", wait_s: float = 0.0) -> float:
        """拿一个槽位；返回等待了多久（秒）。``wait_s<=0`` 表示一直等。

        排队会打一行 info —— "为什么我的任务还没开始跑"在日志里查得到。
        等到超时抛 :class:`GateTimeout`（消息里写清上限与等了多久）。
        """
        sem = await self._semaphore()
        if sem is None:
            return 0.0
        loop = asyncio.get_event_loop()
        started = loop.time()
        if sem.locked():          # 只有真的排队时才记日志，别刷屏
            self.waiting += 1
            logger.info("执行 %s 排队中（并发上限 %s，在跑的已满）", run_id, self._size)
            try:
                await asyncio.wait_for(sem.acquire(), timeout=wait_s or None)
            except (asyncio.TimeoutError, TimeoutError) as exc:
                raise GateTimeout(
                    f"排队太久（并发上限 {self._size}，等了 {wait_s:.0f}s 仍没轮到）"
                ) from exc
            finally:
                self.waiting -= 1
        else:
            await sem.acquire()
        return loop.time() - started

    def release(self) -> None:
        if self._sem is not None:
            self._sem.release()


#: 全局一个（进程内所有 Run 共用）。大小取自配置（``STUDIO_MAX_CONCURRENT_RUNS``）。
gate = Gate(settings.max_concurrent_runs)


def is_transient(exc: BaseException) -> bool:
    """这个异常值得重试吗？

    **用户设的执行超时不算**（``TimeoutError`` 由 ``asyncio.wait_for`` 抛出）——
    那是用户自己的上限，重试只会让等待更久，而且掩盖真正的问题。
    其它（429 / 5xx / 连接断 / provider 侧读超时）都值得等一等再试。
    """
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return False
    if isinstance(exc, asyncio.CancelledError):
        return False
    text = f"{type(exc).__name__}: {exc}"
    return bool(_TRANSIENT.search(text))


def backoff_s(attempt: int, base: float = 1.5) -> float:
    """第 ``attempt`` 次重试前等多久（指数退避，封顶 30s）。"""
    return min(30.0, max(0.0, base) * (2 ** max(0, attempt - 1)))
