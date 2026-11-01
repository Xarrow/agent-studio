"""多路由扇出：一句话值得几个人一起干 → 起一次 master_worker。

两层要一起测：
- router 什么时候算「多位都沾边」（判错了就是白花钱起一堆 run）
- from-route 把这几个人翻译成什么 spec（语义：worker 之间不连线、只有汇入汇总者
  那一步带产出）
"""

from __future__ import annotations

import uuid

from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Agent
from agent_studio.router import Candidate, route


def uniq(p: str) -> str:
    return f"{p}-{uuid.uuid4().hex[:8]}"


async def _agent(name: str, desc: str = "") -> str:
    async with SessionLocal() as s:
        a = Agent(
            slug=uniq("slug"),
            name=name,
            description=desc,
            runtime="agentscope",
            definition={"runtime": "agentscope", "name": name, "tools": [], "skills": []},
        )
        s.add(a)
        await s.commit()
        await s.refresh(a)
        return a.id


# ── router ────────────────────────────────────────────────────────────── #


def test_两位都沾边就算扇出候选():
    c = [
        Candidate("a", "周报助手", "整理周报"),
        Candidate("b", "复盘助手", "写复盘结论"),
        Candidate("c", "视频助手", "下载视频"),
    ]
    d = route("把这周的周报和复盘整理一下", candidates=c)
    names = [m["name"] for m in d.multi]
    assert d.agent_id == "a", "单选结论照旧给分最高的那位"
    assert names == ["周报助手", "复盘助手"], names
    assert "视频助手" not in names


def test_只有一位明显沾边就不扇出():
    c = [Candidate("a", "周报助手", "整理周报"), Candidate("b", "视频助手", "下载视频")]
    d = route("整理这周的周报", candidates=c)
    assert d.agent_id == "a"
    assert d.multi == [], "另一位完全不沾边，多派一路只是浪费钱"


def test_分差太大不扇出():
    # 周报沾 7 分，复盘只沾 3 分（够 HIGH_SCORE 但不到 6 成）—— 只给一位
    c = [
        Candidate("a", "周报助手", "整理周报、复盘结论"),
        Candidate("b", "复盘助手", ""),
    ]
    d = route("整理周报并写复盘", candidates=c)
    assert d.agent_id == "a"
    assert d.multi == [], d.multi


def test_都太低分时谁也不扇出():
    c = [Candidate("a", "甲", ""), Candidate("b", "乙", "")]
    d = route("随便说点什么", candidates=c)
    assert d.multi == []


# ── API ───────────────────────────────────────────────────────────────── #


async def test_扇出会建一份主从编排(client):
    await init_db()
    a = await _agent("汇总助手", "汇总")
    b = await _agent("干活甲", "写代码")
    c = await _agent("干活乙", "跑测试")

    r = await client.post(
        "/api/orchestrations/from-route",
        json={"input": "把这两个问题各答一遍", "agent_ids": [a, b, c], "master_agent_id": a},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["master_agent_id"] == a
    assert set(body["worker_ids"]) == {b, c}

    detail = (await client.get(f"/api/orchestrations/{body['orchestration_id']}")).json()
    spec = detail["spec"]
    assert spec["mode"] == "master_worker"
    assert spec["worker_mode"] == "parallel"
    assert [s["agent_id"] for s in spec["steps"]] == [b, c]
    # 语义：worker 之间不连线，谁都不接上一步的产出
    assert all(s["carry_prev"] is False for s in spec["steps"])
    assert spec["snapshot"]["hash"]


async def test_不填汇总者就用第一位(client):
    await init_db()
    a = await _agent("第一位", "")
    b = await _agent("第二位", "")
    body = (
        await client.post(
            "/api/orchestrations/from-route", json={"input": "一起看看", "agent_ids": [a, b]}
        )
    ).json()
    assert body["master_agent_id"] == a
    assert body["worker_ids"] == [b]


async def test_只有一位就不叫扇出(client):
    await init_db()
    a = await _agent("独苗", "")
    r = await client.post(
        "/api/orchestrations/from-route", json={"input": "干吧", "agent_ids": [a]}
    )
    assert r.status_code == 422


async def test_汇总者不在名单里要拦住(client):
    await init_db()
    a, b, c = await _agent("甲", ""), await _agent("乙", ""), await _agent("丙", "")
    r = await client.post(
        "/api/orchestrations/from-route",
        json={"input": "干吧", "agent_ids": [a, b], "master_agent_id": c},
    )
    assert r.status_code == 422


async def test_名单里有不存在的助手(client):
    await init_db()
    a = await _agent("甲", "")
    r = await client.post(
        "/api/orchestrations/from-route",
        json={"input": "干吧", "agent_ids": [a, "ag_ghost"]},
    )
    assert r.status_code == 404
