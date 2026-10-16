"""从仓库安装 skill 的接口行为（不打网络：把下载与元信息查询替身化）。

守的是用户提的那条用法：``npx skills add tt-a1i/archify`` —— 一条引用进来，
平台自己发现技能、给预览、装进库里并**落盘**（不落盘 = 助手看不见）。
"""

from __future__ import annotations

import io
import tarfile

import pytest

from agent_studio.api import skills as skills_api
from agent_studio.models import Skill
from agent_studio.skills_repo import SkillEntry, parse_skill_md


def _tarball(files: dict[str, str], root: str = "archify-" + "a" * 40) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for rel, content in files.items():
            raw = content.encode()
            info = tarfile.TarInfo(f"{root}/{rel}")
            info.size = len(raw)
            tf.addfile(info, io.BytesIO(raw))
    return buf.getvalue()


ARCHIFY = """---
name: archify
description: 把架构/流程/时序需求变成可交互的 HTML 图
---

# Archify

正文很长，不该常驻提示词。
"""

MULTI = {
    "skills/web-design/SKILL.md": "---\nname: web-design\ndescription: 网页设计\n---\n\n正文\n",
    "skills/data-viz/SKILL.md": "---\nname: data-viz\ndescription: 数据可视化\n---\n\n正文\n",
}

FAKE_SHA = "b" * 40


@pytest.fixture(autouse=True)
async def _clean_skills(client):
    """技能表在同一 session 里是共享的 —— 每个用例开跑前清空，断言才不会被上一条污染。"""
    for s in (await client.get("/api/skills")).json():
        await client.delete(f"/api/skills/{s['id']}")
    yield


@pytest.fixture
def offline(monkeypatch):
    """把「下载仓库」和「查仓库元信息」换成离线替身。

    页面/接口要解析的东西（引用 → 技能清单 → 入库落盘）全部照真跑，
    只有网络这一段被替掉。
    """
    state: dict = {"payload": _tarball({"SKILL.md": ARCHIFY}), "url": None, "ref": None}

    async def fake_fetch(ref, *, timeout: float = 60.0):
        state["ref"] = ref
        return state["payload"], "https://codeload.github.com/fake/tar.gz/HEAD", "archify-" + FAKE_SHA

    async def fake_head(ref, *, timeout: float = 12.0):
        return {"default_branch": "main", "description": "示例仓库", "stars": 42, "sha": FAKE_SHA}

    monkeypatch.setattr(skills_api, "fetch_repo_tarball", fake_fetch)
    monkeypatch.setattr(skills_api, "resolve_head", fake_head)
    return state


