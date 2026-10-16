"""影子命令（studio-npx.sh）真的跑得起来 —— 起一个假平台，用真 shell 执行它。

守的是用户提的那个场景：**部署机没有 Node**，但技能 README 写的是
``npx skills add tt-a1i/archify``。照抄这一行必须能装成功，且：

  · 非 skills 的 npm 包（npx cowsay）→ 转给真正的 npx/明确报错，**不许假装成功**
  · 成功 0 / 失败非 0（脚本和助手都靠退出码判断）
  · 整条命令的参数（--skill / --agent / -g / -y）要传到平台

这里不打 GitHub、也不碰真平台：起一个 recording 用的 stub HTTP 服务，
断言「命令 → 请求体」这一段翻译对不对。真平台的安装由 tests/test_skills_install.py 覆盖。
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
# ⚠️ 别放在 src/agent_studio/data/ 下 —— .gitignore 的 `data/` 规则会把脚本一起吞掉
# （实测：文件在磁盘上、服务能跑，但 repo 和 CI 打的包里都没有）
SHIM_SRC = REPO / "src" / "agent_studio" / "assets" / "studio-npx.sh"


class _Stub(BaseHTTPRequestHandler):
    """记录请求并回固定 JSON：够影子命令解析就行。"""

    received: list[tuple[str, str, dict]] = []
    reply: dict = {}

    def log_message(self, *a):  # 静音
        pass

    def _record(self, method: str) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode() if length else ""
        parsed = json.loads(body) if body.strip().startswith("{") else {}
        type(self).received.append((method, self.path, parsed))

    def do_GET(self) -> None:  # noqa: N802
        self._record("GET")
        payload = type(self).reply.get("GET " + self.path, type(self).reply.get("*", []))
        raw = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:  # noqa: N802
        self._record("POST")
        payload = type(self).reply.get(
            "POST " + self.path,
            {"repo": "o/r", "ref": "main", "items": [{"name": "demo", "updated": False}]},
        )
        raw = json.dumps(payload, ensure_ascii=False).encode()
        code = payload.pop("__status", 200) if isinstance(payload, dict) else 200
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_DELETE(self) -> None:  # noqa: N802
        self._record("DELETE")
        self.send_response(204)
        self.end_headers()


@pytest.fixture
def stub():
    _Stub.received = []
    _Stub.reply = {}
    srv = HTTPServer(("127.0.0.1", 0), _Stub)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


@pytest.fixture
def shim(tmp_path, stub):
    """把影子命令装成 npx / skills 两个名字，放在独立的 bin 目录里。"""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name in ("npx", "skills"):
        f = bin_dir / name
        shutil.copy(SHIM_SRC, f)
        f.chmod(f.stat().st_mode | stat.S_IXUSR)
    env = dict(os.environ)
    # 只留这个 bin 目录 + 系统路径（故意不含任何真 npx）
    env["PATH"] = f"{bin_dir}:/usr/bin:/bin"
    env["STUDIO_URL"] = stub
    env.pop("STUDIO_TOKEN", None)
    return bin_dir, env


def _run(env, *args, cwd=None):
    return subprocess.run(
        args, env=env, cwd=cwd, capture_output=True, text=True, timeout=120, shell=False
    )


def test_README_里那一行照抄就能装(shim):
    bin_dir, env = shim
    r = _run(env, str(bin_dir / "npx"), "skills", "add", "tt-a1i/archify")
    assert r.returncode == 0, r.stderr
    method, path, body = _Stub.received[-1]
    assert (method, path) == ("POST", "/api/skills/install")
    assert body["ref"] == "tt-a1i/archify"
    assert "已安装" in r.stdout or "已更新" in r.stdout


def test_参数翻译到平台(shim):
    bin_dir, env = shim
    r = _run(
        env, str(bin_dir / "npx"), "skills@latest", "add", "minio/skills/aimem",
        "--skill", "aimem", "--agent", "通用助手", "-g", "-y",
    )
    assert r.returncode == 0, r.stderr
    body = _Stub.received[-1][2]
    assert body == {"ref": "minio/skills/aimem", "skill": "aimem", "agents": ["通用助手"]}, body


def test_all_开关与带_npx_前缀的开关都收下(shim):
    bin_dir, env = shim
    r = _run(env, str(bin_dir / "npx"), "-y", "skills", "add", "owner/repo", "--all")
    assert r.returncode == 0, r.stderr
    assert _Stub.received[-1][2] == {"ref": "owner/repo", "all": True}


def test_list_与预览(shim):
    bin_dir, env = shim
    _Stub.reply["GET /api/skills"] = [
        {"name": "archify", "source": {"repo": "tt-a1i/archify"}},
        {"name": "mine", "source": {"type": "inline"}},
    ]
    r = _run(env, str(bin_dir / "skills"), "list")
    assert r.returncode == 0
    assert "archify" in r.stdout and "tt-a1i/archify" in r.stdout and "inline" in r.stdout

    _Stub.reply["POST /api/skills/scan"] = {
        "repo": "tt-a1i/archify", "ref": "main", "stars": 12,
        "skills": [{"name": "archify", "path": "archify", "description": "出图"}],
    }
    r2 = _run(env, str(bin_dir / "skills"), "list", "tt-a1i/archify")
    assert r2.returncode == 0
    assert "tt-a1i/archify @ main" in r2.stdout and "archify" in r2.stdout


def test_多技能仓库会提示用_skill_指定(shim):
    bin_dir, env = shim
    _Stub.reply["POST /api/skills/install"] = {
        "__status": 409,
        "detail": {"message": "多个技能", "skills": [{"name": "a", "description": "A"}, {"name": "b"}]},
    }
    r = _run(env, str(bin_dir / "npx"), "skills", "add", "owner/repo")
    assert r.returncode != 0, "该失败就得失败"
    assert "--skill a" in r.stdout


def test_别的_npm_包不假装成功(shim):
    bin_dir, env = shim
    r = _run(env, str(bin_dir / "npx"), "cowsay", "hi")
    assert r.returncode == 127
    assert "没有 Node" in r.stderr
    assert _Stub.received == [], "不该往平台发任何请求"


def test_真_npx_在后面时让路(shim, tmp_path):
    """本机若装了 Node，`npx cowsay` 必须转给它，而不是被我们拦住。"""
    bin_dir, env = shim
    real = tmp_path / "realbin"
    real.mkdir()
    fake_npx = real / "npx"
    fake_npx.write_text("#!/bin/sh\necho REAL-NPX $@\n")
    fake_npx.chmod(0o755)
    env["PATH"] = f"{bin_dir}:{real}:/usr/bin:/bin"
    r = _run(env, str(bin_dir / "npx"), "cowsay", "hi")
    assert r.returncode == 0
    assert "REAL-NPX cowsay hi" in r.stdout


def test_用法错误非零退出(shim):
    bin_dir, env = shim
    r = _run(env, str(bin_dir / "skills"))
    assert r.returncode == 2 and "用法" in r.stderr
