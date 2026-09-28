"""记忆路由 —— 长期记忆的 CRUD、Agent 绑定、策略与提炼。

三条线在这里汇合：

1. **人工路径**：直接建/改记忆（``POST/PATCH /api/memories``）
2. **绑定路径**：Agent ↔ 记忆（``PUT /api/agents/{id}/memories``）
3. **自动路径**：从某次执行提炼（``POST /api/memories/extract``），
   默认落候选态，用户在候选区确认后转正

注意路由顺序：``/stats``、``/extract`` 这些静态路径必须声明在 ``/{memory_id}`` 之前，
否则会被参数路由吃掉。
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..memory import dedupe, get_policy, parse_candidates, to_read as policy_to_read, update_policy
from ..memory.extract import build_user_prompt, call_llm
from ..models import (
    Agent,
    AgentMemory,
    Memory,
    Run,
    Session as ChatSession,
    SessionMessage,
    now_ms,
)
from ..runner.service import resolve_api_key
from ..schemas import (
    AgentDefinition,
    MemoryBindingRequest,
    BulkIdsRequest,
    MemoryBulkStatusRequest,
    MemoryCreate,
    MemoryDuplicateRequest,
    MemoryExtractRequest,
    MemoryExtractResult,
    MemoryPolicyRead,
    MemoryPolicyUpdate,
    MemoryRead,
    MemoryUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/memories", tags=["memories"])
agent_router = APIRouter(prefix="/api/agents", tags=["memories"])


async def _agent_names(session: AsyncSession, agent_ids: list[str | None]) -> dict[str, str]:
    ids = {a for a in agent_ids if a}
    if not ids:
        return {}
    rows = (
        await session.execute(select(Agent.id, Agent.name).where(Agent.id.in_(ids)))
    ).all()
    return {r[0]: r[1] for r in rows}


def _to_read(row: Memory, agent_name: str | None = None) -> MemoryRead:
    return MemoryRead(
        id=row.id,
        agent_id=row.agent_id,
        agent_name=agent_name,
        scope=row.scope,
        session_id=row.session_id,
        kind=row.kind,
        content=row.content,
        source=row.source,
        source_run_id=row.source_run_id,
        status=row.status,
        importance=float(row.importance or 0.5),
        hits=row.hits or 0,
        last_hit_at=row.last_hit_at,
        embedding_status=row.embedding_status,
        ttl_s=row.ttl_s,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


# --------------------------------------------------------------------------- #
# 统计（静态路径，必须在 /{memory_id} 之前）
# --------------------------------------------------------------------------- #
@router.get("/stats")
async def memory_stats(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """概览用：各状态计数 + 命中总量。"""
    out: dict[str, Any] = {}
    for st in ("active", "candidate", "archived"):
        out[st] = (
            await session.execute(select(func.count(Memory.id)).where(Memory.status == st))
        ).scalar_one()
    out["total_hits"] = (
        await session.execute(select(func.coalesce(func.sum(Memory.hits), 0)))
    ).scalar_one()
    out["by_kind"] = {
        kind: (
            await session.execute(
                select(func.count(Memory.id)).where(Memory.kind == kind, Memory.status == "active")
            )
        ).scalar_one()
        for kind in ("fact", "preference", "instruction", "summary")
    }
    return out


# --------------------------------------------------------------------------- #
# 提炼（从一次执行沉淀）
# --------------------------------------------------------------------------- #
@router.post("/extract", response_model=MemoryExtractResult)
async def extract_memories(
    payload: MemoryExtractRequest, session: AsyncSession = Depends(get_session)
) -> MemoryExtractResult:
    """从某次执行提炼记忆。

    - 不传 ``items``：平台调用轻量模型提炼候选并返回（**不落库**）——
      前端展示给用户勾选/编辑，走"人工确认"路径
    - 传了 ``items``：按提交内容落库（``as_candidate=True`` 则落候选态，
      用于"自动沉淀"场景）
    """
    run = await session.get(Run, payload.run_id)
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Run 不存在: {payload.run_id}")

    # ---- 路径 A：用户已给出条目 → 落库 ----
    if payload.items:
        created = 0
        for item in payload.items:
            content = (item.content or "").strip()
            if not content:
                continue
            row = Memory(
                agent_id=item.agent_id or run.agent_id,
                scope=item.scope,
                kind=item.kind,
                content=content[:4000],
                source="manual",
                source_run_id=run.id,
                status="candidate" if payload.as_candidate or not item.active else "active",
                importance=item.importance,
                ttl_s=item.ttl_s,
                created_at=now_ms(),
                updated_at=now_ms(),
            )
            session.add(row)
            created += 1
        await session.commit()
        return MemoryExtractResult(run_id=run.id, created=created)

    # ---- 路径 B：AI 提炼 → 返回候选（不落库）----
    agent = await session.get(Agent, run.agent_id)
    if agent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agent 不存在")
    definition = AgentDefinition.model_validate(run.definition_snapshot or agent.definition)
    api_key = await resolve_api_key(definition, session)
    policy = await get_policy(session, run.agent_id)

    if not api_key:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "该 Agent 没有可用的 API Key，无法提炼记忆"
        )

    # 会话上下文：多轮时用整段对话提炼，比只看单轮更准
    turns: list[tuple[str, str]] = []
    if run.session_id:
        rows = (
            await session.execute(
                select(SessionMessage)
                .where(SessionMessage.session_id == run.session_id)
                .order_by(SessionMessage.turn_index, SessionMessage.id)
            )
        ).scalars().all()
        turns = [(r.role, r.content) for r in rows]

    user_prompt = build_user_prompt(run.input, run.output, turns or None)
    try:
        raw = await call_llm(
            base_url=definition.model.base_url or "https://api.deepseek.com/v1",
            api_key=api_key,
            model=policy.extract_model or definition.model.name,
            user_prompt=user_prompt,
        )
    except Exception as exc:
        logger.warning("记忆提炼失败 run=%s", run.id, exc_info=True)
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"提炼失败（模型调用出错）：{exc}"
        ) from exc

    candidates = parse_candidates(raw)
    kept, skipped = await dedupe(session, run.agent_id, candidates)

    return MemoryExtractResult(
        run_id=run.id,
        candidates=[
            MemoryRead(
                id="", agent_id=run.agent_id, scope="agent", kind=c.kind, content=c.content,
                source="manual", source_run_id=run.id, status="candidate",
                importance=0.5, hits=0, embedding_status="none", ttl_s=None,
                created_at=now_ms(), updated_at=now_ms(),
            )
            for c in kept
        ],
        created=0,
        skipped=skipped,
    )


# --------------------------------------------------------------------------- #
# 批量状态（候选区确认 / 丢弃）
# --------------------------------------------------------------------------- #
@router.post("/bulk-delete")
async def bulk_delete(payload: BulkIdsRequest, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """批量删除（按 id 列表）。

    与单条删除同一件事，只是省掉"点 N 次 + 确认 N 次"—— 前端会先把
    **具体条目**列给用户看，再带着这批 id 回来（不做条件批量）。
    """
    from sqlalchemy import delete as _delete

    rows = (await session.execute(select(Memory).where(Memory.id.in_(payload.ids)))).scalars().all()
    if not rows:
        return {"deleted": 0}
    found = [r.id for r in rows]
    await session.execute(_delete(Memory).where(Memory.id.in_(found)))
    await session.commit()
    return {"deleted": len(found)}


@router.post("/bulk-status")
async def bulk_status(
    payload: MemoryBulkStatusRequest, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    rows = (
        await session.execute(select(Memory).where(Memory.id.in_(payload.ids)))
    ).scalars().all()
    for row in rows:
        row.status = payload.status
        row.updated_at = now_ms()
    await session.commit()
    return {"updated": len(rows), "status": payload.status}


# --------------------------------------------------------------------------- #
# CRUD
# --------------------------------------------------------------------------- #
@router.get("", response_model=list[MemoryRead])
async def list_memories(
    agent_id: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    kind: str | None = None,
    q: str | None = Query(default=None, description="关键词搜索"),
    scope: str | None = None,
    limit: int = Query(default=200, le=500),
    session: AsyncSession = Depends(get_session),
) -> list[MemoryRead]:
    stmt = select(Memory).order_by(Memory.updated_at.desc()).limit(limit)
    if agent_id:
        stmt = stmt.where(or_(Memory.agent_id == agent_id, Memory.scope == "global"))
    if status_filter:
        stmt = stmt.where(Memory.status == status_filter)
    if kind:
        stmt = stmt.where(Memory.kind == kind)
    if scope:
        stmt = stmt.where(Memory.scope == scope)
    if q:
        stmt = stmt.where(Memory.content.like(f"%{q}%"))
    rows = list((await session.execute(stmt)).scalars().all())
    names = await _agent_names(session, [r.agent_id for r in rows])
    return [_to_read(r, names.get(r.agent_id or "")) for r in rows]


@router.post("", response_model=MemoryRead, status_code=status.HTTP_201_CREATED)
async def create_memory(
    payload: MemoryCreate, session: AsyncSession = Depends(get_session)
) -> MemoryRead:
    content = (payload.content or "").strip()
    if not content:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "记忆内容不能为空")
    if payload.scope == "agent" and not payload.agent_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "scope=agent 时必须指定 agent_id")
    if payload.agent_id and await session.get(Agent, payload.agent_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Agent 不存在: {payload.agent_id}")

    row = Memory(
        agent_id=payload.agent_id,
        scope=payload.scope,
        kind=payload.kind,
        content=content[:4000],
        source="manual",
        source_run_id=payload.source_run_id,
        status="active" if payload.active else "candidate",
        importance=payload.importance,
        ttl_s=payload.ttl_s,
        created_at=now_ms(),
        updated_at=now_ms(),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    names = await _agent_names(session, [row.agent_id])
    return _to_read(row, names.get(row.agent_id or ""))


@router.get("/{memory_id}", response_model=MemoryRead)
async def get_memory(memory_id: str, session: AsyncSession = Depends(get_session)) -> MemoryRead:
    row = await session.get(Memory, memory_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"记忆不存在: {memory_id}")
    names = await _agent_names(session, [row.agent_id])
    return _to_read(row, names.get(row.agent_id or ""))


@router.post(
    "/{memory_id}/duplicate", response_model=MemoryRead, status_code=status.HTTP_201_CREATED
)
async def duplicate_memory(
    memory_id: str,
    payload: MemoryDuplicateRequest,
    session: AsyncSession = Depends(get_session),
) -> MemoryRead:
    """复制一条记忆并绑定到别处。

    平台刻意保持「一条记忆只属于一个 Agent」：需要多个 Agent 共用同一条内容时，
    **复制一份再换绑**，而不是让它同时属于多个 Agent ——
    这样任何一方后续修改都不会牵动另一方，回滚和追责都清楚。
    """
    src = await session.get(Memory, memory_id)
    if src is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"记忆不存在: {memory_id}")

    content = ((payload.content if payload.content is not None else src.content) or "").strip()
    if not content:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "记忆内容不能为空")

    agent_id = payload.agent_id
    scope = payload.scope
    if scope == "global":
        agent_id = None
    elif not agent_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "复制到某个助手时必须指定 agent_id")
    elif await session.get(Agent, agent_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Agent 不存在: {agent_id}")

    now = now_ms()
    row = Memory(
        workspace_id=src.workspace_id,
        agent_id=agent_id,
        scope=scope,
        kind=src.kind,
        content=content[:4000],
        source="manual",          # 复制是人工动作，不是自动沉淀
        status="active",          # 既然人主动复制，就不必再过一遍候选确认
        importance=src.importance,
        ttl_s=src.ttl_s,
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    names = await _agent_names(session, [row.agent_id])
    return _to_read(row, names.get(row.agent_id or ""))


@router.patch("/{memory_id}", response_model=MemoryRead)
async def update_memory(
    memory_id: str, payload: MemoryUpdate, session: AsyncSession = Depends(get_session)
) -> MemoryRead:
    row = await session.get(Memory, memory_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"记忆不存在: {memory_id}")
    if payload.content is not None:
        row.content = payload.content.strip()[:4000]
    if payload.kind is not None:
        row.kind = payload.kind
    if payload.importance is not None:
        row.importance = payload.importance
    if payload.status is not None:
        row.status = payload.status
    if payload.scope is not None:
        row.scope = payload.scope
    if payload.ttl_s is not None:
        row.ttl_s = payload.ttl_s

    # 改归属。归属只有一个语义来源（agent_id），scope 跟着它走 ——
    # 这样就不会出现"scope=global 却绑着某个 agent"这种自相矛盾的状态。
    #   · None（不传）→ 不改
    #   · ""（空串） → 改成全局记忆
    #   · agent id   → 绑到该 Agent（会做存在性校验）
    if payload.agent_id is not None:
        if payload.agent_id == "":
            row.agent_id = None
            row.scope = "global"
        else:
            if await session.get(Agent, payload.agent_id) is None:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND, f"Agent 不存在: {payload.agent_id}"
                )
            row.agent_id = payload.agent_id
            row.scope = "agent"
    row.updated_at = now_ms()
    await session.commit()
    await session.refresh(row)
    names = await _agent_names(session, [row.agent_id])
    return _to_read(row, names.get(row.agent_id or ""))


@router.delete("/{memory_id}")
async def delete_memory(memory_id: str, session: AsyncSession = Depends(get_session)) -> dict:
    row = await session.get(Memory, memory_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"记忆不存在: {memory_id}")
    await session.delete(row)
    await session.commit()
    return {"deleted": 1}


# --------------------------------------------------------------------------- #
# Agent 绑定与策略（挂在 /api/agents 下，语义上属于 Agent 配置）
# --------------------------------------------------------------------------- #
@agent_router.get("/{agent_id}/memories", response_model=list[MemoryRead])
async def get_agent_memories(
    agent_id: str, session: AsyncSession = Depends(get_session)
) -> list[MemoryRead]:
    """该 Agent 可用的记忆 = 显式绑定的 ∪ 归属它自己的 ∪ 全局的。"""
    bound = select(AgentMemory.memory_id).where(AgentMemory.agent_id == agent_id)
    bound_ids = set((await session.execute(bound)).scalars().all())
    stmt = select(Memory).where(
        or_(Memory.agent_id == agent_id, Memory.scope == "global", Memory.id.in_(bound_ids or {""}))
    ).order_by(Memory.updated_at.desc())
    rows = list((await session.execute(stmt)).scalars().all())
    names = await _agent_names(session, [r.agent_id for r in rows])
    return [_to_read(r, names.get(r.agent_id or "")) for r in rows]


@agent_router.get("/{agent_id}/memory-bindings")
async def get_agent_memory_bindings(
    agent_id: str, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """显式绑定的记忆 id 集合。

    与上面"可用记忆"的区别很重要：可用 = 绑定 ∪ 归属 ∪ 全局；
    而**绑定是可写的那部分**（前端据此做全量覆盖时不会误删归属关系）。
    """
    rows = (
        await session.execute(select(AgentMemory.memory_id).where(AgentMemory.agent_id == agent_id))
    ).scalars().all()
    return {"memory_ids": list(rows)}


@agent_router.put("/{agent_id}/memories")
async def set_agent_memories(
    agent_id: str, payload: MemoryBindingRequest, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """全量覆盖绑定集合。绑定不改变记忆归属，只表达"这个 Agent 要用它"。"""
    if await session.get(Agent, agent_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Agent 不存在: {agent_id}")

    valid = set(
        (
            await session.execute(select(Memory.id).where(Memory.id.in_(payload.memory_ids or [""])))
        ).scalars().all()
    )
    existing = (
        await session.execute(select(AgentMemory).where(AgentMemory.agent_id == agent_id))
    ).scalars().all()
    for row in existing:
        await session.delete(row)
    added = 0
    for mid in payload.memory_ids:
        if mid in valid:
            session.add(AgentMemory(agent_id=agent_id, memory_id=mid, created_at=now_ms()))
            added += 1
    await session.commit()
    return {"bound": added, "ignored": len(payload.memory_ids) - added}


@agent_router.get("/{agent_id}/memory-policy", response_model=MemoryPolicyRead)
async def get_agent_memory_policy(
    agent_id: str, session: AsyncSession = Depends(get_session)
) -> MemoryPolicyRead:
    if await session.get(Agent, agent_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Agent 不存在: {agent_id}")
    return await get_policy(session, agent_id)


@agent_router.patch("/{agent_id}/memory-policy", response_model=MemoryPolicyRead)
async def patch_agent_memory_policy(
    agent_id: str, payload: MemoryPolicyUpdate, session: AsyncSession = Depends(get_session)
) -> MemoryPolicyRead:
    if await session.get(Agent, agent_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Agent 不存在: {agent_id}")
    return await update_policy(session, agent_id, payload.model_dump(exclude_none=True))
