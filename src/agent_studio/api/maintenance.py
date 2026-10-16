"""存储维护接口：/api/maintenance/*

为什么要给界面接口（而不是"运维自己上服务器跑脚本"）
------------------------------------------------------
"归档到底有没有用、库现在多大、上次什么时候整理的" —— 这些不该只有 SSH 上去才知道。
接口给三样东西：当前占用（statistics）、立刻整理一次（compact）、配置项（keep_days 等）。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import select
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


@router.get("/paths", response_model=dict)
async def read_paths() -> dict[str, Any]:
    """**数据存在服务器上的哪个路径** —— 给界面显示，用户随时能核对/备份。

    为什么要有：平台数据全在服务器上（自托管），但界面从没说过"存在哪"。
    用户看不到落点，就没法自己备份、也没法判断某次操作到底写没写盘。
    这里返回的都是**运行时的真实路径**（取自配置，不写死字符串），
    换成容器/别的机器也自动是对的。
    """
    from ..db import _active  # noqa: SLF001  —— 当前生效驱动才是真相（可能被 UI 切过）

    # 只有 SQLite 才有"一个文件"；别的驱动（MySQL/PG）如实返回 None，
    # 界面就退回显示连接串 —— 编一个路径比不显示更糟。
    db_file: str | None = str(_active.sqlite_file()) if _active.driver == "sqlite" else None

    work = Path(settings.work_dir).expanduser()
    backups = Path(settings.db_path).expanduser().parent
    sessions_dir = work.resolve() / "sessions"
    return {
        "database_file": db_file,
        "database_url": settings.db_url,
        "work_dir": str(work.resolve()) if work.exists() else str(work),
        "sessions_dir": str(sessions_dir),
        "backup_dir": str(backups.resolve()),
        # 说清"存在哪"的语义，别报一个不存在的路径（原来这里凭空拼了个 runs/ 子目录）
        "note": (
            "会话与消息存在数据库文件里；助手干活（读写的文件、跑的脚本）落在工作目录下："
            "每个会话一个子目录（sessions/<会话号>/），会话之间互不可见；"
            "单轮试跑/定时/编排各有自己的 runs/ 子目录。"
        ),
    }


# --------------------------------------------------------------------------- #
# 会话目录（文件隔离的落地物）
# --------------------------------------------------------------------------- #
def _dir_usage(root: Path) -> dict[str, Any]:
    files = 0
    size = 0
    newest = 0
    for p in root.rglob("*"):
        st = None
        try:
            if p.is_file():
                st = p.stat()
        except OSError:
            st = None
        if st is None:
            continue
        files += 1
        size += st.st_size
        newest = max(newest, int(st.st_mtime))
    return {"files": files, "bytes": size, "mtime": newest}


def scan_session_dirs(session_ids: set[str]) -> list[dict[str, Any]]:
    """列出 ``work_dir/sessions/`` 下的会话目录，并标出"没有主的"。

    没有主 = 磁盘上有目录、库里没有这个会话（手工删过库、或删除时会话目录
    清理失败）。这些才是可以清的；**有主的目录一个都不动** ——
    那是用户文件的所在，清掉就是删数据。
    """
    root = (Path(settings.work_dir).expanduser().resolve() / "sessions")
    out: list[dict[str, Any]] = []
    if not root.is_dir():
        return out
    for d in sorted(root.iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        usage = _dir_usage(d)
        out.append(
            {
                "session_id": d.name,
                "path": str(d),
                "orphan": d.name not in session_ids,
                **usage,
            }
        )
    return out


@router.get("/session-dirs", response_model=dict)
async def read_session_dirs(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """会话目录体检：几个、占多少、几个没主（可清）。"""
    from ..models import Session as ChatSession

    rows = (await session.execute(select(ChatSession.id))).scalars().all()
    dirs = scan_session_dirs(set(rows))
    return {
        "root": str(Path(settings.work_dir).expanduser().resolve() / "sessions"),
        "count": len(dirs),
        "bytes": sum(d["bytes"] for d in dirs),
        "orphans": [d for d in dirs if d["orphan"]],
        "dirs": dirs[:200],
    }


@router.post("/session-dirs/clean", response_model=dict)
async def clean_session_dirs(
    payload: dict | None = None, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """清掉**没有主**的会话目录（名单先给用户看，这里只删点名的/全部没主的）。

    有主的目录即使被点名也不删 —— 那是会话的文件，删目录 = 删用户数据；
    要删数据走「删除会话」，那条路会把会话和目录一起收掉。
    """
    from ..models import Session as ChatSession

    rows = (await session.execute(select(ChatSession.id))).scalars().all()
    dirs = scan_session_dirs(set(rows))
    wanted = set((payload or {}).get("session_ids") or [])
    removed: list[str] = []
    freed = 0
    import shutil

    for d in dirs:
        if not d["orphan"]:
            continue
        if wanted and d["session_id"] not in wanted:
            continue
        try:
            shutil.rmtree(d["path"], ignore_errors=True)
        except OSError:
            continue
        removed.append(d["session_id"])
        freed += int(d["bytes"])
    return {"removed": removed, "count": len(removed), "freed_bytes": freed}


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
