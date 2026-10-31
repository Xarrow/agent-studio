"""公网口令闸：三种带法（cookie / query / header）都要放行，导航 401 要给页面。

回归的是现场事故：口令只存 localStorage 时，浏览器刷新 / 直接输网址带不上自定义头，
后端只认 header/query → 地址栏里只剩一段白页 JSON（用户反馈"页面卡住了"），
而且那个 401 是 JSON，页面上连输口令的框都没有，用户没有任何自救入口。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from agent_studio import main as app_main

TOKEN = "test-token-123"


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """把所有请求当成"经隧道进来"（TestClient 的 peer 叫 testclient）。"""
    monkeypatch.setattr(app_main, "ACCESS_TOKEN", TOKEN)
    monkeypatch.setattr(app_main, "TUNNEL_PEERS", {"testclient"})
    # 不进入 lifespan：只要中间件与路由就够，别去建库/起调度
    return TestClient(app_main.app, raise_server_exceptions=False)


NAV = {"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}
FETCH = {"Accept": "application/json"}


def test_navigation_gets_a_token_page_not_json(client: TestClient) -> None:
    r = client.get("/exec", headers=NAV)
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("text/html")
    assert "需要访问口令" in r.text
    # 页面必须自己能把口令写回去（cookie + localStorage），否则刷新还是白页
    assert "studio_token" in r.text and "studio_access_token" in r.text


def test_fetch_still_gets_json(client: TestClient) -> None:
    r = client.get("/api/version", headers=FETCH)
    assert r.status_code == 401
    assert r.json()["detail"].startswith("需要访问口令")


@pytest.mark.parametrize(
    "kwargs",
    [
        {"headers": {**FETCH, "Authorization": f"Bearer {TOKEN}"}},
        {"headers": {**FETCH, "Cookie": f"studio_token={TOKEN}"}},
        {"params": {"token": TOKEN}, "headers": FETCH},
    ],
    ids=["bearer", "cookie", "query"],
)
def test_three_ways_in(client: TestClient, kwargs: dict) -> None:
    r = client.get("/api/version", **kwargs)
    assert r.status_code == 200, f"{kwargs} 应该放行"


def test_navigation_with_cookie_passes(client: TestClient) -> None:
    """过闸后刷新必须直接进得去 —— 这正是当初卡住的那一步。"""
    r = client.get("/exec", headers={**NAV, "Cookie": f"studio_token={TOKEN}"})
    assert r.status_code != 401


def test_wrong_token_still_rejected(client: TestClient) -> None:
    r = client.get("/api/version", headers={**FETCH, "Cookie": "studio_token=nope"})
    assert r.status_code == 401
