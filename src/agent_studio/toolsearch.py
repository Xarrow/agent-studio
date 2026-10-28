"""工具检索引擎：BM25 稀疏路 + 向量稠密路 + RRF 融合。

为什么单独成模块
----------------
``native_tools._tool_search`` 原来的打分是「子串命中计数」——没有词切分、
没有罕见词权重、没有长度归一，工具一多必然先塌。MCP Gateway（ATC 2026）
的 ToolSearch 给出的阶梯是：双路独立检索 → 并集 → RRF 按名次融合，
实测在 3616 个工具上 Recall@15 从纯稀疏的 67.7% 提到 98.2%。

本模块照抄它的机制，但保持**零新依赖**（与 recall.py 同一哲学）：

- 稀疏路：BM25-ish 打分（tokenize 来自 memory.recall 的同一套中英策略，
  这里独立实现以便带语料级 IDF —— 工具描述里"工具/参数/返回"这类词
  人人都有，必须压下去）
- 稠密路：调用方注入 embedding 函数（平台 llm 侧已有 httpx 客户端），
  暴力余弦 —— 库在几千个工具以内时 O(N) 扫一遍不到 5ms，不值得上 ANN
- 融合：RRF 只看名次不看原始分（余弦 0~1 和 BM25 0~几十量纲不兼容），
  谁也不偏废；任一路失败另一路照常工作

索引文本纪律（论文 §6.3 的隐性基础）：
    只索引 名字 + 描述 + 顶层参数名，不塞整个 input_schema；
    标识符（camelCase / snake_case / kebab-case）拆词后进索引。
"""

from __future__ import annotations

import math
import re
import time
from collections import OrderedDict
from typing import Any, Awaitable, Callable

# --------------------------------------------------------------------------- #
# 文本预处理：标识符拆词 + 分词（中英同策略：英文词 + 中文单字/bigram）
# --------------------------------------------------------------------------- #

_TOKEN_RE = re.compile(r"[a-zA-Z0-9_]+|[\u4e00-\u9fff]")
#: 标识符拆词：modifyInstanceSpec / job_create / tool-search → 空格分隔
_IDENT_SPLIT_RE = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|[_\-./]+")


def split_identifier(text: str) -> str:
    """camelCase / snake_case / kebab-case 拆成独立词（小写）。

    不拆的话 ``job_create`` 是一个整 token，query 里的 "create" 或 "job"
    单独出现时一个都匹配不上 —— 这是子串检索时代最大的隐性漏召回。
    """
    return _IDENT_SPLIT_RE.sub(" ", text).lower()


def tokenize(text: str) -> list[str]:
    """英文按词 + 中文单字再补 bigram（与 memory.recall.tokenize 同策略）。

    标识符（memory_search / tl_8f3ac2）先拆词再进 tokenizer —— 用户会拿
    工具名原样来搜，索引侧拆了 query 侧也得拆，两边才对得上；整段
    标识符本身也保留一枚 token，精确工具名命中权重最高。
    """
    raw = _TOKEN_RE.findall(_IDENT_SPLIT_RE.sub(" ", text.lower()))
    tokens: list[str] = list(raw)
    joined = text.strip().lower()
    if _IDENT_SPLIT_RE.search(joined):
        tokens.append(joined)
    for i in range(len(raw) - 1):
        a, b = raw[i], raw[i + 1]
        if len(a) == 1 and len(b) == 1 and "\u4e00" <= a <= "\u9fff":
            tokens.append(a + b)
    return tokens


def index_text(name: str, description: str, schema: dict[str, Any] | None) -> str:
    """工具的索引文本：名字 + 描述 + 顶层参数名（标识符拆词）。

    只取顶层参数名 —— 参数的嵌套 schema 对检索是噪声：既稀释 embedding
    的语义集中度，也让 BM25 的词频统计失真。
    """
    parts = [split_identifier(name or ""), description or ""]
    props = ((schema or {}).get("properties") or {}) if isinstance(schema, dict) else {}
    for key in list(props.keys())[:20]:  # 参数名上限：防个别巨型 schema 刷屏
        parts.append(split_identifier(str(key)))
    return " ".join(p for p in parts if p)


