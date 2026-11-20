"""站点索引 / 直链安装：原生解析与下载（不依赖 npm / npx）。

对应真实命令::

    npx -y skills@latest add https://archify.si --skill archify --agent claude-code --global --copy --yes

``skills`` CLI 把 ``https://archify.si`` 当 **site index**：
先探 ``/.well-known/agent-skills/index.json``（agentskills.io discovery 0.2.0），
清单里给出 ``{name, type: archive, url, digest}``，再下载 url 指向的 zip 并按 sha256 校验。
这里逐条复刻，装的是同一份文件。
"""

from __future__ import annotations

import hashlib
import io
import json
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from agent_studio.skill_sources import fetch as F
from agent_studio.skill_sources.netpolicy import NetPolicy
from agent_studio.skill_sources.parser import parse_source


# --------------------------------------------------------------------------- #
# 解析：站点索引与直链
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("raw", ["https://archify.si", "https://archify.si/", "http://archify.si"])
def test_裸域名解析为站点索引(raw):
    r = parse_source(raw)
    assert r.kind == "site"
    assert r.host == "archify.si"
    assert r.url.startswith("http") and r.url.endswith("archify.si")


@pytest.mark.parametrize(
    "raw,skill",
    [
        ("https://archify.si", "archify"),
        ("https://seoskills.sh", None),
    ],
)
def test_站点索引保留技能名(raw, skill):
    r = parse_source(raw if skill is None else f"{raw}@{skill}")
    assert r.kind == "site"
    if skill:
        assert r.skill == skill


@pytest.mark.parametrize(
    "raw",
    [
        "https://example.com/skills/SKILL.md",
        "https://example.com/pkg.zip",
        "https://example.com/pkg.tar.gz",
        "https://example.com/pkg.tgz",
    ],
)
def test_直链文件(raw):
    r = parse_source(raw)
    assert r.kind == "file"
    assert r.url == raw


def test_仓库地址不受影响():
    assert parse_source("https://github.com/o/r").kind == "github"
    assert parse_source("https://gitlab.com/grp/sub/r").kind == "gitlab"
    assert parse_source("o/r").kind == "github"


def test_命令里取出站点地址():
    """整条命令 → 只取引用部分（前端/后端都靠这条）。"""
    from agent_studio.skills_repo import parse_skills_cmd

    cmd = parse_skills_cmd(
        "npx -y skills@latest add https://archify.si --skill archify --agent claude-code --global --copy --yes"
    )
    assert cmd is not None
    assert cmd.action == "add"
    assert cmd.ref == "https://archify.si"
    assert cmd.skill == "archify"


# --------------------------------------------------------------------------- #
# 下载：本地起一个"站点索引"，跑真实的取回路径
# --------------------------------------------------------------------------- #
SKILL_MD = """---
name: demo
description: 一个用于测试的技能
---

# Demo

正文。
"""


def _zip_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("demo/SKILL.md", SKILL_MD)
        zf.writestr("demo/bin/tool.mjs", "console.log(1)\n")
    return buf.getvalue()


class _Site:
    """可配置的假站点：内容与状态码都按用例改。"""

    def __init__(self) -> None:
        self.zip = _zip_bytes()
        self.digest = "sha256:" + hashlib.sha256(self.zip).hexdigest()
        self.index_body: dict | None = None
        self.index_path = "/.well-known/agent-skills/index.json"
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):  # noqa: D401 — 静音
                pass

            def do_GET(self):  # noqa: N802
                if self.path == outer.index_path and outer.index_body is not None:
                    body = json.dumps(outer.index_body).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if self.path.endswith("/demo.zip"):   # 清单里的 ./demo.zip 相对 index 解析
                    self.send_response(200)
                    self.send_header("Content-Type", "application/zip")
                    self.send_header("Content-Length", str(len(outer.zip)))
                    self.end_headers()
                    self.wfile.write(outer.zip)
                    return
                if self.path == "/SKILL.md":
                    body = SKILL_MD.encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/markdown")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.send_response(404)
                self.end_headers()

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def close(self) -> None:
        self.srv.shutdown()


@pytest.fixture()
def site():
    s = _Site()
    yield s
    s.close()


def _policy() -> NetPolicy:
    return NetPolicy(proxy_mode="off", allow_plaintext_hosts=["127.0.0.1"], retries=0)


def _ref(url: str, skill: str | None = None):
    r = parse_source(url)
    r.skill = skill
    return r


def test_站点索引装归档(site):
    site.index_body = {
        "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        "skills": [{"name": "demo", "type": "archive", "url": "./demo.zip", "digest": site.digest}],
    }
    import asyncio

    got = asyncio.run(F.fetch_via_site(_ref(site.base), policy=_policy()))
    try:
        assert got.via == "site"
        assert (got.root / "SKILL.md").read_text(encoding="utf-8") == SKILL_MD
        assert (got.root / "bin" / "tool.mjs").exists()
        assert any("sha256" in n for n in got.notes)
    finally:
        got.cleanup()


def test_摘要不符就拒装(site):
    site.index_body = {
        "skills": [{"name": "demo", "type": "archive", "url": "./demo.zip", "digest": "sha256:" + "0" * 64}]
    }
    import asyncio

    with pytest.raises(F.FetchError) as ei:
        asyncio.run(F.fetch_via_site(_ref(site.base), policy=_policy()))
    assert ei.value.code == "digest_mismatch"


def test_站点没有清单时说清楚(site):
    import asyncio

    site.index_body = None
    with pytest.raises(F.FetchError) as ei:
        asyncio.run(F.fetch_via_site(_ref(site.base), policy=_policy()))
    assert ei.value.code == "no_site_index"
    assert ei.value.hint


def test_多技能清单必须指定(site):
    site.index_body = {"skills": [{"name": "a", "url": "./demo.zip"}, {"name": "b", "url": "./demo.zip"}]}
    import asyncio

    with pytest.raises(F.FetchError) as ei:
        asyncio.run(F.fetch_via_site(_ref(site.base), policy=_policy()))
    assert ei.value.code == "skill_choice_required"


def test_直链_SKILL_md(site):
    import asyncio

    got = asyncio.run(F.fetch_via_file(_ref(f"{site.base}/SKILL.md", "demo"), policy=_policy()))
    try:
        assert (got.root / "demo" / "SKILL.md").read_text(encoding="utf-8") == SKILL_MD
    finally:
        got.cleanup()


def test_zip_解压同样防穿越():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("demo/../../evil.txt", "x")
    with pytest.raises(F.FetchError) as ei:
        F.unpack_archive(buf.getvalue(), __import__("pathlib").Path("/tmp/zipcheck"))
    assert ei.value.code == "unsafe_path"
