"""花费上限：量够、算得清、拦得住。

三个验收点：
  1. ``run_cost`` 会按模型汇总 token、按单价算钱；没有单价的模型算不进钱，
     第二个返回值要诚实地说「不完整」。
  2. 预算看门狗发现花超了 → 打标记 + 取消执行任务（不是等它自己跑完）。
  3. 没有设置预算的助手完全不受影响（不能因为加了闸就多查库）。
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import delete

from agent_studio.db import SessionLocal, init_db
from agent_studio.models import LlmCall, ModelPrice, Run
from agent_studio.pricing import run_cost
from agent_studio.runner import service as runner_service


async def _seed_run(run_id: str = "run_budgettest0001") -> str:
    await init_db()
    async with SessionLocal() as db:
        await db.execute(delete(LlmCall).where(LlmCall.run_id == run_id))
        row = await db.get(Run, run_id)
        if row is None:
            db.add(Run(id=run_id, agent_id="ag_budget", status="running", started_at=1, origin="chat"))
        await db.commit()
    return run_id


async def _price(model: str, pin: float, pout: float) -> None:
    async with SessionLocal() as db:
        row = await db.get(ModelPrice, model)
        if row is None:
            db.add(ModelPrice(model=model, in_per_mtok=pin, out_per_mtok=pout))
        else:
            row.in_per_mtok, row.out_per_mtok = pin, pout
        await db.commit()


async def _add_call(run_id: str, model: str, tin: int, tout: int) -> None:
    async with SessionLocal() as db:
        db.add(
            LlmCall(
                run_id=run_id,
                iteration=0,
                provider="test",
                model=model,
                started_at=1,
                tokens_in=tin,
                tokens_out=tout,
            )
        )
        await db.commit()


async def test_按模型汇总算钱_没单价就说不完整():
    rid = await _seed_run("run_budgettest0002")
    await _price("priced-model", 10.0, 30.0)
    await _add_call(rid, "priced-model", 100_000, 10_000)
    async with SessionLocal() as db:
        cost, complete = await run_cost(db, rid)
    # 10 万输入 × 10/百万 + 1 万输出 × 30/百万 = 1.0 + 0.3
    assert complete is True
    assert cost == pytest.approx(1.3)

    # 名字里不能包含已定价的键（模糊匹配是「最长命中」）—— 用完全无关的名字
    await _add_call(rid, "mystery-llm", 50_000, 5_000)
    async with SessionLocal() as db:
        cost2, complete2 = await run_cost(db, rid)
    assert complete2 is False  # 有模型没单价 → 金额只是下界
    assert cost2 == pytest.approx(1.3)


async def test_没有调用记录时不报错():
    rid = await _seed_run("run_budgettest0003")
    async with SessionLocal() as db:
        cost, complete = await run_cost(db, rid)
    assert cost is None and complete is True


async def test_看门狗发现超预算就取消执行(monkeypatch):
    rid = await _seed_run("run_budgettest0004")
    await _price("priced-model", 100.0, 100.0)
    await _add_call(rid, "priced-model", 100_000, 0)  # 10.0

    monkeypatch.setattr(runner_service, "BUDGET_POLL_S", 0.05)

    class _FakeTask:
        def __init__(self):
            self.cancelled = False

        def cancel(self):
            self.cancelled = True

    fake = _FakeTask()
    # 传 None 的 asyncio.Task 类型标注只是提示；这里用鸭子类型的替身
    watcher = asyncio.create_task(runner_service.RunService._budget_watch(None, rid, 5.0, fake))  # type: ignore[arg-type]
    for _ in range(60):
        await asyncio.sleep(0.05)
        if fake.cancelled:
            break
    watcher.cancel()
    assert fake.cancelled is True
    assert rid in runner_service._BUDGET_HIT
    runner_service._BUDGET_HIT.discard(rid)


async def test_预算足够时不打扰(monkeypatch):
    rid = await _seed_run("run_budgettest0005")
    await _price("priced-model", 1.0, 1.0)
    await _add_call(rid, "priced-model", 1_000, 0)  # 0.001

    monkeypatch.setattr(runner_service, "BUDGET_POLL_S", 0.05)

    class _FakeTask:
        cancelled = False

        def cancel(self):
            self.cancelled = True

    fake = _FakeTask()
    watcher = asyncio.create_task(runner_service.RunService._budget_watch(None, rid, 100.0, fake))  # type: ignore[arg-type]
    await asyncio.sleep(0.3)
    watcher.cancel()
    assert fake.cancelled is False
    assert rid not in runner_service._BUDGET_HIT
