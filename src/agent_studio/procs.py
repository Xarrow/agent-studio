"""后台进程 —— 让助手能跑「比一轮对话更久」的活。

为什么必须单独一层
------------------
平台的 bash / python 都是**同步带超时**的：`run` 一轮有 `timeout_s`（默认 900s），
一个 build、一次模型训练、一批下载只要超过它就被掐死，而且没有任何补救手段
—— 这是"对标 Hermes"最硬的一处缺口（Hermes 的 terminal(background) 是日常主力）。

这里提供的是一套**会话级**的后台进程：
  `proc_start` 起进程立刻返回（不等它跑完）
  `proc_poll`  看状态 + 尾部输出（每轮用得上）
  `proc_log`   要全量/更多行时看
  `proc_kill`  停掉
  `proc_list`  这个会话里起过哪些

设计上的几个硬约束
------------------
* **归属**：进程挂在 ``session_id`` 上，不挂 run。run 结束、页面关掉、API 重启，
  进程都还在 —— 这才是"后台"的意义。会话之间的进程互相看不见（同文件隔离一个口径）。
* **进程组**：`start_new_session=True` + `killpg` 终止整棵树。否则 `bash -c "a | b"`
  只杀掉 shell，管道里的子进程会变成孤儿继续烧 CPU。
* **日志**：直接重定向到文件（不是 pipe）。pipe 需要有人持续读，没人读就阻塞；
  文件还能让"API 重启后照样能看输出"。
* **重启对账**：内存里的 Popen 对象随进程没了，但日志和 pid 都在。启动时
  ``reconcile()`` 拿 pid 挨个戳一下（``os.kill(pid, 0)``），活着的继续标 running，
  没了的按 unknown 收尾 —— 不假装它还在跑。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import signal
import time
from pathlib import Path
from typing import Any

from sqlalchemy import select

from .config import PROJECT_ROOT, settings
from .db import SessionLocal
from .models import BgProc, new_id, now_ms

logger = logging.getLogger(__name__)

#: 日志目录（与 data/work 平级，不进会话目录 —— 否则会混进"会话文件"清单）
PROC_DIR = Path(settings.work_dir).parent / "procs"

#: 尾部最多回多少字符（模型读太长没意义，还烧 token）
TAIL_CHARS = 2000
#: 输出文件上限：超了就截断轮转（防止 `yes` 这种把磁盘写满）
MAX_LOG_BYTES = 8 * 1024 * 1024

#: 活着的进程对象（只在起它的这个进程里有；重启后靠 pid + /proc 对账）
_LIVE: dict[str, asyncio.subprocess.Process] = {}
#: 每个进程的等待协程（避免重复起）
_WATCHERS: dict[str, asyncio.Task] = {}


def _log_path(proc_id: str) -> Path:
    PROC_DIR.mkdir(parents=True, exist_ok=True)
    return PROC_DIR / f"{proc_id}.log"


async def _write_row(proc_id: str, **fields: Any) -> None:
    async with SessionLocal() as session:
        row = await session.get(BgProc, proc_id)
        if row is None:
            return
        for k, v in fields.items():
            setattr(row, k, v)
        await session.commit()


async def _watch(proc_id: str, proc: asyncio.subprocess.Process) -> None:
    """等它退出，然后落状态。进程死掉/被杀都走这里（不用轮询）。"""
    try:
        code = await proc.wait()
    except Exception as exc:  # pragma: no cover - 极端情况下 wait 也可能抛
        logger.warning("后台进程 %s 等待失败: %s", proc_id, exc)
        code = None
    status = "exited" if code == 0 else "failed"
    if code is None:
        status = "unknown"
    await _write_row(proc_id, status=status, exit_code=code, ended_at=int(time.time() * 1000))
    _LIVE.pop(proc_id, None)
    _WATCHERS.pop(proc_id, None)


async def start(
    *,
    session_id: str,
    command: str,
    cwd: str | Path | None = None,
    label: str = "",
    run_id: str | None = None,
    agent_id: str | None = None,
    heartbeat_s: int = 0,
) -> dict[str, Any]:
    """起一个后台进程，**立刻**返回。``command`` 用 shell 执行（与 bash 工具一致）。"""
    cmd = (command or "").strip()
    if not cmd:
        raise ValueError("命令不能为空")
    if not (session_id or "").strip():
        raise ValueError("后台进程必须挂在会话上（缺 session_id）")

    try:
        hb = max(0, int(heartbeat_s or 0))
    except (TypeError, ValueError):
        hb = 0

    work = Path(cwd).resolve() if cwd else Path(settings.work_dir).resolve()
    if not work.exists():
        work = Path(PROJECT_ROOT)
    if not work.is_dir():
        raise ValueError(f"工作目录不存在: {work}")

    proc_id = new_id("bg_")
    log = _log_path(proc_id)
    fh = open(log, "wb")  # noqa: SIM115 - 交给子进程继承后立刻关掉父句柄
    try:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            cwd=str(work),
            stdout=fh,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,  # 独立进程组 → killpg 能收掉整棵树
        )
    finally:
        fh.close()

    now = int(time.time() * 1000)
    async with SessionLocal() as session:
        session.add(
            BgProc(
                id=proc_id,
                session_id=session_id,
                run_id=run_id,
                agent_id=agent_id,
                label=(label or cmd)[:120],
                command=cmd[:2000],
                cwd=str(work),
                pid=proc.pid or 0,
                status="running",
                log_path=str(log),
                started_at=now,
                heartbeat_s=hb,
                # 第一次心跳从起跑就开始算（否则要等两个周期才有动静）
                last_beat_at=now if hb > 0 else None,
            )
        )
        await session.commit()

    _LIVE[proc_id] = proc
    _WATCHERS[proc_id] = asyncio.create_task(_watch(proc_id, proc))
    logger.info("后台进程已起 %s pid=%s: %s", proc_id, proc.pid, cmd[:80])
    return {
        "id": proc_id,
        "pid": proc.pid,
        "status": "running",
        "label": (label or cmd)[:120],
        "cwd": str(work),
        "log": str(log),
        "heartbeat_s": hb,
        "hint": "已经起好了，先用 proc_poll 看它跑得怎么样；别用同步命令等它。"
        + ("（已开启心跳：平台会定期把进展发进会话，用户不用反复问）" if hb else ""),
    }


def _read_tail(path: str, chars: int = TAIL_CHARS) -> str:
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - max(chars, 200) * 4))
            raw = fh.read()
        text = raw.decode("utf-8", "replace")
        return text[-chars:]
    except FileNotFoundError:
        return ""
    except Exception as exc:  # pragma: no cover
        return f"（读日志失败: {exc}）"


def _row_dict(row: BgProc, *, tail: bool = False) -> dict[str, Any]:
    now = int(time.time() * 1000)
    elapsed = ((row.ended_at or now) - row.started_at) / 1000
    out: dict[str, Any] = {
        "id": row.id,
        "session_id": row.session_id,
        "run_id": row.run_id,
        "label": row.label,
        "command": row.command,
        "cwd": row.cwd,
        "pid": row.pid,
        "status": row.status,
        "exit_code": row.exit_code,
        "started_at": row.started_at,
        "ended_at": row.ended_at,
        "elapsed_s": round(elapsed, 1),
        "heartbeat_s": int(row.heartbeat_s or 0),
        "last_beat_at": row.last_beat_at,
    }
    if tail:
        out["tail"] = _read_tail(row.log_path)
    return out


async def poll(proc_id: str, *, session_id: str | None = None, tail: bool = True) -> dict[str, Any] | None:
    async with SessionLocal() as session:
        row = await session.get(BgProc, proc_id)
        if row is None:
            return None
        if session_id and row.session_id != session_id:
            return None  # 会话之间不许互看
        return _row_dict(row, tail=tail)


async def log_text(proc_id: str, *, session_id: str | None = None, lines: int = 200) -> str:
    async with SessionLocal() as session:
        row = await session.get(BgProc, proc_id)
        if row is None or (session_id and row.session_id != session_id):
            return ""
        path = row.log_path
    text = _read_tail(path, chars=max(400, min(lines, 4000) * 120))
    return text


async def list_for_session(session_id: str, *, limit: int = 20) -> list[dict[str, Any]]:
    async with SessionLocal() as session:
        rows = (
            (
                await session.execute(
                    select(BgProc)
                    .where(BgProc.session_id == session_id)
                    .order_by(BgProc.started_at.desc())
                    .limit(limit)
                )
            )
            .scalars()
            .all()
        )
        return [_row_dict(r) for r in rows]


async def kill(proc_id: str, *, session_id: str | None = None) -> dict[str, Any]:
    """先 SIGTERM 整个进程组，3 秒不退再 SIGKILL。"""
    async with SessionLocal() as session:
        row = await session.get(BgProc, proc_id)
        if row is None or (session_id and row.session_id != session_id):
            return {"ok": False, "error": "没有这个后台进程"}
        pid, status = row.pid, row.status
    if status != "running":
        return {"ok": True, "status": status, "note": "它已经结束了"}

    proc = _LIVE.get(proc_id)
    killed = False
    if proc is not None and proc.returncode is None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            killed = True
        try:
            await asyncio.wait_for(proc.wait(), timeout=3)
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    elif pid:
        # API 重启过：内存里没有 Popen，直接按 pid 对进程组动手
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(os.getpgid(pid), signal.SIGTERM)
            killed = True
    await _write_row(proc_id, status="killed", ended_at=int(time.time() * 1000))
    return {"ok": True, "status": "killed", "killed": killed}


async def reconcile() -> int:
    """API 启动时对账：标着 running 的，进程还在就保留，没了就改成 unknown。

    不做这件事的后果：重启之后界面上永远挂着一个"正在运行"的幽灵，
    用户点停止又提示"它已经结束了"，来回打脸。
    """
    fixed = 0
    async with SessionLocal() as session:
        rows = (
            (await session.execute(select(BgProc).where(BgProc.status == "running")))
            .scalars()
            .all()
        )
    for row in rows:
        alive = False
        if row.pid:
            try:
                os.kill(row.pid, 0)
                alive = True
            except OSError:
                alive = False
        if not alive:
            await _write_row(row.id, status="unknown", ended_at=int(time.time() * 1000))
            fixed += 1
    if fixed:
        logger.info("后台进程对账：%s 个已不在的进程改为 unknown", fixed)
    return fixed


async def rename_hint(proc_id: str, label: str) -> None:
    """给进程起个人话名字（模型起名太啰嗦时，界面按这个显示）。"""
    await _write_row(proc_id, label=(label or "")[:120])


async def running_count(session_id: str) -> int:
    """给界面/告警用：这个会话现在有几个在跑。"""
    async with SessionLocal() as session:
        rows = (
            (
                await session.execute(
                    select(BgProc).where(
                        BgProc.session_id == session_id, BgProc.status == "running"
                    )
                )
            )
            .scalars()
            .all()
        )
    return len(rows)


# --------------------------------------------------------------------------- #
# 心跳：长任务跑着的时候，定期把"还在跑 + 最近输出"发进会话
# --------------------------------------------------------------------------- #
#: 心跳里最多带几个字的日志尾巴（多了会把会话撑爆）
BEAT_CHARS = 400


def _last_lines(text: str, limit: int = 3) -> str:
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    return " / ".join(lines[-limit:])[:BEAT_CHARS]


async def beat_due(now: int | None = None) -> int:
    """把所有到点的后台进程汇报一次，返回发了几条。

    为什么发**会话消息**而不是 SSE：心跳的意义是"人不在屏幕前也能看到"，
    关掉页面再回来，这些进展要还在。SSE 只在页面开着时有用。
    """
    from .models import SessionMessage

    now = now_ms() if now is None else now
    sent = 0
    async with SessionLocal() as session:
        rows = list(
            (
                await session.execute(
                    select(BgProc).where(BgProc.status == "running", BgProc.heartbeat_s > 0)
                )
            ).scalars()
        )
        for row in rows:
            every = int(row.heartbeat_s or 0) * 1000
            last = int(row.last_beat_at or row.started_at or now)
            if every <= 0 or now - last < every:
                continue
            tail = _last_lines(_read_tail(row.log_path, BEAT_CHARS * 2))
            elapsed_s = max(0, int((now - (row.started_at or now)) / 1000))
            spent = f"{elapsed_s} 秒" if elapsed_s < 60 else f"{elapsed_s // 60} 分钟"
            text = (
                f"〔心跳〕{row.label or row.command[:40]} 还在跑（已 {spent}）"
                + (f" · 最近输出：{tail}" if tail else " · 暂时没有输出")
            )
            session.add(
                SessionMessage(
                    session_id=row.session_id,
                    turn_index=0,  # 心跳不属于任何一轮
                    role="system",
                    content=text,
                    run_id=row.run_id,
                    ts=now,
                )
            )
            row.last_beat_at = now
            sent += 1
        if sent:
            await session.commit()
    if sent:
        logger.info("后台进程心跳：发了 %s 条", sent)
    return sent
