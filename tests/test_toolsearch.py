"""toolsearch 检索引擎的单元测试（BM25 稀疏路 / RRF 融合 / 预处理 / 缓存）。

为什么值得单独测：tool_search 是懒加载工具的**唯一入口**——检索排序错了
模型拿到的就是错工具（失败方式同样很"安静"）。核心断言：
- 标识符拆词后 camelCase/snake_case 能被单词 query 命中（旧子串实现做不到）
- IDF 把人人都有的词压下去、罕见词抬上来
- RRF 融合：两路都认可 > 单路头名；单路命中保留"半票"
- 稠密路失败时纯稀疏照常工作（增强不是依赖）
"""

from __future__ import annotations

from agent_studio.toolsearch import (
    DenseIndex,
    LruCache,
    SparseIndex,
    cache_key,
    index_text,
    looks_like_id_only,
    rrf_fuse,
    split_identifier,
    tokenize,
    weak_signal_hint,
)


# --------------------------------------------------------------------------- #
# 预处理
# --------------------------------------------------------------------------- #


def test_split_identifier_camel_and_snake():
    assert split_identifier("modifyInstanceSpec") == "modify instance spec"
    assert split_identifier("job_create") == "job create"
    assert split_identifier("tool-search") == "tool search"


def test_index_text_includes_top_level_params_only():
    schema = {
        "type": "object",
        "properties": {
            "instance_id": {"type": "string"},
            "nested": {"type": "object", "properties": {"deep": {"type": "string"}}},
        },
    }
    text = index_text("RunInstance", "启动一台实例", schema)
    assert "run instance" in text
    assert "启动一台实例" in text
    assert "instance id" in text
    # 只取顶层参数名，嵌套的不进来
    assert "deep" not in text


def test_tokenize_chinese_bigram():
    toks = tokenize("定时任务")
    assert "定时" in toks and "任务" in toks


# --------------------------------------------------------------------------- #
# 稀疏路
# --------------------------------------------------------------------------- #


def _sample_docs() -> dict[str, str]:
    return {
        "job_create": index_text("job_create", "在这个会话上排一个定时任务", {"properties": {"cron": {}}}),
        "proc_start": index_text("proc_start", "在后台起一个长任务进程", {"properties": {"cmd": {}}}),
        "browser_open": index_text("browser_open", "打开一个网页", {"properties": {"url": {}}}),
        "memory_save": index_text("memory_save", "保存一条长期记忆", {"properties": {"content": {}}}),
        "memory_search": index_text("memory_search", "按关键词搜索记忆", {"properties": {"query": {}}}),
    }


def test_sparse_finds_by_identifier_word():
    idx = SparseIndex(_sample_docs())
    # 旧子串实现：query "schedule" 匹配不到任何东西；现在 cron 不是 ——
    # 换个真实场景：query 用 "任务" 应命中两个任务类工具
    ranked = idx.search("定时 任务")
    assert ranked[0] == "job_create"
    assert "proc_start" in ranked[:3]


def test_sparse_idf_pushes_rare_words_up():
    idx = SparseIndex(_sample_docs())
    # "记忆" 只出现在 memory_* 两个工具里（罕见词），应排最前
    ranked = idx.search("搜索 记忆")
    assert ranked[0] == "memory_search"


def test_sparse_chinese_paraphrase_misses_but_bigram_partial_hits():
    idx = SparseIndex(_sample_docs())
    # 纯换说法（"闹钟"）词面零重叠 —— 稀疏路就该空，这正是稠密路存在的理由
    assert idx.search("闹钟") == []


# --------------------------------------------------------------------------- #
# RRF 融合
# --------------------------------------------------------------------------- #


def test_rrf_two_path_agreement_wins():
    fused = rrf_fuse([["a", "b", "c"], ["b", "a", "d"]], k=20, top_k=4)
    # a 两路都是 rank1（2×1/21）；b 是 rank2+rank1（1/22+1/21）—— a 总分更高
    assert fused[0] == "a"
    # b 紧随其后且高于只出现一路的 c/d
    assert fused[1] == "b"
    assert set(fused[:2]) == {"a", "b"}


def test_rrf_single_path_hit_kept():
    fused = rrf_fuse([["x"]], k=20, top_k=5)
    assert fused == ["x"]  # 只有一路也能工作（稠密路失败降级的形态）


def test_rrf_order_independent_of_raw_scores():
    # 名次相同、两路互换 —— 分数完全一样（量纲无关性的直接检验）
    s1 = rrf_fuse([["a", "b"], ["a", "b"]], top_k=2)
    s2 = rrf_fuse([["b", "a"], ["b", "a"]], top_k=2)
    assert s1 == ["a", "b"] and s2 == ["b", "a"]


# --------------------------------------------------------------------------- #
# 稠密路：暴力余弦 + 失败降级
# --------------------------------------------------------------------------- #


def _vec(base: list[float], noise: float = 0.0) -> list[float]:
    return [v + noise for v in base]


async def test_dense_search_and_threshold():
    d = DenseIndex()
    docs = {"a_tool": "t1", "b_tool": "t2"}

    async def _embed(texts: list[str]):
        return [[1.0, 0.0], [0.0, 1.0]]

    ok = await d.ensure(docs, _embed, "fp1")
    assert ok and d.ready
    ranked = d.search(_vec([0.9, 0.1]), top_l=5)
    assert ranked[0] == "a_tool"


def test_dense_embed_failure_degrades():
    d = DenseIndex()

    async def _boom(_texts):
        raise RuntimeError("endpoint down")

    import asyncio

    assert not asyncio.run(d.ensure({"a": "t"}, _boom, "fp"))
    assert d.search([1.0, 0.0]) == []  # 失败后 search 返回空，不抛


# --------------------------------------------------------------------------- #
# LRU 缓存与缓存键
# --------------------------------------------------------------------------- #


def test_lru_evicts_oldest():
    c = LruCache(capacity=2)
    c.put("k1", 1)
    c.put("k2", 2)
    c.put("k3", 3)
    assert c.get("k1") is None and c.get("k3") == 3


def test_cache_key_normalizes_whitespace_and_case():
    assert cache_key("搜索  工具 ", "fp", 8) == cache_key("搜索 工具", "fp", 8)
    assert cache_key("a", "fp1", 8) != cache_key("a", "fp2", 8)


# --------------------------------------------------------------------------- #
# ID-only 检测
# --------------------------------------------------------------------------- #


def test_id_only_detection():
    assert looks_like_id_only("tl_8f3ac2")
    assert looks_like_id_only("i-bp1abcdef123")
    assert not looks_like_id_only("查找定时任务工具")
    assert not looks_like_id_only("帮我看看这个实例的状态")


def test_weak_signal_hint_mentions_intent():
    hint = weak_signal_hint("tl_8f3ac2")
    assert "tool_search" in hint and "tool_describe" in hint
