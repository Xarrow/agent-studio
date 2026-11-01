"""技能视图必须能被 AgentScope 的 LocalSkillLoader 发现（回归测试）。

历史 bug：视图用软链建目录，``LocalSkillLoader`` 的 ``os.walk`` 不跟随软链
（``followlinks=False``）→ 一个技能都发现不了 → Toolkit 不注册 ``Skill`` 工具，
而系统提示里的「可用技能」表照样列出这些技能名（它直接读磁盘）。结果是模型
被告知"用 Skill 工具读全文"，工具却不存在：技能全文永远读不到。
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from agentscope.skill import LocalSkillLoader

from agent_studio.runtimes.agentscope_rt.runtime import build_skill_view


def _write_skill(root: Path, name: str, body: str = "# 内容") -> Path:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: 测试用技能\n---\n\n{body}\n", encoding="utf-8"
    )
    return d


def test_skill_view_is_discoverable(tmp_path: Path) -> None:
    skills = tmp_path / "skills"
    skills.mkdir()
    _write_skill(skills, "plan-execute")
    _write_skill(skills, "not-bound")  # 没绑定的不该出现在视图里
    work = tmp_path / "run"

    view = build_skill_view(["plan-execute"], skills, work)

    found = asyncio.run(LocalSkillLoader(str(view), scan_subdir=True).list_skills())
    names = {getattr(s, "name", str(s)) for s in found}
    assert names == {"plan-execute"}, f"视图里应只有绑定的技能，实际 {names}"

    # 视图必须是真目录（软链会被 os.walk 跳过）
    assert not (view / "plan-execute").is_symlink()


def test_skill_view_empty_when_nothing_bound(tmp_path: Path) -> None:
    skills = tmp_path / "skills"
    skills.mkdir()
    _write_skill(skills, "plan-execute")
    work = tmp_path / "run"

    view = build_skill_view([], skills, work)
    assert list(view.iterdir()) == []


def test_skill_view_is_shared_across_sessions(tmp_path: Path) -> None:
    """同一组技能只落一份：两个会话拿到的必须是同一个目录。"""
    skills = tmp_path / "skills"
    skills.mkdir()
    _write_skill(skills, "plan-execute")

    a = build_skill_view(["plan-execute"], skills, tmp_path / "ses_a")
    b = build_skill_view(["plan-execute"], skills, tmp_path / "ses_b")

    assert a == b, "同一组技能应共用一个视图目录"
    assert a.parent.name == ".skills-view", "视图放在技能库旁边的全局目录，不进会话目录"
    assert not (tmp_path / "ses_a" / ".skills-view").exists()
    assert not (tmp_path / "ses_b" / ".skills-view").exists()


def test_skill_view_busts_when_skill_changes(tmp_path: Path) -> None:
    """技能内容改了要换目录 —— 共享一份不能让会话读到旧版本。"""
    skills = tmp_path / "skills"
    skills.mkdir()
    _write_skill(skills, "plan-execute")
    before = build_skill_view(["plan-execute"], skills, tmp_path / "ses_a")

    _write_skill(skills, "plan-execute", body="# 改过的内容，比原来长一些")
    after = build_skill_view(["plan-execute"], skills, tmp_path / "ses_a")

    assert before != after, "内容变更后应落到新指纹目录"
    assert "改过的内容" in (after / "plan-execute" / "SKILL.md").read_text(encoding="utf-8")


def test_skill_view_cleans_legacy_session_copy(tmp_path: Path) -> None:
    """旧版在会话目录里的 .skills-view 要被顺手清掉（否则一直当用户文件列出来）。"""
    skills = tmp_path / "skills"
    skills.mkdir()
    _write_skill(skills, "plan-execute")

    legacy = tmp_path / "ses_old" / ".skills-view" / "plan-execute"
    legacy.mkdir(parents=True)
    (legacy / "SKILL.md").write_text("# 旧拷贝", encoding="utf-8")

    build_skill_view(["plan-execute"], skills, tmp_path / "ses_old")

    assert not (tmp_path / "ses_old" / ".skills-view").exists(), "会话目录里不该再留技能文件"
