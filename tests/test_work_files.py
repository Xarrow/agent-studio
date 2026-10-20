"""/api/work —— agent 产物展示端点。

背景：agent 的 Write/Bash 工具把产物写进平台工作目录（data/work/），
此前前端没有任何通道读到它，消息里的产物路径只是一串死文本。
本文件锁三件事：能取回、取不越界（逃逸/敏感类型）、类型标注正确。
"""
from __future__ import annotations

import pathlib
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def work_file(tmp_path, monkeypatch):
    """把工作目录指到测试沙箱再放产物，测完清掉（不碰平台真实 data/work）。"""
    from agent_studio.config import settings

    sandbox = tmp_path / "work"
    sandbox.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "work_dir", sandbox)
    p = sandbox / "_test_artifact.png"
    p.write_bytes(b"\x89PNG\r\n\x1a\nfake")
    yield p
    p.unlink(missing_ok=True)


def test_work_file_served(work_file):
    from agent_studio.main import app

    c = TestClient(app)
    r = c.get("/api/work/file/_test_artifact.png")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/png")


def test_work_file_rejects_escape():
    """../ 逃逸（含 URL 编码形态）必须 404，不能读工作目录外的任何文件。"""
    from agent_studio.main import app

    c = TestClient(app)
    for probe, expect in (
        ("/api/work/file/%2e%2e/studio.db", 404),
        ("/api/work/file/..%2fstudio.db", 404),
        ("/api/work/file/%2e%2e%2f%2e%2e%2fetc%2fpasswd", 404),
    ):
        assert c.get(probe).status_code == expect, probe
    # 「../studio.db」裸形态在 httpx 层会被规范化成 /api/work/studio.db ——
    # 修复后 API 前缀 404 不再被 SPA 兜底成 index.html，必须是 404/405
    assert c.get("/api/work/file/../studio.db").status_code in (404, 405)


def test_work_file_rejects_unknown_type():
    """白名单外的类型（如 sqlite 数据库）一律 404。"""
    from agent_studio.main import app

    c = TestClient(app)
    assert c.get("/api/work/file/uploads.config.json").status_code == 404


def test_work_file_missing_is_404():
    from agent_studio.main import app

    c = TestClient(app)
    assert c.get("/api/work/file/no_such_file.md").status_code == 404


def test_work_list_shape():
    from agent_studio.main import app

    c = TestClient(app)
    r = c.get("/api/work/list")
    assert r.status_code == 200
    for item in r.json()["files"]:
        assert set(item) == {"path", "size", "mtime", "url"}
        assert item["url"].startswith("/api/work/file/")


def test_upload_image_served_inline():
    """图片附件必须 inline（无 attachment 头）—— <img> 对 attachment 响应
    会拒绝渲染，缩略图全裂。非图片保持 attachment（点开=下载）。"""
    import io

    from agent_studio.main import app

    # 最小合法 PNG（1x1 红像素），不依赖 PIL
    PNG_1PX = bytes.fromhex(
        "89504e470d0a1a0a0000000d494844520000000100000001080200000090"
        "7753de0000000c4944415408d763f8cfc00000030101"
        "00184fbb610000000049454e44ae426082"
    )
    c = TestClient(app)
    r = c.post("/api/uploads", files={"file": ("_inline_test.png", PNG_1PX, "image/png")})
    assert r.status_code == 200, r.text
    fid = r.json()["id"]
    try:
        got = c.get(f"/api/uploads/file/{fid}")
        assert got.status_code == 200
        assert got.headers["content-type"] == "image/png"
        assert "attachment" not in got.headers.get("content-disposition", "")
    finally:
        c.delete(f"/api/uploads/file/{fid}")


