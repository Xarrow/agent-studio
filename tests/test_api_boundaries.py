"""QA 回归：接口边界与老数据容忍度。

这一组都来自实测打出来的问题，不是猜的：
1. /api/runs?limit=200 → 500（224 条历史 run 的 input 被存成了**字符串**，
   Pydantic 要 dict，一条脏行把整页列表干掉；前端一旦翻页就白屏）
2. /api/sessions?limit=-5 → 把整库端出去（SQLite 把负 LIMIT 当不限量）
3. /api/sessions?offset=99999 → 还是第一页（offset 根本没接，静默丢弃）
4. /api/sessions/{不存在}/jobs → 200（会话不存在却给了一份空清单）
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

from agent_studio.db import SessionLocal
from agent_studio.models import Agent


def _agent_payload(name: str) -> dict:
    return {
        "name": name,
        "definition": {
            "runtime": "agentscope",
            "name": name,
            "system_prompt": "你是测试助手。",
            "model": {"provider": "deepseek", "name": "deepseek-v4-flash"},
            "tools": [],
            "skills": [],
            "limits": {"max_iters": 5, "timeout_s": 30},
        },
    }


async def _mk_agent(ac) -> str:
    import uuid

    r = await ac.post("/api/agents", json=_agent_payload(f"QA 边界 {uuid.uuid4().hex[:6]}"))
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def test_旧run的input是字符串也不会把列表打成500(client):
    """老数据 double-encoded（库里是 JSON 字符串）时，列表接口必须还能用。"""
    aid = await _mk_agent(client)
    async with SessionLocal() as db:
        await db.execute(
            text(
                "insert into run (id, agent_id, agent_version, runtime, status, input,"
                " output, usage, definition_snapshot, started_at, ended_at)"
                ' values (:id, :aid, 1, "agentscope", "ok", :inp, null, "{}", "{}", 1, 2)'
            ),
            {"id": "run_legacy0001", "aid": aid, "inp": '{"text": "老数据"}'},
        )
        await db.commit()

    r = await client.get("/api/runs?limit=200")
    assert r.status_code == 200, r.text
    row = next(x for x in r.json() if x["id"] == "run_legacy0001")
    assert row["input"] == {"text": "老数据"}


async def test_分页_limit_负数要拒_不能把整库端出去(client):
    r = await client.get("/api/sessions?limit=-5")
    assert r.status_code == 422, r.text


async def test_分页_offset_真的生效(client):
    aid = await _mk_agent(client)
    for i in range(3):
        await client.post("/api/sessions", json={"agent_id": aid, "title": f"会话{i}"})

    page1 = (await client.get(f"/api/sessions?agent_id={aid}&limit=2&offset=0")).json()
    page2 = (await client.get(f"/api/sessions?agent_id={aid}&limit=2&offset=2")).json()
    assert len(page1) == 2
    assert len(page2) == 1
    assert {s["id"] for s in page1}.isdisjoint({s["id"] for s in page2})

    far = (await client.get(f"/api/sessions?agent_id={aid}&offset=99")).json()
    assert far == []


async def test_不存在的会话查定时任务要404(client):
    r = await client.get("/api/sessions/ses_nope/jobs")
    assert r.status_code == 404, r.text


async def test_RunRead_兼容字符串形态的字段():
    """单独钉住 schema：字符串 input/usage 解一层，坏字符串退化成空 dict。"""
    from agent_studio.schemas import RunRead

    base = {
        "id": "run_x",
        "agent_id": "ag_x",
        "agent_version": 1,
        "runtime": "agentscope",
        "status": "ok",
        "started_at": 1,
        "ended_at": 2,
        "error": None,
    }
    ok = RunRead(**{**base, "input": '{"text":"hi"}', "output": None, "usage": "{}"})
    assert ok.input == {"text": "hi"}
    assert ok.usage == {}

    broken = RunRead(**{**base, "input": "not json", "output": None, "usage": {}})
    assert broken.input == {}

    plain = RunRead(**{**base, "input": {"text": "hi"}, "output": None, "usage": {}})
    assert plain.input == {"text": "hi"}


async def test_管理页tab数字等于列表行数(client):
    """tab 上写"Agent 40"就必须真有 40 行。

    真机实测过 tab 写 35、列表 40 行：没挂会话的 chat run 会自己占一行，
    但计数只数 distinct session_id 把它们漏了。
    """
    from collections import Counter

    aid = await _mk_agent(client)
    async with SessionLocal() as db:
        await db.execute(
            text(
                "insert into run (id, agent_id, agent_version, runtime, status, input,"
                " output, usage, definition_snapshot, started_at, ended_at)"
                ' values ("run_orphan0001", :aid, 1, "agentscope", "ok", "{}", null, "{}", "{}", 5, 6)'
            ),
            {"aid": aid},
        )
        await db.commit()

    d = (await client.get("/api/runs/timeline?limit=200")).json()
    rows = Counter(i["kind"] for i in d["items"])
    for kind, n in d["counts"].items():
        assert n == rows.get(kind, 0), (kind, n, rows)
    assert sum(d["counts"].values()) == d["total"] == len(d["items"])


@pytest.mark.parametrize("bad", ["-1", "0", "201"])
async def test_会话列表_limit_越界统一422(client, bad):
    r = await client.get(f"/api/sessions?limit={bad}")
    assert r.status_code == 422, r.text
