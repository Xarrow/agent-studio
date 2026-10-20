"""skill_save：把对话里摸出来的做法沉淀成全局技能。

语义验收点：
  1. 存下来的技能**同时**进库、落盘（只进库 = 助手看不见）
  2. frontmatter 里的 name/description 与入参一致（以后靠 description 认出来）
  3. 同名默认不覆盖 —— 技能是长期资产，不能被随手冲掉
  4. overwrite=True 才更新
  5. 名字里的路径符号被清掉（**不允许写出目录**）
  6. 空名 / 空正文 / 超长 都被挡下并给出人话
  7. 存完自动挂给发起它的那个助手（下一轮就能用）
"""

from __future__ import annotations

import json

from sqlalchemy import delete, select

from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Agent, AgentSkill, Skill
from agent_studio.native_tools import _skill_save, _skill_slug
from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx


async def _seed_agent(agent_id: str = "ag_skilltest00001", name: str = "沉淀测试助手") -> str:
    await init_db()
    async with SessionLocal() as db:
        if await db.get(Agent, agent_id) is None:
            db.add(Agent(id=agent_id, slug="skill-test", name=name, runtime="agentscope", version=1, definition={}))
            await db.commit()
    return agent_id


async def _cleanup(name: str) -> None:
    await init_db()
    async with SessionLocal() as db:
        row = (await db.execute(select(Skill).where(Skill.name == name))).scalar_one_or_none()
        if row is not None:
            await db.execute(delete(AgentSkill).where(AgentSkill.skill_id == row.id))
            await db.delete(row)
            await db.commit()


def test_名字里的路径符号被清掉():
    assert _skill_slug("../../etc/passwd") == "etc-passwd"
    assert _skill_slug("Deploy Static Site") == "deploy-static-site"
    assert _skill_slug("部署静态站点") == "部署静态站点"
    assert _skill_slug("///") == ""


async def test_存下来既进库又落盘():
    await _cleanup("skill-save-demo")
    out = json.loads(
        await _skill_save(
            name="skill-save-demo",
            description="演示用：把一段做法存成技能",
            body="# 步骤\n\n1. 先看现状\n2. 再动手\n",
        )
    )
    assert out["ok"] and out["action"] == "新建"
    async with SessionLocal() as db:
        row = (await db.execute(select(Skill).where(Skill.name == "skill-save-demo"))).scalar_one()
    assert row.content.startswith("---\nname: skill-save-demo")
    assert "description: 演示用" in row.content
    from pathlib import Path

    skill_file = Path(out["path"]) / "SKILL.md"
    assert skill_file.is_file()
    assert "1. 先看现状" in skill_file.read_text(encoding="utf-8")
    await _cleanup("skill-save-demo")


async def test_同名默认不覆盖_要覆盖得显式说():
    await _cleanup("skill-save-dup")
    first = json.loads(
        await _skill_save(name="skill-save-dup", description="第一版", body="旧的做法")
    )
    again = await _skill_save(name="skill-save-dup", description="第二版", body="新的做法")
    assert "已经有同名技能" in again
    async with SessionLocal() as db:
        row = (await db.execute(select(Skill).where(Skill.name == "skill-save-dup"))).scalar_one()
    assert "旧的做法" in row.content

    out = json.loads(
        await _skill_save(name="skill-save-dup", description="第二版", body="新的做法", overwrite=True)
    )
    assert out["action"] == "更新" and out["id"] == first["id"]
    async with SessionLocal() as db:
        row = (await db.execute(select(Skill).where(Skill.name == "skill-save-dup"))).scalar_one()
    assert "新的做法" in row.content
    await _cleanup("skill-save-dup")


async def test_空的和太长的都挡下():
    assert "技能名不能用" in await _skill_save(name="///", description="x", body="y")
    assert "什么时候用它" in await _skill_save(name="ok-name", description="  ", body="y")
    assert "正文是空的" in await _skill_save(name="ok-name", description="d", body="   ")
    long_body = "x" * 20001
    assert "超过上限" in await _skill_save(name="ok-name", description="d", body=long_body)


async def test_自动挂给发起它的助手():
    await _cleanup("skill-save-mount")
    aid = await _seed_agent()
    set_run_ctx(agent_id=aid, session_id="ses_x", run_id="run_x")
    try:
        out = json.loads(
            await _skill_save(name="skill-save-mount", description="挂载测试", body="做法")
        )
    finally:
        clear_run_ctx()
    assert out["mounted_to_caller"] is True
    async with SessionLocal() as db:
        rows = (
            await db.execute(select(AgentSkill.skill_id).where(AgentSkill.agent_id == aid))
        ).scalars().all()
    assert out["id"] in rows
    async with SessionLocal() as db:
        await db.execute(delete(AgentSkill).where(AgentSkill.agent_id == aid))
        await db.commit()
    await _cleanup("skill-save-mount")
