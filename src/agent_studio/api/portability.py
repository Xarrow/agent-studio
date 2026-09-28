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
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import (
    Agent,
    AgentSkill,
    AgentTool,
    Memory,
    MemoryPolicy,
    ModelPrice,
    Secret,
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


#: 可分区的功能配置 —— 「各个功能配置导入导出」就是按这里的粒度来。
#: label 给界面用；importable 表示导入端是否真的会落库（凭据永远不会：密钥不进包）。
SECTIONS: tuple[dict[str, Any], ...] = (
    {"key": "agents", "label": "助手", "importable": True,
     "note": "含它挂的工具/Skill（按名字接）"},
    {"key": "tools", "label": "自定义工具", "importable": True,
     "note": "内置/原生工具不用导（启动会自动同步）；请求头里的密钥会被清掉"},
    {"key": "skills", "label": "技能", "importable": True, "note": "SKILL.md 全文 + 来源"},
    {"key": "workflows", "label": "编排流程", "importable": True,
     "note": "含自动运行设置；触发凭证不导出"},
    {"key": "policies", "label": "记忆策略", "importable": True,
     "note": "每个助手的召回/提炼/压缩档位"},
    {"key": "memories", "label": "长期记忆", "importable": True, "note": "按助手名字接回"},
    {"key": "prices", "label": "模型单价", "importable": False,
     "note": "按模型名对齐；导入不覆盖你已有的单价"},
    {"key": "credentials", "label": "LLM 配置", "importable": False,
     "note": "只导出清单（名字/端点/默认模型）；密钥绝不进包，换机器重新填"},
)

#: 启动会自动重建的工具种类 —— 导出它们没意义，导入也不该重复建
AUTO_SYNCED_TOOL_KINDS = ("builtin", "native", "fork")

#: 长得像密钥的键名（http 工具请求头里）
_SECRET_KEY_HINTS = ("authorization", "token", "api_key", "apikey", "secret", "cookie", "password")


def scrub_secrets(obj: Any) -> tuple[Any, bool]:
    """把"长得像密钥"的字段值清空（返回 清洗后的对象, 是否清过）。

    为什么要做：自定义 http 工具的请求头里常常直接塞 Bearer token ——
    导出包会到处飞（发给自己、放进仓库），密钥不能跟着走。
    """
    touched = False
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            if isinstance(v, str) and v.strip() and any(h in str(k).lower() for h in _SECRET_KEY_HINTS):
                out[k] = ""
                touched = True
            else:
                new_v, t = scrub_secrets(v)
                out[k] = new_v
                touched = touched or t
        return out, touched
    if isinstance(obj, list):
        items = []
        for v in obj:
            new_v, t = scrub_secrets(v)
            items.append(new_v)
            touched = touched or t
        return items, touched
    return obj, False


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
    memories: bool = Query(True, description="是否带上长期记忆（兼容旧参数）"),
    sections: str | None = Query(
        None,
        description="要导哪些功能（逗号分隔，如 agents,workflows）。不传 = 全部",
    ),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """导出成一个 JSON 包（可保存、可搬到另一台实例）。

    包里**不含任何密钥/口令** —— 只带"怎么配的"，不带"拿什么连"。
    ``sections`` 让"各个功能配置"能分开导（只想要助手、或只要流程）。
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
    # 自定义工具：内置/原生那类启动会自己同步，导出没意义（导入也不该重复建）
    tool_rows_export = []
    for t in (await session.execute(select(Tool))).scalars():
        if (t.kind or "") in AUTO_SYNCED_TOOL_KINDS:
            continue
        impl, scrubbed = scrub_secrets(t.impl or {})
        tool_rows_export.append(
            {
                "name": t.name,
                "kind": t.kind,
                "description": t.description or "",
                "input_schema": t.input_schema or {},
                "impl": impl,
                #: 请求头里的密钥被清掉了 —— 导入后要重填
                "secrets_scrubbed": scrubbed,
            }
        )
    out["tools"] = tool_rows_export
    out["skills"] = [
        {
            "name": sk.name,
            "description": sk.description or "",
            "source": sk.source or {},
            "content": sk.content or "",
            "files": sk.files or {},
        }
        for sk in (await session.execute(select(Skill))).scalars()
    ]
    # 记忆策略：每个助手一套（跟着助手名字走，导入时接回新助手）
    pol_rows = (
        await session.execute(
            select(MemoryPolicy, Agent.name).join(Agent, Agent.id == MemoryPolicy.agent_id)
        )
    ).all()
    out["policies"] = [
        {
            "agent": agent_name,
            "auto_extract": int(p.auto_extract or 0),
            "recall_enabled": int(p.recall_enabled or 0),
            "recall_top_k": int(p.recall_top_k or 5),
            "recall_strategy": p.recall_strategy or "hybrid",
            "recall_backend": getattr(p, "recall_backend", "local") or "local",
            "compress_after_turns": int(p.compress_after_turns or 0),
        }
        for p, agent_name in pol_rows
    ]
    # LLM 配置：**只导清单**（名字/端点/默认模型）—— 密钥是环境的一部分，不进包
    out["credentials"] = [
        {
            "name": sec.name,
            "provider": sec.provider,
            "base_url": sec.base_url,
            "default_model": getattr(sec, "default_model", None),
        }
        for sec in (await session.execute(select(Secret))).scalars()
    ]
    out["credential_note"] = "密钥不在包里：导入后请在本机重新填写 API Key（清单只用于告诉你缺哪些）"

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
    if sections:
        wanted = {x.strip() for x in sections.split(",") if x.strip()}
        keep = {"kind", "version", "exported_at", "note", "credential_note"} | wanted
        dropped = sorted(set(out) - keep)
        out = {k: v for k, v in out.items() if k in keep}
        out["sections"] = sorted(wanted)
        out["dropped"] = dropped
    else:
        out["sections"] = [x["key"] for x in SECTIONS]
    return out


@router.get("/api/export/sections", response_model=dict)
async def export_sections(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """「各个功能配置」的清单 + 现有数量（界面据此渲染一行一功能）。"""
    counts = {
        "agents": (await session.execute(select(func.count()).select_from(Agent))).scalar_one(),
        "tools": len(
            [
                t
                for t in (await session.execute(select(Tool))).scalars()
                if (t.kind or "") not in AUTO_SYNCED_TOOL_KINDS
            ]
        ),
        "skills": (await session.execute(select(func.count()).select_from(Skill))).scalar_one(),
        "workflows": (await session.execute(select(func.count()).select_from(Workflow))).scalar_one(),
        "policies": (await session.execute(select(func.count()).select_from(MemoryPolicy))).scalar_one(),
        "memories": (await session.execute(select(func.count()).select_from(Memory))).scalar_one(),
        "prices": (await session.execute(select(func.count()).select_from(ModelPrice))).scalar_one(),
        "credentials": (await session.execute(select(func.count()).select_from(Secret))).scalar_one(),
    }
    return {
        "sections": [{**sec, "count": counts.get(sec["key"], 0)} for sec in SECTIONS],
        "bundle_kind": BUNDLE_KIND,
        "bundle_version": BUNDLE_VERSION,
    }


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

    # 自定义工具：同名已存在就不动（导入不改别人的东西）；内置那类不重复建
    created_tools: list[str] = []
    skipped_tools: list[str] = []
    for item in bundle.get("tools") or []:
        name = str(item.get("name") or "").strip()
        kind = str(item.get("kind") or "").strip()
        if not name:
            continue
        if kind in AUTO_SYNCED_TOOL_KINDS or name in tool_by_name:
            skipped_tools.append(name)
            continue
        t = Tool(
            kind=kind or "http",
            name=name,
            description=str(item.get("description") or ""),
            input_schema=dict(item.get("input_schema") or {}),
            impl=dict(item.get("impl") or {}),
            created_at=now_ms(),
            updated_at=now_ms(),
        )
        session.add(t)
        await session.flush()
        tool_by_name[name] = t.id
        created_tools.append(name)

    # 技能：同名已存在就不动
    created_skills: list[str] = []
    skipped_skills: list[str] = []
    for item in bundle.get("skills") or []:
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        if name in skill_by_name:
            skipped_skills.append(name)
            continue
        sk = Skill(
            name=name,
            description=str(item.get("description") or ""),
            source=dict(item.get("source") or {}),
            content=str(item.get("content") or ""),
            files=dict(item.get("files") or {}),
            created_at=now_ms(),
            updated_at=now_ms(),
        )
        session.add(sk)
        await session.flush()
        skill_by_name[name] = sk.id
        created_skills.append(name)

    # 工具/Skill 是在助手**之前**导出的顺序问题：助手那一段先跑，所以这里要补接
    # （同一个包里既有助手又有工具时，助手当时接不上工具名 → 这里按新工具 id 补上）
    linked_tools = 0
    linked_skills = 0
    if created_tools or created_skills:
        for item in bundle.get("agents") or []:
            aid = id_map.get(str(item.get("id") or "")) or id_map.get(
                f"name:{str(item.get('name') or '').strip()}"
            )
            if not aid:
                continue
            for tname in item.get("tools") or []:
                tid = tool_by_name.get(str(tname))
                if not tid:
                    continue
                exists = (
                    await session.execute(
                        select(AgentTool).where(
                            AgentTool.agent_id == aid, AgentTool.tool_id == tid
                        )
                    )
                ).scalars().first()
                if exists is None:
                    session.add(AgentTool(agent_id=aid, tool_id=tid))
                    linked_tools += 1
            for sname in item.get("skills") or []:
                sid = skill_by_name.get(str(sname))
                if not sid:
                    continue
                exists = (
                    await session.execute(
                        select(AgentSkill).where(
                            AgentSkill.agent_id == aid, AgentSkill.skill_id == sid
                        )
                    )
                ).scalars().first()
                if exists is None:
                    session.add(AgentSkill(agent_id=aid, skill_id=sid))
                    linked_skills += 1

    # 补接成功的，要从"缺失"名单里划掉 —— 否则界面一边说"接上了"一边说"缺这个工具"，
    # 用户只会以为导入坏了（实测就是这么报的：工具是同一个包里的，只是排在助手后面）。
    if linked_tools and missing_tools:
        now_tools = set(tool_by_name)
        missing_tools = [m for m in missing_tools if m.split("→")[-1].strip() not in now_tools]
    if linked_skills and missing_skills:
        now_skills = set(skill_by_name)
        missing_skills = [m for m in missing_skills if m.split("→")[-1].strip() not in now_skills]

    # 记忆策略：按助手名接回；**已有策略的助手不动**（导入不改别人的调参）
    created_policies: list[str] = []
    skipped_policies: list[str] = []
    for item in bundle.get("policies") or []:
        agent_name = str(item.get("agent") or "").strip()
        aid = id_map.get(f"name:{agent_name}")
        if not aid:
            skipped_policies.append(f"{agent_name or '?'}（这次没导入它的助手）")
            continue
        exists = (await session.get(MemoryPolicy, aid)) is not None
        if exists:
            skipped_policies.append(f"{agent_name}（已有策略，保留你的）")
            continue
        session.add(
            MemoryPolicy(
                agent_id=aid,
                auto_extract=int(item.get("auto_extract") or 0),
                recall_enabled=int(item.get("recall_enabled") or 0),
                recall_top_k=int(item.get("recall_top_k") or 5),
                recall_strategy=str(item.get("recall_strategy") or "hybrid"),
                recall_backend=str(item.get("recall_backend") or "local"),
                compress_after_turns=int(item.get("compress_after_turns") or 0),
            )
        )
        created_policies.append(agent_name)

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
        tools=created_tools,
        skills=created_skills,
        policies=created_policies,
        skipped=(
            [f"工具：{n}（已存在或内置）" for n in skipped_tools]
            + [f"技能：{n}（已存在）" for n in skipped_skills]
            + [f"记忆策略：{n}" for n in skipped_policies]
        ),
        credentials_to_fill=[
            str(c.get("name") or "") for c in (bundle.get("credentials") or []) if c.get("name")
        ],
        detail=(
            "导入只新增、不覆盖；密钥不在包里，请在「LLM 配置」里重新选一次凭据"
            if created_agents
            else "包里没有助手"
        ),
    ).model_dump()
