"""浏览器驱动事实注入：模型不该去翻机器猜版本。

现场：平台跑 Google Chrome 158（进程/UA 都核过），用户问「现在浏览器驱动版本」，
助手翻到 Playwright 自带的 chromium-1248，答 156.0.8078.4。
"""

from agent_studio import browser_drivers as bd
from agent_studio.runtimes.agentscope_rt.compile import browser_env_fact


def _act(**kw):
    base = {
        "label": "Google Chrome",
        "version": "158.0.8113.0",
        "proto": "cdp",
        "source": "managed",
        "path": "/srv/src/agent-studio/data/browsers/chrome-158.0.8113.0/chrome-linux64/chrome",
    }
    base.update(kw)
    return base


def test_挂了browser就给出驱动事实():
    bd._LAST_ACTIVE.clear()
    bd.remember_active(_act())
    text = browser_env_fact([{"name": "browser"}, {"name": "bash"}])
    assert "运行环境事实" in text
    assert "158.0.8113.0" in text
    assert "不要" in text and "Playwright" in text
    assert "平台管理" in text


def test_没挂browser就不插():
    bd._LAST_ACTIVE.clear()
    bd.remember_active(_act())
    assert browser_env_fact([{"name": "bash"}]) == ""


def test_没有缓存值时不插():
    bd._LAST_ACTIVE.clear()
    assert browser_env_fact([{"name": "browser"}]) == ""


def test_回退到系统浏览器时明说():
    bd._LAST_ACTIVE.clear()
    bd.remember_active(_act(version="148.0.7778.215", stale=True, stale_reason="设置里选的浏览器不在这台机器上：/x"))
    text = browser_env_fact([{"name": "browser"}])
    assert "已回退系统 Chromium" in text
    assert "148.0.7778.215" in text


def test_对象形态的工具也能识别():
    bd._LAST_ACTIVE.clear()
    bd.remember_active(_act())

    class T:
        name = "browser_use"

    assert "运行环境事实" in browser_env_fact([T()])
