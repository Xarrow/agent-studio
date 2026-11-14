"""两级归属：来源 → 技能；同名跨仓库隔离；整仓检查/同步/卸载。"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_studio.models import Skill
from fixtures_skills import skill_tree

pytestmark = pytest.mark.anyio


async def _install(client, repo: Path, skills: list[str] | None = None):
    r = await client.post("/api/skills/remote/install", json={"ref": str(repo), "skills": skills})
    assert r.status_code == 201, r.text
    return r.json()


async def test_install_registers_source_and_groups(client, tmp_path: Path):
    repo = skill_tree(tmp_path / "repo-a", {"two-alpha": "甲", "two-beta": "乙"})
    await _install(client, repo)

    g = (await client.get("/api/skills/grouped")).json()
    assert g["total"] >= 2
    group = next(x for x in g["groups"] if any(s["name"] == "two-alpha" for s in x["skills"]))
    assert group["counts"]["installed"] >= 2
    assert group["source_id"], "安装时应自动登记来源"


async def test_same_name_two_repos_do_not_overwrite(client, tmp_path: Path):
    a = skill_tree(tmp_path / "repo-one", {"two-animate": "来自仓库一"})
    b = skill_tree(tmp_path / "repo-two", {"two-animate": "来自仓库二"})
    await _install(client, a)
    await _install(client, b, ["two-animate"])

    rows = (await client.get("/api/skills", params={"q": "two-animate"})).json()
    hits = [r for r in rows if r["name"] == "two-animate"]
    assert len(hits) == 2, "同名跨仓库必须是两条记录"
    keys = {h["source"].get("source_key") for h in hits}
    assert len(keys) == 2 and "" not in keys
    dirs = {h.get("dir_name") or h["name"] for h in hits}
    assert len(dirs) == 2, "落盘目录必须隔离，否则互相覆盖"


async def test_source_check_reports_changed(client, tmp_path: Path):
    repo = skill_tree(tmp_path / "repo-c", {"two-gamma": "伽马"})
    await _install(client, repo)
    g = (await client.get("/api/skills/grouped")).json()
    sid = next(x["source_id"] for x in g["groups"] if any(s["name"] == "two-gamma" for s in x["skills"]))

    md = repo / "skills" / "two-gamma" / "SKILL.md"
    md.write_text(md.read_text(encoding="utf-8") + "\n新内容\n", encoding="utf-8")

    r = await client.post(f"/api/skill-sources/{sid}/check")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ok"
    assert body["has_update"] is True and "two-gamma" in body["changed"]


async def test_source_sync_updates_all(client, tmp_path: Path):
    repo = skill_tree(tmp_path / "repo-d", {"two-delta": "德尔塔", "two-epsilon": "艾普西龙"})
    await _install(client, repo)
    g = (await client.get("/api/skills/grouped")).json()
    sid = next(x["source_id"] for x in g["groups"] if any(s["name"] == "two-delta" for s in x["skills"]))

    for name in ("two-delta", "two-epsilon"):
        md = repo / "skills" / name / "SKILL.md"
        md.write_text(md.read_text(encoding="utf-8") + f"\n{name} 更新\n", encoding="utf-8")

    r = await client.post(f"/api/skill-sources/{sid}/sync")
    assert r.status_code == 200, r.text
    assert r.json()["count"] >= 2
    rows = (await client.get("/api/skills", params={"q": "two-delta"})).json()
    detail = next(r for r in rows if r["name"] == "two-delta")
    full = (await client.get(f"/api/skills/{detail['id']}")).json()
    assert "two-delta 更新" in full["content"]


async def test_group_state_toggle_and_uninstall(client, tmp_path: Path):
    repo = skill_tree(tmp_path / "repo-e", {"two-zeta": "泽塔", "two-eta": "伊塔"})
    await _install(client, repo)
    g = (await client.get("/api/skills/grouped")).json()
    sid = next(x["source_id"] for x in g["groups"] if any(s["name"] == "two-zeta" for s in x["skills"]))

    off = await client.post(f"/api/skill-sources/{sid}/state", json={"state": "archived"})
    assert off.json()["count"] >= 2
    g2 = (await client.get("/api/skills/grouped")).json()
    grp = next(x for x in g2["groups"] if x["source_id"] == sid)
    assert all(s["state"] == "archived" for s in grp["skills"])

    un = await client.post(f"/api/skill-sources/{sid}/uninstall")
    assert un.json()["count"] >= 2
    names = [r["name"] for r in (await client.get("/api/skills")).json()]
    assert "two-zeta" not in names
