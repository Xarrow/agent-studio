"""自动运行（定时触发）—— 让流程**不需要人在界面前**也能跑起来。

产品判断：Agent 平台的卖点之一是"无人值守"（每天早上 9 点自动跑一次日报）。
在此之前，这个平台只能"人点一下才跑" —— 那它顶多是个调试台，不是产品。

为什么是这样实现的
------------------
* **进程内一个 20 秒的 tick**，不引第三方调度库、不起第二个服务（自持原则，零依赖）。
  漏跑怎么办：``next_run_at`` 落在过去 → 补跑一次再往后排（不补就会"错过就永远错过"）。
* **时间配置用枚举，不用 cron 表达式**：用户要选，不要填（cron 是"第二个术语"，
  且写错了没人看得出来）。所以只支持 每小时 / 每天 / 每周 + 时:分 + 星期多选 ——
  覆盖"日报/周报/每小时巡检"这些真实场景，且**看一眼就懂**。
* **重启/多副本**：状态在库里（next_run_at），重启后照常接着排；
  同一时刻只认一个 tick（本进程单实例），并且**在途就跳过**（见 ``_in_flight``），
  不会因为 tick 与上一次执行重叠而重复发起。
* 「默认任务」空着就不跑 —— 定时跑一条没有任务描述的流程没有意义，
  界面上会明确提示去填（而不是安静地什么都不做）。
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import logging
import time
from typing import Any

from sqlalchemy import select

from .db import SessionLocal
from .models import Orchestration, Workflow, now_ms

logger = logging.getLogger(__name__)

#: 支持的定时方式（界面上的下拉就这几项 —— 枚举，不让用户填表达式）
SCHEDULE_MODES = ("hourly", "daily", "weekly")

#: 「每天/每周」在几点几分跑（HH:MM；不合法就落回 09:00）
DEFAULT_AT = "09:00"

#: tick 间隔（秒）。20 秒足够准（最坏晚 20 秒），查询成本可以忽略。
TICK_SECONDS = 20


def parse_at(at: str | None) -> tuple[int, int]:
    """``"09:30"`` → ``(9, 30)``；不合法落回默认值（永远不让脏配置把调度搞挂）。"""
    try:
        hh, _, mm = (at or "").strip().partition(":")
        h, m = int(hh), int(mm)
        if 0 <= h <= 23 and 0 <= m <= 59:
            return h, m
    except (TypeError, ValueError):
        pass
    return 9, 0


def parse_weekdays(raw: str | None) -> list[int]:
    """``"1,3,5"`` → ``[1,3,5]``（1=周一 … 7=周日，与 ISO 一致）；空/脏 → 默认周一。"""
    out: set[int] = set()
    for part in (raw or "").split(","):
        part = part.strip()
        if part.isdigit() and 1 <= int(part) <= 7:
            out.add(int(part))
    return sorted(out) or [1]


def compute_next(
    mode: str | None, at: str | None = None, weekdays: str | None = None, now: int | None = None
) -> int | None:
    """算「下一次该什么时候跑」（毫秒时间戳）。``mode`` 不认识 → ``None``（= 不定时）。

    **纯函数**（不碰库、不碰当前时间）—— 所以能被测试钉死，这是最容易算错的一环：
      · hourly：下一个整点
      · daily ：今天 HH:MM 还没到就是今天，过了就是明天
      · weekly：从今天起 7 天内第一个命中的星期（**含今天**）的 HH:MM
    """
    m = (mode or "").strip().lower()
    if m not in SCHEDULE_MODES:
        return None
    now = now_ms() if now is None else now

    if m == "hourly":
        # 下一个整点（本地时钟的整点，用户看表就能对上）
        return (now // 3_600_000 + 1) * 3_600_000

    hh, mm = parse_at(at)
    days = parse_weekdays(weekdays)
    today = _dt.datetime.fromtimestamp(now / 1000).date()

    for offset in range(0, 8):
        d = today + _dt.timedelta(days=offset)
        if m == "weekly" and d.isoweekday() not in days:
            continue
        cand = _dt.datetime.combine(d, _dt.time(hh, mm)).timestamp() * 1000
        if cand > now:
            return int(cand)
    return None


async def _in_flight(session: Any, wf_id: str) -> bool:
    """这条流程是不是还有没跑完的执行 —— 有就跳过这一轮，别叠着起。"""
    rows = (
        await session.execute(
            select(Orchestration.id).where(
                Orchestration.workflow_id == wf_id,
                Orchestration.status.in_(("pending", "running")),
            )
        )
    ).all()
    return bool(rows)


async def tick(now: int | None = None) -> list[str]:
    """跑一轮：把到点的流程发起掉，并排下一次。返回这一轮发起的编排 id。"""
    from .api.workflows import start_run_for_workflow  # 局部导入：避免启动期的循环依赖

    now = now_ms() if now is None else now
    fired: list[str] = []
    async with SessionLocal() as session:
        due = list(
            (
                await session.execute(
                    select(Workflow).where(
                        Workflow.schedule_mode.in_(SCHEDULE_MODES),
                    )
                )
            ).scalars()
        )

    for wf in due:
        next_at = wf.next_run_at
        if next_at is None:
            # 刚开了定时 / 老数据没排过 —— 只排下一次，**不补跑**（首次不该突然冒出一条执行）
            await _set_next(wf.id, compute_next(wf.schedule_mode, wf.schedule_at, wf.schedule_weekdays, now))
            continue
        if next_at > now:
            continue

        async with SessionLocal() as session:
            fresh = await session.get(Workflow, wf.id)
            if fresh is None:
                continue
            if await _in_flight(session, fresh.id):
                logger.info("定时：%s 还有在跑的执行，这一轮跳过", fresh.name)
                await _set_next(
                    fresh.id,
                    compute_next(fresh.schedule_mode, fresh.schedule_at, fresh.schedule_weekdays, now),
                )
                continue
            task = (fresh.default_task or "").strip()
            if not task:
                logger.warning("定时：流程「%s」没写默认任务，跳过（界面会提示去填）", fresh.name)
                await _set_next(
                    fresh.id,
                    compute_next(fresh.schedule_mode, fresh.schedule_at, fresh.schedule_weekdays, now),
                )
                continue
            try:
                orc_id = await start_run_for_workflow(session, fresh, task, origin="schedule")
            except Exception as exc:  # noqa: BLE001 —— 一次失败不能把调度器带走
                logger.warning("定时发起失败：%s (%s)", fresh.name, exc)
                orc_id = None
            fresh.last_run_at = now
            fresh.last_run_source = "schedule"
            fresh.next_run_at = compute_next(
                fresh.schedule_mode, fresh.schedule_at, fresh.schedule_weekdays, now
            )
            fresh.updated_at = now_ms()
            await session.commit()
            if orc_id:
                fired.append(orc_id)
                logger.info("定时发起：%s → %s", fresh.name, orc_id)
    return fired


async def _set_next(wf_id: str, next_at: int | None) -> None:
    async with SessionLocal() as session:
        wf = await session.get(Workflow, wf_id)
        if wf is not None:
            wf.next_run_at = next_at
            await session.commit()


async def loop() -> None:
    """常驻循环（由 ``main.lifespan`` 起一个 task）。异常一律吞掉后继续 ——
    调度器挂了就再也没有"自动跑"，所以它必须比任何一次执行都更耐活。"""
    logger.info("自动运行调度器已启动（每 %ss 检查一次）", TICK_SECONDS)
    while True:
        try:
            await tick()
        except asyncio.CancelledError:  # 服务在退出
            raise
        except Exception:  # noqa: BLE001
            logger.exception("调度器这一轮出错（继续下一轮）")
        try:
            await _maybe_compact()
        except asyncio.CancelledError:  # 服务在退出
            raise
        except Exception:  # noqa: BLE001
            # 归档失败**不影响**自动运行 —— 它只是省空间，不该拖垮调度
            logger.exception("事件归档这一轮出错（继续下一轮）")
        await asyncio.sleep(TICK_SECONDS)


async def _maybe_compact() -> None:
    """事件分层归档：并进**已有**的调度循环，不新建脚本/cron（运维准则）。

    好处是不用再记一个"还要去跑那个脚本"，坏处是这个循环里多了一件与"自动运行"
    无关的事 —— 所以这里做三件保护：开关、最小间隔（默认 1 小时）、异常不影响调度。
    """
    from .config import settings

    if not settings.event_compact_enabled:
        return
    interval = max(int(settings.event_compact_interval_s), 60)
    async with SessionLocal() as session:
        from .settings_store import get_setting, set_setting

        last = int(await get_setting(session, "events_compact_last_at", 0) or 0)
        if now_ms() - last < interval * 1000:
            return
        from .maintenance import compact_events

        stats = await compact_events(session)
        await set_setting(session, "events_compact_last_at", now_ms())
        await session.commit()
        if stats.get("runs_archived"):
            logger.info(
                "事件分层归档：%d 条执行、折叠 %d 行、payload %d → %d 字节",
                stats["runs_archived"], stats["rows_removed"],
                stats["bytes_before"], stats["bytes_after"],
            )


def describe(mode: str | None, at: str | None, weekdays: str | None) -> str:
    """给人看的一句话（界面直接显示，不给用户看枚举值）。"""
    m = (mode or "").strip().lower()
    if m not in SCHEDULE_MODES:
        return "不定时"
    if m == "hourly":
        return "每小时一次"
    hh, mm = parse_at(at)
    clock = f"{hh:02d}:{mm:02d}"
    if m == "daily":
        return f"每天 {clock}"
    names = {1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "日"}
    picks = "、".join(f"周{names[d]}" for d in parse_weekdays(weekdays))
    return f"每周 {picks} {clock}"
