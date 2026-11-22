"""浏览器会话 —— 让助手在页面上操作浏览器（headless Chromium + CDP 直连）。

设计原则
--------
零第三方浏览器自动化依赖：服务器已有的 Chromium 就是引擎，CDP 是它原生控制协议。
Playwright/Selenium 在这里只会带来几百 MB 依赖和版本匹配烦恼。

生命周期
--------
浏览器属于**聊天会话**（``session_id``），不是单次 run：同一个会话里的多轮复用
同一个 Chromium（``--user-data-dir`` 落在 ``/tmp/agent-studio-browser/ses-<会话号>``），
登录态/当前页面/填了一半的表单都在。run 结束**不再关**它；30 分钟没有任何交互
才回收（见 ``browser_control``）。run 只是一个"这一次谁在用"的标签。

画面流（不落盘）
----------------
``Page.startScreencast`` 让 Chromium 主动推 JPEG 帧。帧**只走内存**：
CDP ws → EventBus（type=browser_frame）→ SSE → 前端 <img>。
不进 run_event 表、不写盘 —— 用户明确选择"纯 Chrome 流显示"，刷新后无画面是
已知取舍（动作流 tool_call 事件照旧落库可回放）。

安全收口
--------
· URL 与 fetch 同规则：内网地址（_is_private_host）一律拒绝 —— 浏览器工具
  若能绕过，fetch 的 SSRF 拦截就形同虚设（同一个进程能干的事更多）。
· 子进程超时硬闸；输出截断（read 的正文可能非常大）。
· 导航只许 http/https。
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# 常量（安全闸）
# --------------------------------------------------------------------------- #
#: 默认驱动（系统 Chromium）。实际用哪个由「环境配置 → 浏览器驱动」决定，
#: 启动时读一次设置；没设过就是它。
CHROME_BIN = "/usr/bin/chromium"
#: 一帧的最大体积（CDP 返回 base64；超限丢帧而不是断流）
FRAME_MAX_BYTES = 400_000
#: 帧参数。画面是"让人看得见它在干嘛"，不是录屏：quality 55 一帧 ~30-50KB，
#: everyNthFrame 4 + 后端最小间隔 200ms，约 5 帧/秒 —— 看得清操作，又不把
#: SSE 和前端拖垮。之前不给限速，页面一动就把 30 帧/秒全推过来，整页卡死。
FRAME_QUALITY = 55
FRAME_EVERY_NTH = 4
FRAME_MIN_INTERVAL_MS = 200
#: read 动作返回正文的最大字符数
READ_MAX_CHARS = 20_000
#: 单个动作的默认超时
ACTION_TIMEOUT_S = 45
#: 视口。WebRTC 主链路按 1280 宽推流；JPEG 兼容模式仍按 800 宽、5fps 推
#: （SSE 负载口径没变）。16:10 和面板的可用区域接近，留白比 4:3 少。
VIEWPORT = {"width": 1280, "height": 800, "deviceScaleFactor": 1}
#: 视频档的 screencast 参数（CDP 侧编码一张 JPEG 的代价随质量上升）
VIDEO_FRAME_QUALITY = 68
VIDEO_MAX_FPS = 24

#: 键盘：DOM key → Windows 虚拟键码（CDP 要它才能触发默认行为，比如 Enter 提交）
_VK = {
    "Enter": 13, "Tab": 9, "Escape": 27, "Backspace": 8, "Delete": 46,
    "ArrowLeft": 37, "ArrowUp": 38, "ArrowRight": 39, "ArrowDown": 40,
    "Home": 36, "End": 35, "PageUp": 33, "PageDown": 34, "Insert": 45,
    " ": 32, "Spacebar": 32,
    "Shift": 16, "Control": 17, "Alt": 18, "Meta": 91, "CapsLock": 20,
    "F1": 112, "F2": 113, "F3": 114, "F4": 115, "F5": 116, "F6": 117,
    "F7": 118, "F8": 119, "F9": 120, "F10": 121, "F11": 122, "F12": 123,
}


def describe_key(payload: dict[str, Any]) -> str:
    """按键的人话（动作字幕/回执用）—— 只记\"按了什么\"，不记输入内容。"""
    key = str(payload.get("key") or "")
    names = {
        "Enter": "回车", "Tab": "Tab", "Escape": "Esc", "Backspace": "退格",
        "Delete": "Delete", "ArrowLeft": "←", "ArrowUp": "↑", "ArrowRight": "→",
        "ArrowDown": "↓", " ": "空格", "PageUp": "PageUp", "PageDown": "PageDown",
        "Home": "Home", "End": "End",
    }
    label = names.get(key, key if len(key) > 1 else "字符")
    mods = []
    if payload.get("ctrlKey"):
        mods.append("Ctrl")
    if payload.get("altKey"):
        mods.append("Alt")
    if payload.get("metaKey"):
        mods.append("⌘")
    if payload.get("shiftKey") and len(key) > 1:
        mods.append("Shift")
    return "+".join(mods + [label]) if mods else label


# --------------------------------------------------------------------------- #
# profile 自清理（残留进程 / 残留锁）
#
# 现场（2026-11-22 复测）：同一个会话上一次的 Chromium 没退干净，下一次启动就读不到
# DevTools 行，面板上糊着一句 Chromium 原文
#   Failed to create SingletonLock: File exists … ProcessSingleton …
# 用户既看不懂，也没法自己修。Chromium 的判断很简单：``SingletonLock`` 是个指向
# ``<主机名>-<pid>`` 的软链，那个 pid 还活着就认为 profile 正在被用，直接退出。
# 所以起之前必须先把「占着这个目录的进程」和「锁文件」一起收掉，起不来再收一次重试。
# --------------------------------------------------------------------------- #
#: 这些文件都属于"这个 profile 现在归谁"的标记，残留一律清掉
_PROFILE_LOCK_FILES = ("SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort")


def profile_dir_for(key: str) -> Path:
    """会话/run 归属键 → profile 目录（``ses:<会话号>`` → ``ses-ses_xxx``）。"""
    return Path(f"/tmp/agent-studio-browser/{key.replace(':', '-')}")


def _pids_using(profile: Path) -> list[int]:
    """扫描 /proc，找出命令行里带着这个 profile 目录的进程（=上一个实例的残留）。"""
    needle = str(profile).encode()
    hits: list[int] = []
    me = os.getpid()
    try:
        entries = list(Path("/proc").iterdir())
    except Exception:  # pragma: no cover - 没有 /proc 的平台
        return hits
    for entry in entries:
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid == me:
            continue
        try:
            raw = (entry / "cmdline").read_bytes()
        except Exception:
            continue
        if needle in raw:
            hits.append(pid)
    return hits


def reap_profile(key: str) -> dict[str, Any]:
    """把某个会话的 profile 收回干净：先停掉残留进程，再删锁。

    幂等且便宜（没有残留时只读几个目录项），所以**每次启动前都调**，不只在失败后调：
    服务器重启过、上一轮 abort 过、janitor 还没来得及收，都会留下活着的 Chromium。
    """
    import signal

    profile = profile_dir_for(key)
    killed: list[int] = []
    for pid in _pids_using(profile):
        try:
            os.kill(pid, signal.SIGTERM)
            killed.append(pid)
        except Exception:
            continue
    if killed:
        # 给它们 1.5s 自己退；还活着就 SIGKILL（ziegote/renderer 由主进程带下去）
        deadline = time.monotonic() + 1.5
        while time.monotonic() < deadline:
            alive = [p for p in killed if Path(f"/proc/{p}").exists()]
            if not alive:
                break
            time.sleep(0.1)
        for pid in killed:
            if Path(f"/proc/{pid}").exists():
                try:
                    os.kill(pid, signal.SIGKILL)
                except Exception:
                    pass
        time.sleep(0.1)
    removed: list[str] = []
    for name in _PROFILE_LOCK_FILES:
        f = profile / name
        try:
            if f.is_symlink() or f.exists():
                f.unlink()
                removed.append(name)
        except Exception:  # pragma: no cover - 正在被删/权限问题，交给下一次重试
            continue
    if killed or removed:
        logger.info("浏览器 profile 自清理 %s：停掉 %s，删锁 %s", profile, killed, removed)
    return {"killed": killed, "locks": removed}


def _private_host_check(host: str) -> bool:
    """与 native_tools._is_private_host 同规则（这里独立实现避免运行期 import 环）。"""
    import ipaddress
    import socket

    if host in ("localhost", "0.0.0.0", ""):
        return True
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        try:
            addr = ipaddress.ip_address(socket.gethostbyname(host))
        except Exception:
            return False
    return addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved


