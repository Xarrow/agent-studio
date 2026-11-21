"""生成参数与端点格式的保存期校验。

真出过的事故：temperature=5 保存成功（201），跑一轮直接
`AttributeError: 'dict' object has no attribute 'max_tokens'` —— 用户既看不懂，
也想不到是自己填的那个数字；base_url="not-a-url" 同样能存，错误拖到使用时才出现。
"""

from __future__ import annotations

import pytest


def _agent_body(**params):
    return {
        "name": f"qa-{abs(hash(str(params)))%99999}",
        "definition": {
            "name": "qa",
            "model": {"provider": "deepseek", "name": "deepseek-flash", "params": params},
        },
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "params",
    [
        {"temperature": 5},
        {"temperature": -1},
        {"temperature": "abc"},
        {"top_p": 1.5},
        {"max_tokens": 0},
        {"max_tokens": "many"},
    ],
)
async def test_越界参数保存直接拒绝(client, params):
    r = await client.post("/api/agents", json=_agent_body(**params))
    assert r.status_code == 422, r.text


@pytest.mark.asyncio
async def test_合法参数照常保存(client):
    r = await client.post(
        "/api/agents", json=_agent_body(temperature=0.7, top_p=0.9, max_tokens=1024)
    )
    assert r.status_code in (200, 201), r.text


@pytest.mark.asyncio
@pytest.mark.parametrize("url", ["not-a-url", "ftp://example.com", "https://"])
async def test_端点格式非法保存拒绝(client, url):
    r = await client.post(
        "/api/credentials",
        json={"name": f"qa-url-{abs(hash(url))%9999}", "provider": "openai", "api_key": "sk-x", "base_url": url},
    )
    assert r.status_code == 422, r.text


@pytest.mark.asyncio
async def test_端点留空表示用默认(client):
    r = await client.post(
        "/api/credentials",
        json={"name": "qa-empty-url", "provider": "openai", "api_key": "sk-x", "base_url": ""},
    )
    assert r.status_code in (200, 201), r.text
