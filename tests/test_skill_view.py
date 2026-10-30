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
