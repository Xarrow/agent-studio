"""部署身份（/api/version 的 commit）必须可信 —— 验收拿它当凭据。

现场（2026-11-22）：/api/version 报 ba25c07、``.build_commit`` 是 c89f4ff、真正
在跑的代码是 f2167f3，三处不一致，部署验收等于没有凭据。两个根因，这里各守一条：

① **口径漂移**：以前按请求去读文件，部署脚本又是「先写戳 → 再重启」，中间那段
   窗口里旧进程会报出新版本号，重启失败时它也会替一份没说出口就换了身的代码
   作证。现在戳在**进程启动时**读一次（``main._BUILD``），端点的回答只描述
   「这个进程跑的是哪份代码」。
② **脏树冒充**：部署同步的是工作树，而戳只写 ``git HEAD`` —— 未提交的改动会被
   算到上一个 commit 头上。现在部署会写 ``.build_dirty``，接口多报
   ``commit_dirty``，commit 号只说明"基于哪一版"。
"""

from __future__ import annotations

import json

import pytest

from agent_studio import main


def _app(tmp_path, *, commit=None, dirty=False, git_ref=None, branch="refs/heads/master", sha=None):
    if commit is not None:
        (tmp_path / ".build_commit").write_text(commit + "\n", encoding="utf-8")
    if dirty:
        (tmp_path / ".build_dirty").write_text("1", encoding="utf-8")
    if git_ref is not None:
        git = tmp_path / ".git"
        git.mkdir()
        (git / "HEAD").write_text(f"ref: {git_ref}\n", encoding="utf-8")
        if sha:
            ref_file = git / git_ref
            ref_file.parent.mkdir(parents=True, exist_ok=True)
            ref_file.write_text(sha + "\n", encoding="utf-8")
    return tmp_path


def test_部署戳优先于git_并且带出来源(tmp_path):
    _app(tmp_path, commit="f2167f37cdd1", git_ref="refs/heads/master", sha="ba25c0700000")
    commit, source, dirty = main._read_build_identity(tmp_path)
    assert commit == "f2167f37cdd1"
    assert source == "deploy-stamp", "部署目录里 .build_commit 才是「谁把我放这儿的」"
    assert dirty is False


def test_脏树必须标出来_commit号只说明基于哪一版(tmp_path):
    _app(tmp_path, commit="f2167f37cdd1", dirty=True)
    commit, source, dirty = main._read_build_identity(tmp_path)
    assert commit == "f2167f37cdd1" and source == "deploy-stamp"
    assert dirty is True, "工作区有未提交改动时不能让 commit 号冒充「跑的就是这一版」"


def test_没有部署戳就落到git(tmp_path):
    _app(tmp_path, git_ref="refs/heads/master", sha="f2167f37cdd1aaaaaaaaa")
    commit, source, dirty = main._read_build_identity(tmp_path)
    assert (commit, source, dirty) == ("f2167f37cdd1", "git", False)


def test_裸目录部署没有git也没有戳时回unknown而不是抛异常(tmp_path):
    commit, source, _dirty = main._read_build_identity(tmp_path)
    assert (commit, source) == ("unknown", "unknown")


def test_开发机的未提交改动也要标脏(tmp_path):
    """有 .git 但没有部署戳时，跑未提交的代码必须报 dirty —— 不然 commit 号在撒谎。"""
    import shutil
    import subprocess

    if not shutil.which("git"):
        pytest.skip("这台机器没有 git 命令")
    run = lambda *a: subprocess.run(["git", "-C", str(tmp_path), *a], check=True, capture_output=True)
    run("init", "-q")
    run("config", "user.email", "t@example.com")
    run("config", "user.name", "t")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.py").write_text("x = 1\n", encoding="utf-8")
    run("add", "-A")
    run("commit", "-q", "-m", "init")
    head = run("rev-parse", "--short=12", "HEAD").stdout.decode().strip()

    commit, source, dirty = main._read_build_identity(tmp_path)
    assert (commit, source, dirty) == (head, "git", False)

    (tmp_path / "src" / "a.py").write_text("x = 2\n", encoding="utf-8")
    commit, source, dirty = main._read_build_identity(tmp_path)
    assert (commit, source) == (head, "git")
    assert dirty is True, "改了没提交还报 clean，就是这次要修的那个不trustworthy"


async def test_端点报的是进程启动时的快照_不按请求读文件(monkeypatch):
    """部署窗口里旧进程不许替新戳作证 —— 这是三处不一致的直接来源。"""
    monkeypatch.setattr(main, "_BUILD", ("f2167f37cdd1", "deploy-stamp", False))

    def boom(*_a, **_k):  # 任何"再读一次磁盘"的行为都算回归
        raise AssertionError("version() 不该再读磁盘 —— 口径必须是进程启动时定下的")

    monkeypatch.setattr(main, "_read_build_identity", boom)
    data = await main.version()
    assert data["commit"] == "f2167f37cdd1"
    assert data["commit_source"] == "deploy-stamp"
    assert data["commit_dirty"] is False
    assert "started_at" in data, "运维要能对「这份 commit 是几点起来的」"
    json.dumps(data)  # 必须 JSON 可序列化（免口令端点直接回客户端）
