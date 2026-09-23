"""编排设计稿（Workflow）—— Playground 画布上的那张图。

一组接口：存 / 取 / 改 / 删 / **跑**。
「跑」不新建执行通道：它把图翻译成一份 orchestration spec，交给现成的编排器
（``/api/orchestrations/stream/{id}`` 那套观测能力原样复用）。
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Agent, Orchestration, Workflow, now_ms
from ..orchestrator.graph import (
    MODE_LABEL_CN,
    derive_mode,
    master_of,
    mode_hint,
    normalise,
    topo_layers,
)
from ..orchestrator.service import orchestrator
from ..schemas import (
    WorkflowCreate,
    WorkflowGraph,
    WorkflowRead,
    WorkflowRunRequest,
    WorkflowUpdate,
)

router = APIRouter(prefix="/api/workflows", tags=["workflows"])

#: 允许的执行方式（覆盖时校验，避免写进库才发现跑不起来）
VALID_MODES = {"single", "serial", "parallel", "master_worker", "dag"}


# --------------------------------------------------------------------------- #
# 图 → 执行 spec
# --------------------------------------------------------------------------- #
def graph_to_spec(graph: WorkflowGraph, mode: str, task: str) -> dict[str, Any]:
    """把画布上的图翻译成编排器认得的 spec。

    **优先用专有模式**：能判成 serial / master_worker 就别用 dag ——
    因为 master_worker 会真的让主控**拆任务并汇总**，语义比"分层跑一遍"丰富得多。
    只有当图确实表达不了（分叉后汇合）才落到 dag。
    """
    raw = graph.model_dump(by_alias=True)
    nodes, edges = normalise(raw)
    if not nodes:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "画布上至少要有一个助手")

    # 连线带"上下文共享 / 记忆"时，老四种模式表达不了 → 一律走通用分层执行器。
    # 判据在 graph.derive_mode 里（界面显示的就是它），这里只是再兜一次底。
    if mode != "dag" and derive_mode(raw) == "dag":
        mode = "dag"

    if mode == "dag":
        return {"mode": "dag", "nodes": nodes, "edges": edges, "task": task}

    by_nid = {n["nid"]: n for n in nodes}
    if mode == "single":
        return {
            "mode": "single",
            "steps": [{"agent_id": nodes[0]["agent_id"], "carry_prev": False}],
            "task": task,
        }

    if mode == "parallel":
        return {
            "mode": "parallel",
            "steps": [{"agent_id": n["agent_id"], "carry_prev": False} for n in nodes],
            "task": task,
        }

    if mode == "serial":
        order = [nid for layer in topo_layers(nodes, edges) for nid in layer]
        return {
            "mode": "serial",
            # 画布上的连线本身就是"要传下去"，所以第一步之后都带上一步产出
            "steps": [
                {"agent_id": by_nid[nid]["agent_id"], "carry_prev": i > 0}
                for i, nid in enumerate(order)
            ],
            "task": task,
        }

    # master_worker
    master_nid = master_of(raw)
    workers = [n for n in nodes if n["nid"] != master_nid]
    if not workers or master_nid not in by_nid:
        return {
            "mode": "single",
            "steps": [{"agent_id": nodes[0]["agent_id"], "carry_prev": False}],
            "task": task,
        }
    return {
        "mode": "master_worker",
        "worker_mode": "parallel",
        "master_agent_id": by_nid[master_nid]["agent_id"],
        "steps": [{"agent_id": n["agent_id"], "carry_prev": False} for n in workers],
        "task": task,
    }


# --------------------------------------------------------------------------- #
# 读写辅助
# --------------------------------------------------------------------------- #
async def _run_count(session: AsyncSession, wf_id: str) -> int:
    return (
        await session.execute(
            select(func.count()).select_from(Orchestration).where(Orchestration.workflow_id == wf_id)
        )
    ).scalar_one()


def _to_read(wf: Workflow, run_count: int = 0) -> WorkflowRead:
    graph = WorkflowGraph.model_validate(wf.graph or {})
    derived = derive_mode(wf.graph or {})
    override = (wf.mode_override or "").strip() or None
    effective = override if override in VALID_MODES else derived
    return WorkflowRead(
        id=wf.id,
        name=wf.name,
        description=wf.description or "",
        graph=graph,
        mode_override=override,
        derived_mode=derived,
        derived_hint=mode_hint(wf.graph or {}, derived),
        effective_mode=effective,
        node_count=len(graph.nodes),
        edge_count=len(graph.edges),
        updated_at=wf.updated_at or 0,
        created_at=wf.created_at or 0,
        run_count=run_count,
    )


async def _get_or_404(session: AsyncSession, wf_id: str) -> Workflow:
    wf = await session.get(Workflow, wf_id)
    if wf is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"编排不存在: {wf_id}")
    return wf


async def _assert_agents(session: AsyncSession, graph: WorkflowGraph) -> None:
    """校验图里的助手都还在 —— 否则跑到一半才发现名字写错。"""
    raw = graph.model_dump(by_alias=True)
    nodes, _ = normalise(raw)
    ids = [n["agent_id"] for n in nodes]
    if not ids:
        return
    found = (await session.execute(select(Agent.id).where(Agent.id.in_(ids)))).scalars().all()
    missing = sorted(set(ids) - set(found))
    if missing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"这些助手不存在: {', '.join(missing)}")


# --------------------------------------------------------------------------- #
# 列表 / 详情
# --------------------------------------------------------------------------- #
@router.get("", response_model=list[WorkflowRead])
async def list_workflows(
    limit: int = 50,
    session: AsyncSession = Depends(get_session),
) -> list[WorkflowRead]:
    """按最近改动排序 —— 改过的浮上来，比按创建时间更符合"接着上次干"。"""
    rows = (
        await session.execute(
            select(Workflow).order_by(Workflow.updated_at.desc()).limit(max(1, min(limit, 200)))
        )
    ).scalars().all()
    out: list[WorkflowRead] = []
    for wf in rows:
        out.append(_to_read(wf, await _run_count(session, wf.id)))
    return out


@router.get("/{wf_id}", response_model=WorkflowRead)
async def get_workflow(wf_id: str, session: AsyncSession = Depends(get_session)) -> WorkflowRead:
    wf = await _get_or_404(session, wf_id)
    return _to_read(wf, await _run_count(session, wf_id))


# --------------------------------------------------------------------------- #
# 存 / 改 / 删
# --------------------------------------------------------------------------- #
@router.post("", response_model=WorkflowRead, status_code=status.HTTP_201_CREATED)
async def create_workflow(
    payload: WorkflowCreate,
    session: AsyncSession = Depends(get_session),
) -> WorkflowRead:
    await _assert_agents(session, payload.graph)
    wf = Workflow(
        name=(payload.name or "").strip() or "未命名编排",
        description=payload.description or "",
        graph=payload.graph.model_dump(by_alias=True),
        mode_override=(payload.mode_override or "").strip() or None,
        updated_at=now_ms(),
        created_at=now_ms(),
    )
    session.add(wf)
    await session.commit()
    await session.refresh(wf)
    return _to_read(wf)


@router.put("/{wf_id}", response_model=WorkflowRead)
async def update_workflow(
    wf_id: str,
    payload: WorkflowUpdate,
    session: AsyncSession = Depends(get_session),
) -> WorkflowRead:
    """改名字 / 改图 / 改执行方式。

    全部字段都是可选的：**只名字会变就更名字**，不动图 —— 这样"重命名"就不会
    顺带把画布覆盖掉（那是两个独立的心智动作）。
    """
    wf = await _get_or_404(session, wf_id)
    if payload.graph is not None:
        await _assert_agents(session, payload.graph)
        wf.graph = payload.graph.model_dump(by_alias=True)
    if payload.name is not None:
        wf.name = (payload.name or "").strip() or wf.name
    if payload.description is not None:
        wf.description = payload.description
    if payload.mode_override is not None:
        # 传 "" = 恢复自动判断
        mode = payload.mode_override.strip()
        wf.mode_override = mode if mode in VALID_MODES else None
    wf.updated_at = now_ms()
    await session.commit()
    await session.refresh(wf)
    return _to_read(wf, await _run_count(session, wf_id))


@router.delete("/{wf_id}")
async def delete_workflow(wf_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """删设计稿。**不动**它跑出来的历史记录（那是执行事实，不该跟着消失）。"""
    wf = await _get_or_404(session, wf_id)
    await session.delete(wf)
    await session.commit()
    return {"deleted": 1, "id": wf_id}


# --------------------------------------------------------------------------- #
# 跑
# --------------------------------------------------------------------------- #
@router.post("/{wf_id}/run", response_model=dict)
async def run_workflow(
    wf_id: str,
    payload: WorkflowRunRequest,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """用这份设计稿发起一次执行。

    返回 ``orchestration_id``：前端拿它去订阅
    ``/api/orchestrations/stream/{id}``（观测、分色过程、断线回放全都复用现成的）。
    """
    wf = await _get_or_404(session, wf_id)
    task = (payload.task or "").strip()
    if not task:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "任务描述不能为空")

    graph = WorkflowGraph.model_validate(wf.graph or {})
    await _assert_agents(session, graph)

    # 用户覆盖优先，否则按拓扑自动判断（判据与界面显示的是同一套）
    mode = (wf.mode_override or "").strip() or derive_mode(wf.graph or {})
    if mode not in VALID_MODES:
        mode = "dag"
    spec = graph_to_spec(graph, mode, task)
    if payload.timeout_s:
        spec["timeout_s"] = payload.timeout_s

    orc = Orchestration(
        name=f"{wf.name} · {task[:24]}",
        workflow_id=wf.id,
        mode=spec["mode"],
        worker_mode=spec.get("worker_mode"),
        spec=spec,
        input={"text": task},
        status="pending",
        started_at=now_ms(),
    )
    session.add(orc)
    await session.commit()
    await session.refresh(orc)

    asyncio.create_task(orchestrator.run(orc.id, spec))

    steps = spec.get("steps") or spec.get("nodes") or []
    return {
        "orchestration_id": orc.id,
        "mode": spec["mode"],
        "mode_label": MODE_LABEL_CN.get(spec["mode"], spec["mode"]),
        "step_count": len(steps),
        "stream_url": f"/api/orchestrations/stream/{orc.id}",
    }


@router.get("/{wf_id}/runs", response_model=list[dict])
async def list_workflow_runs(
    wf_id: str,
    limit: int = 20,
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, Any]]:
    """这份设计稿跑过的记录（最近在前）。"""
    wf = await _get_or_404(session, wf_id)
    rows = (
        await session.execute(
            select(Orchestration)
            .where(Orchestration.workflow_id == wf.id)
            .order_by(Orchestration.started_at.desc())
            .limit(max(1, min(limit, 100)))
        )
    ).scalars().all()
    return [
        {
            "id": o.id,
            "mode": o.mode,
            "status": o.status,
            "task": (o.input or {}).get("text", ""),
            "started_at": o.started_at,
            "ended_at": o.ended_at,
            "step_count": len((o.spec or {}).get("steps") or (o.spec or {}).get("nodes") or []),
        }
        for o in rows
    ]
