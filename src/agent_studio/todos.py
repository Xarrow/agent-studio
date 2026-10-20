"""跨轮任务清单（todo）—— 助手自己列的步骤，下一轮还记得。

为什么需要平台存一份
--------------------
AgentScope 的 TaskCreate/TaskUpdate 把清单放在 ``agent.state.tasks_context`` 里。
平台**每一轮都重新编译 agent**（多轮对话的上下文靠 session_message 重建），
所以清单本来每轮都会清零：用户上一轮看它列了五步、标到第二步，下一轮问"继续"，
它自己完全不记得 —— 只能再猜一遍。

这里做两件事：
1. 跑完一轮，把清单**存回库**（``session_plan``，按会话）
2. 下一轮编译好之后，先 ``restore_plan`` 再开跑，运行时会把它注入 prompt

工具本身用运行时的（AgentScope 那套提示词写得很细），平台只负责搬运 ——
换 pi / 自研运行时只要实现 snapshot_plan / restore_plan 两个钩子。
"""

from __future__ import annotations

import logging
from typing import Any

from .db import SessionLocal
from .models import SessionPlan, now_ms

logger = logging.getLogger(__name__)


async def load(session_id: str | None) -> dict[str, Any] | None:
    """取这个会话上一轮留下的清单（没有就 None）。"""
    if not session_id:
        return None
    async with SessionLocal() as db:
        row = await db.get(SessionPlan, session_id)
        if row is None or not (row.plan or {}).get("tasks"):
            return None
        return dict(row.plan)


async def save(session_id: str | None, plan: dict[str, Any] | None) -> None:
    """把这一轮结束时的清单存下来。

    ``plan`` 为空 = 清单已经清干净了（任务全完成或被删）→ 删掉这行，
    免得界面一直挂着一条早就做完的清单。
    """
    if not session_id:
        return
    async with SessionLocal() as db:
        row = await db.get(SessionPlan, session_id)
        tasks = list((plan or {}).get("tasks") or [])
        if not tasks:
            if row is not None:
                await db.delete(row)
                await db.commit()
            return
        if row is None:
            db.add(SessionPlan(session_id=session_id, plan=dict(plan or {}), updated_at=now_ms()))
        else:
            row.plan = dict(plan or {})
            row.updated_at = now_ms()
        await db.commit()


def summarise(plan: dict[str, Any] | None) -> list[dict[str, Any]]:
    """把运行时的清单快照压成界面要的最小结构（平台不解释框架细节）。"""
    out: list[dict[str, Any]] = []
    for t in list((plan or {}).get("tasks") or []):
        if not isinstance(t, dict):
            continue
        out.append(
            {
                "id": str(t.get("id") or ""),
                "subject": str(t.get("subject") or t.get("title") or ""),
                "state": str(t.get("state") or "pending"),
            }
        )
    return out
