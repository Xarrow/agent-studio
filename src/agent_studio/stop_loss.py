"""可靠性护栏引擎：止损计数 + 死路判定（全部读 reliability 配置，可关）。

为什么计数器放平台而不是 prompt：模型每轮是新采样，「上次失败过」它记不住、
也可能无视。失败计数写在 ``run.usage.tool_stats``（随库持久），注入的系统注
出现在下一轮 tool result 旁边 —— 模型可以无视 prompt，无视不了上下文里的
「⚠️ 已连续失败 N 次」。

判定全是纯代码（不花 LLM、不阻塞主链路）：
- 同名工具连续失败 ≥ ``stop_loss`` → 给该 run 排一条 steer 注入
- 连续 ``dead_end`` 次任何工具无成功 → 合成 worker_report(blocked) 事件入账
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from .models import Run, now_ms

logger = logging.getLogger(__name__)

STEER_MARK = "🛑 止损提示（平台注入）："


async def _failed_with_result(session, run_id: str, ev_payload: dict) -> tuple[bool, str]:
    """先查该 tool_call_id 的结果正文（✗ 前缀 = 定性失败），再落回 state/error 判定。"""
    from sqlalchemy import select

    from .models import RunEvent

    cid = str(ev_payload.get("tool_call_id") or "")
    if cid:
        rows = (
            await session.execute(
                select(RunEvent.payload).where(
                    RunEvent.run_id == run_id,
                    RunEvent.type == "tool_result_delta",
                )
            )
        ).scalars()
        buf = ""
        for p in rows:
            pl = p or {}
            if str(pl.get("tool_call_id")) == cid:
                buf += str(pl.get("delta") or "")
        if buf.lstrip().startswith("✗"):
            return True, buf.strip()[:200]
    return _failed(ev_payload)


def _failed(ev_payload: dict) -> tuple[bool, str]:
    """这次工具调用算失败吗。

    口径（与 metrics 一致 + 平台错误约定）：
    - state 非 success / 带 error 字段 = 失败；
    - 平台工具的错误约定：结果正文以「✗」开头 = 定性失败（如 fetch 的
      「✗ 抓取失败」「✗ 搜索不可达」）—— 工具层把 HTTP/网络层的失败
      包成"成功执行"返回，模型看到的是正文，判定也要看正文。
    """
    err = str(ev_payload.get("error") or "")
    state = str(ev_payload.get("state") or "").lower()
    ok = (state in ("success", "ok", "completed", "")) and not err
    if ok:
        # 结果正文前缀判定（_RESULT_KEYS 里的常见键）
        for k in ("result", "output", "text", "content"):
            v = ev_payload.get(k)
            if isinstance(v, str) and v.lstrip().startswith("✗"):
                return True, v.strip()[:200]
    return (not ok), (err or (f"state={state}" if state else ""))


async def _name(session, run_id: str, ev_payload: dict) -> str:
    """工具名：payload 没带就从 tool_call_start 事件反查（同一 tool_call_id）。"""
    name = str(ev_payload.get("tool_call_name") or "")
    if name:
        return name[:64]
    from sqlalchemy import select

    from .models import RunEvent

    cid = str(ev_payload.get("tool_call_id") or "")
    if cid:
        rows = (
            await session.execute(
                select(RunEvent.payload).where(
                    RunEvent.run_id == run_id, RunEvent.type == "tool_call_start"
                )
            )
        ).scalars()
        for p in rows:
            if p and str(p.get("tool_call_id")) == cid:
                return str(p.get("tool_call_name") or "?")[:64]
    return "?"


async def flush_pending_note(session, run_id: str) -> None:
    """在 llm_call_start 时把排队的注入送进上下文（此刻时序安全）。**调用方负责 commit**。"""
    from .steer import deliver as steer_deliver

    row = await session.get(Run, run_id)
    if row is None:
        return
    note = str((row.usage or {}).get("pending_note") or "").strip()
    if not note:
        return
    usage = dict(row.usage or {})
    usage.pop("pending_note", None)
    row.usage = usage
    try:
        await steer_deliver(run_id, note)
    except Exception:  # noqa: BLE001 —— 注入失败不拦主链路
        logger.debug("止损注入(延迟)失败 run=%s", run_id, exc_info=True)


async def on_tool_exec_end(session: AsyncSession, run_id: str, payload: dict) -> None:
    """工具结束后判一次：要不要提示、要不要上报死路。**调用方负责 commit**。"""
    from .reliability import DEAD_END_KEY, STOP_LOSS_KEY, get_setting

    stop_loss = int(await get_setting(session, STOP_LOSS_KEY, 3) or 0)
    dead_end = int(await get_setting(session, DEAD_END_KEY, 0) or 0)
    if not stop_loss and not dead_end:
        return  # 两档全关：零开销

    row = await session.get(Run, run_id)
    if row is None or not row.parent_run_id:
        return  # 只管被派出来的执行
    if row.status not in ("pending", "running"):
        return

    usage = dict(row.usage or {})
    stats = dict(usage.get("tool_stats") or {})
    streak_all = int(stats.get("_streak_all") or 0)  # 连续无成功的调用总数
    failed, err = await _failed_with_result(session, run_id, payload)
    name = await _name(session, run_id, payload)
    per = dict(stats.get(name) or {"streak": 0, "last_err": ""})
    if failed:
        streak_all += 1
        per["streak"] = int(per.get("streak") or 0) + 1
        per["last_err"] = err[:200]
    else:
        streak_all = 0
        per["streak"] = 0
    stats["_streak_all"] = streak_all
    stats[name] = per
    usage["tool_stats"] = stats
    row.usage = usage

    notes: list[str] = []
    if stop_loss and failed and per["streak"] >= stop_loss:
        notes.append(
            f"{name} 已连续失败 {per['streak']} 次（{per['last_err']}）。"
            "同一操作再来第几次都不会有不同结果 —— 换一条路，或用 worker_report(blocked) 上报。"
        )
    if dead_end and streak_all >= dead_end:
        notes.append(
            f"已连续 {streak_all} 次调用没有任何成功 —— 这条路走不通了。"
            "立刻止损：用 worker_report(blocked) 把卡点报给派你活的人。"
        )

    if notes:
        # 不能在这里 observe：tool_exec_end 事件 yield 出来时，AgentScope 还没把
        # tool result 写进 context（它 yield 事件在前、_save_to_context 在后）。
        # 此刻插 user 消息会落在 assistant(tool_calls) 与 tool 结果之间 →
        # 下一轮请求 OpenAI 400（"tool_calls must be followed by tool messages"）。
        # 改为记 pending，由 flush_pending_note 在下一个 llm_call_start 时注入
        # —— 那个时刻 tool result 必已在 context，插话位置合法。
        usage["pending_note"] = (str(usage.get("pending_note") or "") + "\n" + STEER_MARK + " ".join(notes)).strip()[:2000]
        if dead_end and streak_all >= dead_end:
            # 死路另走账本：Router 结束时也能被唤醒
            try:
                from .worker_events import emit_worker_event

                await emit_worker_event(
                    worker_run_id=run_id,
                    parent_run_id=str(row.parent_run_id),
                    root_run_id=str(row.root_run_id or ""),
                    kind="blocked",
                    text=f"🛑 可靠性护栏：连续 {streak_all} 次调用无成功，平台判定为死路（源=stop_loss 引擎）",
                    source="guardrail",
                )
            except Exception:  # noqa: BLE001
                logger.debug("死路上报失败 run=%s", run_id, exc_info=True)
            stats["_streak_all"] = 0  # 报过一次就清零，别每刷一次工具都再报
            row.usage = usage
