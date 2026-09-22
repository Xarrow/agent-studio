"""编排（Playground）路由：多助手协作的发起、观测与中止。

与 ``/api/runs`` 的关系
-----------------------
编排下的每个步骤都是一条普通的 Run，所以"看某一步的细节"直接用
``GET /api/runs/{run_id}`` + ``GET /api/runs/events/{run_id}`` —— 这里不重复造。

本模块只提供"编排视角"：
- 发起一次编排（内含哪些助手、怎么跑）
- 看编排整体的状态与最终结果
- 订阅编排的实时流（聚合所有子步骤的事件）
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import SessionLocal, get_session
from ..models import Agent, Orchestration, Run, RunEvent, now_ms
from ..orchestrator import orchestrator
from ..schemas import (
    OrchestrationCreate,
    OrchestrationDetail,
    OrchestrationRead,
    OrchestrationStepRead,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/orchestrations", tags=["orchestrations"])

#: 编排的终态（到了这些状态，SSE 就可以收尾了）
ORC_TERMINAL = ("ok", "partial", "error", "aborted")

#: 每种模式的默认显示名（用户没起名时用）
MODE_LABEL = {
    "single": "单个助手",
    "serial": "串行协作",
    "parallel": "并行协作",
    "master_worker": "主从协作",
}

MAX_LIST = 200


# --------------------------------------------------------------------------- #
# 组装
# --------------------------------------------------------------------------- #
def _agent_name(run: Run) -> str:
    snap = run.definition_snapshot or {}
    return str(snap.get("name") or run.agent_id)


def _step_read(run: Run) -> OrchestrationStepRead:
    inp = run.input or {}
    raw_in = inp.get("text") if isinstance(inp, dict) else None
    out = run.output or {}
    raw_out = out.get("content") if isinstance(out, dict) else None
    return OrchestrationStepRead(
        run_id=run.id,
        agent_id=run.agent_id,
        agent_name=_agent_name(run),
        role=run.orch_role,
        order_index=run.order_index,
        status=run.status,
        usage=run.usage or {},
        error=run.error,
        started_at=run.started_at,
        ended_at=run.ended_at,
        input_text=str(raw_in or ""),
        output_text=str(raw_out or ""),
    )


def _to_read(orc: Orchestration, step_count: int = 0) -> OrchestrationRead:
    return OrchestrationRead(
        id=orc.id,
        name=orc.name or MODE_LABEL.get(orc.mode, orc.mode),
        mode=orc.mode,
        worker_mode=orc.worker_mode,
        status=orc.status,
        input=orc.input or {},
        output=orc.output,
        usage=orc.usage or {},
        error=orc.error,
        started_at=orc.started_at,
        ended_at=orc.ended_at,
        step_count=step_count,
    )


async def _steps_of(session: AsyncSession, orc_id: str) -> list[Run]:
    rows = (
        await session.execute(
            select(Run)
            .where(Run.orchestration_id == orc_id)
            .order_by(Run.order_index.asc(), Run.started_at.asc())
        )
    ).scalars().all()
    return list(rows)


async def _get_or_404(session: AsyncSession, orc_id: str) -> Orchestration:
    orc = await session.get(Orchestration, orc_id)
    if orc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"编排不存在: {orc_id}")
    return orc


# --------------------------------------------------------------------------- #
# 发起
# --------------------------------------------------------------------------- #
@router.post("", response_model=OrchestrationRead, status_code=status.HTTP_201_CREATED)
async def create_orchestration(
    payload: OrchestrationCreate,
    session: AsyncSession = Depends(get_session),
) -> OrchestrationRead:
    """建一次编排并立刻开始跑（执行在后台，与 HTTP 生命周期解耦）。"""
    task = (payload.task or "").strip()
    if not task:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "任务描述不能为空")
    if not payload.steps:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "至少要选一个助手")

    # 校验助手都存在（避免跑到一半才发现名字写错）
    ids = [s.agent_id for s in payload.steps]
    if payload.master_agent_id:
        ids.append(payload.master_agent_id)
    found = (
        await session.execute(select(Agent.id).where(Agent.id.in_(ids)))
    ).scalars().all()
    missing = sorted(set(ids) - set(found))
    if missing:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"这些助手不存在: {', '.join(missing)}"
        )

    # 冻结整份编排定义：以后 Agent 改了也不影响这次记录的可复现性
    spec: dict[str, Any] = {
        "mode": payload.mode,
        "worker_mode": payload.worker_mode or ("parallel" if payload.mode == "master_worker" else None),
        "master_agent_id": payload.master_agent_id,
        "steps": [s.model_dump() for s in payload.steps],
        "task": task,
    }

    orc = Orchestration(
        name=(payload.name or "").strip() or MODE_LABEL.get(payload.mode, payload.mode),
        mode=payload.mode,
        worker_mode=spec["worker_mode"],
        spec=spec,
        input={"text": task},
        status="pending",
        started_at=now_ms(),
    )
    session.add(orc)
    await session.commit()
    await session.refresh(orc)

    # 后台执行（asyncio task —— 与 /api/runs 的做法一致）
    asyncio.create_task(orchestrator.run(orc.id, spec))

    return _to_read(orc, step_count=len(payload.steps))


# --------------------------------------------------------------------------- #
# 列表 / 详情
# --------------------------------------------------------------------------- #
@router.get("", response_model=list[OrchestrationRead])
async def list_orchestrations(
    limit: int = Query(50, ge=1, le=MAX_LIST),
    session: AsyncSession = Depends(get_session),
) -> list[OrchestrationRead]:
    rows = (
        await session.execute(
            select(Orchestration).order_by(desc(Orchestration.started_at)).limit(limit)
        )
    ).scalars().all()
    if not rows:
        return []

    # 一次性统计各编排的步骤数，避免 N+1 查询
    ids = [o.id for o in rows]
    counts: dict[str, int] = {}
    cnt_rows = (
        await session.execute(
            select(Run.orchestration_id).where(Run.orchestration_id.in_(ids))
        )
    ).scalars().all()
    for oid in cnt_rows:
        if oid:
            counts[oid] = counts.get(oid, 0) + 1

    return [_to_read(o, step_count=counts.get(o.id, 0)) for o in rows]


@router.get("/{orc_id}", response_model=OrchestrationDetail)
async def get_orchestration(
    orc_id: str,
    session: AsyncSession = Depends(get_session),
) -> OrchestrationDetail:
    orc = await _get_or_404(session, orc_id)
    steps = await _steps_of(session, orc_id)
    base = _to_read(orc, step_count=len(steps))
    return OrchestrationDetail(
        **base.model_dump(),
        spec=orc.spec or {},
        steps=[_step_read(r) for r in steps],
    )


# --------------------------------------------------------------------------- #
# 中止
# --------------------------------------------------------------------------- #
@router.post("/{orc_id}/abort")
async def abort_orchestration(
    orc_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """中止编排 —— 级联中止所有还在跑的子步骤。"""
    orc = await _get_or_404(session, orc_id)
    if orc.status in ORC_TERMINAL:
        return {"aborted": 0, "status": orc.status, "detail": "已经结束了"}

    from ..runner import run_service

    killed = 0
    for run in await _steps_of(session, orc_id):
        if run.status in ("pending", "running", "waiting_hitl"):
            if await run_service.abort(run.id):
                killed += 1

    orc.status = "aborted"
    orc.error = "用户中止"
    orc.ended_at = now_ms()
    await session.commit()
    return {"aborted": killed, "status": "aborted"}


# --------------------------------------------------------------------------- #
# 实时流：把「编排状态」和「所有子步骤的事件」聚合成一条 SSE
# --------------------------------------------------------------------------- #
@router.get("/stream/{orc_id}")
async def stream_orchestration(orc_id: str) -> StreamingResponse:
    """编排的实时流。

    和 ``/api/runs/stream/{run_id}`` 的区别：子步骤是**执行过程中动态创建**的，
    没法预先订阅它们的 EventBus，所以这里用轮询库里的事件表来转发
    （天然支持断线重连：重连后从已有 seq 续上，不丢不重）。

    推两类消息：
    - ``{"kind": "status", ...}``     编排状态快照（步骤状态变了就推一次）
    - ``{"kind": "event", ...}``      某个子步骤的一个事件（含 run_id，前端据此分栏显示）
    """

    async def gen():
        seen: dict[str, int] = {}      # run_id -> 已推送的最大 seq
        last_snapshot: str = ""

        while True:
            async with SessionLocal() as session:
                orc = await session.get(Orchestration, orc_id)
                if orc is None:
                    yield 'event: done\ndata: {"error":"not found"}\n\n'
                    return
                runs = await _steps_of(session, orc_id)

                # ① 状态快照（变了才推，避免刷屏）
                snapshot = {
                    "id": orc.id,
                    "status": orc.status,
                    "output": orc.output,
                    "error": orc.error,
                    "usage": orc.usage or {},
                    "ended_at": orc.ended_at,
                    "steps": [
                        {
                            "run_id": r.id,
                            "agent_id": r.agent_id,
                            "agent_name": _agent_name(r),
                            "role": r.orch_role,
                            "order_index": r.order_index,
                            "status": r.status,
                            "error": r.error,
                            "usage": r.usage or {},
                            "input_text": _step_read(r).input_text,
                            "output_text": _step_read(r).output_text,
                            "started_at": r.started_at,
                            "ended_at": r.ended_at,
                        }
                        for r in runs
                    ],
                }
                blob = json.dumps(snapshot, ensure_ascii=False, sort_keys=True)
                if blob != last_snapshot:
                    last_snapshot = blob
                    yield f"event: status\ndata: {json.dumps({'kind': 'status', **snapshot}, ensure_ascii=False)}\n\n"

                # ② 转发各子步骤的新事件
                for r in runs:
                    since = seen.get(r.id, -1)
                    events = (
                        await session.execute(
                            select(RunEvent)
                            .where(RunEvent.run_id == r.id, RunEvent.seq > since)
                            .order_by(RunEvent.seq.asc())
                        )
                    ).scalars().all()
                    for e in events:
                        seen[r.id] = e.seq
                        item = {
                            "kind": "event",
                            "run_id": r.id,
                            "seq": e.seq,
                            "type": e.type,
                            "ts": e.ts,
                            "payload": e.payload or {},
                        }
                        yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"

                if orc.status in ORC_TERMINAL:
                    yield "event: done\ndata: {}\n\n"
                    return

            await asyncio.sleep(0.5)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
