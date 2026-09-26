"""每日额度护栏 + 分派层数：默认不变、开了真拦、拦了说得清。"""

from __future__ import annotations

import asyncio

import pytest

from agent_studio.db import SessionLocal
from agent_studio.models import now_ms
from agent_studio.quota import (
    daily_quota,
    get_daily_limit,
    get_depth_limit,
    human_tokens,
    set_daily_limit,
    set_depth_limit,
    today_used,
)


@pytest.fixture(autouse=True)
async def _db(client):
    """借 client 夹具把表建好（它内部会 init_db）；**每个用例结束都把护栏还原** ——
    这两个值是平台级状态，留脏会连累别的用例（实测踩到：深度被留在 2，
    「默认 1 层」那条就红了）。"""
    yield
    async with SessionLocal() as s:
        await set_daily_limit(s, 0)
        await set_depth_limit(s, 1)


def test_human_tokens_reads_like_a_person_wrote_it():
    assert human_tokens(0) == "0"
    assert human_tokens(9_999) == "9999"
    assert human_tokens(12_345) == "1.2万"
    assert human_tokens(1_050_000) == "105.0万"


async def test_defaults_are_off_and_one_layer():
    """默认必须是「不拦」和「1 层」—— 不能悄悄改变既有行为。

    判据取的是**键不存在时**的默认值（先把键删掉再读），与用例顺序无关。
    """
    from sqlalchemy import delete

    from agent_studio.models import AppSetting

    async with SessionLocal() as s:
        await s.execute(
            delete(AppSetting).where(
                AppSetting.key.in_(("daily_token_limit", "max_fanout_depth"))
            )
        )
        await s.commit()
        assert await get_daily_limit(s) == 0, "默认不设上限"
        assert await get_depth_limit(s) == 1, "默认只允许一层分派"


async def test_quota_counts_todays_tokens_only(client):
    """口径：只算**今天**的 token（输入+输出），昨天的不算。"""
    from agent_studio.models import Run

    now = now_ms()
    async with SessionLocal() as s:
        s.add(Run(id="run_today_a", agent_id="ag_x", status="ok", started_at=now,
                  usage={"tokens_in": 100, "tokens_out": 50}))
        s.add(Run(id="run_yesterday_a", agent_id="ag_x", status="ok",
                  started_at=now - 3 * 24 * 3600 * 1000,
                  usage={"tokens_in": 999_999, "tokens_out": 0}))
        await s.commit()
        used = await today_used(s)
    assert used >= 150, f"今天这 150 必须算进去：{used}"
    assert used < 999_999, f"昨天的巨额不能被算进今天：{used}"


async def test_limit_blocks_new_runs_with_a_clear_reason(client):
    """到顶之后：**新起的执行**被拦下并写明原因（在跑的不打断）。"""
    from agent_studio.models import Run
    from agent_studio.quota import check_daily_quota

    async with SessionLocal() as s:
        s.add(Run(id="run_big_today", agent_id="ag_x", status="ok",
                  started_at=now_ms(), usage={"tokens_in": 5000, "tokens_out": 0}))
        await s.commit()
        await set_daily_limit(s, 1000)  # 上限低于今天已用 → 立刻到顶
        q = await check_daily_quota(s)
    assert q["exceeded"] is True
    assert "今日额度已用完" in q["message"]
    assert "重置" in q["message"], "必须告诉用户什么时候能恢复"
    assert "调高" in q["message"], "必须告诉用户下一步怎么做"

    async with SessionLocal() as s:
        await set_daily_limit(s, 0)  # 收尾：恢复默认（不打扰后面的测试）
        assert (await daily_quota(s))["exceeded"] is False


async def test_execute_is_blocked_by_quota(client):
    """执行入口真的被拦：run 被标成失败、原因写清，且不产生任何事件。"""
    from agent_studio.models import Run
    from agent_studio.runtimes import register_runtime
    from agent_studio.runner import run_service

    from test_spans import SpanRuntime

    register_runtime(SpanRuntime())
    async with SessionLocal() as s:
        s.add(Run(id="run_eaten_today", agent_id="ag_x", status="ok",
                  started_at=now_ms(), usage={"tokens_in": 3000, "tokens_out": 0}))
        await s.commit()
        await set_daily_limit(s, 100)

    async with SessionLocal() as s:
        s.add(Run(id="run_should_be_blocked", agent_id="ag_x", status="pending",
                  input={"text": "随便跑点什么"}))
        await s.commit()

    from agent_studio.schemas import AgentDefinition

    definition = AgentDefinition.model_validate(
        {"runtime": SpanRuntime.name, "name": "x", "model": {"provider": "deepseek", "name": "deepseek-v4-flash"}}
    )
    await run_service.execute("run_should_be_blocked", definition, {"text": "随便跑点什么"})
    await asyncio.sleep(0.05)

    async with SessionLocal() as s:
        row = await s.get(Run, "run_should_be_blocked")
        assert row is not None
        assert row.status == "error", f"应当被拦成失败：{row.status}"
        assert "今日额度已用完" in (row.error or ""), row.error
        assert row.ended_at, "被拦下也算结束（要有结束时间，否则界面上一直显示在跑）"
        await set_daily_limit(s, 0)


async def test_depth_limit_is_readable_and_clamped(client):
    async with SessionLocal() as s:
        await set_depth_limit(s, 2)
        assert await get_depth_limit(s) == 2
        await set_depth_limit(s, 5)  # 越界 → 夹到 2
        assert await get_depth_limit(s) == 2
        await set_depth_limit(s, 1)
        assert await get_depth_limit(s) == 1


async def test_guardrails_api_roundtrip(client):
    """界面读到的档位与现状：只给枚举，不让手打。"""
    got = (await client.get("/api/guardrails")).json()
    assert got["daily"]["choices"] == [0, 10_000, 50_000, 200_000, 500_000, 1_000_000]
    assert got["depth"]["choices"] == [1, 2]
    upd = (await client.put("/api/guardrails/depth", json={"limit": 2})).json()
    assert upd["depth"]["limit"] == 2
    upd = (await client.put("/api/guardrails/daily", json={"limit": 50_000})).json()
    assert upd["daily"]["limit"] == 50_000
    assert upd["daily"]["exceeded"] is False
    # 收尾
    await client.put("/api/guardrails/daily", json={"limit": 0})
    await client.put("/api/guardrails/depth", json={"limit": 1})
