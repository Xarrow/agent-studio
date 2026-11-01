"""分派树的判定器：成环 / 重复 / 预算 / 停滞。

这里**只放纯函数**（不碰数据库、不问模型）。理由和 verify.py 一样：
这些判断是整条链上最需要被信任的一块，做成纯函数才能逐条单测、回放时行为一致。

四道闸对应的判据：
* 结构闸：``would_cycle`` —— 派发链里已经有这个助手，再派就是 A→B→A；
* 语义闸：``fingerprint_of`` —— 同一棵树里同一助手同一任务，只是文本换了措辞；
* 预算闸：``remaining`` —— 额度记在**根**上，子执行花掉的都算在这棵树上；
* 停滞闸：``stall_reason`` —— 在跑但没进展（同一步反复 / 连续没有任何成功结果）。
"""

from __future__ import annotations

import hashlib
import re
from typing import Any, Iterable

#: 派发链最多记这么多层（深度上限是 2，留足余量给「深度放开」之后的场景）
PATH_MAX = 24

#: 同一步重复到这个次数就算停滞
REPEAT_LIMIT = 3
#: 连续这么多步没有任何成功结果就算停滞
NO_PROGRESS_LIMIT = 8

_PUNCT = re.compile(r"[\s，。、；：！？,.;:!?\"'`（）()【】「」《》\-—_/\\|]+")


def normalise_task(text: str) -> str:
    """归一化任务文本：去空白与标点、统一小写。

    只做**表面**归一（标点/空白/大小写），不做同义改写 —— 真要判断"意思一样"
    得上向量，那是另一层的钱和时间，v1 不掺进来。
    """
    return _PUNCT.sub("", (text or "").lower())


def fingerprint_of(agent_id: str, task: str) -> str:
    """任务指纹：同一助手 + 同一（归一化后的）任务 → 同一个指纹。

    取 16 位十六进制：够区分（2^64），也短到能进索引与日志。
    """
    raw = f"{(agent_id or '').strip()}|{normalise_task(task)}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def path_agents(dispatch_path: str | None) -> list[str]:
    """把 ``ag_a>ag_b`` 拆成 agent 列表（脏数据不炸）。"""
    return [p.strip() for p in (dispatch_path or "").split(">") if p.strip()][:PATH_MAX]


def extend_path(dispatch_path: str | None, agent_id: str) -> str:
    """在派发链末尾接上下一层（超长时只留最后 PATH_MAX 段）。"""
    parts = path_agents(dispatch_path)
    nxt = (agent_id or "").strip()
    if nxt:
        parts.append(nxt)
    return ">".join(parts[-PATH_MAX:])


def would_cycle(dispatch_path: str | None, agent_id: str) -> bool:
    """这个助手是不是**上游祖先**（= 再派给它就是 A→B→A）。

    只看祖先，不看**当前这一层**：让一个助手把自己的活拆成 N 路（派给自己）
    是最常用的用法，把它判成环等于把分派功能关掉。真正的回路是"派回上游"，
    而"自己派自己"由深度上限管（子实例不再具备分派能力）。
    """
    target = (agent_id or "").strip()
    if not target:
        return False
    ancestors = path_agents(dispatch_path)[:-1]
    return target in ancestors


def remaining(budget: int | None, spent: int | None) -> int | None:
    """这棵树还剩多少 token（None = 没设上限）。"""
    if budget is None:
        return None
    try:
        return int(budget) - int(spent or 0)
    except (TypeError, ValueError):
        return None


def spend(marks: Iterable[dict[str, Any]]) -> int:
    """一组执行的 usage 合计（只取真花掉的，不做预估）。"""
    total = 0
    for u in marks:
        total += int(u.get("tokens_in") or u.get("prompt_tokens") or 0)
        total += int(u.get("tokens_out") or u.get("completion_tokens") or 0)
    return total


def stall_reason(tool_calls: list[dict[str, Any]]) -> str | None:
    """在跑但没进展？给一句人话原因，没有就 None。

    ``tool_calls`` = 按时间**正序**的工具调用记录，每条形如
    ``{"tool": "bash", "args": "...", "status": "ok"}``。

    两条判据（任一命中即停滞）：
    * 最后 REPEAT_LIMIT 次是**同一个调用**（同 tool、同 args）—— 典型的原地打转；
    * 最近 NO_PROGRESS_LIMIT 次**一次都没成功** —— 一直在撞同一堵墙。

    注意：只判"最后一段"，不判整段历史 —— 一个长任务开头失败几次、后面跑通是正常的。
    """
    marks = [m for m in tool_calls if isinstance(m, dict)]
    if not marks:
        return None

    tail = marks[-REPEAT_LIMIT:]
    if len(tail) == REPEAT_LIMIT:
        sig = {(str(m.get("tool") or ""), str(m.get("args") or "")) for m in tail}
        if len(sig) == 1:
            tool, args = next(iter(sig))
            return (
                f"同一步重复了 {REPEAT_LIMIT} 次没有新结果（{tool} "
                f"{args[:60]}{'…' if len(args) > 60 else ''}）"
            )

    if len(marks) >= NO_PROGRESS_LIMIT:
        recent = marks[-NO_PROGRESS_LIMIT:]
        if not any(str(m.get("status") or "") == "ok" for m in recent):
            return f"连续 {NO_PROGRESS_LIMIT} 步没有任何成功结果"
    return None
