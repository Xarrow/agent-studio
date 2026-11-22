"""视频档下兼容帧通道必须照常产出**真实页面帧**（P0：静止页 0fps 黑屏）。

现场（2026-11-22）：``Page.startScreencast`` 对静止页面一帧都不推，而旧的
``_idle_tick`` 在 ``_video_sink`` 非空时直接 ``continue`` —— 视频档一开，兼容通道
就被关了。WebRTC 又没连上时，面板里只剩启动那张空白帧（实测 6 秒 3 帧全是平灰），
而 WebRTC 永远连不上的情况下面板就永久黑屏。

这里守三件事：
  ① 视频档开着也按 1fps 截真实页面，并且**同时**喂视频轨与 SSE；
  ② 内容断言是真页面：尺寸 1280×800、亮度有结构（空白帧是平的，对照训练习）；
  ③ 真帧刚到 / 没人在看时的让路逻辑没被这次改动破坏。
"""

from __future__ import annotations

import asyncio
import base64

import av
import numpy as np

from agent_studio import browser_session as bs


def _encode_jpeg(luma: np.ndarray) -> str:
    """把一张灰度图编成 JPEG 的 base64（CDP 给前端的就是这个形状）。"""
    h, w = luma.shape
    rgb = np.stack([luma, luma, luma], axis=-1)
    ctx = av.CodecContext.create("mjpeg", "w")
    ctx.width, ctx.height, ctx.pix_fmt = w, h, "yuvj420p"
    packet = ctx.encode(av.VideoFrame.from_ndarray(rgb, format="rgb24"))[0]
    return base64.b64encode(bytes(packet)).decode()


def _page_jpeg() -> str:
    """一张像页面的图：浅底 + 若干深色文字块（有结构，不是平灰）。"""
    luma = np.full((800, 1280), 246, dtype=np.uint8)
    luma[80:150, 60:900] = 30      # 标题
    for i in range(6):             # 正文行
        top = 220 + i * 70
        luma[top : top + 26, 60 : 1180] = 70
    luma[420:560, 300:980] = 200   # 一块浅灰卡片
    return _encode_jpeg(luma)


def _blank_jpeg() -> str:
    """启动那一张"平灰空白帧"（现场日志里 3 帧全是它）。"""
    return _encode_jpeg(np.full((800, 1280), 238, dtype=np.uint8))


def _measure(data_b64: str) -> tuple[int, int, float, float]:
    """解码成灰度 → (宽, 高, 平均亮度, 亮度标准差)。标准差就是"有没有结构"。"""
    ctx = av.CodecContext.create("mjpeg", "r")
    frames = ctx.decode(av.Packet(base64.b64decode(data_b64)))
    assert frames, "帧解不开"
    gray = frames[-1].to_ndarray(format="gray")
    return int(gray.shape[1]), int(gray.shape[0]), float(gray.mean()), float(gray.std())


class _FakeCdp:
    def __init__(self, payload: str) -> None:
        self.payload = payload
        self.calls: list[tuple[str, dict | None]] = []

    async def send(self, method: str, params: dict | None = None):
        self.calls.append((method, params))
        if method == "Page.captureScreenshot":
            return {"result": {"data": self.payload}}
        return {}

    def params_of(self, method: str) -> dict:
        return next(p for m, p in self.calls if m == method) or {}


class _Sink:
    """只记 push —— 真实 FrameSink 的行为由 browser_webrtc 自己的测试守。"""

    def __init__(self) -> None:
        self.pushed: list[str] = []

    def push(self, data: str) -> None:
        self.pushed.append(data)


def _session(payload: str) -> tuple[bs.BrowserSession, list]:
    frames: list = []
    s = bs.BrowserSession(run_id="r-keep", on_frame=lambda *a: frames.append(a))
    s._cdp = _FakeCdp(payload)  # type: ignore[assignment]
    s._last_url = "https://example.com"
    s._last_title = "Example"
    return s, frames


