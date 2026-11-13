"""端点解析的优先级：**凭据上的 base_url 说了算**。

现场：把助手的模型从 DeepSeek 换成 OpenRouter 的免费模型后，LLM 配置页「测试连接」
是通的（那条路径用凭据的端点），但一执行就 401：「你的 api key ****00e3 无效」。
原因是助手定义里还留着 https://api.deepseek.com/v1 —— 拿着 OpenRouter 的 key
去打 DeepSeek，报的却是 key 无效，几乎无法从错误信息反推。

一把 key 只可能属于签发它的那家，所以端点必须跟着凭据走；定义里的 base_url
只在两边同主机（或凭据没配端点）时才用。
"""

from __future__ import annotations

import pytest

from agent_studio.runner.service import resolve_credential


class _FakeSecret:
    def __init__(self, ciphertext: bytes, base_url: str | None):
        self.ciphertext = ciphertext
        self.base_url = base_url


class _FakeSession:
    def __init__(self, secret):
        self._secret = secret

    async def get(self, _model, _key):
        return self._secret


class _Defn:
    """只用到 definition.model.* 的几个字段，不必造完整 AgentDefinition。"""

    def __init__(self, provider, name, base_url, credential_ref):
        from agent_studio.schemas import ModelSpec

        self.model = ModelSpec(
            provider=provider, name=name, params={}, base_url=base_url, credential_ref=credential_ref
        )


@pytest.fixture
def fake_secret(monkeypatch):
    secret = _FakeSecret(b"cipher", "https://openrouter.ai/api/v1")
    monkeypatch.setattr("agent_studio.runner.service.decrypt", lambda _b: "sk-or-test")
    return secret


@pytest.mark.asyncio
async def test_凭据端点优先_即使定义里写了别家的端点(fake_secret):
    defn = _Defn("openai", "baidu/ernie-5.5-flash-preview:free", "https://api.deepseek.com/v1", "sec_x")
    key, base = await resolve_credential(defn, _FakeSession(fake_secret))
    assert key == "sk-or-test"
    assert base == "https://openrouter.ai/api/v1"


@pytest.mark.asyncio
async def test_同主机时保留定义里的路径(fake_secret):
    secret = _FakeSecret(b"cipher", "https://openrouter.ai/api/v1")
    defn = _Defn("openai", "m", "https://openrouter.ai/api/v1/extra", "sec_x")
    key, base = await resolve_credential(defn, _FakeSession(secret))
    assert key == "sk-or-test"
    assert base == "https://openrouter.ai/api/v1"


@pytest.mark.asyncio
async def test_凭据没配端点时用定义里的(fake_secret):
    secret = _FakeSecret(b"cipher", None)
    defn = _Defn("deepseek", "deepseek-flash", "https://api.deepseek.com/v1", "sec_x")
    key, base = await resolve_credential(defn, _FakeSession(secret))
    assert key == "sk-or-test"
    assert base == "https://api.deepseek.com/v1"


@pytest.mark.asyncio
async def test_定义里显式给了_api_key_就不看凭据():
    defn = _Defn("deepseek", "deepseek-flash", "https://api.deepseek.com/v1", None)
    defn.model.api_key = "sk-inline"
    key, base = await resolve_credential(defn, _FakeSession(None))
    assert key == "sk-inline"
    assert base == "https://api.deepseek.com/v1"
