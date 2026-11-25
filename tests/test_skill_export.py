"""技能导出：打成一个 zip，包内每个技能一个目录（SKILL.md + 附件 + skill.json）。

用户要求：skills 支持打包导出。导出包要能原样再导入，所以带 skill.json 元数据。
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest


def _zip_bytes(name: str, files: dict[str, str] | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            f"{name}/SKILL.md",
            f"---\nname: {name}\ndescription: 测试用\n---\n\n# {name}\n\n正文。\n",
        )
        for rel, body in (files or {}).items():
            zf.writestr(f"{name}/{rel}", body)
    return buf.getvalue()


async def _make_skill(client, name: str, files: dict[str, str] | None = None) -> dict:
    r = await client.post(
        "/api/skills/upload",
        files={"file": (f"{name}.zip", _zip_bytes(name, files), "application/zip")},
        data={"dir": ""},
    )
    assert r.status_code in (200, 201), r.text
    body = r.json()
    items = body.get("items") or body.get("skills") or []
    assert items, f"上传没返回条目：{body}"
    return items[0]


@pytest.mark.asyncio
async def test_导出单个技能含正文附件与元数据(client):
    sk = await _make_skill(client, "导出测试", {"scripts/run.sh": "echo hi\n", "refs/a.md": "# A\n"})
    r = await client.get(f"/api/skills/export?ids={sk['id']}")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    assert "attachment" in r.headers["content-disposition"]
    assert r.headers.get("x-skill-count") == "1"

    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = zf.namelist()
    assert "导出测试/SKILL.md" in names
    assert "导出测试/scripts/run.sh" in names
    assert "导出测试/refs/a.md" in names
    assert "导出测试/skill.json" in names
    assert "README.txt" in names
    assert zf.read("导出测试/scripts/run.sh").decode() == "echo hi\n"

    meta = json.loads(zf.read("导出测试/skill.json"))
    assert meta["name"] == "导出测试"
    assert meta["format"] == "agent-studio-skills/1"


@pytest.mark.asyncio
async def test_导出全部并保持多技能各自的目录(client):
    await _make_skill(client, "甲技能")
    await _make_skill(client, "乙技能")
    r = await client.get("/api/skills/export")
    assert r.status_code == 200
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    tops = {n.split("/")[0] for n in zf.namelist() if "/" in n}
    assert {"甲技能", "乙技能"} <= tops
    assert int(r.headers["x-skill-count"]) >= 2


@pytest.mark.asyncio
async def test_指定不存在的技能报_404(client):
    r = await client.get("/api/skills/export?ids=sk_nope")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_重名技能在包内不互相覆盖(client):
    """两个同名技能导出后目录要分开，否则解压就丢一个。"""
    a = await _make_skill(client, "重名")
    b = await _make_skill(client, "重名")
    r = await client.get(f"/api/skills/export?ids={a['id']},{b['id']}")
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    tops = {n.split("/")[0] for n in zf.namelist() if "/" in n}
    assert len([t for t in tops if t.startswith("重名")]) == 2


@pytest.mark.asyncio
async def test_导出包能再导入(client):
    """闭环：导出的 zip 原样上传回来，技能还在。"""
    sk = await _make_skill(client, "可往返技能", {"x/note.txt": "hello"})
    r = await client.get(f"/api/skills/export?ids={sk['id']}")
    zf_bytes = r.content

    await client.delete(f"/api/skills/{sk['id']}")
    up = await client.post(
        "/api/skills/upload",
        files={"file": ("skills.zip", zf_bytes, "application/zip")},
        data={"dir": ""},
    )
    assert up.status_code in (200, 201), up.text
    names = [s["name"] for s in (await client.get("/api/skills")).json()]
    assert "可往返技能" in names