# --------------------------------------------------------------------------- #
# 稀疏路：带语料级 IDF 的 BM25-ish
# --------------------------------------------------------------------------- #


class SparseIndex:
    """对工具集合建一次倒排统计，query 时打 BM25-ish 分。

    与 memory.recall.keyword_score 的区别：这里有**真实语料级 IDF**
    （df 按工具全集统计），而不是"词长代理"——工具描述高度同质
    （"调用/工具/参数"人人都有），词长代理压不掉它们。
    """

    def __init__(self, docs: dict[str, str]) -> None:
        """docs: {工具名: 索引文本}。"""
        self._names = list(docs.keys())
        self._docs_tokens: dict[str, list[str]] = {}
        self._df: dict[str, int] = {}
        for name, text in docs.items():
            toks = tokenize(text)
            self._docs_tokens[name] = toks
            for t in set(toks):
                self._df[t] = self._df.get(t, 0) + 1
        self._n = max(1, len(self._names))
        self._avg_len = sum(len(t) for t in self._docs_tokens.values()) / self._n

    def search(self, query: str, top_l: int = 120) -> list[str]:
        """返回按相关度排序的工具名（最多 top_l 个）。"""
        q_tokens = set(tokenize(query))
        if not q_tokens:
            return []
        scored: list[tuple[float, str]] = []
        for name, toks in self._docs_tokens.items():
            if not toks:
                continue
            counts: dict[str, int] = {}
            for t in toks:
                counts[t] = counts.get(t, 0) + 1
            # BM25 双归一：文档长度 + (1-b) 基线
            len_norm = 1 - 0.75 + 0.75 * (len(toks) / (self._avg_len or 1.0))
            total = 0.0
            for term in q_tokens:
                tf = counts.get(term)
                if not tf:
                    continue
                df = self._df.get(term, 0)
                # Robertson/Sparck-Jones IDF，+1 保正
                idf = math.log((self._n - df + 0.5) / (df + 0.5) + 1.0)
                tf_sat = tf * 2.2 / (tf + 1.2 * len_norm)  # k1=1.2 的饱和项
                total += idf * tf_sat
            if total > 0:
                scored.append((total, name))
        scored.sort(key=lambda x: (-x[0], x[1]))
        return [name for _, name in scored[:top_l]]


# --------------------------------------------------------------------------- #
# 稠密路：注入式 embedding + 暴力余弦
# --------------------------------------------------------------------------- #

#: embed_fn 签名：传一批文本，回等长的向量列表（None=这一轮不可用）
EmbedFn = Callable[[list[str]], Awaitable[list[list[float]] | None]]


def _cosine(a: list[float], b: list[float]) -> float:
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0 or nb <= 0:
        return 0.0
    return dot / math.sqrt(na * nb)


class DenseIndex:
    """工具向量缓存 + 暴力余弦。

    向量在 ``ensure`` 时批量算好挂在本对象上；工具集变化由调用方重建。
    embed 失败（没配端点/网络挂）时 ``search`` 返回空 —— 稠密路是增强
    不是依赖，纯 BM25 路必须能独立工作（与 recall.py 的策略降级同思路）。
    """

    def __init__(self) -> None:
        self._vecs: dict[str, list[float]] = {}
        self._built_at: float = 0.0
        self._fingerprint: str = ""

    async def ensure(self, docs: dict[str, str], embed: EmbedFn, fingerprint: str) -> bool:
        """按需构建向量（fingerprint 变了才重算）。返回是否可用。"""
        if self._vecs and fingerprint == self._fingerprint:
            return True
        if not docs:
            return False
        try:
            vecs = await embed(list(docs.values()))
        except Exception:  # noqa: BLE001 —— embedding 不可用必须静默降级
            return False
        if not vecs or len(vecs) != len(docs):
            return False
        self._vecs = dict(zip(docs.keys(), vecs))
        self._fingerprint = fingerprint
        self._built_at = time.time()
        return True

    def search(self, query_vec: list[float] | None, top_l: int = 120) -> list[str]:
        if not query_vec or not self._vecs:
            return []
        scored = sorted(
            ((_cosine(query_vec, v), n) for n, v in self._vecs.items()),
            key=lambda x: (-x[0], x[1]),
        )
        return [n for s, n in scored[:top_l] if s > 0.05]  # 阈值滤掉完全不相关

    @property
    def ready(self) -> bool:
        return bool(self._vecs)


