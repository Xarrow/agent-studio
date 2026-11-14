"""发现规则、内容哈希、选择与歧义（离线，纯文件操作）。"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_studio.skill_sources.discover import discover, pick, skill_hash


def _mk(root: Path, rel: str, body: str, **extra: str) -> Path:
    d = root / rel
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(body, encoding="utf-8")
    for name, text in extra.items():
        (d / name).write_text(text, encoding="utf-8")
    return d


MD = "---\nname: {n}\ndescription: {d}\n---\n\n# {n}\n"


def test_root_is_skill(tmp_path):
    _mk(tmp_path, "", MD.format(n="root-skill", d="根就是技能"))
    got = discover(tmp_path)
    assert [s.path for s in got] == [""]
    assert got[0].name == "root-skill"


def test_subpath_is_skill(tmp_path):
    _mk(tmp_path, "pkg/one", MD.format(n="one", d="子目录技能"))
    got = discover(tmp_path, subpath="pkg/one")
    assert len(got) == 1 and got[0].path == "pkg/one"


def test_convention_dir_wins_over_recursive(tmp_path):
    _mk(tmp_path, "skills/a", MD.format(n="a", d="约定目录"))
    _mk(tmp_path, "docs/deep/b", MD.format(n="b", d="深层"))
    got = discover(tmp_path)
    assert got[0].name == "a"      # 约定目录优先，不再往下钻
    assert all(s.name != "b" for s in got)


def test_recursive_when_no_convention(tmp_path):
    _mk(tmp_path, "deep/nest/c", MD.format(n="c", d="深层命中"))
    got = discover(tmp_path)
    assert [s.name for s in got] == ["c"]


def test_no_descend_after_hit(tmp_path):
    _mk(tmp_path, "outer/inner/deep", MD.format(n="deep", d="不该被发现"))
    (tmp_path / "outer").mkdir(exist_ok=True)
    (tmp_path / "outer" / "SKILL.md").write_text(MD.format(n="outer", d="外层的"), encoding="utf-8")
    got = discover(tmp_path)
    assert [s.name for s in got] == ["outer"]


def test_internal_hidden(tmp_path):
    _mk(tmp_path, "skills/pub", MD.format(n="pub", d="公开"))
    _mk(tmp_path, "skills/hid", "---\nname: hid\ndescription: 内部\ninternal: true\n---\n")
    got = discover(tmp_path)
    briefs = {b["name"]: b for b in (s.brief() for s in got)}
    assert briefs["hid"]["hidden"] is True
    assert briefs["pub"]["hidden"] is False
    shown = {b["name"] for b in (s.brief(show_internal=True) for s in got)}
    assert shown == {"pub", "hid"}


def test_description_fallback_from_body(tmp_path):
    d = tmp_path / "s"
    d.mkdir()
    (d / "SKILL.md").write_text("---\nname: s\n---\n\n这个技能做某件事\n", encoding="utf-8")
    got = discover(tmp_path)
    assert "这个技能做某件事" in got[0].description


def test_hash_stable_and_order_independent():
    a = skill_hash("X", {"b.txt": "2", "a.txt": "1"})
    b = skill_hash("X", {"a.txt": "1", "b.txt": "2"})
    assert a == b


def test_hash_changes_with_content():
    assert skill_hash("X", {}) != skill_hash("Y", {})
    assert skill_hash("X", {"a": "1"}) != skill_hash("X", {"a": "2"})
    assert skill_hash("X", {"a": "1"}) != skill_hash("X", {"a": "1", "b": ""})


def test_files_collected_and_git_skipped(tmp_path):
    _mk(tmp_path, "skills/s", MD.format(n="s", d="d"), **{"ref.md": "参考"})
    (tmp_path / "skills" / "s" / ".git").mkdir()
    (tmp_path / "skills" / "s" / ".git" / "config").write_text("x", encoding="utf-8")
    got = discover(tmp_path)[0]
    assert "ref.md" in got.files
    assert not any(p.startswith(".git") for p in got.files)


def test_pick_by_name_and_path(tmp_path):
    _mk(tmp_path, "skills/a", MD.format(n="alpha", d="A"))
    _mk(tmp_path, "skills/b", MD.format(n="beta", d="B"))
    items = discover(tmp_path)
    assert [s.name for s in pick(items, skills=["alpha"])] == ["alpha"]
    assert [s.name for s in pick(items, paths=["skills/b"])] == ["beta"]
    assert len(pick(items, skills=["*"])) == 2


def test_pick_missing_raises(tmp_path):
    _mk(tmp_path, "skills/a", MD.format(n="alpha", d="A"))
    with pytest.raises(ValueError):
        pick(discover(tmp_path), skills=["nope"])


def test_ambiguous_same_name(tmp_path):
    # 没有约定目录时才会同时扫到两处 —— 约定目录优先是刻意的
    _mk(tmp_path, "one/a", MD.format(n="dup", d="第一处"))
    _mk(tmp_path, "two/a", MD.format(n="dup", d="第二处"))
    items = discover(tmp_path)
    with pytest.raises(ValueError) as ei:
        pick(items, skills=["dup"])
    assert "ambiguous_skill" in str(ei.value)