async def test_预览只读_不写库(client, offline):
    r = await client.post("/api/skills/scan", json={"ref": "tt-a1i/archify"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["repo"] == "tt-a1i/archify"
    assert body["ref"] == "main", "没写版本就用仓库默认分支"
    assert body["sha"] == FAKE_SHA
    assert [s["name"] for s in body["skills"]] == ["archify"]
    assert "可交互的 HTML 图" in body["skills"][0]["description"]

    listed = await client.get("/api/skills")
    assert listed.json() == [], "预览不该往库里写东西"


async def test_一条引用装进来_含来源与落盘(client, offline, tmp_workdir):
    r = await client.post("/api/skills/install", json={"ref": "tt-a1i/archify"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["count"] == 1
    item = body["items"][0]
    assert item["name"] == "archify" and item["updated"] is False
    # 来源记全了 —— 「更新」按钮靠它回原仓库
    rows = (await client.get("/api/skills")).json()
    src = rows[0]["source"]
    assert src["type"] == "repo"
    assert src["repo"] == "tt-a1i/archify"
    assert src["sha"] == FAKE_SHA
    assert src["url"] == "https://github.com/tt-a1i/archify"
    # 落盘：运行时读的是 work/skills/<name>/SKILL.md
    from pathlib import Path

    from agent_studio.config import settings

    p = Path(settings.work_dir) / "skills" / "archify" / "SKILL.md"
    assert p.is_file(), f"应当落盘到 {p}"
    assert "Archify" in p.read_text(encoding="utf-8")


async def test_同名视为更新而不是重复(client, offline):
    first = await client.post("/api/skills/install", json={"ref": "tt-a1i/archify"})
    second = await client.post("/api/skills/install", json={"ref": "tt-a1i/archify"})
    assert second.status_code == 201
    assert second.json()["items"][0]["updated"] is True
    rows = (await client.get("/api/skills")).json()
    assert len(rows) == 1, "同名 skill 应当只有一条记录"
    assert first.json()["items"][0]["id"] == second.json()["items"][0]["id"]


async def test_多技能仓库不偷偷全装(client, offline):
    offline["payload"] = _tarball(MULTI)
    r = await client.post("/api/skills/install", json={"ref": "vercel-labs/skills"})
    assert r.status_code == 409, "多技能且没勾选 → 让用户选"
    detail = r.json()["detail"]
    assert detail["skills"] and len(detail["skills"]) == 2
    assert "选一个再装" in detail["message"]

    # 勾一个装一个
    one = await client.post(
        "/api/skills/install", json={"ref": "vercel-labs/skills", "paths": ["skills/data-viz"]}
    )
    assert one.status_code == 201
    assert one.json()["items"][0]["name"] == "data-viz"
    rows = (await client.get("/api/skills")).json()
    assert [r["name"] for r in rows] == ["data-viz"]

    # --skill 只给名字也认
    two = await client.post(
        "/api/skills/install", json={"ref": "vercel-labs/skills", "skill": "web-design"}
    )
    assert two.status_code == 201
    assert two.json()["items"][0]["name"] == "web-design"

    # 全装
    allr = await client.post("/api/skills/install", json={"ref": "vercel-labs/skills", "all": True})
    assert allr.status_code == 201
    assert sorted(i["name"] for i in allr.json()["items"]) == ["data-viz", "web-design"]


async def test_引用里带子目录只装那一个(client, offline):
    offline["payload"] = _tarball(MULTI)
    r = await client.post("/api/skills/scan", json={"ref": "vercel-labs/skills/skills/data-viz"})
    assert r.status_code == 200
    assert [s["name"] for s in r.json()["skills"]] == ["data-viz"]

    ins = await client.post("/api/skills/install", json={"ref": "vercel-labs/skills/skills/data-viz"})
    assert ins.status_code == 201
    rows = (await client.get("/api/skills")).json()
    assert rows[0]["source"]["path"] == "skills/data-viz"
    assert rows[0]["source"]["url"].endswith("/tree/main/skills/data-viz")


async def test_版本可以写在引用里也可以单独给(client, offline):
    await client.post("/api/skills/install", json={"ref": "tt-a1i/archify@v2.16.0"})
    assert offline["ref"].ref == "v2.16.0"
    await client.post("/api/skills/install", json={"ref": "tt-a1i/archify", "ref_pin": "v2.15.0"})
    assert offline["ref"].ref == "v2.15.0", "单独给的版本优先"


async def test_更新按钮按记下的来源重装(client, offline):
    ins = await client.post("/api/skills/install", json={"ref": "tt-a1i/archify"})
    sid = ins.json()["items"][0]["id"]
    r = await client.post(f"/api/skills/{sid}/reinstall")
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True and r.json()["sha"] == FAKE_SHA
    assert offline["ref"].slug == "tt-a1i/archify"


async def test_内联写的技能没有可更新来源(client):
    r = await client.post(
        "/api/skills/import",
        json={"source": "inline", "content": "---\nname: mine\ndescription: 手写\n---\n\n正文", "name": "mine"},
    )
    assert r.status_code == 201
    sid = r.json()["items"][0]["id"]
    up = await client.post(f"/api/skills/{sid}/reinstall")
    assert up.status_code == 400
    assert "没有可更新的来源" in up.json()["detail"]


async def test_坏引用与坏仓库给人话报错(client, offline):
    bad = await client.post("/api/skills/scan", json={"ref": "archify"})
    assert bad.status_code == 400 and "owner/repo" in bad.json()["detail"]

    offline["payload"] = _tarball({"README.md": "没有技能"})
    none = await client.post("/api/skills/scan", json={"ref": "tt-a1i/archify"})
    assert none.status_code == 400 and "没找到 SKILL.md" in none.json()["detail"]


def test_技能名与描述从_frontmatter_解析():
    name, desc = parse_skill_md(ARCHIFY, "fallback")
    assert name == "archify"
    assert desc.startswith("把架构")
