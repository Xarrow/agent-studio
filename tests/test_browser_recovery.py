"""浏览器恢复力护栏 —— 2026-11-22 那三个现场缺陷的回归线。

三个缺陷各自对应一段测试：

① 推流启动被残留 Chromium 的 SingletonLock 锁死：
   profile 里上一次的进程没退干净 → 新 Chromium 打印 ``Failed to create SingletonLock``
   就退出。修法是「起之前先收掉残留进程+锁文件，失败再收一次重试」，而且报错必须是
   人话（Chromium 原文只进日志）。这里真起一个占着 profile 的进程、真起一个假的
   Chromium 脚本，验自清理与重试真的发生。

② 面板打字必须回读校验：``Input.insertText`` 在焦点丢了的时候是**静默丢弃**的，
   旧代码不管进没进去都回"已输入 N 个字符"。这里用假 CDP 模拟"焦点在/焦点丢"，
   验回读、键盘事件兜底、以及真进不去时必须回 ✗。

③ 全屏点击必须有回执：全屏和右栏两个面板同时存在时，先关的那个会把对方的流顶掉
   （视频轨断、DataChannel 跟着断 = 全屏里点击/打字全静默）。这里验「只关自己那条」。

另外守兼容模式的保活帧真的把静止页面补到 5fps 量级（不是 2fps，也不是 0）。
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from agent_studio import browser_session as bs
from agent_studio import browser_webrtc as rtc


# --------------------------------------------------------------------------- #
# ① profile 自清理：残留进程 + 锁文件
# --------------------------------------------------------------------------- #
def test_残留进程和锁文件在启动前被收掉(tmp_path, monkeypatch):
    profile = tmp_path / "ses-ses_reap"
    profile.mkdir()
    monkeypatch.setattr(bs, "profile_dir_for", lambda key: profile)

    # 锁文件（Chromium 用的是软链，这里三种形态都放一份）
    (profile / "SingletonLock").symlink_to("somehost-12345")
    (profile / "SingletonCookie").write_text("1")
    (profile / "DevToolsActivePort").write_text("9222")

    # 一个真的还活着的"上一次的 Chromium"：命令行里带着这个 profile 目录
    stale = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", str(profile)])
    try:
        t0 = time.monotonic()
        while time.monotonic() - t0 < 5 and str(profile).encode() not in Path(
            f"/proc/{stale.pid}/cmdline"
        ).read_bytes():
            time.sleep(0.05)
        assert stale.pid in bs._pids_using(profile), "测试自己没把残留进程摆好"

        got = bs.reap_profile("ses:ses_reap")
        assert stale.pid in got["killed"], f"残留进程没被收：{got}"
        assert set(got["locks"]) == {"SingletonLock", "SingletonCookie", "DevToolsActivePort"}
        assert stale.poll() is not None, "残留进程还活着 —— 下次启动又会撞 SingletonLock"
        assert not (profile / "SingletonLock").exists()
        assert not (profile / "SingletonLock").is_symlink()
    finally:
        if stale.poll() is None:
            stale.kill()
            stale.wait()


def test_没有残留时自清理是空转的(tmp_path, monkeypatch):
    profile = tmp_path / "ses-ses_clean"
    profile.mkdir()
    monkeypatch.setattr(bs, "profile_dir_for", lambda key: profile)
    assert bs.reap_profile("ses:ses_clean") == {"killed": [], "locks": []}


# --------------------------------------------------------------------------- #
# ① 启动失败 → 自清理 → 重试一次；两次都失败必须是"人话"
# --------------------------------------------------------------------------- #
_FAKE_CHROME = """#!/usr/bin/env python3
import os, sys, time
counter, mode = sys.argv[1], sys.argv[2]
n = 0
if os.path.exists(counter):
    n = int(open(counter).read().strip() or "0")
n += 1
open(counter, "w").write(str(n))
if mode == "always_fail" or (mode == "fail_once" and n == 1):
    sys.stderr.write("[ERROR:process_singleton_posix.cc] Failed to create SingletonLock: File exists\\n")
    sys.stderr.flush()
    sys.exit(1)
