"""护栏：浏览器驱动管理（装哪个、用哪个）。

钉三件容易"看起来对、实际跑不起来"的事：

① **zip 不保留执行位**：只给主程序 chmod，Chrome 一启动就死在
   ``chrome_crashpad_handler: Permission denied``（实测）。辅助进程也要可执行。
② **国内源优先**：Google 的存储源动不动断在半路（88MB/206MB 被掐），
   候选列表必须镜像在前、官方兜底。
③ **当前驱动要落库**：只写不 commit 的话，界面上点了"用这个"其实没生效
   （实测踩到：设置项根本没写进 app_setting）。
"""

from __future__ import annotations

import os

import pytest

from agent_studio import browser_drivers as bd
from agent_studio.db import SessionLocal, init_db

pytestmark = pytest.mark.anyio


def test_cft_mirror_first_then_official():
    url = "https://storage.googleapis.com/chrome-for-testing-public/155.0.1/linux64/chrome-linux64.zip"
    cands = bd.candidate_urls("chrome", "155.0.1", url)
    assert cands[0].startswith("https://cdn.npmmirror.com/binaries/chrome-for-testing/")
    assert cands[-1] == url, "官方源必须留作兜底"


def test_firefox_mirror_candidate():
    url = "https://download.mozilla.org/?product=firefox-158.0.1-SSL&os=linux64&lang=en-US"
    cands = bd.candidate_urls("firefox", "158.0.1", url)
    assert any("mirrors.tuna.tsinghua.edu.cn" in c and "firefox-158.0.1.tar.xz" in c for c in cands)
    assert cands[-1] == url


def test_fix_perms_makes_helper_executables(tmp_path):
    """解压出来的辅助进程要能执行 —— 否则 Chrome 起不来（就是这条拦过一次发布）。"""
    d = tmp_path / "chrome-linux64"
    d.mkdir()
    main = d / "chrome"
    helper = d / "chrome_crashpad_handler"
    lib = d / "libEGL.so"
    for f in (main, helper, lib):
        f.write_bytes(b"x")
        os.chmod(f, 0o644)  # 模拟 zip 解压后的样子

    bd._fix_perms(tmp_path)

    assert os.access(main, os.X_OK)
    assert os.access(helper, os.X_OK), "辅助进程没有执行位 = 一启动就 Permission denied"
    assert not os.access(lib, os.X_OK), "库文件不该给执行位"


def test_managed_exe_finds_nested_binary(tmp_path):
    """CfT 解压是 chrome-linux64/chrome，Firefox 是 firefox/firefox —— 都要认得。"""
    cft = tmp_path / "chrome-155" / "chrome-linux64"
    cft.mkdir(parents=True)
    (cft / "chrome").write_bytes(b"x")
    assert bd._managed_exe(tmp_path / "chrome-155", "chrome").name == "chrome"

    ff = tmp_path / "firefox-158" / "firefox"
    ff.mkdir(parents=True)
    (ff / "firefox").write_bytes(b"x")
    assert bd._managed_exe(tmp_path / "firefox-158", "firefox").name == "firefox"


def test_active_driver_roundtrip():
    """切到某个驱动 → 读回来是它；恢复默认 → 回到系统 Chromium。"""

    async def run() -> None:
        await init_db()
        # 用一个真实存在的可执行文件当"托管驱动"
        fake = "/bin/sh"
        async with SessionLocal() as s:
            got = await bd.set_active(s, "chrome", fake, "9.9.9", "managed")
            assert got["kind"] == "chrome"
            assert got["path"] == fake
            assert got["version"] == "9.9.9"
            assert got["custom"] is True

            async with SessionLocal() as s2:
                again = await bd.get_active(s2)
            assert again["path"] == fake, "设置必须落库（只写不 commit 会读不回来）"

            async with SessionLocal() as s3:
                back = await bd.reset_active(s3)
            assert back["kind"] == "chromium"
            assert back["custom"] is False

    import asyncio

    asyncio.run(run())


def test_installed_lists_system_chromium():
    rows = bd.installed()
    assert any(r["kind"] == "chromium" and r["source"] == "system" for r in rows)
