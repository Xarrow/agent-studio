"""评测：打分口径 + 批量跑 + 两版对比（全部确定性，不调真模型）。"""

from __future__ import annotations

import asyncio

from agent_studio.db import SessionLocal
from agent_studio.evals import compare, normalise_cases, score_case
from agent_studio.models import EvalRun
from agent_studio.runtimes import register_runtime
from agent_studio.runner import dispatcher

from test_spans import SpanRuntime

#: 桩运行时的产出固定是「好」—— 正好用来做"命中/未命中"的确定性断言
STUB_OUTPUT = "好"


def test_score_case_counts_hits_and_misses():
    """硬判据：命中率即得分，逐条给出命中情况（用户要看得出差在哪）。"""
    case = {"input": "x", "must_include": "甲|乙"}
    got = score_case(case, "甲在这里，乙也在")
    assert got["score"] == 100.0
    assert all(c["hit"] for c in got["checks"])

    half = score_case(case, "只有甲")
    assert half["score"] == 50.0
    assert [c["hit"] for c in half["checks"]] == [True, False]

    none = score_case(case, "完全不相关")
    assert none["score"] == 0.0, "写了判据但一条没中 = 0 分（不是 None）"


def test_score_case_without_criteria_gives_no_score():
    """没有判据**不给分** —— 默认 100 等于自欺，默认 0 等于冤枉。"""
    got = score_case({"input": "x"}, "随便什么产出")
    assert got["score"] is None
    assert "没写判据" in got["note"]


def test_normalise_cases_drops_empty_inputs():
    cases = normalise_cases(
        [{"input": "  甲  "}, {"input": ""}, {"input": None}, "不是字典", {"input": "乙"}]
    )
    assert [c["input"] for c in cases] == ["甲", "乙"]
    assert cases[0]["id"] == "c1" and cases[1]["id"] == "c2", "自动补 id，界面上要能对上"


async def _stub_agent(client) -> str:
    return (
        await client.post(
            "/api/agents",
            json={
                "name": "评测核验",
                "definition": {
                    "runtime": SpanRuntime.name,
                    "name": "评测核验",
                    "system_prompt": "p",
                    "model": {"provider": "deepseek", "name": "deepseek-v4-flash"},
                    "tools": [],
                    "skills": [],
                    "limits": {"max_iters": 1, "timeout_s": 30},
                },
            },
        )
    ).json()["id"]


async def _pump_until_done(client, eval_run_id: str, limit: int = 600) -> dict:
    """手动泵分发器直到这批用例都跑完，再手动收口（测试里不等 2 秒轮询）。"""
    for _ in range(limit):
        await dispatcher.tick()
        await asyncio.sleep(0.02)
        async with SessionLocal() as s:
            run = await s.get(EvalRun, eval_run_id)
            if run is None:
                break
            results = run.results or []
            pending = [x for x in results if x.get("status") == "pending"]
            if results and not pending:
                break
    return (await client.post(f"/api/evals/runs/{eval_run_id}/finish")).json()


async def test_suite_crud_and_run_scores_each_case(client):
    """端到端：建用例集 → 跑一次 → 每一例都落到一条真执行上 → 出分。"""
    register_runtime(SpanRuntime())
    agent_id = await _stub_agent(client)

    suite = (
        await client.post(
            "/api/evals/suites",
            json={
                "agent_id": agent_id,
                "name": "桩评测",
                "cases": [
                    {"input": "说个好字", "must_include": "好"},
                    {"input": "说个别的", "must_include": "不存在的东西"},
                ],
            },
        )
    ).json()
    assert suite["id"] and len(suite["cases"]) == 2

    run = (await client.post(f"/api/evals/suites/{suite['id']}/run", json={"label": "基线"})).json()
    assert run["status"] == "running" and run["label"] == "基线"

    done = await _pump_until_done(client, run["id"])
    assert done["status"] == "ok", done
    assert done["score"] == 50.0, f"一例 100 一例 0 → 平均 50：{done}"
    first, second = done["results"]
    assert first["score"] == 100.0 and first["checks"][0]["hit"] is True
    assert second["score"] == 0.0 and second["checks"][0]["hit"] is False
    assert STUB_OUTPUT in first["output"], "产出要留在结果里（用户能直接看）"

    # 每一例确实是一条**真执行**（挂在同名 usage 认领上）——这样并发闸/额度/成本全都复用
    async with SessionLocal() as s:
        from sqlalchemy import select

        from agent_studio.models import Run

        rows = list((await s.execute(select(Run).where(Run.agent_id == agent_id))).scalars())
    claimed = [
        r for r in rows if isinstance(r.usage, dict) and (r.usage or {}).get("eval_run_id") == run["id"]
    ]
    assert len(claimed) == 2, f"两例就该有两条执行：{len(claimed)}"
    assert {int((r.usage or {}).get("eval_case")) for r in claimed} == {0, 1}

    # 对比：同一套题再跑一次 → 逐例 Δ 与总分 Δ 都是 0（确定性桩，两次结果必然一致）
    run2 = (await client.post(f"/api/evals/suites/{suite['id']}/run", json={"label": "复跑"})).json()
    await _pump_until_done(client, run2["id"])
    cmp = (
        await client.get(f"/api/evals/compare?left={run['id']}&right={run2['id']}")
    ).json()
    assert cmp["total_delta"] == 0.0, cmp
    assert len(cmp["items"]) == 2
    assert all(x["delta"] == 0.0 for x in cmp["items"])


async def test_compare_refuses_different_suites(client):
    """不同用例集的两次评测**不能**逐例对比 —— 题不一样，比出来是假的。"""
    agent_id = await _stub_agent(client)
    a = (
        await client.post(
            "/api/evals/suites",
            json={"agent_id": agent_id, "name": "A", "cases": [{"input": "甲", "must_include": "好"}]},
        )
    ).json()
    b = (
        await client.post(
            "/api/evals/suites",
            json={"agent_id": agent_id, "name": "B", "cases": [{"input": "乙", "must_include": "好"}]},
        )
    ).json()
    ra = (await client.post(f"/api/evals/suites/{a['id']}/run", json={})).json()
    rb = (await client.post(f"/api/evals/suites/{b['id']}/run", json={})).json()
    resp = await client.get(f"/api/evals/compare?left={ra['id']}&right={rb['id']}")
    assert resp.status_code == 422, resp.text


async def test_suite_requires_at_least_one_case(client):
    agent_id = await _stub_agent(client)
    bad = await client.post(
        "/api/evals/suites", json={"agent_id": agent_id, "name": "空", "cases": []}
    )
    assert bad.status_code == 422


def test_compare_puts_regressions_first():
    """对比时**退步的例排前面** —— 用户真正要看的就是"哪几条被我改坏了"。"""

    class _R:
        def __init__(self, results, score):
            self.id, self.label, self.score, self.created_at, self.results = "x", "", score, 0, results
            self.suite_id = "s"

    left = _R(
        [
            {"index": 0, "input": "甲", "score": 100.0},
            {"index": 1, "input": "乙", "score": 50.0},
        ],
        75.0,
    )
    right = _R(
        [
            {"index": 0, "input": "甲", "score": 0.0},
            {"index": 1, "input": "乙", "score": 50.0},
        ],
        25.0,
    )
    got = compare(left, right)
    assert got["total_delta"] == -50.0
    assert got["items"][0]["delta"] == -100.0, "退步的排第一"
    assert got["items"][-1]["delta"] == 0.0
