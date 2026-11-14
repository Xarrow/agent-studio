"""搜索通道自检：状态落库、间隔跳过、探针判据。

为什么值得测：这段代码唯一的产出是"界面上那个红/绿点"。它一旦误判成绿，
用户就会以为搜索正常，而 Agent 正在把无关结果当答案用。
"""

from __future__ import annotations

import pytest

from agent_studio import search_health
from agent_studio.db import init_db


@pytest.fixture(autouse=True)
async def _db():
    await init_db()
    yield


async def test_probe_判据_相关度与耗时(monkeypatch):
    async def good(q, n=8):
        return "1. debian 12 安装 nginx 教程\n   x\n   https://a\n2. nginx\n   y\n   https://b"

    monkeypatch.setattr(search_health, "_search_qq", good)
    p = await search_health._probe("debian 12 安装 nginx")
    assert p["ok"] is True and p["relevance"] >= 0.5

    async def junk(q, n=8):
        return "1. Coronavirus\n   x\n   https://c\n2. WHO\n   y\n   https://d"

    monkeypatch.setattr(search_health, "_search_qq", junk)
    p = await search_health._probe("debian 12 安装 nginx")
    assert p["ok"] is False and p["relevance"] == 0.0


async def test_probe_引擎异常不算整体崩(monkeypatch):
    async def boom(q, n=8):
        raise RuntimeError("gateway timeout")

    monkeypatch.setattr(search_health, "_search_qq", boom)
    p = await search_health._probe("随便")
    assert p["ok"] is False
    assert "gateway timeout" in p["error"]


async def test_check_落库_且未到间隔复用上次结果(monkeypatch):
    calls = {"n": 0}

    async def good(q, n=8):
        calls["n"] += 1
        return "1. debian 12 安装 nginx\n   x\n   https://a\n2. rust async runtime\n   y\n   https://b"

    monkeypatch.setattr(search_health, "_search_qq", good)
    first = await search_health.check(force=True)
    assert first["ok"] is True and calls["n"] == len(search_health.CANARY)

    # 未到间隔：不重新探测
    again = await search_health.check(force=False)
    assert calls["n"] == len(search_health.CANARY)
    assert again["checked_at"] == first["checked_at"]

    # 状态接口只读，不再打网络
    st = await search_health.state()
    assert st["ok"] is True and st["engine"] == "qq" and len(st["probes"]) == len(search_health.CANARY)
