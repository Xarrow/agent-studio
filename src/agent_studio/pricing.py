"""用量 → 金额。

为什么单独一个模块
------------------
算钱需要**单价**，而单价只能由用户填：各家的价格、折扣、汇率都不一样，平台内置一份
价目表只会**很快过期**，还会给人"它算的数是对的"的错觉。所以这里只做两件事：
  ① 从库里读单价（``model_price`` 表，按模型名索引）
  ② 把一份用量算成钱

口径（写死在注释里，免得以后有人猜）
------------------------------------
* 单价单位 = 每 **100 万 token** 的金额 —— 与各家官网报价同一量纲，好抄好核对。
* 金额 = 输入 token × 输入单价 + 输出 token × 输出单价
* **缓存命中的 read token 也按输入单价计**：我们没有单独的缓存价字段，
  这样算出来偏保守 —— 宁可略高估，也不给一个"看起来更便宜"的假象。
* 没填单价的模型 → ``None``（界面显示「—」），**绝不假装 0 元**：
  「这是免费的」和「我不知道多少钱」是两件事，混在一起就没人敢信这张表了。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import ModelPrice

#: 单价的量纲：每百万 token
PER_TOKENS = 1_000_000

#: 默认币种（界面上可改；平台只做**一个**币种，多币种会让合计失去意义）
DEFAULT_CURRENCY = "¥"


def price_key(model: str | None) -> str:
    """单价表的键：模型名小写去空格（大小写/空格不该让单价"找不到"）。"""
    return (model or "").strip().lower()


def tokens_of(usage: dict[str, Any] | None) -> tuple[int, int]:
    """从一份 usage 里取 (输入 token, 输出 token)。

    ⚠️ **键名有两套，都要认**（这里踩过一次，害得记录页 Tokens 列全是「—」）：
      · 平台自己的 ``MetricsCollector`` 写的是 ``tokens_in`` / ``tokens_out``
      · 各家 provider 的原始 usage 写的是 ``prompt_tokens`` / ``completion_tokens``
    只认后者 → 平台自己采的数一个都取不到，界面上永远显示空。
    """
    u = usage or {}
    if not isinstance(u, dict):
        return 0, 0
    tin = u.get("tokens_in", u.get("prompt_tokens", u.get("input_tokens")))
    tout = u.get("tokens_out", u.get("completion_tokens", u.get("output_tokens")))
    return int(tin or 0), int(tout or 0)


async def load_prices(session: AsyncSession) -> dict[str, ModelPrice]:
    """一次读全部单价，按 ``price_key(model)`` 索引（调用方在请求内复用，别循环里读库）。"""
    rows = (await session.execute(select(ModelPrice))).scalars().all()
    return {price_key(r.model): r for r in rows}


async def currency_of(session: AsyncSession) -> str:
    """当前币种（用户没设过就是 ¥）。"""
    from .settings_store import get_setting

    cur = await get_setting(session, "price_currency", DEFAULT_CURRENCY)
    return str(cur or DEFAULT_CURRENCY)


def match_price(model: str | None, prices: dict[str, ModelPrice]) -> ModelPrice | None:
    """按模型名找单价：先精确，再**模糊**（最长命中优先）。

    为什么必须模糊：真实模型名带版本尾巴（``deepseek-v4-flash``、
    ``gpt-4o-mini-2024``），而用户只愿意填一条 ``deepseek-v4``。
    以前只做精确匹配 → 一条都对不上 → 算不出钱 → 花费上限永远不触发（实测踩到）。
    """
    key = price_key(model)
    if not key:
        return None
    hit = prices.get(key)
    if hit is not None:
        return hit
    best: tuple[int, ModelPrice] | None = None
    for candidate, row in prices.items():
        if candidate and candidate in key:
            if best is None or len(candidate) > best[0]:
                best = (len(candidate), row)
    return best[1] if best else None


def cost_of(
    model: str | None, tokens_in: int, tokens_out: int, prices: dict[str, ModelPrice]
) -> float | None:
    """算这一次调用的钱。没有单价 → ``None``（不是 0）。"""
    p = match_price(model, prices)
    if p is None:
        return None
    total = (tokens_in or 0) * float(p.in_per_mtok or 0) + (tokens_out or 0) * float(
        p.out_per_mtok or 0
    )
    return round(total / PER_TOKENS, 6)


async def run_cost(session: AsyncSession, run_id: str) -> tuple[float | None, bool]:
    """这次执行到目前为止花了多少。

    返回 ``(金额, 是否完整)``：只要有一个模型没填单价，金额就只能是**下界** ——
    第二个返回值告诉调用方这件事，别把下界当成准数写进报告。
    一次查完（按模型汇总 token），不逐条查库。
    """
    from sqlalchemy import func

    from .models import LlmCall

    prices = await load_prices(session)
    rows = (
        await session.execute(
            select(
                LlmCall.model,
                func.sum(LlmCall.tokens_in),
                func.sum(LlmCall.tokens_out),
            )
            .where(LlmCall.run_id == run_id)
            .group_by(LlmCall.model)
        )
    ).all()
    total: float | None = 0.0
    complete = True
    for model, tin, tout in rows:
        c = cost_of(model, int(tin or 0), int(tout or 0), prices)
        if c is None:
            complete = False  # 没单价：这部分算不进去
            continue
        total = (total or 0.0) + c
    if not rows:
        return None, True
    return round(total or 0.0, 6), complete


#: 开箱可用的**参考价**（¥ / 百万 token）。用户可在「模型单价」里覆盖任意一条。
#: 为什么要有它：全新的库里 model_price 是空的 → 算不出钱 → 花费上限永远拦不住。
#: 这些只是量级正确的参考价（各家的实际折扣/汇率以账单为准），标注清楚就不算骗人。
DEFAULT_PRICES: dict[str, tuple[float, float]] = {
    "deepseek-v4": (2.0, 8.0),
    "deepseek-v3": (2.0, 8.0),
    "deepseek-r1": (4.0, 16.0),
    "deepseek": (2.0, 8.0),
    "doubao": (0.8, 2.0),
    "gpt-4o-mini": (1.1, 4.4),
    "gpt-4o": (18.0, 72.0),
    "gpt-4.1": (15.0, 60.0),
    "claude-sonnet": (22.0, 108.0),
    "claude-haiku": (5.8, 29.0),
    "claude": (22.0, 108.0),
    "qwen": (2.2, 8.8),
    "glm": (4.3, 16.0),
    "kimi": (4.3, 18.0),
}


async def ensure_default_prices(session: AsyncSession) -> int:
    """给**还没有单价**的参考模型补一条（已有的绝不覆盖 —— 用户填的价说了算）。"""
    existing = await load_prices(session)
    added = 0
    for model, (pin, pout) in DEFAULT_PRICES.items():
        if price_key(model) in existing:
            continue
        session.add(ModelPrice(model=price_key(model), in_per_mtok=pin, out_per_mtok=pout))
        added += 1
    if added:
        await session.commit()
    return added