def test_空白帧对照_平灰图的亮度标准差接近0_真实页面才有结构():
    """先证明断言有牙齿：如果只截到启动那张空白帧，标准差这一关就过不去。"""
    _, _, _, blank_std = _measure(_blank_jpeg())
    w, h, _, page_std = _measure(_page_jpeg())
    assert (w, h) == (1280, 800)
    assert blank_std < 5, f"对照组应该几乎是平的（实际 {blank_std:.1f}）"
    assert page_std > 20, f"真实页面必须有大结构（实际 {page_std:.1f}）"


def test_视频档下保活帧是真的页面_且同时进视频轨与SSE():
    """核心回归：video_sink 非空时也必须截真实页面，两条通道都要收到。"""
    page = _page_jpeg()
    s, frames = _session(page)
    sink = _Sink()
    s._video_sink = sink

    ok = asyncio.run(s._keepalive_frame(video=True))

    assert ok is True, "视频档下的保活帧必须真的进了 SSE 通道（返回 False = 面板只剩空白帧）"
    assert sink.pushed == [page], "视频轨要收到同一张真实页面帧"
    assert frames and frames[0][1] == page, "SSE 拿到的必须是这张真帧"
    w, h, _mean, std = _measure(frames[0][1])
    assert (w, h) == (1280, 800), f"视频档要截整张页面（实际 {w}×{h}）"
    assert std > 20, f"兼容通道的内容必须是真实页面，不是空白帧（标准差 {std:.1f}）"

    params = s._cdp.params_of("Page.captureScreenshot")  # type: ignore[attr-defined]
    assert params["clip"]["scale"] == 1.0, "视频档保活要全尺寸，否则视频轨要放大糊图"
    assert params["quality"] == bs.VIDEO_FRAME_QUALITY


def test_兼容档保活仍是800宽_不把SSE负载放大():
    s, frames = _session(_page_jpeg())
    asyncio.run(s._keepalive_frame(video=False))
    params = s._cdp.params_of("Page.captureScreenshot")  # type: ignore[attr-defined]
    assert params["clip"]["scale"] == 0.625, "兼容模式的帧宽口径没变（800 宽）"
    assert params["quality"] == bs.FRAME_QUALITY
    w, _h, _mean, _std = _measure(frames[0][1])
    assert w == 1280  # 假 CDP 不看 scale，真实 Chromium 才按 scale 出 800 宽


def test_截不到图时一帧都不发_不许拿空白帧充数():
    s, frames = _session("")
    sink = _Sink()
    s._video_sink = sink
    assert asyncio.run(s._keepalive_frame(video=True)) is False
    assert frames == [] and sink.pushed == [], "空图不许进通道（面板会闪一下白）"


def test_静止页开视频档时保活循环真的会跑出帧(monkeypatch):
    """旧代码在这里 continue：视频档一来就再也不出兼容帧。"""
    monkeypatch.setattr(bs, "VIDEO_KEEPALIVE_INTERVAL_S", 0.05)
    page = _page_jpeg()
    s, frames = _session(page)
    s._video_sink = _Sink()
    s._has_watcher = lambda: False  # type: ignore[assignment]  没人订 SSE，但视频流还在看

    async def run() -> None:
        task = asyncio.create_task(s._idle_tick())
        await asyncio.sleep(0.32)
        s._closing = True
        await asyncio.wait_for(task, 2)

    asyncio.run(run())
    assert len(frames) >= 2, f"视频档静止页必须持续出真实帧（实际 {len(frames)}）"
    assert all(f[1] == page for f in frames)


def test_页面正在动时保活让路_不跟24fps主链路抢(monkeypatch):
    monkeypatch.setattr(bs, "VIDEO_KEEPALIVE_INTERVAL_S", 0.05)
    s, frames = _session(_page_jpeg())
    s._video_sink = _Sink()
    s._last_real_frame_at = bs.time.monotonic() * 1000.0  # 刚有真帧

    async def run() -> None:
        task = asyncio.create_task(s._idle_tick())
        await asyncio.sleep(0.25)
        s._closing = True
        await asyncio.wait_for(task, 2)

    asyncio.run(run())
    assert frames == [], "真帧刚到时不该再截（让路窗口内）"
