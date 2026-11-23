"""浏览器回收：5 分钟空闲 TTL、同时最多 3 个、启动清扫残留。

来历：一天下来 /tmp 里堆了 12 个 Chromium（1.5GB 内存、16% CPU），全是没人看的页面。
根因是服务重启后进程内字典清空、上一轮 spawn 的 Chromium 谁都不认领。
"""

from __future__ import annotations

from agent_studio import browser_control as bc


def test_空闲保活是五分钟():
    assert bc.IDLE_TTL_S == 5 * 60


def test_最多同时保留三个浏览器():
    assert bc.MAX_LIVE_BROWSERS == 3


def test_启动清扫在干净机器上是幂等的():
    # 没有残留时返回 0，且不抛（启动路径不能因为清理失败起不来）
    assert bc.sweep_orphan_browsers() == 0


def test_巡检有公开入口():
    # 服务启动就要挂上巡检，不能等第一个浏览器 ensure 才起
    assert callable(bc.ensure_janitor)


def test_巡检单轮_空闲超时与数量上限都能收(monkeypatch):
    """_reclaim_once：空闲超 5 分钟收、超过 3 个收最久没动的。"""
    import asyncio

    closed: list[str] = []

    async def fake_close(c, reason=""):
        c.alive = False
        closed.append(c.key)

    monkeypatch.setattr(bc, "close", fake_close)
    bc._CONTROLS.clear()
    now = bc.now_ms()
    # 两个新鲜的 + 一个空闲 6 分钟的 + 一个第 4 个（触发上限）
    for i, (sid, age_ms) in enumerate(
        [("ses_fresh1", 0), ("ses_fresh2", 1000), ("ses_stale", 6 * 60 * 1000)]
    ):
        c = bc.Control(key=f"ses:{sid}", session_id=sid)
        c.alive, c.status, c.last_active = True, bc.AGENT, now - age_ms
        bc._CONTROLS[c.key] = c
    # 第 4 个：最新，但总数超限 → 应把最老的收掉（已经因超时收掉的除外）
    c4 = bc.Control(key="ses:fresh3", session_id="fresh3")
    c4.alive, c4.status, c4.last_active = True, bc.AGENT, now
    bc._CONTROLS[c4.key] = c4

    try:
        reclaimed = asyncio.run(bc._reclaim_once())
        assert "ses:ses_stale" in reclaimed, "空闲 6 分钟的没被收"
        assert "ses:ses_stale" in closed
        # 剩下 3 个新鲜的不超限 → 不再收
        assert len(closed) == 1, closed
    finally:
        bc._CONTROLS.clear()


def test_巡检单轮_只超数量也要收最久没动的(monkeypatch):
    import asyncio

    closed: list[str] = []

    async def fake_close(c, reason=""):
        c.alive = False
        closed.append(c.key)

    monkeypatch.setattr(bc, "close", fake_close)
    bc._CONTROLS.clear()
    now = bc.now_ms()
    for i in range(4):  # 都新鲜，只是数量超了
        sid = f"s{i}"
        c = bc.Control(key=f"ses:{sid}", session_id=sid)
        c.alive, c.status, c.last_active = True, bc.AGENT, now - (4 - i) * 1000
        bc._CONTROLS[c.key] = c

    try:
        reclaimed = asyncio.run(bc._reclaim_once())
        assert reclaimed == ["ses:s0"], f"应只收最久没动的 s0，实际 {reclaimed}"
        assert bc.MAX_LIVE_BROWSERS == 3
    finally:
        bc._CONTROLS.clear()