# --------------------------------------------------------------------------- #
# CDP 客户端（够用就好：命令应答 + screencast 事件回调）
# --------------------------------------------------------------------------- #
class _Cdp:
    """Chromium DevTools 协议的最小客户端：发命令、等应答、收事件。

    连接的是 **browser 级**端点（DevTools 行给的就是它），而 Page/Runtime/Input
    都是 **target session 域**命令 —— 必须先 ``Target.attachToTarget`` 拿
    sessionId，之后每条命令都带 ``sessionId`` 字段（flatten 模式）。
    实测不 attach 直接发会得到 ``'Page.enable' wasn't found`` —— 这就是
    第一版 navigate 成功页面却全空的原因。
    """

    def __init__(self, ws: Any) -> None:
        self._ws = ws
        self._id = 0
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._listeners: dict[str, list[Any]] = {}
        self._reader: asyncio.Task[None] | None = None
        self.session_id: str | None = None

    @classmethod
    async def connect(cls, ws_url: str) -> "_Cdp":
        import aiohttp

        session = aiohttp.ClientSession()
        ws = await session.ws_connect(ws_url, max_msg_size=64 * 1024 * 1024)
        cdp = cls(ws)
        cdp._session = session  # type: ignore[attr-defined]
        cdp._reader = asyncio.create_task(cdp._read_loop())
        return cdp

    async def attach_page(self) -> None:
        """附到第一个 page target（headless 启动就有一个 newtab）。"""
        r = await self.send("Target.getTargets")
        infos = r.get("result", {}).get("targetInfos", [])
        page = next((ti for ti in infos if ti.get("type") == "page"), None)
        if page is None:
            raise RuntimeError("Chromium 里没有 page target")
        r = await self.send("Target.attachToTarget", {"targetId": page["targetId"], "flatten": True})
        self.session_id = r.get("result", {}).get("sessionId")

    def on(self, method: str, fn: Any) -> None:
        self._listeners.setdefault(method, []).append(fn)

    async def _read_loop(self) -> None:
        try:
            async for msg in self._ws:
                if msg.type != 1:  # TEXT
                    continue
                data = json.loads(msg.data)
                mid = data.get("id")
                if mid is not None and mid in self._pending:
                    self._pending.pop(mid).set_result(data)  # type: ignore[union-attr]
                else:
                    for fn in self._listeners.get(data.get("method", ""), ()):
                        try:
                            r = fn(data.get("params", {}))
                            if asyncio.iscoroutine(r):
                                asyncio.create_task(r)
                        except Exception:  # pragma: no cover
                            logger.exception("CDP 事件回调出错")
        except Exception:
            for fut in self._pending.values():
                if not fut.done():
                    fut.cancel()

    async def send(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self._id += 1
        mid = self._id
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_event_loop().create_future()
        self._pending[mid] = fut
        msg: dict[str, Any] = {"id": mid, "method": method, "params": params or {}}
        if self.session_id:
            msg["sessionId"] = self.session_id
        await self._ws.send_json(msg)
        try:
            resp = await asyncio.wait_for(fut, timeout=ACTION_TIMEOUT_S)
        except TimeoutError:
            return {"error": {"message": f"CDP 命令超时: {method}"}}
        if "error" in resp:
            return resp
        return {"result": resp.get("result", {})}

    async def close(self) -> None:
        if self._reader:
            self._reader.cancel()
            try:
                await self._reader
            except (asyncio.CancelledError, Exception):  # pragma: no cover
                pass
        try:
            await self._ws.close()
        except Exception:  # pragma: no cover
            pass
        try:
            await self._session.close()  # type: ignore[attr-defined]
        except Exception:  # pragma: no cover
            pass


# --------------------------------------------------------------------------- #
# 会话管理（run_id → BrowserSession，单例注册表）
# --------------------------------------------------------------------------- #

# --------------------------------------------------------------------------- #
# BiDi 客户端（Firefox 从 129 起只认这个协议）
# --------------------------------------------------------------------------- #
class _Bidi:
    """WebDriver BiDi 的最小客户端：JSON-RPC over WebSocket。

    与 CDP 的差别（写代码时要记住的两点）：
    · **一切都是 command/response**，没有"事件推流"可以用 —— 所以画面是**定时截图**
      （captureScreenshot），不是 Chromium 那种"有变化才推"。慢一点、费一点，但稳。
    · 返回值是 RemoteValue（``{"type": "number", "value": 3}``），不是裸 JSON ——
      所以脚本统一 ``JSON.stringify`` 成字符串再解析，省掉逐类型解包的坑。
    """

    def __init__(self, ws: Any) -> None:
        self._ws = ws
        self._id = 0
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._reader: asyncio.Task[None] | None = None
        self._session = None

    @classmethod
    async def connect(cls, ws_url: str) -> "_Bidi":
        import aiohttp

        http = aiohttp.ClientSession()
        ws = await http.ws_connect(ws_url, max_msg_size=64 * 1024 * 1024)
        b = cls(ws)
        b._session = http  # type: ignore[attr-defined]
        b._reader = asyncio.create_task(b._read_loop())
        return b

    async def _read_loop(self) -> None:
        try:
            async for msg in self._ws:
                if msg.type != 1:  # TEXT
                    continue
                data = json.loads(msg.data)
                mid = data.get("id")
                if mid is not None and mid in self._pending:
                    self._pending.pop(mid).set_result(data)  # type: ignore[union-attr]
        except Exception:  # pragma: no cover
            logger.exception("BiDi 读循环结束")
            for fut in self._pending.values():
                if not fut.done():
                    fut.cancel()

    async def send(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self._id += 1
        mid = self._id
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_event_loop().create_future()
        self._pending[mid] = fut
        await self._ws.send_json({"id": mid, "method": method, "params": params or {}})
        try:
            resp = await asyncio.wait_for(fut, timeout=ACTION_TIMEOUT_S)
        except TimeoutError:
            raise RuntimeError(f"BiDi 命令超时: {method}") from None
        if resp.get("type") == "error":
            # BiDi 的 error 字段是**字符串**（"unknown error"），CDP 那种 {code,message}
            # 结构在这里没有 —— 按 dict 取会抛 AttributeError，把真实原因整条吞掉
            err = resp.get("error")
            msg = err.get("message") if isinstance(err, dict) else str(err)
            raise RuntimeError(f"{method} 失败: {msg}")
        return resp.get("result") or {}

    async def close(self) -> None:
        if self._reader:
            self._reader.cancel()
        try:
            await self._ws.close()
        except Exception:  # pragma: no cover
            pass
        http = getattr(self, "_session", None)
        if http is not None:
            try:
                await http.close()
            except Exception:  # pragma: no cover
                pass


class _StartFailed(Exception):
    """一次启动没成 —— 带上原始输出尾巴，交给 ``_startup_error`` 翻人话。"""

    def __init__(self, headline: str, tail: list[str]) -> None:
        super().__init__(headline)
        self.headline = headline
        self.tail = list(tail)


class BrowserSession:
    """一个浏览器实例：进程 + CDP + screencast 推流。

    ``key`` 是**归属键**（``ses:<会话号>``）—— run 只是"这一次在用"，浏览器和
    登录态都跟着会话走，run 结束不再关（见 ``browser_control``）。
    """

    def __init__(self, run_id: str, on_frame: Any, proxy: str | None = None, session_id: str = "") -> None:
        self.run_id = run_id
        self.session_id = session_id
        self.key = f"ses:{session_id}" if session_id else f"run:{run_id}"
        self._on_frame = on_frame

        self._proc: asyncio.subprocess.Process | None = None
        self._cdp: _Cdp | None = None
        self._proxy = proxy
        self._ws_url: str | None = None
        self._last_url = ""
        self._last_frame = ""
        self._last_frame_at = 0.0
        #: 最后一次**真帧**（screencast 推来的）的时刻；保活帧不刷新它
        self._last_real_frame_at = 0.0
        self._last_title = ""
        #: 非 CDP 引擎（Firefox/BiDi）时用这一套；两套共用一个对外的动作接口
        self._bidi: _Bidi | None = None
        self._ctx: str = ""
        self._proto: str = "cdp"
        self._frame_task: asyncio.Task[None] | None = None
        #: WebRTC 出口（browser_webrtc.FrameSink）。非空时 CDP 按视频档推帧，
        #: 这里每帧都喂给它；SSE 的 JPEG 仍按老节流（5fps）—— 两套口径互不影响。
        self._video_sink: Any = None
        self._screencast_mode: str = "jpeg"
        self._screencast_on: bool = False
        self._closing: bool = False
        #: 最后一次"点在哪里"（页面坐标）。打字进不去时用它把焦点拿回来。
        self._last_click: tuple[float, float] | None = None
        #: 上一次点中的是不是输入控件 —— 只有它才允许"再点一次拿焦点"，
        #: 否则一点链接再打字就会把同一个链接点开第二遍（真机踩过同类）。
        self._last_click_editable = False
        #: 兼容模式的保活帧循环（页面静止时补帧，见 _idle_tick）
        self._idle_task: asyncio.Task[None] | None = None

    # -- 生命周期 ----------------------------------------------------------- #
    def _child_env(self) -> dict[str, str]:
        """起浏览器时的环境：把「包内自带的系统库」（如果有）指进 LD_LIBRARY_PATH。

        这样全新机器上即使没装 libnss3 这类系统包，只要包/数据目录里带了
        ``browser-deps/lib``，浏览器也能直接起来 —— 不需要 root、不需要联网。
        """
        env = dict(os.environ)
        try:
            from .browser_drivers import chrome_env

            env.update(chrome_env())
        except Exception:  # pragma: no cover
            logger.exception("读取浏览器运行库目录失败（按系统库启动）")
        return env

    def _startup_error(self, tail: list[str], bin_path: str, headline: str, *, retried: bool = False) -> str:
        """把"启动失败"翻译成**用户能动手**的一句话。

        现场踩到的坑：Chrome for Testing 装好了、也选中了，但它启动时缺
        ``libnspr4.so`` 之类的系统库 —— 用户看到的只是"没有 DevTools 行"，
        完全不知道要去装依赖，最后只能认为"驱动没装上"。

        另一类（2026-11-22）：上一个实例还占着 profile，
        ``Failed to create SingletonLock: File exists`` —— 这是**平台自己的
        收尾问题**，不该让用户看见 Chromium 原文，也不该让他自己去删 /tmp。
        """
        blob = "\n".join(tail)
        if any(
            s in blob
            for s in ("SingletonLock", "ProcessSingleton", "profile appears to be in use", "SingletonSocket")
        ):
            if retried:
                return (
                    "浏览器启动失败：这个会话的配置还被上一个浏览器进程占着，"
                    "已自动清掉并重试过一次仍没起来。稍等几秒再点一次「接管」，或发消息让我重开。"
                )
            return "浏览器启动失败：这个会话的配置被上一个进程占着（已自动清理）"
        if "error while loading shared libraries" in blob:
            try:
                from .browser_drivers import _missing_libs

                missing = _missing_libs(bin_path)
            except Exception:  # pragma: no cover
                missing = []
            names = "、".join(missing) if missing else "系统运行库"
            return (
                f"{headline}：这个浏览器缺系统运行库（{names}）。"
                f"装上依赖即可 —— apt-get install -y libnss3 libnspr4 libasound2t64 "
                f"libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libcairo2 "
                f"libcups2t64 libgbm1 libpango-1.0-0 libxcomposite1 libxdamage1 "
                f"libxfixes3 libxkbcommon0 libxrandr2 libdrm2 fonts-liberation"
            )
        if retried:
            return f"{headline}：这个浏览器起不来（已自动清理配置重试一次），换一个驱动或看服务端日志"
        # 原始输出只进日志，面板上不糊 Chromium 原文（用户看不懂也没法动手）
        logger.warning("浏览器启动失败（%s）：%s", headline, " / ".join(tail[-6:])[:800])
        return f"{headline}：浏览器没起来，正在自动重试一次"

    async def _kill_proc(self) -> None:
        """收掉这一个 Chromium（整组）。不碰 CDP/推流状态 —— 只用于启动失败重试。"""
        import signal

        if self._proc is None:
            return
        try:
            os.killpg(os.getpgid(self._proc.pid), signal.SIGKILL)
        except Exception:  # pragma: no cover - 已经退出了
            try:
                self._proc.kill()
            except Exception:
                pass
        try:
            await self._proc.wait()
        except Exception:  # pragma: no cover
            pass
        self._proc = None

    async def _launch(self, args: list[str]) -> str:
        """起一次 Chromium 并等 DevTools 行；失败抛 ``_StartFailed``（带原始尾巴）。"""
        self._proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            # 独立进程组：收尾时整组 SIGKILL，别把 renderer/zygote 留下来继续占 profile
            start_new_session=True,
        )
        # remote-debugging-port=0：Chromium 会把实际端口写进 stderr 的 DevTools 行
        ws_url = None
        assert self._proc.stdout is not None
        tail: list[str] = []  # 启动期最后几行 stderr —— 起不来时它就是唯一的线索
        try:
            while True:
                line = await asyncio.wait_for(self._proc.stdout.readline(), timeout=15)
                text = line.decode("utf-8", errors="replace")
                if "DevTools listening on ws://" in text:
                    ws_url = text.split("DevTools listening on ", 1)[1].strip()
                    break
                if text.strip():
                    tail.append(text.rstrip())
                    del tail[:-12]
                if not line:
                    break
        except TimeoutError:
            await self._kill_proc()
            raise _StartFailed("启动后 15s 内没报 DevTools 端口", tail) from None
        if not ws_url:
            await self._kill_proc()
            raise _StartFailed("启动失败（没有 DevTools 行）", tail)
        return ws_url

    async def _ensure(self) -> None:
        """惰性启动：第一次动作才拉起 Chromium（不操作就零成本）。"""
        if self._cdp is not None:
            return
        self._closing = False  # 上一次失败重试时可能被 close() 置过
        # 用哪个内核由设置决定（环境配置页可换、可装新版本）；取不到就退回默认
        bin_path, proto = CHROME_BIN, "cdp"
        try:
            from .browser_drivers import resolve_bin

            drv = await resolve_bin()
            bin_path = str(drv.get("path") or CHROME_BIN)
            proto = str(drv.get("proto") or "cdp")
        except Exception:  # pragma: no cover
            logger.exception("读取浏览器驱动设置失败，退回系统 Chromium")
        if not Path(bin_path).exists():
            where = (
                "这台机器上没有系统 Chromium（也没有选托管版本）"
                if not bin_path
                else f"驱动不在了：{bin_path}"
            )
            raise RuntimeError(f"{where} —— 到「环境配置 → 浏览器驱动」装一个并选中（或点一下自检看缺什么）")
        self._proto = proto
        if proto != "cdp":
            await self._ensure_bidi(bin_path)
            return
        user_data = profile_dir_for(self.key)
        user_data.mkdir(parents=True, exist_ok=True)
        # 起之前先把这个会话的 profile 收回干净：残留的 Chromium 会让新实例
        # 直接 Failed to create SingletonLock 退出（复测现场就是这个）
        reap_profile(self.key)
        args = [
            bin_path,
            "--headless=new",
            f"--user-data-dir={user_data}",
            "--no-sandbox",
            "--disable-gpu",
            "--no-first-run",
            # 不画滚动条：帧里那条 15px 的灰边会让人以为画面被裁了
            "--hide-scrollbars",
            "--remote-debugging-port=0",
            f"--window-size={VIEWPORT['width']},{VIEWPORT['height']}",
        ]
        if self._proxy:
            args.append(f"--proxy-server={self._proxy}")
        try:
            ws_url = await self._launch(args)
        except _StartFailed as first:
            # 一次自动重试：清锁+清残留后再起（用户不该为"上一次没退干净"付费）
            logger.warning("浏览器第一次启动失败，清理 profile 后重试：%s", first.headline)
            reap_profile(self.key)
            user_data.mkdir(parents=True, exist_ok=True)
            try:
                ws_url = await self._launch(args)
            except _StartFailed as second:
                raise RuntimeError(
                    self._startup_error(second.tail or first.tail, bin_path, second.headline, retried=True)
                ) from None
        self._ws_url = ws_url
        self._cdp = await _Cdp.connect(ws_url)
        await self._cdp.attach_page()
        await self._cdp.send("Page.enable")
        await self._cdp.send("Runtime.enable")
        # 视口要**显式钉死**，不能指望 --window-size：
        # headless=new 的窗口含浏览器自己的界面，实测 800x600 的窗口里页面只有
        # 785x400 —— 截图少掉下面三分之一，用户看到的就是"页面显示不完整"。
        # 用 Emulation 覆盖成 800x600 之后，截图的宽高比才和真实浏览一致。
        try:
            await self._cdp.send(
                "Emulation.setDeviceMetricsOverride",
                {
                    "width": VIEWPORT["width"],
                    "height": VIEWPORT["height"],
                    "deviceScaleFactor": VIEWPORT["deviceScaleFactor"],
                    "mobile": False,
                },
            )
        except Exception:  # pragma: no cover —— 老内核没有这个方法就退回窗口尺寸
            logger.debug("设定视口失败，沿用窗口尺寸", exc_info=True)
        # 画面流：Chromium 主动推帧（每有变化才推）
        self._cdp.on("Page.screencastFrame", self._handle_frame)
        await self._start_screencast("jpeg")
        if self._idle_task is None:
            self._idle_task = asyncio.create_task(self._idle_tick())

    async def _start_screencast(self, mode: str) -> None:
        """按模式（重）启 screencast。

        · ``jpeg``：兼容模式/喂 SSE 的那条，5fps、800 宽 —— 2026-10-22 修卡顿时
          定下的口径，别放宽（tests/test_browser_frame_throttle.py 守着）。
        · ``video``：WebRTC 主链路，1280 宽、24fps、质量 68。SSE 那边仍由
          ``_handle_frame`` 按 200ms 节流，前端不会因为视频档被灌满。
        """
        if self._cdp is None:
            return
        if self._screencast_on and self._screencast_mode == mode:
            return
        if self._screencast_on:
            try:
                await self._cdp.send("Page.stopScreencast")
            except Exception:  # pragma: no cover - 没在推时停会报错，忽略
                pass
        params: dict[str, Any] = {
            "format": "jpeg",
            "quality": FRAME_QUALITY if mode == "jpeg" else VIDEO_FRAME_QUALITY,
            "maxWidth": 800 if mode == "jpeg" else VIEWPORT["width"],
            "maxHeight": 500 if mode == "jpeg" else VIEWPORT["height"],
            # 兼容模式也取满帧（不再每 4 帧才给 1 帧）。两个限流叠在一起时，
            # 画得慢的页面（合成器只以 10~15Hz 出图）会先被除以 4 掉到 2~3fps。
            # 帧率口径现在统一在后端那个 200ms 节流上（见 _emit_frame/FRAME_MIN_INTERVAL_MS）；
            # 静止页面的 0 帧由 _idle_tick 的保活帧补上。
            "everyNthFrame": 1,
        }
        if mode == "video":
            params["maxFrameRate"] = VIDEO_MAX_FPS
        try:
            await self._cdp.send("Page.startScreencast", params)
        except Exception:
            # 老内核不认识 maxFrameRate 时退回不带它的调用（不影响画面，只是更快丢帧）
            logger.info("startScreencast 带 maxFrameRate 失败，退回默认参数", exc_info=True)
            params.pop("maxFrameRate", None)
            await self._cdp.send("Page.startScreencast", params)
        self._screencast_mode = mode
        self._screencast_on = True

    async def enable_video_mode(self, sink: Any) -> None:
        """WebRTC 连上/开始协商：把 CDP 的帧率提上来，帧同时喂给视频轨。"""
        await self._ensure()
        if self._bidi is not None:
            raise RuntimeError("Firefox/BiDi 内核不支持推流（画面走定时截图）")
        self._video_sink = sink
        await self._start_screencast("video")

    async def disable_video_mode(self, sink: Any = None) -> None:
        if self._closing:
            return
        if sink is not None and self._video_sink is not sink:
            return  # 已经有别的观看者接管了，别把它关掉
        self._video_sink = None
        try:
            await self._start_screencast("jpeg")
        except Exception:  # pragma: no cover - 浏览器已退出
            logger.debug("恢复 JPEG 推流失败", exc_info=True)

    async def _handle_frame(self, params: dict[str, Any]) -> None:
        """帧到达：回 ack（不 ack Chromium 会暂停推流），然后推给 EventBus。"""
        if self._cdp is None:
            return
        await self._emit_frame(str(params.get("data", "")), params.get("sessionId"))
        if self._idle_task is None and self._screencast_on:
            # 页面静止时 Chromium 不再推帧，5fps 的数字会掉到 0（复测现场被读成"卡死"）。
            # 有变化就由真帧说话，没变化由保活补上 —— 见 _idle_tick。
            self._idle_task = asyncio.create_task(self._idle_tick())

    async def _emit_frame(
        self, data: str, session_id: Any = None, *, ack: bool = True, throttle: bool = True
    ) -> bool:
        """一帧的去向：喂视频轨（不等节流）+ 节流后进 SSE。返回这次有没有进 SSE。

        ``throttle=False`` 给保活帧用：它自己按 200ms 排好了节奏，再被节流一次
        就会因为几毫秒抖动被丢掉（实测掉到 4fps 以下，面板上看着不像 5fps）。
        """
        if not data:
            return False
        if ack and self._cdp is not None:
            try:
                await self._cdp.send("Page.screencastFrameAck", {"sessionId": session_id})
            except Exception:  # pragma: no cover
                pass
        # WebRTC 主链路：视频档的帧（1280 宽、24fps）**不等 SSE 节流**，每帧都进
        # 视频轨。体积上限也放宽（高质量 JPEG 在复杂页面上会超过 400KB，但视频轨
        # 是一帧一帧解码的，不存在把 SSE 堵住的问题）。
        if self._video_sink is not None:
            try:
                self._video_sink.push(data)
            except Exception:  # pragma: no cover
                logger.debug("视频轨喂帧失败", exc_info=True)
        if len(data) > FRAME_MAX_BYTES:
            return False
        now_ms = time.monotonic() * 1000.0
        if throttle:
            if ack:
                # 真帧的时间戳单独记：保活帧靠它判断"页面刚刚动过，我先让路"
                self._last_real_frame_at = now_ms
            # 节流：Chromium 在页面有动画/滚动时会猛推帧，按最小间隔丢掉多余的
            if now_ms - self._last_frame_at < FRAME_MIN_INTERVAL_MS:
                return False
            self._last_frame_at = now_ms
        # 留最后一张：run 结束存成会话文件，刷新页面后还能看到"它最后停在哪儿"。
        # 只收 http(s) 的帧 —— Chromium 被收尾时会吐 about:blank 的白屏帧，
        # 收下它就等于把"最后一屏"存成一张空白图。
        if self._last_url.startswith(("http://", "https://")):
            self._last_frame = data
        try:
            self._on_frame(self.run_id, data, self._last_url, self._last_title)
        except Exception:  # pragma: no cover
            logger.exception("浏览器帧推送失败")
        return True

    async def _idle_tick(self) -> None:
        """兼容模式的保活帧：页面没变化时按 5fps 主动截一张。

        为什么需要它：``Page.startScreencast`` 只在**页面有变化**时推帧，静止页面
        的帧率本来就是 0 —— 面板上那个"实时 fps"就会显示 0~1fps，用户读成"卡了/
        坏了"（复测现场就是这句）。这里在"没帧 + 有人在看"时用
        ``Page.captureScreenshot`` 主动补一帧（实测 1280×800 一次 ~43ms，
        缩到 800×500 后 ~35ms），代价只在**真的有人在看且页面不动**时才付。
        页面一动，真帧先到，这里就自动让路（见 0.35s 判断）。
        """
        try:
            while not self._closing and self._cdp is not None:
                # 节奏按"开始截"到"下一轮开始截"的间隔算：截一张要 35~45ms，
                # 若只是固定 sleep 200ms，实测会掉到 4.3fps（面板上就不像 5fps）
                tick_at = time.monotonic()
                if self._video_sink is not None:
                    await asyncio.sleep(FRAME_MIN_INTERVAL_MS / 1000.0)
                    continue  # 视频档自己有帧，别抢
                if not self._has_watcher():
                    await asyncio.sleep(FRAME_MIN_INTERVAL_MS / 1000.0)
                    continue  # 没人在看：一帧都不截（不拿空闲页面的 CPU 开玩笑）
                if time.monotonic() * 1000.0 - self._last_real_frame_at < 350:
                    await asyncio.sleep(FRAME_MIN_INTERVAL_MS / 1000.0)
                    continue  # 刚有真帧（页面在动）：这一拍让给它
                try:
                    r = await self._cdp.send(
                        "Page.captureScreenshot",
                        {
                            "format": "jpeg",
                            "quality": FRAME_QUALITY,
                            "captureBeyondViewport": False,
                            "clip": {
                                "x": 0,
                                "y": 0,
                                "width": VIEWPORT["width"],
                                "height": VIEWPORT["height"],
                                "scale": 0.625,  # 1280×800 → 800×500，与兼容模式的帧同尺寸
                            },
                        },
                    )
                    data = (r.get("result") or {}).get("data") or ""
                except Exception:  # pragma: no cover - 页面正在跳转/正在关
                    await asyncio.sleep(FRAME_MIN_INTERVAL_MS / 1000.0)
                    continue
                await self._emit_frame(str(data), ack=False, throttle=False)
                spent = time.monotonic() - tick_at
                await asyncio.sleep(max(0.0, FRAME_MIN_INTERVAL_MS / 1000.0 - spent))
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover
            logger.debug("保活帧循环退出", exc_info=True)

    def _has_watcher(self) -> bool:
        """这个会话的画面上有没有活的订阅者（SSE 连着面板/缩略条）。"""
        try:
            from .runner.service import bus

            chan = f"sess:{self.session_id}" if self.session_id else f"run:{self.run_id}"
            return bus.watchers(chan) > 0
        except Exception:  # pragma: no cover
            return False

    # -- BiDi（Firefox）----------------------------------------------------- #
    async def _ensure_bidi(self, bin_path: str) -> None:
        """拉起 Firefox 并连上它的 BiDi 端点。

        Firefox 不像 Chromium 有 ``--remote-debugging-port=0`` 自动分配端口那样稳，
        这里自己挑一个空闲端口，再从 stderr 的 ``WebDriver BiDi listening on`` 行确认。
        """
        if self._bidi is not None:
            return
        import socket

        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()

        profile = Path(f"/tmp/agent-studio-browser/{self.key.replace(':', '-')}/ff-profile")
        profile.mkdir(parents=True, exist_ok=True)
        args = [
            bin_path,
            "--headless",
            f"--remote-debugging-port={port}",
            f"--profile={profile}",
            "--no-remote",
            f"--width={VIEWPORT['width']}",
            f"--height={VIEWPORT['height']}",
            "about:blank",
        ]
        if self._proxy:
            args.insert(1, f"--proxy-server={self._proxy}")
        self._proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=self._child_env(),
        )
        ws_url = ""
        assert self._proc.stdout is not None
        try:
            while True:
                line = await asyncio.wait_for(self._proc.stdout.readline(), timeout=25)
                text = line.decode("utf-8", errors="replace")
                if "WebDriver BiDi listening on ws://" in text:
                    ws_url = text.split("WebDriver BiDi listening on ", 1)[1].strip()
                    break
                if not line:
                    break
        except TimeoutError:
            await self.close()
            raise RuntimeError("Firefox 启动后 25s 内没报 BiDi 端点") from None
        if not ws_url:
            await self.close()
            raise RuntimeError("Firefox 启动失败（没有 BiDi 行）")

        self._bidi = await _Bidi.connect(ws_url.rstrip("/") + "/session")
        await self._bidi.send("session.new", {"capabilities": {}})
        tree = await self._bidi.send("browsingContext.getTree", {"maxDepth": 1})
        ctxs = tree.get("contexts") or []
        if not ctxs:
            await self.close()
            raise RuntimeError("Firefox 里没有可用的浏览上下文")
        self._ctx = str(ctxs[0].get("context") or "")
        try:  # 视口跟 Chromium 对齐，画面/坐标才有可比性
            await self._bidi.send(
                "browsingContext.setViewport",
                {"context": self._ctx, "viewport": {"width": VIEWPORT["width"], "height": VIEWPORT["height"]}},
            )
        except Exception:  # pragma: no cover
            logger.info("Firefox 不支持 setViewport，沿用窗口尺寸")
        self._frame_task = asyncio.create_task(self._bidi_frames())

    async def _bidi_frames(self) -> None:
        """定时截图当"画面流"（BiDi 没有 screencast 事件）。"""
        while self._bidi is not None:
            await asyncio.sleep(0.9)
            if self._bidi is None or not self._last_url.startswith(("http://", "https://")):
                continue
            try:
                shot = await self._bidi.send(
                    "browsingContext.captureScreenshot",
                    {"context": self._ctx, "origin": "viewport", "format": {"type": "image/jpeg", "quality": 0.55}},
                )
                data = str(shot.get("data") or "")
                if data and len(data) <= FRAME_MAX_BYTES:
                    self._last_frame = data
                    self._on_frame(self.run_id, data, self._last_url, self._last_title)
            except Exception:  # pragma: no cover
                logger.debug("Firefox 帧抓取失败", exc_info=True)

    async def _eval(self, expr: str) -> Any:
        """在页面里求值（统一 JSON.stringify，省掉 RemoteValue 解包）。"""
        assert self._bidi is not None
        r = await self._bidi.send(
            "script.evaluate",
            {
                "expression": f"JSON.stringify({expr})",
                "target": {"context": self._ctx},
                "awaitPromise": True,
                "resultOwnership": "none",
            },
        )
        raw = (r.get("result") or {}).get("value")
        if raw in (None, "null", "undefined"):
            return None
        try:
            return json.loads(raw)
        except Exception:
            return raw

    async def _refresh_meta_bidi(self) -> None:
        try:
            val = await self._eval("document.URL + '\\u0001' + document.title")
        except Exception:
            return
        if isinstance(val, str) and "\u0001" in val:
            self._last_url, self._last_title = val.split("\u0001", 1)

    async def _bidi_navigate(self, url: str, wait_s: float) -> str:
        assert self._bidi is not None
        self._last_url = url
        await self._bidi.send(
            "browsingContext.navigate", {"context": self._ctx, "url": url, "wait": "complete"}
        )
        await asyncio.sleep(min(max(wait_s, 0.5), 10))
        await self._refresh_meta_bidi()
        return f"已打开 {self._last_url}（标题: {self._last_title}）"

    async def _bidi_center(self, selector: str) -> tuple[float, float] | str:
        """选择器 → 视口坐标（找不到就返回一句错误文案）。"""
        expr = (
            "(() => {const el=document.querySelector(%s); if(!el) return null;"
            "const r=el.getBoundingClientRect(); if(r.width===0&&r.height===0) return null;"
            "return {x:r.x+r.width/2, y:r.y+r.height/2};})()" % json.dumps(selector)
        )
        try:
            val = await self._eval(expr)
        except Exception as exc:  # noqa: BLE001
            return f"✗ 解析选择器失败: {exc}"
        if not isinstance(val, dict):
            return f"✗ 找不到元素: {selector}"
        return float(val.get("x") or 0), float(val.get("y") or 0)

    async def _bidi_click_xy(self, x: float, y: float) -> None:
        assert self._bidi is not None
        await self._bidi.send(
            "input.performActions",
            {
                "context": self._ctx,
                "actions": [
                    {
                        "type": "pointer",
                        "id": "mouse",
                        "parameters": {"pointerType": "mouse"},
                        "actions": [
                            {"type": "pointerMove", "x": int(x), "y": int(y), "origin": "viewport"},
                            {"type": "pointerDown", "button": 0},
                            {"type": "pointerUp", "button": 0},
                        ],
                    }
                ],
            },
        )

    async def _bidi_type(self, text: str) -> None:
        assert self._bidi is not None
        actions = []
        for ch in text:
            actions.append({"type": "keyDown", "value": ch})
            actions.append({"type": "keyUp", "value": ch})
        await self._bidi.send(
            "input.performActions",
            {"context": self._ctx, "actions": [{"type": "key", "id": "kb", "actions": actions}]},
        )

    async def _bidi_read(self, selector: str) -> str:
        expr = (
            "(() => {const el=document.querySelector(%s); if(!el) return null;"
            "if('value' in el && typeof el.value==='string') return el.value;"
            "return el.innerText || el.textContent || '';})()" % json.dumps(selector)
        )
        try:
            val = await self._eval(expr)
        except Exception:  # pragma: no cover
            return f"✗ 读取超时或被中断：{selector}"
        if val is None:
            return f"✗ 找不到元素: {selector}"
        text = str(val)
        return text[:READ_MAX_CHARS] + ("\n…（已截断）" if len(text) > READ_MAX_CHARS else "")

    # -- 动作 --------------------------------------------------------------- #
    def _check_url(self, url: str) -> str | None:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return f"✗ 只支持 http/https，收到: {parsed.scheme or '(空)'}"
        if not parsed.hostname:
            return "✗ URL 里没有主机名"
        if _private_host_check(parsed.hostname):
            return f"✗ 出于安全考虑不能访问内网地址: {parsed.hostname}"
        return None

    async def _refresh_meta(self) -> None:
        if self._cdp is None:
            return
        r = await self._cdp.send("Runtime.evaluate", {"expression": "document.URL + '\\u0001' + document.title"})
        val = (r.get("result") or {}).get("result", {}).get("value", "")
        if isinstance(val, str) and "\u0001" in val:
            self._last_url, self._last_title = val.split("\u0001", 1)

    async def navigate(self, url: str, wait_s: float = 3.0) -> str:
        err = self._check_url(url)
        if err:
            return err
        await self._ensure()
        if self._bidi is not None:
            return await self._bidi_navigate(url, wait_s)
        assert self._cdp is not None
        # 先按请求的地址记下 —— `_refresh_meta` 靠 Runtime.evaluate 读 document.URL，
        # 偶尔读不回来（页面还在跳转/执行上下文被换掉），那样帧事件里的 url 就是空的，
        # 前端只能显示"还没打开页面"。请求地址是最可靠的兜底。
        self._last_url = url
        await self._cdp.send("Page.navigate", {"url": url})
        await asyncio.sleep(min(max(wait_s, 0.5), 10))
        await self._refresh_meta()
        return f"已打开 {self._last_url}（标题: {self._last_title}）"

    async def _find_selector(self, selector: str) -> dict[str, Any]:
        """把 CSS 选择器解析成元素坐标（CDP 的点击是坐标派发，不是 DOM 调用）。"""
        assert self._cdp is not None
        js = (
            "JSON.stringify((() => { const el = document.querySelector(" + json.dumps(selector) + ");"
            " if (!el) return null; const r = el.getBoundingClientRect();"
            " return {x: r.x + r.width/2, y: r.y + r.height/2, visible: r.width > 0 && r.height > 0}; })())"
        )
        r = await self._cdp.send("Runtime.evaluate", {"expression": js, "returnByValue": True})
        val = (r.get("result") or {}).get("result", {}).get("value")
        if not val:
            return {}
        try:
            return json.loads(val)
        except Exception:
            return {}

    async def click(self, selector: str) -> str:
        await self._ensure()
        if self._bidi is not None:
            c = await self._bidi_center(selector)
            if isinstance(c, str):
                return c
            await self._bidi_click_xy(*c)
            await asyncio.sleep(0.8)
            await self._refresh_meta_bidi()
            return f"已点击 {selector}（页面: {self._last_url}）"
        box = await self._find_selector(selector)
        if not box:
            return f"✗ 没找到元素: {selector}"
        if not box.get("visible"):
            return f"✗ 元素不可见（可能被遮挡或 display:none）: {selector}"
        assert self._cdp is not None
        x, y = box["x"], box["y"]
        self._last_click = (float(x), float(y))
        for etype, btns in (
            ("mousePressed", 0),
            ("mouseReleased", 2),
        ):
            await self._cdp.send(
                "Input.dispatchMouseEvent",
                {"type": etype, "x": x, "y": y, "button": "left", "clickCount": 1, "buttons": btns},
            )
        await asyncio.sleep(0.8)
        await self._refresh_meta()
        return f"已点击 {selector}（页面: {self._last_url}）"

    async def type_text(self, selector: str, value: str) -> str:
        await self._ensure()
        if self._bidi is not None:
            c = await self._bidi_center(selector)
            if isinstance(c, str):
                return c
            await self._bidi_click_xy(*c)
            await asyncio.sleep(0.2)
            await self._bidi_type(value)
            await asyncio.sleep(0.3)
            return f"已在 {selector} 输入 {len(value)} 个字符"
        box = await self._find_selector(selector)
        if not box:
            return f"✗ 没找到元素: {selector}"
        assert self._cdp is not None
        # 先点聚焦，再逐键输入（真实键盘事件，oninput/框架都能吃到）
        await self._cdp.send(
            "Input.dispatchMouseEvent",
            {"type": "mousePressed", "x": box["x"], "y": box["y"], "button": "left", "clickCount": 1, "buttons": 0},
        )
        await self._cdp.send(
            "Input.dispatchMouseEvent",
            {"type": "mouseReleased", "x": box["x"], "y": box["y"], "button": "left", "clickCount": 1, "buttons": 2},
        )
        await self._cdp.send("Input.insertText", {"text": value})
        await asyncio.sleep(0.3)
        return f"已在 {selector} 输入 {len(value)} 个字符"

    async def read(self, selector: str = "body") -> str:
        await self._ensure()
        if self._bidi is not None:
            body = await self._bidi_read(selector)
            await self._refresh_meta_bidi()
            return f"[{self._last_title}] {self._last_url}\n{body}"
        assert self._cdp is not None
        # 输入框优先返回 value（innerText 是空的）：用户/助手都靠它确认"刚才打的字进去了"，
        # 和 BiDi 那条路保持一致。
        js = (
            "(() => { const el = document.querySelector(" + json.dumps(selector) + ") || document.body;"
            " if ('value' in el && typeof el.value === 'string') return el.value;"
            " return (el.innerText || '').slice(0, %d); })()" % READ_MAX_CHARS
        )
        r = await self._cdp.send("Runtime.evaluate", {"expression": js, "returnByValue": True})
        val = (r.get("result") or {}).get("result", {}).get("value", "")
        await self._refresh_meta()
        return f"[{self._last_title}] {self._last_url}\\n{val or '(页面没有文本)'}"

    async def scroll(self, dy: int = 600) -> str:
        await self._ensure()
        if self._bidi is not None:
            await self._eval(f"window.scrollBy(0, {int(dy)}) || 0")
            await asyncio.sleep(0.4)
            return f"已滚动 {int(dy)}px"
        assert self._cdp is not None
        await self._cdp.send("Runtime.evaluate", {"expression": f"window.scrollBy(0, {int(dy)})"})
        await asyncio.sleep(0.4)
        return f"已滚动 {int(dy)}px"

    async def snapshot(self, quality: int = 50) -> str | None:
        """抓一张当前画面（base64 JPEG）—— 执行过程留档用。

        screencast 的帧只进内存（seq<0、不落库），刷新就没了；用户要"回看它当时
        看到了什么"，就必须在**每个动作之后**主动存一张。
        """
        if self._bidi is not None:
            try:
                shot = await self._bidi.send(
                    "browsingContext.captureScreenshot",
                    {
                        "context": self._ctx,
                        "origin": "viewport",
                        # BiDi 的 quality 是 0~1（传 0~100 的整数会被协议直接拒掉）
                        "format": {"type": "image/jpeg", "quality": max(0.2, min(1.0, quality / 100))},
                    },
                )
                return str(shot.get("data") or "") or None
            except Exception:  # pragma: no cover
                logger.debug("Firefox 截图失败", exc_info=True)
                return None
        if self._cdp is None:
            return None
        try:
            r = await self._cdp.send(
                "Page.captureScreenshot", {"format": "jpeg", "quality": quality, "captureBeyondViewport": False}
            )
            data = (r.get("result") or {}).get("data") or ""
            return data or None
        except Exception:  # pragma: no cover
            logger.debug("截图失败", exc_info=True)
            return None

    async def element_label(self, x: float, y: float) -> str:
        """坐标 → 人话（给人看的动作记录用：用户在哪儿点了什么）。

        用户点完要回灌给助手"用户点了搜索框"这类话 —— 只记坐标等于没说。
        """
        expr = (
            "(() => {const el=document.elementFromPoint(%s,%s); if(!el) return '';"
            "const ph=(el.getAttribute&&(el.getAttribute('placeholder')||el.getAttribute('aria-label')||''))||'';"
            "const t=(el.innerText||el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,24);"
            "const tag=(el.tagName||'').toLowerCase();"
            "return [tag, ph, t].filter(Boolean).join(' ');})()" % (float(x), float(y))
        )
        try:
            if self._bidi is not None:
                return str(await self._eval(expr) or "")[:40]
            if self._cdp is None:
                return ""
            js = "JSON.stringify(" + expr + ")"
            r = await self._cdp.send("Runtime.evaluate", {"expression": js, "returnByValue": True})
            val = (r.get("result") or {}).get("result", {}).get("value")
            return str(json.loads(val) if val else "")[:40]
        except Exception:  # pragma: no cover
            return ""

    async def mouse_move(self, x: float, y: float) -> None:
        """鼠标移动（悬停/拖拽的前提）。"""
        await self._ensure()
        if self._bidi is not None:
            await self._bidi.send(
                "input.performActions",
                {
                    "context": self._ctx,
                    "actions": [
                        {
                            "type": "pointer",
                            "id": "mouse",
                            "parameters": {"pointerType": "mouse"},
                            "actions": [{"type": "pointerMove", "x": int(x), "y": int(y), "origin": "viewport"}],
                        }
                    ],
                },
            )
            return
        assert self._cdp is not None
        await self._cdp.send(
            "Input.dispatchMouseEvent",
            {"type": "mouseMoved", "x": float(x), "y": float(y), "button": "none", "buttons": 0},
        )

    async def _dispatch_click(self, x: float, y: float, button: str, click_count: int) -> None:
        """派发一次真实的按下+松开（按下=左1/右2/中4，松开=0）。"""
        assert self._cdp is not None
        bits = {"left": (1, 0), "middle": (4, 0), "right": (2, 0)}.get(button, (1, 0))
        for etype, buttons in (("mousePressed", bits[0]), ("mouseReleased", bits[1])):
            await self._cdp.send(
                "Input.dispatchMouseEvent",
                {
                    "type": etype,
                    "x": float(x),
                    "y": float(y),
                    "button": button,
                    "clickCount": int(click_count or 1),
                    "buttons": buttons,
                },
            )

    async def _focus_state_at(self, x: float, y: float) -> dict[str, Any]:
        """这个点上是什么、它是不是输入控件、焦点是不是已经在它上面。"""
        expr = (
            "(() => {const el=document.elementFromPoint(%s,%s); if(!el) return {kind:'none'};"
            "const t=(el.tagName||'').toUpperCase();"
            "const editable = t==='INPUT'||t==='TEXTAREA'||el.isContentEditable===true;"
            "return {kind:t, editable:editable, focused: !!editable && document.activeElement===el,"
            " ph:(el.getAttribute&&(el.getAttribute('placeholder')||el.getAttribute('aria-label')))||''};"
            "})()" % (float(x), float(y))
        )
        return await self._js(expr) or {}

    async def user_click(
        self, x: float, y: float, button: str = "left", click_count: int = 1
    ) -> str:
        """用户在画面上点了一下（坐标已由前端按内容区换算成视口坐标）。"""
        await self._ensure()
        if self._bidi is not None:
            await self._bidi_click_xy(x, y)
            await asyncio.sleep(0.5)
            await self._refresh_meta_bidi()
            return f"用户点击 ({int(x)},{int(y)})，当前页面: {self._last_url}"
        assert self._cdp is not None
        self._last_click = (float(x), float(y))
        await self._dispatch_click(x, y, button, click_count)
        await asyncio.sleep(0.35)
        # 点在**输入控件**上就必须确认焦点真的落在它上面。
        # 页面（Bing 这类）点完会把控件重新渲染一遍，焦点掉到 body ——
        # 那时面板里打的字会全部丢掉（复测现场："点了搜索框，打字进不去"）。
        focus = await self._focus_state_at(x, y)
        self._last_click_editable = bool(focus.get("editable"))
        if focus.get("editable") and not focus.get("focused"):
            await self._dispatch_click(x, y, button, click_count)  # 再点一次（页面刚重渲染）
            await asyncio.sleep(0.2)
            focus = await self._focus_state_at(x, y)
            if not focus.get("focused"):
                # 点击被页面吞掉：直接让 DOM 聚焦同一个点上的控件
                await self._js(
                    "(() => {const el=document.elementFromPoint(%s,%s);"
                    " if(el && el.focus) el.focus(); return true;})()" % (float(x), float(y))
                )
                await asyncio.sleep(0.1)
        await self._refresh_meta()
        return f"用户点击 ({int(x)},{int(y)})，当前页面: {self._last_url}"

    async def wheel(self, x: float, y: float, dx: float = 0, dy: float = 0) -> str:
        """在指针位置滚轮（不是 window.scrollBy —— 页面里的横向容器/地图也要能滚）。"""
        await self._ensure()
        if self._bidi is not None:
            await self._eval(f"window.scrollBy({int(dx)}, {int(dy)}) || 0")
            await asyncio.sleep(0.2)
            return f"已滚动 ({int(dx)},{int(dy)})"
        assert self._cdp is not None
        await self._cdp.send(
            "Input.dispatchMouseEvent",
            {
                "type": "mouseWheel",
                "x": float(x),
                "y": float(y),
                "deltaX": float(dx),
                "deltaY": float(dy),
                "button": "none",
                "buttons": 0,
            },
        )
        return f"已滚动 ({int(dx)},{int(dy)})"

    async def key_event(self, payload: dict[str, Any]) -> str:
        """真实键盘事件（Enter/Tab/Esc/方向键/Backspace/Delete/组合键）。

        前端把 ``KeyboardEvent`` 的 key/code/keyCode 原样送来；这里补 CDP 需要的
        ``windowsVirtualKeyCode``/modifiers/text。可打印字符走 keyDown(text)+keyUp，
        组合键（Ctrl+A 之类）只发 keyDown/keyUp，不给 text（否则浏览器会当成字符）。
        """
        await self._ensure()
        key = str(payload.get("key") or "")
        code = str(payload.get("code") or "")
        if not key and not code:
            return "没有按键"
        mods = 0
        if payload.get("altKey"):
            mods |= 1
        if payload.get("ctrlKey"):
            mods |= 2
        if payload.get("metaKey"):
            mods |= 4
        if payload.get("shiftKey"):
            mods |= 8
        vk = int(payload.get("keyCode") or 0) or _VK.get(key, 0)
        text = ""
        if len(key) == 1 and not (mods & (2 | 4)):
            text = key
        elif key == "Enter":
            text = "\r"
        if self._bidi is not None:
            # BiDi 只有 performActions 的 key 动作：组合键需要逐键 down/up，
            # 这里按「按下修饰键 → 按主键 → 松开」拼一段（够用，不做长按）。
            seq: list[dict[str, Any]] = []
            if payload.get("ctrlKey"):
                seq += [{"type": "keyDown", "value": "\uE009"}, {"type": "keyUp", "value": "\uE009"}]
            seq.append({"type": "keyDown", "value": key})
            seq.append({"type": "keyUp", "value": key})
            await self._bidi.send(
                "input.performActions",
                {"context": self._ctx, "actions": [{"type": "key", "id": "kb", "actions": seq}]},
            )
            await asyncio.sleep(0.1)
            return f"已按键 {describe_key(payload)}"
        assert self._cdp is not None
        base: dict[str, Any] = {
            "key": key,
            "code": code,
            "windowsVirtualKeyCode": vk,
            "nativeVirtualKeyCode": vk,
            "modifiers": mods,
            "autoRepeat": bool(payload.get("repeat")),
            "isKeypad": bool(payload.get("location") == 3),
            "location": int(payload.get("location") or 0),
        }
        await self._cdp.send("Input.dispatchKeyEvent", {"type": "keyDown", **base})
        if text and len(text) == 1:
            # 字符只由 char 事件插入。keyDown 也带 text 会插入两次（实测输入
            # "a" 得到 "aa"），而只发 keyDown 又会让监听 keypress/input 的页面收不到。
            await self._cdp.send(
                "Input.dispatchKeyEvent", {"type": "char", **base, "text": text, "unmodifiedText": text}
            )
        await self._cdp.send("Input.dispatchKeyEvent", {"type": "keyUp", **{k: v for k, v in base.items() if k not in ("text", "unmodifiedText")}})
        await asyncio.sleep(0.05)
        return f"已按键 {describe_key(payload)}"

    async def hit_test(self, x: float, y: float) -> dict[str, Any]:
        """点击位置到底是什么：给\"有没有点中可交互元素\"一个事实依据。"""
        expr = (
            "(() => {const el=document.elementFromPoint(%s,%s); if(!el) return null;"
            "const hit=el.closest('a,button,input,select,textarea,label,summary,"
            "[role=\"button\"],[role=\"link\"],[onclick],[tabindex]');"
            "const t=(el.innerText||el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,40);"
            "const ph=(el.getAttribute&&(el.getAttribute('placeholder')||el.getAttribute('aria-label')||''))||'';"
            "const h=hit&&(hit.getAttribute('href')||hit.getAttribute('aria-label')||'');"
            "return {tag:(el.tagName||'').toLowerCase(), actionable:!!hit,"
            " hitTag:hit?hit.tagName.toLowerCase():'', label:[(el.tagName||'').toLowerCase(),ph,t].filter(Boolean).join(' '),"
            " href:h||''};})()" % (float(x), float(y))
        )
        try:
            if self._bidi is not None:
                val = await self._eval(expr)
            else:
                assert self._cdp is not None
                r = await self._cdp.send(
                    "Runtime.evaluate", {"expression": "JSON.stringify(" + expr + ")", "returnByValue": True}
                )
                raw = (r.get("result") or {}).get("result", {}).get("value")
                val = json.loads(raw) if raw else None
        except Exception:  # pragma: no cover
            return {}
        return val if isinstance(val, dict) else {}

    async def page_signature(self) -> str:
        """页面\"看起来变没变\"的廉价指纹（URL/标题/滚动位置/文本长度/焦点）。"""
        expr = (
            "(() => {const b=document.body; const ae=document.activeElement;"
            "return [document.URL, document.title, Math.round(window.scrollY||0),"
            "(b&&(b.innerText||'').length)||0, ae?(ae.tagName||'')+':'+(ae.id||ae.name||''):''].join('|');})()"
        )
        try:
            if self._bidi is not None:
                val = await self._eval(expr)
                return str(val or "")
            if self._cdp is None:
                return ""
            r = await self._cdp.send(
                "Runtime.evaluate", {"expression": "JSON.stringify(" + expr + ")", "returnByValue": True}
            )
            raw = (r.get("result") or {}).get("result", {}).get("value")
            return str(json.loads(raw) if raw else "")
        except Exception:  # pragma: no cover
            return ""

    async def _js(self, expr: str) -> Any:
        """Runtime.evaluate + JSON.stringify 的小工具（CDP 通路通用）。"""
        assert self._cdp is not None
        r = await self._cdp.send(
            "Runtime.evaluate", {"expression": "JSON.stringify(" + expr + ")", "returnByValue": True}
        )
        raw = (r.get("result") or {}).get("result", {}).get("value")
        if not raw:
            return None
        try:
            return json.loads(raw)
        except Exception:  # pragma: no cover
            return None

    async def _focus_probe(self) -> dict[str, Any]:
        """当前焦点是不是可输入元素 + 它的当前值（打字回读的唯一依据）。"""
        expr = (
            "(() => {const a=document.activeElement; if(!a) return {editable:false};"
            "const t=(a.tagName||'').toUpperCase();"
            "const editable = t==='INPUT'||t==='TEXTAREA'||a.isContentEditable===true;"
            "let v=''; if('value' in a && typeof a.value==='string') v=a.value;"
            "else if(a.isContentEditable) v=a.innerText||'';"
            "return {editable: editable, tag: t, value: v,"
            " ph:(a.getAttribute&&(a.getAttribute('placeholder')||a.getAttribute('aria-label')))||''};})()"
        )
        return await self._js(expr) or {}

    async def _refocus(self) -> bool:
        """把焦点放回**上一次点过的输入框**。

        为什么要这一步：页面（Bing 这类）在点击后会把输入控件重新渲染一遍，
        焦点掉到 body，``Input.insertText`` 就打进空气里 —— 面板上看着"打了字"，
        页面却是空的（复测现场）。用同一个坐标再点一次能把焦点拿回来。

        只在"上一次点中的确实是输入控件"时才重放这次点击：否则用户点了个链接
        又打字，这里会把链接点开第二遍（页面被带走）。
        """
        if not self._last_click or not self._last_click_editable:
            return False
        x, y = self._last_click
        try:
            await self.user_click(x, y)
        except Exception:  # pragma: no cover
            return False
        info = await self._focus_probe()
        return bool(info.get("editable"))

    async def _type_chars(self, text: str) -> None:
        """逐字符兜底：真键盘事件（只监听 keydown/keypress 的页面吃 insertText 不吃）。"""
        assert self._cdp is not None
        for ch in text:
            await self._cdp.send(
                "Input.dispatchKeyEvent",
                {"type": "keyDown", "key": ch, "text": ch, "unmodifiedText": ch},
            )
            await self._cdp.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": ch})
            await asyncio.sleep(0.01)

    @staticmethod
    def _typed_ok(before: str, after: str, text: str) -> bool:
        """回读判定：新值里能看见这段文字（或至少变长了）。"""
        if after == before:
            return False
        return text in after or len(after) > len(before)

    async def user_type(self, text: str) -> str:
        """用户通过页面输入条打的字（整段插入，兼容中文输入法）。

        **必须回读验证**：插入成功 ≠ 文字进了页面。焦点不在输入框时
        ``Input.insertText`` 静默丢弃，用户看到的是"打了但框里是空的"。
        所以这里三步：① 插入后回读；② 没进去就重新聚焦 + 逐字符键盘事件再来一次；
        ③ 还不行就把原因**原样返回**（面板会立刻显示，而不是假装成功）。
        """
        await self._ensure()
        if self._bidi is not None:
            await self._bidi_type(text)
            await asyncio.sleep(0.3)
            return f"已输入 {len(text)} 个字符"
        assert self._cdp is not None
        if not text:
            return "没有要输入的内容"
        info = await self._focus_probe()
        if not info.get("editable"):
            # 焦点掉在 body 上（页面刚重渲染过）→ 先用上次点过的地方把焦点拿回来
            await self._refocus()
            info = await self._focus_probe()
        if not info.get("editable"):
            return "✗ 页面里没有输入焦点：先点一下页面里的输入框，再在这里打字"
        base = str(info.get("value") or "")
        await self._cdp.send("Input.insertText", {"text": text})
        await asyncio.sleep(0.25)
        after = str((await self._focus_probe()).get("value") or "")
        if self._typed_ok(base, after, text):
            return f"已在页面输入框输入 {len(text)} 个字符（回读一致）"

        # ② 换一条路：重新聚焦（点击）→ 逐字符真键盘事件
        await self._refocus()
        info2 = await self._focus_probe()
        if info2.get("editable"):
            base2 = str(info2.get("value") or "")
            await self._type_chars(text)
            await asyncio.sleep(0.3)
            after2 = str((await self._focus_probe()).get("value") or "")
            if self._typed_ok(base2, after2, text):
                return f"已用键盘事件输入 {len(text)} 个字符（回读一致）"

        # ③ 真进不去 —— 说清楚，别让用户以为打进去了
        return "✗ 文字没进页面输入框：先点页面里的输入框（看到光标）再在面板里打字"

    async def wait(self, wait_s: float = 1.0) -> str:
        await asyncio.sleep(min(max(wait_s, 0.1), 15))
        if self._bidi is not None:
            await self._refresh_meta_bidi()
            return f"等了 {wait_s}s（当前: {self._last_url}）"
        await self._refresh_meta()
        return f"等了 {wait_s}s（当前: {self._last_url}）"

    async def close(self) -> None:
        self._closing = True
        if self.session_id:
            try:
                from . import browser_webrtc as rtc

                await rtc.close_stream(self.session_id)
            except Exception:  # pragma: no cover - 收尾不该挡住关浏览器
                logger.debug("关闭推流失败", exc_info=True)
        if self._frame_task is not None:
            self._frame_task.cancel()
            self._frame_task = None
        if self._idle_task is not None:
            self._idle_task.cancel()
            self._idle_task = None
        if self._bidi is not None:
            try:
                await self._bidi.close()
            except Exception:  # pragma: no cover
                pass
            self._bidi = None
        if self._cdp is not None:
            try:
                await self._cdp.close()
            except Exception:  # pragma: no cover
                pass
            self._cdp = None
        if self._proc is not None:
            # 独立进程组（start_new_session）→ 整组收掉。只 kill 主进程会留下
            # zygote/renderer，它们还占着 profile 目录（下次启动就是 SingletonLock 报错）。
            import signal

            try:
                os.killpg(os.getpgid(self._proc.pid), signal.SIGKILL)
            except Exception:  # pragma: no cover - 进程已经走了/没有权限
                try:
                    self._proc.kill()
                except Exception:
                    pass
            try:
                await self._proc.wait()
            except Exception:  # pragma: no cover
                pass
            self._proc = None


