"""路由接口：某个助手「收哪些话」的增删改查 + 试算（给一段话看会交给谁、为什么）。

为什么要一个 preview：规则是正则/关键词写的，人写的时候心里想的是"这样写就一定
会分给它"，但真实的话不会照着你写的样子说。能先试一句，才敢把规则留在那儿。
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import router as intent
from ..db import get_session
from ..models import Agent, RouteRule, now_ms

router = APIRouter(prefix="/api/routes", tags=["routes"])


class RuleIn(BaseModel):
    agent_id: str
    pattern: str = Field(min_length=1, max_length=160)
    kind: str = Field(default="keyword", pattern="^(keyword|regex)$")
    priority: int = Field(default=100, ge=0, le=9999)
    note: str | None = Field(default=None, max_length=200)


class RulePatch(BaseModel):
    pattern: str | None = Field(default=None, min_length=1, max_length=160)
    kind: str | None = Field(default=None, pattern="^(keyword|regex)$")
    priority: int | None = Field(default=None, ge=0, le=9999)
    enabled: bool | None = None
    note: str | None = Field(default=None, max_length=200)


class PreviewIn(BaseModel):
    text: str = Field(min_length=1, max_length=8000)
    agent_id: str | None = None
    default_agent_id: str | None = None


def _check_pattern(kind: str, pattern: str) -> str:
    p = (pattern or "").strip()
    if not p:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "规则不能是空的")
    if kind == "regex":
        # 用与运行时**同一个引擎**校验：标准库 re 能编译的，运行时（regex）也可能不接受
        try:
            if intent._regex_mod is not None:
                intent._regex_mod.compile(p)
            else:
                re.compile(p)
        except Exception as exc:  # noqa: BLE001
            # 让错误在写入时就暴露：存下去的正则永远匹配不上，等于悄悄没生效
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, f"正则写错了：{exc}"
            ) from exc
        # 灾难回溯自检：拿一段最坏输入试一下，超时就不许存（一句用户输入能把服务钉死）
        if intent._regex_mod is not None:
            try:
                intent._regex_mod.search(p, "a" * 64 + "b", timeout=0.05)
            except TimeoutError as exc:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT,
                    "这条正则回溯太慢（几十秒级别），会卡住整台服务；请改得更具体些",
                ) from exc
            except Exception:  # noqa: BLE001
                pass
    elif len(p) < 2:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "关键词至少 2 个字（1 个字几乎句句都命中）"
        )
    elif any(sep in p for sep in ("，", ",", "；", ";", "、", "\n")):
        # 一条规则里塞多个词 = 永远命不中（整串当子串比）。界面上是逗号分隔多条，
        # 接口直调的人容易踩这个坑，所以这里直接拦住并说清怎么办。
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "一条规则只能写一个词；要写多个请分多条添加（界面里用逗号分隔会自动拆开）",
        )
    return p


def _to_read(r: RouteRule) -> dict[str, Any]:
    return {
        "id": r.id,
        "agent_id": r.agent_id,
        "kind": r.kind,
        "pattern": r.pattern,
        "priority": r.priority,
        "enabled": bool(r.enabled),
        "note": r.note,
        "updated_at": r.updated_at,
    }


def _candidates(agents: list[Agent]) -> list[intent.Candidate]:
    """候选 = 名字 + 描述 + 能力标签（技能名 / 工具名）。

    为什么把工具名当标签：用户说"帮我跑段代码"，能不能接这句话，很大程度取决于
    这位助手有没有 bash —— 这比描述里写了什么更实在。
    """
    out: list[intent.Candidate] = []
    for a in agents:
        d = a.definition or {}
        tags: list[str] = []
        for s in d.get("skills") or []:
            if isinstance(s, dict) and s.get("name"):
                tags.append(str(s["name"]))
        for t in d.get("tools") or []:
            if isinstance(t, dict):
                name = t.get("name") or t.get("ref")
                if name:
                    tags.append(str(name).split(".")[-1])
        out.append(
            intent.Candidate(
                agent_id=a.id,
                name=a.name,
                description=a.description or "",
                tags=tuple(tags[:20]),
            )
        )
    return out


@router.get("", response_model=dict)
async def list_rules(
    agent_id: str | None = Query(None),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    stmt = select(RouteRule)
    if agent_id:
        stmt = stmt.where(RouteRule.agent_id == agent_id)
    rows = list((await session.execute(stmt.order_by(RouteRule.priority, RouteRule.pattern))).scalars())
    return {"items": [_to_read(r) for r in rows], "total": len(rows)}


@router.post("", response_model=dict, status_code=status.HTTP_201_CREATED)
async def add_rule(body: RuleIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    agent = await session.get(Agent, body.agent_id)
    if agent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "助手不存在")
    pattern = _check_pattern(body.kind, body.pattern)
    # 查重不看大小写：关键词匹配本来就是忽略大小写的，Weekly 和 weekly 存两条
    # 只会让"其他候选"里出现同一个助手两次。
    dup = (
        await session.execute(select(RouteRule).where(RouteRule.agent_id == body.agent_id))
    ).scalars().all()
    dup = next((r for r in dup if (r.pattern or "").casefold() == pattern.casefold()), None)
    if dup:
        # 重复添加不是错误，是"我改一下这条"—— 直接把新参数盖上去
        dup.kind = body.kind
        dup.priority = body.priority
        dup.note = body.note
        dup.enabled = True
        dup.updated_at = now_ms()
        await session.commit()
        await session.refresh(dup)
        return _to_read(dup)
    row = RouteRule(
        agent_id=body.agent_id,
        kind=body.kind,
        pattern=pattern,
        priority=body.priority,
        note=body.note,
    )
    session.add(row)
    try:
        await session.commit()
    except IntegrityError:
        # 两个人同时点「添加」会撞唯一键。这不是错误，是"这条已经在了" ——
        # 我实测并发 6 次时其中一次 500，用户看到的是红字报错。
        await session.rollback()
        again = (
            await session.execute(
                select(RouteRule).where(
                    RouteRule.agent_id == body.agent_id, RouteRule.pattern == pattern
                )
            )
        ).scalars().first()
        if again is not None:
            return _to_read(again)
        raise
    await session.refresh(row)
    return _to_read(row)


@router.patch("/{rule_id}", response_model=dict)
async def patch_rule(
    rule_id: str, body: RulePatch, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    row = await session.get(RouteRule, rule_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "规则不存在")
    if body.kind is not None:
        _check_pattern(body.kind, body.pattern or row.pattern)
        row.kind = body.kind
    if body.pattern is not None:
        row.pattern = _check_pattern(body.kind or row.kind, body.pattern)
    if body.priority is not None:
        row.priority = body.priority
    if body.enabled is not None:
        row.enabled = body.enabled
    if body.note is not None:
        row.note = body.note
    row.updated_at = now_ms()
    await session.commit()
    await session.refresh(row)
    return _to_read(row)


@router.delete("/{rule_id}", response_model=dict)
async def remove_rule(rule_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    row = await session.get(RouteRule, rule_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "规则不存在")
    await session.execute(delete(RouteRule).where(RouteRule.id == rule_id))
    await session.commit()
    return {"deleted": rule_id}


@router.post("/preview", response_model=dict)
async def preview(body: PreviewIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """给一句话，看会交给谁、走了哪一层、分数怎么来的。"""
    agents = list((await session.execute(select(Agent))).scalars())
    if body.agent_id and all(a.id != body.agent_id for a in agents):
        # 指名一个不存在的助手，回来却是 "explicit/你指名的" —— 上层据此建执行会直接失败
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "指名的助手不存在")
    rules = [
        intent.Rule(
            agent_id=r.agent_id, pattern=r.pattern, kind=r.kind, priority=r.priority
        )
        for r in (
            await session.execute(select(RouteRule).where(RouteRule.enabled.is_(True)))
        ).scalars()
    ]
    d = intent.route(
        body.text,
        candidates=_candidates(agents),
        rules=rules,
        explicit_agent_id=body.agent_id,
        default_agent_id=body.default_agent_id,
    )
    names = {a.id: a.name for a in agents}
    out = d.as_dict()
    out["agent_name"] = names.get(d.agent_id or "")
    for alt in out["alternatives"]:
        alt["name"] = names.get(str(alt.get("agent_id")), alt.get("name") or "")
    return out
