"""worker → Router 的事件投递（挂在平台事件账本 events/ 之上）。

为什么是「账本 + handler」而不是独立的路由器/表
--------------------------------------------
平台已有成熟的事件层（``events/``：幂等 append、claim/lease 重试、
死信、scheduler 定时 tick 消费）。worker 上报应该**入这本账**，
投递做成 handler —— 重试/幂等/可观测全套白得，不再自造 WorkerEvent 表。

事件两个产地（消费端不区分）：
    a. worker 主动调 ``worker_report`` 工具（progress/blocked/done/failed）
    b. 平台自动转报：``_persist_event`` 必经点拦截 worker 树的 error/run_end
       （worker 模型无感、不耗它的轮次）

投递规则（handler 内，见 events/handlers.py）：
    Router 轮在跑      → steer 直注（事件变成它下一步推理的见闻）
    Router 轮已结束    → blocked/failed 立即起唤醒轮（卡住的事不能等轮询）；
                         progress/done 只落账不唤醒（随收口带上，防轰炸）
    Router 等人工确认  → 不打断人，事件留在账上
"""

from __future__ import annotations

import logging
from typing import Any

from .db import SessionLocal
from .models import Run, now_ms

logger = logging.getLogger(__name__)

#: 这些 kind 值得打断 Router（起唤醒轮）；其余攒着随收口带
URGENT_KINDS = frozenset({"blocked", "failed"})

#: worker 上报事件在账本里的 kind
EV_KIND = "worker.report"


async def emit_worker_event(
    *,
    worker_run_id: str,
    parent_run_id: str,
    root_run_id: str,
    kind: str,
    text: str,
    progress: int | None = None,
    source: str = "report",
) -> dict[str, Any]:
    """入账本（消费交给 handler）。返回 {ok, route?}（工具回显用）。"""
    from .events import store as event_store

    if kind not in ("progress", "blocked", "done", "failed"):
        kind = "progress"
    async with SessionLocal() as s:
        wrun = await s.get(Run, worker_run_id)
        agent_name = "?"
        if wrun is not None:
            from .models import Agent

            a = await s.get(Agent, wrun.agent_id)
            agent_name = a.name if a else "?"
        # root 以父执行（或父的 root）为准 —— worker 自己的 root 列在旧数据/特殊
        # 时序下可能为空，fallback 到 worker.id 会让「按树查事件」查不到。
        pr = await s.get(Run, parent_run_id) if parent_run_id else None
        root_run_id = str((pr.root_run_id if pr else "") or parent_run_id or root_run_id)
        await event_store.append(
            s,
            EV_KIND,
            subject_kind="run",
            subject_id=parent_run_id or root_run_id,
            payload={
                "worker_run_id": worker_run_id,
                "parent_run_id": parent_run_id,
                "root_run_id": root_run_id or (parent_run_id or ""),
                "event_kind": kind,
                "text": (text or "")[:2000],
                "progress": progress,
                "source": source,
                "agent_name": agent_name,
                "ts": now_ms(),
            },
            dedupe_key=None,  # 上报不设幂等键：同一句话发两次是两次事实
        )
        # 上报即续约（lease 心跳）：watcher 知道它活着
        wr = await s.get(Run, worker_run_id)
        if wr is not None and wr.status in ("pending", "running"):
            usage = dict(wr.usage or {})
            usage["lease_until"] = now_ms() + 120_000
            wr.usage = usage
        await s.commit()
    # 入账即回「已受理」；route 要等 handler 跑完才知道（异步），工具回显不阻塞在这
    return {
        "ok": True,
        "route": "accepted",
        "note": "事件已入账本，平台正在投递给派活方（在跑就实时到，结束且紧急就唤醒）",
    }


def _render(p: dict[str, Any]) -> str:
    """payload → 给 Router 看的一行话。简洁：判断材料，不是报告文学。"""
    mark = {
        "progress": "🔹 进展",
        "blocked": "⚠️ 卡住，需要你决策",
        "done": "✅ 提前完工",
        "failed": "❌ 失败",
    }.get(str(p.get("event_kind")), str(p.get("event_kind")))
    head = f"[worker 事件] 【{p.get('agent_name', '?')}】{mark}"
    if p.get("progress") is not None:
        head += f"（{p['progress']}%）"
    return f"{head}：{p.get('text', '')}"


