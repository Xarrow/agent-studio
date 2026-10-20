"""技能使用计数 —— 让「这个技能还有用吗」有据可查。

为什么需要：平台的技能只会越攒越多（助手自己沉淀、仓库安装、手写），
攒到几十个之后没人知道哪几个是真在用的。没有使用数据，"整理"就只能靠猜，
而靠猜整理一定会删掉别人正在用的东西。

计数口径（必须说清楚，否则数字会骗人）：
* **调用一次 +1**：模型用 ``Skill`` 工具真把这份技能读进上下文，才算"用了"。
* 只是"列在提示清单里"**不算** —— 每个技能每轮都被列一次，那样所有技能的数字
  都一样大，等于没信息。
* 读失败（名字写错）也计数：说明它在被想起，只是名字对不上，这反而是要修的信号。
"""

from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger(__name__)

_PATCHED = False
#: 持有任务引用，避免被 GC 提前回收（传引用给后台写库）
_PENDING: set[asyncio.Task] = set()


async def _bump(skill_name: str) -> None:
    """按名字给技能 +1。技能是按目录名（= slug）认的，与展示名可能不同。"""
    from sqlalchemy import select

    from .db import SessionLocal
    from .models import Skill, now_ms

    from .runner.ctx import current_run_ctx

    try:
        ctx = current_run_ctx() or {}
    except Exception:  # noqa: BLE001
        ctx = {}
    run_id = str(ctx.get("run_id") or "") or None

    name = (skill_name or "").strip()
    if not name:
        return
    try:
        async with SessionLocal() as db:
            row = (
                await db.execute(select(Skill).where(Skill.name == name))
            ).scalars().first()
            if row is None:
                # 展示名与目录名不一致时，按"内容里写着这个名字"兜底找一遍
                rows = list((await db.execute(select(Skill))).scalars())
                row = next((r for r in rows if r.name.lower() == name.lower()), None)
            if row is None:
                return
            row.use_count = int(row.use_count or 0) + 1
            row.last_used_at = now_ms()
            if run_id:
                row.last_used_run_id = run_id
            await db.commit()
    except Exception:  # noqa: BLE001 —— 计数失败绝不能影响读技能本身
        logger.debug("技能使用计数失败 %s", name, exc_info=True)


def note_use(skill_name: str) -> None:
    """记一次使用（不阻塞工具调用）。"""
    try:
        task = asyncio.create_task(_bump(skill_name))
    except RuntimeError:  # 没有事件循环（同步测试/脚本）：直接跳过
        return
    _PENDING.add(task)
    task.add_done_callback(_PENDING.discard)


def install_skill_usage_hook() -> None:
    """给 AgentScope 的 ``Skill`` 工具挂钩子（幂等，进程内只打一次）。

    为什么打在类上而不是实例上：``obj(...)`` 这类调用走的是**类型**查找，
    给实例赋 ``__call__`` 不生效（Python 数据模型的坑）。类级补丁在本进程内
    对所有 Toolkit 生效，正好是我们要的"所有助手、所有技能统一计数"。
    """
    global _PATCHED
    if _PATCHED:
        return
    try:
        from agentscope.tool._builtin._skill import SkillViewer
    except Exception as exc:  # noqa: BLE001 —— 框架换了内部路径：退化成"不计数"
        logger.warning("技能使用计数未启用（SkillViewer 路径变了）: %s", exc)
        return

    original = SkillViewer.__call__

    async def counted(self, *args, **kwargs):
        name = kwargs.get("skill") or kwargs.get("name") or (args[0] if args else "")
        if isinstance(name, str) and name.strip():
            note_use(name)
        return await original(self, *args, **kwargs)

    SkillViewer.__call__ = counted
    _PATCHED = True
    logger.info("技能使用计数已启用（Skill 工具调用 +1）")
