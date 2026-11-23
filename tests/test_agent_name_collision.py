"""本地助手与 A2A 影子同名时，本地这个仍然能保存。

现场：本机「Hermes 对齐助手」和一条远端镜像 slug=a2a-ra_… 同名，
用户改任何一个字段都会被重名校验 409 挡住 —— 界面显示"没保存"，看起来像功能坏了。
"""

from __future__ import annotations

import uuid


async def _mk_agent(client, name: str, slug: str) -> dict:
    r = await client.post(
        "/api/agents",
        json={"name": name, "slug": slug, "definition": {"name": name}},
    )
    assert r.status_code in (200, 201), r.text
    return r.json()


async def test_改回原名时不被影子挡住(client):
    name = f"撞名测试-{uuid.uuid4().hex[:6]}"
    local = await _mk_agent(client, name, f"local-{uuid.uuid4().hex[:6]}")
    # 造一条同名的 a2a 影子
    shadow_name = f"{name}-影子"
    await _mk_agent(client, shadow_name, f"a2a-ra_{uuid.uuid4().hex[:12]}")

    # 本地助手改成别人的名字再改回来：改回来这一步不该被影子挡（这里影子名不同，
    # 测的是"没有影子挡路时流程通"）；真正要守的是下面的同名影子场景
    r = await client.put(
        f"/api/agents/{local['id']}",
        json={"name": shadow_name, "definition": {"name": shadow_name}},
    )
    # 与影子同名：允许（影子不算重名）
    assert r.status_code == 200, r.text

    # 改回自己的名字也允许
    r2 = await client.put(
        f"/api/agents/{local['id']}",
        json={"name": name, "definition": {"name": name}},
    )
    assert r2.status_code == 200, r2.text


async def test_两个本地助手仍然不能同名(client):
    a = f"本地A-{uuid.uuid4().hex[:6]}"
    b = f"本地B-{uuid.uuid4().hex[:6]}"
    await _mk_agent(client, a, f"a-{uuid.uuid4().hex[:6]}")
    other = await _mk_agent(client, b, f"b-{uuid.uuid4().hex[:6]}")
    r = await client.put(
        f"/api/agents/{other['id']}", json={"name": a, "definition": {"name": a}}
    )
    assert r.status_code == 409, r.text
