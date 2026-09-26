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


def cost_of(
    model: str | None, tokens_in: int, tokens_out: int, prices: dict[str, ModelPrice]
) -> float | None:
    """算这一次调用的钱。没有单价 → ``None``（不是 0）。"""
    p = prices.get(price_key(model))
    if p is None:
        return None
    total = (tokens_in or 0) * float(p.in_per_mtok or 0) + (tokens_out or 0) * float(
        p.out_per_mtok or 0
    )
    return round(total / PER_TOKENS, 6)
