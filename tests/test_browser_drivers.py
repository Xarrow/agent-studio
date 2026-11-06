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


# --------------------------------------------------------------------------- #
# 自检：「装好了」和「能用」是两件事
#
# 现场踩到的：Chrome for Testing 下载解压都成功、界面上也"已选中"，但机器上
# 缺 libnss3/libnspr4 —— 一启动就死。用户看到的只有"启动失败（没有 DevTools 行）"，
# 于是以为"驱动没装上"，反复重装也没用。
# --------------------------------------------------------------------------- #
def _fake_bin(tmp_path, body: str):
    p = tmp_path / "fake-chrome"
    p.write_text("#!/bin/sh\n" + body, encoding="utf-8")
    p.chmod(0o755)
    return p


def test_verify_flags_missing_shared_libs(tmp_path, monkeypatch):
    exe = _fake_bin(
        tmp_path,
        'echo "fake-chrome: error while loading shared libraries: libnss3.so: '
        'cannot open shared object file: No such file or directory" >&2\nexit 127\n',
    )
    monkeypatch.setattr(bd, "_missing_libs", lambda _p: ["libnspr4.so", "libnss3.so"])
    got = bd.verify(str(exe), "chrome", force=True)
    assert got["ok"] is False
    assert "缺系统运行库" in got["problem"]
    assert "libnss3.so" in got["problem"]
    # 必须给出能直接照抄的补救命令，否则用户还是不知道要干嘛
    assert "apt-get install" in got["hint"]


def test_verify_passes_when_browser_renders(tmp_path, monkeypatch):
    exe = _fake_bin(tmp_path, 'echo "<html><body></body></html>"\nexit 0\n')
    monkeypatch.setattr(bd, "_missing_libs", lambda _p: [])
    got = bd.verify(str(exe), "chrome", force=True)
    assert got["ok"] is True, got
    assert got["problem"] == ""


def test_verify_reports_vanished_binary(tmp_path):
    got = bd.verify(str(tmp_path / "nope"), "chrome", force=True)
    assert got["ok"] is False
    assert "不存在" in got["problem"]


def test_verify_result_is_cached(tmp_path, monkeypatch):
    exe = _fake_bin(tmp_path, 'echo "<html></html>"\nexit 0\n')
    calls = {"n": 0}

    def _count(path):
        calls["n"] += 1
        return []

    monkeypatch.setattr(bd, "_missing_libs", _count)
    bd.verify(str(exe), "chrome", force=True)
    bd.verify(str(exe), "chrome")
    assert calls["n"] == 1, "短时间内重复自检不该反复起进程"


def test_active_reports_why_it_cannot_run(tmp_path, monkeypatch):
    """当前驱动要带上 verify —— 页面靠它显示「起不来：缺 xxx」而不是只显示"在用"。"""
    exe = _fake_bin(
        tmp_path,
        'echo "chrome: error while loading shared libraries: libgbm.so.1: '
        'cannot open shared object file" >&2\nexit 127\n',
    )
    monkeypatch.setattr(bd, "_missing_libs", lambda _p: ["libgbm.so.1"])

    async def run():
        init_db()
        async with SessionLocal() as s:
            await bd.set_active(s, "chrome", str(exe), "1.0.0", "managed")
            got = await bd.get_active(s)
            assert got["verify"]["ok"] is False
            assert "libgbm.so.1" in got["verify"]["problem"]
            await bd.reset_active(s)

    import asyncio

    asyncio.run(run())


# --------------------------------------------------------------------------- #
# 全新机器：缺系统库时能不能自己救回来
# --------------------------------------------------------------------------- #
def test_install_deps_without_root_hands_back_the_command(monkeypatch):
    """systemd 起来的是普通用户：装不了就**把命令原样交出去**，不能假装成功。"""
    import subprocess as sp

    monkeypatch.setattr(bd, "_apt_cmd", lambda: ["apt-get", "install", "-y", "libnss3"])
    monkeypatch.setattr(bd.os, "geteuid", lambda: 1000)
    monkeypatch.setattr(bd.shutil, "which", lambda name: None)  # 连 sudo 都没有

    class _P:
        returncode = 1
        stdout = ""
        stderr = "E: Could not open lock file /var/lib/dpkg/lock-frontend"

    monkeypatch.setattr(bd.subprocess, "run", lambda *a, **k: _P())
    got = bd.install_system_deps()
    assert got["ok"] is False
    assert got["needs_root"] is True
    assert got["command"].startswith("apt-get install")
    assert "lock" in got["output"], "真实报错要带回来，否则用户不知道卡在哪"


def test_install_deps_as_root_reports_success_and_clears_check_cache(monkeypatch):
    monkeypatch.setattr(bd, "_apt_cmd", lambda: ["apt-get", "install", "-y", "libnss3"])
    monkeypatch.setattr(bd.os, "geteuid", lambda: 0)
    bd._VERIFY["whatever@1"] = {"ok": False}

    class _P:
        returncode = 0
        stdout = "Setting up libnss3 ..."
        stderr = ""

    monkeypatch.setattr(bd.subprocess, "run", lambda *a, **k: _P())
    got = bd.install_system_deps()
    assert got["ok"] is True
    assert bd._VERIFY == {}, "装完必须作废旧自检结论，否则页面还显示着「起不来」"


def test_deps_dir_can_be_pointed_by_env(monkeypatch, tmp_path):
    """包里带库这条路：STUDIO_BROWSER_LIBS 指过去，启动时就注入 LD_LIBRARY_PATH。"""
    monkeypatch.setenv("STUDIO_BROWSER_LIBS", str(tmp_path))
    assert bd.deps_dir() == tmp_path
    assert bd.chrome_env() == {}, "空目录不算数"
    (tmp_path / "libnss3.so").write_text("", encoding="utf-8")
    assert bd.chrome_env() == {"LD_LIBRARY_PATH": str(tmp_path)}
