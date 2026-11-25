"""从 npm registry 装技能（第三方仓库，含公司内网 registry）。

现场命令形如：

    npx --registry=http://npm.intra.xiaojukeji.com d-skills@latest add ddp

不能用 npx：部署机（东京那台离线一体包）是零 Node 的，跑 npx 必失败。
这里直接按 registry 协议取 metadata → dist.tarball → 解包，纯 HTTP，不依赖运行时。
"""

from __future__ import annotations

import io
import json
import tarfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from agent_studio.skill_sources.discover import discover
from agent_studio.skill_sources.fetch import fetch_via_npm
from agent_studio.skill_sources.netpolicy import NetPolicy
from agent_studio.skill_sources.parser import parse_source


def _skill_tgz(skills: dict[str, str]) -> bytes:
    """造一个 npm 包 tarball：顶层 package/，里面 skills/<name>/SKILL.md。"""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, body in skills.items():
            data = body.encode("utf-8")
            info = tarfile.TarInfo(f"package/skills/{name}/SKILL.md")
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
        pkg = json.dumps({"name": "d-skills", "version": "1.0.0"}).encode()
        info = tarfile.TarInfo("package/package.json")
        info.size = len(pkg)
        tf.addfile(info, io.BytesIO(pkg))
    return buf.getvalue()


SKILL_MD = """---
name: {name}
description: 内部技能 {name}
---

# {name}

用来验证 npm 来源。
"""


class _Reg:
    """最小 npm registry：/d-skills 给 metadata，/d-skills/-/d-skills-1.0.0.tgz 给包。"""

    def __init__(self, tgz: bytes):
        self.tgz = tgz
        self.hits: list[str] = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                outer.hits.append(self.path)
                if self.path.startswith("/d-skills/-/"):
                    body = outer.tgz
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                elif self.path.startswith("/d-skills"):
                    body = json.dumps(
                        {
                            "name": "d-skills",
                            "dist-tags": {"latest": "1.0.0"},
                            "versions": {
                                "1.0.0": {
                                    "dist": {
                                        "tarball": f"http://127.0.0.1:{outer.port}/d-skills/-/d-skills-1.0.0.tgz",
                                        "shasum": "abc123def456",
                                    }
                                }
                            },
                        }
                    ).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):  # 安静
                return

        self.httpd = HTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        outer.port = self.port
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return f"http://127.0.0.1:{self.port}"

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


def test_解析内网命令_取出包名版本与技能名():
    cmd = "npx --registry=http://npm.intra.xiaojukeji.com d-skills@latest add ddp"
    ref = parse_source(cmd)
    assert ref.kind == "npm"
    assert ref.repo == "d-skills"
    assert ref.ref == "latest"
    assert ref.skill == "ddp"
    assert ref.url == "http://npm.intra.xiaojukeji.com"


def test_skills_CLI_不被当成_npm():
    ref = parse_source("npx skills add vercel-labs/agent-browser")
    assert ref.kind != "npm"


@pytest.mark.asyncio
async def test_从_registry_取包并发现技能():
    tgz = _skill_tgz({"ddp": SKILL_MD.format(name="ddp")})
    with _Reg(tgz) as registry:
        ref = parse_source(f"npx --registry={registry} d-skills@latest add ddp")
        fetched = await fetch_via_npm(ref, policy=NetPolicy())
        try:
            entries = discover(fetched.root)
            names = [e.name for e in entries]
            assert "ddp" in names
            assert fetched.via == "npm"
            assert fetched.commit.startswith("abc123")
        finally:
            fetched.cleanup()


@pytest.mark.asyncio
async def test_包不存在时报人话():
    from agent_studio.skill_sources.fetch import FetchError

    with _Reg(_skill_tgz({"x": SKILL_MD.format(name="x")})) as registry:
        ref = parse_source(f"npx --registry={registry} not-here@latest add a")
        with pytest.raises(FetchError) as ei:
            await fetch_via_npm(ref, policy=NetPolicy())
        assert ei.value.code in ("npm_package_missing", "npm_version_missing")


@pytest.mark.asyncio
async def test_版本不存在时报人话():
    from agent_studio.skill_sources.fetch import FetchError

    tgz = _skill_tgz({"ddp": SKILL_MD.format(name="ddp")})
    with _Reg(tgz) as registry:
        ref = parse_source(f"npx --registry={registry} d-skills@9.9.9 add ddp")
        with pytest.raises(FetchError) as ei:
            await fetch_via_npm(ref, policy=NetPolicy())
        assert ei.value.code == "npm_version_missing"
