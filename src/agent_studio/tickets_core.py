"""Ticket：一件要有人干的事 —— 阶段由事实算出来，不靠改状态。

照 dsh-superagent 的 001-domain：它没有"改 stage"的代码，只有事实
（Input / Report / Attention），stage 是一张**按优先级读的表**。
这样做的好处很直接：状态不可能和事实不一致，也不可能出现"卡在某个状态没人动"。

我们这边的对应关系：
    Trigger  → event 表（已有，kind/payload/dedupe_key/causation_id）
    Thread   → thread_sub 表（thread_id → session_id），后续要扩成多对多
    Ticket   → 这张表
    Assign   → run（已有，挂 ticket_id）
    Report   → tickets.facts["reports"]
    Attention→ tickets.facts["attention"]
"""

from __future__ import annotations

from typing import Any

#: 阶段常量（面板按这个顺序读；定义见 stage()）
STAGE_UNDELIVERED = "person/delivery"
STAGE_ANSWER = "person/answer"
STAGE_REVIEW = "person/review"
STAGE_BLOCKED = "person/blocked"
STAGE_FAILED = "person/failed"
STAGE_QUEUED = "working/queued"
STAGE_IDLE = "idle"
STAGE_WORKING = "working"

#: 面板文案：一行说清"现在卡在谁那里"
STAGE_LABEL: dict[str, str] = {
    STAGE_UNDELIVERED: "消息没送到",
    STAGE_ANSWER: "等你的回答",
    STAGE_REVIEW: "等你验收",
    STAGE_BLOCKED: "卡住了",
    STAGE_FAILED: "失败了",
    STAGE_QUEUED: "排队中",
    STAGE_IDLE: "等下一个触发",
    STAGE_WORKING: "在干",
}

#: 这些阶段都要人动手 —— 面板第一屏应该是它们
PERSON_STAGES = frozenset({STAGE_UNDELIVERED, STAGE_ANSWER, STAGE_REVIEW, STAGE_BLOCKED, STAGE_FAILED})


def stage(facts: dict[str, Any]) -> str:
    """算出一张票此刻的阶段。**纯函数**：同样的输入永远同样的输出，可单测。

    顺序就是优先级（自上而下，第一条命中的算数）—— 取的是 dsh-superagent 那张表：
      1. 投递失败   —— 连消息都没送到，别的都无从谈起
      2. 有未答问题 —— 它在等你
      3. 最新报告是 ready —— 做完等你验收
      4. 最新报告 blocked/failed 且之后没有人回过话
      5. 有未完成的 Assignment（或还没开始）
      6. 最新报告是 waiting，或 Assignment 已结束 → idle
      7. 其余 → working
    """
    if facts.get("ended_at"):
        return STAGE_IDLE
    if int(facts.get("undelivered") or 0) > 0:
        return STAGE_UNDELIVERED
    if facts.get("attention"):
        return STAGE_ANSWER

    reports: list[dict[str, Any]] = list(facts.get("reports") or [])
    latest = reports[-1] if reports else None
    if latest and latest.get("kind") == "ready":
        return STAGE_REVIEW
    if latest and latest.get("kind") in ("blocked", "failed"):
        # 之后人说过话 → 已经放行，往下走（免得一张票永远停在"卡住了"）
        last_human = int(facts.get("last_human_at") or 0)
        if int(latest.get("at") or 0) >= last_human:
            return STAGE_BLOCKED if latest["kind"] == "blocked" else STAGE_FAILED

    assignment = facts.get("assignment") or {}
    status = assignment.get("status")
    # 没有 Assignment，或还没跑起来 —— 这是「排队中」，不是「在干」
    if status in (None, "queued", "pending"):
        return STAGE_QUEUED
    if status == "running":
        return STAGE_WORKING
    # 跑完了还没交下一轮：等触发（waiting 报告，或就是空着）
    return STAGE_IDLE


def needs_person(facts: dict[str, Any]) -> bool:
    return stage(facts) in PERSON_STAGES
