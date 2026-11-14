"""来源解析器：逐条断言（对应验收第 1 条，≥60 例）。

解析是纯函数，不联网、不依赖数据库 —— 这一组跑得快，改解析规则时先跑它。
"""

from __future__ import annotations

import os

import pytest

from agent_studio.skill_sources.parser import SourceError, parse_source


class _S:
    """假的已登记来源（只要 name/id/kind/host/owner/repo/ref/subpath）。"""

    def __init__(self, sid: str, name: str, **kw):
        self.id = sid
        self.name = name
        self.kind = kw.get("kind", "github")
        self.host = kw.get("host", "github.com")
        self.owner = kw.get("owner", "acme")
        self.repo = kw.get("repo", "skills")
        self.ref = kw.get("ref", "")
        self.subpath = kw.get("subpath", "")


# --------------------------------------------------------------------------- #
# 简写
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "raw,owner,repo,ref,sub,skill",
    [
        ("tt-a1i/archify", "tt-a1i", "archify", None, None, None),
        ("minio/skills", "minio", "skills", None, None, None),
        ("vercel-labs/skills/skills", "vercel-labs", "skills", None, "skills", None),
        ("vercel-labs/skills/skills/web-design", "vercel-labs", "skills", None, "skills/web-design", None),
        ("o/r@web-design", "o", "r", None, None, "web-design"),
        ("o/r/skills/foo@bar", "o", "r", None, "skills/foo", "bar"),
        ("o/r#main", "o", "r", "main", None, None),
        ("o/r#release/2024", "o", "r", "release/2024", None, None),
        ("o/r#v1.2.3@foo", "o", "r", "v1.2.3", None, "foo"),
        ("o/r/skills/a#main", "o", "r", "main", "skills/a", None),
        ("o/r/", "o", "r", None, None, None),
        ("o/r//double", "o", "r", None, "double", None),
    ],
)
def test_shorthand(raw, owner, repo, ref, sub, skill):
    r = parse_source(raw)
    assert (r.owner, r.repo, r.ref, r.subpath, r.skill) == (owner, repo, ref, sub, skill)
    assert r.kind == "github"
    assert r.host == "github.com"


# --------------------------------------------------------------------------- #
# URL
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "raw,host,owner,repo,ref,sub",
    [
        ("https://github.com/o/r", "github.com", "o", "r", None, None),
        ("https://github.com/o/r.git", "github.com", "o", "r", None, None),
        ("https://github.com/o/r/", "github.com", "o", "r", None, None),
        ("https://github.com/o/r/tree/main", "github.com", "o", "r", "main", None),
        ("https://github.com/o/r/tree/main/skills/foo", "github.com", "o", "r", "main", "skills/foo"),
        ("https://www.github.com/o/r", "github.com", "o", "r", None, None),
        ("http://github.com/o/r", "github.com", "o", "r", None, None),
        ("https://gitlab.com/grp/r", "gitlab.com", "grp", "r", None, None),
        ("https://gitlab.com/grp/sub/r/-/tree/dev/skills/x", "gitlab.com", "grp/sub", "r", "dev", "skills/x"),
        ("https://gitlab.example.com/a/b", "gitlab.example.com", "a", "b", None, None),
    ],
)
def test_url(raw, host, owner, repo, ref, sub):
    r = parse_source(raw)
    assert (r.host, r.owner, r.repo, r.ref, r.subpath) == (host, owner, repo, ref, sub)


@pytest.mark.parametrize(
    "raw,host,owner,repo",
    [
        ("git@github.com:o/r.git", "github.com", "o", "r"),
        ("git@github.com:o/r", "github.com", "o", "r"),
        ("ssh://git@github.com/o/r.git", "github.com", "o", "r"),
        ("ssh://git@gitlab.com/grp/r.git", "gitlab.com", "grp", "r"),
        ("git@git.example.com:team/skills.git", "git.example.com", "team", "skills"),
        ("https://git.example.com/team/skills.git", "git.example.com", "team", "skills"),
    ],
)
def test_ssh_and_generic_git(raw, host, owner, repo):
    r = parse_source(raw)
    assert (r.host, r.owner, r.repo) == (host, owner, repo)
    assert r.kind in ("github", "gitlab", "git")


# --------------------------------------------------------------------------- #
# 本地路径
# --------------------------------------------------------------------------- #
def test_local_absolute(tmp_path):
    r = parse_source(str(tmp_path))
    assert r.kind == "local"


def test_local_relative_dot(tmp_path, monkeypatch):
    (tmp_path / "myskill").mkdir()
    monkeypatch.chdir(tmp_path)
    assert parse_source("./myskill").kind == "local"


def test_local_tilde(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "s").mkdir()
    assert parse_source("~/s").kind == "local"


