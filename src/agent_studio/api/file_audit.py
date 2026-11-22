"""文件操作审计的读出口。

只给界面看「最近助手都动过哪些文件、谁点头的、谁拦下的」，不做写操作
（写入口在 ``file_policy.audit``：守卫和续跑接口在判定的那一刻记，别处不该补记）。

为什么不是一个一级页面：用户要的是"运行记录或设置里能查到即可"。
放在系统设置里跟「危险模式」开关同一段 —— 开了危险模式立刻能在下面看到
「跳过」的那几条，因果关系一目了然。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import file_policy
from ..db import get_session
from ..models import FileAudit

router = APIRouter(prefix="/api/file-audit", tags=["file-audit"])


def _row(row: FileAudit) -> dict[str, Any]:
    return {
        "id": row.id,
        "ts": row.ts,
        "agent_id": row.agent_id,
        "agent_name": row.agent_name,
        "run_id": row.run_id,
        "session_id": row.session_id,
        "path": row.path,
        "op": row.op,
        "result": row.result,
        "result_label": file_policy.RESULT_LABELS.get(row.result, row.result),
        "rule": row.rule,
        "detail": row.detail,
    }


@router.get("")
async def list_audit(
    limit: int = Query(default=30, ge=1, le=200),
    result: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """最近的文件操作（默认 30 条，时间倒序）+ 危险模式当前状态。"""
    stmt = select(FileAudit).order_by(FileAudit.ts.desc(), FileAudit.id.desc()).limit(limit)
    if result:
        stmt = stmt.where(FileAudit.result == result)
    rows = (await session.execute(stmt)).scalars().all()
    total = int(
        (await session.execute(select(func.count(FileAudit.id)))).scalar_one() or 0
    )
    return {
        "items": [_row(r) for r in rows],
        "total": total,
        "danger_mode": await file_policy.skip_confirm(),
        "results": [{"value": k, "label": v} for k, v in file_policy.RESULT_LABELS.items()],
        #: 禁区（界面要能告诉用户"哪些位置永远碰不得"）
        "protected": list(file_policy.protected_roots()),
    }


@router.get("/summary")
async def summary(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """按结果分组计数 —— 用户第一眼看的应该是"被拦下几次、跳过了几次"。"""
    rows = (
        await session.execute(
            select(FileAudit.result, func.count(FileAudit.id)).group_by(FileAudit.result)
        )
    ).all()
    counts = {str(k or ""): int(v) for k, v in rows}
    return {
        "counts": {k: counts.get(k, 0) for k in file_policy.RESULT_LABELS},
        "labels": file_policy.RESULT_LABELS,
        "danger_mode": await file_policy.skip_confirm(),
        "protected": list(file_policy.protected_roots()),
    }
