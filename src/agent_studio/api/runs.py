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
from ..models import Agent, LlmCall, ModelTest, Run, RunEvent, Span, ToolCall, now_ms
from ..pricing import cost_of, currency_of, load_prices, price_key, tokens_of
from ..runner import run_service
from ..runner.service import resolve_api_key
from ..schemas import (
    ActivityItem,
    ActivityList,
    AgentDefinition,
    FanoutItemRead,
    FanoutRead,
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
    SpanRead,
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

    # 耗时瀑布：按开始时间排（父一般早于子，缩进才好算）
    span_rows = (
        await session.execute(
            select(Span).where(Span.run_id == run_id).order_by(Span.started_at.asc())
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
        spans=[
            SpanRead(
                id=s.id,
                parent_id=s.parent_id,
                kind=s.kind,
                name=s.name or "",
                started_at=s.started_at,
                ended_at=s.ended_at,
                duration_ms=s.duration_ms,
                attributes=s.attributes or {},
            )
            for s in span_rows
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


@router.post("/{run_id}/refill")
async def refill_fanout_run(run_id: str) -> dict[str, Any]:
    """**补齐失败的那几路**（分派这一步重跑：已成功的复用，只补非 ok 的项）。

    与 ``/{run_id}/rerun`` 的分工：那个是"把这条执行重跑一遍"（分派出去的**某一路**失败时用它）；
    这个是"这一步的清单再派一次"（多路失败时一次补齐，不重复扣费）。
    """
    from ..orchestrator.service import Orchestrator

    try:
        return await Orchestrator().refill_fanout(run_id)
    except LookupError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc


@router.post("/{run_id}/rerun", response_model=RunRead)
async def rerun_run(run_id: str, session: AsyncSession = Depends(get_session)) -> RunRead:
    """**重跑这一条执行**（就地重来一次，不新建记录）。

    为什么需要它
    ------------
    · 分派出去的一路失败了 → 只想重跑**那一路**。重跑整批既重复扣费，又要把已经
      做好的项再做一遍（用户要的是"只重跑第 2 项"）。
    · 分派容器自己也能重跑：内核按 ``(父执行, 第几路)`` **幂等** —— 已成功的项直接复用，
      只补跑失败或没跑的（见 fanout.dispatch）。

    与「只跑这一步」的分工：那个是"按图的节点"重跑（会新建一条编排）；
    这个是"按已有的这条记录"重跑（记录原地更新，归属不变：还在同一个节点、同一路）。
    """
    run = await _get_or_404(session, run_id)
    if run.status in ("pending", "running", "waiting_hitl"):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"这条执行还没结束（{run.status}），先等它跑完或先中止再重跑",
        )
    definition = AgentDefinition.model_validate(run.definition_snapshot or {})
    inp = run.input or {}
    text = inp.get("text") if isinstance(inp, dict) else None
    if not str(text or "").strip():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "这条记录没有留下输入文本，没法重跑"
        )

    # 就地重来：清掉上一次的结果；**归属不动**（node_id / item_index / parent_run_id 保持），
    # 所以重跑完它还贴在原来那一格上，画布与记录里不会多出孤儿记录。
    run.status = "pending"
    run.output = None
    run.error = None
    run.ended_at = None
    run.started_at = now_ms()
    usage = dict(run.usage or {})
    usage["reruns"] = int(usage.get("reruns") or 0) + 1
    run.usage = usage
    await session.commit()
    await session.refresh(run)

    from ..runner import run_service

    await run_service.start(run.id, definition, str(text))
    return to_read(run)


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


# ── 「运行记录」时间线（分页版）────────────────────────────────────────────
#
# 为什么要重写（原来差在哪）
# -------------------------
# 原来把一个 1000 条的窗口**全捞进内存**再在 Python 里筛/搜/截断：
#   · 前端要 limit=300 → 每次都把上千行记录（含 output/input 全文）读出来、序列化、扔掉
#   · 没有分页：超过窗口的老记录**翻不到**（不是慢，是根本看不见）
#   · 搜索只在这个窗口内匹配 → "我明明搜到过那条"变成玄学
# 现在：条件全部下推到 SQL（可移植：`cast(...).ilike` 在 SQLite/MySQL/PG 都成立），
# 游标分页（`(started_at, id)` 复合游标，避免同毫秒记录在翻页时被跳过或重复），
# 并明确返回 `total`（界面能说"还有 N 条"）与 `has_more`。
def _kind_case(model):  # noqa: ANN001
    """kind 的 SQL 表达式：老数据 origin 为空 → 按 orchestration/session 推断。

    与 Python 版 ``_run_kind`` 必须**完全一致**，否则筛选出来的条数会对不上。
    """
    from sqlalchemy import case, literal

    return case(
        (model.origin.in_(("chat", "preview", "playground")), model.origin),
        (model.orchestration_id.is_not(None), literal("playground")),
        (model.session_id.is_not(None), literal("chat")),
        else_=literal("preview"),
    )


def _needles(q: str) -> list[str]:
    r"""搜索词 → 若干个 LIKE 模式。

    ⚠️ 为什么要两个：JSON 列（input/output/definition_snapshot/messages）在 SQLite 里是
    ``json.dumps`` 的结果，中文默认被转义成 ``\uXXXX`` —— 拿 ``LIKE '%中文%'`` 去匹配
    **永远搜不到**（库里根本没有那几个汉字）。这是"我明明搜到过"的隐形坑，
    所以除了原样，再拿一份"转义后的形式"去比。
    """
    raw = q.strip()
    escaped = json.dumps(raw, ensure_ascii=True)[1:-1]
    return [raw] if escaped == raw else [raw, escaped]


def _like_any(col, q: str):  # noqa: ANN001, ANN201
    from sqlalchemy import or_

    return or_(*[col.ilike(f"%{n}%") for n in _needles(q)])


def _run_conds(kind, status, agent_id, q, before_at, before_id) -> list:  # noqa: ANN001
    from sqlalchemy import String, and_, cast, or_

    from ..models import Agent

    conds: list = []
    if kind and kind != "all":
        conds.append(_kind_case(Run) == kind)
    if status:
        conds.append(Run.status == status)
    if agent_id:
        conds.append(Run.agent_id == agent_id)
    if q and q.strip():
        conds.append(
            or_(
                _like_any(cast(Run.input, String), q),
                _like_any(cast(Run.output, String), q),
                _like_any(cast(Run.definition_snapshot, String), q),
                _like_any(Run.error, q),
                Run.agent_id.in_(select(Agent.id).where(_like_any(Agent.name, q))),
            )
        )
    if before_at:
        # 复合游标：同一毫秒内的多条靠 id 决定先后，否则翻页会漏/重
        conds.append(
            or_(Run.started_at < before_at, and_(Run.started_at == before_at, Run.id < before_id))
        )
    # **分派出去的每一路不单独占一条** —— 它们是同一件事的分身，收在容器那一行下面
    # （否则记录页被同一批刷屏、翻页也翻不完；画布上是叠卡，这里就应该是"一行 + 展开"）。
    conds.append(Run.parent_run_id.is_(None))
    return conds


def _test_conds(kind, status, q, before_at, before_id) -> list:  # noqa: ANN001
    from sqlalchemy import String, and_, cast, or_

    conds: list = []
    if kind and kind not in ("all", "llm_test"):
        return [literal_false()]        # 只看助手执行时，裸模型调用不进结果
    if status:
        conds.append(ModelTest.status == status)
    if q and q.strip():
        conds.append(
            or_(
                _like_any(ModelTest.model, q),
                _like_any(ModelTest.credential_name, q),
                _like_any(ModelTest.reply, q),
                _like_any(ModelTest.error, q),
                _like_any(cast(ModelTest.messages, String), q),
            )
        )
    if before_at:
        conds.append(
            or_(
                ModelTest.started_at < before_at,
                and_(ModelTest.started_at == before_at, ModelTest.id < before_id),
            )
        )
    return conds


def literal_false():  # noqa: ANN201
    from sqlalchemy import false

    return false()


@router.get("/timeline", response_model=ActivityList)
async def activity_timeline(
    kind: str | None = Query(None, description="chat / preview / playground / llm_test"),
    status: str | None = Query(None),
    agent_id: str | None = Query(None),
    q: str | None = Query(None, description="关键词：主体名 / 模型 / 摘要 / 错误"),
    limit: int = Query(50, ge=1, le=200, description="每页条数（默认 50，界面用「加载更多」翻）"),
    before: int | None = Query(None, description="游标：只取这个时间戳（毫秒）之前的记录"),
    before_id: str | None = Query(None, description="游标 tiebreak：同一毫秒内的记录靠它排序"),
    session: AsyncSession = Depends(get_session),
) -> ActivityList:
    """把**三类调用**并成一条时间线（分页 + 搜索在库里完成）。

    为什么合并（而不是分三个列表）
    ------------------------------
    用户脑子里的问题是"我发起过哪些调用、结果如何、哪次出错了"，而不是"它存在哪张表"。
    分开放，就等于逼用户在几个列表之间对照着看。存储上仍然分开（语义不同，见 models.ModelTest）。

    分页是**游标式**（`before` + `before_id`）而不是 offset：
    记录一直在新增，offset 会让"翻到第 2 页"时内容整体位移、用户看到重复或漏掉的条目。
    """
    from sqlalchemy import func

    agents = {a.id: a.name for a in (await session.execute(select(Agent))).scalars()}
    prices = await load_prices(session)
    currency = await currency_of(session)

    # 取 limit+1：多取一条用来判断"还有没有"。两个来源各取 limit+1 再合并，
    # 结果的前 limit 条必然正确（数学上：并集的前 k 条一定来自各自的前 k 条）。
    want = limit + 1
    run_stmt = (
        select(Run).where(*_run_conds(kind, status, agent_id, q, before, before_id or ""))
        .order_by(Run.started_at.desc(), Run.id.desc())
        .limit(want)
    )
    runs = list((await session.execute(run_stmt)).scalars())

    tests: list[ModelTest] = []
    if not agent_id:
        test_stmt = (
            select(ModelTest)
            .where(*_test_conds(kind, status, q, before, before_id or ""))
            .order_by(ModelTest.started_at.desc(), ModelTest.id.desc())
            .limit(want)
        )
        tests = list((await session.execute(test_stmt)).scalars())

    items: list[ActivityItem] = []
    for r in runs:
        out = r.output if isinstance(r.output, dict) else {}
        dur = (r.ended_at - r.started_at) if (r.ended_at and r.started_at) else None
        usage = r.usage if isinstance(r.usage, dict) else {}
        model_name = (r.definition_snapshot or {}).get("model", {}).get("name")
        # ⚠️ 取 token 一律走 pricing.tokens_of：同时认平台 tokens_in/out 与 provider 的
        #    prompt/completion_tokens 两套键名（只认后者会导致 Tokens 整列「—」）。
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
                subtitle=(f"多轮第 {r.turn_index} 轮" if r.turn_index else None),
                agent_id=r.agent_id,
                model=model_name,
                tokens_in=tin,
                tokens_out=tout,
                cost=cost_of(model_name, tin, tout, prices),
                currency=currency,
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

    items.sort(key=lambda x: (x.at, x.id), reverse=True)
    has_more = len(items) > limit
    items = items[:limit]

    # ── 分派明细：给这一页里的容器行，一次查询把它们的各路取回来 ────────────
    run_ids = [x.id for x in items if x.kind in ("playground", "preview", "chat")]
    if run_ids:
        kids = list(
            (
                await session.execute(
                    select(Run)
                    .where(Run.parent_run_id.in_(run_ids))
                    .order_by(Run.item_index.asc())
                )
            ).scalars()
        )
        by_parent: dict[str, list[Run]] = {}
        for k in kids:
            by_parent.setdefault(str(k.parent_run_id), []).append(k)
        for x in items:
            rows = by_parent.get(x.id)
            if not rows:
                continue
            tin = tout = 0
            kids_out: list[FanoutItemRead] = []
            ok_n = failed_n = 0
            for k in rows:
                k_usage = k.usage if isinstance(k.usage, dict) else {}
                k_in, k_out = tokens_of(k_usage)
                tin += k_in
                tout += k_out
                if k.status == "ok":
                    ok_n += 1
                elif k.status in ("error", "aborted"):
                    failed_n += 1
                kids_out.append(
                    FanoutItemRead(
                        run_id=k.id,
                        index=int(k.item_index or 0),
                        label=k.item_label or "",
                        status=k.status,
                        duration_ms=(k.ended_at - k.started_at) if (k.ended_at and k.started_at) else None,
                        tokens_in=k_in,
                        tokens_out=k_out,
                    )
                )
            x.fanout = FanoutRead(
                total=len(rows),
                ok=ok_n,
                failed=failed_n,
                tokens_in=tin,
                tokens_out=tout,
                items=kids_out,
            )

    # 徽标计数：**不带类型筛选**，这样切换类型时徽标不会跳（原有语义，保持不变）
    counts: dict[str, int] = {}
    for kind_name, cnt in (
        await session.execute(
            select(_kind_case(Run).label("k"), func.count())
            .where(Run.parent_run_id.is_(None))  # 口径与列表一致：不把每一路算成一条
            .group_by(_kind_case(Run))
        )
    ).all():
        counts[str(kind_name)] = int(cnt)
    test_count = int(
        (await session.execute(select(func.count()).select_from(ModelTest))).scalar() or 0
    )
    if test_count:
        counts["llm_test"] = test_count

    # 当前筛选下的总条数（界面用来说"还有 N 条"）—— 与列表同源同条件
    total_runs = int(
        (
            await session.execute(
                select(func.count())
                .select_from(Run)
                .where(*_run_conds(kind, status, agent_id, q, None, None))
            )
        ).scalar()
        or 0
    )
    total_tests = 0
    if not agent_id:
        total_tests = int(
            (
                await session.execute(
                    select(func.count())
                    .select_from(ModelTest)
                    .where(*_test_conds(kind, status, q, None, None))
                )
            ).scalar()
            or 0
        )

    return ActivityList(
        items=items, counts=counts, has_more=has_more, total=total_runs + total_tests
    )


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
