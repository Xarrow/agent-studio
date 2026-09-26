"""外部触发 /api/hooks/{token} —— 让**别的系统**也能让一条流程跑起来。

为什么是这个形状
----------------
* 凭证放在**路径**里（每条流程一把）：外部系统往往只能配一个 URL（webhook、
  监控告警、IFTTT 式的服务），没有地方塞 header。路径即 key 最省事。
* **GET 与 POST 都收**：能用 curl 一行试通（`curl https://…/api/hooks/xxx`），
  也能给正经系统 POST 一个 JSON。
* 触发时可以用 body 里的 ``task`` **临时换任务**；不给就用流程的「默认任务」。
  这样同一把 key 既能"跑固定日报"，也能"带着今天的参数跑一次"。
* 这个路径**不走平台口令**（见 main.py 的 AUTH_EXEMPT_PREFIXES）：token 本身就是
  凭证，口令 + token 两道会卡死所有不能自定义 header 的调用方。
  ⚠️ 所以 token 是敏感凭据：界面上可一键重置（旧的立即失效）。

刻意不做：把外部触发做成"第三方平台的适配器"（钉钉/飞书/Slack 各一套）。
先给一个通的、通用的入口；具体平台是调用方的事。
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Workflow, now_ms

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/hooks", tags=["hooks"])


async def _find_by_token(session: AsyncSession, token: str) -> Workflow:
    wf = (
        await session.execute(select(Workflow).where(Workflow.trigger_token == token))
    ).scalar_one_or_none()
    if wf is None or not token:
        # 不区分"没这个 token"和"token 为空"——别给探测者任何信息
        raise HTTPException(status.HTTP_404_NOT_FOUND, "触发地址无效（可能已被重置）")
    return wf


async def _fire(session: AsyncSession, wf: Workflow, task: str | None) -> dict[str, Any]:
    from .workflows import start_run_for_workflow  # 局部导入：避免启动期循环依赖

    final_task = (task or "").strip() or (wf.default_task or "").strip()
    if not final_task:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "这条流程还没有「默认任务」，请求里也没带 task —— 不知道该拿什么任务去跑",
        )
    orc_id, spec = await start_run_for_workflow(
        session, wf, final_task, origin="webhook", name_suffix=" · 外部触发"
    )
    wf.last_run_at = now_ms()
    wf.last_run_source = "webhook"
    await session.commit()
    logger.info("外部触发：%s → %s", wf.name, orc_id)
    return {
        "ok": True,
        "workflow": wf.name,
        "workflow_id": wf.id,
        "task": final_task,
        "mode": spec["mode"],
        "orchestration_id": orc_id,
        # 怎么盯这次执行（现成的观测通道，外部系统直接接）
        "stream_path": f"/api/orchestrations/stream/{orc_id}",
    }


@router.post("/{token}", response_model=dict)
async def trigger_post(
    token: str, request: Request, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """POST 触发一次执行。body 可选：``{"task": "今天要做什么"}``。"""
    task: str | None = None
    try:
        body = await request.json()
        if isinstance(body, dict):
            task = str(body.get("task") or body.get("text") or "") or None
    except Exception:  # noqa: BLE001 —— 空 body / 不是 JSON 都当"用默认任务"
        task = None
    wf = await _find_by_token(session, token)
    return await _fire(session, wf, task)


@router.get("/{token}", response_model=dict)
async def trigger_get(
    token: str,
    task: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """GET 触发（方便 curl / 浏览器直接试）：``?task=...`` 可选。"""
    wf = await _find_by_token(session, token)
    return await _fire(session, wf, task)
