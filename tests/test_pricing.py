"""护栏：算钱这件事的三个「必须」—— 键名两套都认、没单价不给 0、单价键归一。

背景（血泪）：记录页的 Tokens 列曾经**整列显示「—」**，而库里的 token 数据一直都在。
根因就是取 token 时只认了 provider 的键名（``prompt_tokens``/``completion_tokens``），
而平台自己的 MetricsCollector 写的是 ``tokens_in``/``tokens_out`` —— 一个都取不到。
这个断言就是钉死这条口径，以后谁再"顺手改一下键名"都会红。
"""

from __future__ import annotations

from agent_studio.models import ModelPrice
from agent_studio.pricing import cost_of, price_key, tokens_of


def _price(model: str, tin: float, tout: float) -> ModelPrice:
    return ModelPrice(model=model, in_per_mtok=tin, out_per_mtok=tout)


# ── 取 token：两套键名都要认 ────────────────────────────────────────────────
def test_tokens_of_reads_platform_keys():
    """平台自己的 metrics 写的是 tokens_in / tokens_out —— 这条路必须通。"""
    assert tokens_of({"tokens_in": 3695, "tokens_out": 172}) == (3695, 172)


def test_tokens_of_reads_provider_keys():
    """各家 provider 的原始 usage 写的是 prompt/completion_tokens —— 也要认。"""
    assert tokens_of({"prompt_tokens": 100, "completion_tokens": 20}) == (100, 20)
    assert tokens_of({"input_tokens": 7, "output_tokens": 3}) == (7, 3)


def test_tokens_of_prefers_platform_keys_and_never_crashes():
    both = {"tokens_in": 10, "tokens_out": 5, "prompt_tokens": 999}
    assert tokens_of(both) == (10, 5), "两套都在时以平台自己采的为准"
    assert tokens_of({}) == (0, 0)
    assert tokens_of(None) == (0, 0)
    assert tokens_of({"tokens_in": None, "tokens_out": "12"}) == (0, 12)


# ── 算钱：没单价是 None，不是 0 ─────────────────────────────────────────────
def test_cost_is_none_without_price():
    """**这条是产品口径**：没填单价 → None（界面显示「—」）。
    返回 0 会让用户以为"这些调用免费" —— 那比不显示更糟。"""
    assert cost_of("gpt-whatever", 1_000_000, 1_000_000, {}) is None


def test_cost_matches_per_million_definition():
    prices = {price_key("DeepSeek-V4-Flash"): _price("DeepSeek-V4-Flash", 1.0, 2.0)}
    # 1M 输入 + 1M 输出，单价 1 / 2（每百万）→ 3 元
    assert cost_of("deepseek-v4-flash", 1_000_000, 1_000_000, prices) == 3.0
    # 零用量也要算出 0.0（**区别于 None**：这是"有单价、确实没花钱"）
    assert cost_of("deepseek-v4-flash", 0, 0, prices) == 0.0


def test_price_key_normalises_case_and_space():
    """大小写/空格不该让单价"找不到"（同一个模型只应有一条单价）。"""
    assert price_key("  DeepSeek-V4-Flash ") == "deepseek-v4-flash"
    assert price_key(None) == ""
    prices = {price_key("deepseek-v4-flash"): _price("deepseek-v4-flash", 1.0, 2.0)}
    assert cost_of("DEEPSEEK-V4-FLASH", 0, 1_000_000, prices) == 2.0
    assert cost_of(" deepseek-v4-flash", 1_000_000, 0, prices) == 1.0
