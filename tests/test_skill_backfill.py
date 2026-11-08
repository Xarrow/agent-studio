"""勾了技能却在对话里找不到 —— 因为盘上没有它的目录。

实测：东京实例某个助手挂了 8 个技能，``work/skills/`` 里只有 3 个目录
（换机器/迁移数据库时正文在库里、文件没带过来）。``build_skill_view`` 只把
盘上存在的名字拷进视图，``skill_catalog`` 也只列盘上的 —— 于是模型看到的
"可用技能"比界面少，用户那边就是"我勾了但找不到"。

修法：运行时入口按绑定名补齐缺失目录（库里正文准），本用例锁住这条修复。
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import delete

from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Skill
from agent_studio.skills_lifecycle import ensure_skill_files, write_skill_files


def test_写文件会把正文和附件都落到目录(tmp_path: Path) -> None:
    row = Skill(
        id="sk_test_write",
        name="demo-skill",
        description="测试",
        content="# 标题\n\n正文",
        files={"references/a.md": "附件内容"},
    )
    target = write_skill_files(row, tmp_path)

    assert (target / "SKILL.md").read_text(encoding="utf-8").startswith("# 标题")
    assert (target / "references/a.md").read_text(encoding="utf-8") == "附件内容"


async def test_库里勾着但盘上没有的会被补回来(tmp_path: Path, monkeypatch) -> None:
    from agent_studio import skills_lifecycle

    monkeypatch.setattr(skills_lifecycle, "skills_dir", lambda: tmp_path)
    await init_db()
    async with SessionLocal() as s:
        await s.execute(delete(Skill).where(Skill.id == "sk_test_backfill"))
        s.add(
            Skill(
                id="sk_test_backfill",
                name="backfill-demo",
                description="测试",
                content="# 补写\n\n正文",
                files={},
            )
        )
        await s.commit()

    assert not (tmp_path / "backfill-demo" / "SKILL.md").exists()

    fixed = await ensure_skill_files(["backfill-demo", "根本不存在的技能"])

    assert fixed == ["backfill-demo"]
    assert (tmp_path / "backfill-demo" / "SKILL.md").read_text(encoding="utf-8").startswith("# 补写")

    # 第二次什么也不做（不重复写、不误报）
    assert await ensure_skill_files(["backfill-demo"]) == []

    async with SessionLocal() as s:
        await s.execute(delete(Skill).where(Skill.id == "sk_test_backfill"))
        await s.commit()
