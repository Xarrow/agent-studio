"""原生记忆工具：写入去重（含归档恢复）。"""

from __future__ import annotations

import pytest

@pytest.mark.asyncio
async def test_memory_save_restores_archived_instead_of_duplicating(monkeypatch):
    """同样的内容归档后再记一次：恢复那条，不再新建一条（防重复）。"""
    from sqlalchemy import select

    from agent_studio.db import SessionLocal
    from agent_studio.models import Memory
    from agent_studio.native_tools import _memory_save

    body = "去重测试：家里的网关是 192.168.2.7"
    n = "".join(body.split())
    async with SessionLocal() as s:
        for old in (await s.execute(select(Memory))).scalars().all():
            if "".join((old.content or "").split()) == n:
                await s.delete(old)
        await s.commit()
        s.add(Memory(agent_id=None, scope="global", kind="fact", layer="memory",
                     content=body, source="agent", status="archived"))
        await s.commit()

    out = await _memory_save(content=body)
    assert "已恢复" in out
    async with SessionLocal() as s:
        rows = [m for m in (await s.execute(select(Memory))).scalars().all()
                if "".join((m.content or "").split()) == n]
        assert len(rows) == 1, "不该多出一条"
        assert rows[0].status != "archived"
