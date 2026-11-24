"""浏览器驱动设置指向别的机器（跨机迁移）时：能自愈就自愈，不能就明说。

现场：本机选了 chrome-158，迁到东京后设置里还留着 /srv/src/... 的绝对路径，
东京没有这个文件 → 以前静默回退系统 Chromium（148），用户看着"已选中 158"却是 148。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_studio import browser_drivers as bd


@pytest.fixture()
def fake_root(tmp_path, monkeypatch):
    """造一个假的本机 browsers 目录：chrome-158.0.8113.0/chrome-linux64/chrome"""
    root = tmp_path / "browsers"
    exe = root / "chrome-158.0.8113.0" / "chrome-linux64" / "chrome"
    exe.parent.mkdir(parents=True)
    exe.write_text("#!/bin/sh\necho 'Google Chrome 158.0.8113.0'\n")
    exe.chmod(0o755)
    monkeypatch.setattr(bd, "ROOT", root)
    return root, exe


def test_跨机路径按版本目录复位(fake_root):
    root, exe = fake_root
    got = bd._remap_path("/home/other/agent-studio/data/browsers/chrome-158.0.8113.0/chrome-linux64/chrome")
    assert got == str(exe)


def test_本机已有路径原样返回(fake_root):
    _root, exe = fake_root
    assert bd._remap_path(str(exe)) == str(exe)


def test_找不到同名版本时返回空(fake_root):
    assert bd._remap_path("/opt/nowhere/chrome-999.0.0.0/chrome-linux64/chrome") == ""


async def test_get_active_自愈并写回(fake_root):
    from agent_studio.db import SessionLocal, init_db
    from agent_studio.settings_store import get_setting, set_setting

    root, exe = fake_root
    await init_db()
    async with SessionLocal() as s:
        await set_setting(
            s,
            bd.SETTING_KEY,
            {"kind": "chrome", "path": "/home/other/agent-studio/data/browsers/chrome-158.0.8113.0/chrome-linux64/chrome", "version": "158.0.8113.0", "source": "managed"},
        )
        await s.commit()
        out = await bd.get_active(s)
        assert out["path"] == str(exe), "应该自愈到本机同版本"
        assert out.get("corrected_from", "").startswith("/home/other/")
        saved = await get_setting(s, bd.SETTING_KEY, {})
        assert saved["path"] == str(exe), "纠正后的路径要写回，别每次重算"


async def test_get_active_无法自愈时标_stale(fake_root):
    from agent_studio.db import SessionLocal, init_db
    from agent_studio.settings_store import set_setting

    await init_db()
    async with SessionLocal() as s:
        await set_setting(
            s,
            bd.SETTING_KEY,
            {"kind": "chrome", "path": "/opt/nowhere/chrome-999.0.0.0/chrome-linux64/chrome", "version": "999.0", "source": "managed"},
        )
        await s.commit()
        out = await bd.get_active(s)
        assert out["stale"] is True
        assert out["configured_path"].endswith("chrome")
        assert "不在这台机器上" in out["stale_reason"]
