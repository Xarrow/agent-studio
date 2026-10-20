"""挂载关系的外键护栏：写错 id 要 400 说清是哪个，不能 500。"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from agent_studio.api.agents import _sync_relations
from agent_studio.db import SessionLocal, init_db
from agent_studio.schemas import AgentDefinition, SkillRef, ToolRef


async def _defn(**kw) -> AgentDefinition:
    return AgentDefinition(name="关系护栏", system_prompt="x", **kw)


async def test_引用不存在的技能要说清是哪个():
    """现场：换一套环境的库里技能 id 不存在 → 插入关联表撞外键 → 500，
    用户只看到 Internal Server Error，根本猜不到是哪个 id。"""
    await init_db()
    async with SessionLocal() as db:
        with pytest.raises(HTTPException) as ei:
            await _sync_relations(db, "ag_不存在", await _defn(skills=[SkillRef(ref="sk_nope1234")]))
    assert ei.value.status_code == 400
    assert "sk_nope1234" in ei.value.detail


async def test_引用不存在的工具要说清是哪个():
    await init_db()
    async with SessionLocal() as db:
        with pytest.raises(HTTPException) as ei:
            await _sync_relations(db, "ag_不存在", await _defn(tools=[ToolRef(ref="tl_nope1234")]))
    assert ei.value.status_code == 400
    assert "tl_nope1234" in ei.value.detail


async def test_关掉的工具不去校验():
    """enabled=False 的引用本来就不写库，不该因为它不存在而报错。"""
    await init_db()
    async with SessionLocal() as db:
        await _sync_relations(
            db, "ag_不存在", await _defn(tools=[ToolRef(ref="tl_nope1234", enabled=False)])
        )
