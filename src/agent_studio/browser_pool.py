"""共享一个 Chromium 进程：每会话一个 BrowserContext（等于一个无痕窗口）。

为什么这么做
------------
以前每个会话 spawn 一个 Chromium，一天下来堆到 12 个（1.5GB 内存 / 16% CPU），
而且重启后没人认领（见 browser_control.sweep_orphan_browsers）。

共享后常驻 1 个进程，会话之间靠 ``Target.createBrowserContext`` 隔离：
cookie、localStorage、缓存各自独立 —— 和「无痕窗口」是同一套机制，不是假装隔离。

代价（写清楚，别事后惊讶）
--------------------------
· **整进程崩溃会牵连所有会话**。进程死掉时这里把状态清空，各会话下次动作重新
  连（页面状态丢失，但会话本身、对话记录都不受影响）。
· 单个 tab 的 renderer 崩溃只影响那个 tab（Chrome 本来就是多进程架构）。
· 有代理的会话**不走共享**：``--proxy-server`` 是进程级参数，各进程才能各用一套。
· 传文件/下载仍各自落在共享 profile 下，按会话目录区分（见工作目录那套）。
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
from pathlib import Path

logger = logging.getLogger(__name__)

#: 共享 profile 目录。注意 sweep_orphan_browsers 认这个路径：进程活着就保留。
ROOT = Path("/tmp/agent-studio-browser/shared-profile")

_proc: asyncio.subprocess.Process | None = None
_ws_url = ""
_bin = ""
_lock: asyncio.Lock | None = None


def _get_lock() -> asyncio.Lock:
    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    return _lock


def running() -> bool:
    return _proc is not None and _proc.returncode is None


async def ensure(bin_path: str, width: int = 1280, height: int = 800) -> str:
    """确保常驻 Chromium 在跑，返回 **browser 级** WebSocket 端点。

    同一个进程可以同时被多条 ws 连接用（每条连接 attach 自己的 target session），
    所以这里返回的是 ``ws://…/devtools/browser/…`` 而不是某个 page 的端点。
    """
    global _proc, _ws_url, _bin

    async with _get_lock():
        if running() and _ws_url and _bin == bin_path:
            return _ws_url
        await _shutdown_locked()

        ROOT.mkdir(parents=True, exist_ok=True)
        args = [
            bin_path,
            "--headless=new",
            f"--user-data-dir={ROOT}",
            "--no-sandbox",
            "--disable-gpu",
            "--no-first-run",
            "--hide-scrollbars",
            "--remote-debugging-port=0",
            f"--window-size={width},{height}",
        ]
        _proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            # 独立进程组：收尾时整组收，别留 zygote/renderer 占着 profile
            start_new_session=True,
        )
        assert _proc.stdout is not None
        tail: list[str] = []
        ws = ""
        try:
            while True:
                line = await asyncio.wait_for(_proc.stdout.readline(), timeout=20)
                if not line:
                    break
                text = line.decode("utf-8", errors="replace")
                if "DevTools listening on ws://" in text:
                    ws = text.split("DevTools listening on ", 1)[1].strip()
                    break
                if text.strip():
                    tail.append(text.rstrip())
                    del tail[:-12]
        except TimeoutError:
            await _shutdown_locked()
            raise RuntimeError("共享 Chromium 启动后 20s 内没报 DevTools 端口") from None
        if not ws:
            await _shutdown_locked()
            raise RuntimeError(
                "共享 Chromium 没起来：" + " / ".join(tail[-4:])[:400]
            )
        _ws_url = ws
        _bin = bin_path
        logger.info("共享 Chromium 已启动 pid=%s（每个会话一个 BrowserContext）", _proc.pid)
        # 进程退出时把状态清空：下次 ensure 会重建，各会话自动重连
        asyncio.create_task(_watch(_proc))
        return ws


async def _watch(proc: asyncio.subprocess.Process) -> None:
    global _proc, _ws_url, _bin
    try:
        code = await proc.wait()
    except asyncio.CancelledError:  # pragma: no cover
        return
    if _proc is proc:
        logger.warning("共享 Chromium 退出（code=%s），各会话下次动作会重建", code)
        _proc = None
        _ws_url = ""
        _bin = ""


async def _shutdown_locked() -> None:
    global _proc, _ws_url, _bin
    proc = _proc
    _proc = None
    _ws_url = ""
    _bin = ""
    if proc is None or proc.returncode is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:  # pragma: no cover
        try:
            proc.kill()
        except Exception:
            pass
    try:
        await asyncio.wait_for(proc.wait(), timeout=5)
    except Exception:  # pragma: no cover
        pass


async def shutdown() -> None:
    """服务收尾/测试用：整组关掉常驻进程。"""
    async with _get_lock():
        await _shutdown_locked()


def stats() -> dict[str, object]:
    return {
        "running": running(),
        "pid": getattr(_proc, "pid", None),
        "bin": _bin,
        "ws": _ws_url,
    }
