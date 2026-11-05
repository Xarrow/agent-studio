"""版本历史与回滚 /api/revisions

为什么值得做成接口（而不是"界面上看看"）
----------------------------------------
用户对"改坏"的恐惧是真实的：没有历史，每改一次提示词都在赌。有了它，
改动变成可逆动作 —— 这也是"敢用"和"不敢用"的分界线。

设计要点见 ``revisions.py``：
  · 一个泛化表（助手 / 流程共用）
  · 回滚 = 前进（新建一条快照，历史只增不改）
  · 内容一样不记（否则自动保存会把历史刷成噪声）
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Revision
from ..revisions import (
    KINDS,
    _payload_of,
    delete_revision,
    diff_payload,
    list_revisions,
    restore,
    summarize,
)

router = APIRouter(prefix="/api/revisions", tags=["revisions"])


def _to_read(row: Revision) -> dict[str, Any]:
    return {
        "id": row.id,
        "kind": row.kind,
        "target_id": row.target_id,
        "version": row.version,
        # 「改了什么」—— 界面上直接显示这句人话，用户不用逐字段对比
        "label": row.label,
        "created_at": row.created_at,
    }


@router.get("", response_model=dict)
async def read_revisions(
    kind: str = Query(..., description="agent / workflow"),
    target_id: str = Query(...),
    limit: int = Query(50, ge=1, le=200),
    with_payload: bool = Query(False, description="是否带完整快照内容（用于对比/预览）"),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    if kind not in KINDS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"不支持的对象类型：{kind}")
    rows = await list_revisions(session, kind, target_id, limit)
    latest = rows[0].version if rows else 0
    items = []
    for r in rows:
        item = _to_read(r)
        item["current"] = r.version == latest
        if with_payload:
            item["payload"] = r.payload or {}
        items.append(item)
    return {"items": items, "latest_version": latest}


@router.post("/{rev_id}/restore", response_model=dict)
async def restore_revision(
    rev_id: str, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """回到这一版（**新建一条快照，历史不改写**）。"""
    row = await session.get(Revision, rev_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "这个版本不存在（可能已被清理）")
    try:
        info = await restore(session, row)
    except LookupError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    await session.commit()
    return {"ok": True, "kind": row.kind, "target_id": row.target_id, **info}


@router.get("/{rev_id}", response_model=dict)
async def read_revision(rev_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """单个版本（带完整快照，用于预览这一版长什么样）。"""
    row = await session.get(Revision, rev_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "这个版本不存在（可能已被删除）")
    return {**_to_read(row), "payload": row.payload or {}}


@router.get("/{rev_id}/diff", response_model=dict)
async def diff_revision(
    rev_id: str,
    against: str = Query(
        "prev",
        description="和谁比：prev=上一版（默认）/ current=当前状态 / rev_xxx=指定版本",
    ),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """这一版相对「上一版 / 当前 / 指定版」改了什么。

    「上一版」是默认口径：用户点开某条历史，想知道的是"这一版动了什么"。
    """
    row = await session.get(Revision, rev_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "这个版本不存在（可能已被删除）")

    if against == "current":
        base_payload = await _payload_of(session, row.kind, row.target_id) or {}
        base_label = "当前状态"
    elif against == "prev":
        prev = (
            await session.execute(
                select(Revision)
                .where(
                    Revision.kind == row.kind,
                    Revision.target_id == row.target_id,
                    Revision.version < row.version,
                )
                .order_by(Revision.version.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        base_payload = dict(prev.payload or {}) if prev else {}
        base_label = f"v{prev.version}" if prev else "（没有更早的版本）"
    else:
        base = await session.get(Revision, against)
        if base is None or base.kind != row.kind or base.target_id != row.target_id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "用来对比的版本不在同一个对象上")
        base_payload = dict(base.payload or {})
        base_label = f"v{base.version}"

    target = dict(row.payload or {})
    changes = diff_payload(base_payload, target)
    return {
        "id": row.id,
        "version": row.version,
        "against": against,
        "against_label": base_label,
        # 一句人话（与列表里的 label 同口径），差异清单给界面渲染成表格
        "summary": summarize(row.kind, base_payload, target),
        "changes": changes,
        "payload": target,
        "base_payload": base_payload,
    }


@router.delete("/{rev_id}", response_model=dict)
async def delete_revision_endpoint(
    rev_id: str, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """删掉一条历史（当前配置不受影响 —— 它存在助手/流程本身上）。"""
    try:
        kind = await delete_revision(session, rev_id)
    except LookupError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    await session.commit()
    return {"ok": True, "id": rev_id, "kind": kind}
