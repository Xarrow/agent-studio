"""存储维护：事件分层归档 + 存储体检。

为什么需要（这不是洁癖，是"能不能长期用"的问题）
------------------------------------------------
一次执行大约写 390 行事件，其中**98% 是流式片段**：
``text_delta`` / ``thinking_delta`` / ``tool_call_args`` 这类"模型吐字的碎片"。
它们的内容最终都已经在别处了 ——
  · 最终文本 → ``run.output``
  · 工具结果 → ``tool_call.result_preview``（前 500 字）+ ``result_size``
再加上 ``tool_result_delta`` 这种单行上百 KB 的大家伙，库会**只增不减**地长下去：
按每天 100 次执行算就是 3.9 万行/天，一年上千万行 —— 备份越来越慢、老记录回放越来越卡。

分层规则（"近的细、远的粗"）
--------------------------
  · ``event_keep_days`` 天内的执行：**一行不动**（正在用的、还要排障的都在这段）
  · 更早的执行：把流式片段**合并成每种类型一条归档行**（记下条数与字符数），
    其余大 payload 截断到 ``event_preview_bytes`` —— 时间线骨架、轮次、工具调用、
    最终产出全都还在，只是"逐字碎片"不再留着（那本来就是过程噪声）
  · **在途执行永不触碰**（status 不是终态就跳过）
  · 已经归档过的执行不重复处理（``events_archived_at`` 打标记），所以反复调用是安全的
"""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .models import Run, RunEvent, now_ms

logger = logging.getLogger(__name__)

#: 流式片段事件：行数占绝大多数，内容在别处都有（见文件头注释）
STREAM_TYPES = (
    "text_delta",
    "thinking_delta",
    "tool_result_delta",
    "tool_call_args",
    "llm_delta",
    "reasoning_delta",
)

TERMINAL = ("ok", "error", "aborted")


def _payload_bytes(payload: Any) -> int:
    try:
        return len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    except (TypeError, ValueError):  # pragma: no cover
        return 0


async def compact_events(
    session: AsyncSession,
    *,
    keep_days: int | None = None,
    preview_bytes: int | None = None,
    now: int | None = None,
    only_run: str | None = None,
) -> dict[str, Any]:
    """把"够老的执行"的事件分层归档。返回一份可显示的统计（界面要看得见效果）。"""
    keep = int(keep_days if keep_days is not None else settings.event_keep_days)
    preview = int(preview_bytes if preview_bytes is not None else settings.event_preview_bytes)
    ts = now if now is not None else now_ms()
    cutoff = ts - keep * 24 * 3600 * 1000

    conds = [
        Run.status.in_(TERMINAL),
        Run.ended_at.is_not(None),
        Run.ended_at < cutoff,
        Run.events_archived_at.is_(None),
    ]
    if only_run:
        conds.append(Run.id == only_run)
    runs = list((await session.execute(select(Run).where(*conds))).scalars())

    stats: dict[str, Any] = {
        "runs_archived": 0,
        "rows_removed": 0,
        "rows_kept": 0,
        "bytes_before": 0,
        "bytes_after": 0,
        "cutoff": cutoff,
        "keep_days": keep,
    }
    if not runs:
        return stats

    for run in runs:
        rows = list(
            (
                await session.execute(
                    select(RunEvent).where(RunEvent.run_id == run.id).order_by(RunEvent.seq)
                )
            ).scalars()
        )
        if not rows:
            run.events_archived_at = ts
            continue

        before = sum(_payload_bytes(r.payload) for r in rows)
        stream: dict[str, dict[str, int]] = {}
        max_seq = rows[-1].seq
        for r in rows:
            if r.type in STREAM_TYPES:
                box = stream.setdefault(r.type, {"count": 0, "chars": 0})
                box["count"] += 1
                box["chars"] += len(json.dumps(r.payload or {}, ensure_ascii=False))
                await session.delete(r)
        # 每种被折叠的类型留一条"归档行"：时间线上还能看出"这里原本有一大段逐字输出"
        for kind, box in stream.items():
            max_seq += 1
            session.add(
                RunEvent(
                    run_id=run.id,
                    seq=max_seq,
                    type="archived",
                    ts=run.ended_at or ts,
                    payload={
                        "of": kind,
                        "count": box["count"],
                        "chars": box["chars"],
                        "note": f"{keep} 天前的逐字片段已归档（最终产出见「产出」）",
                    },
                )
            )

        after = 0
        for r in (
            await session.execute(select(RunEvent).where(RunEvent.run_id == run.id))
        ).scalars():
            size = _payload_bytes(r.payload)
            if size > preview:
                # 大 payload 截断（保留开头 + 原始大小，能看出"这里被截过"）
                text = json.dumps(r.payload or {}, ensure_ascii=False)
                r.payload = {
                    "_truncated": True,
                    "_bytes": size,
                    "_preview": text[: max(200, preview)],
                }
                size = _payload_bytes(r.payload)
            after += size
        run.events_archived_at = ts
        stats["runs_archived"] += 1
        stats["rows_removed"] += sum(b["count"] for b in stream.values())
        stats["bytes_before"] += before
        stats["bytes_after"] += after

    stats["rows_kept"] = int(
        (
            await session.execute(
                select(func.count())
                .select_from(RunEvent)
                .where(RunEvent.run_id.in_([r.id for r in runs]))
            )
        ).scalar()
        or 0
    )
    await session.commit()
    logger.info(
        "事件归档：%d 条执行、折叠 %d 行流式片段、payload %d → %d 字节",
        stats["runs_archived"],
        stats["rows_removed"],
        stats["bytes_before"],
        stats["bytes_after"],
    )
    return stats


