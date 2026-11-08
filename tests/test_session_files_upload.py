"""会话文件上传：右栏「会话文件」那个上传按钮的真实落点。

要钉住的三件事：
· 落在**这个会话自己的工作目录**里（不是附件暂存区，也不是别的会话）
· 文件名的路径部分一律丢掉（`../../evil.txt` 只能变成一个普通文件名）
· 同名不覆盖，加后缀

做法和 test_work_files 一致：把 settings.work_dir 指到临时沙箱，用完清掉，
不碰平台真实的 data/work。
"""

from __future__ import annotations

import io
import uuid

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from agent_studio.config import settings
    from agent_studio.main import app

    sandbox = tmp_path / "work"
    sandbox.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "work_dir", sandbox)
    yield TestClient(app), sandbox


def _new_session(c: TestClient) -> str:
    name = f"上传验收-{uuid.uuid4().hex[:6]}"  # 同一个测试库里重名会 409
    agent = c.post("/api/agents", json={"name": name, "definition": {"name": name, "system_prompt": "x"}}).json()
    return c.post("/api/sessions", json={"agent_id": agent["id"], "title": "上传"}).json()["id"]


def test_上传落到这个会话的目录(client):
    c, sandbox = client
    sid = _new_session(c)
    blob = "# 你好\n".encode()
    r = c.post(
        f"/api/sessions/{sid}/files",
        files=[("files", ("报告.md", io.BytesIO(blob), "text/markdown"))],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 1
    assert body["saved"][0]["path"] == "报告.md"
    assert body["saved"][0]["size"] == len(blob)

    # 真的落在会话目录，且清单里能看到（上传完看不见 = 白传）
    assert (sandbox / "sessions" / sid / "报告.md").read_bytes() == blob
    listed = c.get(f"/api/sessions/{sid}/files").json()
    assert [f["path"] for f in listed["files"]] == ["报告.md"]


def test_路径被剥掉_同名不覆盖(client):
    c, sandbox = client
    sid = _new_session(c)
    for name in ("../../evil.txt", "evil.txt"):
        r = c.post(f"/api/sessions/{sid}/files", files=[("files", (name, io.BytesIO(b"x"), "text/plain"))])
        assert r.status_code == 200, r.text
    paths = sorted(f["path"] for f in c.get(f"/api/sessions/{sid}/files").json()["files"])
    assert paths == ["evil-1.txt", "evil.txt"], paths
    # 没有逃到会话目录外面去
    assert not (sandbox / "evil.txt").exists()


def test_会话不存在就404(client):
    c, _ = client
    r = c.post("/api/sessions/ses_nope/files", files=[("files", ("a.txt", io.BytesIO(b"x"), "text/plain"))])
    assert r.status_code == 404
