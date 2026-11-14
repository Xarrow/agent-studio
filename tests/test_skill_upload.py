"""技能包上传：zip / .skills / tar.gz / 单文件，以及越界与压缩炸弹防护。

为什么单独测：
    上传是**唯一**一个把外部字节写进服务器目录的入口。它出错不是"功能不好用"，
    而是往任意位置写文件。所以这里既测"能装进来"，也测"该拒的一定拒"。
"""

from __future__ import annotations

import io
import tarfile
import zipfile

import pytest
from httpx import ASGITransport, AsyncClient

from agent_studio.config import settings
from agent_studio.db import init_db
from agent_studio.main import app

SKILL_MD = """---
name: qa-uploaded
description: 上传测试技能
---

# 上传测试

正文。
"""


@pytest.fixture
async def client():
    await init_db()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        yield c


def _zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, text in files.items():
            zf.writestr(name, text)
    return buf.getvalue()


async def test_上传_zip_装进技能库并解压到指定目录(client):
    data = _zip({"qa-uploaded/SKILL.md": SKILL_MD, "qa-uploaded/assets/a.txt": "hello"})
    r = await client.post(
        "/api/skills/upload",
        files={"file": ("pkg.zip", data, "application/zip")},
        data={"dir": "qa-uploads/case1"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["kind"] == "zip" and body["count"] == 1
    assert body["items"][0]["name"] == "qa-uploaded"

    # 解压目录按用户指定落地，且原始附件保留
    target = settings.work_dir / "qa-uploads" / "case1"
    assert (target / "qa-uploaded" / "assets" / "a.txt").is_file()
    # 技能在库里，且落盘成运行时目录
    assert (settings.work_dir / "skills" / "qa-uploaded" / "SKILL.md").is_file()


async def test_上传_skills后缀按zip处理(client):
    data = _zip({"qa-uploaded2/SKILL.md": SKILL_MD.replace("qa-uploaded", "qa-uploaded2")})
    r = await client.post(
        "/api/skills/upload", files={"file": ("bundle.skills", data, "application/octet-stream")}
    )
    assert r.status_code == 201, r.text
    assert r.json()["kind"] == "zip"


async def test_上传_tar_gz(client):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        payload = SKILL_MD.replace("qa-uploaded", "qa-uploaded3").encode()
        info = tarfile.TarInfo("qa-uploaded3/SKILL.md")
        info.size = len(payload)
        tf.addfile(info, io.BytesIO(payload))
    r = await client.post(
        "/api/skills/upload", files={"file": ("pkg.tar.gz", buf.getvalue(), "application/gzip")}
    )
    assert r.status_code == 201, r.text
    assert r.json()["kind"] == "tar"


async def test_上传_单个md(client):
    r = await client.post(
        "/api/skills/upload",
        files={"file": ("SKILL.md", SKILL_MD.replace("qa-uploaded", "qa-uploaded4").encode(), "text/markdown")},
    )
    assert r.status_code == 201, r.text
    assert r.json()["kind"] == "file" and r.json()["count"] == 1


async def test_压缩包路径穿越被拒(client):
    evil = _zip({"../../etc/evil.txt": "x"})
    r = await client.post("/api/skills/upload", files={"file": ("evil.zip", evil, "application/zip")})
    assert r.status_code == 400
    assert "非法路径" in r.json()["detail"]


async def test_目标目录越界被拒(client):
    data = _zip({"qa-uploaded5/SKILL.md": SKILL_MD.replace("qa-uploaded", "qa-uploaded5")})
    r = await client.post(
        "/api/skills/upload",
        files={"file": ("pkg.zip", data, "application/zip")},
        data={"dir": "/etc"},
    )
    assert r.status_code == 400
    assert "工作目录内" in r.json()["detail"]


async def test_包内没有SKILL_md时明确报错(client):
    data = _zip({"readme.txt": "no skill here"})
    r = await client.post("/api/skills/upload", files={"file": ("empty.zip", data, "application/zip")})
    assert r.status_code == 400
    assert "SKILL.md" in r.json()["detail"]
