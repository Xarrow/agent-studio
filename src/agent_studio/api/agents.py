"""Agent 资源路由：CRUD + 复制 + 版本 + 工具/Skill 挂载。"""

from __future__ import annotations

import json

import re

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.orm.attributes import flag_modified
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
    # 先把不存在的引用挡在门外。不校验的话，插入关联表会撞外键约束，
    # 用户看到的是 "Internal Server Error"（实测：换到另一套环境的库里技能 id
    # 不存在，创建助手直接 500，谁也猜不到是哪个 id 写错了）。
    tool_refs = [r.ref for r in definition.tools if r.enabled]
    if tool_refs:
        found = set(
            (await session.execute(select(Tool.id).where(Tool.id.in_(tool_refs)))).scalars().all()
        )
        missing = [r for r in tool_refs if r not in found]
        if missing:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"工具不存在：{'、'.join(missing)}（可能来自另一套环境的库）"
            )
    skill_refs = [r.ref for r in definition.skills]
    if skill_refs:
        found = set(
            (await session.execute(select(Skill.id).where(Skill.id.in_(skill_refs)))).scalars().all()
        )
        missing = [r for r in skill_refs if r not in found]
        if missing:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"技能不存在：{'、'.join(missing)}（可能来自另一套环境的库）"
            )
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
    # 远端 A2A 的影子 Agent：注册项被停用的就不列出来（它跑在对面，这里停用=不可用）。
    # 不停用仍可见，是"能在 Agents 页发现并使用"的前提；停用还看得见就是自相矛盾。
    return [to_read(r) for r in rows if not ((r.definition or {}).get("disabled") is True)]


@router.post("", response_model=AgentRead, status_code=status.HTTP_201_CREATED)
async def create_agent(
    payload: AgentCreate, session: AsyncSession = Depends(get_session)
) -> AgentRead:
    # 重名校验：列表里两个同名助手无法区分（历史/日志里也只显示名字）。
    slug = payload.slug or slugify(payload.name)
    exists = (
        await session.execute(select(Agent).where(Agent.slug == slug, Agent.version == 1))
    ).scalar_one_or_none()
    if exists is not None:
        slug = f"{slug}-{int(now_ms() % 100000)}"

    dup = (
        await session.execute(select(Agent).where(Agent.name == payload.name.strip()))
    ).scalar_one_or_none()
    if dup is not None:
        raise HTTPException(status_code=409, detail=f"已存在同名助手「{payload.name.strip()}」")

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
    # 第一版快照：这样"从第 1 版开始"就成立（不必等第一次修改才有历史）
    from ..revisions import KIND_AGENT, snapshot

    await snapshot(session, KIND_AGENT, row.id)
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
        new_name = payload.name.strip()
        if new_name and new_name != row.name:
            dup = (
                await session.execute(
                    select(Agent).where(Agent.name == new_name, Agent.id != agent_id)
                )
            ).scalar_one_or_none()
            if dup is not None:
                raise HTTPException(status_code=409, detail=f"已存在同名助手「{new_name}」")
        row.name = new_name
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
    # 打一版快照（内容没变就不记）—— 有了它，"改坏了"就能退回去
    from ..revisions import KIND_AGENT, snapshot

    await snapshot(session, KIND_AGENT, row.id)
    await session.commit()
    await session.refresh(row)
    return to_read(row)


