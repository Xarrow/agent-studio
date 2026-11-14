"""会话级变更推送：让浏览器不再轮询。

为什么要有这个
==============
原来对话页每 4~8 秒轮询一次（后来改成拉 digest 指纹），原因是**会话里会发生
页面不知道的事**：
  · 编排/巡检在上一轮 SSE 结束后**另起一轮**（新 run，页面手里没有它的流）；
  · 平台往会话里追加消息（收口、通知）；
  · 产物目录被写入了新文件。

这些东西没有"给这条会话订阅"的通道 —— SSE 只按 run 订阅。所以只能轮询。
这里补上会话级通道：服务端自己盯着库和产物目录（本机 SQLite，几毫秒），
**变了才推**；浏览器只保持一条长连接。

代价与边界
----------
- 每个打开的标签页一条 SSE，服务端每 2 秒做一次「count + max(id) + 目录 stat」，
  没人订阅时任务自动停（不空转）；
- 只在单进程内有效（本平台就是单进程 uvicorn）；多进程部署需要换 Redis 之类，
  那时这条通道也要跟着换 —— 见 docs。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from sqlalchemy import func, select

import logging

logger = logging.getLogger(__name__)
from .models import Run, Session as ChatSession, SessionMessage

TICK_S = 2.0


class SessionWatcher:
    """按会话推送"变了"的最小实现（事件只在服务端检测，不依赖业务代码埋点）。"""

    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue]] = {}
        self._cache: dict[str, str] = {}
        self._task: asyncio.Task | None = None

    # ---------------- 订阅 ----------------
    async def subscribe(self, session_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=64)
        self._subs.setdefault(session_id, set()).add(q)
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._loop(), name="session-watch")
        return q

    def prime(self, session_id: str, digest: dict[str, Any]) -> None:
        """订阅时先把"当前状态"记进缓存 —— 否则第一轮会立刻再推一次相同的 changed。"""
        self._cache[session_id] = self.key_of(digest)

    def unsubscribe(self, session_id: str, q: asyncio.Queue) -> None:
        subs = self._subs.get(session_id)
        if subs is not None:
            subs.discard(q)
            if not subs:
                self._subs.pop(session_id, None)
                self._cache.pop(session_id, None)

    # ---------------- 检测 ----------------
    @staticmethod
    async def digest(session_id: str) -> dict[str, Any]:
        from .db import SessionLocal

        async with SessionLocal() as db:
            row = await db.get(ChatSession, session_id)
            if row is None:
                return {"session_id": session_id, "gone": True}
            count = (
                await db.execute(
                    select(func.count()).select_from(SessionMessage).where(SessionMessage.session_id == session_id)
                )
            ).scalar() or 0
            last_id = (
                await db.execute(
                    select(SessionMessage.id)
                    .where(SessionMessage.session_id == session_id)
                    .order_by(SessionMessage.id.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
            running = (
                await db.execute(
                    select(Run.id)
                    .where(Run.session_id == session_id, Run.status.in_(("running", "pending")))
                    .limit(1)
                )
            ).scalar_one_or_none()
            artifacts = _artifacts_fingerprint(row.id)
        return {
            "session_id": session_id,
            "message_count": int(count),
            "last_message_id": last_id or "",
            "last_active_at": int(row.last_active_at or 0),
            "running": bool(running),
            "running_id": running or "",
            "artifacts": artifacts,
        }

    @staticmethod
    def key_of(d: dict[str, Any]) -> str:
        return f"{d.get('message_count')}|{d.get('last_message_id')}|{d.get('last_active_at')}|{d.get('running')}|{d.get('artifacts')}"

    async def _loop(self) -> None:
        while self._subs:
            for sid in list(self._subs):
                try:
                    d = await self.digest(sid)
                except Exception:  # noqa: BLE001 —— 一次读库失败不能把通道弄死
                    logger.debug("会话监听读取失败 %s", sid, exc_info=True)
                    continue
                key = self.key_of(d)
                if self._cache.get(sid) != key:
                    self._cache[sid] = key
                    for q in list(self._subs.get(sid, ())):
                        try:
                            q.put_nowait({"type": "changed", "digest": d})
                        except asyncio.QueueFull:
                            pass
            await asyncio.sleep(TICK_S)


def _artifacts_fingerprint(session_id: str) -> str:
    """产物目录指纹：文件数 + 最新 mtime + 总大小。目录不存在就是空串。"""
    from .config import settings

    root = Path(settings.work_dir) / "sessions" / session_id
    if not root.is_dir():
        return ""
    n = 0
    newest = 0
    total = 0
    for p in root.rglob("*"):
        try:
            if not p.is_file():
                continue
            st = p.stat()
        except OSError:
            continue
        n += 1
        newest = max(newest, int(st.st_mtime))
        total += st.st_size
    return f"{n}:{newest}:{total}"


watcher = SessionWatcher()


def sse(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
