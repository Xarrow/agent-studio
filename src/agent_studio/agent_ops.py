"""平台原生「Agent 互操作」工具 —— 让正在运行的助手能盘点、查看、复制其他助手。

三个能力（P1.5，2026-09-27 方案）：
  list_agents  看看平台里有哪些助手（名字/职责一句话/工具数）
  read_agent   看某个助手的完整配置（提示词、模型、工具、技能）—— 判断"它适不适合接这活"
  fork_agent   把某个助手复制一份变体（可改名字/职责）—— 之后 fork 派发指名它

设计口径：
  * 全部走 ORM 直接读写（和 api/agents.py 同一张表），不经过 HTTP —— 工具在进程内执行
  * 只读工具不设限；fork_agent 挂 guard：只能由**正在执行**的助手调用（与 fork 工具同一条纪律），
    且新变体**不带 fork 工具**（防止自我复制失控；要放开也在界面上放开，不靠模型自觉）
  * 新助手的 parent_id 指回源助手 —— 血缘在 Agents 页已有展示，不新增列
"""

from __future__ import annotations

import copy
import json
from typing import Any

from sqlalchemy import select

from .db import SessionLocal
from .models import Agent, Tool, new_id, now_ms
from .runner.ctx import current_run_ctx


def _brief(a: Agent) -> str:
    tools = (a.definition or {}).get("tools") or []
    return (
        f"- {a.name}：{(a.description or '').strip()[:80] or '（无描述）'} · "
        f"{len(tools)} 个工具 · runtime={a.runtime}"
    )


async def _list_agents() -> str:
    """列出平台里全部助手（一行一个：名字、职责、工具数）。"""
    async with SessionLocal() as session:
        rows = list((await session.execute(select(Agent).order_by(Agent.created_at))).scalars())
    if not rows:
        return "平台里还没有助手。"
    return f"共 {len(rows)} 个助手：\n" + "\n".join(_brief(a) for a in rows)


async def _read_agent(name: str) -> str:
    """查看某个助手的完整配置：提示词、模型、工具、技能。"""
    async with SessionLocal() as session:
        row = (
            await session.execute(select(Agent).where(Agent.name == name))
        ).scalars().first()
        if row is None:
            all_names = [
                a.name for a in (await session.execute(select(Agent))).scalars()
            ]
            return f"没有叫「{name}」的助手（现有：{'、'.join(all_names) or '无'}）"
        d = row.definition or {}
        return json.dumps(
            {
                "name": row.name,
                "description": row.description,
                "model": d.get("model"),
                "system_prompt": (d.get("system_prompt") or "")[:2000],
                "tools": [t if isinstance(t, str) else (t or {}).get("ref") for t in (d.get("tools") or [])],
                "skills": [s if isinstance(s, str) else (s or {}).get("ref") for s in (d.get("skills") or [])],
                "runtime": row.runtime,
            },
            ensure_ascii=False,
        )


async def _fork_agent(
    source: str,
    new_name: str = "",
    description: str = "",
) -> str:
    """复制某个助手为新变体（血缘记在 parent_id）。

    参数：
      source      源助手名字（必填）
      new_name    新名字（不填 =「源名-v2」自动顺延）
      description 新职责一句话（不填 = 继承源）
    """
    ctx = current_run_ctx()
    if not ctx.get("run_id"):
        return "复制失败：当前不在一次执行上下文中（fork_agent 只能由正在运行的助手调用）。"

    async with SessionLocal() as session:
        src = (
            await session.execute(select(Agent).where(Agent.name == source))
        ).scalars().first()
        if src is None:
            return f"复制失败：没有叫「{source}」的助手。"
        name = (new_name or "").strip()
        if not name:
            # 自动顺延：源名-v2、源名-v3 …
            n = 2
            names = {
                a.name
                for a in (await session.execute(select(Agent))).scalars()
            }
            while f"{src.name}-v{n}" in names:
                n += 1
            name = f"{src.name}-v{n}"
        dup = (
            await session.execute(select(Agent).where(Agent.name == name))
        ).scalars().first()
        if dup is not None:
            return f"复制失败：已经有叫「{name}」的助手（复制来源：{source}）。"

        definition = copy.deepcopy(src.definition or {})
        # 新变体不带 fork 工具 —— 防止自我复制失控（与 fanout 派发实例同一条纪律）。
        # 注意 definition.tools 存的是 {ref: Tool行id}，**名字在 Tool 表里**，
        # 按 "fork" 字符串过滤永远不匹配（现场：v2 原样带走了 12 个工具）。
        fork_tool_ids = {
            t.id
            for t in (
                await session.execute(select(Tool).where(Tool.name == "fork"))
            ).scalars()
        }
        definition["tools"] = [
            t for t in (definition.get("tools") or [])
            if (t if isinstance(t, str) else (t or {}).get("ref")) not in fork_tool_ids
        ]
        row = Agent(
            id=new_id("ag_"),
            slug=f"{src.slug}-v{int(now_ms() / 1000)}"[:60],
            name=name,
            description=(description or "").strip() or src.description,
            runtime=src.runtime,
            version=1,
            parent_id=src.id,   # 血缘：Agents 页已有展示
            definition=definition,
        )
        session.add(row)
        await session.commit()
        return f"已创建助手「{name}」（复制自 {source}）。之后用 fork 工具、agent 参数填「{name}」就能把活派给它。"


# --------------------------------------------------------------------------- #
# 工具注册表（sync_builtins / compile 共用，同 fetch/web_search/python）
# --------------------------------------------------------------------------- #
LIST_SCHEMA: dict[str, Any] = {"type": "object", "properties": {}, "required": []}
READ_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"name": {"type": "string", "description": "助手名字"}},
    "required": ["name"],
}
FORK_AGENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "source": {"type": "string", "description": "要复制的助手名字"},
        "new_name": {"type": "string", "description": "新名字（不填自动 v2/v3 顺延）"},
        "description": {"type": "string", "description": "新职责一句话（不填继承源）"},
    },
    "required": ["source"],
}

AGENT_OPS_TOOLS: dict[str, dict[str, Any]] = {
    "list_agents": {
        "fn": _list_agents,
        "description": "列出平台里所有助手：名字、职责一句话、工具数。接活前先看看有谁能干。",
        "schema": LIST_SCHEMA,
        "flags": {"read_only": True, "concurrency_safe": True, "dangerous": False, "native": True},
    },
    "read_agent": {
        "fn": _read_agent,
        "description": "查看某个助手的完整配置（提示词/模型/工具/技能），判断它适不适合接某个活。",
        "schema": READ_SCHEMA,
        "flags": {"read_only": True, "concurrency_safe": True, "dangerous": False, "native": True},
    },
    "fork_agent": {
        "fn": _fork_agent,
        "description": (
            "把某个助手复制一份变体（可改名字/职责），返回新助手名。"
            "适合「它差点意思，照它改一版」的场景；新变体不带分派工具。"
        ),
        "schema": FORK_AGENT_SCHEMA,
        "flags": {"read_only": False, "concurrency_safe": False, "dangerous": False, "native": True},
    },
}
