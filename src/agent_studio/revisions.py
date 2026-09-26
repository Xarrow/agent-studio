"""版本快照与回滚（助手 / 流程共用一套）。

产品判断
--------
Agent 平台的资产就是"怎么配的"：提示词、模型、工具、编排图。谁把它改坏了要能退回上一版 ——
没有这个，用户就会因为"怕改坏"而不敢改，那这个平台的价值直接减半。
（原来只有一个自增的 ``version`` 数字，**没有内容**：知道"改过 3 次"，但不知道"改成什么了"。）

三条刻意的设计
--------------
1. **一个泛化表**（``revision``：kind + target_id + version + payload）。
   助手和流程的"版本"语义完全一样（快照 + 列表 + 回滚），没必要做两套。
2. **回滚 = 前进**：恢复旧版时**新建一条**快照，而不是抹掉中间的历史。
   历史只增不改，才敢相信它（也让"我退回去又改回来"这件事有记录）。
3. **内容一样就不记**：每次自动保存都插一条会让历史变成噪声（画布上拖一下就是一次保存）。
   所以只有在 payload 真的变了的时候才写快照。

``summarize()`` 是纯函数（可测）：把"两版之间改了什么"说成**一句人话**，
用户才不用逐字段对比 —— 这也是"看到更多"的一部分。
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Agent, AgentSkill, AgentTool, Revision, Skill, Tool, Workflow, now_ms

logger = logging.getLogger(__name__)

KIND_AGENT = "agent"
KIND_WORKFLOW = "workflow"
KINDS = (KIND_AGENT, KIND_WORKFLOW)


# --------------------------------------------------------------------------- #
# 「改了什么」—— 纯函数，界面直接显示这句话
# --------------------------------------------------------------------------- #
def summarize(kind: str, old: dict[str, Any] | None, new: dict[str, Any]) -> str:
    """两版之间改了什么（一句人话）。认不出具体改动就回一句中性的。"""
    if not old:
        return "首次记录"

    def d(key: str, default: Any = "") -> Any:
        return (new or {}).get(key, default)

    def o(key: str, default: Any = "") -> Any:
        return (old or {}).get(key, default)

    if kind == KIND_WORKFLOW:
        parts: list[str] = []
        if o("name") != d("name"):
            parts.append("改了名字")
        old_g, new_g = old.get("graph") or {}, new.get("graph") or {}
        on, nn = len(old_g.get("nodes") or []), len(new_g.get("nodes") or [])
        oe, ne = len(old_g.get("edges") or []), len(new_g.get("edges") or [])
        if nn != on:
            parts.append(f"步骤 {on} → {nn}")
        if ne != oe:
            parts.append(f"连线 {oe} → {ne}")
        if old_g.get("nodes") != new_g.get("nodes") and nn == on:
            parts.append("换了步骤里的助手")
        if old_g.get("edges") != new_g.get("edges") and ne == oe:
            parts.append("改了连线关系")
        if o("mode_override") != d("mode_override"):
            parts.append("改了执行方式")
        return "、".join(parts) or "版面或细节调整"

    # 助手
    parts = []
    if o("name") != d("name"):
        parts.append(f"改名：{o('name')} → {d('name')}")
    od, nd = old.get("definition") or {}, new.get("definition") or {}
    if (od.get("system_prompt") or "") != (nd.get("system_prompt") or ""):
        parts.append("改了提示词")
    om, nm = od.get("model") or {}, nd.get("model") or {}
    if om.get("name") != nm.get("name"):
        parts.append(f"换模型：{om.get('name')} → {nm.get('name')}")
    if om.get("provider") != nm.get("provider"):
        parts.append(f"换服务商：{om.get('provider')} → {nm.get('provider')}")
    if (od.get("role") or "worker") != (nd.get("role") or "worker"):
        parts.append("改了流程里的角色")
    if (od.get("orchestrator_brief") or "") != (nd.get("orchestrator_brief") or ""):
        parts.append("改了编排者职责定义")
    if (od.get("tools") or []) != (nd.get("tools") or []):
        parts.append(f"改工具（{len(od.get('tools') or [])} → {len(nd.get('tools') or [])}）")
    if (od.get("skills") or []) != (nd.get("skills") or []):
        parts.append(f"改 Skill（{len(od.get('skills') or [])} → {len(nd.get('skills') or [])}）")
    if (od.get("limits") or {}) != (nd.get("limits") or {}):
        parts.append("改了上限")
    if (od.get("runtime") or "") != (nd.get("runtime") or ""):
        parts.append("换了运行时")
    return "、".join(parts) or "细节调整"


# --------------------------------------------------------------------------- #
# 快照 / 列表 / 回滚
# --------------------------------------------------------------------------- #
async def _payload_of(session: AsyncSession, kind: str, target_id: str) -> dict[str, Any] | None:
    """把"当前状态"取成一份可回滚的载荷（**不含密钥**：凭据是环境的一部分）。"""
    if kind == KIND_AGENT:
        row = await session.get(Agent, target_id)
        if row is None:
            return None
        tools = [
            n
            for (n,) in (
                await session.execute(
                    select(Tool.name).join(AgentTool, AgentTool.tool_id == Tool.id).where(AgentTool.agent_id == target_id)
                )
            ).all()
        ]
        skills = [
            n
            for (n,) in (
                await session.execute(
                    select(Skill.name)
                    .join(AgentSkill, AgentSkill.skill_id == Skill.id)
                    .where(AgentSkill.agent_id == target_id)
                )
            ).all()
        ]
        return {
            "name": row.name,
            "description": row.description,
            "runtime": row.runtime,
            "definition": row.definition or {},
            "tool_names": sorted(tools),
            "skill_names": sorted(skills),
        }
    if kind == KIND_WORKFLOW:
        row = await session.get(Workflow, target_id)
        if row is None:
            return None
        return {
            "name": row.name,
            "description": row.description,
            "graph": row.graph or {},
            "mode_override": row.mode_override,
        }
    return None


async def snapshot(
    session: AsyncSession, kind: str, target_id: str, *, label: str = "", force: bool = False
) -> Revision | None:
    """给某个对象记一版。**内容没变就不记**（除非 force）—— 历史里全是噪声等于没有历史。"""
    payload = await _payload_of(session, kind, target_id)
    if payload is None:
        return None
    last = (
        await session.execute(
            select(Revision)
            .where(Revision.kind == kind, Revision.target_id == target_id)
            .order_by(Revision.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    version = (last.version + 1) if last else 1
    if last is not None and not force and dict(last.payload or {}) == dict(payload):
        return None
    if not label:
        label = summarize(kind, dict(last.payload) if last else None, dict(payload))
    row = Revision(
        kind=kind,
        target_id=target_id,
        version=version,
        payload=payload,
        label=label[:200],
        created_at=now_ms(),
    )
    session.add(row)
    return row


async def list_revisions(
    session: AsyncSession, kind: str, target_id: str, limit: int = 50
) -> list[Revision]:
    return list(
        (
            await session.execute(
                select(Revision)
                .where(Revision.kind == kind, Revision.target_id == target_id)
                .order_by(Revision.version.desc())
                .limit(limit)
            )
        ).scalars()
    )


async def restore(session: AsyncSession, revision: Revision) -> dict[str, Any]:
    """回到这一版 —— **新建一条快照（回滚也是前进）**，历史只增不改。"""
    payload = dict(revision.payload or {})
    if revision.kind == KIND_AGENT:
        row = await session.get(Agent, revision.target_id)
        if row is None:
            raise LookupError("这个助手已经不在了")
        row.name = str(payload.get("name") or row.name)
        row.description = payload.get("description")
        row.runtime = str(payload.get("runtime") or row.runtime)
        row.definition = dict(payload.get("definition") or {})
        row.version = (row.version or 1) + 1
        row.updated_at = now_ms()
        # 关系（工具 / Skill）也在版本里 —— 按名字接回本机现成的
        await session.execute(delete(AgentTool).where(AgentTool.agent_id == row.id))
        await session.execute(delete(AgentSkill).where(AgentSkill.agent_id == row.id))
        if payload.get("tool_names"):
            ids = (
                await session.execute(select(Tool.id).where(Tool.name.in_(payload["tool_names"])))
            ).scalars()
            for tid in ids:
                session.add(AgentTool(agent_id=row.id, tool_id=tid))
        if payload.get("skill_names"):
            ids = (
                await session.execute(select(Skill.id).where(Skill.name.in_(payload["skill_names"])))
            ).scalars()
            for sid in ids:
                session.add(AgentSkill(agent_id=row.id, skill_id=sid))
    elif revision.kind == KIND_WORKFLOW:
        row = await session.get(Workflow, revision.target_id)
        if row is None:
            raise LookupError("这份流程已经不在了")
        row.name = str(payload.get("name") or row.name)
        row.description = str(payload.get("description") or "")
        row.graph = dict(payload.get("graph") or {})
        row.mode_override = payload.get("mode_override")
        row.updated_at = now_ms()
    else:
        raise ValueError(f"不认识的对象类型：{revision.kind}")

    await session.flush()
    new_rev = await snapshot(
        session,
        revision.kind,
        revision.target_id,
        label=f"回滚到 v{revision.version}",
        force=True,
    )
    return {"version": (new_rev.version if new_rev else revision.version), "restored_from": revision.version}

async def backfill_initial(session: AsyncSession) -> int:
    """给**还没有任何版本记录**的助手 / 流程补一条起点快照。

    为什么需要：版本功能上线后，只有"新建/被编辑过"的对象才有历史 ——
    用户那些早就存在的助手点进去会看到"还没有历史"，等于这个功能对他们没生效。
    幂等（已经有记录就跳过），所以放启动时跑一次最省事。
    """
    made = 0
    for kind, model in ((KIND_AGENT, Agent), (KIND_WORKFLOW, Workflow)):
        ids = [i for (i,) in (await session.execute(select(model.id))).all()]
        if not ids:
            continue
        has = {
            tid
            for (tid,) in (
                await session.execute(
                    select(Revision.target_id).where(Revision.kind == kind, Revision.target_id.in_(ids))
                )
            ).all()
        }
        for tid in ids:
            if tid in has:
                continue
            if await snapshot(session, kind, tid):
                made += 1
    if made:
        await session.commit()
    return made
