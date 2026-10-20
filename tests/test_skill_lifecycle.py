"""技能生命周期：使用计数 / 闲置降级 / 归档 / 恢复 / 固定豁免。

这几条都是"自动整理不能闯祸"的边界，所以每条都要有断言：
* 只动助手自己攒的技能（仓库装的、手写的、导入的绝不自动归档）
* 只挪不删（正文永远在库里，恢复能重建目录）
* 固定的技能不降级、不归档、手动也归档不了
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from agent_studio.config import settings
from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Skill, now_ms
from agent_studio.skills_lifecycle import (
    ARCHIVE_AFTER_DAYS,
    STALE_AFTER_DAYS,
    DAY_MS,
    archive_skill,
    restore_skill,
    skills_dir,
    sweep,
)


def _run(coro):
    return asyncio.run(coro)


async def _mk(name: str, *, src_type: str = "agent", used_days_ago: float | None = None,
              pinned: bool = False, with_dir: bool = True) -> str:
    await init_db()
    async with SessionLocal() as db:
        row = Skill(
            name=name,
            description="测试",
            source={"type": src_type},
            content="---\nname: %s\n---\n正文" % name,
            files={},
            pinned=pinned,
            state="active",
            use_count=2,
            last_used_at=(now_ms() - int(used_days_ago * DAY_MS)) if used_days_ago is not None else None,
            created_at=now_ms(),
            updated_at=now_ms() - int((used_days_ago or 0) * DAY_MS),
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        if with_dir:
            d = skills_dir() / name
            d.mkdir(parents=True, exist_ok=True)
            (d / "SKILL.md").write_text(row.content, encoding="utf-8")
        return row.id


def test_usage_counter_bumps():
    from agent_studio.skill_usage import _bump

    sid = _run(_mk("count-me"))
    _run(_bump("count-me"))

    async def _read():
        async with SessionLocal() as db:
            return await db.get(Skill, sid)

    row = _run(_read())
    assert row.use_count == 3 and row.last_used_at


def test_sweep_marks_stale_then_archives():
    sid = _run(_mk("old-skill", used_days_ago=STALE_AFTER_DAYS + 1))

    async def _go():
        async with SessionLocal() as db:
            first = await sweep(db)
            row = await db.get(Skill, sid)
            return first, row.state

    first, state = _run(_go())
    assert state == "stale" and "old-skill" in first["stale"]

    # 再老到归档线 → 目录被挪走、正文仍在库里
    async def _go2():
        async with SessionLocal() as db:
            row = await db.get(Skill, sid)
            row.last_used_at = now_ms() - (ARCHIVE_AFTER_DAYS + 1) * DAY_MS
            await db.commit()
            second = await sweep(db)
            row = await db.get(Skill, sid)
            return second, row

    second, row = _run(_go2())
    assert "old-skill" in second["archived"]
    assert row.state == "archived" and row.archive_path
    assert not (skills_dir() / "old-skill").exists()
    assert Path(row.archive_path).exists()
    assert "正文" in row.content


def test_pinned_and_foreign_skills_are_never_touched():
    pin_id = _run(_mk("pinned-one", used_days_ago=ARCHIVE_AFTER_DAYS + 5, pinned=True))
    repo_id = _run(_mk("repo-one", src_type="repo", used_days_ago=ARCHIVE_AFTER_DAYS + 5))

    async def _go():
        async with SessionLocal() as db:
            await sweep(db)
            a = await db.get(Skill, pin_id)
            b = await db.get(Skill, repo_id)
            return a.state, b.state, a.pinned

    state_pin, state_repo, pinned = _run(_go())
    assert state_pin == "active" and pinned is True
    assert state_repo == "active", "仓库装的技能不许自动归档"


def test_restore_rebuilds_directory():
    sid = _run(_mk("restore-me", used_days_ago=ARCHIVE_AFTER_DAYS + 2))

    async def _archive_then_restore():
        async with SessionLocal() as db:
            row = await db.get(Skill, sid)
            await archive_skill(db, row)
            await db.commit()
            assert not (skills_dir() / "restore-me").exists()
            await restore_skill(db, row)
            await db.commit()
            return row

    row = _run(_archive_then_restore())
    assert row.state == "active" and row.archive_path == ""
    md = skills_dir() / "restore-me" / "SKILL.md"
    assert md.exists() and "正文" in md.read_text(encoding="utf-8")


def test_restore_survives_lost_directory():
    """目录被人手删了也能恢复：正文在库里，按正文重建。"""
    sid = _run(_mk("lost-dir"))

    async def _go():
        async with SessionLocal() as db:
            row = await db.get(Skill, sid)
            import shutil

            shutil.rmtree(skills_dir() / "lost-dir")
            await restore_skill(db, row)
            await db.commit()
            return row

    _run(_go())
    assert (skills_dir() / "lost-dir" / "SKILL.md").exists()


async def test_api_lifecycle_pin_archive_restore(client):
    sid = await _mk("api-skill", used_days_ago=STALE_AFTER_DAYS + 2)

    got = await client.get("/api/skills/lifecycle")
    assert got.status_code == 200
    body = got.json()
    assert body["stats"]["total"] >= 1
    assert body["thresholds"]["stale_days"] == STALE_AFTER_DAYS

    await client.post(f"/api/skills/{sid}/pin", json={"pinned": True})
    blocked = await client.post(f"/api/skills/{sid}/archive")
    assert blocked.status_code == 409, "固定的技能不能直接归档"

    await client.post(f"/api/skills/{sid}/pin", json={"pinned": False})
    archived = await client.post(f"/api/skills/{sid}/archive")
    assert archived.status_code == 200 and archived.json()["state"] == "archived"

    restored = await client.post(f"/api/skills/{sid}/restore")
    assert restored.status_code == 200 and restored.json()["state"] == "active"


def test_lifecycle_stats_shape():
    rows = [
        Skill(id="a", name="a", source={"type": "agent"}, state="active"),
        Skill(id="b", name="b", source={"type": "agent"}, state="stale", pinned=True),
        Skill(id="c", name="c", source={"type": "repo"}, state="archived"),
    ]
    from agent_studio.skills_lifecycle import stats

    out = stats(rows)
    assert out == {"total": 3, "active": 1, "stale": 1, "archived": 1, "pinned": 1, "agent": 2}
