"""Agent 资源路由：CRUD + 复制 + 版本 + 工具/Skill 挂载。"""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Agent, AgentSkill, AgentTool, Run, Skill, Tool, now_ms
from ..schemas import AgentCreate, AgentRead, AgentUpdate, DuplicateRequest

router = APIRouter(prefix="/api/agents", tags=["agents"])


def slugify(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff]+", "-", (name or "").strip().lower()).strip("-")
    return s or "agent"


def to_read(row: Agent) -> AgentRead:
    return AgentRead(
        id=row.id,
        workspace_id=row.workspace_id,
        slug=row.slug,
        name=row.name,
        description=row.description,
        runtime=row.runtime,
        version=row.version,
        parent_id=row.parent_id,
        definition=row.definition or {},
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def _sync_relations(session: AsyncSession, agent_id: str, definition) -> None:
    """按定义里的 tools/skills 重建关联表（全量替换语义，简单可预测）。"""
    await session.execute(delete(AgentTool).where(AgentTool.agent_id == agent_id))
    await session.execute(delete(AgentSkill).where(AgentSkill.agent_id == agent_id))
    for ref in definition.tools:
        if ref.enabled:
            session.add(AgentTool(agent_id=agent_id, tool_id=ref.ref))
    for ref in definition.skills:
        session.add(AgentSkill(agent_id=agent_id, skill_id=ref.ref))


async def _get_or_404(session: AsyncSession, agent_id: str) -> Agent:
    row = await session.get(Agent, agent_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Agent 不存在: {agent_id}")
    return row


# --------------------------------------------------------------------------- #
@router.get("", response_model=list[AgentRead])
async def list_agents(session: AsyncSession = Depends(get_session)) -> list[AgentRead]:
    rows = (
        (await session.execute(select(Agent).order_by(Agent.updated_at.desc()))).scalars().all()
    )
    return [to_read(r) for r in rows]


@router.post("", response_model=AgentRead, status_code=status.HTTP_201_CREATED)
async def create_agent(
    payload: AgentCreate, session: AsyncSession = Depends(get_session)
) -> AgentRead:
    slug = payload.slug or slugify(payload.name)
    exists = (
        await session.execute(select(Agent).where(Agent.slug == slug, Agent.version == 1))
    ).scalar_one_or_none()
    if exists is not None:
        slug = f"{slug}-{int(now_ms() % 100000)}"

    row = Agent(
        slug=slug,
        name=payload.name,
        description=payload.description,
        runtime=payload.definition.runtime,
        version=1,
        definition=payload.definition.model_dump(mode="json", exclude={"model": {"api_key"}}),
    )
    session.add(row)
    await session.flush()
    await _sync_relations(session, row.id, payload.definition)
    await session.commit()
    await session.refresh(row)
    return to_read(row)


@router.get("/{agent_id}", response_model=AgentRead)
async def get_agent(agent_id: str, session: AsyncSession = Depends(get_session)) -> AgentRead:
    return to_read(await _get_or_404(session, agent_id))


@router.put("/{agent_id}", response_model=AgentRead)
async def update_agent(
    agent_id: str,
    payload: AgentUpdate,
    session: AsyncSession = Depends(get_session),
) -> AgentRead:
    """更新。默认 ``bump_version=True``：写回同一条记录但 version+1（可回滚）。"""
    row = await _get_or_404(session, agent_id)

    if payload.name is not None:
        row.name = payload.name
    if payload.description is not None:
        row.description = payload.description

    if payload.definition is not None:
        row.definition = payload.definition.model_dump(mode="json", exclude={"model": {"api_key"}})
        row.runtime = payload.definition.runtime
        if payload.bump_version:
            row.version = (row.version or 1) + 1
        await _sync_relations(session, row.id, payload.definition)

    row.updated_at = now_ms()
    await session.commit()
    await session.refresh(row)
    return to_read(row)


@router.delete("/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_agent(agent_id: str, session: AsyncSession = Depends(get_session)) -> None:
    row = await _get_or_404(session, agent_id)
    await session.execute(delete(AgentTool).where(AgentTool.agent_id == agent_id))
    await session.execute(delete(AgentSkill).where(AgentSkill.agent_id == agent_id))
    await session.delete(row)
    await session.commit()


# --------------------------------------------------------------------------- #
# 复制
# --------------------------------------------------------------------------- #
@router.post("/{agent_id}/duplicate", response_model=AgentRead, status_code=status.HTTP_201_CREATED)
async def duplicate_agent(
    agent_id: str,
    payload: DuplicateRequest | None = None,
    session: AsyncSession = Depends(get_session),
) -> AgentRead:
    """复制一个 Agent（定义 + 工具/Skill 挂载关系一并复制）。"""
    src = await _get_or_404(session, agent_id)

    base_slug = (payload.slug if payload and payload.slug else slugify(src.name)) or src.slug
    slug = base_slug
    n = 2
    while (await session.execute(select(Agent).where(Agent.slug == slug))).first() is not None:
        slug = f"{base_slug}-{n}"
        n += 1

    clone = Agent(
        workspace_id=src.workspace_id,
        slug=slug,
        name=(payload.name if payload and payload.name else f"{src.name} (副本)"),
        description=src.description,
        runtime=src.runtime,
        version=1,
        parent_id=src.id,          # 血缘：来源
        definition=dict(src.definition or {}),
    )
    session.add(clone)
    await session.flush()

    # 复制挂载关系
    tool_ids = (
        await session.execute(select(AgentTool.tool_id).where(AgentTool.agent_id == src.id))
    ).scalars().all()
    for tool_id in tool_ids:
        session.add(AgentTool(agent_id=clone.id, tool_id=tool_id))

    skill_ids = (
        await session.execute(select(AgentSkill.skill_id).where(AgentSkill.agent_id == src.id))
    ).scalars().all()
    for skill_id in skill_ids:
        session.add(AgentSkill(agent_id=clone.id, skill_id=skill_id))

    await session.commit()
    await session.refresh(clone)
    return to_read(clone)


@router.get("/{agent_id}/lineage", response_model=list[AgentRead])
async def agent_lineage(agent_id: str, session: AsyncSession = Depends(get_session)) -> list[AgentRead]:
    """血缘链：从当前 Agent 往回追复制来源。"""
    chain: list[Agent] = []
    current = await _get_or_404(session, agent_id)
    seen: set[str] = set()
    while current is not None and current.id not in seen:
        chain.append(current)
        seen.add(current.id)
        current = await session.get(Agent, current.parent_id) if current.parent_id else None
    return [to_read(r) for r in chain]


# --------------------------------------------------------------------------- #
# 挂载关系
# --------------------------------------------------------------------------- #
@router.get("/{agent_id}/tools")
async def list_agent_tools(agent_id: str, session: AsyncSession = Depends(get_session)) -> list[dict]:
    await _get_or_404(session, agent_id)
    rows = (
        await session.execute(
            select(Tool).join(AgentTool, AgentTool.tool_id == Tool.id).where(AgentTool.agent_id == agent_id)
        )
    ).scalars().all()
    return [{"id": r.id, "name": r.name, "kind": r.kind} for r in rows]


@router.post("/{agent_id}/tools/{tool_id}", status_code=status.HTTP_204_NO_CONTENT)
async def mount_tool(
    agent_id: str, tool_id: str, session: AsyncSession = Depends(get_session)
) -> None:
    await _get_or_404(session, agent_id)
    if await session.get(Tool, tool_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"工具不存在: {tool_id}")
    existing = await session.get(AgentTool, {"agent_id": agent_id, "tool_id": tool_id})
    if existing is None:
        session.add(AgentTool(agent_id=agent_id, tool_id=tool_id))
        row = await _get_or_404(session, agent_id)
        definition = dict(row.definition or {})
        tools = definition.get("tools") or []
        if not any(t.get("ref") == tool_id for t in tools):
            tools.append({"ref": tool_id, "enabled": True})
        definition["tools"] = tools
        row.definition = definition
        row.updated_at = now_ms()
        await session.commit()


@router.delete("/{agent_id}/tools/{tool_id}", status_code=status.HTTP_204_NO_CONTENT)
async def unmount_tool(
    agent_id: str, tool_id: str, session: AsyncSession = Depends(get_session)
) -> None:
    await _get_or_404(session, agent_id)
    existing = await session.get(AgentTool, {"agent_id": agent_id, "tool_id": tool_id})
    if existing is not None:
        await session.delete(existing)
    row = await _get_or_404(session, agent_id)
    definition = dict(row.definition or {})
    definition["tools"] = [t for t in (definition.get("tools") or []) if t.get("ref") != tool_id]
    row.definition = definition
    row.updated_at = now_ms()
    await session.commit()


@router.post("/{agent_id}/skills/{skill_id}", status_code=status.HTTP_204_NO_CONTENT)
async def mount_skill(
    agent_id: str, skill_id: str, session: AsyncSession = Depends(get_session)
) -> None:
    await _get_or_404(session, agent_id)
    if await session.get(Skill, skill_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Skill 不存在: {skill_id}")
    existing = await session.get(AgentSkill, {"agent_id": agent_id, "skill_id": skill_id})
    if existing is None:
        session.add(AgentSkill(agent_id=agent_id, skill_id=skill_id))
        await session.commit()


@router.delete("/{agent_id}/skills/{skill_id}", status_code=status.HTTP_204_NO_CONTENT)
async def unmount_skill(
    agent_id: str, skill_id: str, session: AsyncSession = Depends(get_session)
) -> None:
    await _get_or_404(session, agent_id)
    existing = await session.get(AgentSkill, {"agent_id": agent_id, "skill_id": skill_id})
    if existing is not None:
        await session.delete(existing)
        await session.commit()


@router.get("/{agent_id}/runs")
async def list_agent_runs(
    agent_id: str, limit: int = 20, session: AsyncSession = Depends(get_session)
) -> list[dict]:
    await _get_or_404(session, agent_id)
    rows = (
        await session.execute(
            select(Run).where(Run.agent_id == agent_id).order_by(Run.started_at.desc()).limit(limit)
        )
    ).scalars().all()
    return [
        {
            "id": r.id,
            "status": r.status,
            "started_at": r.started_at,
            "ended_at": r.ended_at,
            "usage": r.usage or {},
        }
        for r in rows
    ]
