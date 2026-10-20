"""会话定时任务的 HTTP 接口。

产品的用法是"在对话里给这个助手排个班"：
  每天早上 9 点替我汇总三条新闻 → 结果回到这个对话里（还能接着追问），
  同时按配置推一份到飞书/企业微信群（webhook）。

所以入口挂在会话上：``/api/sessions/{id}/jobs``。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..jobs import describe_schedule, fire, next_for, normalise_deliver
from ..models import Session, SessionJob, now_ms
from ..scheduler import SCHEDULE_MODES

router = APIRouter(tags=["jobs"])


class JobIn(BaseModel):
    prompt: str = ""
    mode: str = "daily"
    at: str = "09:00"
    weekdays: str = "1"
    enabled: bool = True
    deliver: dict[str, Any] = Field(default_factory=dict)


class JobPatch(BaseModel):
    prompt: str | None = None
    mode: str | None = None
    at: str | None = None
    weekdays: str | None = None
    enabled: bool | None = None
    deliver: dict[str, Any] | None = None


def to_read(job: SessionJob) -> dict[str, Any]:
    return {
        "id": job.id,
        "session_id": job.session_id,
        "agent_id": job.agent_id,
        "prompt": job.prompt,
        "mode": job.mode,
        "at": job.at,
        "weekdays": job.weekdays,
        "enabled": bool(job.enabled),
        "deliver": job.deliver or {"channel": "session"},
        "schedule_text": describe_schedule(job.mode, job.at, job.weekdays),
        "next_run_at": job.next_run_at,
        "last_run_at": job.last_run_at,
        "last_run_id": job.last_run_id,
        "last_status": job.last_status,
        "created_at": job.created_at,
    }


def _check_mode(mode: str) -> str:
    m = (mode or "").strip().lower()
    if m not in SCHEDULE_MODES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "频率只能是 每小时/每天/每周")
    return m


@router.get("/api/sessions/{session_id}/jobs")
async def list_jobs(
    session_id: str, db: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    rows = list(
        (
            await db.execute(
                select(SessionJob)
                .where(SessionJob.session_id == session_id)
                .order_by(SessionJob.created_at.desc())
            )
        ).scalars()
    )
    return {"items": [to_read(j) for j in rows]}


@router.post("/api/sessions/{session_id}/jobs", status_code=status.HTTP_201_CREATED)
async def create_job(
    session_id: str, body: JobIn, db: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    prompt = (body.prompt or "").strip()
    if not prompt:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "要写清楚每次让它做什么")
    chat = await db.get(Session, session_id)
    if chat is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"会话不存在: {session_id}")
    try:
        deliver = normalise_deliver(body.deliver)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    job = SessionJob(
        session_id=session_id,
        agent_id=chat.agent_id,
        prompt=prompt,
        mode=_check_mode(body.mode),
        at=(body.at or "09:00").strip(),
        weekdays=(body.weekdays or "1").strip(),
        enabled=1 if body.enabled else 0,
        deliver=deliver,
        created_at=now_ms(),
        updated_at=now_ms(),
    )
    job.next_run_at = next_for(job) if job.enabled else None
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return to_read(job)


@router.patch("/api/jobs/{job_id}")
async def patch_job(
    job_id: str, body: JobPatch, db: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    job = await db.get(SessionJob, job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"定时任务不存在: {job_id}")
    if body.prompt is not None:
        job.prompt = body.prompt.strip()
    if body.mode is not None:
        job.mode = _check_mode(body.mode)
    if body.at is not None:
        job.at = body.at.strip()
    if body.weekdays is not None:
        job.weekdays = body.weekdays.strip()
    if body.deliver is not None:
        try:
            job.deliver = normalise_deliver(body.deliver)
        except ValueError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    if body.enabled is not None:
        job.enabled = 1 if body.enabled else 0
    # 开关或时间变了 → 重排下一次（关掉 = 不再排；打开 = 从此刻往后算）
    job.next_run_at = next_for(job) if job.enabled else None
    job.updated_at = now_ms()
    await db.commit()
    await db.refresh(job)
    return to_read(job)


@router.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str, db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    job = await db.get(SessionJob, job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"定时任务不存在: {job_id}")
    await db.delete(job)
    await db.commit()
    return {"deleted": True, "id": job_id}


@router.post("/api/jobs/{job_id}/run-now")
async def run_now(job_id: str) -> dict[str, Any]:
    """立刻跑一次（用户在存之前想确认"它到底会不会跑、结果长什么样"）。"""
    run_id = await fire(job_id, manual=True)
    if run_id is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "没能发起：会话里可能还有一轮在跑，或者这个任务没有提示词",
        )
    return {"run_id": run_id}
