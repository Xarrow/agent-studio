"""意图路由：这段话该交给哪个助手 —— 纯函数，不碰数据库。

为什么是纯函数
--------------
路由错了**不会报错**：话被交给了不合适的助手，它老老实实跑完，给出一个像模像样但
不对的结果。这种失败比崩了更难发现，所以判定必须单独可测、每一步都能解释。
数据库只提供"候选与规则"，判定本身在这里。

四层（越靠前越硬）
------------------
L0 显式指名   用户自己点了助手 / 调用方传了 agent_id —— 不猜。
L1 规则命中   助手自己的「收这些话」（关键词/正则）。规则是用户写的，命中就算数。
L2 内容打分   助手名 / 能力标签 / 描述在话里出现了多少。
L3 兜底       当前会话的助手；只有一个候选时也用它；都没有 → 交给用户选（不硬猜）。

打分刻意简单到能口算：名字 3 分、标签 2 分、描述 1 分、规则 10 分。
不用向量、不调模型 —— 前者解释不了"为什么是它"，后者每次路由都要花一次钱、还不可复现。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

try:  # 用户写的正则要能被打断 —— 标准库 re 回溯时无法中断，一句话就能把进程钉死
    import regex as _regex_mod
except ImportError:  # pragma: no cover - 没装时退回 re（并启用静态危险检测）
    _regex_mod = None

#: 这些字/词出现在任何描述里都不说明问题（否则"帮我"会把所有助手都算命中）
STOPWORDS = {
    "帮我", "可以", "使用", "支持", "进行", "通过", "以及", "或者", "如果", "然后",
    "一个", "这个", "那个", "我们", "你们", "他们", "自己", "需要", "能够", "负责",
    "助手", "个助手", "小助手", "agent", "assistant",
    "the", "and", "for", "with", "that", "this", "you", "are",
}

#: 分数（刻意简单到能口算）
W_NAME = 3   # 名字本体（去掉"助手/专家"这类尾巴）
W_TAG = 2    # 能力标签（技能名 / 工具名）/ 名字拆出来的两字词
W_CAP = 2    # 描述里的能力片段（"代码""测试"这种）
W_WORD = 1   # 描述里的英文词
#: 规则命中直接定局
W_RULE = 10

#: 到这个分就算"敢派"
HIGH_SCORE = 3

#: 单条正则的匹配预算（秒）。超了就当作"不命中" —— 宁可漏一次，不能把服务卡住。
REGEX_TIMEOUT = 0.02
#: 用户正则只在这么大的一段文本上跑（8000 字的输入配灾难回溯 = 一定超时）
REGEX_TEXT_CAP = 2000
#: 描述只当佐证：再多也只能贡献这么多分（不然一段长描述能把任何话都拉过来）
DESC_CAP = 4

#: 名字里的尾巴 —— "周报助手"该命中"周报"，而不是要求用户说出"周报助手"四个字
NAME_SUFFIX = ("小助手", "助手", "专家", "机器人", "agent", "bot", "服务")
#: 出现这些字的片段不算能力词（"帮我处理"这种片段到处都是，加它会糊掉整张成绩单）
STOPCHARS = set("的了把被我你他它一这下些这那和或与并就都还也很大太小多少吗呢啊吧么"
               "个给件们事时比更又再先后上中里让做用看说想会能要")


@dataclass(frozen=True)
class Candidate:
    """一个候选助手 —— 只管路由需要的字段，不传 ORM 行。"""

    agent_id: str
    name: str
    description: str = ""
    tags: tuple[str, ...] = ()


@dataclass(frozen=True)
class Rule:
    """一条「收这些话」。``kind="regex"`` 时 pattern 是正则，否则是关键词。"""

    agent_id: str
    pattern: str
    kind: str = "keyword"
    priority: int = 100


@dataclass
class Decision:
    agent_id: str | None
    layer: int
    score: int
    confidence: str
    reason: str
    alternatives: list[dict[str, Any]] = field(default_factory=list)
    #: 「这句话值得几个人一起干」的候选（≥2 位才填）。
    #: 和 ``alternatives`` 的区别：alternatives 是"也可以给谁"（二选一），
    #: multi 是"这几位都沾边、一起干更好"（扇出 + 汇总）。
    multi: list[dict[str, Any]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "agent_id": self.agent_id,
            "layer": self.layer,
            "score": self.score,
            "confidence": self.confidence,
            "reason": self.reason,
            "alternatives": self.alternatives,
            "multi": self.multi,
        }


def _norm(text: str) -> str:
    return (text or "").strip().lower()


def _unsafe_regex(pattern: str) -> bool:
    r"""没装 regex 时的兜底：挡掉嵌套量词这类经典灾难回溯（(a+)+、(\w+)* …）。

    做法：找到「组后面还跟着量词」的位置，再看组内是不是已经有量词 ——
    组内可重复 + 组外又重复 = 回溯指数增长。这不是完备判定，只是下限。
    """
    p = pattern or ""
    for i, ch in enumerate(p):
        if ch != ")" or i + 1 >= len(p) or p[i + 1] not in "*+{":
            continue
        depth = 0
        j = i - 1
        while j >= 0:
            if p[j] == ")":
                depth += 1
            elif p[j] == "(":
                if depth == 0:
                    break
                depth -= 1
            j -= 1
        if j < 0:
            continue
        if any(q in p[j + 1 : i] for q in "*+{"):
            return True
    return False


def _regex_search(pattern: str, text: str) -> bool:
    """跑一条用户正则。**绝不**让它把事件循环钉住。

    为什么这么小心：实测一条 `(a+)+$` 配 30 个 a，标准库 re 要跑几十秒，
    期间 FastAPI 的事件循环被占死 —— 后续所有请求（连别的接口）一起挂住。
    一句用户输入就能让整个平台停摆，这不是"性能问题"。
    """
    if not pattern:
        return False
    probe = text[:REGEX_TEXT_CAP]
    if _regex_mod is not None:
        try:
            return _regex_mod.search(pattern, probe, timeout=REGEX_TIMEOUT) is not None
        except TimeoutError:
            return False  # 太慢 = 当作不命中（记不了日志，但也不会卡）
        except _regex_mod.error:
            return False
    if _unsafe_regex(pattern):
        return False
    try:
        return re.search(pattern, probe, re.IGNORECASE) is not None
    except re.error:
        return False


def _hits(needle: str, haystack: str) -> bool:
    """命中判定：英文按词边界，中文按子串；中文再放宽一层（去掉虚词比一次）。

    中文没有空格，"财报"出现在"帮我看看这季度财报"里就是命中 —— 用子串。
    但人写规则是写"季度复盘"，嘴里说的是"这季**度**的复盘" —— 中间多一个"的"就
    命不中，用户会觉得"我明明写了"。所以子串失败后，把两侧的虚词都抹掉再比一次：
    "季度复盘" vs "这季度的复盘" → 抹掉"这/的"后都是"季度复盘" ✓

    英文不能这样（"go" 会命中 "google"），所以按词边界，且不做上面的放宽。
    """
    n = _norm(needle)
    h = _norm(haystack)
    if not n or not h:
        return False
    if re.search(r"[a-z0-9]", n):
        return re.search(rf"(?<![a-z0-9]){re.escape(n)}(?![a-z0-9])", h) is not None
    if n in h:
        return True
    # 抹掉虚词再试（虚词表故意短：只收"多一个就认不出"的那些）
    soft = set("的了吗呢吧啊呀和与及就都也很太更还又再这那我们你他它个些把被让给")
    cn = "".join(ch for ch in n if ch not in soft)
    ch = "".join(ch for ch in h if ch not in soft)
    return len(cn) >= 2 and cn in ch


def _name_words(name: str) -> list[tuple[str, int]]:
    """从名字里取「能代表它」的词 + 各自的权重。

    中文名字的尾巴（助手/专家）是通用后缀，不算信息：用户说"周报"就该命中"周报助手"，
    不该逼他说全名。英文名字反过来 —— 整词才准，拆了没意义。
    """
    out: list[tuple[str, int]] = []
    for part in re.split(r"[\s·/、,，\-—_]+", name or ""):
        part = part.strip()
        if len(part) < 2 or _norm(part) in STOPWORDS:
            continue
        core = part
        low = part.lower()
        for suf in NAME_SUFFIX:
            if low.endswith(suf) and len(part) > len(suf):
                core = part[: -len(suf)].strip()
                break
        if core and _norm(core) not in STOPWORDS:
            out.append((core, W_NAME))
        if core != part:
            out.append((part, W_NAME))          # 全名也算（写得越全越精确）
        # 长名字再拆两字词：「视频下载」→ 视频 / 下载
        if len(core) >= 4 and re.search(r"[\u4e00-\u9fa5]", core):
            for i in range(len(core) - 1):
                gram = core[i : i + 2]
                if gram not in STOPWORDS and not (set(gram) & STOPCHARS):
                    out.append((gram, W_TAG))
    # 去重保序（同一个词只加一次）
    seen: set[str] = set()
    uniq: list[tuple[str, int]] = []
    for w, wt in out:
        k = _norm(w)
        if k in seen:
            continue
        seen.add(k)
        uniq.append((w, wt))
    return uniq


def _cap_words(desc: str) -> list[str]:
    """描述里的能力片段：英文整词 + 中文 2~4 字片段（滤掉虚词碎片）。

    中文没有分词，用 n-gram 是最省的近似；代价是"帮我处理"这类碎片也会冒出来，
    所以带虚词的片段一律丢掉，并且描述总分封顶（见 DESC_CAP）。
    """
    out: list[str] = []
    for w in re.findall(r"[A-Za-z][A-Za-z0-9_]{1,}", desc or ""):
        if w.lower() not in STOPWORDS:
            out.append(w)
    for chunk in re.findall(r"[\u4e00-\u9fa5]{2,}", desc or ""):
        for n in (4, 3, 2):
            for i in range(len(chunk) - n + 1):
                piece = chunk[i : i + n]
                if piece in STOPWORDS or (set(piece) & STOPCHARS):
                    continue
                out.append(piece)
    seen: set[str] = set()
    uniq: list[str] = []
    for w in out:
        k = _norm(w)
        if k in seen:
            continue
        seen.add(k)
        uniq.append(w)
    return uniq[:120]


def score_candidates(text: str, candidates: list[Candidate]) -> list[dict[str, Any]]:
    """给每个候选打分，返回按分数降序的列表（带 why，能解释给用户听）。"""
    rows: list[dict[str, Any]] = []
    for cand in candidates:
        score = 0
        why: list[str] = []

        for word, weight in _name_words(cand.name):
            if _hits(word, text):
                score += weight
                why.append(f"名字「{word}」")

        for tag in cand.tags:
            t = (tag or "").strip()
            if len(t) >= 2 and _norm(t) not in STOPWORDS and _hits(t, text):
                score += W_TAG
                why.append(f"能力「{t}」")

        desc_score = 0
        for piece in _cap_words(cand.description or ""):
            if desc_score >= DESC_CAP:
                break
            if not _hits(piece, text):
                continue
            weight = W_WORD if re.search(r"[A-Za-z]", piece) else W_CAP
            desc_score += weight
            why.append(f"描述「{piece}」")
        score += min(desc_score, DESC_CAP)

        rows.append(
            {
                "agent_id": cand.agent_id,
                "name": cand.name,
                "score": score,
                "why": why[:8],
            }
        )
    rows.sort(key=lambda r: (-int(r["score"]), str(r["agent_id"])))
    return rows


def match_rules(text: str, rules: list[Rule]) -> list[Rule]:
    """命中的规则，按（优先级小 → 模式长）排序：写得越具体越优先。"""
    hit: list[Rule] = []
    for r in rules:
        pat = (r.pattern or "").strip()
        if not pat:
            continue
        if r.kind == "regex":
            if _regex_search(pat, text or ""):
                hit.append(r)
        elif _hits(pat, text):
            hit.append(r)
    hit.sort(key=lambda r: (int(r.priority), -len(r.pattern)))
    return hit


def _alts(
    rows: list[dict[str, Any]], exclude: str | None = None, keep_zero: bool = False
) -> list[dict[str, Any]]:
    """候选列表：同一个助手只出现一次，且不重复摆出已经选中的那个。

    实测踩过：两条规则都命中同一助手时，界面上"交给 简明助手"下面又列出
    "其他候选：简明助手 10 分" —— 看起来像两个不同的选择。
    """
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in rows:
        aid = str(r.get("agent_id") or "")
        if not aid or aid == exclude or aid in seen:
            continue
        if not keep_zero and int(r.get("score") or 0) <= 0:
            # 0 分的候选列出来只是噪音（实测"其他候选：X 0 分、Y 0 分、Z 0 分"）
            continue
        seen.add(aid)
        out.append(r)
        if len(out) >= 4:
            break
    return out


#: 一起干的门槛：第二位至少要够到最高分的这个比例
MULTI_RATIO = 0.6


def _multi(rows: list[dict[str, Any]], limit: int = 3) -> list[dict[str, Any]]:
    """哪几位值得一起干。

    判据刻意简单：最高分够"敢派"，且第二位也够到最高分的 6 成 —— 说明这句话
    同时落在两个人的能力范围里。差得远的（4 成以下）宁可只给一位：多派一路就是
    多一份钱、多一份要汇总的噪音，而扇出本身不便宜。
    """
    if not rows:
        return []
    hi = int(rows[0].get("score") or 0)
    if hi < HIGH_SCORE:
        return []
    floor = max(HIGH_SCORE, int(hi * MULTI_RATIO))
    picked = [r for r in rows if int(r.get("score") or 0) >= floor][:limit]
    if len(picked) < 2:
        return []
    return [
        {
            "agent_id": r["agent_id"],
            "name": r["name"],
            "score": int(r.get("score") or 0),
            "why": list(r.get("why") or r.get("rule") or []),
        }
        for r in picked
    ]


def route(
    text: str,
    *,
    candidates: list[Candidate],
    rules: list[Rule] | None = None,
    explicit_agent_id: str | None = None,
    default_agent_id: str | None = None,
) -> Decision:
    """四层判定。返回的 ``reason`` 是给人看的，不要在这里拼 UI 文案。"""
    by_id = {c.agent_id: c for c in candidates}
    text = (text or "").strip()

    # ── L0 显式指名 ──────────────────────────────────────────────
    if explicit_agent_id:
        cand = by_id.get(explicit_agent_id)
        return Decision(
            agent_id=explicit_agent_id,
            layer=0,
            score=100,
            confidence="explicit",
            reason="你指名了助手，不猜。",
            alternatives=[] if not cand else [{"agent_id": cand.agent_id, "name": cand.name, "score": 100}],
        )

    # ── L1 规则（用户自己写的「收这些话」）────────────────────────
    hits = match_rules(text, list(rules or []))
    hits = [h for h in hits if h.agent_id in by_id]  # 规则指向已不存在的助手当没写
    if hits:
        top = hits[0]
        cand = by_id[top.agent_id]
        return Decision(
            agent_id=top.agent_id,
            layer=1,
            score=W_RULE,
            confidence="rule",
            reason=f"命中「{cand.name}」的收话规则：{top.pattern}",
            alternatives=_alts(
                [
                    {"agent_id": h.agent_id, "name": by_id[h.agent_id].name, "score": W_RULE, "rule": h.pattern}
                    for h in hits[1:]
                ],
                exclude=top.agent_id,
            ),
            # 不止一位助手配了命中同一句话的规则 → 这句话本来就该几个人一起干
            multi=_multi(
                [
                    {"agent_id": h.agent_id, "name": by_id[h.agent_id].name, "score": W_RULE, "rule": h.pattern}
                    for h in hits
                ]
            ),
        )

    # ── L2 内容打分 ─────────────────────────────────────────────
    rows = score_candidates(text, list(candidates))
    best = rows[0] if rows else None
    alts = _alts(rows[:4])
    if best and int(best["score"]) > 0:
        conf = "high" if int(best["score"]) >= HIGH_SCORE else "low"
        tie = [r for r in rows[1:] if int(r["score"]) == int(best["score"])]
        reason = f"「{best['name']}」命中 " + "、".join(best["why"])
        if tie:
            conf = "low"
            reason += f"；但它和「{tie[0]['name']}」同分，得问你一句"
        return Decision(
            agent_id=best["agent_id"] if conf == "high" else None,
            layer=2,
            score=int(best["score"]),
            confidence=conf,
            reason=reason,
            alternatives=_alts(rows[:4], exclude=best["agent_id"] if conf == "high" else None),
            multi=_multi(rows),
        )

    # ── L3 兜底 ────────────────────────────────────────────────
    if default_agent_id and default_agent_id in by_id:
        cand = by_id[default_agent_id]
        return Decision(
            agent_id=cand.agent_id,
            layer=3,
            score=0,
            confidence="fallback",
            reason=f"没有哪位助手明确认得这些话，先用当前对话的「{cand.name}」。",
            alternatives=_alts(alts, exclude=cand.agent_id),
        )
    if len(by_id) == 1:
        only = next(iter(by_id.values()))
        return Decision(
            agent_id=only.agent_id,
            layer=3,
            score=0,
            confidence="fallback",
            reason=f"只有一位助手「{only.name}」，就它了。",
            alternatives=_alts(alts, exclude=only.agent_id),
        )
    return Decision(
        agent_id=None,
        layer=3,
        score=0,
        confidence="unknown",
        reason="没有哪位助手的名字/标签/描述能对上这些话，也没配规则 —— 需要你选一个。",
        alternatives=_alts(rows[:4], keep_zero=True),
    )
