"""编排快照：把「这次跑的到底是谁、第几版」钉进 spec。

为什么只有 ``agent_id`` 不够
----------------------------
* 助手会被改（v4 → v5），编排历史里看不出当时用的是哪一版 —— 复盘时
  「它当时明明没有这个工具」这类争议没有依据。
* 单步 run 里确实冻结了 ``definition_snapshot``，但要从**编排**记录看出
  「当时团队的构成」，得逐个去翻子 run；子 run 还会被定期清理。
* 技能绑定也会变。想回答「当时它挂了哪几个技能」，只能靠快照。

``hash`` 只覆盖**结构**（模式、谁在第几位、怎么连），不含任务文本与时间 ——
这样才能回答真正有用的那个问题：「这份编排跟上次跑的是同一份吗」。

技能只记**名字**（目录级），不记全文：这里的作用是"知道它能干什么"，
不是"把技能抄进提示词"。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Agent, AgentSkill, Skill

#: 快照格式版本。以后加减字段时自增，老记录仍按老版本解释
FREEZE_VERSION = 1

#: 结构指纹只认真的这些字段（顺序无关，排序后再算）
_STRUCT_KEYS = ("mode", "worker_mode", "master_agent_id", "master_nid")


def _structure(spec: dict[str, Any]) -> dict[str, Any]:
    """抽出"结构"部分：模式 + 参与者顺序/连线。不含任务、时间、判据。"""
    struct: dict[str, Any] = {k: spec.get(k) for k in _STRUCT_KEYS if spec.get(k) is not None}
    if "nodes" in spec:  # dag
        struct["nodes"] = [[n.get("nid"), n.get("agent_id")] for n in spec.get("nodes") or []]
        struct["edges"] = [[e.get("from"), e.get("to")] for e in spec.get("edges") or []]
    if "steps" in spec:
        struct["steps"] = [
            [s.get("nid"), s.get("agent_id"), bool(s.get("carry_prev"))]
            for s in spec.get("steps") or []
        ]
    return struct


def structure_hash(spec: dict[str, Any]) -> str:
    """结构指纹：同一份编排（同样的参与者、同样的顺序）永远算出同一个值。"""
    blob = json.dumps(_structure(spec), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]


def _agent_ids(spec: dict[str, Any]) -> list[str]:
    ids: list[str] = []
    mid = spec.get("master_agent_id")
    if mid:
        ids.append(str(mid))
    for s in spec.get("steps") or []:
        if s.get("agent_id"):
            ids.append(str(s["agent_id"]))
    for n in spec.get("nodes") or []:
        if n.get("agent_id"):
            ids.append(str(n["agent_id"]))
    # 编排者自己挑人的场景：备选名单也要进快照（否则复盘时看不出"当时能挑谁"）
    for a in spec.get("roster") or []:
        if a:
            ids.append(str(a))
    return list(dict.fromkeys(ids))


async def freeze_spec(session: AsyncSession, spec: dict[str, Any]) -> dict[str, Any]:
    """给 spec 补上快照（原地改一份拷贝后返回，调用方拿返回值去存/去跑）。

    查不到某个助手时不报错 —— 编排都快开始了，宁可少一条名字也不要在这里 500。
    但会留下 ``name=None``，界面上能看出"这位当时已经没了"。
    """
    ids = _agent_ids(spec)
    agents: dict[str, Agent] = {}
    if ids:
        rows = (await session.execute(select(Agent).where(Agent.id.in_(ids)))).scalars().all()
        agents = {a.id: a for a in rows}

    skills: dict[str, list[str]] = {}
    if ids:
        rows_s = (
            await session.execute(
                select(AgentSkill.agent_id, Skill.name)
                .join(Skill, Skill.id == AgentSkill.skill_id)
                .where(AgentSkill.agent_id.in_(ids))
            )
        ).all()
        for aid, name in rows_s:
            skills.setdefault(aid, []).append(str(name))

    def snap(aid: str) -> dict[str, Any]:
        a = agents.get(aid)
        return {
            "agent_id": aid,
            "name": a.name if a else None,
            "version": a.version if a else None,
            # 一句话职责（截断）：主控拆任务要看这个才知道该派给谁
            "desc": ((a.description or "").strip()[:120] if a else ""),
            "skills": sorted(skills.get(aid, [])),
        }

    out = dict(spec)
    if out.get("steps"):
        out["steps"] = [{**s, "agent": snap(str(s.get("agent_id") or ""))} for s in out["steps"]]
    if out.get("nodes"):
        out["nodes"] = [{**n, "agent": snap(str(n.get("agent_id") or ""))} for n in out["nodes"]]
    out["snapshot"] = {
        "v": FREEZE_VERSION,
        "hash": structure_hash(spec),
        "agents": {aid: snap(aid) for aid in ids},
    }
    return out


def team_catalog(spec: dict[str, Any], limit_desc: int = 40, limit_skills: int = 5) -> str:
    """给主控（编排者）的「团队花名册」：一行一位，只说名字 / 一句话用途 / 技能名。

    刻意只到技能**名字**：把每个技能的全文注进主控的提示词，等于让它去干活的活，
    拆任务的这一步会被技能细节淹没（而且提示词会长到不可控）。
    """
    entries: list[str] = []
    seen: set[str] = set()
    for s in spec.get("steps") or []:
        a = (s.get("agent") or {}) if isinstance(s.get("agent"), dict) else {}
        aid = str(a.get("agent_id") or s.get("agent_id") or "")
        if not aid or aid in seen:
            continue
        seen.add(aid)
        entries.append(_line(len(entries) + 1, a, limit_desc, limit_skills))
    if not entries:
        # 编排者自己挑人：花名册就是当时那份备选名单
        for a in (spec.get("snapshot") or {}).get("agents", {}).values():
            aid = str((a or {}).get("agent_id") or "")
            if not aid or aid in seen:
                continue
            seen.add(aid)
            entries.append(_line(len(entries) + 1, a, limit_desc, limit_skills))
    if not entries:
        for n in spec.get("nodes") or []:
            a = (n.get("agent") or {}) if isinstance(n.get("agent"), dict) else {}
            aid = str(a.get("agent_id") or n.get("agent_id") or "")
            if not aid or aid in seen:
                continue
            seen.add(aid)
            entries.append(_line(len(entries) + 1, a, limit_desc, limit_skills))
    return "\n".join(entries)


def _line(idx: int, agent: dict[str, Any], limit_desc: int, limit_skills: int) -> str:
    name = agent.get("name") or agent.get("agent_id") or "未命名助手"
    desc = str(agent.get("desc") or "").strip()
    skills = [str(x) for x in (agent.get("skills") or [])]
    tail = ""
    if skills:
        shown = "、".join(skills[:limit_skills])
        more = f" 等 {len(skills)} 个" if len(skills) > limit_skills else ""
        tail = f" · 技能：{shown}{more}"
    if desc and len(desc) > limit_desc:
        desc = desc[: limit_desc - 1] + "…"
    return f"{idx}. {name}：{desc}{tail}" if desc else f"{idx}. {name}{tail}"
