"""/metrics —— Prometheus 文本格式（零依赖手写）。

为什么值得有
------------
"这个平台健康吗"不该在界面上一条条点：有多少执行在跑、队列里排了多少、花了多少钱、
事件表多大了、库多大 —— 这些是**监控系统该自动看**的东西。
不引 prometheus_client（自持原则），格式就是几行文本。

抓取（需要凭据，和其它接口一样）：
    curl -H "Authorization: Bearer <口令>" http://<host>:8848/metrics
或  curl "http://<host>:8848/metrics?token=<口令>"
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import PlainTextResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db import get_session
from ..models import LlmCall, Run, RunEvent, ToolCall
from ..pricing import cost_of, currency_of, load_prices, tokens_of
from ..runner.dispatcher import dispatcher

router = APIRouter(tags=["metrics"])

_STARTED_AT = int(time.time())


def _line(name: str, value: Any, **labels: Any) -> str:
    if labels:
        inner = ",".join(f'{k}="{v}"' for k, v in labels.items())
        return f"{name}{{{inner}}} {value}"
    return f"{name} {value}"


@router.get("/metrics", response_class=PlainTextResponse)
async def metrics(session: AsyncSession = Depends(get_session)) -> PlainTextResponse:
    out: list[str] = []

    def head(name: str, help_text: str, kind: str = "gauge") -> None:
        out.append(f"# HELP {name} {help_text}")
        out.append(f"# TYPE {name} {kind}")

    # 执行（按状态）
    head("agent_studio_runs_total", "执行总数（按状态）", "counter")
    for status_name, cnt in (
        await session.execute(select(Run.status, func.count()).group_by(Run.status))
    ).all():
        out.append(_line("agent_studio_runs_total", int(cnt), status=status_name))
    in_flight = int(
        (
            await session.execute(
                select(func.count()).select_from(Run).where(Run.status.in_(("pending", "running", "waiting_hitl")))
            )
        ).scalar()
        or 0
    )
    head("agent_studio_runs_in_flight", "还没结束的执行（含排队与等人工确认）")
    out.append(_line("agent_studio_runs_in_flight", in_flight))

    head("agent_studio_queue_pending", "队列里排队等跑的（pending）")
    out.append(
        _line(
            "agent_studio_queue_pending",
            int(
                (
                    await session.execute(
                        select(func.count()).select_from(Run).where(Run.status == "pending")
                    )
                ).scalar()
                or 0
            ),
        )
    )
    head("agent_studio_dispatcher_running", "分发器当前在跑的协程数")
    out.append(_line("agent_studio_dispatcher_running", dispatcher.running_count))
    head("agent_studio_gate_slots", "并发上限配置（0 = 不限）")
    out.append(_line("agent_studio_gate_slots", settings.max_concurrent_runs))

    # 用量与花费（口径与界面一致：没填单价的**不计入金额**，单独报数量）
    prices = await load_prices(session)
    currency = await currency_of(session)
    tokens_in = tokens_out = 0
    cost_total = 0.0
    unpriced = 0
    for run in (await session.execute(select(Run))).scalars():
        usage = run.usage if isinstance(run.usage, dict) else {}
        tin, tout = tokens_of(usage)
        model_name = (run.definition_snapshot or {}).get("model", {}).get("name")
        tokens_in += tin
        tokens_out += tout
        c = cost_of(model_name, tin, tout, prices)
        if c is None and (tin or tout):
            unpriced += 1
        elif c is not None:
            cost_total += c
    head("agent_studio_tokens_total", "累计 tokens（按方向）", "counter")
    out.append(_line("agent_studio_tokens_total", tokens_in, direction="in"))
    out.append(_line("agent_studio_tokens_total", tokens_out, direction="out"))
    head("agent_studio_cost_total", "累计金额（只统计填了单价的模型）", "counter")
    out.append(_line("agent_studio_cost_total", round(cost_total, 6), currency=currency))
    head("agent_studio_unpriced_runs_total", "有 token 但没填单价的执行数（金额不可信的部分）", "counter")
    out.append(_line("agent_studio_unpriced_runs_total", unpriced))

    head("agent_studio_llm_calls_total", "模型调用次数", "counter")
    out.append(
        _line(
            "agent_studio_llm_calls_total",
            int((await session.execute(select(func.count()).select_from(LlmCall))).scalar() or 0),
        )
    )
    head("agent_studio_tool_calls_total", "工具调用次数", "counter")
    out.append(
        _line(
            "agent_studio_tool_calls_total",
            int((await session.execute(select(func.count()).select_from(ToolCall))).scalar() or 0),
        )
    )
    head("agent_studio_event_rows", "事件行数（含已归档的骨架）")
    out.append(
        _line(
            "agent_studio_event_rows",
            int((await session.execute(select(func.count()).select_from(RunEvent))).scalar() or 0),
        )
    )
    head("agent_studio_uptime_seconds", "接口进程已运行秒数")
    out.append(_line("agent_studio_uptime_seconds", int(time.time()) - _STARTED_AT))

    return PlainTextResponse("\n".join(out) + "\n")
