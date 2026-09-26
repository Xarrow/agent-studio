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
from ..schemas import AutoRunIn
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
def _wait_of(node: dict[str, Any]) -> dict[str, Any]:
    """把**节点身份与等待上限**带进 spec 的那一步。

    · ``nid``：画布节点 id —— 执行记录靠它精确回贴到节点上。
      以前没有它，界面只能按「agent_id 相同 + 还没用过」的顺序猜，同一个助手出现在
      两个节点就会贴错；分派（一个节点多条执行）之后更是必然串味。
    · ``wait_timeout_s``：不填 = 不带，执行层用平台默认。
    """
    out: dict[str, Any] = {}
    nid = (node or {}).get("nid")
    if isinstance(nid, str) and nid:
        out["nid"] = nid
    v = (node or {}).get("wait_timeout_s")
    if isinstance(v, int) and not isinstance(v, bool):
        out["wait_timeout_s"] = v
    # 分派配置（按上游清单每项一路）—— 与 wait_timeout_s 同理，必须全链路带上
    fm = str((node or {}).get("fanout") or "").strip()
    if fm:
        out["fanout"] = fm
        fmax = (node or {}).get("fanout_max")
        if isinstance(fmax, int) and not isinstance(fmax, bool) and fmax > 0:
            out["fanout_max"] = fmax
        fagent = str((node or {}).get("fanout_agent") or "").strip()
        if fagent:
            out["fanout_agent"] = fagent
        fb = (node or {}).get("fanout_budget")
        if isinstance(fb, int) and not isinstance(fb, bool) and fb > 0:
            out["fanout_budget"] = fb
    return out


