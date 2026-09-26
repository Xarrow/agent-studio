"""存储维护接口：/api/maintenance/*

为什么要给界面接口（而不是"运维自己上服务器跑脚本"）
------------------------------------------------------
"归档到底有没有用、库现在多大、上次什么时候整理的" —— 这些不该只有 SSH 上去才知道。
接口给三样东西：当前占用（statistics）、立刻整理一次（compact）、配置项（keep_days 等）。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db import get_session, engine
from ..maintenance import STREAM_TYPES, compact_events, storage_stats
from ..settings_store import set_setting

router = APIRouter(prefix="/api/maintenance", tags=["maintenance"])


def _db_bytes() -> int | None:
    """SQLite 库文件大小（其他驱动没有"文件大小"这个概念，返回 None）。"""
    try:
        from .. import db as dbmod

        path = dbmod._active.sqlite_file()  # noqa: SLF001
        return path.stat().st_size if path.exists() else None
    except Exception:  # noqa: BLE001
        return None


@router.get("/storage", response_model=dict)
async def read_storage(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """存储体检：多少行事件、占多少、归档过多少、下次按什么规则归档。"""
    stats = await storage_stats(session)
    stats["db_bytes"] = _db_bytes()
    stats["stream_type_count"] = len(STREAM_TYPES)
    return stats


@router.post("/compact", response_model=dict)
async def run_compact(
    keep_days: int | None = None, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """立刻整理一次（把够老执行的逐字片段折叠掉、超大 payload 截断）。"""
    if not settings.event_compact_enabled and keep_days is None:
        return {"ok": False, "reason": "自动归档已关闭（STUDIO_EVENT_COMPACT_ENABLED=0）"}
    stats = await compact_events(session, keep_days=keep_days)
    from ..models import now_ms

    await set_setting(session, "events_compact_last_at", now_ms())
    await session.commit()
    return {"ok": True, **stats}

@router.post("/backup-db", response_model=dict)
async def backup_db_now() -> dict[str, Any]:
    """**立刻留一份数据库副本**（做危险操作前点一下；平时每天自动留一份）。

    为什么要给用户这个按钮：自托管的平台上，库就是唯一真相，
    "改之前先留一份"应该是**一键**的事，而不是让人去终端里敲命令。
    """
    from ..config import settings
    from ..maintenance import backup_db

    made = backup_db(str(settings.db_path))
    return {"ok": bool(made), "path": made}
