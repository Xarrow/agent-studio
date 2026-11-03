"""平台原生「Agent 互操作」工具 —— 让正在运行的助手能盘点、查看、复制、停止其他助手。

四个能力（P1.5，2026-09-27 方案；worker_stop 2026-11-03 增补）：
  list_agents  看看平台里有哪些助手（名字/职责一句话/工具数）
  read_agent   看某个助手的完整配置（提示词、模型、工具、技能）—— 判断"它适不适合接这活"
  fork_agent   把某个助手复制一份变体（可改名字/职责）—— 之后 fork 派发指名它
  worker_stop  强制停止某个 worker 正在跑的执行 —— Router 干预 worker 的硬通道

设计口径：
  * 全部走 ORM 直接读写（和 api/agents.py 同一张表），不经过 HTTP —— 工具在进程内执行
  * 只读工具不设限；fork_agent 挂 guard：只能由**正在执行**的助手调用（与 fork 工具同一条纪律），
    且新变体**不带 fork 工具**（防止自我复制失控；要放开也在界面上放开，不靠模型自觉）
  * 新助手的 parent_id 指回源助手 —— 血缘在 Agents 页已有展示，不新增列
  * worker_stop 是**平台控制通道**（run_service.abort → dispatcher task.cancel → 落终态），
    不是"给 worker 发一句话"——那种消息式弱关联在 worker 独立会话里根本送不进去。
    停止后 run 落 aborted 终态，watch_worker 的事件回流照常走（报告 kind=failed 但带
    run_status=aborted），Router 收口时能知道是"被停的"不是"干砸的"。
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


async def _worker_stop(worker: str, reason: str = "") -> str:
    """强制停止某个 worker 正在跑的执行（平台控制通道，不是发消息）。

    参数：
      worker worker 助手名字（必填）；也可填 run_id（ag 前缀名字优先按名字查）
      reason 停止原因一句话（记进中止记录，Router 收口/界面上能看到）
    """
    from sqlalchemy import select as _select

    from .models import Run
    from .runner import service as _run_service
    from .supervisor import agent_busy

    want = (worker or "").strip()
    if not want:
        return "worker 不能为空：填要停的助手名字。"

    ctx = current_run_ctx()
    if not ctx.get("run_id"):
        return "停止失败：worker_stop 只能由正在运行的助手调用（防止接口误触）。"

    async with SessionLocal() as session:
        # 名字优先；直接给了 run id（run_ 前缀）就按 run 查
        run: Run | None = None
        agent_name = want
        if want.startswith("run_"):
            run = await session.get(Run, want)
            if run is None:
                return f"停止失败：没有 run {want}。"
        if run is None:
            a = (
                await session.execute(_select(Agent).where(Agent.name == want))
            ).scalars().first()
            if a is None:
                all_names = [
                    x.name for x in (await session.execute(_select(Agent))).scalars()
                ]
                return f"停止失败：没有叫「{want}」的助手（现有：{'、'.join(all_names) or '无'}）。"
            agent_name = a.name
            # 只停 worker 自己的执行（origin=worker），不动编排/对话轮次
            run = await agent_busy(session, a.id)
        if run is None:
            return f"{agent_name} 现在没有在跑的活，不用停。"
        run_id, run_status = run.id, run.status

    ok = await _run_service.run_service.abort(run_id)
    if not ok:
        return f"停止失败：run {run_id} 不在可停止状态（当前 {run_status}）。"
    why = (reason or "").strip()
    return (
        f"已停止【{agent_name}】的执行（run {run_id}{'，原因：' + why if why else ''}）。"
        f"它的收尾报告会照常回流到票上（状态=已中止）。"
    )


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
WORKER_STOP_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "worker": {
            "type": "string",
            "description": "要停的 worker：助手名字（常用）或 run id（run_ 开头）",
        },
        "reason": {"type": "string", "description": "停止原因一句话（记进中止记录）"},
    },
    "required": ["worker"],
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
    "worker_stop": {
        "fn": _worker_stop,
        "description": (
            "强制停止某个 worker 正在跑的执行（平台控制通道，立即生效，不是给它发消息）。"
            "场景：派错了、方向不对要重派、或用户要求停下。停完它的收尾报告照常回流到票上。"
        ),
        "schema": WORKER_STOP_SCHEMA,
        # 改外部状态（把别人的 run 打成终态）、非并发安全：同 fork_agent 一档
        "flags": {"read_only": False, "concurrency_safe": False, "dangerous": True, "native": True},
    },
}
