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


def item_prompt(item: str, index: int, total: int) -> str:
    """交给实例的输入。

    刻意写得**明确而有限**：只处理这一项、不要替其它项做决定 ——
    否则每路都会试图总结全局，产出互相重复、汇总时噪声很大。
    """
    return (
        f"这是分派给你的第 {index + 1} 项（共 {total} 项），"
        f"只处理这一项，不要处理其它项、也不要总结全局：\n\n{item}"
    )


# --------------------------------------------------------------------------- #
# 内核：分派
# --------------------------------------------------------------------------- #
async def dispatch(
    *,
    parent_run: Run,
    agent_id: str,
    definition_snapshot: dict[str, Any],
    items: list[str],
    max_items: int | None = None,
    wait_s: float | None = None,
    budget_tokens: int | None = None,
    db_factory: Any = SessionLocal,
) -> dict[str, Any]:
    """建 N 条子 run → 交给调度队列（受并发闸）→ 等齐 → 汇总。"""
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
        done = {int(r.item_index): r for r in existing if r.status in TERMINAL}

        created: list[Run] = []
        for i, item in enumerate(picked):
            if i in done:
                continue
            child = Run(
                agent_id=agent_id,
                agent_version=parent_run.agent_version,
                runtime=definition_snapshot.get("runtime") or parent_run.runtime,
                status="pending",
                input={"text": item_prompt(item, i, len(picked))},
                definition_snapshot=definition_snapshot,
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
        definition = AgentDefinition.model_validate(definition_snapshot)
        for c in created:
            await run_service.start(c.id, definition, (c.input or {}).get("text") or "")

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
    # 派给谁：默认自己；填了别的助手名字就用它（编排者派活给通用助手走这条）
    target_name = str(kwargs.get("agent") or "").strip()
    target_agent_id = agent_id
    if not run_id or not agent_id:
        # 不在执行上下文里（例如被别处直接调用）——明确拒绝，而不是建出无主的执行
        return "分派失败：当前不在一次执行上下文中（fork 只能由正在运行的助手调用）。"

    if ctx.get("depth", 0) >= 1:
        # 深度 1：实例不再具备分派能力（内核兜底，不只靠工具清单）
        return "分派失败：分派出来的实例不允许再次分派（最多一层）。"

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
        # 子实例去掉分派工具（双保险：load_tools 那层也会按深度过滤）
        snap["tools"] = [t for t in (snap.get("tools") or []) if _tool_name(t) != "fork"]

    result = await dispatch(
        parent_run=parent,
        agent_id=target_agent_id or agent_id,
        definition_snapshot=snap,
        items=items,
        max_items=kwargs.get("max_items"),
        wait_s=kwargs.get("wait_s"),
        budget_tokens=kwargs.get("budget_tokens"),
    )
    return render_summary(result)


def _tool_name(ref: Any) -> str:
    if isinstance(ref, dict):
        return str(ref.get("name") or ref.get("ref") or "")
    return str(ref or "")


#: 给模型看的说明与参数（工具入库时写进 description / input_schema）
TOOL_DESCRIPTION = (
    "把一份任务清单分派给**同一助手的多个实例**并行处理（每项一个实例），"
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
        "agent": {
            "type": "string",
            "description": (
                "用**哪个助手**去跑这些子任务（填助手名字，可选）。"
                "不填 = 用你自己。编排者派活给别人（例如「通用助手」）时填这里"
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