async def deliver_to_router(p: dict[str, Any]) -> dict[str, str]:
    """handler 的投递动作：steer 直注 / 唤醒轮 / 留账。由 events handler 调。"""
    parent = str(p.get("parent_run_id") or "")
    kind = str(p.get("event_kind") or "progress")
    if not parent:
        return {"route": "dropped", "note": "无派活方（非派发树），不投递"}

    session_id = ""
    async with SessionLocal() as s:
        pr = await s.get(Run, parent)
        if pr is None:
            return {"route": "dropped", "note": "派活方执行已不存在"}
        session_id = str(pr.session_id or "")
        if pr.status in ("pending", "running"):
            # 在线：steer 直注
            from . import steer as steer_registry

            r = await steer_registry.deliver(parent, _render(p))
            if r == steer_registry.SteerResult.DELIVERED:
                return {"route": "steer", "note": "已实时送达 Router 本轮"}
            # 竞态（刚好在收尾）→ 落下面唤醒/留账逻辑
        elif pr.status == "waiting_hitl":
            return {"route": "queued", "note": "Router 暂停等确认中，事件留在账上"}

    if kind in URGENT_KINDS and session_id:
        from .supervisor import _spawn_router_turn

        digest = (
            f"【worker 事件 · 需要你处理】\n{_render(p)}\n\n"
            f"（你上一轮已结束，平台把这件事推给你。）"
            f"判断怎么处置：能纠偏就重派（dispatch），方向不对就换方案；"
            f"如果是误报或小事，说明一句即可，不必大动干戈。"
        )
        spawned = await _spawn_router_turn(session_id, digest)
        if spawned:
            return {"route": "wakeup", "note": "Router 已被唤醒处理", "run_id": spawned}
        return {"route": "queued", "note": "唤醒轮没起成（会话忙），事件留在账上"}

    return {"route": "queued", "note": "已记录，随收口一起带给 Router"}


async def _maybe_forward_platform_event(run_id: str, ev: Any) -> None:
    """平台自动转报：worker 树的 error / run_end → 账本（worker 模型无感）。

    只转「有信息量」的：error 转成 failed；run_end 在 worker 没自己报过
    终态时补一条（防谎报/防漏报的兜底，状态以 run 表实际值为准）。
    """
    import asyncio

    await asyncio.sleep(0)  # 让出：调用点在事件热路径上

    async with SessionLocal() as s:
        run = await s.get(Run, run_id)
        if run is None or not run.parent_run_id:
            return  # 不是被派出来的执行，与 Router 无关
        parent = str(run.parent_run_id or "")
        root = str(run.root_run_id or parent or run_id)

    if ev.type == "error":
        text = str((ev.payload or {}).get("message") or (ev.payload or {}).get("error") or "执行报错")[:500]
        await emit_worker_event(
            worker_run_id=run_id, parent_run_id=parent, root_run_id=root,
            kind="failed", text=f"执行报错：{text}", source="platform",
        )
        return
    # run_end：查这棵树有没有 worker 自己报过的终态，有就不重复
    from sqlalchemy import select as _sel

    from .models import Event

    async with SessionLocal() as s:
        last = (
            await s.execute(
                _sel(Event)
                .where(Event.kind == EV_KIND)
                .order_by(Event.created_at.desc())
                .limit(30)
            )
        ).scalars().all()
    for e in last:
        pl = e.payload or {}
        if pl.get("worker_run_id") == run_id and pl.get("event_kind") in ("done", "failed"):
            return  # worker 自己报过了，平台不重复
    # 终态兜底：run_end 事件流过时 run 可能还没标终态（终态在事件循环尾部落库）
    # —— 短重试等几秒再查实际状态。转报是后台任务，等得起。
    status = ""
    for _ in range(6):
        await asyncio.sleep(1.5)
        async with SessionLocal() as s:
            row = await s.get(Run, run_id)
            status = str(row.status or "") if row else ""
        if status not in ("", "pending", "running"):
            break
    if status in ("", "pending", "running"):
        return  # 等不到终态就不猜（watch_worker 的终态推送还在兜底）
    kind = {"ok": "done", "aborted": "failed", "error": "failed"}.get(status, "")
    if not kind:
        return
    await emit_worker_event(
        worker_run_id=run_id, parent_run_id=parent, root_run_id=root,
        kind=kind, text=f"执行结束（平台转报，状态 {status}）",
        source="platform",
    )
