"""Run 资源路由：发起执行、SSE 实时流、事件回放、Trace 与耗时指标。"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import SessionLocal, get_session
from ..models import Agent, LlmCall, ModelTest, Run, RunEvent, ToolCall, now_ms
from ..pricing import cost_of, currency_of, load_prices, price_key, tokens_of
from ..runner import run_service
from ..runner.service import resolve_api_key
from ..schemas import (
    ActivityItem,
    ActivityList,
    AgentDefinition,
    HitlResumeRequest,
    LlmCallRead,
    ModelTestRead,
    RunBulkDeleteRequest,
    RunCreate,
    RunDeleteResponse,
    RunEventRead,
    RunPruneRequest,
    RunRead,
    RunTrace,
    ToolCallRead,
)

from ..runtimes.base import HitlResponse

router = APIRouter(prefix="/api/runs", tags=["runs"])


def to_read(run: Run) -> RunRead:
    return RunRead(
        id=run.id,
        agent_id=run.agent_id,
        agent_version=run.agent_version,
        runtime=run.runtime,
        status=run.status,
        origin=run.origin,
        input=run.input or {},
        output=run.output,
        usage=run.usage or {},
        error=run.error,
        started_at=run.started_at,
        ended_at=run.ended_at,
        pending_hitl=run.pending_hitl,
        session_id=run.session_id,
        turn_index=run.turn_index,
    )


async def _get_or_404(session: AsyncSession, run_id: str) -> Run:
    row = await session.get(Run, run_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Run 不存在: {run_id}")
    return row


# --------------------------------------------------------------------------- #
# 发起执行
# --------------------------------------------------------------------------- #
@router.post("", response_model=RunRead, status_code=status.HTTP_201_CREATED)
async def create_run(payload: RunCreate, session: AsyncSession = Depends(get_session)) -> RunRead:
    agent = await session.get(Agent, payload.agent_id)
    if agent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Agent 不存在: {payload.agent_id}")

    definition = AgentDefinition.model_validate(agent.definition)
    if payload.timeout_s:
        definition.limits.timeout_s = payload.timeout_s

    # 多轮会话：校验会话存在且属于同一个 Agent（防止把 A 的上下文喂给 B）
    session_id: str | None = None
    turn_index: int | None = None
    if payload.session_id:
        from ..models import Session as ChatSession

        chat = await session.get(ChatSession, payload.session_id)
        if chat is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, f"会话不存在: {payload.session_id}"
            )
        if chat.agent_id != agent.id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "会话与 Agent 不匹配：会话属于另一个 Agent，请新建会话",
            )
        session_id = chat.id
        from ..context import next_turn_index

        turn_index = await next_turn_index(session, chat.id)

    run = Run(
        agent_id=agent.id,
        agent_version=agent.version,
        runtime=definition.runtime,
        status="pending",
        input={"text": payload.input} if isinstance(payload.input, str) else payload.input,
        # 冻结定义快照：保证这次 Run 可复现（即使 Agent 之后被改）
        definition_snapshot=definition.model_dump(mode="json", exclude={"model": {"api_key"}}),
        started_at=now_ms(),
        session_id=session_id,
        turn_index=turn_index,
        # 来源决定它在「运行记录」里归到哪一类（对话 / 试跑 / 编排）
        origin=payload.origin if payload.origin in ("chat", "preview", "playground") else None,
    )
    session.add(run)
    await session.commit()
    await session.refresh(run)

    # 后台启动（与 HTTP 生命周期解耦）
    await run_service.start(run.id, definition, payload.input)
    return to_read(run)


# --------------------------------------------------------------------------- #
# 列表 / 详情 / 事件 / Trace
# --------------------------------------------------------------------------- #
@router.get("", response_model=list[RunRead])
async def list_runs(
    agent_id: str | None = None,
    limit: int = Query(default=50, le=200),
    session: AsyncSession = Depends(get_session),
) -> list[RunRead]:
    stmt = select(Run).order_by(Run.started_at.desc()).limit(limit)
    if agent_id:
        stmt = stmt.where(Run.agent_id == agent_id)
    rows = (await session.execute(stmt)).scalars().all()
    return [to_read(r) for r in rows]


@router.get("/events/{run_id}", response_model=list[RunEventRead])
async def get_events(run_id: str, session: AsyncSession = Depends(get_session)) -> list[RunEventRead]:
    """事件回放（SSE 断开后也能拿全量）。"""
    await _get_or_404(session, run_id)
    rows = (
        await session.execute(
            select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq)
        )
    ).scalars().all()
    return [
        RunEventRead(seq=r.seq, type=r.type, ts=r.ts, payload=r.payload or {}) for r in rows
    ]


@router.get("/trace/{run_id}", response_model=RunTrace)
async def get_trace(run_id: str, session: AsyncSession = Depends(get_session)) -> RunTrace:
    """瀑布图数据源：Run + 事件 + LLM 调用明细 + 工具调用明细 + 聚合指标。"""
    run = await _get_or_404(session, run_id)

    events = (
        await session.execute(
            select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq)
        )
    ).scalars().all()

    llm_rows = (
        await session.execute(
            select(LlmCall).where(LlmCall.run_id == run_id).order_by(LlmCall.id)
        )
    ).scalars().all()

    tool_rows = (
        await session.execute(
            select(ToolCall).where(ToolCall.run_id == run_id).order_by(ToolCall.id)
        )
    ).scalars().all()

    agent = await session.get(Agent, run.agent_id)

    return RunTrace(
        run=to_read(run),
        agent_name=agent.name if agent else None,
        events=[
            RunEventRead(seq=e.seq, type=e.type, ts=e.ts, payload=e.payload or {}) for e in events
        ],
        llm_calls=[
            LlmCallRead(
                id=c.id, iteration=c.iteration, provider=c.provider, model=c.model,
                started_at=c.started_at, ended_at=c.ended_at, duration_ms=c.duration_ms,
                ttft_ms=c.ttft_ms, tokens_in=c.tokens_in, tokens_out=c.tokens_out,
                tokens_cache_read=c.tokens_cache_read, cost_usd=c.cost_usd or 0.0,
                status=c.status, error=c.error,
            )
            for c in llm_rows
        ],
        tool_calls=[
            ToolCallRead(
                id=t.id, iteration=t.iteration, tool_name=t.tool_name, args=t.args or {},
                call_id=t.call_id, started_at=t.started_at, ended_at=t.ended_at,
                duration_ms=t.duration_ms, status=t.status, result_size=t.result_size,
                result_preview=t.result_preview, error=t.error,
            )
            for t in tool_rows
        ],
        metrics=run.usage or {},
    )


# --------------------------------------------------------------------------- #
# SSE 实时流（先回放已有事件，再推增量 —— 支持断线重连）
# --------------------------------------------------------------------------- #
@router.get("/stream/{run_id}")
async def stream_run(run_id: str) -> StreamingResponse:
    async def gen():
        queue = run_service.bus.subscribe(run_id)
        last_seq = -1
        try:
            # 1) 回放已落库的事件（含刷新页面/断线重连场景）
            async with SessionLocal() as session:
                rows = (
                    await session.execute(
                        select(RunEvent)
                        .where(RunEvent.run_id == run_id)
                        .order_by(RunEvent.seq)
                    )
                ).scalars().all()
                for row in rows:
                    last_seq = row.seq
                    payload = {
                        "seq": row.seq,
                        "type": row.type,
                        "ts": row.ts,
                        "payload": row.payload or {},
                    }
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

            # 2) 推增量
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=30)
                except TimeoutError:
                    yield ": keep-alive\n\n"      # 心跳，防代理断连
                    continue
                if item is None:                   # Run 结束哨兵
                    break
                if item.get("seq", 0) <= last_seq:  # 去重
                    continue
                last_seq = item["seq"]
                yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"

            yield "event: done\ndata: {}\n\n"
        finally:
            run_service.bus.unsubscribe(run_id, queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --------------------------------------------------------------------------- #
# 控制
# --------------------------------------------------------------------------- #
@router.post("/abort/{run_id}")
async def abort_run(run_id: str, session: AsyncSession = Depends(get_session)) -> dict:
    await _get_or_404(session, run_id)
    ok = await run_service.abort(run_id)
    return {"aborted": ok}


@router.post("/resume/{run_id}")
async def resume_run(
    run_id: str, payload: HitlResumeRequest, session: AsyncSession = Depends(get_session)
) -> dict:
    run = await _get_or_404(session, run_id)
    if run.status != "waiting_hitl":
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"该 Run 不在等待确认状态（当前: {run.status}）"
        )
    # 状态在等确认、待确认内容却是空的 —— 这是"修复前留下的记录"的特征：
    # 那时续跑后再暂停没有落库。这种记录无法恢复（连状态快照都没有），
    # 与其回一句含糊的错误，不如直接说清楚并给出路。
    if not run.pending_hitl:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "这条运行的待确认内容已经丢失（旧的记录格式），没法继续；请重新发起一次。",
        )
    ok = await run_service.resume(
        run_id,
        # payload 允许客户端不传（None）—— 服务端会用自己存的那份合并，
        # 所以这里给 {} 而不是 None（HitlResponse 要求 dict）。
        HitlResponse(
            confirm=payload.confirm, reason=payload.reason, payload=payload.payload or {}
        ),
    )
    return {"resumed": ok}


# --------------------------------------------------------------------------- #
# 对比（放在 /{run_id} 之前，避免路径冲突）
# --------------------------------------------------------------------------- #
@router.get("/compare/two")
async def compare_runs(
    a: str, b: str, session: AsyncSession = Depends(get_session)
) -> dict:
    """并排对比两次 Run（换模型/改提示词后的效果差异）。"""
    run_a = await _get_or_404(session, a)
    run_b = await _get_or_404(session, b)

    async def _side(run: Run) -> dict:
        event_count = (
            await session.execute(
                select(RunEvent.id).where(RunEvent.run_id == run.id)
            )
        ).scalars().all()
        return {
            "run": to_read(run).model_dump(),
            "event_count": len(event_count),
        }

    return {"a": await _side(run_a), "b": await _side(run_b)}


# --------------------------------------------------------------------------- #
# 统一「运行记录」时间线
# --------------------------------------------------------------------------- #
def _run_kind(run: Run) -> str:
    """这条执行记录属于哪一类。

    优先用显式的 origin；老数据没这一列（NULL）时按 session/orchestration 推断：
    带编排 → playground，带会话 → chat，都没有 → preview（助手页试跑）。
    推断只是为了让历史数据也能归类，新数据一律显式记录。
    """
    if run.origin in ("chat", "preview", "playground"):
        return run.origin
    if run.orchestration_id:
        return "playground"
    if run.session_id:
        return "chat"
    return "preview"


def _text_of(blob: Any) -> str:
    """从 input/output 里抠出一句话，够列表显示就行。"""
    if isinstance(blob, str):
        return blob
    if isinstance(blob, dict):
        for k in ("text", "content", "message"):
            v = blob.get(k)
            if isinstance(v, str) and v.strip():
                return v
            if isinstance(v, list) and v and isinstance(v[0], dict):
                c = v[0].get("content") or v[0].get("text")
                if isinstance(c, str) and c.strip():
                    return c
        return ""
    return ""


@router.get("/timeline", response_model=ActivityList)
async def activity_timeline(
    kind: str | None = Query(None, description="chat / preview / playground / llm_test"),
    status: str | None = Query(None),
    agent_id: str | None = Query(None),
    q: str | None = Query(None, description="关键词：主体名 / 模型 / 摘要 / 错误"),
    limit: int = Query(200, ge=1, le=1000),
    session: AsyncSession = Depends(get_session),
) -> ActivityList:
    """把**三类调用**并成一条时间线，供「运行记录」页展示。

    为什么要合并（而不是分三个列表）
    ------------------------------
    用户脑子里的问题是"我发起过哪些调用、结果如何、哪次出错了"，而不是
    "它存在哪张表"。分开放，就等于逼用户在几个列表之间对照着看。

    存储上仍然是分开的，原因见 ``models.ModelTest`` 的注释：
    助手执行（run，带 agent）和裸模型调用（model_test，无 agent）语义不同。
    这里只在**读取时**合并 —— 一次调用就是一次调用。
    """
    # 助手名映射（列表里要显示"哪次是哪个助手跑的"）
    agents = {a.id: a.name for a in (await session.execute(select(Agent))).scalars()}
    # 单价与币种：一次读出来，循环里直接用（别在 for 里查库）
    prices = await load_prices(session)
    currency = await currency_of(session)

    runs = list(
        (await session.execute(select(Run).order_by(Run.started_at.desc()).limit(1000)))
        .scalars()
    )
    tests = list(
        (
            await session.execute(
                select(ModelTest).order_by(ModelTest.started_at.desc()).limit(1000)
            )
        ).scalars()
    )

    items: list[ActivityItem] = []
    for r in runs:
        out = r.output if isinstance(r.output, dict) else {}
        dur = (r.ended_at - r.started_at) if (r.ended_at and r.started_at) else None
        usage = r.usage if isinstance(r.usage, dict) else {}
        model_name = (r.definition_snapshot or {}).get("model", {}).get("name")
        # ⚠️ 取 token 一律走 pricing.tokens_of：它同时认平台的 tokens_in/out 与
        #    provider 的 prompt/completion_tokens 两套键名。
        #    之前这里只认后者 → 平台自己采的数一个都取不到 → 记录页 Tokens 列**整列「—」**
        #    （数据一直在库里，只是没被读出来）。这就是那个 bug 的根因。
        tin, tout = tokens_of(usage)
        items.append(
            ActivityItem(
                kind=_run_kind(r),  # type: ignore[arg-type]
                id=r.id,
                at=r.started_at,
                orchestration_id=r.orchestration_id,
                duration_ms=dur,
                status=r.status,
                title=agents.get(r.agent_id, r.agent_id),
                subtitle=(
                    f"多轮第 {r.turn_index} 轮" if r.turn_index else None
                ),
                agent_id=r.agent_id,
                model=model_name,
                tokens_in=tin,
                tokens_out=tout,
                #: 金额（没填单价 = None → 界面显示「—」，不假装 0 元）
                cost=cost_of(model_name, tin, tout, prices),
                currency=currency,
                # 定时 / 外部触发发起的执行要标出来（不是用户点的）
                trigger=(r.origin if r.origin in ("schedule", "webhook") else None),
                summary=(_text_of(r.input) or _text_of(out))[:120] or None,
                error=r.error,
            )
        )

    for t in tests:
        first_user = next(
            (m.get("content", "") for m in (t.messages or []) if m.get("role") == "user"), ""
        )
        items.append(
            ActivityItem(
                kind="llm_test",
                id=t.id,
                at=t.started_at,
                duration_ms=t.duration_ms,
                status=t.status,
                title=f"{t.credential_name or t.provider} · {t.model}",
                subtitle="裸模型调用（不带助手）",
                credential_id=t.credential_id,
                model=t.model,
                tokens_in=t.tokens_in,
                tokens_out=t.tokens_out,
                cost=cost_of(t.model, t.tokens_in, t.tokens_out, prices),
                currency=currency,
                summary=(first_user or t.reply or "")[:120] or None,
                error=t.error,
            )
        )

    items.sort(key=lambda x: x.at, reverse=True)

    # 计数徽标：基于"还没按类型筛选"的全集，这样切换筛选时徽标不会跳
    counts: dict[str, int] = {}
    for it in items:
        counts[it.kind] = counts.get(it.kind, 0) + 1

    if kind and kind != "all":
        items = [x for x in items if x.kind == kind]
    if status:
        items = [x for x in items if x.status == status]
    if agent_id:
        items = [x for x in items if x.agent_id == agent_id]
    if q:
        needle = q.strip().lower()
        items = [
            x
            for x in items
            if needle
            in " ".join(
                filter(None, [x.title, x.subtitle, x.summary, x.model, x.error])
            ).lower()
        ]

    return ActivityList(items=items[:limit], counts=counts)


@router.get("/usage", response_model=dict)
async def usage_summary(
    days: int = Query(7, ge=1, le=90, description="统计最近多少天"),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """**用了多少、花了多少** —— 今日 / 近 N 天 / 按模型 / 按天，一次答完。

    为什么要专门一个端点（而不是让用户自己在列表里加）
    --------------------------------------------------
    用户问的是"这个月花了多少、花在哪"，而列表一次只显示几百条还是分页的 ——
    算不出合计、看不出趋势。这里把三个问题一次答完：
      · 今天用了多少、花了多少（today）
      · 近 N 天合计（period）
      · 按模型拆（by_model）· 按天拆（daily，界面画趋势）
      · 哪些模型还**没填单价**（unpriced）—— 不说这个，合计就是骗人的

    口径与 ``pricing`` 一致：没填单价的模型金额记 ``None``，合计里**不当作 0**
    （它只统计填了单价的那部分），并且单独报出 ``unpriced_count``。
    """
    import time as _time

    now = now_ms()
    day_ms = 24 * 3600 * 1000
    since = now - days * day_ms
    today_key = _time.strftime("%Y-%m-%d", _time.localtime(now / 1000))

    prices = await load_prices(session)
    currency = await currency_of(session)

    def blank() -> dict[str, Any]:
        # cost 起点是 None 而不是 0.0：**一次都没算过钱**时必须是「—」，
        # 显示成 0 就成了"这些调用免费" —— 那是在撒谎（见 pricing.py 的口径）。
        return {"calls": 0, "tokens_in": 0, "tokens_out": 0, "cost": None, "unpriced": 0}

    def add(box: dict[str, Any], model: str | None, tin: int, tout: int) -> None:
        c = cost_of(model, tin, tout, prices)
        box["calls"] += 1
        box["tokens_in"] += tin
        box["tokens_out"] += tout
        if c is None:
            box["unpriced"] += 1
        else:
            box["cost"] = round((box["cost"] or 0.0) + c, 6)

    daily: dict[str, dict[str, Any]] = {}
    per_model: dict[str, dict[str, Any]] = {}
    period = blank()
    today = blank()

    def take(model, tin, tout, at):
        day = _time.strftime("%Y-%m-%d", _time.localtime((at or now) / 1000))
        d = daily.setdefault(day, {**blank(), "day": day})
        add(d, model, tin, tout)
        key = price_key(model) or "(未知模型)"
        m = per_model.setdefault(key, {**blank(), "model": (model or "(未知模型)"), "priced": price_key(model) in prices})
        add(m, model, tin, tout)
        add(period, model, tin, tout)
        if day == today_key:
            add(today, model, tin, tout)

    for r in (
        await session.execute(select(Run).where(Run.started_at >= since))
    ).scalars():
        usage = r.usage if isinstance(r.usage, dict) else {}
        tin, tout = tokens_of(usage)
        if tin or tout:
            take((r.definition_snapshot or {}).get("model", {}).get("name"), tin, tout, r.started_at)

    for t in (
        await session.execute(select(ModelTest).where(ModelTest.started_at >= since))
    ).scalars():
        if t.tokens_in or t.tokens_out:
            take(t.model, t.tokens_in, t.tokens_out, t.started_at)

    # 按天补齐（没有调用的那天也要出现，否则趋势图画出来是"跳"的）
    series = []
    for i in range(days - 1, -1, -1):
        day = _time.strftime("%Y-%m-%d", _time.localtime((now - i * day_ms) / 1000))
        series.append(daily.get(day) or {**blank(), "day": day})

    rows = sorted(per_model.values(), key=lambda r: (-(r["cost"] or 0), -r["tokens_in"] - r["tokens_out"]))
    return {
        "currency": currency,
        "days": days,
        "today": today,
        "period": period,
        "daily": series,
        "by_model": rows,
        #: 用了 token 但没填单价的模型 —— 界面据此提示"补上才算得准"
        "unpriced": [r["model"] for r in rows if not r["priced"]],
    }


@router.get("/model-tests/{test_id}", response_model=ModelTestRead)
async def get_model_test(
    test_id: str, session: AsyncSession = Depends(get_session)
) -> ModelTestRead:
    """单条 LLM 对话测试的完整记录（弹框里要看请求原文与回复）。

    时间线接口只带摘要 —— 列表不需要每条都背着完整消息体；
    要展开看细节时再取这一条。
    """
    row = await session.get(ModelTest, test_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"记录不存在: {test_id}")
    return ModelTestRead.model_validate(row, from_attributes=True)


@router.post("/model-tests/bulk-delete", response_model=RunDeleteResponse)
async def bulk_delete_model_tests(
    payload: BulkDeleteRequest, session: AsyncSession = Depends(get_session)
) -> RunDeleteResponse:
    """删除选中的 LLM 对话测试记录（「运行记录」页里和助手执行一起勾选的）。"""
    deleted = 0
    for _id in payload.ids:
        row = await session.get(ModelTest, _id)
        if row is not None:
            await session.delete(row)
            deleted += 1
    await session.commit()
    return RunDeleteResponse(deleted=deleted, skipped=[])


@router.get("/{run_id}", response_model=RunRead)
async def get_run(run_id: str, session: AsyncSession = Depends(get_session)) -> RunRead:
    return to_read(await _get_or_404(session, run_id))


# --------------------------------------------------------------------------- #
# 清理（危险操作，分级设计）
#
# - 单条删除   → 直接删
# - 批量删除   → 传 ids 列表
# - 按条件清理 → 时间 / 状态 / Agent（比"清空全部"实用）
# - 清空全部   → 必须显式提交确认词，防误操作
#
# 外键都是 ON DELETE CASCADE，删 Run 会自动清掉 run_event / llm_call / tool_call。
# --------------------------------------------------------------------------- #
#: 终态：只有这些状态允许删除（运行中的必须先中断）
TERMINAL_STATUSES = ("ok", "error", "aborted")

#: 清空全部时必须显式提交的确认词
CLEAR_CONFIRM_WORD = "DELETE"

IN_FLIGHT = ("pending", "running", "waiting_hitl")


async def _delete_runs(
    session: AsyncSession, run_ids: list[str]
) -> tuple[int, list[dict[str, Any]]]:
    """删除终态 Run；运行中的跳过并说明原因。"""
    deleted = 0
    skipped: list[dict[str, Any]] = []
    for rid in run_ids:
        run = await session.get(Run, rid)
        if run is None:
            skipped.append({"id": rid, "reason": "记录不存在"})
            continue
        if run.status in IN_FLIGHT:
            skipped.append(
                {"id": rid, "reason": f"状态为 {run.status}，请先中断再删除"}
            )
            continue
        await session.delete(run)
        deleted += 1
    await session.commit()
    return deleted, skipped


@router.delete("/{run_id}", response_model=RunDeleteResponse)
async def delete_run(
    run_id: str, session: AsyncSession = Depends(get_session)
) -> RunDeleteResponse:
    """删除单条 Run（连同它的事件与调用记录）。"""
    deleted, skipped = await _delete_runs(session, [run_id])
    if deleted == 0 and skipped and skipped[0]["reason"] == "记录不存在":
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Run 不存在: {run_id}")
    return RunDeleteResponse(deleted=deleted, skipped=skipped)


@router.post("/bulk-delete", response_model=RunDeleteResponse)
async def bulk_delete_runs(
    payload: RunBulkDeleteRequest, session: AsyncSession = Depends(get_session)
) -> RunDeleteResponse:
    """批量删除选中的记录。

    「运行记录」页把助手执行和 LLM 对话测试并成了一条时间线，用户勾选时
    不该关心哪条存在哪张表 —— 所以这里按 id 前缀分流（``mt_`` = 模型测试）。
    前端因此只需要一个「删除选中」。
    """
    run_ids = [i for i in payload.ids if not i.startswith("mt_")]
    test_ids = [i for i in payload.ids if i.startswith("mt_")]

    deleted, skipped = (0, [])
    if run_ids:
        deleted, skipped = await _delete_runs(session, run_ids)

    for _id in test_ids:
        row = await session.get(ModelTest, _id)
        if row is not None:
            await session.delete(row)
            deleted += 1
        else:
            skipped = [*skipped, {"id": _id, "reason": "不存在"}]
    if test_ids:
        await session.commit()

    return RunDeleteResponse(deleted=deleted, skipped=skipped)


@router.post("/prune", response_model=RunDeleteResponse)
async def prune_runs(
    payload: RunPruneRequest, session: AsyncSession = Depends(get_session)
) -> RunDeleteResponse:
    """按条件清理 —— 时间 / 状态 / Agent。

    ``run_event`` 是大表（一条 Run 可能上百个事件），长期会撑大 SQLite，
    所以这是常规运维动作。``dry_run=True`` 可先看会删多少。
    """
    stmt = select(Run)
    if payload.before_ts:
        stmt = stmt.where(Run.started_at < payload.before_ts)
    stmt = stmt.where(Run.status.in_(payload.status or list(TERMINAL_STATUSES)))
    if payload.agent_id:
        stmt = stmt.where(Run.agent_id == payload.agent_id)
    rows = list((await session.execute(stmt)).scalars())

    if payload.dry_run:
        return RunDeleteResponse(
            deleted=0,
            skipped=[{"id": r.id, "reason": "dry_run（未删除）"} for r in rows],
        )
    deleted, skipped = await _delete_runs(session, [r.id for r in rows])
    return RunDeleteResponse(deleted=deleted, skipped=skipped)


@router.delete("", response_model=RunDeleteResponse)
async def clear_runs(
    confirm: str = Query("", description=f'清空全部需传 confirm={CLEAR_CONFIRM_WORD}'),
    agent_id: str | None = Query(None, description="只清空某个 Agent 的记录"),
    session: AsyncSession = Depends(get_session),
) -> RunDeleteResponse:
    """清空全部 Run（**危险**，必须显式提交确认词）。"""
    if confirm != CLEAR_CONFIRM_WORD:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f'清空全部需显式确认：请在 confirm 参数传入 "{CLEAR_CONFIRM_WORD}"',
        )
    stmt = select(Run).where(Run.status.in_(TERMINAL_STATUSES))
    if agent_id:
        stmt = stmt.where(Run.agent_id == agent_id)
    rows = list((await session.execute(stmt)).scalars())
    deleted, skipped = await _delete_runs(session, [r.id for r in rows])
    return RunDeleteResponse(deleted=deleted, skipped=skipped)
