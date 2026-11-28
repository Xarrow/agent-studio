"""端点一致性：助手里写死的 Base URL 不能和凭据指向不同服务商。

现场（用户报告）：助手 provider=anthropic-compatible、模型名 deepseek-v4-flash、
凭据指向公司代理、而 definition.base_url 还留着 https://api.deepseek.com/v1。
运行期拿代理的 key 去打 DeepSeek → 401「your api key is invalid」，
可「测试连接」页是通的（那条路径只读凭据）—— 用户以为是 key 坏了。
"""

from __future__ import annotations

import pytest


async def _make_cred(client, base_url: str, name: str = "代理") -> str:
    r = await client.post(
        "/api/credentials",
        json={
            "name": name,
            "provider": "anthropic-compatible",
            "api_key": "sk-test-1234567890",
            "base_url": base_url,
            "default_model": "deepseek-chat",
        },
    )
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def _create_agent(client, cred_id: str, def_base_url: str):
    return await client.post(
        "/api/agents",
        json={
            "name": f"端点冲突-{abs(hash(def_base_url)) % 9999}",
            "definition": {
                "name": "端点冲突",
                "role": "worker",
                "system_prompt": "x",
                "model": {
                    "provider": "anthropic-compatible",
                    "name": "deepseek-chat",
                    "credential_ref": cred_id,
                    "base_url": def_base_url,
                },
                "runtime": "agentscope",
            },
        },
    )


@pytest.mark.asyncio
async def test_端点与凭据不同主机时拒绝保存(client):
    cid = await _make_cred(client, "https://llm-proxy.intra.example.com")
    r = await _create_agent(client, cid, "https://api.deepseek.com/v1")
    assert r.status_code == 400, r.text
    detail = r.json().get("detail", "")
    assert "不是同一个服务商" in detail
    assert "llm-proxy.intra.example.com" in detail


@pytest.mark.asyncio
async def test_同一主机允许保存(client):
    cid = await _make_cred(client, "https://api.deepseek.com/anthropic", name="同主机")
    r = await _create_agent(client, cid, "https://api.deepseek.com/v1")
    assert r.status_code in (200, 201), r.text


@pytest.mark.asyncio
async def test_助手不写base_url时跟随凭据(client):
    cid = await _make_cred(client, "https://api.example.com", name="无地址")
    r = await _create_agent(client, cid, "")
    assert r.status_code in (200, 201), r.text


def test_错误文本带端点与模型():
    from agent_studio.runner.recorder import _err_with_target

    exc = RuntimeError("AuthenticationError: your api key is invalid")
    msg = _err_with_target(exc, "anthropic-compatible", "deepseek-v4-flash", "https://api.deepseek.com/v1")
    assert "api key is invalid" in msg
    assert "base_url=https://api.deepseek.com/v1" in msg
    assert "model=deepseek-v4-flash" in msg
    assert "provider=anthropic-compatible" in msg
