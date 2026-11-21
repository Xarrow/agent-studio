"""端点解析的护栏：不能静默把请求打到 OpenAI。

真出过的事故：助手配的是 DeepSeek，报错却说「请求了 https://api.openai.com/v1」。
两处成因都已堵上：

① ``llm.chat_once`` 拿到空 base_url 时以前默默退回 api.openai.com —— 现在明确报错
② ``runner.service.resolve_credential`` 没有凭据时把 base_url 落成 provider 官方端点
   （DeepSeek → https://api.deepseek.com/v1），不再留空往下传
"""

from __future__ import annotations

import pytest

from agent_studio.llm import _chat_url


def test_空端点不再退回_openai():
    """以前空 base_url 会变成 https://api.openai.com/v1 —— 配置与报错对不上。"""
    with pytest.raises(ValueError):
        _chat_url("")


def test_正常拼接():
    assert _chat_url("https://api.deepseek.com/v1") == "https://api.deepseek.com/v1/chat/completions"
    assert _chat_url("https://api.deepseek.com/v1/") == "https://api.deepseek.com/v1/chat/completions"
    # 已经是完整端点就原样用（火山方舟 plan key 这类）
    assert (
        _chat_url("https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions")
        == "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions"
    )


@pytest.mark.asyncio
async def test_没有凭据时端点落到该_provider_的官方地址():
    """助手没绑凭据：key 为空是事实，但端点不能变成 OpenAI 的。"""
    from agent_studio.runner.service import resolve_credential
    from agent_studio.schemas import AgentDefinition

    d = AgentDefinition(name="t", model={"provider": "deepseek", "name": "deepseek-v4-flash"})
    key, base = await resolve_credential(d, None)
    assert key in (None, "")
    assert base and "deepseek.com" in base, base
