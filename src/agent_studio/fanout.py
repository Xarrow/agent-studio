"""Fan-out 内核：一个 Agent 把一份任务拆成 N 份，分派给**自己的 N 个实例**并行处理。

设计要点（详见交付页 agent-studio-fanout-design.html）
--------------------------------------------------
* 权威实现在**编排层**（不依赖任何运行时）：未来接 pi 之类的运行时也自动具备。
* 每一路都是一条**独立 run**（带 node_id / item_index / item_label / parent_run_id）——
  只有这样，"看得见（画布/记录）、算得清（成本/耗时）、单独重跑"才成立。
  工具内部 await 若干次是**不可见**的，那种做法等于让模型在暗处跑 30 个 agent。
* 两个入口共用本模块：模型调用 ``fork`` 工具（见 ``handle_tool_call``）、
  画布节点配置（P1，见 ``parse_items`` 的列表解析）。
* 硬约束都在**内核**里（不是 UI）：上限截断、深度 1、禁自动重试、幂等重跑。

为什么重跑要幂等（I6）
----------------------
父 run 的自动重试（429 退避）会把整批分派再跑一遍 = 钱翻倍。
所以按 ``(parent_run_id, item_index)`` 判断：已成功的项直接跳过并复用其产出。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any

from sqlalchemy import select

from .config import settings
from .db import SessionLocal
from .models import Run, now_ms
from .runner.ctx import current_run_ctx

logger = logging.getLogger(__name__)

#: 允许的最大路数（防止"上游返回 800 条"把额度和时间跑飞）。UI 只给枚举，这里是硬闸。
MAX_ITEMS_HARD = 20
DEFAULT_MAX_ITEMS = 5
#: 等所有实例跑完的上限（秒）—— 与「最长等多久」默认值一致（15 分钟）
DEFAULT_WAIT_S = 900.0
#: 每项在返回给模型的摘要里最多留多少字（有界回注：细节让模型按需 read）
SUMMARY_CHARS = 80
POLL_SECONDS = 0.5
TERMINAL = ("ok", "error", "aborted")
#: 「在等人点头」的状态 —— 它不是失败，但也**不能傻等**：
#: 人什么时候点确认是未知的，等着只会把这一步拖到「最长等多久」超时，
#: 而超时报告会把原因说成"跑太久"（误导）。所以一发现就**立即收尾并如实上报**。
WAITING = ("waiting_hitl",)


# --------------------------------------------------------------------------- #
# 纯函数（可单测）：列表解析、标签、提示词
# --------------------------------------------------------------------------- #
_BULLET = re.compile(r"^\s*(?:[-*•·]|\d+[.)、]|第\s*\d+\s*[项条])\s*")


def parse_items(text: Any) -> list[str]:
    """把上游产出解析成"一项一条"。

    支持三种真实会遇到的形状（其余一律当"不是列表"，返回空 —— 宁可让用户显式给列表，
    也不要猜出一堆垃圾项去跑）：
      ① JSON 数组：``["a", "b"]`` 或 ``[{"title": "..."}]``
      ② markdown / 编号列表：``- 甲`` / ``1. 甲`` / ``第 2 项 甲``
      ③ 普通多行文本：每行一项（至少 2 行）
    """
    if isinstance(text, list):
        return [str(x).strip() for x in text if str(x).strip()]
    if not isinstance(text, str):
        return []
    raw = text.strip()
    if not raw:
        return []

    # ① JSON 数组
    if raw.startswith("[") and raw.endswith("]"):
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            data = None
        if isinstance(data, list):
            out: list[str] = []
            for x in data:
                if isinstance(x, dict):
                    for key in ("title", "name", "text", "content", "label"):
                        if isinstance(x.get(key), str) and x[key].strip():
                            out.append(x[key].strip())
                            break
                    else:
                        out.append(json.dumps(x, ensure_ascii=False))
                elif str(x).strip():
                    out.append(str(x).strip())
            return out

    lines = [ln for ln in (l.strip() for l in raw.splitlines()) if ln]
    # ② 有项目符号 / 编号的行
    bulleted = [ln for ln in lines if _BULLET.match(ln)]
    if len(bulleted) >= 2:
        return [_BULLET.sub("", ln).strip() for ln in bulleted if _BULLET.sub("", ln).strip()]
    # ③ 普通多行
    if len(lines) >= 2:
        return lines
    return []


def item_label(item: str, index: int) -> str:
    """那一路在界面/摘要里显示的名字：第 N 项 · 前 12 字。"""
    one = re.sub(r"\s+", " ", str(item)).strip()
    head = one[:12] + ("…" if len(one) > 12 else "")
    return f"第 {index + 1} 项 · {head}" if head else f"第 {index + 1} 项"


def item_prompt(item: str, index: int, total: int, work_dir: str = "") -> str:
    """交给实例的输入。

    刻意写得**明确而有限**：只处理这一项、不要替其它项做决定 ——
    否则每路都会试图总结全局，产出互相重复、汇总时噪声很大。

    ``work_dir`` 非空时把"你这一路的目录"写明白：**必须**说，
    否则模型会自己编绝对路径（实测写 `/result.md`、`/mnt/data/result.md`），
    越出沙箱 → 权限引擎要求人工确认 → 无人值守的批量分派整步卡在"等你确认"。
    """
    text = (
        f"这是分派给你的第 {index + 1} 项（共 {total} 项），"
        f"只处理这一项，不要处理其它项、也不要总结全局：\n\n{item}"
    )
    if work_dir:
        text += (
            f"\n\n（你这一路的工作目录是 `{work_dir}`。要落文件就用**相对路径**，"
            "例如 `result.md` —— 它会写在这个目录里；不要用 `/` 开头的绝对路径。）"
        )
    return text


# --------------------------------------------------------------------------- #
# 内核：分派
# --------------------------------------------------------------------------- #
def _isolated_snapshot(snapshot: dict[str, Any], parent_run: Run, index: int) -> dict[str, Any]:
    """给第 i 路一份"工作目录换成自己"的定义快照。

    为什么需要它：分派出去的每一路都是**真并行**的实例，若共用同一个工作目录，
    同时写同名文件就是互相覆盖（"分几路跑"最典型的用法恰恰是各自产出各自的文件）。
    命名：``<原目录名或 fanout>-<父执行号后 6 位>-<第几路>`` —— **单层名字**，
    满足 ``resolve_work_dir`` 对 workspace 的校验（不允许路径分隔符 / ``..``）。
    """
    snap = dict(snapshot)
    base = str(snap.get("workspace") or "").strip().strip("/") or "fanout"
    suffix = str(parent_run.id)[-6:]
    snap["workspace"] = f"{base}-{suffix}-{index + 1}"
    return snap


async def dispatch_remote(
    *,
    parent_run: Run,
    agent_id: str,
    remote_base: str,
    items: list[str],
    max_items: int | None = None,
    wait_s: float | None = None,
    remote_agent_id: str | None = None,
    headers: dict[str, str] | None = None,
    db_factory: Any = SessionLocal,
) -> dict[str, Any]:
    """把每一路**派给远端 A2A agent**（跨平台的 agent 间 fork）。

    与本地 dispatch 的关系
    ---------------------
    形状完全一样：每一项一条独立 run（带 parent_run_id / item_index / item_label），
    所以记录页、调用链、单独重跑这些能力**不用为远端另写一套**。区别只有一处：
    子 run 的 ``runtime`` 记成 ``"a2a"``，跑的人不是本地运行时，而是远端平台的
    agent（通过 A2A 的 message/send + tasks/get）。

    怎么找到远端：``remote_base`` 可以是 ``http://host:port``（自动补 ``/a2a``）、
    直接是 ``.../a2a``，或者从卡片地址 ``.../.well-known/agent-card.json`` 复制来的
    整串。``remote_agent_id`` 用来在远端选具体助手（放进 message.metadata.agentId）。
    """
    import asyncio as _asyncio

    from . import a2a_client

    cap = max(1, min(int(max_items or DEFAULT_MAX_ITEMS), MAX_ITEMS_HARD))
    picked = items[:cap]
    if not picked:
        return {"ok": False, "reason": "没有可分派的项", "items": [], "total": 0}

    # 先探一次远端：地址/协议不对就在这里失败，不要建了 N 条 run 才发现连不上
    try:
        card = await a2a_client.discover(remote_base, headers=headers)
    except a2a_client.A2AError as exc:
        return {
            "ok": False,
            "reason": f"远端不可用：{exc}",
            "items": [],
            "total": 0,
            "remote": remote_base,
        }
    remote_name = str(card.get("name") or remote_base)

    async with db_factory() as session:
        created: list[Run] = []
        for i, item in enumerate(picked):
            child = Run(
                agent_id=agent_id,                      # 本地发起方（远端 agent 不在本地表里）
                agent_version=parent_run.agent_version,
                runtime="a2a",                          # ← 远端执行的标记（记录页据此标 A2A）
                status="pending",
                input={"text": item, "remote": remote_base, "remote_name": remote_name},
                definition_snapshot={},
                started_at=now_ms(),
                node_id=parent_run.node_id if parent_run.node_id else None,
                item_index=i,
                item_label=item_label(item, i),
                parent_run_id=parent_run.id,
                orchestration_id=parent_run.orchestration_id,
                origin=parent_run.origin,
            )
            session.add(child)
            created.append(child)
        await session.commit()
        for c in created:
            await session.refresh(c)

    timeout = float(wait_s if wait_s is not None else DEFAULT_WAIT_S)

    async def _one(child: Run, text: str) -> None:
        """跑一路：发消息 → 等终态 → 落库。任何异常都变成这一路的失败原因。"""
        try:
            status, out, task_id = await a2a_client.run_until_done(
                remote_base,
                text,
                agent_id=remote_agent_id,
                timeout_s=timeout,
                headers=headers,
            )
        except a2a_client.A2AError as exc:
            status, out, task_id = "error", "", ""
            err = str(exc)
        else:
            err = "" if status != "error" else (out or "远端执行失败")
        async with db_factory() as session:
            row = await session.get(Run, child.id)
            if row is None:  # pragma: no cover
                return
            row.status = status
            row.output = {"content": out} if out else None
            row.error = err or None
            row.ended_at = now_ms()
            if task_id:
                # 远端 task id 记进 usage：排查时能拿着它去远端查（本平台自己的 id 是 run.id）
                row.usage = {**(row.usage or {}), "remote_task_id": task_id}
            if status == "waiting_hitl":
                row.pending_hitl = {"remote": remote_base, "remote_task_id": task_id,
                                    "note": "远端在等人确认，确认后远端会继续；本平台不代答"}
                # 后台续轮询：远端确认后会出终态，答案要回填到这条子 run ——
                # 不然它永远停在"等待确认"，用户在远端点了同意也看不到结果。
                _asyncio.get_running_loop().create_task(
                    _repoll_until_done(child.id, remote_base, task_id, timeout, headers, remote_agent_id)
                )
            await session.commit()

    await _asyncio.gather(*(_one(c, picked[int(c.item_index or 0)]) for c in created))

    # 等待确认的那几路由 _repoll_until_done 在后台接管，这里不阻塞。

    # ── 汇总（与本地分派同一形状，render_summary 直接可用）───────────────
    async with db_factory() as session:
        rows = list(
            (
                await session.execute(select(Run).where(Run.id.in_([c.id for c in created])))
            ).scalars()
        )
    rows.sort(key=lambda r: int(r.item_index or 0))
    out_items: list[dict[str, Any]] = []
    ok_n = failed_n = 0
    for r in rows:
        if r.status == "ok":
            ok_n += 1
        elif r.status in ("error", "aborted"):
            failed_n += 1
        text = _text_of(r.output) or (r.error or "")
        out_items.append(
            {
                "index": int(r.item_index or 0),
                "label": r.item_label or "",
                "status": r.status,
                "run_id": r.id,
                "duration_ms": (r.ended_at - r.started_at) if (r.ended_at and r.started_at) else None,
                "summary": text[:SUMMARY_CHARS],
                "error_text": r.error or "",
                "tokens_in": 0,
                "tokens_out": 0,
            }
        )
    # 与本地 dispatch **同一种形状** —— render_summary / 记录页都不用为远端另写一套
    return {
        "isolated": False,
        "workspaces": [],
        "waiting": [
            {"index": x["index"], "label": x["label"], "run_id": x["run_id"]}
            for x in out_items
            if x["status"] in WAITING
        ],
        "usage": {"tokens_in": 0, "tokens_out": 0, "llm_calls": 0},
        "ok": ok_n > 0 and failed_n == 0,
        "total": len(out_items),
        "succeeded": ok_n,
        "failed": [x for x in out_items if x["status"] != "ok"],
        "items": out_items,
        "truncated": len(items) > cap,
        "capped_at": cap,
        "budget_tokens": 0,
        "budget_stopped": 0,
        "timed_out": False,
        "wait_s": timeout,
        # 远端专属（供工具层说清"这一批是发给谁的"）
        "remote": remote_base,
        "remote_name": remote_name,
    }


async def dispatch(
    *,
    parent_run: Run,
    agent_id: str,
    definition_snapshot: dict[str, Any],
    items: list[str],
    max_items: int | None = None,
    wait_s: float | None = None,
    budget_tokens: int | None = None,
    isolate_workspace: bool = False,
    db_factory: Any = SessionLocal,
) -> dict[str, Any]:
    """建 N 条子 run → 交给调度队列（受并发闸）→ 等齐 → 汇总。

    ``isolate_workspace=True`` 时每一路拿到**自己的工作目录**（并行实例同时写文件不会互相覆盖）。
    默认 False = 都用助手的那个目录（能互相看到产物，也是历史行为）。
    """
    from .runner import run_service
    from .schemas import AgentDefinition

    cap = max(1, min(int(max_items or DEFAULT_MAX_ITEMS), MAX_ITEMS_HARD))
    truncated = len(items) > cap
    picked = items[:cap]
    if not picked:
        return {"ok": False, "reason": "没有可分派的项", "items": [], "total": 0}

    # ── 幂等：同一次分派里已成功的项直接复用（重试/重跑不重复扣费）──────
    async with db_factory() as session:
        existing = list(
            (
                await session.execute(
                    select(Run).where(
                        Run.parent_run_id == parent_run.id,
                        Run.item_index.is_not(None),
                    )
                )
            ).scalars()
        )
        # ⚠️ 只有**成功**的项才算"已完成、可复用" —— 失败/被中止的项必须重新跑，
        # 否则「补齐失败的那几路」点了等于没点（现场实测：容器重跑 53s 后，
        # 失败那一项原封不动，因为它也被当成了"已完成"）。终态 ≠ 成功。
        done = {int(r.item_index): r for r in existing if r.status == "ok"}

        created: list[Run] = []
        for i, item in enumerate(picked):
            if i in done:
                continue
            child_snapshot = (
                _isolated_snapshot(definition_snapshot, parent_run, i)
                if isolate_workspace
                else definition_snapshot
            )
            # 工作目录必须**写进提示词**：不然模型会自己编绝对路径（/result.md），
            # 越出沙箱就要人工确认 —— 无人值守的分派会整步卡在"等你确认"（实测）。
            child = Run(
                agent_id=agent_id,
                agent_version=parent_run.agent_version,
                runtime=definition_snapshot.get("runtime") or parent_run.runtime,
                status="pending",
                input={
                    "text": item_prompt(
                        item, i, len(picked), str(child_snapshot.get("workspace") or "")
                    )
                },
                definition_snapshot=child_snapshot,
                started_at=now_ms(),
                # 归属：同一个节点、第几路、谁发起的
                node_id=parent_run.node_id if parent_run.node_id else None,
                item_index=i,
                item_label=item_label(item, i),
                parent_run_id=parent_run.id,
                orchestration_id=parent_run.orchestration_id,
                # 来源沿用父 run（定时/外部触发的分派仍然是"它自己跑的"）
                origin=parent_run.origin,
            )
            session.add(child)
            created.append(child)
        await session.commit()
        for c in created:
            await session.refresh(c)

    ids = [c.id for c in created] + [r.id for r in done.values()]
    timeout = float(wait_s if wait_s is not None else DEFAULT_WAIT_S)
    deadline = time.monotonic() + max(timeout, 1.0)

    #: 预算（token）用完后没跑的项 —— 如实标记，不静默丢弃
    not_started: list[Run] = []
    budget = int(budget_tokens or 0)
    if not created:
        logger.info("分派：%d 项全部已有成功记录，直接复用", len(done))
    else:
        # ── 起：走统一的调度队列（并发闸在那层，超出排队而不是失败）─────
        for c in created:
            # ⚠️ 每一路必须用它**自己**的定义快照 —— 用共享的那份就等于把分派目录隔离
            # 白配了（库里记着隔离目录、实际却写进共享目录；实测踩到：库里是
            # fanout-xxxx-1，磁盘上根本没建这个目录）。
            await run_service.start(
                c.id,
                AgentDefinition.model_validate(c.definition_snapshot or definition_snapshot),
                (c.input or {}).get("text") or "",
            )

    # ── 等齐 + 预算监控 ──────────────────────────────────────────────────
    # 预算按**真花掉的** token 掐（不做跑前预估 —— 估出来的数是编的）：
    # 全部照常提交（并行度不受影响），监控里发现超了就**只停还没开始的那几路** ——
    # 正在跑的不打断（半途掐断反而更浪费），停下的如实标原因，之后可单独重跑。
    timed_out = False
    budget_hit = False
    #: 在等人工确认的那几路（发现就收尾，不傻等到超时）
    waiting: list[str] = []
    while True:
        async with db_factory() as session:
            rows = list((await session.execute(select(Run).where(Run.id.in_(ids)))).scalars())
            if budget > 0 and not budget_hit:
                used = 0
                for r in rows:
                    u = r.usage or {}
                    used += int(u.get("tokens_in") or u.get("prompt_tokens") or 0)
                    used += int(u.get("tokens_out") or u.get("completion_tokens") or 0)
                if used > budget:
                    # 超预算：把**还没开始的**那几路停下并写清原因。
                    # ⚠️ 两个坑都在这里：① 光写库不够 —— 它可能还在分发器的**内存队列**里，
                    #     下一步就被领走跑起来了；② 正在跑的那几路**不打断**（半途掐断更浪费）。
                    # 所以顺序是：先判「没在跑」→ 写库（分发器的 DB 扫描从此不再捡它）→ 再从队列摘掉。
                    from .runner import run_service as _rs

                    _doomed: list[str] = []
                    for r in rows:
                        if r.status == "pending" and not _rs.is_running(r.id):
                            _doomed.append(r.id)
                            r.status = "aborted"
                            r.error = (
                                f"超出预算（{budget} token，已用 {used}）未跑 —— "
                                "可单独重跑，或调高「最多花多少」后整批重跑"
                            )
                            # started_at 也压到同一刻：它**根本没跑**，
                            # 否则界面上会出现"未跑却耗时 34 秒"这种假数字
                            r.ended_at = now_ms()
                            r.started_at = r.ended_at
                    if _doomed:
                        await session.commit()
                        for _rid in _doomed:
                            await _rs.abort(_rid)  # 从内存队列摘掉（上面已确认没在跑）
                        logger.warning(
                            "分派：token 已超预算（%d > %d），停下未开始的 %d 路", used, budget, len(_doomed)
                        )
                    budget_hit = True
        if all(r.status in TERMINAL for r in rows):
            break
        # 某一路在等人点头 → 立即收尾：人什么时候点是未知的，傻等只会把这一步拖到
        # 「最长等多久」超时，而超时报告会把原因说成"跑太久"（误导）。
        _waiting_now = [r.id for r in rows if r.status in WAITING]
        if _waiting_now:
            waiting = _waiting_now
            logger.info("分派：有 %d 路在等人工确认，先收尾（确认后那一路会自己跑完）", len(_waiting_now))
            break
        if time.monotonic() > deadline:
            timed_out = True
            break
        await asyncio.sleep(POLL_SECONDS)

    # ── 汇总（有界：每项一句 + 句柄）─────────────────────────────────────
    async with db_factory() as session:
        rows = list((await session.execute(select(Run).where(Run.id.in_(ids)))).scalars())
    rows.sort(key=lambda r: int(r.item_index or 0))
    out_items: list[dict[str, Any]] = []
    tok_in = tok_out = calls = 0
    for r in rows:
        text = _text_of(r.output) or (r.error or "")
        u = r.usage or {}
        tin = int(u.get("tokens_in") or u.get("prompt_tokens") or 0)
        tout = int(u.get("tokens_out") or u.get("completion_tokens") or 0)
        tok_in += tin
        tok_out += tout
        calls += int(u.get("llm_calls") or 0)
        out_items.append(
            {
                "index": int(r.item_index or 0),
                "label": r.item_label or "",
                "status": r.status,
                "run_id": r.id,
                "duration_ms": (r.ended_at - r.started_at) if (r.ended_at and r.started_at) else None,
                "summary": text[:SUMMARY_CHARS],
                "error_text": r.error or "",
                "tokens_in": tin,
                "tokens_out": tout,
            }
        )
    ok_n = sum(1 for x in out_items if x["status"] == "ok")
    waiting_items = [
        {"index": x["index"], "label": x["label"], "run_id": x["run_id"]}
        for x in out_items
        if x["status"] in WAITING
    ]
    return {
        "isolated": bool(isolate_workspace),
        "workspaces": (
            [f"{_isolated_snapshot(dict(definition_snapshot), parent_run, i)['workspace']}" for i in range(len(picked))]
            if isolate_workspace
            else []
        ),
        "waiting": waiting_items,
        # 合计（**只作展示**：不写进这一步的顶层 usage，否则全局用量统计会重复计一次）
        "usage": {"tokens_in": tok_in, "tokens_out": tok_out, "llm_calls": calls},
        "ok": ok_n > 0,
        "total": len(out_items),
        "succeeded": ok_n,
        "failed": [x for x in out_items if x["status"] not in ("ok",)],
        "items": out_items,
        "truncated": truncated,
        "capped_at": cap,
        "budget_tokens": int(budget_tokens or 0),
        "budget_stopped": sum(1 for x in out_items if (x["status"] == "aborted" and "超出预算" in (x.get("error_text") or ""))),
        "timed_out": timed_out,
        "wait_s": timeout,
    }


async def _tokens_of(ids: list[str], db_factory: Any = SessionLocal) -> int:
    """这批执行到现在**真花掉的** token（预算按真数掐，不按预估）。"""
    if not ids:
        return 0
    async with db_factory() as session:
        rows = list((await session.execute(select(Run).where(Run.id.in_(ids)))).scalars())
    total = 0
    for r in rows:
        u = r.usage or {}
        total += int(u.get("tokens_in") or u.get("prompt_tokens") or 0)
        total += int(u.get("tokens_out") or u.get("completion_tokens") or 0)
    return total


async def _parent_run(run_id: str) -> Run:
    """取当前执行在库里的那一行（dispatch 需要 parent_run）。"""
    async with SessionLocal() as session:
        row = await session.get(Run, run_id)
    if row is None:  # pragma: no cover
        raise RuntimeError(f"父执行不存在: {run_id}")
    return row


def _text_of(blob: Any) -> str:
    """从 run.output 里抠出人话（与记录页同一口径）。"""
    if isinstance(blob, str):
        return blob
    if isinstance(blob, dict):
        for k in ("content", "text", "message"):
            v = blob.get(k)
            if isinstance(v, str) and v.strip():
                return v
            if isinstance(v, list) and v and isinstance(v[0], dict):
                c = v[0].get("content") or v[0].get("text")
                if isinstance(c, str) and c.strip():
                    return c
    return ""


def render_summary(result: dict[str, Any]) -> str:
    """把结果说成模型能用的短文本（**有界**：绝不把 N 项全文塞回上下文）。"""
    if not result.get("items"):
        return f"分派失败：{result.get('reason') or '没有可处理的项'}"
    lines = [
        f"分派结果：共 {result['total']} 项，成功 {result['succeeded']}，失败 {len(result['failed'])}",
    ]
    if result.get("truncated"):
        lines.append(f"注意：项数超过上限，只处理了前 {result['capped_at']} 项（其余未处理）")
    if result.get("isolated"):
        dirs = result.get("workspaces") or []
        lines.append(
            "（这几路各自用**独立的工作目录**，产出不会互相覆盖："
            + "、".join(dirs[:5])
            + ("…" if len(dirs) > 5 else "")
            + "）"
        )
    if result.get("waiting"):
        who = "、".join(f"第 {x['index'] + 1} 项" for x in result["waiting"])
        lines.append(
            f"注意：{who} 正在**等你确认**（它要用的工具需要你点头）—— "
            "去「管理」确认后那一路会自己跑完，然后重跑这一步就能把它并进来（已成功的不会重跑）"
        )
    if result.get("budget_stopped"):
        lines.append(
            f"注意：已花超过预算（{result.get('budget_tokens')} token），"
            f"后面 {result['budget_stopped']} 项**没有执行**（可单独重跑，或调高「最多花多少」后重跑整批）"
        )
    if result.get("timed_out"):
        lines.append(f"注意：等待超过 {int(result['wait_s'])}s，仍有项没跑完（它们可能还在跑）")
    for x in result["items"]:
        mark = "成功" if x["status"] == "ok" else x["status"]
        dur = f"{x['duration_ms'] / 1000:.1f}s" if x.get("duration_ms") else "—"
        lines.append(f"{x['index'] + 1}. [{mark}] {dur} {x['label']}：{x['summary'] or '（无产出）'}")
    if result["failed"]:
        bad = "、".join(str(x["index"] + 1) for x in result["failed"])
        lines.append(f"失败项：第 {bad} 项（错误见各自记录，可单独重跑）")
    u = result.get("usage") or {}
    if u.get("tokens_in") or u.get("tokens_out"):
        lines.append(
            f"各路合计：{len(result['items'])} 路用了 {u.get('tokens_in', 0) + u.get('tokens_out', 0)} token"
            f"（{u.get('tokens_in', 0)} 入 / {u.get('tokens_out', 0)} 出）"
        )
    lines.append("每项完整产出都已存档（按 run_id 可查/回放）；需要细节时再读取，不要凭摘要推断全文。")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# 工具入口：模型调用它来分派
# --------------------------------------------------------------------------- #
async def handle_tool_call(**kwargs: Any) -> str:
    """``fork`` 工具的执行体（由运行时按 FunctionTool 调用）。

    参数（由模型填）：
      tasks      字符串数组，每项一个子任务（必填）
      max_items  最多几路（可选，默认 5，硬上限 20）
      wait_s     最多等多久（可选，默认 900 秒）
    身份（run_id / node_id / agent_id）从 contextvar 取 —— 模型不需要知道这些。
    """
    tasks = kwargs.get("tasks")
    if isinstance(tasks, str):
        tasks = parse_items(tasks) or [tasks]
    items = [str(t).strip() for t in (tasks or []) if str(t).strip()]
    if not items:
        return "分派失败：tasks 必须是至少一项的字符串数组。"

    ctx = current_run_ctx()
    run_id = ctx.get("run_id")
    agent_id = ctx.get("agent_id")
    # 派给谁：优先级 —— ① 这次调用显式填的（模型自己判断）；② **本步在节点上配的「派给谁」**
    # （人在画布上定死的默认，不靠模型自觉）；③ 都没有 = 自己。
    # 远端 A2A：填了 remote（URL）就把这一批发给**另一台平台上的 agent**，
    # 与本地分派共记录页/调用链/汇总形状，只是每一路走 A2A 而不是本地运行时。
    remote_base = str(kwargs.get("remote") or "").strip()
    if remote_base:
        if not run_id or not agent_id:
            return "分派失败：当前不在一次执行上下文中（fork 只能由正在运行的助手调用）。"
        # 远端要哪个助手：显式参数优先（远端平台认 message.metadata.agentId）；
        # 不填 = 远端自己的默认助手
        remote_agent = str(kwargs.get("remote_agent") or "").strip()
        result = await dispatch_remote(
            parent_run=await _parent_run(run_id),
            agent_id=str(agent_id),
            remote_base=remote_base,
            items=items,
            max_items=kwargs.get("max_items"),
            wait_s=kwargs.get("wait_s"),
            remote_agent_id=remote_agent or None,
        )
        head = (
            f"（这一批是发给远端 A2A agent「{result.get('remote_name') or remote_base}」执行的："
            f"{remote_base}）\n"
        )
        return head + render_summary(result)

    target_name = str(kwargs.get("agent") or "").strip()
    _node_default = ""
    if not target_name:
        _pre = current_run_ctx()
        if _pre.get("run_id"):
            async with SessionLocal() as _s:
                _row = await _s.get(Run, _pre["run_id"])
                if _row is not None:
                    _node_default = str(((_row.input or {}).get("fanout_agent") or "")).strip()
            if _node_default:
                # 存的是 agent_id（节点上选的是"哪一个助手"）→ 换回名字走下面同一条解析
                async with SessionLocal() as _s:
                    from .models import Agent as _A

                    _t = await _s.get(_A, _node_default)
                    target_name = _t.name if _t is not None else ""
                logger.info("分派未指定 agent → 用本步节点配的「派给谁」：%s", target_name)
    target_agent_id = agent_id
    if not run_id or not agent_id:
        # 不在执行上下文里（例如被别处直接调用）——明确拒绝，而不是建出无主的执行
        return "分派失败：当前不在一次执行上下文中（fork 只能由正在运行的助手调用）。"

    # 内核兜底（不只靠工具清单）：到允许的层数就不再分派。
    # 默认 1 层 —— 分派出来的实例不再分派；平台可在界面上放开到 2 层。
    from .quota import get_depth_limit as _depth_limit_of

    async with SessionLocal() as _ds:
        _max_depth = await _depth_limit_of(_ds)
    if ctx.get("depth", 0) >= _max_depth:
        return (
            f"分派失败：你已经处在第 {ctx.get('depth', 0)} 层，"
            f"当前平台最多允许 {_max_depth} 层分派。"
        )

    async with SessionLocal() as session:
        parent = await session.get(Run, run_id)
        if parent is None:
            return f"分派失败：找不到当前执行记录 {run_id}。"
        if target_name:
            from sqlalchemy import select as _select

            from .models import Agent as _Agent

            pick = (
                await session.execute(_select(_Agent).where(_Agent.name == target_name))
            ).scalars().first()
            if pick is None:
                names = [
                    a.name for a in (await session.execute(_select(_Agent))).scalars()
                ]
                return f"分派失败：没有叫「{target_name}」的助手（现有：{'、'.join(names)}）"
            target_agent_id = pick.id
            # 子实例要跑的是**那个助手**，所以定义快照也得是它自己的
            # （用父执行的快照去跑另一个助手 = 拿错提示词/模型/工具）
            snap = dict(pick.definition or {})
        else:
            snap = dict(parent.definition_snapshot or {})
        # 子实例去掉分派工具（双保险：load_tools 那层也会按深度过滤）。
        # ⚠️ 定义里的工具项**只有 ref（Tool 行 id），没有 name** —— 只按名字过滤等于没过滤
        # （实测：子执行的快照里 fork 还在）。所以先把 ref 解析成真名字再比。
        snap["tools"] = await _without_fork(session, snap.get("tools") or [])

    result = await dispatch(
        parent_run=parent,
        agent_id=target_agent_id or agent_id,
        isolate_workspace=bool(kwargs.get("isolate")),
        definition_snapshot=snap,
        items=items,
        max_items=kwargs.get("max_items"),
        wait_s=kwargs.get("wait_s"),
        budget_tokens=kwargs.get("budget_tokens"),
    )
    return render_summary(result)


def _tool_name(ref: Any) -> str:
    """取工具项的名字（有 name 就用，没有就退化成 ref 字符串 —— 只适合展示）"""
    if isinstance(ref, dict):
        return str(ref.get("name") or ref.get("ref") or "")
    return str(ref or "")


async def _without_fork(session: Any, tools: list[Any]) -> list[Any]:
    """去掉分派工具本身 —— 子实例不该再分派（深度限 1）。

    过滤必须按**真名字**：定义里的工具项形如 ``{"ref": "tl_xxx", "enabled": true}``，
    名字在 Tool 表里（这与 agent_ops 里 fork 剥离踩过的是同一个坑）。只按
    ``_tool_name()`` 比字符串，ref 一定不等于 "fork"，于是"双保险"形同虚设。
    """
    from .models import Tool as _Tool

    refs = [str(t.get("ref") or "") for t in tools if isinstance(t, dict)]
    names: dict[str, str] = {}
    if refs:
        rows = (await session.execute(select(_Tool.id, _Tool.name).where(_Tool.id.in_(refs)))).all()
        names = {str(i): str(n) for i, n in rows}

    def keep(t: Any) -> bool:
        if not isinstance(t, dict):
            return True
        ref = str(t.get("ref") or "")
        # 名字优先取定义里的（可能显式写了），否则回表查
        name = str(t.get("name") or names.get(ref) or "")
        return name != "fork"

    return [t for t in tools if keep(t)]


#: 给模型看的说明与参数（工具入库时写进 description / input_schema）
TOOL_DESCRIPTION = (
    "把一份任务清单分派出去并行处理（每项一路，每路一条独立执行记录）。"
    "默认用你自己；填 agent 用本平台别的助手；填 remote 则派给**远端 A2A agent**（跨平台）。"
    "适合「这批东西每一条都要过一遍」的场景（多份文档、多张单据、多个查询）。"
    "原说明留档：把一份任务清单分派给**同一助手的多个实例**并行处理（每项一个实例），"
    "然后一次性拿回各项结果摘要。适合「这批东西每一条都要过一遍」的场景"
    "（多份文档、多张单据、多个查询）。"
    "它会为每一项生成一条独立的执行记录（可单独查看、单独重跑、单独计费），"
    "因此不要用它代替「同一步里做一件小事」。最多 20 项，默认 5 项。"
)
TOOL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "tasks": {
            "type": "array",
            "items": {"type": "string"},
            "description": "要分派的子任务清单，一项一条（必填）",
        },
        "max_items": {
            "type": "integer",
            "description": "最多处理几项（可选，默认 5，上限 20）",
        },
        "wait_s": {
            "type": "integer",
            "description": "最多等多久（秒，可选，默认 900）",
        },
        "budget_tokens": {
            "type": "integer",
            "description": "这一批最多花多少 token（可选，默认不限）。超了会停下还没开始的那几路并如实上报",
        },
        "isolate": {
            "type": "boolean",
            "description": (
                "true = 每一路用**自己独立的工作目录**（各自产出的文件不会互相覆盖）；"
                "默认 false = 都用你自己的目录"
            ),
        },
        "agent": {
            "type": "string",
            "description": (
                "用**哪个助手**去跑这些子任务（填助手名字，可选）。"
                "不填 = 用你自己。编排者派活给别人（例如「通用助手」）时填这里"
            ),
        },
        "remote_agent": {
            "type": "string",
            "description": (
                "远端用**哪个助手**跑（可选）：填远端平台上的助手 id。"
                "不填 = 远端自己的默认助手。只填了 remote 才有意义"
            ),
        },
        "remote": {
            "type": "string",
            "description": (
                "把这一批发给**远端 A2A agent**（填它的地址，可选）——"
                "跨平台派活时用，例如 http://other-host:8848 或完整卡片地址。"
                "填了它就不在本平台跑，每一路仍会记一条执行记录（标为 A2A）。"
            ),
        },
    },
    "required": ["tasks"],
}


def tool_flags() -> dict[str, Any]:
    return {
        "platform": True,
        "read_only": False,
        # 分派会占用并发配额与额度 → 不让它和其它工具并发调用
        "concurrency_safe": False,
        "fanout": True,
    }


async def _repoll_until_done(
    child_run_id: str,
    remote_base: str,
    task_id: str,
    timeout_s: float,
    headers: dict[str, str] | None,
    remote_agent_id: str | None,
) -> None:
    """远端在等人确认时，后台继续轮它的任务直到终态，把结果回填到子 run。

    场景：远端平台的 agent 用工具要人点确认（HITL）。``run_until_done`` 撞到
    input-required 会立即返回（不能让父 run 干等），但远端被确认后会继续跑出
    终态 —— 没人接着轮，答案就永远丢了。这里接管：deadline 之前持续轮询，
    出终态（ok/失败/取消）就回填子 run 并清掉 pending_hitl。
    """
    import asyncio as _a

    from . import a2a_client

    deadline = time.monotonic() + max(30.0, timeout_s)
    while True:
        try:
            task = await a2a_client.get_task(remote_base, task_id, headers=headers)
        except a2a_client.A2AError:
            break  # 远端暂时连不上就到此为止 —— 子 run 已如实标了等待确认
        state = a2a_client.state_of(task)
        if state in ("completed", "canceled", "failed", "rejected"):
            status = a2a_client.status_of(task)
            out = a2a_client.task_text(task)
            async with SessionLocal() as session:
                row = await session.get(Run, child_run_id)
                if row is None or row.status != "waiting_hitl":
                    return  # 用户已在本地重跑/中止，别覆盖
                row.status = status
                row.output = {"content": out} if out else None
                row.error = None if status == "ok" else (out or "远端执行失败")
                row.ended_at = now_ms()
                row.pending_hitl = None
                row.usage = {**(row.usage or {}), "remote_task_id": task_id}
                await session.commit()
            return
        if time.monotonic() >= deadline:
            return  # 子 run 保持 waiting_hitl（pending_hitl 里留着 task_id，可手动查）
        await _a.sleep(a2a_client.POLL_S * 2)