# --------------------------------------------------------------------------- #
# RRF 融合（论文公式：score(t) = Σ 1/(k + rank_i(t))，k=20）
# --------------------------------------------------------------------------- #


def rrf_fuse(ranked_lists: list[list[str]], k: int = 20, top_k: int = 15) -> list[str]:
    """多路名次融合。只出现一路的工具得"半票"——并集语义，精度靠
    「两路都认可」自然上浮；分数量纲无关（只看名次），零调参。"""
    scores: dict[str, float] = {}
    for path in ranked_lists:
        for rank, name in enumerate(path, start=1):
            scores[name] = scores.get(name, 0.0) + 1.0 / (k + rank)
    ranked = sorted(scores.keys(), key=lambda n: (-scores[n], n))
    return ranked[:top_k]


# --------------------------------------------------------------------------- #
# LRU 语义缓存：⟨query, 结果⟩ —— agent 一轮里常重搜同义 query
# --------------------------------------------------------------------------- #


class LruCache:
    """容量上限的 LRU（零依赖，OrderedDict 实现）。"""

    def __init__(self, capacity: int = 64) -> None:
        self._cap = capacity
        self._data: OrderedDict[str, Any] = OrderedDict()

    def get(self, key: str) -> Any | None:
        if key not in self._data:
            return None
        self._data.move_to_end(key)
        return self._data[key]

    def put(self, key: str, value: Any) -> None:
        self._data[key] = value
        self._data.move_to_end(key)
        while len(self._data) > self._cap:
            self._data.popitem(last=False)

    def clear(self) -> None:
        self._data.clear()


def cache_key(query: str, fingerprint: str, limit: int) -> str:
    """缓存键：query 归一 + 工具集指纹 + limit —— 工具集变了旧缓存自动失效。"""
    return f"{fingerprint}|{limit}|{' '.join(query.lower().split())}"


# --------------------------------------------------------------------------- #
# 弱语义 query 检测：ID-only 输入提示换语义重搜
# --------------------------------------------------------------------------- #

#: 平台常见 ID 形态：tl_xxxxxx / n_82958b / run_ab12 / i-bp1abcd...（纯标识符）。
#: 特征：要么是「短前缀 + 分隔符 + 乱码段」，要么整串就是一坨 hash ——
#: 关键判据是"不含空格的自然词"，而不是枚举具体字符集（ID 的字母表各家不一）。
_ID_ONLY_RE = re.compile(
    r"^[a-zA-Z]{1,6}[-_][0-9a-zA-Z_\-]*[0-9][0-9a-zA-Z_\-]*$"  # 前缀-ID：后半段须含数字（run_x2_id_123 / tl_8f3ac2），排除 web_search 这类"前缀_英文词"工具名
    r"|^[0-9a-f]{8,}$"                                          # 纯 hex hash
)


def looks_like_id_only(query: str) -> bool:
    """query 几乎只有一个 ID 时，两路检索都救不了（词面无可匹配实词、
    embedding 无语义信号）—— 调用方应返回引导提示而不是硬搜。"""
    text = query.strip()
    if not text or len(text.split()) > 3:
        return False
    return bool(_ID_ONLY_RE.match(text.replace(" ", "")))


def weak_signal_hint(query: str) -> str:
    return (
        f"查询「{query}」看起来只有一个 ID/标识符，缺少语义信号，难以匹配工具。"
        "请改用描述意图的说法重搜 tool_search（例如想查它属于哪类资源、想对它做什么），"
        "或直接用 tool_describe 浏览工具全集。"
    )
