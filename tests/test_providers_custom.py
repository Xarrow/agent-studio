"""自定义协议端点：OpenAI 协议 / Anthropic 协议的任意 API。

用户口径：「LLM 配置为什么不知道 Anthropic 和 OpenAI 接口协议的其他 API 配置？」
—— 协议一致就该能接，不该只有内置那几家。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from agent_studio.providers import PROVIDERS
from agent_studio.runtimes.agentscope_rt.compile import (
    PROVIDER_CREDENTIALS,
    build_credential,
    build_model,
)


def test_两个通用协议都在_provider_列表里():
    assert "openai-compatible" in PROVIDERS
    assert "anthropic-compatible" in PROVIDERS
    for key in ("openai-compatible", "anthropic-compatible"):
        p = PROVIDERS[key]
        # 必须自己填 base_url：没有默认地址可猜
        assert p.default_base_url is None
        assert p.allows_base_url is True
        assert p.kind == "llm"
        assert p.requires_key is True


def test_映射到对应协议实现():
    assert PROVIDER_CREDENTIALS["openai-compatible"] == "OpenAICredential"
    assert PROVIDER_CREDENTIALS["anthropic-compatible"] == "AnthropicCredential"


def _spec(provider: str, base_url: str):
    return SimpleNamespace(provider=provider, name="some-model", base_url=base_url, params={})


def test_openai_协议_能构造凭据与模型():
    cred = build_credential(_spec("openai-compatible", "https://relay.example.com/v1"), "sk-x")
    assert cred is not None
    model = build_model(_spec("openai-compatible", "https://relay.example.com/v1"), "sk-x")
    assert "OpenAI" in type(model).__name__


def test_anthropic_协议_能构造凭据与模型():
    cred = build_credential(_spec("anthropic-compatible", "https://claude-relay.example.com"), "sk-ant-x")
    assert cred is not None
    model = build_model(_spec("anthropic-compatible", "https://claude-relay.example.com"), "sk-ant-x")
    assert "Anthropic" in type(model).__name__


def test_自定义端点会把_base_url_传下去():
    spec = _spec("openai-compatible", "https://my-gateway.local/v1")
    cred = build_credential(spec, "sk-x")
    dumped = cred.model_dump() if hasattr(cred, "model_dump") else {}
    assert any("my-gateway.local" in str(v) for v in dumped.values()), dumped


def test_没填_base_url_时报错而不是偷偷打默认地址():
    with pytest.raises(Exception):
        # OpenAI SDK 没有 base_url 会用 api.openai.com —— 对自建端点等于把 key 发错地方
        build_model(_spec("openai-compatible", ""), "sk-x")


def test_anthropic_的_base_url_去掉版本段():
    """Anthropic SDK 自己拼 /v1/messages：base_url 必须是域名根。

    用户从别处抄来的地址常带 /v1，原样传下去就是 /v1/v1/messages → 404，
    看着像"这个端点不支持"。
    """
    for raw in (
        "https://relay.example.com",
        "https://relay.example.com/",
        "https://relay.example.com/v1",
        "https://relay.example.com/v1/messages",
    ):
        m = build_model(_spec("anthropic-compatible", raw), "sk-ant-x")
        assert str(m.client.base_url).rstrip("/") == "https://relay.example.com", raw


def test_openai_的_base_url_原样保留():
    """OpenAI 兼容网关路径五花八门（/v1、/api/v3、/compatible-mode/v1），不许改。"""
    m = build_model(_spec("openai-compatible", "https://gw.example.com/api/v3"), "sk-x")
    assert "api/v3" in str(m.client.base_url)
