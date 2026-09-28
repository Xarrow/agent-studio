"""fork 剥离护栏 —— 子实例不能再分派（深度限 1）。

真出过的问题：定义里的工具项形如 ``{"ref": "tl_xxx", "enabled": true}``，
**名字在 Tool 表里**；按名字过滤时如果不先解析 ref，`"tl_xxx" != "fork"`
永远成立 → 「双保险」形同虚设，子执行的快照里 fork 工具还在。
（同一个坑在 agent_ops 里踩过一次，这里是第二次 —— 所以立测试。）
"""

import pytest
from sqlalchemy import select

from agent_studio.db import SessionLocal
from agent_studio.fanout import _without_fork
from agent_studio.models import Tool, new_id, now_ms


async def _drop_tools(ids: list[str]) -> None:
    """用完就删 —— 测试库是 session 级共享的，留下工具行会污染别的用例
    （实测：test_portability 按工具计数，多出来的行让它变红）。"""
    from sqlalchemy import delete as _del

    async with SessionLocal() as s:
        await s.execute(_del(Tool).where(Tool.id.in_(ids)))
        await s.commit()


async def _mk_tool(name: str, kind: str) -> str:
    async with SessionLocal() as s:
        row = Tool(
            id=new_id("tl_"),
            kind=kind,
            name=name,
            description="",
            input_schema={},
            impl={},
            flags={},
            created_at=now_ms(),
            updated_at=now_ms(),
        )
        s.add(row)
        await s.commit()
        return row.id


@pytest.mark.asyncio
async def test_without_fork_resolves_ref_to_name(client):
    """只有 ref 的工具项也要能被识别出 fork 并剥掉。"""
    fork_id = await _mk_tool("fork", "fork")
    read_id = await _mk_tool("read_护栏", "builtin")

    tools = [
        {"ref": read_id, "enabled": True},
        {"ref": fork_id, "enabled": True},  # 没有 name —— 就是线上数据的形状
        {"ref": read_id, "enabled": True},
    ]
    async with SessionLocal() as s:
        kept = await _without_fork(s, tools)

    refs = [t["ref"] for t in kept]
    assert fork_id not in refs, "fork 没被剥掉（ref 没解析成名字）"
    assert refs == [read_id, read_id], "其它工具不该被动"

    await _drop_tools([fork_id, read_id])


@pytest.mark.asyncio
async def test_without_fork_keeps_other_kinds_and_tolerates_junk(client):
    """非 fork 的工具（含平台原生/HTTP）照常保留；坏数据不炸。"""
    native_id = await _mk_tool("list_agents_护栏", "native")
    http_id = await _mk_tool("自定义_护栏", "http")
    async with SessionLocal() as s:
        kept = await _without_fork(
            s,
            [
                {"ref": native_id, "enabled": True},
                {"ref": http_id, "enabled": True},
                {"ref": "tl_不存在的id", "enabled": True},  # 查不到名字 → 保留，不误删
                "not-a-dict",  # 脏数据
            ],
        )
    assert len(kept) == 4

    await _drop_tools([native_id, http_id])
