"""会话（多轮对话）+ 记忆（长期）测试。

重点覆盖四类风险：

1. **抽象完整性**：TurnContext 里不能出现任何框架对象（否则运行时无关就破了）
2. **多轮状态**：轮次递增、历史正确写入、超预算时从最旧开始丢弃
3. **记忆正确性**：scope 可见性、关键词命中优先、字符预算、命中计数
4. **护栏**：提炼解析容错、去重、自动沉淀强制进候选态、会话跨 Agent 隔离
"""

from __future__ import annotations

import uuid

import pytest

from agent_studio.memory.extract import Candidate, dedupe, parse_candidates
from agent_studio.memory.recall import keyword_score, recall, tokenize
from agent_studio.runtimes.base import TurnContext, TurnMessage


def uniq(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def agent_payload(name: str, **over) -> dict:
    payload = {
        "name": name,
        "definition": {
            "runtime": "agentscope",
            "name": name,
            "system_prompt": "你是一个测试助手。",
            "model": {"provider": "deepseek", "name": "deepseek-v4-flash"},
            "tools": [],
            "skills": [],
            "limits": {"max_iters": 10, "timeout_s": 60},
        },
    }
    payload.update(over)
    return payload


async def make_agent(client, name: str | None = None) -> str:
    r = await client.post("/api/agents", json=agent_payload(name or uniq("mem-agent")))
    assert r.status_code == 201, r.text
    return r.json()["id"]


# --------------------------------------------------------------------------- #
# 抽象完整性：运行时无关
# --------------------------------------------------------------------------- #
def test_turn_context_is_pure_data():
    """TurnContext 必须是纯数据容器 —— 这是"换运行时零改动"的前提。"""
    ctx = TurnContext(
        session_id="ses_x",
        turn_index=2,
        history=[TurnMessage(role="user", content="你好")],
        memory_text="## 已知信息\n- 用户在上海",
        memory_ids=["mem_a"],
    )
    dumped = ctx.model_dump()
    # 所有值都能被 JSON 序列化（没有框架对象混进来）
    import json

    json.dumps(dumped, ensure_ascii=False)

    assert dumped["history"][0] == {"role": "user", "content": "你好"}
    assert not ctx.is_empty()

    # 空上下文判定（无会话无记忆）
    assert TurnContext().is_empty()


def test_runtime_capabilities_declares_multi_turn():
    from agent_studio.runtimes import get_runtime

    caps = get_runtime("agentscope").capabilities()
    assert caps.supports_multi_turn is True
    assert caps.supports_memory is True


# --------------------------------------------------------------------------- #
# 分词与打分
# --------------------------------------------------------------------------- #
def test_tokenize_handles_chinese_and_english():
    tokens = tokenize("用户在上海用 DeepSeek")
    assert "deepseek" in tokens
    assert "上海" in tokens          # 中文 bigram
    assert "在" in tokens            # 单字也在


def test_keyword_score_ranks_relevant_higher():
    query = "用户在上海用什么模型"
    hit = keyword_score("用户在上海使用 DeepSeek 模型", query)
    miss = keyword_score("数据库连接池的最大连接数配置", query)
    assert hit > miss
    assert 0.0 <= hit <= 1.0


# --------------------------------------------------------------------------- #
# 会话：CRUD 与多轮状态
# --------------------------------------------------------------------------- #
async def test_session_crud_and_turn_index(client):
    aid = await make_agent(client)

    r = await client.post("/api/sessions", json={"agent_id": aid})
    assert r.status_code == 201, r.text
    sid = r.json()["id"]
    assert r.json()["agent_id"] == aid
    assert r.json()["turn_count"] == 0

    # 列表能查到
    r = await client.get(f"/api/sessions?agent_id={aid}")
    assert any(s["id"] == sid for s in r.json())

    # 改名
    r = await client.patch(f"/api/sessions/{sid}", json={"title": "改过的标题"})
    assert r.json()["title"] == "改过的标题"

    # 会话必须与 Agent 匹配（不能把 A 的上下文喂给 B）
    other = await make_agent(client)
    r = await client.post("/api/runs", json={"agent_id": other, "input": "hi", "session_id": sid})
    assert r.status_code == 409

    # 不存在的会话 → 404
    r = await client.post("/api/runs", json={"agent_id": aid, "input": "hi", "session_id": "ses_nope"})
    assert r.status_code == 404

    # 删除
    r = await client.delete(f"/api/sessions/{sid}")
    assert r.status_code == 200
    assert (await client.get(f"/api/sessions/{sid}")).status_code == 404


async def test_append_turn_and_history_budget(client):
    """历史写入 + 超预算时从最旧丢弃。"""
    from agent_studio.context import append_turn, load_history
    from agent_studio.db import SessionLocal
    from agent_studio.models import Session as ChatSession, new_id

    aid = await make_agent(client)
    sid = new_id("ses_")
    async with SessionLocal() as s:
        s.add(ChatSession(id=sid, agent_id=aid, title="t"))
        await s.commit()

    async with SessionLocal() as s:
        for i in range(1, 4):
            turn = await append_turn(
                s, session_id=sid, run_id=f"run_{i}", user_text=f"第{i}问", assistant_text=f"第{i}答"
            )
            assert turn == i  # 轮次严格递增

    async with SessionLocal() as s:
        hist = await load_history(s, sid)
        assert [m.content for m in hist] == ["第1问", "第1答", "第2问", "第2答", "第3问", "第3答"]

        # 预算极小：只保留最近的（从最旧开始丢）
        small = await load_history(s, sid, budget_chars=20)
        assert len(small) < len(hist)
        assert small[-1].content == "第3答"


async def test_clear_context_keeps_session(client):
    from agent_studio.context import append_turn, clear_context
    from agent_studio.db import SessionLocal
    from agent_studio.models import Session as ChatSession, new_id

    aid = await make_agent(client)
    sid = new_id("ses_")
    async with SessionLocal() as s:
        s.add(ChatSession(id=sid, agent_id=aid))
        await s.commit()
        await append_turn(s, session_id=sid, run_id="run_x", user_text="q", assistant_text="a")

    async with SessionLocal() as s:
        removed = await clear_context(s, sid)
        assert removed == 2
        assert (await s.get(ChatSession, sid)) is not None  # 会话本身保留


# --------------------------------------------------------------------------- #
# 记忆：CRUD / 策略 / 绑定
# --------------------------------------------------------------------------- #
async def test_memory_crud(client):
    aid = await make_agent(client)
    r = await client.post(
        "/api/memories",
        json={"content": "用户偏好中文回复", "agent_id": aid, "kind": "preference", "importance": 0.9},
    )
    assert r.status_code == 201, r.text
    mem = r.json()
    assert mem["status"] == "active"
    assert mem["scope"] == "agent"
    assert mem["hits"] == 0

    # 候选态
    r = await client.post(
        "/api/memories", json={"content": "候选条目", "agent_id": aid, "active": False}
    )
    assert r.json()["status"] == "candidate"

    # 更新：候选转正
    r = await client.patch(f"/api/memories/{r.json()['id']}", json={"status": "active"})
    assert r.json()["status"] == "active"

    # 非法：scope=agent 但没给 agent_id
    r = await client.post("/api/memories", json={"content": "x", "scope": "agent"})
    assert r.status_code == 400

    # 空内容拒绝
    r = await client.post("/api/memories", json={"content": "   ", "agent_id": aid})
    assert r.status_code == 400

    # 删除
    assert (await client.delete(f"/api/memories/{mem['id']}")).status_code == 200
    assert (await client.get(f"/api/memories/{mem['id']}")).status_code == 404


async def test_memory_policy_defaults_and_update(client):
    aid = await make_agent(client)

    r = await client.get(f"/api/agents/{aid}/memory-policy")
    assert r.status_code == 200
    p = r.json()
    # 安全默认：召回开、自动沉淀关（有成本，需显式开启）
    assert p["recall_enabled"] is True
    assert p["auto_extract"] is False
    assert p["recall_top_k"] == 5

    r = await client.patch(
        f"/api/agents/{aid}/memory-policy", json={"auto_extract": True, "recall_top_k": 8}
    )
    assert r.status_code == 200
    assert r.json()["auto_extract"] is True
    assert r.json()["recall_top_k"] == 8

    # 读回一致
    assert (await client.get(f"/api/agents/{aid}/memory-policy")).json()["recall_top_k"] == 8


async def test_agent_memory_binding(client):
    aid = await make_agent(client)
    other = await make_agent(client)

    m1 = (
        await client.post("/api/memories", json={"content": "记忆一", "agent_id": other, "scope": "global"})
    ).json()
    m2 = (await client.post("/api/memories", json={"content": "记忆二", "agent_id": other})).json()

    # 绑定 m1（global 本来就能看到）+ m2（跨 Agent 显式借用）+ 一个不存在的 id
    r = await client.put(f"/api/agents/{aid}/memories", json={"memory_ids": [m1["id"], m2["id"], "mem_nope"]})
    assert r.status_code == 200
    assert r.json()["bound"] == 2
    assert r.json()["ignored"] == 1

    rows = (await client.get(f"/api/agents/{aid}/memories")).json()
    ids = {x["id"] for x in rows}
    assert m1["id"] in ids and m2["id"] in ids


async def test_memory_stats(client):
    aid = await make_agent(client)
    await client.post("/api/memories", json={"content": "统计用条目", "agent_id": aid, "kind": "fact"})
    r = await client.get("/api/memories/stats")
    assert r.status_code == 200
    body = r.json()
    assert set(body) >= {"active", "candidate", "archived", "total_hits", "by_kind"}
    assert body["active"] >= 1


# --------------------------------------------------------------------------- #
# 召回
# --------------------------------------------------------------------------- #
async def test_recall_scope_visibility(client):
    """只有：本 Agent 的 ∪ 显式绑定的 ∪ global 的 —— 别的 Agent 的看不到。"""
    from agent_studio.db import SessionLocal

    aid = await make_agent(client)
    other = await make_agent(client)

    mine = (await client.post("/api/memories", json={"content": "我的私有事实", "agent_id": aid})).json()
    theirs = (await client.post("/api/memories", json={"content": "别人的私有事实", "agent_id": other})).json()
    glob = (await client.post("/api/memories", json={"content": "全局共享事实", "scope": "global", "agent_id": None})).json()

    async with SessionLocal() as s:
        res = await recall(s, aid, "事实", top_k=10, strategy="recent")
        ids = set(res.ids)
    assert mine["id"] in ids
    assert glob["id"] in ids
    assert theirs["id"] not in ids          # 隔离

    # 候选态不参与召回
    cand = (await client.post("/api/memories", json={"content": "候选不该召回", "agent_id": aid, "active": False})).json()
    async with SessionLocal() as s:
        assert cand["id"] not in set((await recall(s, aid, "候选", top_k=10)).ids)


async def test_recall_keyword_and_budget(client):
    from agent_studio.db import SessionLocal

    aid = await make_agent(client)
    await client.post("/api/memories", json={"content": "用户使用 DeepSeek 模型做推理", "agent_id": aid})
    await client.post("/api/memories", json={"content": "服务器磁盘 30% 占用", "agent_id": aid})

    async with SessionLocal() as s:
        res = await recall(s, aid, "用的是哪个模型", top_k=5, strategy="keyword")
        assert res.memories, "关键词召回应有结果"
        assert "DeepSeek" in res.memories[0].content   # 相关的排第一
        assert res.text and res.text.startswith("## 已知信息")

        # 预算极小时至多注入一条
        tight = await recall(s, aid, "模型", top_k=5, max_chars=10)
        assert len(tight.memories) <= 1


async def test_mark_hit_updates_counters(client):
    from agent_studio.db import SessionLocal
    from agent_studio.memory import mark_hit

    aid = await make_agent(client)
    mem = (await client.post("/api/memories", json={"content": "命中计数测试", "agent_id": aid})).json()
    assert mem["hits"] == 0

    async with SessionLocal() as s:
        await mark_hit(s, [mem["id"]])
        await s.commit()

    after = (await client.get(f"/api/memories/{mem['id']}")).json()
    assert after["hits"] == 1
    assert after["last_hit_at"] is not None


# --------------------------------------------------------------------------- #
# 提炼（护栏）
# --------------------------------------------------------------------------- #
def test_parse_candidates_tolerates_noise():
    # 带 markdown 代码块
    raw = '```json\n[{"kind": "fact", "content": "用户在上海"}]\n```'
    out = parse_candidates(raw)
    assert len(out) == 1 and out[0].content == "用户在上海"

    # 前后有解释性文字
    raw = '好的，提炼结果如下：\n[{"kind":"preference","content":"偏好中文"}]\n以上。'
    assert parse_candidates(raw)[0].kind == "preference"

    # 非法 JSON → 空（不炸）
    assert parse_candidates("这不是 JSON") == []
    # 空输出
    assert parse_candidates("") == []
    # 未知 kind → 归为 fact
    assert parse_candidates('[{"kind":"???","content":"x"}]')[0].kind == "fact"
    # 缺 content → 丢弃
    assert parse_candidates('[{"kind":"fact"}]') == []


def test_parse_candidates_caps_at_three():
    raw = "[" + ",".join(f'{{"kind":"fact","content":"条目{i}"}}' for i in range(10)) + "]"
    assert len(parse_candidates(raw)) == 3


def test_parse_candidates_truncates_long_content():
    long_text = "很长的内容" * 200
    out = parse_candidates(f'[{{"kind":"fact","content":"{long_text}"}}]')
    assert len(out[0].content) <= 400


async def test_dedupe_skips_similar(client):
    from agent_studio.db import SessionLocal

    aid = await make_agent(client)
    await client.post("/api/memories", json={"content": "用户在上海生活和工作", "agent_id": aid})

    async with SessionLocal() as s:
        kept, skipped = await dedupe(
            s,
            aid,
            [
                Candidate(kind="fact", content="用户在上海生活和工作"),   # 几乎一样 → 跳过
                Candidate(kind="fact", content="全新信息：项目使用 uv 管理依赖"),
            ],
        )
    assert len(kept) == 1
    assert "uv" in kept[0].content
    assert len(skipped) == 1


async def test_extract_manual_items_persist(client):
    """手动沉淀路径：给出 items → 落库并关联来源 Run。"""
    aid = await make_agent(client)
    r = await client.post("/api/runs", json={"agent_id": aid, "input": "测试输入"})
    run_id = r.json()["id"]

    r = await client.post(
        "/api/memories/extract",
        json={
            "run_id": run_id,
            "items": [{"content": "从执行中提炼的事实", "agent_id": aid, "kind": "fact"}],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 1

    # as_candidate=True → 落候选态（自动沉淀用）
    r = await client.post(
        "/api/memories/extract",
        json={"run_id": run_id, "items": [{"content": "候选事实", "agent_id": aid}], "as_candidate": True},
    )
    assert r.json()["created"] == 1
    rows = (await client.get(f"/api/memories?agent_id={aid}&status=candidate")).json()
    assert any(x["content"] == "候选事实" for x in rows)


async def test_extract_unknown_run_404(client):
    r = await client.post("/api/memories/extract", json={"run_id": "run_nope"})
    assert r.status_code == 404


async def test_bulk_status(client):
    aid = await make_agent(client)
    ids = [
        (await client.post("/api/memories", json={"content": f"候选{i}", "agent_id": aid, "active": False})).json()["id"]
        for i in range(3)
    ]
    r = await client.post("/api/memories/bulk-status", json={"ids": ids, "status": "active"})
    assert r.status_code == 200
    assert r.json()["updated"] == 3
    for mid in ids:
        assert (await client.get(f"/api/memories/{mid}")).json()["status"] == "active"
