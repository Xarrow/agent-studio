"""项目上下文（AGENTS.md）与「记忆存完即用」的测试。

两件事都属于"助手以为自己知道、其实不知道"的典型：
* 目录里的规矩没被读进来 → 它按一般习惯乱来（跑错命令、产物丢在错地方）
* 记忆存成候选但没人确认 → 下一轮照样不知道刚记过什么
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from agent_studio.config import settings
from agent_studio.runtimes.agentscope_rt.compile import (
    PROJECT_CONTEXT_LIMIT,
    project_context,
)


def test_reads_agents_md_in_workdir():
    root = Path(settings.work_dir).resolve()
    d = root / "proj_a"
    d.mkdir(parents=True, exist_ok=True)
    (d / "AGENTS.md").write_text("# 规矩\n- 测试用 pytest -q\n- 产物放 out/", encoding="utf-8")
    text = project_context(str(d))
    assert "这个目录的规矩" in text
    assert "pytest -q" in text
    assert str(d / "AGENTS.md") in text


def test_nearest_file_wins():
    root = Path(settings.work_dir).resolve()
    parent = root / "proj_b"
    child = parent / "sub"
    child.mkdir(parents=True, exist_ok=True)
    (parent / "AGENTS.md").write_text("父级规矩", encoding="utf-8")
    (child / "AGENTS.md").write_text("子级规矩", encoding="utf-8")
    text = project_context(str(child))
    assert "子级规矩" in text and "父级规矩" not in text


def test_falls_back_to_parent():
    root = Path(settings.work_dir).resolve()
    parent = root / "proj_c"
    child = parent / "deep" / "deeper"
    child.mkdir(parents=True, exist_ok=True)
    (parent / "AGENTS.md").write_text("往上找得到的规矩", encoding="utf-8")
    assert "往上找得到的规矩" in project_context(str(child))


def test_no_file_is_empty_and_harmless():
    root = Path(settings.work_dir).resolve()
    d = root / "proj_none"
    d.mkdir(parents=True, exist_ok=True)
    assert project_context(str(d)) == ""
    assert project_context(None) == ""
    assert project_context("/") == ""  # 沙箱外的路径不该被读


def test_truncated_when_too_long():
    root = Path(settings.work_dir).resolve()
    d = root / "proj_big"
    d.mkdir(parents=True, exist_ok=True)
    (d / "AGENTS.md").write_text("x" * (PROJECT_CONTEXT_LIMIT + 500), encoding="utf-8")
    text = project_context(str(d))
    assert "已截断" in text
    assert len(text) < PROJECT_CONTEXT_LIMIT + 500


def test_memory_save_is_effective_immediately():
    """memory_save 落库就是 active —— 不是 candidate（候选 = 等于没记）。"""
    from sqlalchemy import select

    from agent_studio.db import SessionLocal, init_db
    from agent_studio.models import Memory
    from agent_studio.native_tools import _memory_save
    from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx

    async def _go():
        await init_db()
        set_run_ctx(run_id="run_memtest", agent_id="ag_memtest")
        out = await _memory_save("用户喜欢简洁直接的结论")
        clear_run_ctx()
        async with SessionLocal() as db:
            rows = list(
                (
                    await db.execute(
                        select(Memory).where(Memory.source_run_id == "run_memtest")
                    )
                ).scalars()
            )
        return out, rows

    out, rows = asyncio.run(_go())
    assert "已记住" in out
    assert rows and rows[0].status == "active"
    assert rows[0].source == "agent"
