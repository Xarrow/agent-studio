"""浏览器会话 —— 让助手在页面上操作浏览器（headless Chromium + CDP 直连）。

设计原则
--------
零第三方浏览器自动化依赖：服务器已有的 Chromium 就是引擎，CDP 是它原生控制协议。
Playwright/Selenium 在这里只会带来几百 MB 依赖和版本匹配烦恼。

生命周期
--------
每个 run 一个 Chromium 子进程（``--user-data-dir`` 落在 run 工作目录下，天然隔离）。
工具每次调用从 contextvar 拿 run_id 复用同一实例 —— 浏览器有状态（cookie/登录），
跨动作共享正是"操作浏览器"的意义。run 结束由 runner 收尾 kill（见 close_all）。

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
#: 视口（帧大小直接决定 SSE 负载；800×600 够看清操作，又不至于帧过大）
VIEWPORT = {"width": 800, "height": 600, "deviceScaleFactor": 1}


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


class BrowserSession:
    """一个 run 的浏览器实例：进程 + CDP + screencast 推流。"""

    def __init__(self, run_id: str, on_frame: Any, proxy: str | None = None) -> None:
        self.run_id = run_id
        self._on_frame = on_frame
        self._proc: asyncio.subprocess.Process | None = None
        self._cdp: _Cdp | None = None
        self._proxy = proxy
        self._ws_url: str | None = None
        self._last_url = ""
        self._last_frame = ""
        self._last_frame_at = 0.0
        self._last_title = ""
        #: 非 CDP 引擎（Firefox/BiDi）时用这一套；两套共用一个对外的动作接口
        self._bidi: _Bidi | None = None
        self._ctx: str = ""
        self._proto: str = "cdp"
        self._frame_task: asyncio.Task[None] | None = None

    # -- 生命周期 ----------------------------------------------------------- #
    async def _ensure(self) -> None:
        """惰性启动：第一次动作才拉起 Chromium（不操作就零成本）。"""
        if self._cdp is not None:
            return
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
            raise RuntimeError(f"浏览器驱动不存在：{bin_path}（到「环境配置 → 浏览器驱动」重新选一个）")
        self._proto = proto
        if proto != "cdp":
            await self._ensure_bidi(bin_path)
            return
        user_data = Path(f"/tmp/agent-studio-browser/{self.run_id}")
        user_data.mkdir(parents=True, exist_ok=True)
        args = [
            bin_path,
            "--headless=new",
            f"--user-data-dir={user_data}",
            "--no-sandbox",
            "--disable-gpu",
            "--no-first-run",
            "--remote-debugging-port=0",
            f"--window-size={VIEWPORT['width']},{VIEWPORT['height']}",
        ]
        if self._proxy:
            args.append(f"--proxy-server={self._proxy}")
        self._proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        # remote-debugging-port=0：Chromium 会把实际端口写进 stderr 的 DevTools 行
        ws_url = None
        assert self._proc.stdout is not None
        try:
            while True:
                line = await asyncio.wait_for(self._proc.stdout.readline(), timeout=15)
                text = line.decode("utf-8", errors="replace")
                if "DevTools listening on ws://" in text:
                    ws_url = text.split("DevTools listening on ", 1)[1].strip()
                    break
                if not line:
                    break
        except TimeoutError:
            await self.close()
            raise RuntimeError("Chromium 启动后 15s 内没报 DevTools 端口")
        if not ws_url:
            await self.close()
            raise RuntimeError("Chromium 启动失败（没有 DevTools 行）")
        self._ws_url = ws_url
        self._cdp = await _Cdp.connect(ws_url)
        await self._cdp.attach_page()
        await self._cdp.send("Page.enable")
        await self._cdp.send("Runtime.enable")
        # 画面流：Chromium 主动推帧（每有变化才推，quality 60 的一帧 ~40-80KB）
        self._cdp.on("Page.screencastFrame", self._handle_frame)
        await self._cdp.send(
            "Page.startScreencast",
            {
                "format": "jpeg",
                # 画面只是"让人看得见它在干嘛"，不是录屏：不给 maxFrameRate
                # Chromium 会按页面变化把 30 帧/秒全推过来，SSE 和前端都扛不住。
                "quality": FRAME_QUALITY,
                "maxWidth": VIEWPORT["width"],
                "maxHeight": VIEWPORT["height"],
                "everyNthFrame": FRAME_EVERY_NTH,
            },
        )

    async def _handle_frame(self, params: dict[str, Any]) -> None:
        """帧到达：回 ack（不 ack Chromium 会暂停推流），然后推给 EventBus。"""
        if self._cdp is None:
            return
        try:
            await self._cdp.send("Page.screencastFrameAck", {"sessionId": params.get("sessionId")})
        except Exception:  # pragma: no cover
            pass
        data = params.get("data", "")
        if len(data) > FRAME_MAX_BYTES:
            return
        # 节流：Chromium 在页面有动画/滚动时会猛推帧，按最小间隔丢掉多余的
        now_ms = time.monotonic() * 1000.0
        if now_ms - self._last_frame_at < FRAME_MIN_INTERVAL_MS:
            return
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

        profile = Path(f"/tmp/agent-studio-browser/{self.run_id}/ff-profile")
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
        js = (
            "(() => { const el = document.querySelector(" + json.dumps(selector) + ") || document.body;"
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

    async def user_click(self, x: float, y: float) -> str:
        """用户在画面上点了一下（坐标已由前端换算成视口坐标）。"""
        await self._ensure()
        if self._bidi is not None:
            await self._bidi_click_xy(x, y)
            await asyncio.sleep(0.5)
            await self._refresh_meta_bidi()
            return f"用户点击 ({int(x)},{int(y)})，当前页面: {self._last_url}"
        assert self._cdp is not None
        for etype, btns in (("mousePressed", 0), ("mouseReleased", 2)):
            await self._cdp.send(
                "Input.dispatchMouseEvent",
                {"type": etype, "x": x, "y": y, "button": "left", "clickCount": 1, "buttons": btns},
            )
        await asyncio.sleep(0.5)
        await self._refresh_meta()
        return f"用户点击 ({int(x)},{int(y)})，当前页面: {self._last_url}"

    async def user_type(self, text: str) -> str:
        """用户通过页面输入条打的字（先点聚焦的位置）。"""
        await self._ensure()
        if self._bidi is not None:
            await self._bidi_type(text)
            await asyncio.sleep(0.3)
            return f"已输入 {len(text)} 个字符"
        assert self._cdp is not None
        await self._cdp.send("Input.insertText", {"text": text})
        await asyncio.sleep(0.3)
        return f"已输入 {len(text)} 个字符"

    async def wait(self, wait_s: float = 1.0) -> str:
        await asyncio.sleep(min(max(wait_s, 0.1), 15))
        if self._bidi is not None:
            await self._refresh_meta_bidi()
            return f"等了 {wait_s}s（当前: {self._last_url}）"
        await self._refresh_meta()
        return f"等了 {wait_s}s（当前: {self._last_url}）"

    async def close(self) -> None:
        if self._frame_task is not None:
            self._frame_task.cancel()
            self._frame_task = None
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
            try:
                self._proc.kill()
                await self._proc.wait()
            except Exception:  # pragma: no cover
                pass
            self._proc = None


#: run_id → 会话（进程级注册表；run 结束由 runner 收尾调 close_all）
_SESSIONS: dict[str, BrowserSession] = {}


def get_session(run_id: str, on_frame: Any, proxy: str | None = None) -> BrowserSession:
    sess = _SESSIONS.get(run_id)
    if sess is None:
        sess = BrowserSession(run_id, on_frame, proxy)
        _SESSIONS[run_id] = sess
    return sess


async def close_all(run_id: str) -> None:
    """run 结束时收尾：杀进程 + 删 user-data-dir（不留全局状态）。

    画面留档在**每一步**就已经写进会话目录了（见 browser_trace），
    所以这里不必再单独存"最后一张"。
    """
    sess = _SESSIONS.pop(run_id, None)
    if sess is not None:
        await sess.close()
    import shutil

    ud = Path(f"/tmp/agent-studio-browser/{run_id}")
    if ud.exists():
        # 重试几拍：进程刚 kill 时句柄未放，rmtree 会静默失败留下目录（实测 abort 后残留）
        for _ in range(5):
            shutil.rmtree(ud, ignore_errors=True)
            if not ud.exists():
                break
            await asyncio.sleep(0.4)