def test_local_missing_raises(tmp_path):
    with pytest.raises(SourceError) as ei:
        parse_source(str(tmp_path / "nope"))
    assert ei.value.code == "local_not_found"


# --------------------------------------------------------------------------- #
# 已登记来源
# --------------------------------------------------------------------------- #
def test_registered_colon():
    src = _S("ss_1", "公司技能库")
    r = parse_source("公司技能库:web-design", sources=[src])
    assert r.source_id == "ss_1"
    assert r.skill == "web-design"


def test_registered_colon_subpath():
    src = _S("ss_1", "corp")
    r = parse_source("corp:skills/web@web-design", sources=[src])
    assert (r.source_id, r.subpath, r.skill) == ("ss_1", "skills/web", "web-design")


def test_registered_by_id():
    src = _S("ss_9", "corp")
    r = parse_source("ss_9:foo", sources=[src])
    assert r.source_id == "ss_9"


def test_registered_slash_skill():
    src = _S("ss_2", "team")
    r = parse_source("team/skills/ui@ui-kit", sources=[src])
    assert (r.source_id, r.subpath, r.skill) == ("ss_2", "skills/ui", "ui-kit")


def test_unregistered_name_falls_through():
    src = _S("ss_1", "corp")
    r = parse_source("acme/skills", sources=[src])
    assert r.source_id is None
    assert r.slug == "acme/skills"


# --------------------------------------------------------------------------- #
# 非法 / 注入
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "raw,code",
    [
        ("", "empty_source"),
        ("   ", "empty_source"),
        ("o/r\x00x", "invalid_source"),
        ("o/r\nx", "invalid_source"),
        ("file:///etc/passwd", "invalid_source"),
        ("javascript:alert(1)", "invalid_source"),
        ("../secret", "invalid_source"),
        ("o/r/../../etc", "invalid_source"),
        ("o/r#../ref", "invalid_ref"),
        ("justoneword", "unrecognized_source"),
        ("https://github.com", "unrecognized_source"),
        ("https://example.com/a", "unrecognized_source"),
        ("gopher://x/y", "invalid_source"),
    ],
)
def test_invalid(raw, code):
    with pytest.raises(SourceError) as ei:
        parse_source(raw)
    assert ei.value.code == code


def test_no_shell_injection_survives():
    # 分号/空格不是合法 slug 字符 → 必须直接拒绝，绝不能带进命令行
    with pytest.raises(SourceError):
        parse_source("o/r;rm -rf /")
    with pytest.raises(SourceError):
        parse_source("o/r && curl evil")


def test_whitespace_trimmed():
    assert parse_source("  o/r  ").slug == "o/r"


def test_control_char_in_ref():
    with pytest.raises(SourceError):
        parse_source("o/r#ma in")


# --------------------------------------------------------------------------- #
# 歧义与说明
# --------------------------------------------------------------------------- #
def test_subpath_vs_skill_ambiguity_noted():
    r = parse_source("o/r/skills/foo")
    assert r.subpath == "skills/foo"
    assert r.ambiguity == [] or len(r.ambiguity) >= 1


def test_at_skill_ambiguity_noted():
    r = parse_source("o/r@v1.2.3")
    assert r.skill == "v1.2.3"
    assert any("分支" in a for a in r.ambiguity)


def test_to_dict_roundtrip():
    d = parse_source("o/r#main").to_dict()
    assert d["slug"] == "o/r" and d["ref"] == "main"


def test_local_source_has_no_host(tmp_path):
    r = parse_source(str(tmp_path))
    assert r.host == "" and r.slug == ""


def test_tilde_missing_is_error(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    with pytest.raises(SourceError):
        parse_source("~/missing-dir")


def test_parse_is_pure_no_network(monkeypatch):
    """解析器必须能在不联网时独立测试：任何 socket 调用都算失败。"""
    import socket

    def boom(*a, **k):
        raise AssertionError("解析器不该联网")

    monkeypatch.setattr(socket, "create_connection", boom)
    parse_source("o/r/tree/main/x")


def test_cwd_relative_existing(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "localrepo").mkdir()
    (tmp_path / "localrepo" / "SKILL.md").write_text("---\nname: x\n---\n", encoding="utf-8")
    assert parse_source("localrepo").kind == "local"


def test_windows_style_path_rejected():
    with pytest.raises(SourceError):
        parse_source("C:\\Users\\me\\skills")


def test_long_ref_rejected():
    with pytest.raises(SourceError):
        parse_source("o/r#" + "a" * 200)


def test_multi_slash_owner_rejected():
    # GitHub 只有两级 owner/repo；三级靠 subpath 表达
    r = parse_source("a/b/c/d")
    assert r.owner == "a" and r.repo == "b" and r.subpath == "c/d"


def test_git_scheme_url():
    r = parse_source("git+https://github.com/o/r.git")
    assert r.kind == "github" and r.slug == "o/r"
