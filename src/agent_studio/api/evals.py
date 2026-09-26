"""评测：用例集 + 跑一次 + 结果 + 两版对比。

界面上的落点：**助手详情页**（评测是"这个助手"的事，控件归属其对象）——
不新开一级导航、不加 tab（用户明确不要的东西）。
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..evals import compare, finish_eval, normalise_cases, start_eval, wait_and_finish
from ..models import Agent, EvalRun, EvalSuite, now_ms

router = APIRouter(prefix="/api/evals", tags=["evals"])


class CaseIn(BaseModel):
    id: str | None = None
    input: str
    must_include: str = ""
    rubric: str = ""


class SuiteIn(BaseModel):
    agent_id: str
    name: str = Field(default="未命名用例集", max_length=120)
    cases: list[CaseIn] = []


class RunIn(BaseModel):
    """开一次评测。``label`` 是给这次起的名字（如"改提示词前"），对比时一眼认得出。"""

    label: str = Field(default="", max_length=60)


def _suite_read(row: EvalSuite) -> dict[str, Any]:
    return {
        "id": row.id,
        "agent_id": row.agent_id,
        "name": row.name,
        "cases": normalise_cases(row.cases),
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def _run_read(row: EvalRun, *, detail: bool = False) -> dict[str, Any]:
    out = {
        "id": row.id,
        "suite_id": row.suite_id,
        "agent_id": row.agent_id,
        "label": row.label,
        "status": row.status,
        "score": row.score,
        "created_at": row.created_at,
        "finished_at": row.finished_at,
        "case_count": len(row.results or []),
    }
    if detail:
        out["results"] = row.results or []
    return out


@router.get("/suites")
async def list_suites(
    agent_id: str | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, Any]]:
    stmt = select(EvalSuite).order_by(EvalSuite.updated_at.desc())
    if agent_id:
        stmt = stmt.where(EvalSuite.agent_id == agent_id)
    rows = list((await session.execute(stmt)).scalars())
    return [_suite_read(r) for r in rows]


@router.post("/suites", status_code=status.HTTP_201_CREATED)
async def create_suite(
    body: SuiteIn, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    agent = await session.get(Agent, body.agent_id)
    if agent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"找不到这个助手：{body.agent_id}")
    cases = normalise_cases([c.model_dump() for c in body.cases])
    if not cases:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "至少要有一条用例（输入不能为空）")
    row = EvalSuite(agent_id=body.agent_id, name=body.name.strip() or "未命名用例集", cases=cases)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _suite_read(row)


@router.put("/suites/{suite_id}")
async def update_suite(
    suite_id: str, body: SuiteIn, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    row = await session.get(EvalSuite, suite_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "找不到这个用例集")
    cases = normalise_cases([c.model_dump() for c in body.cases])
    if not cases:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "至少要有一条用例（输入不能为空）")
    row.name = body.name.strip() or row.name
    row.cases = cases
    row.updated_at = now_ms()
    await session.commit()
    await session.refresh(row)
    return _suite_read(row)


@router.delete("/suites/{suite_id}")
async def delete_suite(suite_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    row = await session.get(EvalSuite, suite_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "找不到这个用例集")
    await session.delete(row)  # 历史评测记录**保留**（那是证据，不该跟着用例集消失）
    await session.commit()
    return {"deleted": 1, "id": suite_id}


@router.post("/suites/{suite_id}/run", status_code=status.HTTP_201_CREATED)
async def run_suite(
    suite_id: str,
    body: RunIn = Body(default=RunIn()),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """开一次评测：每一条用例都会变成一次**真实执行**（算进用量与额度）。"""
    suite = await session.get(EvalSuite, suite_id)
    if suite is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "找不到这个用例集")
    agent = await session.get(Agent, suite.agent_id)
    if agent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "这个用例集挂的助手已经不在了")
    row = await start_eval(session, suite, label=body.label, agent=agent)
    # 后台等这批跑完再收口（失败只记日志：评测挂了不影响平台）
    asyncio.create_task(wait_and_finish(row.id))  # noqa: RUF006
    return _run_read(row, detail=True)


@router.get("/runs")
async def list_runs(
    suite_id: str | None = Query(default=None),
    agent_id: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, Any]]:
    stmt = select(EvalRun).order_by(EvalRun.created_at.desc()).limit(limit)
    if suite_id:
        stmt = stmt.where(EvalRun.suite_id == suite_id)
    if agent_id:
        stmt = stmt.where(EvalRun.agent_id == agent_id)
    rows = list((await session.execute(stmt)).scalars())
    return [_run_read(r) for r in rows]


@router.get("/runs/{eval_run_id}")
async def read_run(
    eval_run_id: str, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    row = await session.get(EvalRun, eval_run_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "找不到这次评测")
    return _run_read(row, detail=True)


@router.post("/runs/{eval_run_id}/finish")
async def finish_now(eval_run_id: str) -> dict[str, Any]:
    """手动收口（正常情况下后台会自己收；这条是给"看结果"按钮一个确定性入口）。"""
    row = await finish_eval(eval_run_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "找不到这次评测")
    return _run_read(row, detail=True)


@router.get("/compare")
async def compare_runs(
    left: str = Query(..., description="基准那次（例如「改之前」）"),
    right: str = Query(..., description="对比那次（例如「改之后」）"),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    a = await session.get(EvalRun, left)
    b = await session.get(EvalRun, right)
    if a is None or b is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "有一次评测找不到")
    if a.suite_id != b.suite_id:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "这两次不是同一个用例集，逐例对比没有意义"
        )
    return compare(a, b)
