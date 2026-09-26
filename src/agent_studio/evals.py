"""评测：用例集 + 批量跑 + 打分 + 两版对比。

为什么需要它（用户的原始问题）
------------------------------
"我改了提示词，到底变好了还是变坏了？"—— 没有用例集，这个问题只能靠感觉回答；
而"感觉"在 Agent 上特别不可靠（同一个问题问两次答案就不一样）。

设计要点
--------
· **不新建执行引擎**：每一例就是一条普通的 ``run`` 记录（挂 ``usage.eval_run_id`` 认领），
  所以并发闸、每日额度、span、成本、历史回放**全都自动复用** ——
  评测不是在平台旁边另起一套，而是站在平台上跑。
· **打分先看硬判据、再让模型当裁判**：
  ① ``must_include``（必须包含的关键词，用 ``|`` 分隔）—— 确定性、可复现、0 成本；
  ② 只有①没写时，才用「评分要点」请模型当裁判（0~100 + 一句话理由）。
  **两者都没有 → 不给分（None）**，绝不默认满分：那等于自欺。
· **对比是同一用例集两次运行**（例如"改提示词前/后"）：逐例出 Δ，看得见哪几条退步了。
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import SessionLocal
from .llm import chat_once, extract_json
from .models import Agent, EvalRun, EvalSuite, Run, now_ms

logger = logging.getLogger(__name__)

#: 一例最长等多久（模型慢/排队都可能；超时就如实记"超时"，不给分）
CASE_WAIT_S = 900
#: 判据里用来分隔多个关键词的符号（中文竖线也认 —— 用户会写成"甲｜乙"）
_SEP = "|｜"


def normalise_cases(raw: Any) -> list[dict[str, Any]]:
    """把界面交上来的用例整理成规范形状（顺手拦住空用例）。"""
    out: list[dict[str, Any]] = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        text = str(item.get("input") or "").strip()
        if not text:
            continue
        # id 按**保留下来的**顺序编号（丢掉空行后不能留洞，否则界面上会看到"第 4 例"却没有前三例）
        out.append(
            {
                "id": str(item.get("id") or f"c{len(out) + 1}"),
                "input": text,
                "must_include": str(item.get("must_include") or "").strip(),
                "rubric": str(item.get("rubric") or "").strip(),
            }
        )
    return out


def _checks_of(case: dict[str, Any]) -> list[str]:
    raw = str(case.get("must_include") or "")
    parts: list[str] = []
    for chunk in raw.replace("｜", "|").split("|"):
        kw = chunk.strip()
        if kw:
            parts.append(kw)
    return parts


def score_case(case: dict[str, Any], output: str) -> dict[str, Any]:
    """按硬判据打分（**纯函数**，可单测）。

    · 有 ``must_include`` → 100 × 命中数/总数，逐条给出命中与否（用户能看出差在哪）。
    · 没有判据 → ``score=None``（不是 0、也不是 100）—— 交给裁判或如实标"没判据"。
    """
    checks = _checks_of(case)
    if not checks:
        return {"score": None, "checks": [], "note": "没写判据（必须包含 或 评分要点），这一例不给分"}
    text = output or ""
    low = text.lower()
    detail = []
    hit = 0
    for kw in checks:
        ok = kw.lower() in low
        hit += 1 if ok else 0
        detail.append({"keyword": kw, "hit": ok})
    return {"score": round(100 * hit / len(checks), 1), "checks": detail, "note": ""}


JUDGE_PROMPT = """你是严格的评测裁判。按给定的评分要点给下面这条回答打分。

评分要点：{rubric}

【用户输入】
{input}

【待评回答】
{output}

