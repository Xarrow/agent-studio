"""记忆提炼 —— 从一次执行里提炼"值得长期记住"的内容。

这是「自动沉淀」的核心。生产级的难点不在"能不能提炼"，而在**护栏**：

1. **只提炼结论 / 偏好 / 事实，不存过程** —— 否则记忆库会被工具调用流水灌满
2. **去重合并** —— 与已有记忆高度相似时更新旧条目，而不是新增（防止同一事实存 100 份）
3. **条数上限** —— 单次最多 3 条
4. **默认进候选态** —— 自动提炼的结果先落 ``status=candidate``，用户确认后才生效

第 4 条是整个设计里最关键的一环：它让自动化**不失控** ——
即使用户长期不清理，候选区堆积也只是"待办的噪音"，不会污染召回结果。
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Memory
from .recall import keyword_score

logger = logging.getLogger(__name__)

#: 单次提炼的条数上限
MAX_ITEMS = 3

#: 单条记忆的内容长度上限
MAX_CONTENT_CHARS = 400

#: 判定"重复"的相关度阈值（超过则合并到已有条目）
DEDUP_THRESHOLD = 0.82

SYSTEM_PROMPT = """你是一个记忆提炼器。阅读一次 Agent 执行记录，提炼出**值得长期记住**的内容。

只提炼这四类：
- fact：关于用户、环境、项目的稳定事实（如"用户在上海"、"项目用 uv 管理依赖"）
- preference：用户偏好（如"偏好中文回复"、"不要 emoji"）
- instruction：用户提出的长期要求
- summary：本次任务得出的可复用结论

**不要提炼**：
- 一次性的任务过程、工具调用的中间结果、报错堆栈
- 通用常识、模型自己知道的背景知识
- 临时的、会很快过时的状态

输出**严格的 JSON 数组**（不要 markdown 代码块），每项形如：
{"kind": "fact", "content": "……"}

最多 3 条。如果没有任何值得记住的内容，输出 []。"""


@dataclass
class Candidate:
    kind: str
    content: str


def _truncate(text: str, limit: int = MAX_CONTENT_CHARS) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def parse_candidates(raw: str) -> list[Candidate]:
    """从模型输出里解析候选（容错：剥离代码块、容忍前后杂质）。"""
    if not raw:
        return []
    text = raw.strip()
    # 剥掉 ```json ... ``` 包装
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    # 取第一个 [ ... ] 片段
    start, end = text.find("["), text.rfind("]")
    if start >= 0 and end > start:
        text = text[start : end + 1]

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        logger.debug("提炼结果不是合法 JSON: %s", raw[:200])
        return []
    if not isinstance(data, list):
        return []

    out: list[Candidate] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        content = _truncate(str(item.get("content") or ""))
        if not content:
            continue
        kind = str(item.get("kind") or "fact")
        if kind not in {"fact", "preference", "instruction", "summary"}:
            kind = "fact"
        out.append(Candidate(kind=kind, content=content))
    return out[:MAX_ITEMS]


def build_user_prompt(run_input: Any, run_output: Any, turns: list[tuple[str, str]] | None = None) -> str:
    """拼装提炼请求的正文。``turns`` 为多轮会话时的完整对话。"""
    parts: list[str] = []
    if turns:
        convo = "\n".join(f"{role}: {text}" for role, text in turns[-8:])
        parts.append(f"对话记录：\n{convo}")
    else:
        parts.append(f"用户输入：\n{json.dumps(run_input, ensure_ascii=False)[:2000]}")
        out_text = ""
        if isinstance(run_output, dict):
            out_text = str(run_output.get("content") or "")
        else:
            out_text = str(run_output or "")
        parts.append(f"Agent 输出：\n{out_text[:4000]}")
    return "\n\n".join(p for p in parts if p.strip())


async def call_llm(
    *,
    base_url: str,
    api_key: str,
    model: str,
    user_prompt: str,
    timeout: float = 60.0,
    system_prompt: str | None = None,
) -> str:
    """调用 OpenAI 兼容接口做一次轻量调用（不进 Agent 循环）。

    ``system_prompt`` 默认是**记忆提炼**那套（输出 JSON 候选）。别的用途
    （比如会话压缩要一段散文摘要）必须显式传自己的 —— 复用提炼的 prompt
    会让模型回一堆 JSON 候选，甚至什么都回不出来，而空结果会被上层当成
    "没什么可压缩"丢掉（症状：设了阈值却看不到任何摘要）。
    """
    url = base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt or SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            url,
            json=payload,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        )
        resp.raise_for_status()
        data = resp.json()
    choices = data.get("choices") or []
    if not choices:
        return ""
    return str((choices[0].get("message") or {}).get("content") or "")


async def dedupe(
    session: AsyncSession, agent_id: str | None, candidates: list[Candidate]
) -> tuple[list[Candidate], list[dict[str, Any]]]:
    """去重：与已有记忆比对，高分则跳过并说明（交由调用方决定合并策略）。

    返回 ``(保留的候选, 被跳过的说明)``。
    """
    stmt = select(Memory).where(Memory.status.in_(("active", "candidate")))
    if agent_id:
        stmt = stmt.where((Memory.agent_id == agent_id) | (Memory.scope == "global"))
    existing = list((await session.execute(stmt)).scalars().all())

    kept: list[Candidate] = []
    skipped: list[dict[str, Any]] = []
    seen: list[str] = []

    for c in candidates:
        dup_of: str | None = None
        for e in existing:
            # 双向打分：新内容 vs 旧内容（避免长文本单边占优）
            s = max(keyword_score(e.content, c.content), keyword_score(c.content, e.content))
            if s >= DEDUP_THRESHOLD:
                dup_of = e.id
                break
        # 同批内也去重
        if dup_of is None:
            for prev in seen:
                s = max(keyword_score(prev, c.content), keyword_score(c.content, prev))
                if s >= DEDUP_THRESHOLD:
                    dup_of = "同批重复"
                    break
        if dup_of:
            skipped.append({"content": c.content, "reason": f"与已有记忆高度相似（{dup_of}）"})
            continue
        seen.append(c.content)
        kept.append(c)

    return kept[:MAX_ITEMS], skipped