#: 归属键（ses:<会话号>） → 浏览器实例。run 只是"这一次在用"，不再决定生死。
_SESSIONS: dict[str, BrowserSession] = {}


def get_session(run_id: str, on_frame: Any, proxy: str | None = None, session_id: str = "") -> BrowserSession:
    """取（或建）这个**会话**的浏览器。

    同一个聊天会话里跨 run 复用同一个 Chromium —— 登录态、当前页面、填了一半
    的表单都在。切到新的一轮时只把 ``run_id`` 和帧回调换掉（留档按 run 分目录）。
    """
    key = f"ses:{session_id}" if session_id else f"run:{run_id}"
    sess = _SESSIONS.get(key)
    if sess is None:
        sess = BrowserSession(run_id, on_frame, proxy, session_id=session_id)
        _SESSIONS[key] = sess
    else:
        sess.run_id = run_id
        sess._on_frame = on_frame
        sess._proxy = proxy or sess._proxy
    return sess


def get_existing(key: str) -> BrowserSession | None:
    return _SESSIONS.get(key)


async def close_key(key: str) -> None:
    """收掉某个会话的浏览器 + 它的 profile 目录（过期/删会话时用）。"""
    sess = _SESSIONS.pop(key, None)
    if sess is not None:
        await sess.close()
    _cleanup_dir(Path(f"/tmp/agent-studio-browser/{key.replace(':', '-')}"))