def _master_wait(node: dict[str, Any]) -> dict[str, Any]:
    """主控自己那两跳（拆任务 / 汇总）的等待上限 —— 同样是它自己节点上设的值。"""
    v = (node or {}).get("wait_timeout_s")
    return {"master_wait_timeout_s": v} if isinstance(v, int) and not isinstance(v, bool) else {}


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
            "steps": [{"agent_id": nodes[0]["agent_id"], "carry_prev": False, **_wait_of(nodes[0])}],
            "task": task,
        }

    if mode == "parallel":
        return {
            "mode": "parallel",
            "steps": [
                {"agent_id": n["agent_id"], "carry_prev": False, **_wait_of(n)}
                for n in nodes
            ],
            "task": task,
        }

    if mode == "serial":
        order = [nid for layer in topo_layers(nodes, edges) for nid in layer]
        return {
            "mode": "serial",
            # 画布上的连线本身就是"要传下去"，所以第一步之后都带上一步产出
            "steps": [
                {
                    "agent_id": by_nid[nid]["agent_id"],
                    "carry_prev": i > 0,
                    **_wait_of(by_nid[nid]),
                }
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
            "steps": [{"agent_id": nodes[0]["agent_id"], "carry_prev": False, **_wait_of(nodes[0])}],
            "task": task,
        }
    return {
        "mode": "master_worker",
        "worker_mode": "parallel",
        "master_agent_id": by_nid[master_nid]["agent_id"],
        # 主控自己的两跳（拆任务 / 汇总）等多久 —— 也让它自己那个节点说了算
        **_master_wait(by_nid[master_nid]),
        "steps": [
            {"agent_id": n["agent_id"], "carry_prev": False, **_wait_of(n)} for n in workers
        ],
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
    # 第一版快照（新流程也要有"起点"，回滚才有意义）
    from ..revisions import KIND_WORKFLOW, snapshot

    await snapshot(session, KIND_WORKFLOW, wf.id)
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
    # 快照（内容没变不记）：画布是自动保存的，所以"只在真变了才记"这道闸很关键
    from ..revisions import KIND_WORKFLOW, snapshot

    await snapshot(session, KIND_WORKFLOW, wf.id)
    await session.commit()
    await session.refresh(wf)
    return _to_read(wf, await _run_count(session, wf_id))


@router.delete("/{wf_id}")
async def delete_workflow(wf_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """删设计稿。**不动**它跑出来的历史记录（那是执行事实，不该跟着消失）。"""
    wf = await _get_or_404(session, wf_id)
    await session.delete(wf)
    # 版本历史跟着走（对象没了，快照就是孤儿行）
    from sqlalchemy import delete as _delete

    from ..models import Revision

    await session.execute(
        _delete(Revision).where(Revision.kind == "workflow", Revision.target_id == wf_id)
    )
    await session.commit()
    return {"deleted": 1, "id": wf_id}


# --------------------------------------------------------------------------- #
# 跑
# --------------------------------------------------------------------------- #

# --------------------------------------------------------------------------- #
# 自动运行（无人值守）：定时 + 外部触发
# --------------------------------------------------------------------------- #
def _new_token() -> str:
    """每条流程自己的触发凭证（外部系统拿它发起执行，等价于一把专属 key）。"""
    import secrets

    return secrets.token_hex(16)


def _auto_payload(wf: Workflow) -> dict[str, Any]:
    """自动运行的当前配置（界面直接用，不自己拼）。"""
    from ..scheduler import SCHEDULE_MODES, describe

    mode = (wf.schedule_mode or "").strip()
    problems: list[str] = []
    if mode in SCHEDULE_MODES and not (wf.default_task or "").strip():
        problems.append("没写「默认任务」—— 定时不会真的跑（它不知道该拿什么任务去跑）")
    if mode in SCHEDULE_MODES and not len(WorkflowGraph.model_validate(wf.graph or {}).nodes):
        problems.append("画布上还没有助手")
    return {
        "mode": mode if mode in SCHEDULE_MODES else "",
        "at": wf.schedule_at or "09:00",
        "weekdays": wf.schedule_weekdays or "",
        "default_task": wf.default_task or "",
        "describe": describe(wf.schedule_mode, wf.schedule_at, wf.schedule_weekdays),
        "next_run_at": wf.next_run_at,
        "last_run_at": wf.last_run_at,
        "last_run_source": wf.last_run_source or "",
        # 相对路径 —— 完整 URL 由前端按当前访问地址拼（内网/公网/tailnet 各不相同）
        "hook_path": f"/api/hooks/{wf.trigger_token}" if wf.trigger_token else "",
        "problems": problems,
    }


@router.get("/{wf_id}/auto", response_model=dict)
async def read_auto(wf_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """读自动运行配置。

    顺带做一件事：**没有触发凭证就生成一把并落库**（首次打开就能看到外部触发地址，
    不然用户得先"保存一次"才拿到 URL —— 那个多余的动作没有必要）。
    """
    wf = await _get_or_404(session, wf_id)
    if not wf.trigger_token:
        wf.trigger_token = _new_token()
        await session.commit()
        await session.refresh(wf)
    return _auto_payload(wf)


@router.put("/{wf_id}/auto", response_model=dict)
async def write_auto(
    wf_id: str, payload: AutoRunIn, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """存自动运行配置，并**立刻把下一次运行时间排好**（用户马上能看到"下次 09:00"）。"""
    from ..scheduler import SCHEDULE_MODES, compute_next

    wf = await _get_or_404(session, wf_id)
    mode = (payload.mode or "").strip().lower()
    if mode and mode not in SCHEDULE_MODES:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"不支持的定时方式：{payload.mode}（只能是 {'/'.join(SCHEDULE_MODES)} 或留空=不定时）",
        )
    if not wf.trigger_token:
        wf.trigger_token = _new_token()
    wf.schedule_mode = mode
    wf.schedule_at = (payload.at or "09:00").strip()[:5]
    wf.schedule_weekdays = (payload.weekdays or "").strip()[:16]
    wf.default_task = (payload.default_task or "").strip()
    wf.next_run_at = compute_next(mode, wf.schedule_at, wf.schedule_weekdays)
    wf.updated_at = now_ms()
    await session.commit()
    await session.refresh(wf)
    return _auto_payload(wf)


@router.post("/{wf_id}/auto/rotate", response_model=dict)
async def rotate_trigger_token(
    wf_id: str, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """换一把新的触发凭证（旧地址立即失效）—— 怀疑泄漏或不想让人再用时点它。"""
    wf = await _get_or_404(session, wf_id)
    wf.trigger_token = _new_token()
    await session.commit()
    await session.refresh(wf)
    return _auto_payload(wf)

@router.post("/{wf_id}/run-node", response_model=dict)
async def run_node(
    wf_id: str,
    nid: str,
    payload: WorkflowRunRequest,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """**只跑这一步** —— 单独执行流程里的某个节点（对齐 Dify 的单步运行）。

    刻意**不新建 workflow** ✗：单步试跑只是"看一眼这一步在这条任务下会怎么答"，
    为此往用户的流程列表里塞一条临时数据就是脏数据 ✗（用户对数据很在意）。
    所以这里只在内存里把图裁成"只含这一个节点"，其余（观测 / 回放 / 分页）全部复用现成通道 ✓
    """
    wf = await _get_or_404(session, wf_id)
    task = (payload.task or "").strip()
    if not task:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "任务描述不能为空")
    full = WorkflowGraph.model_validate(wf.graph or {})
    node = next((n for n in full.nodes if n.nid == nid), None)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "这一步不在流程里（可能已被删）")

    one = WorkflowGraph.model_validate({"nodes": [node.model_dump()], "edges": []})
    await _assert_agents(session, one)

    spec = graph_to_spec(one, "dag", task)
    if payload.timeout_s:
        spec["timeout_s"] = payload.timeout_s

    orc = Orchestration(
        name=f"{wf.name} · 只跑一步 · {task[:20]}",
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
    return {"orchestration_id": orc.id, "mode": spec["mode"], "nid": nid, "step_count": 1}


async def start_run_for_workflow(
    session: AsyncSession,
    wf: Workflow,
    task: str,
    *,
    timeout_s: int | None = None,
    origin: str = "playground",
    name_suffix: str = "",
) -> tuple[str, dict[str, Any]]:
    """**发起一次执行**（画布上的运行、定时、外部触发共用这一段）。

    为什么抽出来：三条入口做的事完全一样（图 → spec → 建编排 → 交给编排器），
    各写一遍的结果一定是"某天只改了两处，第三处悄悄不一样"。
    返回 ``(orchestration_id, spec)``，调用方按自己的需要组装响应。
    """
    task = (task or "").strip()
    if not task:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "任务描述不能为空")

    graph = WorkflowGraph.model_validate(wf.graph or {})
    await _assert_agents(session, graph)

    # 用户覆盖优先，否则按拓扑自动判断（判据与界面显示的是同一套）
    mode = (wf.mode_override or "").strip() or derive_mode(wf.graph or {})
    if mode not in VALID_MODES:
        mode = "dag"
    spec = graph_to_spec(graph, mode, task)
    if timeout_s:
        spec["timeout_s"] = timeout_s
    # 这次执行是**谁发起**的（playground / schedule / webhook）——
    # 记进 run.origin，运行记录里才分得清"我点的"和"它自己跑的"
    spec["origin"] = origin

    orc = Orchestration(
        name=f"{wf.name}{name_suffix} · {task[:24]}",
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
    return orc.id, spec


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
    orc_id, spec = await start_run_for_workflow(
        session, wf, payload.task or "", timeout_s=payload.timeout_s
    )
    task = (payload.task or "").strip()
    steps = spec.get("steps") or spec.get("nodes") or []
    return {
        "orchestration_id": orc_id,
        "mode": spec["mode"],
        "mode_label": MODE_LABEL_CN.get(spec["mode"], spec["mode"]),
        "step_count": len(steps),
        # 这里原来写的是 {orc.id}（未定义的名字）→ 每次跑流程都 500。
        # 正确值是上面那个 orc_id（start_run_for_workflow 的返回）。
        "stream_url": f"/api/orchestrations/stream/{orc_id}",
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
