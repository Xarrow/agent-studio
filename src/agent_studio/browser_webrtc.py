"""浏览器画面 · WebRTC 推流（H.264，失败就回退 JPEG/SSE）。

为什么是这个方案
----------------
服务器上已经有自研的 CDP + Chromium 进程模型（``browser_session``），这里**不引入
Playwright/浏览器网关**，只在旁边加一条"帧出口"：

    Chromium --CDP screencast(JPEG)--> FrameSink --PyAV 解码--> aiortc 视频轨
                                                              └─ H.264 编码 → SRTP/UDP

· **aiortc + PyAV**：纯 Python 的 WebRTC 栈，编码器就是包内的 libx264
  （PyAV wheel 自带），不需要 GStreamer/ffmpeg 系统包、不需要 Node。
  依赖只有 aiortc/av/numpy —— 能被打进离线包，跟现有进程模型同生共死。
· **H.264 优先**：浏览器兼容面最广、PyAV 的 libx264 在 1280×800 上实测能编
  250fps（单核），24fps 只占零头。VP8 作为协商不到 H.264 时的兜底（aiortc
  默认把 VP8 排第一，所以这里显式 ``setCodecPreferences`` 把 H.264 顶上去）。
· **自适应**：看**接收端**回报的 fps/RTT/丢包（浏览器每 2s 经 DataChannel 送
  回来）做三档分辨率/码率阶梯（1280→960→640）。降档保流畅，不硬撑。
· **不碰控制权**：DataChannel 里的输入一律走 ``browser_control.apply_user_input``
  —— 和 POST /browser-input 同一条闸门、同一份人话。非持有者被拒时把原因回给
  前端就地显示。

ICE 现实（必须写清楚）
----------------------
东京这台 VPS 的公网入口只放通 TCP，UDP 入站被服务商挡掉（实测上海/NYC 打任意
UDP 端口都超时），所以 host/srflx 直连必然失败。媒体走同机 coturn 的
``turn:…?transport=tcp`` 中转（见 scripts/setup-turn.sh）：视频仍是 DTLS-SRTP
端到端加密，TURN 只转发密文；同机中转不产生额外费用。直连能力没有删掉 ——
在 UDP 可达的机器（例如内网/其他机房）上同一条链路会直接选 host 候选。
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import time
from fractions import Fraction
from typing import Any

logger = logging.getLogger(__name__)

#: 推流目标（1280 宽、24fps）。再高这台 2 vCPU 的机器会把 Chromium 挤瘦。
VIDEO_WIDTH = 1280
VIDEO_HEIGHT = 800
VIDEO_FPS = 24
#: 分辨率/码率阶梯：网络差就往下走，保流畅不保清晰
LEVELS = [
    {"width": 1280, "height": 800, "bitrate": 2_400_000},
    {"width": 960, "height": 600, "bitrate": 1_400_000},
    {"width": 640, "height": 400, "bitrate": 800_000},
]
#: 静止页面也要有帧（2fps）—— 否则浏览器端计时/抖动统计会停，切回来像卡死
IDLE_FRAME_INTERVAL_S = 0.5
#: 服务端等 ICE 收集完的上限（非 trickle；一般 <1s）
GATHER_TIMEOUT_S = 4.0

try:  # 依赖缺失时整条链路降级为 JPEG，不影响服务启动
    import av  # noqa: F401
    from aiortc import RTCPeerConnection, RTCSessionDescription
    from aiortc.mediastreams import VideoStreamTrack
    from aiortc.rtcrtpparameters import RTCRtpCodecCapability

    AVAILABLE = True
except Exception:  # pragma: no cover - 离线包缺依赖时
    AVAILABLE = False
    logger.warning("aiortc/PyAV 不可用 —— 浏览器画面将只走 JPEG/SSE 兼容模式", exc_info=True)


# --------------------------------------------------------------------------- #
# 帧入口：CDP 的 JPEG 帧 → 最新一帧（丢旧不排队，延迟不累积）
# --------------------------------------------------------------------------- #
class FrameSink:
    """只保留**最新**一帧。慢的时候宁可丢帧，也不要越积越慢。"""

    def __init__(self) -> None:
        self.latest: bytes | None = None
        self.updated_at = 0.0
        self.event = asyncio.Event()
        self.frames_in = 0

    def push(self, data_b64: str) -> None:
        try:
            self.latest = base64.b64decode(data_b64)
        except Exception:  # pragma: no cover - CDP 给的一定是合法 base64
            return
        self.updated_at = time.monotonic()
        self.frames_in += 1
        self.event.set()

    def take(self) -> tuple[bytes, float] | None:
        if self.latest is None:
            return None
        data, ts = self.latest, self.updated_at
        self.latest = None
        return data, ts


if AVAILABLE:

    class BrowserVideoTrack(VideoStreamTrack):
        """把 FrameSink 里的 JPEG 变成 aiortc 的视频帧（按档位缩放）。"""

        kind = "video"

        def __init__(self, sink: FrameSink) -> None:
            super().__init__()
            self._sink = sink
            self._decoder = av.CodecContext.create("mjpeg", "r")
            self._last: av.VideoFrame | None = None
            self._last_scaled: av.VideoFrame | None = None
            self._level = 0
            self._sent = 0
            self._queue_ms = 0.0

        @property
        def level(self) -> int:
            return self._level

        def set_level(self, level: int) -> None:
            level = max(0, min(level, len(LEVELS) - 1))
            if level != self._level:
                self._level = level
                self._last_scaled = None  # 下一次按新尺寸重算
                logger.info("WebRTC 清晰度档位 → %d (%dx%d)", level, *self.size)

        @property
        def size(self) -> tuple[int, int]:
            lv = LEVELS[self._level]
            return lv["width"], lv["height"]

        def _decode(self, data: bytes) -> av.VideoFrame | None:
            try:
                packet = av.Packet(data)
                frames = self._decoder.decode(packet)
            except Exception:
                # 偶发半帧/坏帧直接丢，不打断整条流
                return None
            return frames[-1] if frames else None

        def _scale(self, frame: av.VideoFrame) -> av.VideoFrame:
            w, h = self.size
            if frame.width == w and frame.height == h:
                return frame.reformat(format="yuv420p")
            return frame.reformat(width=w, height=h, format="yuv420p")

        async def recv(self) -> av.VideoFrame:
            frame: av.VideoFrame | None = None
            try:
                await asyncio.wait_for(self._sink.event.wait(), timeout=IDLE_FRAME_INTERVAL_S)
            except (asyncio.TimeoutError, TimeoutError):
                pass
            self._sink.event.clear()
            item = self._sink.take()
            if item is not None:
                data, ts = item
                self._queue_ms = (time.monotonic() - ts) * 1000
                decoded = self._decode(data)
                if decoded is not None:
                    frame = self._scale(decoded)
                    self._last = frame
                    self._last_scaled = frame
            if frame is None:
                frame = self._last_scaled or self._last
            if frame is None:
                # 还没有任何一帧：给一张黑图占位（避免 recv 抛异常把连接带崩）
                frame = av.VideoFrame(LEVELS[self._level]["width"], LEVELS[self._level]["height"], "yuv420p")
                for plane in frame.planes:
                    plane.update(bytes(plane.buffer_size))
            if frame.width != self.size[0] or frame.height != self.size[1]:
                frame = self._scale(frame)
                self._last_scaled = frame
            self._sent += 1
            frame.pts = int(time.monotonic() * 90000)
            frame.time_base = Fraction(1, 90000)
            return frame

        @property
        def queue_ms(self) -> float:
            return self._queue_ms

        @property
        def frames_sent(self) -> int:
            return self._sent


def _turn_ice_servers() -> list[dict[str, Any]]:
    """TURN REST 临时凭据（密钥只在服务端）。

    ``STUDIO_TURN_URLS`` 形如 ``turn:1.2.3.4:3478?transport=tcp``（逗号分隔）。
    没配就返回空 —— 前端会先走直连，失败后自动切兼容模式（不静默假装有 TURN）。
    """
    secret = os.environ.get("STUDIO_TURN_SECRET", "").strip()
    urls = [u.strip() for u in os.environ.get("STUDIO_TURN_URLS", "").split(",") if u.strip()]
    if not secret or not urls:
        return []
    ttl = int(os.environ.get("STUDIO_TURN_TTL", "3600") or 3600)
    username = f"{int(time.time()) + ttl}:studio"
    digest = hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()
    return [
        {
            "urls": urls,
            "username": username,
            "credential": base64.b64encode(digest).decode(),
        }
    ]


def ice_config() -> dict[str, Any]:
    servers = _turn_ice_servers()
    return {
        "enabled": AVAILABLE,
        "iceServers": servers,
        "turn": bool(servers),
        "target_fps": VIDEO_FPS,
        "max_width": VIDEO_WIDTH,
        "max_height": VIDEO_HEIGHT,
    }


# --------------------------------------------------------------------------- #
# 一条会话的推流
# --------------------------------------------------------------------------- #
class BrowserStream:
    def __init__(self, session_id: str, browser: Any, client: str = "") -> None:
        self.session_id = session_id
        self.browser = browser
        #: 建这条流的前端实例标识。同一个会话可能同时挂着两个面板（右栏 + 全屏），
        #: 谁先关就把对方顶掉过（"两个 BrowserStage 互相顶掉"就是这么来的）——
        #: 带上它之后，只有**建这条流的那个人**能关它。
        self.client = client
        self.sink = FrameSink()
        self.pc: Any = None
        self.track: Any = None
        self.transceiver: Any = None
        self.channel: Any = None
        self.level = 0
        self.state = "connecting"
        self.reason = ""
        self.created_at = time.monotonic()
        self.last_stats: dict[str, Any] = {}
        self._client: dict[str, Any] = {}
        self._last_client_at = 0.0
        self._frames_base = 0
        self._frames_in_base = 0
        self._sink_fps = 0.0
        self._fps_at = time.monotonic()
        self._fps = 0.0
        self._task: asyncio.Task[None] | None = None
        self._monitor: asyncio.Task[None] | None = None
        self._closed = False

    # -- 生命周期 ---------------------------------------------------------- #
    async def start(self) -> None:
        if not AVAILABLE:
            raise RuntimeError("服务端没有装 aiortc/PyAV，WebRTC 不可用")
        await self.browser.enable_video_mode(self.sink)
        self.pc = RTCPeerConnection()
        self.track = BrowserVideoTrack(self.sink)
        # 用 addTransceiver（而不是 addTrack）拿得到 transceiver：必须在
        # setRemoteDescription **之前**设编解码偏好，aiortc 只在那一步过滤。
        self.transceiver = self.pc.addTransceiver(self.track, direction="sendonly")
        self._task = asyncio.create_task(self._watch())
        self._monitor = asyncio.create_task(self._metrics_loop())

        @self.pc.on("datachannel")
        def _on_datachannel(channel: Any) -> None:
            self.channel = channel

            @channel.on("message")
            def _on_message(message: Any) -> None:
                asyncio.create_task(self._on_input(message))

    async def _watch(self) -> None:
        """连接状态变化 → 失败就收摊并通知前端切兼容模式。"""
        try:
            while not self._closed:
                await asyncio.sleep(0.5)
                pc = self.pc
                if pc is None:
                    return
                st = pc.connectionState
                if st == "connected" and self.state != "live":
                    self.state = "live"
                    self.reason = ""
                    self._publish()
                elif st in ("failed", "closed"):
                    await self._fail("WebRTC 连接断了" if st == "failed" else "WebRTC 连接已关闭")
                    return
                elif st == "disconnected":
                    # ICE 偶尔能自己恢复：给 6 秒，不行才算失败
                    await asyncio.sleep(6)
                    if pc.connectionState == "disconnected":
                        await self._fail("WebRTC 连接中断（ICE 不通）")
                        return
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover
            logger.exception("WebRTC 连接监视出错")
            await self._fail("WebRTC 连接异常")

    async def _fail(self, reason: str) -> None:
        if self._closed:
            return
        self.state = "failed"
        self.reason = reason
        logger.info("WebRTC 失败 session=%s：%s", self.session_id, reason)
        self._publish()
        await self.close(keep_state=True)

    async def close(self, keep_state: bool = False) -> None:
        if self._closed:
            return
        self._closed = True
        if self._monitor:
            self._monitor.cancel()
        if self._task and self._task is not asyncio.current_task():
            self._task.cancel()
        if self.pc is not None:
            try:
                await self.pc.close()
            except Exception:  # pragma: no cover
                pass
        self.pc = None
        if not keep_state:
            self.state = "closed"
        try:
            await self.browser.disable_video_mode(self.sink)
        except Exception:  # pragma: no cover
            logger.debug("关闭视频模式失败", exc_info=True)
        if STREAMS.get(self.session_id) is self:
            STREAMS.pop(self.session_id, None)

    # -- 指标 -------------------------------------------------------------- #
    def _publish(self) -> None:
        """把模式/实测值推给前端状态区（SSE，seq<0 不落库）。"""
        try:
            from .runner.service import bus

            bus.publish(
                f"sess:{self.session_id}",
                {
                    "seq": -4,
                    "type": "browser_stream",
                    "ts": 0,
                    "payload": {
                        "mode": "webrtc" if self.state in ("live", "connecting") else "jpeg",
                        "state": self.state,
                        "reason": self.reason,
                        "fps": round(self._fps, 1),
                        "kbps": int(self.last_stats.get("kbps") or 0),
                        "latency_ms": int(self.last_stats.get("latency_ms") or 0),
                        "width": LEVELS[self.level]["width"],
                        "height": LEVELS[self.level]["height"],
                        "level": self.level,
                    },
                },
            )
        except Exception:  # pragma: no cover
            logger.debug("推流指标推送失败", exc_info=True)

    async def _metrics_loop(self) -> None:
        last_bytes = 0
        last_at = time.monotonic()
        try:
            while not self._closed:
                await asyncio.sleep(2)
                sent = self.track.frames_sent if self.track else 0
                frames_in = self.sink.frames_in
                now = time.monotonic()
                span = max(0.001, now - self._fps_at)
                self._fps = (sent - self._frames_base) / span
                # 浏览器真正在出帧的速度（静止页面只有 2fps 保活帧，不能当"网络差"）
                self._sink_fps = (frames_in - self._frames_in_base) / span
                self._frames_base, self._frames_in_base, self._fps_at = sent, frames_in, now
                kbps = 0
                if self.pc is not None:
                    try:
                        stats = await self.pc.getStats()
                        for rep in stats.values():
                            if getattr(rep, "type", "") == "outbound-rtp" and getattr(rep, "kind", "") == "video":
                                total = int(getattr(rep, "bytesSent", 0) or 0)
                                kbps = int((total - last_bytes) * 8 / max(0.001, now - last_at) / 1000)
                                last_bytes, last_at = total, now
                    except Exception:  # pragma: no cover
                        pass
                # 接收端回传的数值优先（那才是用户真正看到的）
                if self._client and time.monotonic() - self._last_client_at < 8:
                    self.last_stats = {
                        "kbps": int(self._client.get("kbps") or kbps),
                        "latency_ms": int(self._client.get("latency_ms") or 0),
                        "rtt_ms": int(self._client.get("rtt_ms") or 0),
                        "fps": float(self._client.get("fps") or 0),
                    }
                    self._adapt()
                else:
                    self.last_stats = {"kbps": kbps}
                logger.info(
                    "[webrtc] ses=%s state=%s fps=%.1f kbps=%s latency=%sms level=%d",
                    self.session_id,
                    self.state,
                    self._fps,
                    self.last_stats.get("kbps"),
                    self.last_stats.get("latency_ms"),
                    self.level,
                )
                self._publish()
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover
            logger.exception("推流指标循环出错")

    def _adapt(self) -> None:
        """接收端实测驱动分辨率阶梯：低于 15fps 降档，稳定 22fps 以上再升。

        只在**浏览器真的在出帧**时才判断：静止页面服务端按 2fps 发保活帧，
        接收端 fps 自然就是 2 —— 拿它当"网络差"会让页面越放越糊（实测降到
        640×400 后再也升不回来）。
        """
        if self._sink_fps < 6:
            return
        fps = float(self._client.get("fps") or 0)
        rtt = float(self._client.get("rtt_ms") or 0)
        now = time.monotonic()
        if fps and fps < 15 and self.level < len(LEVELS) - 1:
            if now - getattr(self, "_last_down", 0) > 6:
                self._last_down = now
                self.level += 1
                self._apply_level()
        elif fps >= 22 and rtt < 250 and self.level > 0:
            if now - getattr(self, "_last_up", 0) > 10:
                self._last_up = now
                self.level -= 1
                self._apply_level()

    def _apply_level(self) -> None:
        if self.track:
            self.track.set_level(self.level)
        # aiortc 没有暴露 setParameters；编码器实例在 sender 里，直接设码率
        try:
            sender = next(s for s in self.pc.getSenders() if s.kind == "video")
            enc = getattr(sender, "_RTCRtpSender__encoder", None)
            if enc is not None and hasattr(enc, "target_bitrate"):
                enc.target_bitrate = LEVELS[self.level]["bitrate"]
        except Exception:  # pragma: no cover
            pass

    # -- 输入（DataChannel） ------------------------------------------------ #
    async def _on_input(self, message: Any) -> None:
        if not isinstance(message, str):
            return
        try:
            payload = json.loads(message)
        except Exception:
            return
        if not isinstance(payload, dict):
            return
        kind = str(payload.get("kind") or "")
        if kind == "stats":
            self._client = payload
            self._last_client_at = time.monotonic()
            return
        # 坐标口径：前端从 701ad49 起发的就是**页面坐标**（它按 public_state.viewport
        # 把画面像素换算回 1280×800 的页面坐标），所以这里**不能再按档位乘一次** ——
        # 那会把点击整体放大 1280/档宽倍（实测 640 档点搜索框 → 落到空白处，
        # 焦点没进输入框，随后打的字全丢）。payload 里带 coords="page" 就是新口径；
        # 老前端（缓存的旧包）不带，才沿用档位换算。
        if kind in ("click", "move", "wheel"):
            lv = LEVELS[self.level]
            page_based = str(payload.get("coords") or "") == "page"
            if not page_based:
                fx = VIDEO_WIDTH / float(lv["width"])
                fy = VIDEO_HEIGHT / float(lv["height"])
                if (fx, fy) != (1.0, 1.0):
                    payload = dict(payload)
                    for key, factor in (("x", fx), ("y", fy)):
                        if key in payload:
                            try:
                                payload[key] = float(payload[key]) * factor
                            except (TypeError, ValueError):
                                pass
            else:
                # 页面坐标也别越界（留白处点空了会打到奇怪的地方）
                payload = dict(payload)
                try:
                    payload["x"] = max(0.0, min(float(payload.get("x", 0)), float(VIDEO_WIDTH) - 1))
                    payload["y"] = max(0.0, min(float(payload.get("y", 0)), float(VIDEO_HEIGHT) - 1))
                except (TypeError, ValueError):
                    pass
        from . import browser_control as bc

        c = bc.get_for_session(self.session_id)
        try:
            detail = await bc.apply_user_input_detail(c, self.browser, payload)
        except bc.UserInputDenied as exc:
            self._send({"type": "denied", "kind": kind, "reason": str(exc)})
            return
        except Exception as exc:  # pragma: no cover
            logger.exception("DataChannel 输入失败")
            self._send({"type": "denied", "kind": kind, "reason": f"这一步没打进去：{exc}"})
            return
        self._send(
            {
                "type": "ack",
                "kind": kind,
                "note": detail.get("note") or "",
                "feedback": detail.get("feedback") or "",
                "changed": bool(detail.get("changed")),
                "state": detail.get("state") or {},
            }
        )

    def _send(self, obj: dict[str, Any]) -> None:
        try:
            if self.channel is not None and self.channel.readyState == "open":
                self.channel.send(json.dumps(obj, ensure_ascii=False))
        except Exception:  # pragma: no cover
            logger.debug("DataChannel 回执发送失败", exc_info=True)


#: session_id → 当前推流（一个会话只推一条；新 offer 顶掉旧的）
STREAMS: dict[str, BrowserStream] = {}


def existing(session_id: str) -> BrowserStream | None:
    return STREAMS.get(session_id)


async def ensure_stream(session_id: str, browser: Any, client: str = "") -> BrowserStream:
    old = STREAMS.get(session_id)
    if old is not None:
        await old.close()
    stream = BrowserStream(session_id, browser, client)
    await stream.start()
    STREAMS[session_id] = stream
    return stream


async def handle_offer(
    session_id: str, browser: Any, offer_sdp: str, offer_type: str, client: str = ""
) -> dict[str, Any]:
    """浏览器 offer → 服务端 answer（非 trickle：answer 里带齐候选）。"""
    stream = await ensure_stream(session_id, browser, client)
    pc = stream.pc
    # 编解码偏好必须在 setRemoteDescription **之前**设（aiortc 在这一步算
    # transceiver._codecs；之后再设，answer 里 VP8 还在，浏览器就可能选它）。
    try:
        if "H264" in offer_sdp.upper():
            caps = [
                RTCRtpCodecCapability(
                    mimeType="video/H264",
                    clockRate=90000,
                    parameters={
                        "level-asymmetry-allowed": "1",
                        "packetization-mode": "1",
                        "profile-level-id": "42e01f",
                    },
                )
            ]
            stream.transceiver.setCodecPreferences(caps)
    except Exception:  # pragma: no cover - 老版本没有这个 API 就按默认协商
        logger.debug("setCodecPreferences 不可用，按默认协商", exc_info=True)
    await pc.setRemoteDescription(RTCSessionDescription(sdp=offer_sdp, type=offer_type))
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    deadline = time.monotonic() + GATHER_TIMEOUT_S
    while pc.iceGatheringState != "complete" and time.monotonic() < deadline:
        await asyncio.sleep(0.05)
    sdp = pc.localDescription.sdp
    stream._apply_level()
    return {"sdp": sdp, "type": pc.localDescription.type, "stream": metrics(session_id)}


def metrics(session_id: str) -> dict[str, Any]:
    s = STREAMS.get(session_id)
    if s is None:
        return {"mode": "jpeg", "state": "off", "fps": 0, "kbps": 0, "latency_ms": 0}
    return {
        "mode": "webrtc" if s.state in ("live", "connecting") else "jpeg",
        "state": s.state,
        "reason": s.reason,
        "fps": round(s._fps, 1),
        "kbps": int(s.last_stats.get("kbps") or 0),
        "latency_ms": int(s.last_stats.get("latency_ms") or 0),
        "rtt_ms": int(s.last_stats.get("rtt_ms") or 0),
        "width": LEVELS[s.level]["width"],
        "height": LEVELS[s.level]["height"],
        "level": s.level,
        "ice": "turn-tcp" if _turn_ice_servers() else "direct-only",
    }


async def close_stream(session_id: str, client: str = "") -> None:
    """收掉这个会话的推流。带 client 时**只关自己建的那条**（别顶掉对方的面板）。"""
    s = STREAMS.get(session_id)
    if s is None:
        return
    if client and s.client and s.client != client:
        logger.info("忽略别的面板的关闭请求 ses=%s（流属于 %s，请求来自 %s）", session_id, s.client, client)
        return
    await s.close()
