"""数据带走：导出 / 导入（/api/export、/api/import）。

产品判断：**客户的资产要能拿走**
-------------------------------
助手、流程、单价、记忆都是用户自己攒出来的东西。锁在这套库里、界面上一键导出都没有，
等于"你的资产在我手上" —— 自用无所谓，要给别用或者换台机器就是硬伤
（这个项目的作者自己就要"下载→归档→换机器"）。

三条刻意的设计
--------------
1. **导出包里没有密钥**（LLM key / 口令都不进包）。密钥是**环境**的一部分，
   换机器该重新填，而不是跟着数据文件到处飞。界面上也这么写。
2. **导入永远"加"，不"覆盖"**：新记录一律新 id，并在导入时把关系重新接上
   （流程节点 → 新助手；助手的工具/Skill → 按**名字**匹配；记忆 → 新助手）。
   导入别人的包不该动到你现有的任何东西 —— 这是最容易做错、代价最大的一点。
3. **工具/Skill/凭据按"名字"接，不按 id**：id 是每台实例自己生成的，
   包里的 id 在另一台机器上一定对不上（对不上就说清楚，别静默丢）。
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import (
    Agent,
    AgentSkill,
    AgentTool,
    Memory,
    ModelPrice,
    Skill,
    Tool,
    Workflow,
    now_ms,
)
from ..pricing import currency_of, price_key
from ..schemas import ImportRequest, ImportResult  # noqa: F401  (定义见下)
from ..settings_store import set_setting

logger = logging.getLogger(__name__)

router = APIRouter(tags=["portability"])

BUNDLE_KIND = "agent-studio-export"
BUNDLE_VERSION = 1


def remap_graph(graph: dict[str, Any] | None, id_map: dict[str, str]) -> dict[str, Any]:
    """把流程里的节点指向**新**助手 id。

    **纯函数**（所以能被测试钉死）：id 对不上的节点保留原值，由调用方决定是跳过还是报错 ——
    这里不擅自删节点（悄悄少一步的流程，比报错难查得多）。
    """
    g = dict(graph or {})
    nodes = []
    for n in g.get("nodes") or []:
        node = dict(n or {})
        aid = str(node.get("agent_id") or "")
        if aid in id_map:
            node["agent_id"] = id_map[aid]
        nodes.append(node)
    g["nodes"] = nodes
    return g


@router.get("/api/export", response_model=dict)
async def export_all(
    memories: bool = Query(True, description="是否带上长期记忆"),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """导出成一个 JSON 包（可保存、可搬到另一台实例）。

    包里**不含任何密钥/口令** —— 只带"怎么配的"，不带"拿什么连"。
    """
    agents = list((await session.execute(select(Agent))).scalars())
    workflows = list((await session.execute(select(Workflow))).scalars())

    # 工具 / Skill 关联按名字导出（id 是每台实例自己的，跨机一定对不上）
    tool_rows = (await session.execute(select(AgentTool.agent_id, Tool.name).join(Tool, Tool.id == AgentTool.tool_id))).all()
    skill_rows = (await session.execute(select(AgentSkill.agent_id, Skill.name).join(Skill, Skill.id == AgentSkill.skill_id))).all()
    tools_of: dict[str, list[str]] = {}
    for aid, name in tool_rows:
        tools_of.setdefault(aid, []).append(name)
    skills_of: dict[str, list[str]] = {}
    for aid, name in skill_rows:
        skills_of.setdefault(aid, []).append(name)

    out = {
        "kind": BUNDLE_KIND,
        "version": BUNDLE_VERSION,
        "exported_at": now_ms(),
        "note": "不含任何密钥/口令；导入时一律新建，不覆盖你现有的数据",
        "agents": [
            {
                # id 要带上：流程节点存的是 assistant id，导入时靠它把节点**重新指向**
                # 新助手（否则跨机导入出来的流程会指向不存在的助手）。id 不是秘密。
                "id": a.id,
                "name": a.name,
                "slug": a.slug,
                "description": a.description,
                "runtime": a.runtime,
                "definition": a.definition or {},
                "tools": sorted(tools_of.get(a.id, [])),
                "skills": sorted(skills_of.get(a.id, [])),
            }
            for a in agents
        ],
        "workflows": [
            {
                "name": w.name,
                "description": w.description,
                "graph": w.graph or {},
                "mode_override": w.mode_override,
                # 自动运行的设置跟着走（触发凭证**不导出**，导入时各自生成）
                "auto": {
                    "default_task": w.default_task or "",
                    "schedule_mode": w.schedule_mode or "",
                    "schedule_at": w.schedule_at or "09:00",
                    "schedule_weekdays": w.schedule_weekdays or "",
                },
            }
            for w in workflows
        ],
        "prices": {
            "currency": await currency_of(session),
            "items": [
                {
                    "model": p.model,
                    "in_per_mtok": float(p.in_per_mtok or 0),
                    "out_per_mtok": float(p.out_per_mtok or 0),
                }
                for p in (await session.execute(select(ModelPrice))).scalars()
            ],
        },
    }
    if memories:
        rows = list(
            (await session.execute(select(Memory, Agent.name).outerjoin(Agent, Agent.id == Memory.agent_id))).all()
        )
        out["memories"] = [
            {
                "agent": agent_name,          # 按名字走，导入时接回新助手
                "scope": m.scope,
                "kind": m.kind,
                "content": m.content,
                "importance": float(m.importance or 0.5),
                "status": m.status,
            }
            for m, agent_name in rows
        ]
    return out


@router.post("/api/import", response_model=dict)
async def import_bundle(
    payload: ImportRequest, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """导入一个导出包（**只增不改**）。

    做三件事：建助手（新 id）→ 建流程（节点指向新助手）→ 接上工具/Skill/记忆。
    对不上的东西**如实报出来**（缺哪个工具、哪一步的助手没找到），
    而不是安静地少几个 —— 用户拿到一个"看着像但其实缺东西"的流程，比拿到一句警告糟得多。
    """
    bundle = payload.bundle or {}
    if bundle.get("kind") != BUNDLE_KIND:
        # 也接受"直接把 agents/workflows 塞进来"的宽松写法，但要说清楚
        if not (bundle.get("agents") or bundle.get("workflows")):
            return ImportResult(ok=False, detail=f"这不是 Agent Studio 的导出包（kind={bundle.get('kind')!r}）").model_dump()

    # 现成的工具 / Skill / 助手名字（按名字接）
    tool_by_name = {t.name: t.id for t in (await session.execute(select(Tool))).scalars()}
    skill_by_name = {s.name: s.id for s in (await session.execute(select(Skill))).scalars()}
    existing_agents = {a.name: a.id for a in (await session.execute(select(Agent))).scalars()}
    #: slug 是**唯一键**（workspace + slug + version）—— 导入同一个包两次不该炸，
    #: 所以这里自己保证唯一（同名助手是允许的，slug 不行）
    used_slugs = {a.slug for a in (await session.execute(select(Agent))).scalars()}

    def _free_slug(base: str) -> str:
        raw = (base or "imported-agent").strip()[:52] or "imported-agent"
        if raw not in used_slugs:
            used_slugs.add(raw)
            return raw
        for i in range(2, 999):
            cand = f"{raw}-{i}"
            if cand not in used_slugs:
                used_slugs.add(cand)
                return cand
        return f"{raw}-{now_ms()}"

    created_agents: list[dict[str, Any]] = []
    missing_tools: list[str] = []
    missing_skills: list[str] = []
    #: 包里的助手在**本包内**的旧 id（如果带了 id）→ 新 id；没带 id 就用名字当键
    id_map: dict[str, str] = {}

    for item in bundle.get("agents") or []:
        name = str(item.get("name") or "").strip() or "导入的助手"
        definition = dict(item.get("definition") or {})
        # 凭据是**本机**的东西：包里的 credential_ref 在这台机器上没有意义，清掉让用户重选
        model = dict(definition.get("model") or {})
        cred_dropped = bool(model.get("credential_ref"))
        model.pop("credential_ref", None)
        definition["model"] = model

        agent = Agent(
            name=name,
            slug=_free_slug(str(item.get("slug") or "") or name.lower().replace(" ", "-")),
            description=item.get("description"),
            runtime=str(item.get("runtime") or "agentscope"),
            definition=definition,
            created_at=now_ms(),
            updated_at=now_ms(),
        )
        session.add(agent)
        await session.flush()  # 拿到新 id
        if item.get("id"):
            id_map[str(item["id"])] = agent.id
        id_map[f"name:{name}"] = agent.id

        for tname in item.get("tools") or []:
            tid = tool_by_name.get(str(tname))
            if tid:
                session.add(AgentTool(agent_id=agent.id, tool_id=tid))
            else:
                missing_tools.append(f"{name} → {tname}")
        for sname in item.get("skills") or []:
            sid = skill_by_name.get(str(sname))
            if sid:
                session.add(AgentSkill(agent_id=agent.id, skill_id=sid))
            else:
                missing_skills.append(f"{name} → {sname}")

        created_agents.append(
            {
                "id": agent.id,
                "name": name,
                "credential_reset": cred_dropped,
                # 同名助手已经存在 —— 依然新建（导入不改别人的东西），但要让用户知道
                "name_collision": name in existing_agents,
            }
        )

    created_workflows: list[dict[str, Any]] = []
    unfixed_nodes: list[str] = []
    for item in bundle.get("workflows") or []:
        name = str(item.get("name") or "").strip() or "导入的流程"
        graph = remap_graph(item.get("graph"), id_map)
        # 节点指向的助手在本包里找不到（既没有 id 也没有对应名字）→ 如实报出来
        for node in graph.get("nodes") or []:
            aid = str(node.get("agent_id") or "")
            if aid and aid not in set(id_map.values()):
                unfixed_nodes.append(f"{name} → {aid}")
        auto = dict(item.get("auto") or {})
        wf = Workflow(
            name=name,
            description=str(item.get("description") or ""),
            graph=graph,
            mode_override=item.get("mode_override"),
            default_task=str(auto.get("default_task") or ""),
            # 定时设置跟着走，但**下次运行时间不照搬**（那是包导出那一刻的排期）
            schedule_mode=str(auto.get("schedule_mode") or ""),
            schedule_at=str(auto.get("schedule_at") or "09:00"),
            schedule_weekdays=str(auto.get("schedule_weekdays") or ""),
            created_at=now_ms(),
            updated_at=now_ms(),
        )
        session.add(wf)
        await session.flush()
        if wf.schedule_mode:
            from ..scheduler import compute_next

            wf.next_run_at = compute_next(wf.schedule_mode, wf.schedule_at, wf.schedule_weekdays)
        created_workflows.append({"id": wf.id, "name": name})

    # 记忆：按助手名字接回新助手（接不上就作为"不带助手"的记忆留着，不丢内容）
    imported_memories = 0
    for m in bundle.get("memories") or []:
        content = str(m.get("content") or "").strip()
        if not content:
            continue
        session.add(
            Memory(
                agent_id=id_map.get(f"name:{m.get('agent')}") if m.get("agent") else None,
                scope=str(m.get("scope") or "agent"),
                kind=str(m.get("kind") or "fact"),
                content=content,
                source="import",
                status=str(m.get("status") or "active"),
                importance=float(m.get("importance") or 0.5),
                created_at=now_ms(),
                updated_at=now_ms(),
            )
        )
        imported_memories += 1

    # 单价：只补"本机还没填"的（不覆盖你已经核对过的价格）
    prices = bundle.get("prices") or {}
    if prices.get("currency"):
        await set_setting(session, "price_currency", str(prices["currency"])[:8])
    have = {price_key(p.model) for p in (await session.execute(select(ModelPrice))).scalars()}
    priced = 0
    for row in prices.get("items") or []:
        model = str(row.get("model") or "").strip()
        if not model or price_key(model) in have:
            continue
        session.add(
            ModelPrice(
                model=model,
                in_per_mtok=float(row.get("in_per_mtok") or 0),
                out_per_mtok=float(row.get("out_per_mtok") or 0),
                updated_at=now_ms(),
            )
        )
        priced += 1

    await session.commit()
    return ImportResult(
        ok=True,
        agents=created_agents,
        workflows=created_workflows,
        memories=imported_memories,
        prices=priced,
        missing_tools=missing_tools,
        missing_skills=missing_skills,
        unfixed_nodes=unfixed_nodes,
        detail=(
            "导入只新增、不覆盖；密钥不在包里，请在「LLM 配置」里重新选一次凭据"
            if created_agents
            else "包里没有助手"
        ),
    ).model_dump()
