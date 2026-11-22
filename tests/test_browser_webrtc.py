"""WebRTC 推流：协议协商、凭据与「输入回执」的护栏。

这些测试不起 Chromium，但会真起两个 aiortc PeerConnection 做一次 SDP 交换 ——
H.264 优先这件事必须靠真实的 answer 验证：aiortc 默认把 VP8 排在第一位，一旦
回退到 VP8，Python 编码 1280×800 的帧率会掉到个位数（用户看到的就是卡）。
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import time

import pytest

from agent_studio import browser_control as bc
from agent_studio import browser_webrtc as rtc


class FakeBrowser:
    def __init__(self) -> None:
        self.video = False

    async def enable_video_mode(self, sink) -> None:
        self.video = True

    async def disable_video_mode(self, sink=None) -> None:
        self.video = False


class FakeSess:
    """够用的假浏览器：可配置点击命中/页面变化。"""

    def __init__(self, *, actionable: bool = True, signature: str = "sig-1") -> None:
        self._last_url = "https://example.com/"
        self._last_title = "Example"
        self.actionable = actionable
        self.signature = signature
        self.keys: list[dict] = []
        self.clicks: list[tuple[float, float]] = []
        self.typed: list[str] = []
        self.wheels: list[tuple[float, float, float, float]] = []

    async def hit_test(self, x: float, y: float) -> dict:
        return {"tag": "a", "actionable": self.actionable, "label": "a 搜索", "hitTag": "a"}

    async def element_label(self, x: float, y: float) -> str:
        return "a 搜索"

    async def page_signature(self) -> str:
        return self.signature

    async def user_click(self, x: float, y: float, button: str = "left", click_count: int = 1) -> str:
        self.clicks.append((x, y))
        return "点了"

    async def key_event(self, payload: dict) -> str:
        self.keys.append(payload)
        return "按键"

    async def user_type(self, text: str) -> str:
        self.typed.append(text)
        return "输入"

    async def wheel(self, x: float, y: float, dx: float = 0, dy: float = 0) -> str:
        self.wheels.append((x, y, dx, dy))
        return "滚了"

    async def read(self, selector: str = "body") -> str:
        return "[Example] https://example.com/\n正文"


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.setenv("STUDIO_TURN_SECRET", "")
    monkeypatch.setenv("STUDIO_TURN_URLS", "")
    for c in list(bc._CONTROLS.values()):
        bc._CONTROLS.pop(c.key, None)
    rtc.STREAMS.clear()
    yield
    rtc.STREAMS.clear()


def _ctl(status: str = bc.USER) -> bc.Control:
    c = bc.Control(key="ses:s1", session_id="s1", run_id="r1", status=status)
    c.running = status == bc.AGENT
    bc._CONTROLS[c.key] = c
    return c


def test_没有配置_TURN_时只报直连能力_不假装有中转(monkeypatch):
    cfg = rtc.ice_config()
    assert cfg["enabled"] is True
    assert cfg["iceServers"] == [] and cfg["turn"] is False


def test_TURN_临时凭据按_REST_约定签名(monkeypatch):
    monkeypatch.setenv("STUDIO_TURN_SECRET", "s3cret")
    monkeypatch.setenv("STUDIO_TURN_URLS", "turn:1.2.3.4:3478?transport=tcp")
    servers = rtc._turn_ice_servers()
    assert len(servers) == 1
    item = servers[0]
    assert item["urls"] == ["turn:1.2.3.4:3478?transport=tcp"]
    user = item["username"]
    expiry = int(user.split(":", 1)[0])
    assert expiry > time.time()
    expected = base64.b64encode(
        hmac.new(b"s3cret", user.encode(), hashlib.sha1).digest()
    ).decode()
    assert item["credential"] == expected


async def test_offer_的_answer_只用_H264_不用_VP8():
    from aiortc import RTCPeerConnection

    client = RTCPeerConnection()
    client.addTransceiver("video", direction="recvonly")
    client.createDataChannel("input")
    offer = await client.createOffer()
    await client.setLocalDescription(offer)
    answer = await rtc.handle_offer("s1", FakeBrowser(), client.localDescription.sdp, "offer")
    sdp = answer["sdp"]
    assert "H264" in sdp, "answer 必须协商到 H.264"
    assert "VP8" not in sdp, "不能回退到 VP8（Python 编码扛不住 24fps）"
    assert answer["stream"]["mode"] == "webrtc"
    await rtc.close_stream("s1")
    await client.close()


async def test_键盘输入记人话_且只在持有者手里生效():
    c = _ctl(bc.USER)
    sess = FakeSess()
    detail = await bc.apply_user_input_detail(
        c, sess, {"kind": "key", "key": "Enter", "code": "Enter", "keyCode": 13}
    )
    assert sess.keys and sess.keys[0]["key"] == "Enter"
    assert "用户按了 回车" in detail["note"]

    c2 = _ctl(bc.AGENT)
    with pytest.raises(bc.UserInputDenied):
        await bc.apply_user_input_detail(c2, sess, {"kind": "key", "key": "Tab", "code": "Tab"})


async def test_点击没有可见变化也要有回执_不许静默():
    c = _ctl(bc.USER)
    sess = FakeSess(signature="same")
    detail = await bc.apply_user_input_detail(c, sess, {"kind": "click", "x": 10, "y": 20})
    assert "页面没有可见变化" in detail["note"]
    assert "没有可见变化" in detail["feedback"]
    assert c.user_notes and "用户点击了 a 搜索" in c.user_notes[-1]


async def test_点到空白处要当场说清没点中():
    c = _ctl(bc.USER)
    sess = FakeSess(actionable=False)
    detail = await bc.apply_user_input_detail(c, sess, {"kind": "click", "x": 10, "y": 20})
    assert "空白处" in detail["note"]
    assert "没有可点的元素" in detail["feedback"]


async def test_滚轮走指针位置_不是_window_scrollBy():
    c = _ctl(bc.USER)
    sess = FakeSess()
    detail = await bc.apply_user_input_detail(
        c, sess, {"kind": "wheel", "x": 100, "y": 200, "dx": 0, "dy": 120}
    )
    assert sess.wheels == [(100.0, 200.0, 0.0, 120.0)]
    assert "向下滚动了 120px" in detail["note"]


async def test_降档后的点击坐标折回页面坐标():
    """轨道降档会缩帧（1280→960→640），前端按收到的画面像素算坐标。

    服务端必须折回页面坐标再点，否则 640 档上点「页面正中」会落到页面 (320,200)
    —— 实测 9 点标定里 5 个点打偏到左上相邻格子。
    """
    c = _ctl(bc.USER)
    sess = FakeSess()
    stream = rtc.BrowserStream("s1", sess)
    stream.level = 2  # 640×400
    await stream._on_input(
        __import__("json").dumps({"kind": "click", "x": 320, "y": 200, "button": "left", "clickCount": 1})
    )
    assert sess.clicks == [(640.0, 400.0)], sess.clicks


async def test_静止页面不因保活帧的_2fps_降档():
    c = _ctl(bc.USER)
    stream = rtc.BrowserStream("s1", FakeBrowser())
    # 浏览器没有新帧（只有 2fps 保活帧），接收端报 4fps：不许降档
    stream._sink_fps = 2.0
    stream._client = {"fps": 4, "rtt_ms": 30}
    stream._adapt()
    assert stream.level == 0
    # 页面真在动（24fps 出帧）但接收端只有 8fps：这才是网络问题，降一档
    stream._sink_fps = 20.0
    stream._client = {"fps": 8, "rtt_ms": 30}
    stream._adapt()
    assert stream.level == 1


# --------------------------------------------------------------------------- #
# 僵尸流：客户端无声消失 → 服务端必须自己回收
# --------------------------------------------------------------------------- #
class _StuckPc:
    """永远停在 connecting 的对端（客户端崩溃/关标签后服务端看到的就是这样）。"""

    connectionState = "connecting"

    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


class _LivePc(_StuckPc):
    connectionState = "connected"


async def test_客户端无声消失时看门狗回收流并切回兼容档(monkeypatch):
    """护栏：客户端 15s 超时后可能一个字节都发不出来（崩溃/断网）。

    旧 ``_watch`` 只认 failed/closed，于是这条流永久 connecting、浏览器永久留在
    视频档（实测一份日志 327 条 state=connecting、超过 11 分钟）。
    """
    monkeypatch.setattr(rtc, "CONNECT_WATCHDOG_S", 0.6)
    browser = FakeBrowser()
    browser.video = True  # 开过视频档
    pc = _StuckPc()
    stream = rtc.BrowserStream("s1", browser, client="ghost")
    stream.pc = pc
    rtc.STREAMS["s1"] = stream
    # 客户端建连后一声不响地消失了 5 秒（这 5 秒里 pc 一直是 connecting）
    stream.created_at = time.monotonic() - 5

    await asyncio.wait_for(stream._watch(), timeout=5)

    assert stream.state == "failed", "看门狗必须把僵尸流落成 failed"
    assert "没连上" in stream.reason
    assert browser.video is False, "回收时要顺手把浏览器切回兼容档（disable_video_mode）"
    assert pc.closed is True, "PeerConnection 要关掉，别让 aiortc 留着它"
    assert rtc.STREAMS.get("s1") is None, "流要从注册表里摘掉，别让它继续被当成活的"
    assert rtc.metrics("s1")["mode"] == "jpeg", "面板据此回兼容模式"
    assert rtc.metrics("s1")["state"] == "off"


async def test_连上了就不许被看门狗误杀(monkeypatch):
    monkeypatch.setattr(rtc, "CONNECT_WATCHDOG_S", 0.3)
    browser = FakeBrowser()
    pc = _LivePc()
    stream = rtc.BrowserStream("s1", browser)
    stream.pc = pc
    rtc.STREAMS["s1"] = stream
    stream.created_at = time.monotonic() - 5  # 建连慢，但确实连上了

    task = asyncio.create_task(stream._watch())
    await asyncio.sleep(0.9)  # 跑过好几轮：看门狗窗口早过了
    assert stream.state == "live" and not stream._closed
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await stream.close()
    assert browser.video is False