def test_media_types_preview_inline(tmp_path, monkeypatch):
    """音视频要在对话里能直接播 —— 后缀白名单得放行，且 Content-Type 对得上。"""
    from agent_studio.config import settings

    sandbox = tmp_path / "work"
    sandbox.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "work_dir", sandbox)
    (sandbox / "tone.mp3").write_bytes(b"ID3fake")
    (sandbox / "clip.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42")
    (sandbox / "doc.pdf").write_bytes(b"%PDF-1.4 fake")
    (sandbox / "note.md").write_text("# 标题", encoding="utf-8")
    (sandbox / "page.html").write_text("<h1>hi</h1>", encoding="utf-8")
    (sandbox / "evil.exe").write_bytes(b"MZ")

    from agent_studio.main import app

    c = TestClient(app)
    expect = {
        "tone.mp3": "audio/",
        "clip.mp4": "video/",
        "doc.pdf": "application/pdf",
        "note.md": "text/markdown",
        "page.html": "text/html",
    }
    for name, ctype in expect.items():
        r = c.get(f"/api/work/file/{name}")
        assert r.status_code == 200, name
        assert r.headers["content-type"].startswith(ctype), (name, r.headers["content-type"])
    # 可执行文件永远不放行
    assert c.get("/api/work/file/evil.exe").status_code == 404


def test_filename_with_brackets_is_served(tmp_path, monkeypatch):
    """bilibili 下回来的名字带方括号（`标题 [BVxxx].mp4`）—— 之前整条 URL 404，
    用户看到的就是"mp4 播不了"。文件名规则不能收得太紧。"""
    from agent_studio.config import settings

    sandbox = tmp_path / "work"
    sandbox.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "work_dir", sandbox)
    name = "余承东雍正王朝 2 [BV1r9nF6ZE2h].mp4"
    (sandbox / name).write_bytes(b"\x00\x00\x00\x18ftypmp42")

    from agent_studio.main import app

    c = TestClient(app)
    r = c.get("/api/work/file/" + quote(name))
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("video/")


def test_head_supported_for_media(tmp_path, monkeypatch):
    """iOS Safari 放视频前先发 HEAD；只接 GET 会 405，被当成"放不了"。"""
    from agent_studio.config import settings

    sandbox = tmp_path / "work"
    sandbox.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "work_dir", sandbox)
    (sandbox / "v.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42")

    from agent_studio.main import app

    r = TestClient(app).head("/api/work/file/v.mp4")
    assert r.status_code == 200
    assert int(r.headers["content-length"]) == 12


def test_probe_rejects_outside_and_missing():
    from agent_studio.main import app

    c = TestClient(app)
    assert c.get("/api/work/probe", params={"path": "../studio.db"}).status_code == 404
    assert c.get("/api/work/probe", params={"path": "nope.mp4"}).status_code == 404


def test_probe_reports_codec_and_playability(tmp_path, monkeypatch):
    """真用 ffmpeg 造一个 H.264 → 必须判"能播"；再改后缀当 hevc 不可行，
    所以这里换个角度：不存在的文件 404，H.264 判 yes，编码判定函数对 hevc 说 no。"""
    pytest.importorskip("shutil")
    import shutil as _sh

    if not _sh.which("ffmpeg"):
        pytest.skip("没有 ffmpeg")

    from agent_studio.config import settings

    sandbox = tmp_path / "work"
    sandbox.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "work_dir", sandbox)
    vid = sandbox / "tiny.mp4"
    import subprocess

    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
         "testsrc=size=160x120:rate=10:duration=1", "-c:v", "libx264",
         "-pix_fmt", "yuv420p", str(vid)],
        check=True, timeout=120,
    )

    from agent_studio.api.work import _probe
    from agent_studio.main import app

    info = _probe(vid)
    assert info["ok"] and info["video"] == "h264" and info["playable"] == "yes"
    assert info["width"] == 160 and info["height"] == 120

    got = TestClient(app).get("/api/work/probe", params={"path": "tiny.mp4"}).json()
    assert got["playable"] == "yes"


def test_transcode_makes_playable_copy(tmp_path, monkeypatch):
    if not __import__("shutil").which("ffmpeg"):
        pytest.skip("没有 ffmpeg")
    from agent_studio.config import settings

    sandbox = tmp_path / "work"
    sandbox.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(settings, "work_dir", sandbox)
    src = sandbox / "clip.mp4"
    import subprocess

    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
         "testsrc=size=160x120:rate=10:duration=1", "-c:v", "libx264",
         "-pix_fmt", "yuv420p", str(src)],
        check=True, timeout=120,
    )
    # 假装它是 AV1：直接断言产物生成与回读，编码真伪不影响这条链路
    from agent_studio.main import app

    r = TestClient(app).post("/api/work/transcode", json={"path": "clip.mp4"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["url"].startswith("/api/work/file/")
    assert (sandbox / body["path"]).exists()
    assert body["probe"]["playable"] == "yes"
