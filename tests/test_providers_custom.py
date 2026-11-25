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
