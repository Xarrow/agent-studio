"""删技能：库里删掉的同时，工作目录里那份落盘也必须消失。

踩到的现场：删了 zeit-notes 的上传技能，`/api/skills` 列表里没了，但
`data/work/skills/upload-zeit-notes/` 还在 —— 工作目录里永远挂着一份「不存在的
技能」，看起来像「删不掉」，也会被当成工作区文件列出来。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import delete, select

from agent_studio.config import settings
from agent_studio.db import SessionLocal, init_db
from agent_studio.models import AgentSkill, Skill

NAME = "delete-me-demo"


@pytest.fixture(autouse=True)
async def _sandbox_work(tmp_path, monkeypatch):
    """把工作目录指到临时沙箱，别动真实 data/work。"""
    await init_db()
    monkeypatch.setattr(settings, "work_dir", tmp_path)
    async with SessionLocal() as db:
        row = (await db.execute(select(Skill).where(Skill.name == NAME))).scalar_one_or_none()
        if row is not None:
            await db.execute(delete(AgentSkill).where(AgentSkill.skill_id == row.id))
            await db.delete(row)
            await db.commit()
    yield tmp_path


async def test_删技能同时清掉磁盘目录(client, _sandbox_work: Path):
    md = "# 演示技能\n\n正文\n"
    r = await client.post(
        "/api/skills/import",
        json={"content": f"---\nname: {NAME}\ndescription: 演示\n---\n\n{md}", "source": "inline"},
    )
    assert r.status_code in (200, 201), r.text
    skill_id = r.json()["items"][0]["id"]

    on_disk = _sandbox_work / "skills" / NAME
    assert (on_disk / "SKILL.md").is_file(), "导入后应当落盘（否则助手看不见）"

    d = await client.delete(f"/api/skills/{skill_id}")
    assert d.status_code == 204

    assert not on_disk.exists(), "库里删了，落盘目录也必须一起清掉"
    async with SessionLocal() as db:
        assert (await db.execute(select(Skill).where(Skill.name == NAME))).scalar_one_or_none() is None


async def test_删技能不会动技能库以外的目录(client, _sandbox_work: Path):
    """同名目录如果不在技能库下（例如有人手工建了个同名目录），不许被连带删。"""
    outside = _sandbox_work / NAME
    outside.mkdir(parents=True)
    (outside / "keep.txt").write_text("别删我", encoding="utf-8")

    r = await client.post(
        "/api/skills/import",
        json={"content": f"---\nname: {NAME}\ndescription: 演示\n---\n\n正文\n", "source": "inline"},
    )
    skill_id = r.json()["items"][0]["id"]
    await client.delete(f"/api/skills/{skill_id}")

    assert (outside / "keep.txt").is_file(), "只该删技能库里的那份"