print("DevTools listening on ws://127.0.0.1:9999/devtools/browser/fake", flush=True)
time.sleep(30)
"""


class _FakeCdp:
    """只够 ``_ensure`` 走完启动流程的假 CDP。"""

    sent: list[str] = []

    @classmethod
    async def connect(cls, ws_url: str):  # noqa: D401 - 与 _Cdp.connect 同签名
        cls.sent = []
        return cls()

    async def attach_page(self) -> None:
        return None

    async def send(self, method: str, params: dict | None = None):
        type(self).sent.append(method)
        return {}

    def on(self, event: str, cb) -> None:
        return None

    async def close(self) -> None:
        return None


def _fake_chrome(tmp_path: Path, mode: str) -> Path:
    script = tmp_path / "chrome"
    script.write_text(_FAKE_CHROME)
    script.chmod(0o755)
    counter = tmp_path / "runs.txt"
    # 脚本自己带 wrapper：把参数固定进去，避免依赖 _ensure 拼的 Chromium 参数
    wrapper = tmp_path / "chrome-wrapped"
    wrapper.write_text(f'#!/bin/sh\nexec {sys.executable} {script} {counter} {mode} "$@"\n')
    wrapper.chmod(0o755)
    return wrapper


@pytest.fixture
def fresh_profile(tmp_path, monkeypatch):
    profile = tmp_path / "ses-ses_start"
    profile.mkdir()
    monkeypatch.setattr(bs, "profile_dir_for", lambda key: profile)
    monkeypatch.setattr(bs, "_Cdp", _FakeCdp)
    return profile


def _install_driver(tmp_path: Path, monkeypatch, bin_path: Path) -> None:
    from agent_studio import browser_drivers

    async def fake_resolve():
        return {"path": str(bin_path), "proto": "cdp"}

    monkeypatch.setattr(browser_drivers, "resolve_bin", fake_resolve)


def test_SingletonLock_失败后自清理重试一次就起来(tmp_path, monkeypatch, fresh_profile):
    binary = _fake_chrome(tmp_path, "fail_once")
    _install_driver(tmp_path, monkeypatch, binary)
    sess = bs.BrowserSession(run_id="r-retry", on_frame=lambda *a: None, session_id="ses_start")

    async def run():
        await sess._ensure()
        try:
            assert sess._cdp is not None, "重试一次之后必须真的连上"
            assert sess._ws_url.startswith("ws://127.0.0.1:9999")
        finally:
            await sess.close()

    asyncio.run(run())
    assert (tmp_path / "runs.txt").read_text().strip() == "2", "应该恰好起了两次"


def test_两次都失败时报人话_不糊_Chromium_原文(tmp_path, monkeypatch, fresh_profile):
    binary = _fake_chrome(tmp_path, "always_fail")
    _install_driver(tmp_path, monkeypatch, binary)
    sess = bs.BrowserSession(run_id="r-dead", on_frame=lambda *a: None, session_id="ses_start")

    async def run():
        with pytest.raises(RuntimeError) as ei:
            await sess._ensure()
        await sess.close()
        return str(ei.value)

    msg = asyncio.run(run())
    assert "SingletonLock" not in msg and "File exists" not in msg, f"面板上不许糊 Chromium 原文：{msg}"
    assert "自动清" in msg and "重试" in msg, msg
    assert (tmp_path / "runs.txt").read_text().strip() == "2"


# --------------------------------------------------------------------------- #
# ② 打字回读校验
# --------------------------------------------------------------------------- #
class _DomCdp:
    """一个只有"焦点里那个输入框"的假页面。

    ``focus_lost`` 模拟 Bing 那种"点完把控件重新渲染一遍、焦点掉到 body"，
    ``insert_lands`` 模拟焦点还在时 insertText 真的写进 value。
    """

    def __init__(self) -> None:
        self.value = ""
        self.focused = False
        self.editable = True
        self.insert_lands = True
        self.inserts = 0
        self.keys: list[str] = []
        self.mouse: list[str] = []

    async def send(self, method: str, params: dict | None = None):
        params = params or {}
        if method == "Input.insertText":
            self.inserts += 1
            if self.focused and self.insert_lands:
                self.value += str(params.get("text", ""))
            return {}
        if method == "Input.dispatchKeyEvent":
            if params.get("type") == "keyDown":
                ch = str(params.get("text") or "")
                if self.focused and ch:
                    self.keys.append(ch)
                    self.value += ch
            return {}
        if method in ("Input.dispatchMouseEvent",):
            self.mouse.append(str(params.get("type")))
            if params.get("type") == "mousePressed":
                self.focused = self.editable
            return {}
        if method == "Runtime.evaluate":
            return {"result": {"result": {"value": json.dumps({})}}}
        return {}


def _typing_session(cdp: _DomCdp) -> bs.BrowserSession:
    sess = bs.BrowserSession(run_id="r-type", on_frame=lambda *a: None)
    sess._cdp = cdp  # type: ignore[assignment]
    sess._last_url = "https://www.bing.com/"

    async def fake_js(expr: str):
        if "elementFromPoint" in expr:
            return {"kind": "INPUT", "editable": cdp.editable, "focused": cdp.focused, "ph": "搜索"}
        if "document.activeElement" in expr:
            return {"editable": cdp.focused and cdp.editable, "tag": "INPUT", "value": cdp.value, "ph": "搜索"}
        return {}

    sess._js = fake_js  # type: ignore[method-assign]

    async def no_meta():
        return None

    sess._refresh_meta = no_meta  # type: ignore[method-assign]
    return sess


def test_焦点在输入框时_insertText_直接进_回读一致():
    cdp = _DomCdp()
    cdp.focused = True
    sess = _typing_session(cdp)
    out = asyncio.run(sess.user_type("环境配置"))
    assert cdp.value == "环境配置"
    assert "回读一致" in out, out
    assert cdp.inserts == 1, "第一次就该直接成，不该再补一遍键盘事件"


def test_焦点丢了就重新聚焦再打_逐字符键盘事件兜底():
    """现场：点 Bing 搜索框 → 页面重渲染 → 焦点掉到 body → insertText 静默丢弃。"""
    cdp = _DomCdp()
    cdp.focused = False
    cdp.insert_lands = False  # 即使有焦点也不吃 insertText（只认 keydown 的页面）
    sess = _typing_session(cdp)
    sess._last_click = (640.0, 300.0)
    sess._last_click_editable = True

    out = asyncio.run(sess.user_type("agent studio"))
    assert cdp.value == "agent studio", f"文字必须真进页面框：{cdp.value!r}"
    assert "回读一致" in out, out
    assert "键盘事件" in out, out


def test_真进不去时必须说清楚_不许假装成功():
    cdp = _DomCdp()
    cdp.editable = False
    cdp.focused = False
    sess = _typing_session(cdp)
    out = asyncio.run(sess.user_type("随便打点"))
    assert out.startswith("✗"), out
    assert "先点" in out
    assert "已输入" not in out, "没进去就不许回'已输入 N 个字符'"


def test_上一次点的是链接时_不重放点击():
    """点了个链接再打字：不许把同一个链接再点一遍（会二次跳转）。"""
    cdp = _DomCdp()
    sess = _typing_session(cdp)
    sess._last_click = (10.0, 10.0)
    sess._last_click_editable = False
    assert asyncio.run(sess._refocus()) is False
    assert cdp.mouse == [], "不该发出任何鼠标事件"


# --------------------------------------------------------------------------- #
# ③ 全屏/右栏：只关自己那条流
# --------------------------------------------------------------------------- #
class _FakeBrowser:
    def __init__(self) -> None:
        self.video = False

    async def enable_video_mode(self, sink) -> None:
        self.video = True

    async def disable_video_mode(self, sink=None) -> None:
        self.video = False


@pytest.fixture(autouse=True)
def _clean_streams():
    rtc.STREAMS.clear()
    yield
    rtc.STREAMS.clear()


def test_别的面板发来的关闭请求不顶掉新流():
    """全屏打开时右栏那个面板正在卸载，它的 close 会晚于全屏的 offer 到达。"""

    async def run():
        await rtc.ensure_stream("ses_x", _FakeBrowser(), client="rail")
        # 全屏面板建流（真实流程里 ensure_stream 会先关掉旧的）
        await rtc.ensure_stream("ses_x", _FakeBrowser(), client="fullscreen")
        assert rtc.existing("ses_x") is not None
        await rtc.close_stream("ses_x", "rail")  # 右栏的那条迟到的 close
        assert rtc.existing("ses_x") is not None, "右栏关流把全屏的流顶掉了 —— 全屏输入会全静默"
        await rtc.close_stream("ses_x", "fullscreen")
        assert rtc.existing("ses_x") is None

    asyncio.run(run())


def test_页面坐标口径不再按档位换算():
    """前端从 701ad49 起发页面坐标：带 coords=page 时服务端不能再乘一次。"""

    class _Sess:
        _last_url = "https://example.com/"
        _last_title = "Example"
        clicks: list[tuple[float, float]] = []

        async def hit_test(self, x, y):
            return {"tag": "input", "actionable": True, "label": "搜索框"}

        async def element_label(self, x, y):
            return "搜索框"

        async def page_signature(self):
            return "s"

        async def user_click(self, x, y, button="left", click_count=1):
            self.clicks.append((float(x), float(y)))
            return "点了"

    sess = _Sess()
    from agent_studio import browser_control as bc

    c = bc.Control(key="ses:ses_page", session_id="ses_page", run_id="r-page", status=bc.USER)
    bc._CONTROLS[c.key] = c
    stream = rtc.BrowserStream("ses_page", sess)
    stream.level = 2  # 640×400 档
    asyncio.run(
        stream._on_input(
            json.dumps({"kind": "click", "x": 640, "y": 400, "coords": "page", "button": "left"})
        )
    )
    bc._CONTROLS.pop(c.key, None)
    assert sess.clicks == [(640.0, 400.0)], f"页面坐标被二次放大了：{sess.clicks}"


# --------------------------------------------------------------------------- #
# 兼容模式保活帧：静止页面也要有 ~5fps 的实测帧
# --------------------------------------------------------------------------- #
def test_静止页面靠保活帧补到5fps量级(monkeypatch):
    frames: list = []

    class _ShotCdp:
        def __init__(self) -> None:
            self.shots = 0

        async def send(self, method: str, params: dict | None = None):
            if method == "Page.captureScreenshot":
                self.shots += 1
                await asyncio.sleep(0.035)  # 现场实测一次截图 ~35ms
                return {"result": {"data": "IMG"}}
            return {}

    sess = bs.BrowserSession(
        run_id="r-idle", on_frame=lambda rid, d, u, t: frames.append(time.monotonic()), session_id="ses_idle"
    )
    cdp = _ShotCdp()
    sess._cdp = cdp  # type: ignore[assignment]
    sess._last_url = "https://example.com/static"
    sess._last_title = "Static"
    sess._screencast_on = True
    sess._has_watcher = lambda: True  # type: ignore[method-assign]

    async def run():
        task = asyncio.create_task(sess._idle_tick())
        await asyncio.sleep(1.2)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(run())
    fps = len(frames) / 1.2
    assert 3.5 <= fps <= 6.5, f"保活帧应在 5fps 量级（截图耗时算进节奏），实测 {fps:.1f}fps"
    assert cdp.shots >= 4


def test_没人在看时不截保活帧(monkeypatch):
    frames: list = []

    class _ShotCdp:
        shots = 0

        async def send(self, method: str, params: dict | None = None):
            type(self).shots += 1
            return {"result": {"data": "IMG"}}

    sess = bs.BrowserSession(run_id="r-nw", on_frame=lambda *a: frames.append(1), session_id="ses_nw")
    sess._cdp = _ShotCdp()  # type: ignore[assignment]
    sess._last_url = "https://example.com/"
    sess._screencast_on = True
    sess._has_watcher = lambda: False  # type: ignore[method-assign]

    async def run():
        task = asyncio.create_task(sess._idle_tick())
        await asyncio.sleep(0.5)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(run())
    assert frames == []
    assert _ShotCdp.shots == 0, "没订阅者时不许拿空闲页面的 CPU 换帧"