@router.delete("/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_agent(agent_id: str, session: AsyncSession = Depends(get_session)) -> None:
    row = await _get_or_404(session, agent_id)
    await session.execute(delete(AgentTool).where(AgentTool.agent_id == agent_id))
    await session.execute(delete(AgentSkill).where(AgentSkill.agent_id == agent_id))
    # 版本历史跟着走：对象都没了，留着这些快照只是孤儿行（也再没人能回滚它）
    from ..models import Revision

    await session.execute(
        delete(Revision).where(Revision.kind == "agent", Revision.target_id == agent_id)
    )
    # 它的会话也一并删：留着的话侧栏还会出现这些"孤儿对话"，点进去身份带/操作
    # 都落到不存在的 agent 上（实测攒了 7 条）。
    from ..models import Session as SessionModel

    orphan_sessions = (
        (await session.execute(select(SessionModel).where(SessionModel.agent_id == agent_id)))
        .scalars()
        .all()
    )
    for s in orphan_sessions:
        await session.delete(s)
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
        # 必须深拷贝再赋回 + flag_modified：浅拷贝时嵌套 list/dict 与 ORM 已加载值共享，
        # SQLAlchemy 的变更检测可能判定"没变"而不发 UPDATE —— 表现为 204 成功但
        # definition.tools 里根本没有（真机实测抓到过，勾选前端回显对、后端却没存）。
        definition = json.loads(json.dumps(row.definition or {}))
        tools = definition.get("tools") or []
        if not any(t.get("ref") == tool_id for t in tools):
            tools.append({"ref": tool_id, "enabled": True})
        definition["tools"] = tools
        row.definition = definition
        flag_modified(row, "definition")
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
    definition = json.loads(json.dumps(row.definition or {}))
    definition["tools"] = [t for t in (definition.get("tools") or []) if t.get("ref") != tool_id]
    row.definition = definition
    flag_modified(row, "definition")
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


@router.get("/orchestrator/brief")
async def orchestrator_brief() -> dict[str, str]:
    """编排者（Orchestrator）职责的**平台内置定义**。

    为什么要这个接口：Agents 页要把"这个分类到底要求它做什么"显示给用户看
    （并且允许按助手覆盖）—— 文案只存在后端一份，前端不复制，改口径只改一处。
    """
    from agent_studio.orchestrator.service import ORCHESTRATOR_BRIEF

    return {"brief": ORCHESTRATOR_BRIEF, "role": "orchestrator", "abilities": "分析任务|管理上下文|验证结果|归纳总结"}


@router.post("/repair-refs")
async def repair_refs(session: AsyncSession = Depends(get_session)) -> dict:
    """把助手定义里「本机不存在的工具/技能引用」摘掉。

    为什么需要它：跨机导入过的助手，定义里可能还留着源机器的 tl_xxx / sk_xxx。
    这些 id 在本机不存在，于是每次保存都被校验拦下（报一长串「工具不存在」），
    用户想改个名字都改不了。这里一次性清掉，返回每个助手清了几条 ——
    不做静默删除，界面/日志能看见改了什么。
    """
    from ..models import Agent, Skill, Tool

    tool_ids = {t.id for t in (await session.execute(select(Tool))).scalars()}
    skill_ids = {s.id for s in (await session.execute(select(Skill))).scalars()}
    # 关联表里其实已经按名字接好了（导入时建的）—— 清完无效引用后，用它们把
    # 定义里的挂载恢复回来，而不是让助手变成"一个工具都不挂"。
    from ..models import AgentSkill, AgentTool

    linked_tools: dict[str, list[str]] = {}
    for row in (await session.execute(select(AgentTool))).scalars():
        linked_tools.setdefault(row.agent_id, []).append(row.tool_id)
    linked_skills: dict[str, list[str]] = {}
    for row in (await session.execute(select(AgentSkill))).scalars():
        linked_skills.setdefault(row.agent_id, []).append(row.skill_id)
    fixed: list[dict] = []
    for a in (await session.execute(select(Agent))).scalars():
        defn = dict(a.definition or {})
        dropped_t = 0
        dropped_s = 0
        tools = []
        for r in defn.get("tools") or []:
            if isinstance(r, dict) and str(r.get("ref") or "") in tool_ids:
                tools.append(r)
            else:
                dropped_t += 1
        skills = []
        for r in defn.get("skills") or []:
            if isinstance(r, dict) and str(r.get("ref") or "") in skill_ids:
                skills.append(r)
            else:
                dropped_s += 1
        # 空挂载但关联表里有 → 补回来（跨机导入后可能被清空过一次）
        if not tools and linked_tools.get(a.id):
            dropped_t += 0
        if dropped_t or dropped_s or (not tools and linked_tools.get(a.id)) or (not skills and linked_skills.get(a.id)):
            added = 0
            have_t = {str(r.get("ref") or "") for r in tools if isinstance(r, dict)}
            have_s = {str(r.get("ref") or "") for r in skills if isinstance(r, dict)}
            for tid in linked_tools.get(a.id, []):
                if tid in tool_ids and tid not in have_t:
                    tools.append({"ref": tid, "enabled": True})
                    added += 1
            for sid2 in linked_skills.get(a.id, []):
                if sid2 in skill_ids and sid2 not in have_s:
                    skills.append({"ref": sid2})
            defn["tools"] = tools
            defn["skills"] = skills
            a.definition = defn
            fixed.append(
                {
                    "id": a.id,
                    "name": a.name,
                    "dropped_tools": dropped_t,
                    "dropped_skills": dropped_s,
                    "relinked_tools": added,
                }
            )
    await session.commit()
    return {"fixed": fixed, "count": len(fixed)}