def _cleanup_dir(ud: Path) -> None:
    import shutil

    if not ud.exists():
        return
    # 重试几拍：进程刚 kill 时句柄未放，rmtree 会静默失败留下目录（实测 abort 后残留）
    for _ in range(5):
        shutil.rmtree(ud, ignore_errors=True)
        if not ud.exists():
            return
        time.sleep(0.2)


async def close_all(run_id: str) -> None:
    """**硬关**某个 run 的浏览器（只在明确要收掉现场时用）。

    run 正常结束**不再走这里** —— 见 ``browser_control.on_run_end``：
    浏览器跟着会话保活 30 分钟，run 结束画面仍然可以点。
    """
    sess = _SESSIONS.pop(f"run:{run_id}", None)
    if sess is not None:
        await sess.close()
    _cleanup_dir(Path(f"/tmp/agent-studio-browser/run-{run_id}"))

# --------------------------------------------------------------------------- #
# 暂停/接管
#
# v1 这里是 per-run 的 asyncio.Event（协作式暂停），没有"控制权归属"：
# 暂停期间用户和助手都能发动作，谁后发谁赢。已整体换成会话级状态机
# —— 见 ``browser_control.py``（单一状态源 + 持有者闸门）。
# 这里只留一个兼容别名，避免老调用点 import 失败。
# --------------------------------------------------------------------------- #
async def wait_if_paused(run_id: str, timeout_s: float = 900.0) -> str:  # pragma: no cover
    """已废弃：控制权闸门在 ``browser_control.gate_agent``。"""
    return ""

