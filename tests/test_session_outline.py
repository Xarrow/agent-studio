"""会话目录 / 分级加载 / 条件请求 / 幂等键 —— 这一组是「打开会话」的契约。

为什么值得单独一层测试：这四条都是「看起来能用、其实悄悄退化」的类型 ——
目录少一轮、翻页少一页、304 拿错会话的 tag、幂等键没生效多建一个空会话，
界面上都不会报错，只有用户翻历史时才察觉。
"""

from __future__ import annotations

import pytest

from agent_studio.api.sessions import _digest_of


async def _mk_agent(client) -> str:
    import uuid

    name = f"目录测试助手-{uuid.uuid4().hex[:6]}"
    r = await client.post(
        "/api/agents",
        json={"name": name, "definition": {"runtime": "agentscope", "name": name}},
    )
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def _mk_session(client, agent_id: str, title: str = "目录测试") -> str:
    r = await client.post("/api/sessions", json={"agent_id": agent_id, "title": title})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def _seed_turns(session_id: str, turns: int, start: int = 1) -> None:
    """直接写库造 N 轮（user + assistant 各一条）—— 走 API 造太慢且要真跑模型。"""
    from agent_studio.db import SessionLocal
    from agent_studio.models import SessionMessage

    async with SessionLocal() as s:
        for i in range(start, start + turns):
            s.add(SessionMessage(session_id=session_id, turn_index=i, role="user", content=f"第 {i} 个问题", ts=1700000000000 + i))
            s.add(
                SessionMessage(
                    session_id=session_id, turn_index=i, role="assistant", content=f"答 {i}", ts=1700000000000 + i + 1
                )
            )
        await s.commit()


# --------------------------------------------------------------------------- #
# 摘要规则
# --------------------------------------------------------------------------- #
def test_摘要首行与长度():
    assert _digest_of("第一行\n第二行") == "第一行"
    long = "这" * 100
    d = _digest_of(long)
    assert len(d) == 40 and d.endswith("…")


def test_摘要把网址压成域名():
    d = _digest_of("看下 https://www.example.com/a/very/long/path?x=1 这个页面")
    assert "example.com" in d
    assert "/a/very/long" not in d


def test_摘要去掉_markdown_与附件噪音():
    d = _digest_of("## 帮我分析（附件：report.pdf）这段数据")
    assert "#" not in d
    assert "附件" not in d
    assert d.startswith("帮我分析")


def test_摘要首句优先():
    d = _digest_of("先看结论。后面还有一大堆解释说明。")
    assert d == "先看结论。"


def test_空提问给空摘要():
    assert _digest_of("") == ""
    assert _digest_of("   \n  ") == ""


# --------------------------------------------------------------------------- #
# 目录接口
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_目录一轮一条(client):
    aid = await _mk_agent(client)
    sid = await _mk_session(client, aid)
    await _seed_turns(sid, 3)

    r = await client.get(f"/api/sessions/{sid}/outline")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 3
    assert [it["seq"] for it in body["items"]] == [1, 2, 3]
    assert body["items"][0]["digest"] == "第 1 个问题"
    for it in body["items"]:
        assert set(it) >= {"turn_id", "seq", "digest", "status", "created_at", "step_count", "artifact_count", "run_id"}


@pytest.mark.asyncio
async def test_目录带_ETag_且二次请求回_304(client):
    aid = await _mk_agent(client)
    sid = await _mk_session(client, aid)
    await _seed_turns(sid, 2)

    first = await client.get(f"/api/sessions/{sid}/outline")
    assert first.status_code == 200
    etag = first.headers.get("etag")
    assert etag

    second = await client.get(f"/api/sessions/{sid}/outline", headers={"If-None-Match": etag})
    assert second.status_code == 304
    assert second.content == b""


@pytest.mark.asyncio
async def test_目录变了_ETag_就变(client):
    aid = await _mk_agent(client)
    sid = await _mk_session(client, aid)
    await _seed_turns(sid, 2)
    etag1 = (await client.get(f"/api/sessions/{sid}/outline")).headers["etag"]

    await _seed_turns(sid, 1, start=3)  # 只加第 3 轮（重复铺会造出重复 turn_index）
    r = await client.get(f"/api/sessions/{sid}/outline", headers={"If-None-Match": etag1})
    assert r.status_code == 200  # 不能错误地回 304
    assert r.json()["count"] == 3


# --------------------------------------------------------------------------- #
# 打开会话 / 翻页
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_打开会话只取最近N轮并给游标(client):
    aid = await _mk_agent(client)
    sid = await _mk_session(client, aid)
    await _seed_turns(sid, 12)

    r = await client.get(f"/api/sessions/{sid}?turns=5")
    assert r.status_code == 200
    body = r.json()
    assert body["before_turn"] == 7
    turns = sorted({m["turn_index"] for m in body["messages"]})
    assert turns == [8, 9, 10, 11, 12]


@pytest.mark.asyncio
async def test_open_聚合接口带目录与消息(client):
    aid = await _mk_agent(client)
    sid = await _mk_session(client, aid)
    await _seed_turns(sid, 6)

    r = await client.get(f"/api/sessions/{sid}/open?turns=3")
    assert r.status_code == 200
    body = r.json()
    assert body["session"]["id"] == sid
    assert len(body["outline"]) == 6  # 目录始终全量
    assert body["before_turn"] == 3
    assert sorted({m["turn_index"] for m in body["messages"]}) == [4, 5, 6]


@pytest.mark.asyncio
async def test_往前翻页与跳到某轮附近(client):
    aid = await _mk_agent(client)
    sid = await _mk_session(client, aid)
    await _seed_turns(sid, 10)

    before = (await client.get(f"/api/sessions/{sid}/turns?before=5&limit=5")).json()
    assert sorted({m["turn_index"] for m in before["messages"]}) == [1, 2, 3, 4]
    assert before["before_turn"] == 0 and before["has_more"] is False

    around = (await client.get(f"/api/sessions/{sid}/turns?around=5&limit=4")).json()
    got = sorted({m["turn_index"] for m in around["messages"]})
    assert 5 in got and min(got) <= 4 and max(got) >= 6


# --------------------------------------------------------------------------- #
# 幂等键
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_同一幂等键只建一个会话(client):
    aid = await _mk_agent(client)
    key = "test-idem-1"

    a = await client.post("/api/sessions", json={"agent_id": aid, "title": "幂等"}, headers={"Idempotency-Key": key})
    b = await client.post("/api/sessions", json={"agent_id": aid, "title": "幂等"}, headers={"Idempotency-Key": key})
    assert a.status_code == 201 and b.status_code == 201
    assert a.json()["id"] == b.json()["id"]
    assert b.headers.get("idempotent-replay") == "1"


@pytest.mark.asyncio
async def test_不同幂等键建不同会话(client):
    aid = await _mk_agent(client)
    a = await client.post("/api/sessions", json={"agent_id": aid}, headers={"Idempotency-Key": "k-1"})
    b = await client.post("/api/sessions", json={"agent_id": aid}, headers={"Idempotency-Key": "k-2"})
    assert a.json()["id"] != b.json()["id"]
