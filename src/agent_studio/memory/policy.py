"""Agent 的记忆策略 —— 读写 ``memory_policy`` 表（无记录时用默认值）。

为什么不给每个 Agent 预建策略行：Agent 创建/复制/删除的路径都要同步维护，
容易漏；用"缺省即默认"的方式读，写入时才落库，逻辑简单且不会出现脏数据。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from ..models import MemoryPolicy, now_ms
from ..schemas import MemoryPolicyRead

#: 默认策略 —— 安全默认：召回开（明显有益）、自动沉淀关（有成本，需显式开启）
DEFAULT_POLICY: dict[str, Any] = {
    "auto_extract": False,
    "recall_enabled": True,
    "recall_top_k": 5,
    "recall_strategy": "hybrid",
    "recall_backend": "local",
    "max_inject_chars": 2000,
    "extract_model": None,
    "compress_after_turns": 10,
}


def to_read(agent_id: str, row: MemoryPolicy | None) -> MemoryPolicyRead:
    """ORM → DTO（缺行时返回默认值）。"""
    if row is None:
        return MemoryPolicyRead(agent_id=agent_id, **DEFAULT_POLICY)
    return MemoryPolicyRead(
        agent_id=agent_id,
        auto_extract=bool(row.auto_extract),
        recall_enabled=bool(row.recall_enabled),
        recall_top_k=row.recall_top_k,
        recall_strategy=row.recall_strategy,
        recall_backend=getattr(row, "recall_backend", None) or "local",
        max_inject_chars=row.max_inject_chars,
        extract_model=row.extract_model,
        compress_after_turns=row.compress_after_turns,
    )


async def get_policy(session: AsyncSession, agent_id: str) -> MemoryPolicyRead:
    return to_read(agent_id, await session.get(MemoryPolicy, agent_id))


async def get_or_create_row(session: AsyncSession, agent_id: str) -> MemoryPolicy:
    row = await session.get(MemoryPolicy, agent_id)
    if row is None:
        row = MemoryPolicy(agent_id=agent_id, **DEFAULT_POLICY)
        session.add(row)
        await session.flush()
    return row


async def update_policy(
    session: AsyncSession, agent_id: str, patch: dict[str, Any]
) -> MemoryPolicyRead:
    """局部更新（只覆盖显式传入的字段）。"""
    row = await get_or_create_row(session, agent_id)
    for key, value in patch.items():
        if value is None or key == "agent_id":
            continue
        if key in ("auto_extract", "recall_enabled"):
            setattr(row, key, 1 if value else 0)
        else:
            setattr(row, key, value)
    row.updated_at = now_ms()
    await session.commit()
    await session.refresh(row)
    return to_read(agent_id, row)