只输出 JSON，不要任何多余文字：
{{"score": 0~100 的整数, "reason": "一句话说明扣分或给分的关键理由"}}
"""


async def judge_case(
    case: dict[str, Any], output: str, *, base_url: str, api_key: str, model: str
) -> dict[str, Any]:
    """请模型当裁判（只在没有硬判据时用）。返回 ``{score, reason}``；失败则 score=None。"""
    rubric = str(case.get("rubric") or "").strip()
    if not rubric:
        return {"score": None, "reason": "没写评分要点"}
    reply, err = await chat_once(
        base_url=base_url,
        api_key=api_key,
        model=model,
        messages=[
            {
                "role": "user",
                "content": JUDGE_PROMPT.format(rubric=rubric, input=case["input"], output=output),
            }
        ],
    )
    if err:
        return {"score": None, "reason": f"裁判没评成：{err}"}
    data = extract_json(reply)
    if not data:
        return {"score": None, "reason": f"裁判没按格式回：{reply[:120]}"}
    try:
        score = float(data.get("score"))
    except (TypeError, ValueError):
        return {"score": None, "reason": f"裁判给了非数字分：{data.get('score')!r}"}
    return {"score": max(0.0, min(100.0, score)), "reason": str(data.get("reason") or "")[:300]}


async def start_eval(
    session: AsyncSession, suite: EvalSuite, *, label: str = "", agent: Agent | None = None
) -> EvalRun:
    """开一次评测：给每一例建一条 run（pending，等分发器捡），并登记这次评测。

    为什么不在这里直接跑：直接跑就要自己实现并发/超时/额度/记录，
    而这些都是 ``run`` 已经有的东西 —— 复用等于白拿。
    """
    cases = normalise_cases(suite.cases)
    agent_id = suite.agent_id if agent is None else agent.id
    run = EvalRun(
        suite_id=suite.id,
        agent_id=agent_id,
        label=(label or "").strip()[:60],
        status="running",
        results=[
            {"case_id": c["id"], "index": i, "input": c["input"], "status": "pending"}
            for i, c in enumerate(cases)
        ],
    )
    session.add(run)
    await session.flush()

    definition = dict((agent.definition if agent is not None else None) or {})
    for i, case in enumerate(cases):
        session.add(
            Run(
                agent_id=agent_id,
                runtime=str(definition.get("runtime") or "agentscope"),
                status="pending",
                input={"text": case["input"]},
                definition_snapshot=definition,
                # 认领信息写在 usage 里：不新增列，也不影响"这条花了多少"的显示
                usage={"eval_run_id": run.id, "eval_case": i, "eval_label": run.label},
                item_label=f"第 {i + 1} 例 · {case['input'][:18]}",
            )
        )
    await session.commit()
    logger.info("评测已开跑：%s（用例集 %s，%d 例）", run.id, suite.name, len(cases))
    return run


def _case_run_ids(run: EvalRun) -> list[str]:
    return [str(x.get("run_id") or "") for x in (run.results or []) if x.get("run_id")]


async def finish_eval(eval_run_id: str) -> EvalRun | None:
    """等所有用例执行结束 → 逐例打分 → 汇总。可重复调用（幂等）。"""
    async with SessionLocal() as session:
        run = await session.get(EvalRun, eval_run_id)
        if run is None:
            return None
        suite = await session.get(EvalSuite, run.suite_id)
        if suite is None:
            return None
        agent = await session.get(Agent, run.agent_id)
        cases = normalise_cases(suite.cases)

        # 找出这次评测的用例执行（按 usage.eval_run_id 认领 —— 不靠 item_label 猜）
        rows = list(
            (await session.execute(select(Run).where(Run.agent_id == run.agent_id))).scalars()
        )
        mine = {
            int((r.usage or {}).get("eval_case")): r
            for r in rows
            if isinstance(r.usage, dict) and (r.usage or {}).get("eval_run_id") == eval_run_id
        }
        if not mine:
            run.status = "error"
            run.finished_at = now_ms()
            await session.commit()
            return run

        results: list[dict[str, Any]] = []
        scores: list[float] = []
        for i, case in enumerate(cases):
            row = mine.get(i)
            out_text = ""
            status = "missing"
            err = ""
            tokens = 0
            if row is not None:
                status = row.status
                if isinstance(row.output, dict):
                    out_text = str(row.output.get("content") or "")
                err = row.error or ""
                tin, tout = (row.usage or {}).get("tokens_in"), (row.usage or {}).get("tokens_out")
                tokens = int(tin or 0) + int(tout or 0)

            graded = score_case(case, out_text)
            judge = None
            if graded["score"] is None and status == "ok":
                # 只有没写硬判据、且这一例真跑成了，才请裁判（省钱也省时）
                judge = await _judge_with_agent(agent, case, out_text)
                if judge.get("score") is not None:
                    graded = {"score": judge["score"], "checks": [], "note": "由 AI 裁判打分"}

            item = {
                "case_id": case["id"],
                "index": i,
                "input": case["input"],
                "status": status,
                "output": out_text[:4000],
                "score": graded["score"],
                "checks": graded["checks"],
                "judge": judge,
                "note": graded["note"],
                "error": err[:400],
                "tokens": tokens,
                "run_id": row.id if row is not None else "",
            }
            results.append(item)
            if graded["score"] is not None:
                scores.append(float(graded["score"]))

        run.results = results
        run.score = round(sum(scores) / len(scores), 1) if scores else None
        run.status = "ok" if len(mine) == len(cases) else "partial"
        run.finished_at = now_ms()
        await session.commit()
        logger.info(
            "评测收口：%s 得分 %s（%d/%d 例有分）", run.id, run.score, len(scores), len(cases)
        )
        return run


async def _judge_with_agent(
    agent: Agent | None, case: dict[str, Any], output: str
) -> dict[str, Any] | None:
    """用被测助手自己的凭据/模型当裁判（不另配一套 key）。"""
    if agent is None or not (case.get("rubric") or "").strip() or not output.strip():
        return None
    from .runner.service import resolve_credential

    try:
        async with SessionLocal() as session:
            from .schemas import AgentDefinition

            definition = AgentDefinition.model_validate(agent.definition or {})
            api_key, base_url = await resolve_credential(definition, session)
            model = (agent.definition or {}).get("model", {})
            model_name = str(model.get("name") or "")
            base = base_url or str(model.get("base_url") or "")
        return await judge_case(
            case, output, base_url=base, api_key=api_key, model=model_name
        )
    except Exception as exc:  # noqa: BLE001 - 裁判失败不该毁掉整批
        logger.warning("裁判调用失败：%s", exc)
        return {"score": None, "reason": f"裁判调用失败：{exc}"}


async def wait_and_finish(eval_run_id: str, timeout_s: int = CASE_WAIT_S) -> None:
    """后台等这批用例跑完再收口（由 API 起一个 task，失败只记日志）。"""
    deadline = now_ms() + timeout_s * 1000
    while now_ms() < deadline:
        await asyncio.sleep(2.0)
        async with SessionLocal() as session:
            run = await session.get(EvalRun, eval_run_id)
            if run is None:
                return
            rows = list(
                (await session.execute(select(Run).where(Run.agent_id == run.agent_id))).scalars()
            )
        pend = [
            r
            for r in rows
            if isinstance(r.usage, dict)
            and (r.usage or {}).get("eval_run_id") == eval_run_id
            and r.status in ("pending", "running", "waiting_hitl")
        ]
        if not pend:
            break
    try:
        await finish_eval(eval_run_id)
    except Exception:  # noqa: BLE001
        logger.exception("评测收口出错：%s", eval_run_id)


def compare(left: EvalRun, right: EvalRun) -> dict[str, Any]:
    """两次运行逐例对比（同一个用例集才有意义）。

    返回每例的 ``left/right/delta``（缺的那一侧记 None）与总分 Δ ——
    退步的例会**排在前面**，因为用户真正要看的就是"哪几条被我改坏了"。
    """
    lmap = {int(x.get("index", -1)): x for x in (left.results or [])}
    rmap = {int(x.get("index", -1)): x for x in (right.results or [])}
    items: list[dict[str, Any]] = []
    for idx in sorted(set(lmap) | set(rmap)):
        a, b = lmap.get(idx), rmap.get(idx)
        sa = a.get("score") if a else None
        sb = b.get("score") if b else None
        delta = None if sa is None or sb is None else round(float(sb) - float(sa), 1)
        items.append(
            {
                "index": idx,
                "input": (b or a or {}).get("input", ""),
                "left": {"score": sa, "output": (a or {}).get("output", ""), "status": (a or {}).get("status")},
                "right": {"score": sb, "output": (b or {}).get("output", ""), "status": (b or {}).get("status")},
                "delta": delta,
            }
        )
    items.sort(key=lambda x: (x["delta"] is None, x["delta"] if x["delta"] is not None else 0))
    total = None
    if left.score is not None and right.score is not None:
        total = round(float(right.score) - float(left.score), 1)
    return {
        "left": {"id": left.id, "label": left.label, "score": left.score, "at": left.created_at},
        "right": {"id": right.id, "label": right.label, "score": right.score, "at": right.created_at},
        "total_delta": total,
        "items": items,
    }
