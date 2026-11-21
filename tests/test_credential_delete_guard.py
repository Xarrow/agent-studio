"""删凭据前必须检查引用：一把"钥匙"被 N 个助手用着，静默删掉等于一次全挂。

真出过的坑：删完没有任何提示，那几个助手下一轮报「provider=deepseek 需要 api_key」，
用户根本联想不到是刚才那次删除。
"""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_被助手引用的凭据删不掉(client):
    # 建凭据
    cred = (
        await client.post(
            "/api/credentials",
            json={
                "name": "待删凭据",
                "provider": "deepseek",
                "api_key": "sk-test-deadbeef",
                "base_url": "https://api.deepseek.com/v1",
                "default_model": "deepseek-flash",
            },
        )
    ).json()
    cid = cred["id"]

    # 建一个引用它的助手
    agent = (
        await client.post(
            "/api/agents",
            json={
                "name": "引用它的助手",
                "definition": {
                    "name": "引用它的助手",
                    "model": {"provider": "deepseek", "name": "deepseek-flash", "credential_ref": cid},
                },
            },
        )
    )
    assert agent.status_code in (200, 201), agent.text

    r = await client.delete(f"/api/credentials/{cid}")
    assert r.status_code == 409, r.text
    body = r.json()
    assert "引用它的助手" in str(body)

    # 换掉引用后可以删
    aid = agent.json()["id"]
    await client.put(
        f"/api/agents/{aid}",
        json={"definition": {"name": "引用它的助手", "model": {"provider": "deepseek", "name": "deepseek-flash"}}},
    )
    r2 = await client.delete(f"/api/credentials/{cid}")
    assert r2.status_code in (200, 204), r2.text
