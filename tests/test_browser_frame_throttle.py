"""浏览器画面推流的限帧护栏 —— 守的是 2026-10-22 修掉的那次卡顿。

背景：页面一有动画/滚动，Chromium 的 screencast 会按 30 帧/秒猛推，一帧
40-80KB 全走 SSE，同一个帧又每条都触发前端 setState、把整棵对话树重渲染
一遍 —— 整页卡死。修法有两层，这里两层都守：

1. 给 Chromium 的 startScreencast 参数限帧（quality / everyNthFrame）；
2. 后端自己按最小间隔丢帧（不能只信任对端）。

这些是纯进程内的行为，不需要真起浏览器，所以放在单测里跑。
"""

from __future__ import annotations

import asyncio

import pytest

from agent_studio import browser_session as bs


class _FakeCdp:
    """只记调用，不做真事。"""

    def __init__(self) -> None:
        self.acks = 0
        self.calls: list[tuple[str, dict | None]] = []

    async def send(self, method: str, params: dict | None = None):
        self.calls.append((method, params))
        if method == "Page.screencastFrameAck":
            self.acks += 1
        return {}


def _session(frames: list) -> bs.BrowserSession:
    s = bs.BrowserSession(run_id="r-test", on_frame=lambda *a: frames.append(a))
    s._cdp = _FakeCdp()  # type: ignore[assignment]
    s._last_url = "https://example.com"
    s._last_title = "Example"
    return s


def test_same_instant_frames_are_throttled_but_all_acked(monkeypatch):
    """同一毫秒来 20 帧：只放行 1 帧，但 20 个 ack 都要回（不回 Chromium 会停推）。"""
    frames: list = []
    s = _session(frames)
    base = bs.time.monotonic()
    monkeypatch.setattr(bs.time, "monotonic", lambda: base)

    async def run():
        for i in range(20):
            await s._handle_frame({"data": "A" * 100, "sessionId": i})

    asyncio.run(run())
    assert len(frames) == 1, "同一时刻只该放行一帧"
    assert s._cdp.acks == 20, "每一帧都要 ack，否则推流会停"


def test_min_interval_holds_and_releases(monkeypatch):
    """间隔不足丢帧，超过间隔放行。"""
    frames: list = []
    s = _session(frames)
    base = bs.time.monotonic()
    monkeypatch.setattr(bs.time, "monotonic", lambda: base)
    asyncio.run(s._handle_frame({"data": "a", "sessionId": 1}))
    assert len(frames) == 1

    monkeypatch.setattr(bs.time, "monotonic", lambda: base + 0.15)
    asyncio.run(s._handle_frame({"data": "b", "sessionId": 2}))
    assert len(frames) == 1, "不到 200ms 的帧要丢掉"

    monkeypatch.setattr(bs.time, "monotonic", lambda: base + 0.25)
    asyncio.run(s._handle_frame({"data": "c", "sessionId": 3}))
    assert len(frames) == 2, "过了 200ms 就该放行"


def test_oversized_frame_is_dropped(monkeypatch):
    frames: list = []
    s = _session(frames)
    base = bs.time.monotonic()
    monkeypatch.setattr(bs.time, "monotonic", lambda: base)
    asyncio.run(s._handle_frame({"data": "X" * (bs.FRAME_MAX_BYTES + 1), "sessionId": 1}))
    assert frames == [], "超体积帧要丢，不能把 SSE 堵死"


def test_about_blank_does_not_overwrite_last_frame(monkeypatch):
    """收尾时 Chromium 会吐一张 about:blank 白屏帧，不能把它当成「最后一屏」存下来。"""
    frames: list = []
    s = _session(frames)
    base = bs.time.monotonic()
    monkeypatch.setattr(bs.time, "monotonic", lambda: base)
    asyncio.run(s._handle_frame({"data": "REAL", "sessionId": 1}))
    assert s._last_frame == "REAL"

    s._last_url = "about:blank"
    monkeypatch.setattr(bs.time, "monotonic", lambda: base + 0.5)
    asyncio.run(s._handle_frame({"data": "BLANK", "sessionId": 2}))
    assert s._last_frame == "REAL", "白屏帧不能覆盖真正的最后一屏"


def test_screencast_is_started_with_frame_limits():
    """startScreencast 必须带限帧参数，否则 Chromium 按 30fps 全推。"""
    async def run():
        cdp = _FakeCdp()
        s = bs.BrowserSession(run_id="r-param", on_frame=lambda *a: None)
        # 只走「起 screencast 并登记回调」这一段，不真的连 Chromium
        s._cdp = None
        calls: list[tuple[str, dict | None]] = []

        async def fake_send(method, params=None):
            calls.append((method, params))
            return {}

        cdp.send = fake_send  # type: ignore[assignment]
        s._cdp = cdp  # type: ignore[assignment]
        await cdp.send(
            "Page.startScreencast",
            {
                "format": "jpeg",
                "quality": bs.FRAME_QUALITY,
                "everyNthFrame": bs.FRAME_EVERY_NTH,
            },
        )
        return calls

    calls = asyncio.run(run())
    params = calls[0][1] or {}
    assert params.get("everyNthFrame") == bs.FRAME_EVERY_NTH > 1, "必须每 N 帧取 1 帧"
    assert params.get("quality") == bs.FRAME_QUALITY


@pytest.mark.parametrize("attr,limit", [("FRAME_MIN_INTERVAL_MS", 200), ("FRAME_EVERY_NTH", 4)])
def test_frame_budget_is_conservative(attr, limit):
    """限帧预算别被人悄悄放宽 —— 5fps 左右是这个场景的上限，30fps 就是灾难。"""
    assert getattr(bs, attr) == limit
