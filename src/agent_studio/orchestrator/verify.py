"""汇总前的验证层 —— 先核"这句话能不能核"，再把结论交给汇总。

为什么必须有这一层
------------------
多助手并行跑完，把各路的文本拼起来当"最终结论"，等于完全没验证：任何一路
编一个不存在的文件、引一段没跑过的测试，都会被当成事实呈给用户。模型自己
"再审一遍"也不可靠（同一问题两次答案都不一样）。

所以这里只做**可机械判定**的三件事，一次都不问模型：

1. **引用核验**：结论里出现的 `路径:行号` 真的存在吗？行号在文件范围内吗？
   —— 成本接近 0，能挡掉绝大部分幻觉。
2. **交叉冲突**：同一个引用，一路说"存在"、另一路说"不存在" —— 至少有一路错，
   必须标出来，而不是让汇总把它们并排展示。
3. **覆盖检查**：编排开始时写下的完成判据（acceptance），逐条看有没有被
   某个结论覆盖；没覆盖的就是 gap，明确写"未覆盖"，不假装完成。

刻意不做（v1 边界，写在这里免得后来人以为是漏了）
------------------------------------------------
* 不做语义仲裁（"两路结论相反，谁对"）—— 那需要跑可执行验证或再派一路反驳，
  是编排层的事，不在这个纯函数模块里假装能做。
* 不做 URL 抓取（网络依赖、慢、不可测）—— 只做语法层标记，交给上层决定要不要验。
* 不做"没有引用 = 有罪"的判断：很多结论天然没有文件引用（比如"这个方案更简单"）。
  没引用的路单独计数，不判失败。

设计约束：全部纯函数 + 只读文件系统，不连数据库、不发网络请求 —— 这样能被单测
逐条覆盖，也能在编排跑完后重算（回放时行为一致）。
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

#: 结论里可能出现的"可核引用"：`src/a.py:88`、`./web/lib/x.ts`、`docs/b.md`
#: 路径段限制在安全字符内，避免把 "版本 1.2.3" 之类的句子误判成文件。
_CITE_RE = re.compile(
    r"(?<![\w/.:-])"
    r"((?:\.{1,2}/)?(?:[\w@+-]+/)*[\w@+-]+\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|md|mdx|json|yaml|yml"
    r"|toml|ini|cfg|sh|bash|sql|txt|css|scss|html|go|rs|java|kt|rb|php|c|h|cpp|hpp|swift))"
    r"(?::(\d+))?"
)

#: 明显不是项目文件的扩展名/目录（避免把依赖树里的路径也当成"必须存在"）
_IGNORE_PREFIXES = ("node_modules/", ".git/", "site-packages/", "dist/", ".next/")

MAX_FILE_BYTES = 2_000_000  # 单个文件最多读 2MB 去找行号


@dataclass
class Citation:
    ref: str                  # 原样（含行号）
    path: str                 # 只取路径
    line: int | None = None   # 行号（有就核）
    exists: bool = False
    line_in_range: bool | None = None
    reason: str = ""    # 不存在/超出范围的原因（给人看）

    @property
    def ok(self) -> bool:
        if not self.exists:
            return False
        return self.line_in_range is not False


@dataclass
class RunResult:
    """一条 worker 产出的可核事实（只放能和文本对上的东西，不评价质量）。"""

    run_id: str
    name: str
    status: str
    citations: list[Citation] = field(default_factory=list)
    text_chars: int = 0
    text: str = ""

    @property
    def total(self) -> int:
        return len(self.citations)

    @property
    def ok_count(self) -> int:
        return sum(1 for c in self.citations if c.ok)

    @property
    def all_dead(self) -> bool:
        """有引用但**全部**核不上 —— 这条结论基本不可信。"""
        return self.total > 0 and self.ok_count == 0


def extract_citations(text: str) -> list[Citation]:
    """从一段文本里抽引用（去重、保序）。"""
    seen: set[str] = set()
    out: list[Citation] = []
    for m in _CITE_RE.finditer(text or ""):
        path, line = m.group(1), m.group(2)
        if any(seg in path for seg in _IGNORE_PREFIXES):
            continue
        ref = f"{path}:{line}" if line else path
        if ref in seen:
            continue
        seen.add(ref)
        out.append(Citation(ref=ref, path=path, line=int(line) if line else None))
    return out


def _read_lines(path: Path) -> int | None:
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            return None
        with path.open("rb") as fh:
            return sum(1 for _ in fh)
    except OSError:
        return None


def check(citation: Citation, root: str | os.PathLike[str] | None) -> Citation:
    """核一个引用：文件在不在、行号在不在范围内。**只读，不抛异常。**"""
    base = Path(root) if root else Path.cwd()
    target = (base / citation.path).resolve()
    # 只许看工作目录及其子目录（防止结论里写 /etc/passwd 被"核到存在"）
    try:
        target.relative_to(base.resolve())
    except ValueError:
        citation.exists = False
        citation.reason = "不在工作目录内，未核"
        return citation

    if not target.is_file():
        # 有些结论写的是相对别的目录的路径 —— 退一步按文件名在工作目录里找一次
        if citation.path.startswith(("./", "../")):
            citation.exists = False
            citation.reason = "文件不存在"
            return citation
        citation.exists = False
        citation.reason = "文件不存在"
        return citation

    citation.exists = True
    if citation.line is not None:
        n = _read_lines(target)
        if n is None:
            citation.line_in_range = None
            citation.reason = "文件过大，未核行号"
        else:
            citation.line_in_range = 1 <= citation.line <= max(n, 1)
            if not citation.line_in_range:
                citation.reason = f"行号超出范围（文件只有 {n} 行）"
    return citation


def verify_run(
    run_id: str,
    name: str,
    status: str,
    text: str,
    workdir: str | os.PathLike[str] | None,
) -> RunResult:
    res = RunResult(run_id=run_id, name=name, status=status, text_chars=len(text or ""), text=text or "")
    res.citations = [check(c, workdir) for c in extract_citations(text)]
    return res


def find_conflicts(runs: Iterable[RunResult]) -> list[dict[str, Any]]:
    """同一个引用在不同 run 里"存在/不存在"不一致 —— 至少有一路错。"""
    by_ref: dict[str, dict[str, list[str]]] = {}
    for r in runs:
        for c in r.citations:
            slot = by_ref.setdefault(c.ref, {"ok": [], "bad": []})
            slot["ok" if c.ok else "bad"].append(r.name)
    out: list[dict[str, Any]] = []
    for ref, slot in by_ref.items():
        if slot["ok"] and slot["bad"]:
            out.append({"ref": ref, "ok_in": slot["ok"], "missing_in": slot["bad"]})
    return out


def _bigrams(text: str) -> set[str]:
    s = re.sub(r"[\s，。、；：,.;:（）()「」【】“”\"'`\-—_/]+", "", text or "")
    return {s[i : i + 2] for i in range(len(s) - 1)} if len(s) > 1 else ({s} if s else set())


def coverage(acceptance: list[str], texts: Iterable[str]) -> dict[str, Any]:
    """完成判据覆盖检查（v1：**二元组命中率**，过半即算覆盖）。

    为什么不用"按词切分再求命中"：中文判据里"说明 500 的服务端原因"会被切成
    说明/500/服务端原因 —— 而实际产出写的是"服务端未捕获的异常"，意思覆盖了、
    字面却没对齐，于是每条判据都报 gap（实测：真跑一次，2 条判据全被误报）。
    二元组（bigram）命中率对改写更宽容，同时仍然要求"说过这件事"。

    这仍然只是**保守信号**：宁可把"其实做了但没说清"的报成 gap，
    也不要把没做的说成做完了 —— 少报一个 gap 的代价远大于多报一个。
    """
    items = [a.strip() for a in (acceptance or []) if str(a).strip()]
    have = _bigrams("\n".join(t for t in texts if t))
    covered: list[str] = []
    gaps: list[str] = []
    for item in items:
        grams = _bigrams(item)
        if not grams:
            gaps.append(item)
            continue
        hit = len(grams & have) / len(grams)
        (covered if hit >= 0.5 else gaps).append(item)
    return {"acceptance": items, "covered": covered, "gaps": gaps}


def summarise(
    runs: Iterable[RunResult],
    *,
    acceptance: list[str] | None = None,
) -> dict[str, Any]:
    """把各条 run 的可核事实汇总成一个可以直接塞进编排 output 的 dict。"""
    rows = list(runs)
    total = sum(r.total for r in rows)
    ok = sum(r.ok_count for r in rows)
    missing = [
        {"ref": c.ref, "run": r.name, "reason": c.reason}
        for r in rows
        for c in r.citations
        if not c.ok
    ]
    conflicts = find_conflicts(rows)
    cov = coverage(list(acceptance or []), [r.text for r in rows])
    return {
        "citations": {"total": total, "ok": ok, "missing": missing},
        "runs": [
            {
                "run_id": r.run_id,
                "name": r.name,
                "status": r.status,
                "citations": r.total,
                "citations_ok": r.ok_count,
                "no_citation": r.total == 0,
                "unverified": r.all_dead,
            }
            for r in rows
        ],
        "conflicts": conflicts,
        "coverage": cov,
        "unverified": [r.name for r in rows if r.all_dead],
        "clean": not missing and not conflicts and not cov["gaps"],
    }


def render_block(v: dict[str, Any]) -> str:
    """把验证结果渲染成几行人话，追加在汇总末尾。没有内容可报时返回空串。"""
    if not v:
        return ""
    cites = v.get("citations") or {}
    missing = cites.get("missing") or []
    conflicts = v.get("conflicts") or []
    cov = v.get("coverage") or {}
    gaps = cov.get("gaps") or []
    unverified = v.get("unverified") or []

    if not missing and not conflicts and not gaps and not unverified:
        # 没问题就**一个字都不说**：成功是常态，报"全部通过"只会把结论挤走。
        # 想让人看见"核过了"的是界面上的小徽标（读结构化 verification），不是正文。
        return ""

    lines = ["—— 验证 ——"]
    if cites.get("total"):
        lines.append(
            f"引用核对：{cites.get('total')} 处 → {cites.get('ok')} 处存在、{len(missing)} 处找不到"
        )
        for m in missing[:5]:
            lines.append(f"  · {m['ref']}（{m['run']}）：{m.get('reason') or '不存在'}")
        if len(missing) > 5:
            lines.append(f"  · 还有 {len(missing) - 5} 处未列")
    for c in conflicts[:3]:
        lines.append(
            f"冲突：{c['ref']} —— {'、'.join(c['ok_in'])} 说存在，{'、'.join(c['missing_in'])} 说找不到"
        )
    if cov.get("acceptance"):
        lines.append(
            f"覆盖：{len(cov['acceptance'])} 条完成判据 → 覆盖 {len(cov.get('covered') or [])} 条"
        )
        for g in gaps[:3]:
            lines.append(f"  · 未覆盖：{g}")
    if unverified:
        lines.append(f"未验证：{'、'.join(unverified)}（引用的东西一个都核不上）")
    return "\n".join(lines)


__all__ = [
    "Citation",
    "RunResult",
    "check",
    "coverage",
    "extract_citations",
    "find_conflicts",
    "render_block",
    "summarise",
    "verify_run",
]
