"""共享浏览器：两个会话只起一个 Chromium 进程，各自一个 BrowserContext。

来历：每会话 spawn 一个 Chromium，一天堆到 12 个、1.5GB 内存、16% CPU。
"""

from __future__ import annotations

import asyncio


def test_两个会话共用一个进程且上下文隔离(tmp_path, monkeypatch):
    from agent_studio import browser_pool
    from agent_studio.browser_session import BrowserSession

    # 隔离 profile 目录：生产里常驻的那个共享进程会占住 SingletonLock，
    # 不隔离的话测试会起不来第二个进程 → 回落每会话模式 → 假失败。
    monkeypatch.setattr(browser_pool, "ROOT", tmp_path / "shared-profile")
    browser_pool._proc = None
    browser_pool._ws_url = ""

    async def go():
        a = BrowserSession("runA", lambda *x: None, session_id="ses_pool_a")
        b = BrowserSession("runB", lambda *x: None, session_id="ses_pool_b")
        try:
            await a._ensure()
            await b._ensure()
            assert a._shared and b._shared, "没走共享模式"
            assert a._browser_ctx and b._browser_ctx
            assert a._browser_ctx != b._browser_ctx, "两个会话共用了一个上下文"
            assert a._cdp is not None and b._cdp is not None
            assert a._cdp.session_id != b._cdp.session_id, "attach 到了同一个页面"
            assert browser_pool.running(), "共享进程没起来"
        finally:
            await a.close()
            await b.close()
        # 关掉会话只 dispose 掉自己的 context，进程留着给下一个会话用
        assert browser_pool.running(), "关会话把共享进程一起收了"
        await browser_pool.shutdown()
        assert not browser_pool.running()

    asyncio.run(go())
