"""单价（用量 → 金额）/api/prices

产品上要回答的问题是「**这个月花了多少钱、花在哪个模型上**」。数据早就有了
（每次调用都记了 token），缺的只有「单价」这一项 —— 而单价只能用户填。
所以这个路由只做三件事：把**用过的模型列出来**、让用户填两个数、把它存下来。

刻意不做的事：内置一份"官方价目表"。价格会变、有折扣、有汇率，
内置就是给用户一个会过期的数字 —— 那比不显示更糟。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Agent, LlmCall, ModelPrice, ModelTest, now_ms
from ..pricing import DEFAULT_CURRENCY, load_prices, price_key
from ..settings_store import get_setting, set_setting

router = APIRouter(prefix="/api/prices", tags=["prices"])


class PriceRow(BaseModel):
    model: str
    in_per_mtok: float = 0.0
    out_per_mtok: float = 0.0


class PriceBookIn(BaseModel):
    """整本单价一次提交（界面上就是一张表，一行一个模型）。"""

    currency: str | None = None
    items: list[PriceRow] = Field(default_factory=list)


async def _known_models(session: AsyncSession) -> list[dict[str, Any]]:
    """「用过的模型」清单：**谁真的花过钱**要看得见，用户才知道该填哪几个。

    来源三处（合并去重）：裸模型调用（llm_call）、LLM 测试（model_test）、
    助手定义里的模型（agent.definition.model.name）。
    顺带把已消耗的 token 带上 —— 填单价时最想知道"这个模型我用了多少"。
    """
    agg: dict[str, dict[str, Any]] = {}

    def bump(model: str | None, tin: int = 0, tout: int = 0, calls: int = 1) -> None:
        k = price_key(model)
        if not k:
            return
        row = agg.setdefault(k, {"model": (model or "").strip(), "calls": 0, "tokens_in": 0, "tokens_out": 0})
        row["calls"] += calls
        row["tokens_in"] += int(tin or 0)
        row["tokens_out"] += int(tout or 0)

    for model, tin, tout, n in (
        await session.execute(
            select(
                LlmCall.model,
                func.coalesce(func.sum(LlmCall.tokens_in), 0),
                func.coalesce(func.sum(LlmCall.tokens_out), 0),
                func.count(),
            ).group_by(LlmCall.model)
        )
    ).all():
        bump(model, tin, tout, n)

    for model, tin, tout, n in (
        await session.execute(
            select(
                ModelTest.model,
                func.coalesce(func.sum(ModelTest.tokens_in), 0),
                func.coalesce(func.sum(ModelTest.tokens_out), 0),
                func.count(),
            ).group_by(ModelTest.model)
        )
    ).all():
        bump(model, tin, tout, n)

    # 助手定义里配着的模型（还没跑过也算"用过的" —— 它随时会花钱）
    for (definition,) in (await session.execute(select(Agent.definition))).all():
        model = ((definition or {}).get("model") or {}).get("name")
        if model:
            bump(model, calls=0)

    return sorted(agg.values(), key=lambda r: (-r["tokens_in"] - r["tokens_out"], r["model"]))


@router.get("", response_model=dict)
async def read_prices(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """单价本 + 用过的模型清单（界面一张表把两者对齐）。"""
    prices = await load_prices(session)
    currency = str(await get_setting(session, "price_currency", DEFAULT_CURRENCY) or DEFAULT_CURRENCY)
    known = await _known_models(session)
    by_key = {k: v for k, v in prices.items()}
    items = []
    for row in known:
        p = by_key.pop(price_key(row["model"]), None)
        items.append(
            {
                **row,
                "in_per_mtok": float(p.in_per_mtok) if p else 0.0,
                "out_per_mtok": float(p.out_per_mtok) if p else 0.0,
                #: 填过单价没有 —— 决定界面显示「¥x」还是「—」
                "priced": p is not None,
            }
        )
    # 填过但已经不在"用过"清单里的（比如换过模型）也带回来，别让用户以为丢了
    for p in by_key.values():
        items.append(
            {
                "model": p.model,
                "calls": 0,
                "tokens_in": 0,
                "tokens_out": 0,
                "in_per_mtok": float(p.in_per_mtok or 0),
                "out_per_mtok": float(p.out_per_mtok or 0),
                "priced": True,
            }
        )
    return {
        "currency": currency,
        "items": items,
        #: 用过但**没填单价**的模型 —— 界面据此提示"这些还不会算钱"
        "unpriced": [r["model"] for r in items if not r["priced"] and (r["tokens_in"] or r["tokens_out"])],
    }


@router.put("", response_model=dict)
async def write_prices(
    payload: PriceBookIn, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """整本覆盖式保存（界面上就是"填完点保存"）。

    两个数都填 0（或都留空）= **取消这个模型的单价** —— 删掉它，回到"不算钱"，
    而不是留下一行 0/0 让人以为"这个模型免费"。
    """
    if payload.currency:
        await set_setting(session, "price_currency", payload.currency.strip()[:8] or DEFAULT_CURRENCY)

    existing = await load_prices(session)
    saved = 0
    cleared = 0
    for row in payload.items:
        k = price_key(row.model)
        if not k:
            continue
        tin, tout = float(row.in_per_mtok or 0), float(row.out_per_mtok or 0)
        cur = existing.get(k)
        if tin <= 0 and tout <= 0:
            if cur is not None:
                await session.delete(cur)
                cleared += 1
            continue
        if cur is None:
            session.add(
                ModelPrice(model=row.model.strip(), in_per_mtok=tin, out_per_mtok=tout, updated_at=now_ms())
            )
        else:
            cur.in_per_mtok = tin
            cur.out_per_mtok = tout
            cur.updated_at = now_ms()
        saved += 1
    await session.commit()
    return {"saved": saved, "cleared": cleared}


@router.delete("/{model}", response_model=dict)
async def delete_price(model: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    row = (
        await session.execute(select(ModelPrice).where(ModelPrice.model == model))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"没有这个模型的单价: {model}")
    await session.delete(row)
    await session.commit()
    return {"deleted": 1, "model": model}