async def storage_stats(session: AsyncSession) -> dict[str, Any]:
    """存储体检（界面上一眼看得到，不然"归档到底有没有用"没人知道）。"""
    event_rows = int(
        (await session.execute(select(func.count()).select_from(RunEvent))).scalar() or 0
    )
    event_bytes = int(
        (
            await session.execute(select(func.coalesce(func.sum(func.length(RunEvent.payload)), 0)))
        ).scalar()
        or 0
    )
    runs = int((await session.execute(select(func.count()).select_from(Run))).scalar() or 0)
    archived = int(
        (
            await session.execute(
                select(func.count()).select_from(Run).where(Run.events_archived_at.is_not(None))
            )
        ).scalar()
        or 0
    )
    stream_rows = int(
        (
            await session.execute(
                select(func.count())
                .select_from(RunEvent)
                .where(RunEvent.type.in_(STREAM_TYPES))
            )
        ).scalar()
        or 0
    )
    last = (
        await session.execute(select(func.max(Run.events_archived_at)))
    ).scalar()
    from .settings_store import get_setting

    return {
        "event_rows": event_rows,
        "stream_rows": stream_rows,
        "event_payload_bytes": event_bytes,
        "runs": runs,
        "runs_archived": archived,
        "last_archived_at": int(last) if last else None,
        "last_auto_run_at": int(
            await get_setting(session, "events_compact_last_at", 0) or 0
        )
        or None,
        "keep_days": int(settings.event_keep_days),
        "preview_bytes": int(settings.event_preview_bytes),
        "enabled": bool(settings.event_compact_enabled),
    }

# --------------------------------------------------------------------------- #
# 数据库每日副本
# --------------------------------------------------------------------------- #
#: 保留几份（够回退即可；留太多会把磁盘吃满，反而更危险）
DB_KEEP = 3


def db_backups(db_path: str) -> list[str]:
    """已有的每日副本，按时间从新到旧（只认我们自己造的那个命名）。"""
    from pathlib import Path

    p = Path(db_path)
    if not p.parent.exists():
        return []
    hits = [str(x) for x in p.parent.glob(f"{p.name}.daily-*") if x.is_file()]
    return sorted(hits, reverse=True)


def prune_db_backups(db_path: str, keep: int = DB_KEEP) -> list[str]:
    """只留最近 ``keep`` 份，返回被删掉的（**只删我们自己按命名造的副本**）。"""
    import os

    old = db_backups(db_path)[keep:]
    for path in old:
        try:
            os.remove(path)
        except OSError:  # pragma: no cover - 删不掉不该让备份流程失败
            pass
    return old


def backup_db(db_path: str, keep: int = DB_KEEP) -> str | None:
    """给数据库留一份副本（活库也安全：走 SQLite 的 backup API，不是拷文件）。

    为什么不用 ``cp``：库在 WAL 模式下运行时拷文件，可能拿到**半写状态**的副本 ——
    真要回退时才发现副本是坏的，那比没有更糟。
    """
    import sqlite3
    import time as _time
    from pathlib import Path

    src_path = Path(db_path)
    if not src_path.exists():
        return None
    stamp = _time.strftime("%Y%m%d-%H%M%S")
    target = src_path.with_name(f"{src_path.name}.daily-{stamp}")
    source = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
    try:
        dest = sqlite3.connect(str(target))
        try:
            source.backup(dest)
        finally:
            dest.close()
    finally:
        source.close()
    prune_db_backups(db_path, keep)
    return str(target)
