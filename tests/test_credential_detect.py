"""「粘贴即用」：只给 Key 认服务商 + 验证 + 拿模型清单。

守三件事：
  ① 认得出是哪家（真去逐个试，不靠前缀猜）；
  ② 认出来后把默认端点与模型清单一起带回来（前端直接用选择器）；
  ③ 认不出时给人话原因与下一步，**不透后端原文**。
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_studio.api import credentials as cred_api


async def _fake_probe(provider: str, api_key: str, base_url: str | None, model_name: str | None):
    if provider == "openai":
        return True, ["gpt-4o-mini", "gpt-4o"], None, 120
    return False, [], "密钥无效（HTTP 401）：Incorrect API key provided: sk-xxx", 60


async def test_detect_recognizes_provider_and_returns_models(client, monkeypatch):
    monkeypatch.setattr(cred_api, "_probe", _fake_probe)
    r = await client.post("/api/credentials/detect", json={"api_key": "sk-abcdefghijklmnop"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["provider"] == "openai"
    assert body["base_url"] == "https://api.openai.com/v1"
    assert "gpt-4o" in body["models"]
    # 认出来就返回：tried 是**真的试过**的那几家（可能只有它自己）
    assert any(t["provider"] == "openai" and t["ok"] for t in body["tried"])


async def test_detect_failure_is_human_and_skips_raw_text(client, monkeypatch):
    async def all_bad(provider, api_key, base_url, model_name):
        return False, [], "密钥无效（HTTP 401）：Incorrect API key provided", 20

    monkeypatch.setattr(cred_api, "_probe", all_bad)
    r = await client.post("/api/credentials/detect", json={"api_key": "sk-abcdefghijklmnop"})
    body = r.json()
    assert body["ok"] is False
    assert body["provider"] == ""
    assert "没通过" in body["reason"] and "改选服务商" in body["reason"]
    # 后端原文只留在 tried 里（排查用），给用户的那句话不许出现
    assert "Incorrect API key" not in body["reason"]


async def test_detect_respects_explicit_provider(client, monkeypatch):
    calls: list[str] = []

    async def probe(provider, api_key, base_url, model_name):
        calls.append(provider)
        return (provider == "moonshot"), ([] if provider != "moonshot" else ["kimi-k2"]), None, 30

    monkeypatch.setattr(cred_api, "_probe", probe)
    r = await client.post(
        "/api/credentials/detect", json={"api_key": "sk-abcdefghijklmnop", "provider": "moonshot"}
    )
    body = r.json()
    assert body["ok"] is True and body["provider"] == "moonshot"
    assert calls == ["moonshot"], "指定了服务商就只该试这一家"


async def test_detect_rejects_too_short_key(client):
    r = await client.post("/api/credentials/detect", json={"api_key": "sk-1"})
    body = r.json()
    assert body["ok"] is False and "粘贴完整" in body["reason"]


async def test_detect_anthropic_uses_its_own_auth_and_v1_base(client, monkeypatch):
    """Claude 的 Key 用 Bearer 打过去必然 401 —— 会被判成「密钥无效」。

    这里守两件事：探测时走 ``/v1``，且返回给前端入库的 base_url 也是 ``/v1``
    （否则存下来的凭据以后一样连不上）。
    """
    seen: dict[str, str] = {}

    async def probe(provider, api_key, base_url, model_name):
        seen[provider] = base_url or ""
        return (provider == "anthropic"), (["claude-sonnet-4-5"] if provider == "anthropic" else []), None, 90

    monkeypatch.setattr(cred_api, "_probe", probe)
    r = await client.post("/api/credentials/detect", json={"api_key": "sk-ant-abcdefghijklmnop"})
    body = r.json()
    assert body["ok"] is True and body["provider"] == "anthropic"
    assert seen["anthropic"] == "https://api.anthropic.com/v1"
    assert body["base_url"] == "https://api.anthropic.com/v1"


async def test_probe_anthropic_sends_x_api_key(monkeypatch):
    """真探针那一层：Anthropic 用 ``x-api-key`` + ``anthropic-version``，不是 Bearer。"""
    captured: dict[str, Any] = {}

    class _Resp:
        status_code = 200

        def json(self):
            return {"data": [{"id": "claude-sonnet-4-5"}]}

    class _Client:
        def __init__(self, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, headers=None):
            captured["url"] = url
            captured["headers"] = headers or {}
            return _Resp()

    monkeypatch.setattr(cred_api.httpx, "AsyncClient", _Client)
    ok, models, err, _lat = await cred_api._probe(
        "anthropic", "sk-ant-abcdefghij", "https://api.anthropic.com", None
    )
    assert ok is True and not err
    assert captured["url"] == "https://api.anthropic.com/v1/models"
    assert captured["headers"]["x-api-key"] == "sk-ant-abcdefghij"
    assert "Authorization" not in captured["headers"]
    assert models == ["claude-sonnet-4-5"]


async def test_detect_unverifiable_provider_does_not_probe(client, monkeypatch):
    """Gemini（没有默认端点）/ Ollama（不需要 Key）：别拿探针去冤枉它。

    给回「这家验证不了 + 推荐模型清单」，前端据此允许保存但说明没验证过。
    """
    calls: list[str] = []

    async def probe(provider, api_key, base_url, model_name):
        calls.append(provider)
        return False, [], "不该被调用", None

    monkeypatch.setattr(cred_api, "_probe", probe)

    r = await client.post(
        "/api/credentials/detect", json={"api_key": "AIzaabcdefghijklmn", "provider": "gemini"}
    )
    body = r.json()
    assert body["ok"] is False and body["provider"] == "gemini"
    assert "没有可自动验证的接口" in body["reason"]
    assert "gemini-2.5-pro" in body["suggested"]

    r = await client.post("/api/credentials/detect", json={"api_key": "", "provider": "ollama"})
    body = r.json()
    assert body["ok"] is False and "不需要 API Key" in body["reason"]
    assert calls == [], "验证不了的服务商不该发探测请求"
