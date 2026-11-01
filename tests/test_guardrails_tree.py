"""护栏接口：每棵树最多花多少（新增一档）+ 三档都能回读。

界面就长在「用量」那一行里（点开就地展开三个下拉），所以接口必须能把
「当前值 + 可选档位」一次给全 —— 只给值不给档位，界面就得自己抄一份枚举，
迟早两边不一致。
"""

from __future__ import annotations

from agent_studio.quota import TREE_BUDGET_CHOICES


async def test_护栏里有树额度这一档(client):
    r = await client.get("/api/guardrails")
    assert r.status_code == 200
    data = r.json()
    assert set(data) >= {"daily", "depth", "tree"}
    assert data["tree"]["choices"] == list(TREE_BUDGET_CHOICES)
    assert isinstance(data["tree"]["limit"], int)


async def test_设树额度后立刻回读(client):
    r = await client.put("/api/guardrails/tree", json={"limit": 50_000})
    assert r.status_code == 200
    assert r.json()["tree"]["limit"] == 50_000

    again = (await client.get("/api/guardrails")).json()
    assert again["tree"]["limit"] == 50_000


async def test_树额度设0等于不限(client):
    r = await client.put("/api/guardrails/tree", json={"limit": 0})
    assert r.status_code == 200
    assert r.json()["tree"]["limit"] == 0
