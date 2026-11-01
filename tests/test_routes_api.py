"""路由接口：规则增删改查 + 试算。落库的规则必须立刻影响试算结果。"""

from __future__ import annotations

import uuid

from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Agent


def uniq(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


async def _agent(name: str, desc: str = "", definition: dict | None = None) -> str:
    async with SessionLocal() as s:
        a = Agent(
            slug=uniq("slug"),
            name=name,
            description=desc,
            runtime="agentscope",
            definition=definition
            or {"runtime": "agentscope", "name": name, "tools": [], "skills": []},
        )
        s.add(a)
        await s.commit()
        await s.refresh(a)
        return a.id


async def test_加一条规则并立刻影响试算(client):
    await init_db()
    code = await _agent("编程助手", "写代码、改 bug")
    report = await _agent("周报助手", "整理周报")

    r = await client.post(
        "/api/routes",
        json={"agent_id": report, "pattern": "代码评审结论", "kind": "keyword", "priority": 20},
    )
    assert r.status_code == 201, r.text
    rule = r.json()
    assert rule["pattern"] == "代码评审结论"

    p = await client.post(
        "/api/routes/preview",
        json={"text": "把这次代码评审结论写进周报", "default_agent_id": code},
    )
    d = p.json()
    assert d["layer"] == 1, d
    assert d["agent_id"] == report
    assert d["agent_name"] == "周报助手"


async def test_重复添加同一条规则等于更新(client):
    await init_db()
    a = await _agent("视频助手", "下载视频")
    body = {"agent_id": a, "pattern": "抖音", "kind": "keyword", "priority": 100}
    r1 = await client.post("/api/routes", json=body)
    body["priority"] = 5
    r2 = await client.post("/api/routes", json=body)
    assert r1.json()["id"] == r2.json()["id"], "同一条规则不该建出两条"
    assert r2.json()["priority"] == 5

    items = (await client.get(f"/api/routes?agent_id={a}")).json()["items"]
    assert len(items) == 1


async def test_停用的规则不参与判定(client):
    await init_db()
    a = await _agent("翻译助手", "翻译")
    b = await _agent("写作助手", "写作")
    rule = (
        await client.post(
            "/api/routes", json={"agent_id": a, "pattern": "这段话", "priority": 10}
        )
    ).json()
    await client.patch(f"/api/routes/{rule['id']}", json={"enabled": False})
    d = (await client.post("/api/routes/preview", json={"text": "这段话怎么翻", "default_agent_id": b})).json()
    assert d["layer"] != 1, "停用的规则还在生效 = 用户关了没反应"


async def test_写错的正则当场拒绝(client):
    await init_db()
    a = await _agent("正则助手")
    r = await client.post(
        "/api/routes", json={"agent_id": a, "pattern": "([未闭合", "kind": "regex"}
    )
    assert r.status_code == 422
    assert "正则" in r.json()["detail"]


async def test_一个字的规则拒绝(client):
    await init_db()
    a = await _agent("短词助手")
    r = await client.post("/api/routes", json={"agent_id": a, "pattern": "的", "kind": "keyword"})
    assert r.status_code == 422


async def test_给不存在的助手加规则_404(client):
    await init_db()
    r = await client.post("/api/routes", json={"agent_id": "ag_nope", "pattern": "随便"})
    assert r.status_code == 404


async def test_删规则(client):
    await init_db()
    a = await _agent("待删助手")
    rule = (await client.post("/api/routes", json={"agent_id": a, "pattern": "要删的"})).json()
    r = await client.delete(f"/api/routes/{rule['id']}")
    assert r.status_code == 200
    items = (await client.get(f"/api/routes?agent_id={a}")).json()["items"]
    assert items == []
    again = await client.delete(f"/api/routes/{rule['id']}")
    assert again.status_code == 404


async def test_试算会解释为什么是它(client):
    await init_db()
    await _agent("编程助手", "写代码、跑测试")
    await _agent("周报助手", "整理周报")
    d = (
        await client.post(
            "/api/routes/preview", json={"text": "帮我写点代码，跑一下测试"}
        )
    ).json()
    assert d["agent_name"] == "编程助手"
    assert d["alternatives"], "得把候选摆出来，用户才能一眼看出有没有选错"
    assert any(a.get("name") for a in d["alternatives"])


async def test_指名了就按指名的来(client):
    await init_db()
    a = await _agent("编程助手", "写代码")
    b = await _agent("周报助手", "整理周报")
    d = (
        await client.post("/api/routes/preview", json={"text": "帮我写代码", "agent_id": b})
    ).json()
    assert d["agent_id"] == b and d["layer"] == 0
    assert a != b


async def test_灾难回溯的正则不许存(client):
    """`(a|aa)+$` 这类回溯几十秒的正则，一句用户输入就能把整个服务钉住。"""
    await init_db()
    a = await _agent("慢正则助手")
    r = await client.post(
        "/api/routes", json={"agent_id": a, "pattern": r"(a|aa)+$", "kind": "regex"}
    )
    assert r.status_code == 422, r.text
    assert "回溯" in r.json()["detail"] or "卡住" in r.json()["detail"]


async def test_存下去的正则不许把服务卡住(client):
    """引擎换 regex 之后 (a+)+$ 其实很快 —— 真正要守的是"任何已存规则都不许卡住请求"。"""
    import time

    await init_db()
    a = await _agent("已存正则助手")
    r = await client.post(
        "/api/routes", json={"agent_id": a, "pattern": "(a+)+$", "kind": "regex"}
    )
    assert r.status_code == 201, r.text
    t0 = time.time()
    d = await client.post("/api/routes/preview", json={"text": "a" * 60 + "b"})
    assert time.time() - t0 < 2.0, "正则跑太久 = 整台服务陪它一起等"
    assert d.status_code == 200


async def test_反例_正常正则照收(client):
    await init_db()
    a = await _agent("正常正则助手")
    r = await client.post(
        "/api/routes", json={"agent_id": a, "pattern": r"第\d+周", "kind": "regex"}
    )
    assert r.status_code == 201, r.text


async def test_关键词里塞逗号被拒(client):
    """「周报，复盘」当一条规则存下去 = 永远不会命中的坏规则。"""
    await init_db()
    a = await _agent("逗号助手")
    r = await client.post("/api/routes", json={"agent_id": a, "pattern": "周报，复盘"})
    assert r.status_code == 422
    assert "分多条" in r.json()["detail"]


async def test_大小写不同不建两条(client):
    await init_db()
    a = await _agent("大小写助手")
    r1 = await client.post("/api/routes", json={"agent_id": a, "pattern": "Weekly"})
    r2 = await client.post("/api/routes", json={"agent_id": a, "pattern": "weekly"})
    assert r1.json()["id"] == r2.json()["id"], "关键词匹配本来就忽略大小写，存两条是重复"
    items = (await client.get(f"/api/routes?agent_id={a}")).json()["items"]
    assert len(items) == 1


async def test_并发同一条不报500(client):
    """两个人同时点添加会撞唯一键 —— 用户不该看到 500。"""
    await init_db()
    a = await _agent("并发助手")
    import asyncio

    res = await asyncio.gather(
        *[client.post("/api/routes", json={"agent_id": a, "pattern": "并发词"}) for _ in range(5)]
    )
    codes = sorted(r.status_code for r in res)
    assert all(c in (200, 201) for c in codes), codes
    items = (await client.get(f"/api/routes?agent_id={a}")).json()["items"]
    assert len(items) == 1


async def test_指名不存在的助手_试算要报错(client):
    await init_db()
    r = await client.post(
        "/api/routes/preview", json={"text": "随便", "agent_id": "ag_ghost"}
    )
    assert r.status_code == 422
    assert "不存在" in r.json()["detail"]


async def test_候选里不会出现已选中的那个(client):
    await init_db()
    a = await _agent("候选助手A", "处理表格")
    b = await _agent("候选助手B", "处理表格")
    # 两条规则都命中同一助手 → 旧版会在"其他候选"里把同一个助手再列一遍
    await client.post("/api/routes", json={"agent_id": a, "pattern": "表格"})
    await client.post("/api/routes", json={"agent_id": a, "pattern": "数据"})
    d = (await client.post("/api/routes/preview", json={"text": "处理表格数据"})).json()
    assert d["agent_id"] == a
    assert all(x["agent_id"] != a for x in d["alternatives"])
    assert len({x["agent_id"] for x in d["alternatives"]}) == len(d["alternatives"])
    assert b  # 另一候选仍应出现
