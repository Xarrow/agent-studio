"""编排快照：这次到底是谁、第几版。

为什么值得单独测：这两件事都是**事后**才被用到（复盘"当时它是不是有这个技能"、
"跟上次跑的是不是同一份编排"），出错时没人当场看得见。
"""

from __future__ import annotations

import uuid

from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Agent, AgentSkill, Skill
from agent_studio.orchestrator.service import _PLAN_PROMPT
from agent_studio.orchestrator.snapshot import freeze_spec, structure_hash, team_catalog


def uniq(p: str) -> str:
    return f"{p}-{uuid.uuid4().hex[:8]}"


def _spec(*agent_ids: str, mode: str = "master_worker", master: str | None = None) -> dict:
    return {
        "mode": mode,
        "master_agent_id": master,
        "steps": [{"agent_id": a, "carry_prev": False} for a in agent_ids],
        "task": "把这件事办了",
    }


async def _agent(name: str, desc: str) -> str:
    async with SessionLocal() as s:
        a = Agent(
            slug=uniq("slug"),
            name=name,
            description=desc,
            runtime="agentscope",
            definition={"runtime": "agentscope", "name": name, "tools": [], "skills": []},
        )
        s.add(a)
        await s.commit()
        await s.refresh(a)
        return a.id


async def test_快照记住名字版本与技能名():
    await init_db()
    aid = await _agent("周报助手", "把零散记录整理成周报")
    sid = uniq("sk")
    async with SessionLocal() as s:
        sk = Skill(id=sid, name=uniq("weekly"), state="active", description="周报技能")
        s.add(sk)
        await s.flush()
        s.add(AgentSkill(agent_id=aid, skill_id=sid))
        await s.commit()

    async with SessionLocal() as s:
        frozen = await freeze_spec(s, _spec(aid))

    step = frozen["steps"][0]["agent"]
    assert step["name"] == "周报助手"
    assert step["version"] == 1
    assert step["desc"]
    assert step["skills"] and step["skills"][0].startswith("weekly-")
    assert frozen["snapshot"]["v"] == 1
    assert len(frozen["snapshot"]["hash"]) == 12


async def test_结构指纹只看结构_不看任务文本():
    await init_db()
    a, b = await _agent("甲", ""), await _agent("乙", "")
    async with SessionLocal() as s:
        h1 = structure_hash(_spec(a, b))
        spec2 = _spec(a, b)
        spec2["task"] = "完全不同的任务，时间也不一样"
        h2 = structure_hash(spec2)
        # 顺序变了就是另一份编排
        h3 = structure_hash(_spec(b, a))
    assert h1 == h2, "任务文本不该影响结构指纹"
    assert h1 != h3, "参与者顺序变了，必须算两份"


async def test_助手被删了也不炸_留个空名字():
    await init_db()
    async with SessionLocal() as s:
        frozen = await freeze_spec(s, _spec("ag_不存在的"))
    assert frozen["steps"][0]["agent"]["name"] is None
    assert frozen["snapshot"]["agents"]["ag_不存在的"]["version"] is None


async def test_花名册只给名字和技能名_不给技能全文():
    await init_db()
    a = await _agent("编程助手", "改代码、跑测试")
    async with SessionLocal() as s:
        frozen = await freeze_spec(s, _spec(a))
    text = team_catalog(frozen)
    assert "编程助手" in text
    assert "改代码" in text
    assert "SKILL.md" not in text and "## " not in text, "花名册不该包含任何技能正文"


async def test_主控的拆解提示词里带着花名册():
    assert "{team}" in _PLAN_PROMPT, "模板必须留出花名册的位置，否则注进去也没人看"
    text = _PLAN_PROMPT.format(task="随便", n=2, team="1. 甲：做事\n2. 乙：做别的事")
    assert "1. 甲：做事" in text


async def test_发起编排时真的把快照落进库(client):
    await init_db()
    a = await _agent("落库助手", "看看")
    r = await client.post(
        "/api/orchestrations",
        json={"mode": "single", "steps": [{"agent_id": a, "carry_prev": False}], "task": "跑一下"},
    )
    assert r.status_code == 201, r.text
    orc_id = r.json()["id"]

    detail = (await client.get(f"/api/orchestrations/{orc_id}")).json()
    snap = detail["spec"].get("snapshot")
    assert snap and snap["v"] == 1
    assert detail["spec"]["steps"][0]["agent"]["name"] == "落库助手"
