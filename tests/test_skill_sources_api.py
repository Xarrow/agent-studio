"""接口层：来源登记、浏览、安装（走真实导入管线）、检查更新、设置、模式选择。"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from agent_studio.skill_sources import service
from fixtures_skills import SKILL_MD, make_git_repo, skill_tree

pytestmark = pytest.mark.anyio


async def test_parse_endpoint(client):
    r = await client.get("/api/skills/parse", params={"q": "acme/skills/skills@ui"})
    body = r.json()
    assert body["ok"] and body["ref"]["slug"] == "acme/skills"
    assert body["ref"]["subpath"] == "skills" and body["ref"]["skill"] == "ui"


async def test_parse_endpoint_error(client):
    r = await client.get("/api/skills/parse", params={"q": "file:///etc/passwd"})
    assert r.json()["ok"] is False
    assert r.json()["code"] == "invalid_source"


async def test_source_crud_and_browse(client, tmp_path: Path):
    root = skill_tree(tmp_path / "repo", {"ui-kit": "界面组件规范"})
    r = await client.post("/api/skill-sources", json={"address": str(root), "name": "本地测试源", "priority": 5})
    assert r.status_code == 201, r.text
    sid = r.json()["id"]
    assert r.json()["kind"] == "local"
    assert "token" not in r.json()

    lst = (await client.get("/api/skill-sources")).json()
    assert any(x["id"] == sid for x in lst)

    b = await client.post(f"/api/skill-sources/{sid}/browse")
    assert b.status_code == 200, b.text
    names = [s["name"] for s in b.json()["skills"]]
    assert "ui-kit" in names

    e = await client.put(f"/api/skill-sources/{sid}", json={"address": str(root), "name": "改名了", "enabled": False})
    assert e.json()["name"] == "改名了" and e.json()["enabled"] is False

    d = await client.delete(f"/api/skill-sources/{sid}")
    assert d.status_code == 204
    assert all(x["id"] != sid for x in (await client.get("/api/skill-sources")).json())


async def test_install_from_local_source(client, tmp_path: Path):
    root = skill_tree(tmp_path / "repo", {"only-one": "只有一个技能"})
    r = await client.post("/api/skills/remote/install", json={"ref": str(root), "dry_run": True})
    assert r.status_code == 201, r.text
    plan = r.json()["plan"]
    assert any(p["name"] == "only-one" for p in plan)

    r2 = await client.post("/api/skills/remote/install", json={"ref": str(root), "skills": ["only-one"]})
    assert r2.status_code == 201, r2.text
    body = r2.json()
    assert body["installed"] and body["meta"]["via"] == "local"

    skills = (await client.get("/api/skills", params={"q": "only-one"})).json()
    row = next(x for x in skills if x["name"] == "only-one")
    assert row["source"]["type"] in ("repo", "local")
    # 落盘：运行时读的是磁盘
    disk = Path(row.get("disk_path") or "")
    assert row.get("id")


async def test_install_preview_matches_install(client, tmp_path: Path):
    root = skill_tree(tmp_path / "repo", {"a1": "甲", "b2": "乙"})
    scan = (await client.post("/api/skills/remote/scan", json={"ref": str(root)})).json()
    assert {s["name"] for s in scan["skills"]} == {"a1", "b2"}
    assert scan["meta"]["via"] == "local"


async def test_check_updates_two_level_rule(client, tmp_path: Path, monkeypatch):
    root = skill_tree(tmp_path / "repo", {"upd": "会被更新的"})
    sha1 = make_git_repo(root)
    r = await client.post("/api/skills/remote/install", json={"ref": str(root), "skills": ["upd"]})
    assert r.status_code == 201, r.text
    skill = (await client.get("/api/skills", params={"q": "upd"})).json()[0]

    # 1) 提交变了、内容没变 → 不算更新
    monkeypatch.setattr(service.fetchmod, "resolve_commit", _fake_commit("b" * 40))

    async def _same(*a, **k):
        class Fetched:
            def __init__(self):
                self.root = root
                self.commit = "b" * 40
                self.integrity = "verified"
                self.via = "git"
                self.url_used = ""
                self.notes = []

            def cleanup(self):
                return None

        return Fetched()

    monkeypatch.setattr(service.fetchmod, "fetch", _same)
    items = (await client.get("/api/skills/updates", params={"force": True})).json()["items"]
    mine = next(i for i in items if i["id"] == skill["id"])
    assert mine["has_update"] is False

    # 2) 内容也变了 → 才算有更新
    md = root / "skills" / "upd" / "SKILL.md"
    md.write_text(md.read_text(encoding="utf-8") + "\n新的指令\n", encoding="utf-8")
    items2 = (await client.get("/api/skills/updates", params={"force": True})).json()["items"]
    mine2 = next(i for i in items2 if i["id"] == skill["id"])
    assert mine2["has_update"] is True

    # 3) 更新落库
    u = await client.post(f"/api/skills/{skill['id']}/update")
    assert u.status_code == 200, u.text
    assert "新的指令" in (await client.get(f"/api/skills/{skill['id']}")).json()["content"]


def _fake_commit(sha: str):
    async def _fn(*a, **k):
        return sha

    return _fn


async def test_settings_roundtrip_and_mode(client):
    r = await client.put("/api/skills/remote/settings", json={"mode": "native", "check_interval_h": 2})
    body = r.json()
    assert body["mode"] == "native"
    assert body["check_interval_h"] == 2.0
    assert body["net_policy"]["proxy_mode"] in ("system", "env", "manual", "off")
    assert "password" not in str(body["net_policy"]).lower()

    bad = await client.put("/api/skills/remote/settings", json={"mode": "wat"})
    assert bad.status_code == 400

    await client.put("/api/skills/remote/settings", json={"mode": "auto"})


async def test_npx_mode_without_pin_prefers_native(client, monkeypatch):
    monkeypatch.setattr(service, "probe_environment", lambda refresh=False: {"npx": "/usr/bin/npx", "npm": "/usr/bin/npm", "git": "/usr/bin/git", "node": "/usr/bin/node", "versions": {}})
    await client.put("/api/skills/remote/settings", json={"mode": "auto", "npx_pin": ""})
    s = (await client.get("/api/skills/remote/settings")).json()
    assert s["effective_mode"][0] == "native"


async def test_npx_mode_pinned_uses_npx(client, monkeypatch):
    monkeypatch.setattr(service, "probe_environment", lambda refresh=False: {"npx": "/usr/bin/npx", "npm": "", "git": "", "node": "", "versions": {}})
    await client.put("/api/skills/remote/settings", json={"mode": "auto", "npx_pin": "skills@9.9.9"})
    s = (await client.get("/api/skills/remote/settings")).json()
    assert s["effective_mode"][0] == "npx"


async def test_npx_delegate_rejects_unknown_flags(client):
    from agent_studio.skill_sources.service import _validate_npx_argv

    with pytest.raises(ValueError):
        _validate_npx_argv("add", ["--evil"])
    with pytest.raises(ValueError):
        _validate_npx_argv("rm -rf", [])
    _validate_npx_argv("add", ["--skill", "x", "--yes"])


async def test_doctor_reports_steps(client):
    d = (await client.get("/api/skills/doctor", params={"host": "127.0.0.1"})).json()
    assert d["steps"][0]["step"] == "dns"
    assert "policy" in d and "password" not in str(d["policy"]).lower()


async def test_npx_delegation_refuses_without_sandbox(client, monkeypatch):
    """没有沙箱命令时必须拒绝 —— 它会写进用户真实技能目录（含 Hermes 的 ~/.hermes/skills）。"""
    from agent_studio.db import SessionLocal

    monkeypatch.setattr(
        service,
        "probe_environment",
        lambda refresh=False: {"npx": "/usr/bin/npx", "npm": "", "git": "", "node": "", "versions": {}},
    )
    await client.put("/api/skills/remote/settings", json={"mode": "npx", "npx_pin": "skills@1.8.1"})
    async with SessionLocal() as session:
        with pytest.raises(RuntimeError) as ei:
            await service.run_via_npx(session, "acme/skills")
    assert "npx_sandbox_required" in str(ei.value)


async def test_sandbox_command_is_prefixed(client, monkeypatch):
    """配了沙箱命令时，npx 调用必须被包在它后面（而不是直接跑）。"""
    import asyncio
    from agent_studio.db import SessionLocal

    seen: dict[str, list[str]] = {}

    class FakeProc:
        returncode = 0

        async def communicate(self):
            return b"ok", b""

    async def fake_exec(*argv, **kw):
        seen["argv"] = list(argv)
        return FakeProc()

    monkeypatch.setattr(service.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(
        service, "probe_environment",
        lambda refresh=False: {"npx": "/usr/bin/npx", "npm": "", "git": "", "node": "", "versions": {}},
    )
    await client.put(
        "/api/skills/remote/settings",
        json={"mode": "npx", "npx_pin": "skills@1.8.1", "net_policy": {}},
    )
    async with SessionLocal() as session:
        from agent_studio.settings_store import set_setting

        await set_setting(session, "skills_npx_sandbox_cmd", "bwrap --dev-bind / /")
        await session.commit()
        await service.run_via_npx(session, "acme/skills", extra_argv=["--skill", "x"])
    argv = seen["argv"]
    assert argv[:3] == ["bwrap", "--dev-bind", "/"]
    assert "/usr/bin/npx" in argv and "skills" in argv and "acme/skills" in argv
