"""平台原生内核工具 —— fetch / web_search / python。

参照 Hermes agent 的三层工具体系（内核工具 / Skills / 外围）补齐"通用助手"的手：
没有这三个，"查资料 / 跑数据"类任务就是瘸的。

为什么放平台层（kind="native"，同 fork）而不是塞进 AgentScope 内置清单：
* 执行体是平台自己的函数，**权威实现不随运行时走** —— 未来接 pi 也自动具备；
* 安全约束（SSRF、大小/时长上限、python 限目录限时长）在这里集中收口，
  UI 的"试运行"与 Agent 运行时走同一个实现，不会出现"试跑通了、真跑不一样"。

安全模型（与既有 workspace 体系对齐）
------------------------------------
fetch        只读。禁止内网地址（SSRF）、限 20s / 256KB、二进制拒收。
web_search   只读。腾讯搜索为主、Bing RSS/HTML 兜底（零 key、零依赖），解析前 8 条
             标题+摘要+链接，返回纯文本 —— 模型拿到的就是"能用"的搜索结果。
python       写类。代码写进 run 自己的工作目录下执行（cwd 锁死），
             stdout/stderr 有限截断，超时硬闸（默认 30s，上限 120s）。
             子进程继承当前工作目录 = 与 read/write/edit 同一隔离域。
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import os
import re
import socket
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# 出网请求头：伪装成一个真实的 Chrome
# --------------------------------------------------------------------------- #
# 为什么必须装：默认 UA（httpx/x.y 或 "compatible; AgentStudio/1.0"）会被
# 站点直接判成脚本 —— 实测现象是 403 / 验证页 / 空结果，用户看到的是
# "搜索不可达"。伪装成正经浏览器是最低成本、且对只读抓取无副作用的提升。
#
# 要点（浏览器真的会发这些，缺一条就露馅）：
#   · UA 必须是**完整**的 Chrome UA 串：只有 "AppleWebKit/537.36" 没有
#     Chrome/xx 的 UA 是最典型的脚本特征（老代码就这样）；
#   · Accept 要像文档导航（含 q 权重），不能只给 text/html；
#   · Accept-Language 带中文优先（站点会据此返回中文页，顺带更省 token）；
#   · Sec-Fetch-* 是现代 Chrome 的必备头，缺失会被指纹识别；
#   · Upgrade-Insecure-Requests: 1 同理。
# 三处（fetch / 腾讯搜索 / Bing）**共用同一份**，避免"某一条路径忘了改"。
CHROME_VERSION = "131"
BROWSER_HEADERS: dict[str, str] = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        f"AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROME_VERSION}.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "image/avif,image/webp,image/apng,*/*;q=0.8"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "Connection": "keep-alive",
}

FETCH_TIMEOUT_S = 20
FETCH_MAX_BYTES = 256 * 1024
SEARCH_TIMEOUT_S = 15
PYTHON_TIMEOUT_S_DEFAULT = 30
PYTHON_TIMEOUT_S_MAX = 120
PYTHON_OUTPUT_MAX = 32 * 1024

# 内网/保留网段 —— fetch 拒绝（防 SSRF 打进平台自身或内网服务）
def _is_private_host(host: str) -> bool:
    try:
        addr = ipaddress.ip_address(socket.gethostbyname(host))
        return addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved
    except Exception:
        # 解析不出（可能已断网）→ 交给 httpx 报错，不在这里拦
        return False


async def _fetch(url: str, max_bytes: int = FETCH_MAX_BYTES) -> str:
    """抓一个网页/接口，返回文本（HTML 剥成粗粒度纯文本）。"""
    import httpx

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return f"✗ 只支持 http/https，收到: {parsed.scheme or '(空)'}"
    if not parsed.hostname:
        return "✗ URL 里没有主机名"
    if _is_private_host(parsed.hostname):
        return f"✗ 出于安全考虑不能访问内网地址: {parsed.hostname}"

    # 有 DeepSeek 工具凭据就先用它：返回的是干净 Markdown，比本地剥 HTML 稳
    try:
        from . import deepseek_tools as dst

        cred = await dst.resolve_credential()
        if cred is not None:
            data, usage = await dst.fetch(cred, url)
            if data.get("content"):
                await dst.record_usage(usage)
                text = data["content"][:max_bytes]
                title = data.get("title") or ""
                return (f"# {title}\n\n{text}" if title else text)
    except Exception:  # noqa: BLE001 —— 退回本地抓取
        pass

    try:
        async with httpx.AsyncClient(
            timeout=FETCH_TIMEOUT_S,
            follow_redirects=True,
            headers=BROWSER_HEADERS,
        ) as client:
            r = await client.get(url)
    except httpx.HTTPError as exc:
        return f"✗ 抓取失败（{type(exc).__name__}: {str(exc)[:120]}）"
    ctype = r.headers.get("content-type", "")
    if r.status_code >= 400:
        return f"✗ HTTP {r.status_code} {r.reason_phrase}"
    if "html" in ctype:
        text = _html_to_text(r.text)
    elif any(t in ctype for t in ("json", "text", "xml", "javascript")) or ctype == "":
        text = r.text
    else:
        return f"✗ 不支持的内容类型: {ctype}（只收文本/HTML/JSON/XML）"
    if len(text.encode("utf-8", errors="replace")) > max_bytes:
        text = text[:max_bytes] + f"\n…（已截断，原文超过 {max_bytes // 1024}KB）"
    return text


_TAG_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.DOTALL | re.IGNORECASE)
_TAG_STRIP_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\n{3,}")


def _html_to_text(html: str) -> str:
    """HTML → 粗粒度纯文本（够模型读，不做完整解析）。"""
    out = _TAG_RE.sub("", html)
    out = re.sub(r"<br\s*/?>", "\n", out, flags=re.IGNORECASE)
    out = re.sub(r"</(p|div|li|h[1-6]|tr)>", "\n", out, flags=re.IGNORECASE)
    out = _TAG_STRIP_RE.sub("", out)
    out = (
        out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
    )
    return _WS_RE.sub("\n\n", out).strip()


async def _web_search(query: str, max_results: int = 8) -> str:
    """搜索：Bing RSS → Bing HTML → 腾讯搜索（中文兜底）。

    为什么不再用 DuckDuckGo：html.duckduckgo.com 在多数网络下已经不可用
    （返回 403/风控页或直接超时）。留着它只是让每次搜索先白等 15 秒。

    为什么优先 RSS 而不是 HTML：
      · HTML 版是给浏览器渲染的，同一查询在不同出口下会拿到"固定池里的随机结果"
        （和查询词无关），而且结构一改解析就静默变成空；
      · `format=rss` 是同一后端的结构化出口：10 条、标题/链接/摘要齐全，
        实测同一查询三次返回完全一致（Debian 官网 / Download / 维基）。
    """
    # 第一优先：DeepSeek 自研搜索（rerank_score / authority 就是现成的质量信号）
    try:
        from . import deepseek_tools as dst

        cred = await dst.resolve_credential()
        if cred is not None:
            results, usage = await dst.search(cred, query, count=max_results)
            if results:
                await dst.record_usage(usage)
                return _format_deepseek(results[:max_results])
    except Exception:  # noqa: BLE001 —— 上游任何问题都退回本地链，不让搜索整个不可用
        pass

    # 引擎选择：先问腾讯，再按「结果和查询词的相关度」决定要不要换 Bing。
    #
    # 为什么不写死顺序：实测两个引擎都会"看查询词抽风"——
    #   · Bing 对中文查询会返回固定池里的无关结果（查 nginx 返回冠状病毒百科）；
    #   · 腾讯对英文长尾会混进垃圾站（rust async runtime → 某个色情站）。
    # 所以判据不是"谁品牌好"，而是"这一份结果里有多少查询词是真的命中了"。
    out = await _search_qq(query, max_results)
    best = out
    best_score = _relevance(query, out) if out else 0.0
    if best_score < 0.5:
        bing = await _search_bing_rss(query, max_results)
        if bing is not None:
            bing_score = _relevance(query, bing)
            if bing_score > best_score:
                best, best_score = bing, bing_score
        if best_score < 0.5:
            html = await _search_bing(query, max_results)
            if html is not None:
                html_score = _relevance(query, html)
                if html_score > best_score:
                    best, best_score = html, html_score
    if best is not None and _looks_useful(best):
        if best_score < 0.5:
            # 所有引擎都只给了和查询无关的结果（反爬池）：如实标注，
            # 别让模型把"冠状病毒百科"当成 nginx 文档用。
            return (
                "⚠ 以下结果与查询词基本无关（搜索引擎返回了反爬池内容，不是真的搜索到了）：\n"
                + best
                + "\n建议改用已知域名的直接 fetch，或换一个更具体的关键词再试一次。"
            )
        return best
    return (
        "✗ 搜索不可达：Bing 与腾讯搜索都连不上 —— 本机出海直连不通（已实测确认），"
        "这不是查询词的问题，换关键词、换引擎、用 curl 重试都一样会失败。\n"
        "正确的做法（选一个，别在搜索上烧超过 2 次调用）：\n"
        "1. 改用已知域名直接 fetch（官方文档/GitHub 链接，不经过搜索引擎）；\n"
        "2. 基于你已有的知识作答，并明确标注「未能联网核实」；\n"
        "3. 被派活时：worker_report(kind=blocked) 上报「搜索通道不可用，"
        "需要提供入口 URL 或改派有网络的执行」。"
    )


_STOP = {"the", "a", "an", "of", "for", "to", "in", "on", "and", "or", "with", "how"}


def _tokens(query: str) -> set[str]:
    """查询词切成可比对的 token：中文按二元组，英文按单词（去停用词）。"""
    q = query.lower()
    toks: set[str] = set()
    for word in re.findall(r"[a-z0-9][a-z0-9+._-]*", q):
        if len(word) > 1 and word not in _STOP:
            toks.add(word)
    cjk = re.findall(r"[\u4e00-\u9fff]+", q)
    for run in cjk:
        toks.update(run[i : i + 2] for i in range(len(run) - 1))
        if len(run) == 1:
            toks.add(run)
    return toks


def _relevance(query: str, formatted: str | None) -> float:
    """结果里命中了多少查询词（0~1）。

    只看标题行：摘要是各站自己写的，容易蹭词；标题命中才说明这一条真的是
    关于这个查询的。没有 token 可算时返回 1.0（不因为打分逻辑而拒绝结果）。
    """
    toks = _tokens(query)
    if not toks or not formatted:
        return 0.0
    # 标题 + 链接（域名里也常有查询词，例如 github.com/xxx/runtime）
    picked = [line for line in formatted.splitlines() if line.strip() and not line.startswith("   ")]
    titles = " ".join(line.split(". ", 1)[-1] for line in picked).lower()
    urls = " ".join(line.strip() for line in formatted.splitlines() if line.startswith("   http"))
    hay = f"{titles} {urls}"
    hit = sum(1 for t in toks if t in hay)
    return hit / len(toks)


def _looks_useful(formatted: str) -> bool:
    """结果够不够用：格式化后至少两条编号行。

    单条结果通常意味着引擎只回了"相关推荐"或者半页错误，这时值得换下一个引擎。
    """
    return sum(1 for line in formatted.splitlines() if line[:1].isdigit()) >= 2


async def _search_bing_rss(query: str, max_results: int = 8) -> str | None:
    """Bing 的 RSS 出口 —— 结构化、稳定，是首选。

    None = 不可用（让上层降级），str = 结果（或"确实没有结果"）。
    """
    import httpx

    try:
        async with httpx.AsyncClient(
            timeout=SEARCH_TIMEOUT_S,
            follow_redirects=True,
            headers=BROWSER_HEADERS,
        ) as client:
            r = await client.get(
                "https://www.bing.com/search",
                params={
                    "q": query,
                    "format": "rss",
                    "setlang": "zh-cn",
                    "mkt": "zh-CN",
                    "count": str(max_results),
                },
            )
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        return None
    results = _parse_bing_rss(r.text)
    if not results:
        return None
    return _format_results(results[:max_results])


async def _search_bing(query: str, max_results: int = 8) -> str | None:
    """Bing 国内版（cn.bing.com 直连可用，实测）。"""
    import httpx

    try:
        async with httpx.AsyncClient(
            timeout=SEARCH_TIMEOUT_S,
            follow_redirects=True,
            headers=BROWSER_HEADERS,
        ) as client:
            r = await client.get(
                "https://www.bing.com/search",
                params={"q": query, "setlang": "zh-cn", "mkt": "zh-CN"},
            )
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        return None
    results = _parse_bing(r.text)
    if not results:
        return None
    return _format_results(results[:max_results])


def _format_deepseek(results: list[dict]) -> str:
    """DeepSeek 搜索结果的渲染：标题 / 摘要 / 链接 + 权威度。

    为什么把 rerank_score 和 authority 打出来：这两列是上游给的质量信号
    （rerank ≥1.5 为优质、authority ≥3 为极权威）。模型能据此决定"要不要再搜
    一次"或"这条能不能直接引用"，比只给一串链接有用。
    """
    if not results:
        return "（没有搜到结果）"
    lines = []
    for i, r in enumerate(results, 1):
        title = _clean(str(r.get("title") or ""))
        url = str(r.get("url") or "")
        summary = _clean(str(r.get("summary") or r.get("snippet") or ""))
        score = r.get("rerank_score")
        auth = r.get("authority")
        date = str(r.get("date") or "")[:10]
        meta = []
        if isinstance(score, (int, float)):
            meta.append(f"相关 {score:.1f}")
        if isinstance(auth, int) and auth >= 0:
            meta.append(f"权威 {auth}")
        if date:
            meta.append(date)
        lines.append(f"{i}. {title}" + (f"（{' · '.join(meta)}）" if meta else ""))
        if summary:
            lines.append(f"   {summary}")
        lines.append(f"   {url}")
    return "\n".join(lines)


_ZERO_WIDTH = dict.fromkeys(map(ord, "\u200b\u200c\u200d\ufeff"))


def _clean(s: str) -> str:
    """去掉零宽字符与多余空白 —— 腾讯搜索的标题/摘要里夹着 \u200b，
    看不见但会切断关键词，模型复制出来就是错的。"""
    return re.sub(r"[ \t\u00a0]+", " ", s.translate(_ZERO_WIDTH)).strip()


def _format_results(results: list[tuple[str, str, str]]) -> str:
    if not results:
        return "（没有搜到结果，换个关键词试试）"
    lines = []
    for i, (title, snippet, url) in enumerate(results, 1):
        snippet = re.sub(r"\s+", " ", snippet).strip()
        lines.append(f"{i}. {_clean(title)}\n   {_clean(snippet)}\n   {url}")
    return "\n".join(lines)


_BING_RE = re.compile(
    r'<li class="b_algo".*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>(.*?)</a>.*?'
    r'<p class="b_lineclamp[^"]*"[^>]*>(.*?)</p>',
    re.DOTALL,
)


def _parse_bing(html: str) -> list[tuple[str, str, str]]:
    """从 Bing 结果页解析（标题, 摘要, 链接）。解析失败返回空表。"""
    out = []
    for m in _BING_RE.finditer(html):
        url, title, snippet = m.group(1), m.group(2), m.group(3)
        title = _TAG_STRIP_RE.sub("", title).strip()
        snippet = (
            snippet.replace("&ensp;", " ").replace("&#0183;", "·").replace("&nbsp;", " ")
        )
        snippet = _TAG_STRIP_RE.sub("", snippet).strip()
        if title:
            out.append((title, snippet, url))
    return out


def _parse_bing_rss(xml_text: str) -> list[tuple[str, str, str]]:
    """解析 Bing RSS（标题, 摘要, 链接）。

    为什么用 ElementTree 而不是正则：RSS 是 XML，正则在 CDATA/转义上很容易翻车；
    ET 是标准库，零依赖。字段缺失就跳过，不抛异常 —— 搜索工具不能因为一条
    畸形 item 就把整个结果丢掉。
    """
    import xml.etree.ElementTree as ET

    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    out: list[tuple[str, str, str]] = []
    for item in root.findall(".//item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        desc = item.findtext("description") or ""
        if not title or not link:
            continue
        # description 里是 HTML 片段（<b>高亮</b>、&amp; 之类），转成纯文本
        snippet = _html_to_text(desc)
        out.append((_html_to_text(title), snippet, link))
    return out


async def _search_qq(query: str, max_results: int = 8) -> str | None:
    """腾讯搜索（so.qq.com）的 WAP 接口 —— 中文查询的兜底。

    为什么放兜底而不是主力：
      · 没有公开契约：请求体要带 sp 会话字段，返回是一棵 800KB 的卡片树，
        卡片名（card-wap/*）随时可能改；
      · 响应体大（一次 ~800KB），比 Bing 重两个数量级；
      · 它服务的是自家浏览器外壳（UA 伪装成 iOS Safari 才给 WAP 版）。
    好处是中文站点覆盖好，Bing 抽风时能顶上，所以只在"Bing 全空 + 查询含中文"时用。
    """
    import httpx
    import json as _json

    now = int(__import__("time").time() * 1000)
    payload = {
        "query": query,
        "page": 1,
        "variant": "wap",
        "sp": {
            "sourceid": "18_01_03",
            "last_sourceid": "16_01_07",
            "sessiontime": str(now),
            "bddn": "",
            "brnd": "",
            "query": query,
            "entryTime": str(now),
        },
    }
    headers = {
        **BROWSER_HEADERS,
        "User-Agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"
        ),
        "Content-Type": "application/json",
        "Accept": "*/*",
        "Origin": "https://so.qq.com",
        "Referer": "https://so.qq.com/",
    }
    try:
        async with httpx.AsyncClient(timeout=SEARCH_TIMEOUT_S, follow_redirects=True) as client:
            r = await client.post(
                "https://so.qq.com/searchweb/api/search/next-page",
                headers=headers,
                content=_json.dumps(payload, ensure_ascii=False).encode(),
            )
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        return None
    try:
        data = r.json()
    except ValueError:
        return None
    results = _parse_qq(data)
    if not results:
        return None
    return _format_results(results[:max_results])


def _parse_qq(data: dict) -> list[tuple[str, str, str]]:
    """腾讯卡片树 → (标题, 摘要, 链接)。只取带 vm.title/url 的卡片（正文结果）。"""
    out: list[tuple[str, str, str]] = []
    for card in data.get("cards") or []:
        vm = ((card or {}).get("data") or {}).get("vm") or {}
        title = str(vm.get("title") or "").strip()
        url = str(vm.get("url") or "").strip()
        if not title or not url:
            continue
        snippet = str(vm.get("content") or "").strip()
        source = str(vm.get("sourcename") or "").strip()
        if source:
            snippet = f"[{source}] {snippet}" if snippet else f"[{source}]"
        out.append((title, snippet, url))
    return out


# --------------------------------------------------------------------------- #
# 文档 / 语音（服务端处理用户上传的文件）
# --------------------------------------------------------------------------- #
#: 单次写回上下文的正文上限：OCR 1000 页全塞进去等于把上下文烧穿
DOC_CONTEXT_CHARS = 6000


def _run_workspace() -> Path:
    """当前 run 的工作目录（工具文件参数的唯一根）。"""
    try:
        from .runner.ctx import current_run_ctx

        ctx = current_run_ctx()
        root = Path(ctx.get("workspace") or ".")
    except Exception:  # noqa: BLE001
        root = Path(".").resolve()
    return root if root.exists() else Path(tempfile.gettempdir())


def _safe_file(rel: str) -> Path:
    """把「会话工作目录内的相对路径」解析成绝对路径；越界一律拒绝。

    为什么必须挡：文件是用户传的，模型也会自己拼路径（"../" 很容易出现）。
    这些工具的输入是**路径**，不是内容，所以校验点只有这里一个。
    """
    root = _run_workspace().resolve()
    target = (root / rel).resolve() if not Path(rel).is_absolute() else Path(rel).resolve()
    if root not in target.parents and target != root:
        raise ValueError(f"路径越界：{rel}")
    return target


async def _read_document(path: str, purpose: str = "text", max_pages: int = 0) -> str:
    """OCR：把上传的 PDF / 图片 / Office 文档读成文字（按页返回）。

    工业场景最常走这条：扫描件投标书、PDF 规格书、合同截图。文件已经由用户
    上传到会话工作目录，模型只需要给路径。
    """
    from . import deepseek_tools as dst

    cred = await dst.resolve_credential()
    if cred is None:
        return (
            "✗ 未配置 DeepSeek 工具密钥，OCR 不可用。\n"
            "请让用户在「API 密钥」里添加 provider=deepseek-tools 的凭据。"
        )
    try:
        target = _safe_file(path)
    except ValueError as exc:
        return f"✗ {exc}"
    if not target.is_file():
        return f"✗ 文件不存在：{path}（先用会话文件列表确认文件名）"
    if target.stat().st_size > 100 * 1024 * 1024:
        return "✗ 文件超过 100MiB，请先拆分或压缩。"

    mode = "rich_layout_recognition" if purpose in ("rich", "layout", "rich_layout") else "text_recognition"
    try:
        data, usage = await dst.ocr(cred, target.name, target.read_bytes(), purpose=mode)
    except dst.ToolsError as exc:
        return exc.as_tool_text()
    await dst.record_usage(usage)

    pages = data.get("pages") or []
    total_chars = sum(len(p.get("text") or "") for p in pages)
    limit = _run_workspace() / ".studio" / "results"
    limit.mkdir(parents=True, exist_ok=True)
    full = limit / f"ocr-{usage.request_id or int(time.time())}.md"
    try:
        full.write_text(
            "\n\n".join(f"## 第 {p.get('index', i) + 1} 页\n\n{p.get('text') or ''}" for i, p in enumerate(pages)),
            encoding="utf-8",
        )
    except OSError:
        full = Path("")

    want = int(max_pages or 0)
    shown = pages[:want] if want > 0 else pages
    body_parts, used = [], 0
    for i, page in enumerate(shown):
        text = (page.get("text") or "").strip()
        if not text:
            continue
        block = f"## 第 {page.get('index', i) + 1} 页\n{text}"
        if used + len(block) > DOC_CONTEXT_CHARS:
            block = block[: max(0, DOC_CONTEXT_CHARS - used)] + "\n…（本页截断）"
        body_parts.append(block)
        used += len(block)
        if used >= DOC_CONTEXT_CHARS:
            break

    head = (
        f"识别完成：{data.get('page_count') or len(pages)} 页，共 {total_chars} 字，"
        f"耗时 {usage.latency_ms}ms，花费 ¥{usage.cost_cny:.4f}。"
    )
    tail = ""
    if total_chars > used:
        tail = (
            f"\n\n（以上只放了前 {used} 字；完整文本在 {full} ，需要细节用 read 打开）"
            if full
            else f"\n\n（以上只放了前 {used} 字）"
        )
    return head + "\n\n" + "\n\n".join(body_parts) + tail


async def _transcribe(path: str) -> str:
    """ASR：把上传的音频转成文字（≤120 秒、≤8MiB）。"""
    from . import deepseek_tools as dst

    cred = await dst.resolve_credential()
    if cred is None:
        return (
            "✗ 未配置 DeepSeek 工具密钥，语音识别不可用。\n"
            "请让用户在「API 密钥」里添加 provider=deepseek-tools 的凭据。"
        )
    try:
        target = _safe_file(path)
    except ValueError as exc:
        return f"✗ {exc}"
    if not target.is_file():
        return f"✗ 文件不存在：{path}"
    size = target.stat().st_size
    if size > 8 * 1024 * 1024:
        return f"✗ 音频 {size / 1048576:.1f}MiB 超过 8MiB 上限，请先压缩或分段。"

    try:
        data, usage = await dst.asr(cred, target.name, target.read_bytes())
    except dst.ToolsError as exc:
        return exc.as_tool_text()
    await dst.record_usage(usage)

    text = (data.get("text") or "").strip()
    seconds = float(data.get("duration_ms") or 0) / 1000
    return (
        f"转写完成：{seconds:.1f} 秒音频，{len(text)} 字，耗时 {usage.latency_ms}ms，"
        f"花费 ¥{usage.cost_cny:.4f}。\n\n{text or '（没有识别到语音内容）'}"
    )


async def _speak(text: str, voice: str = "stella", fmt: str = "wav") -> str:
    """TTS：把一段文字合成音频，落到 product/ 供下载（备选能力）。"""
    from . import deepseek_tools as dst

    cred = await dst.resolve_credential()
    if cred is None:
        return "✗ 未配置 DeepSeek 工具密钥，语音合成不可用。"
    voice_id = "tide" if str(voice).lower() in ("tide", "male", "男") else "stella"
    fmt = "pcm" if str(fmt).lower() == "pcm" else "wav"
    try:
        audio, usage = await dst.tts(cred, text, voice_id=voice_id, fmt=fmt)
    except dst.ToolsError as exc:
        return exc.as_tool_text()
    await dst.record_usage(usage)

    out_dir = _run_workspace() / "product"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"speech-{dst.cache_key(text, voice_id, fmt)}.{fmt}"
    target = out_dir / name
    try:
        target.write_bytes(audio)
    except OSError as exc:
        return f"✗ 音频已合成但写入失败：{exc}"

    return (
        f"已合成 {usage.units:.0f} 计费字符（{len(audio) / 1024:.0f}KB，{usage.latency_ms}ms，"
        f"¥{usage.cost_cny:.4f}），文件在 product/{name}，用户可在右栏「产物」里播放或下载。"
    )


async def _python(code: str, timeout_s: int = PYTHON_TIMEOUT_S_DEFAULT) -> str:
    """在**当前 run 的工作目录**里跑一段 Python（cwd 锁死 = 与文件工具同一隔离域）。"""
    from .runner.ctx import current_run_ctx

    timeout_s = max(1, min(int(timeout_s or PYTHON_TIMEOUT_S_DEFAULT), PYTHON_TIMEOUT_S_MAX))

    cwd: Path | None = None
    try:
        ctx = current_run_ctx()
        cwd = Path(ctx.get("workspace") or ".")
    except Exception:
        cwd = Path(".").resolve()
    if not cwd.exists():
        cwd = Path(tempfile.gettempdir())

    # 代码落盘再跑：避免 -c 一整段在 ps 里裸奔，也方便留下"跑了什么"的痕迹
    script = cwd / "_py_tool.py"
    script.write_text(code, encoding="utf-8")

    try:
        proc = await asyncio.create_subprocess_exec(
            "python3",
            str(script),
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
        except asyncio.TimeoutError:
            proc.kill()
            return f"✗ 超过 {timeout_s}s 被强制停止"
    except FileNotFoundError:
        return "✗ 服务器上没有 python3"

    out = stdout.decode("utf-8", errors="replace")
    if len(out) > PYTHON_OUTPUT_MAX:
        out = out[:PYTHON_OUTPUT_MAX] + f"\n…（输出超过 {PYTHON_OUTPUT_MAX // 1024}KB 已截断）"
    return out or "(没有输出)"


# --------------------------------------------------------------------------- #
# 工具登记表（sync-builtins 与 compile 共用的唯一真相）
# --------------------------------------------------------------------------- #
FETCH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "url": {"type": "string", "description": "要抓取的 http/https 地址"},
    },
    "required": ["url"],
}
SEARCH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "query": {"type": "string", "description": "搜索关键词"},
    },
    "required": ["query"],
}
READ_DOC_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "path": {"type": "string", "description": "会话工作目录里的文件路径（PDF/图片/Office 文档）"},
        "purpose": {
            "type": "string",
            "enum": ["text", "rich"],
            "description": "text=只要文字；rich=保留版面（带坐标标记，可用于定位/裁图）",
        },
        "max_pages": {"type": "integer", "description": "只回前 N 页正文（默认全回，但总字数有上限）"},
    },
    "required": ["path"],
}

TRANSCRIBE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "path": {"type": "string", "description": "会话工作目录里的音频文件（16bit PCM WAV / Ogg Opus，≤120 秒、≤8MiB）"},
    },
    "required": ["path"],
}

SPEAK_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "text": {"type": "string", "description": "要朗读的文本（≤10000 计费字符；汉字算 2 字符）"},
        "voice": {"type": "string", "enum": ["stella", "tide"], "description": "音色：stella 女声（默认）/ tide 男声"},
        "fmt": {"type": "string", "enum": ["wav", "pcm"], "description": "音频格式，默认 wav"},
    },
    "required": ["text"],
}

PYTHON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "code": {"type": "string", "description": "要执行的 Python 代码（在当前工作目录运行）"},
        "timeout_s": {"type": "integer", "description": f"超时秒数（默认 {PYTHON_TIMEOUT_S_DEFAULT}，上限 {PYTHON_TIMEOUT_S_MAX}）"},
    },
    "required": ["code"],
}

KNOWLEDGE_SEARCH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "query": {"type": "string", "description": "要查的内容或关键词（中文整句也行）"},
        "top_k": {"type": "integer", "description": "返回几条（默认 5，最多 20）"},
    },
    "required": ["query"],
}

MEMORY_SEARCH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "query": {"type": "string", "description": "要查什么（用自然语言写，别只写关键词）"},
        "top_k": {"type": "integer", "description": "最多要几条，默认 5"},
    },
    "required": ["query"],
}

MEMORY_SAVE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "content": {"type": "string", "description": "要记住的一句话（写清事实本身，别写'用户说了什么'）"},
        "tags": {
            "type": "array",
            "items": {"type": "string"},
            "description": "可选标签（外部记忆服务支持；平台内置记忆会写进正文）",
        },
        "pin": {
            "type": "boolean",
            "description": (
                "true = 常驻：以后每一轮都直接带上这条（不靠检索）。"
                "只给「用户是谁、环境事实、长期约定」这类每次都要知道的事；"
                "任务细节、一次性的结论不要 pin —— 常驻段有长度上限，塞满会挤掉正文。"
            ),
        },
        "layer": {
            "type": "string",
            "enum": ["user", "memory"],
            "description": (
                "user = 关于**用户**的（他是谁、偏好、正在做什么、在意什么）；"
                "memory = **你自己**的笔记（环境事实、某套做法、踩过的坑、结论）。"
                "判据：这句话主语是用户还是环境/事情。分错层的后果是模型把自己推断的东西"
                "当成用户亲口说过的话。默认 memory。"
            ),
        },
    },
    "required": ["content"],
}


async def _knowledge_search(query: str, top_k: int = 5) -> str:
    """**查知识中心里的文档**：返回命中的文档名 + 片段 + doc_id。

    与 read_document 的区别：那个读的是本次会话上传的文件，这个查的是
    已经入库、分好类、长期留存的知识（合同、规格书、内部文档）。
    """
    from .db import SessionLocal
    from .knowledge import service as kb

    text = (query or "").strip()
    if not text:
        return "查询为空。给一个关键词或一句话。"
    k = max(1, min(int(top_k or 5), 20))
    # 一句话里常常带几个词（"付款期限 多少天 账期"），整串去做 LIKE 必然查不到；
    # 拆成词逐个查再合并——这是"整句检索"最省事又不引入向量库的做法
    terms = [t for t in text.replace("，", " ").replace("、", " ").split() if len(t) >= 2][:6] or [text]
    merged: dict[str, dict] = {}
    async with SessionLocal() as session:
        for term in terms:
            for hit in await kb.search(session, term, limit=k, status="ready"):
                merged.setdefault(hit["id"], hit)
    hits = list(merged.values())[:k]
    if not hits:
        return f"知识库里没有和「{text}」相关的文档。可以换个说法，或先在知识中心上传。"
    lines = [f"在知识库中找到 {len(hits)} 份相关文档："]
    for i, h in enumerate(hits, 1):
        where = f" 第 {h['page']} 页" if h.get("page") else ""
        lines.append(f"{i}. 《{h['name']}》{where}（doc_id: {h['id']}）\n   片段：{h['snippet']}")
    lines.append("需要看全文就用 doc_id 调 read_document 或让用户打开文档详情。")
    return "\n".join(lines)


async def _memory_search(query: str, top_k: int = 5) -> str:
    """**主动查长期记忆**：内置（BM25）+ 配了就用外部，两边都问、合并去重。

    为什么给 Agent 这个工具
    ----------------------
    以前记忆只在执行开始时**自动**注入一次 System Prompt —— Agent 自己没法"想起来去查"
    （比如先干别的、中途才需要某个事实）。现在它可以随时查，且查的结果里会标出
    哪些来自内置、哪些来自外部记忆服务。
    """
    from .db import SessionLocal
    from .memory import external
    from .memory.recall import recall as _recall
    from .runner.ctx import current_run_ctx

    text = (query or "").strip()
    if not text:
        return "查询为空。"
    k = max(1, min(int(top_k or 5), 20))
    ctx = current_run_ctx()
    agent_id = str(ctx.get("agent_id") or "")

    local_lines: list[str] = []
    ext_lines: list[str] = []
    note = ""

    async with SessionLocal() as session:
        res = await _recall(session, agent_id, text, top_k=k, strategy="hybrid", max_chars=4000)
        local_lines = [f"- {m.content}" for m in res.memories]
        try:
            cfg = await external.load_config(session)
        except Exception:  # noqa: BLE001 —— 配置读不出来不该让工具炸
            cfg = None
        if cfg is not None and cfg.ready:
            try:
                for item in await external.search(cfg, text, top_k=k, agent_id=agent_id or None):
                    ext_lines.append(f"- {item.content}")
            except external.ExternalMemoryError as exc:
                note = f"\n（外部记忆服务这次没答上来：{exc}）"

    if not local_lines and not ext_lines:
        return "没有找到相关记忆。" + note
    parts: list[str] = []
    if local_lines:
        parts.append("【平台内置记忆】\n" + "\n".join(local_lines))
    if ext_lines:
        parts.append("【外部记忆服务】\n" + "\n".join(ext_lines))
    return "\n\n".join(parts) + note


SKILL_SAVE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "name": {
            "type": "string",
            "description": "技能名（短横线小写英文最好，如 deploy-static-site；中文也能用，别带斜杠）",
        },
        "description": {
            "type": "string",
            "description": "一句话说明**什么时候该用它** —— 以后助手就是靠这句话认出它的",
        },
        "body": {
            "type": "string",
            "description": "技能正文 Markdown：适用场景、步骤、命令、坑。写做法，别写这次的具体数据",
        },
        "overwrite": {
            "type": "boolean",
            "description": "同名技能已存在时是否覆盖（默认 false，会提示你换个名字或显式覆盖）",
        },
    },
    "required": ["name", "description", "body"],
}

#: 技能正文上限。技能是给下一次看的「做法」，不是这次的报告 —— 太长就没人读了。
SKILL_BODY_LIMIT = 20000


def _skill_slug(name: str) -> str:
    """名字 → 目录名。允许中文（Linux 上没问题），去掉路径符号，压掉多余横线。"""
    raw = (name or "").strip().lower()
    slug = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", raw, flags=re.UNICODE)
    slug = re.sub(r"-{2,}", "-", slug).strip("-.")
    return slug[:64]


async def _skill_save(
    name: str, description: str, body: str, overwrite: bool = False
) -> str:
    """**把这次的做法沉淀成一个全局技能**。

    为什么给 Agent 这个工具
    ----------------------
    以前技能只能从「技能」页导入或从仓库装 —— 助手在对话里摸出来的做法（先查什么、
    跑哪条命令、哪个坑要绕）聊完就散了，下次换一个人还得从头踩一遍。
    这个工具让它当场把做法写下来，落在**全局技能目录**里：任何挂了这个技能的助手
    下一轮就能读到。

    边界：同名默认不覆盖（技能是长期资产，不能被随手冲掉）；正文有长度上限；
    名字里的路径符号会被清掉（不允许写出目录）。
    """
    from sqlalchemy import select

    from .api.skills import _materialize
    from .db import SessionLocal
    from .models import Agent, AgentSkill, Skill
    from .runner.ctx import current_run_ctx

    slug = _skill_slug(name)
    desc = (description or "").strip()
    text = (body or "").strip()
    if not slug:
        return "技能名不能用（空名、或者只有符号）。用短横线小写英文，比如 deploy-static-site。"
    if not desc:
        return "缺一句话说明「什么时候用它」—— 没有这句，以后没人认得出这个技能。"
    if not text:
        return "正文是空的，没存。"
    if len(text) > SKILL_BODY_LIMIT:
        return (
            f"正文 {len(text)} 字，超过上限 {SKILL_BODY_LIMIT}。"
            "技能要短：写关键步骤和坑，细节留给下一次现场判断。"
        )

    content = f"---\nname: {slug}\ndescription: {desc}\n---\n\n{text}\n"
    ctx = current_run_ctx()
    agent_id = str(ctx.get("agent_id") or "")
    source = {
        "type": "agent",
        "agent_id": agent_id,
        "session_id": str(ctx.get("session_id") or ""),
        "run_id": str(ctx.get("run_id") or ""),
    }

    async with SessionLocal() as session:
        row = (
            await session.execute(select(Skill).where(Skill.name == slug))
        ).scalar_one_or_none()
        if row is not None and not overwrite:
            return (
                f"已经有同名技能「{slug}」（{row.id}）。"
                "要更新它就再调一次并把 overwrite 设成 true；想留一份新的就换个名字。"
            )

        if agent_id:
            agent = await session.get(Agent, agent_id)
            if agent is not None:
                source["agent_name"] = agent.name

        if row is None:
            row = Skill(name=slug, description=desc, content=content, files={}, source=source)
            session.add(row)
            await session.flush()
            action = "新建"
        else:
            row.content = content
            row.description = desc
            row.source = source
            from .models import now_ms

            row.updated_at = now_ms()
            action = "更新"

        mounted = False
        if agent_id:
            if await session.get(AgentSkill, {"agent_id": agent_id, "skill_id": row.id}) is None:
                session.add(AgentSkill(agent_id=agent_id, skill_id=row.id))
                mounted = True
        await session.commit()

        path = await _materialize(row)
        return json.dumps(
            {
                "ok": True,
                "action": action,
                "id": row.id,
                "name": slug,
                "path": str(path),
                "mounted_to_caller": mounted,
                "scope": "全局：出现在「技能」页，任何助手都能挂",
                "note": (
                    "这一轮已生效于技能目录（下一次工具调用就能读到）；"
                    "同名再存要带 overwrite=true"
                ),
            },
            ensure_ascii=False,
        )


async def _memory_save(
    content: str,
    tags: list[str] | None = None,
    pin: bool = False,
    layer: str = "memory",
) -> str:
    """**主动记一条**：内置直接生效（store-and-use）+ 配了外部就同时写外部。

    为什么改成直接生效（原来的候选制）：
    "记了但没生效"等于没记 —— 助手说完"我记住了"，下一轮照样不知道，
    用户还得去记忆页逐条点确认。Hermes 就是存完即用，这里对齐。
    退出机制仍然在：记忆页能逐条归档/删掉，来源标 agent 便于回查。
    """
    from .db import SessionLocal
    from .memory import external
    from .memory.policy import get_policy
    from .models import Memory, now_ms
    from .runner.ctx import current_run_ctx

    body = (content or "").strip()
    if not body:
        return "内容为空，没有存。"
    lay = "user" if str(layer or "").strip().lower() == "user" else "memory"
    tag_list = [str(t).strip() for t in (tags or []) if str(t).strip()]
    ctx = current_run_ctx()
    agent_id = str(ctx.get("agent_id") or "") or None
    run_id = str(ctx.get("run_id") or "") or None

    stored = body + (f"（标签：{'、'.join(tag_list)}）" if tag_list else "")
    async with SessionLocal() as session:
        # 保存方式由 Agent 的记忆策略决定：
        #   auto    → 直接 active（存完即用）
        #   confirm → candidate（进「待确认」，用户点了「记住」才算数）
        #   off     → 不存，如实告诉模型"这个助手关了记忆写入"
        save_mode = "auto"
        if agent_id:
            try:
                pol = await get_policy(session, agent_id)
                save_mode = getattr(pol, "save_mode", None) or "auto"
            except Exception:  # noqa: BLE001 —— 读不到策略就按默认（直接存）走
                save_mode = "auto"
        if save_mode == "off":
            return "这个助手关了记忆写入（记忆策略里设成了「不许存」），这条没存。要记的话让用户去记忆面板改。"
        status = "candidate" if save_mode == "confirm" else "active"
        session.add(
            Memory(
                agent_id=agent_id,
                scope="agent" if agent_id else "global",
                kind="fact",
                layer=lay,
                content=stored,
                source="agent",
                source_run_id=run_id,
                status=status,
                # 常驻的给高 importance：常驻段按它排序，超预算时先保重要的
                importance=0.9 if pin else 0.6,
                pinned=1 if pin else 0,
                created_at=now_ms(),
                updated_at=now_ms(),
            )
        )
        await session.commit()

        external_note = "（没配外部记忆服务，只存了内置）"
        try:
            cfg = await external.load_config(session)
            if cfg.ready:
                item_id = await external.add(cfg, body, tags=tag_list, agent_id=agent_id)
                external_note = f"已写入外部记忆服务{'（id: ' + item_id + '）' if item_id else ''}"
        except external.ExternalMemoryError as exc:
            external_note = f"外部记忆写入失败：{exc}"

    who = "关于用户的" if lay == "user" else ""
    if status == "candidate":
        return (
            f"已放进「待确认」：{who}「{body[:40]}…」—— 用户点「记住」之后才算数，"
            f"在那之前不会进上下文。{external_note}"
        )
    where = "常驻记忆（以后每一轮都会带上）" if pin else "记忆（下次提问相关时会召回）"
    return f"已记住{who}{where}；记多了可在记忆页归档。{external_note}"


# --------------------------------------------------------------------------- #
# 浏览器（headless Chromium + CDP 直连；画面实时推给页面，用户可接管输入）
# --------------------------------------------------------------------------- #
BROWSER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "action": {
            "type": "string",
            "enum": ["navigate", "click", "type", "read", "scroll", "wait", "wait_login"],
            "description": (
                "navigate=打开网址；click=点页面元素；type=往输入框打字；"
                "read=读当前页面文本；scroll=滚动；wait=等页面变化；"
                "wait_login=打开页面等用户在画面里亲自输入登录（账号密码不经模型）"
            ),
        },
        "url": {"type": "string", "description": "（navigate）要打开的网址，http/https"},
        "selector": {"type": "string", "description": "（click/type）CSS 选择器，如 #kw、.login-btn"},
        "value": {"type": "string", "description": "（type）要输入的文本"},
        "dy": {"type": "integer", "description": "（scroll）滚动的像素，负数向上"},
        "wait_s": {"type": "number", "description": "（navigate/wait）等待秒数"},
    },
    "required": ["action"],
}


async def _browser(
    action: str,
    url: str = "",
    selector: str = "",
    value: str = "",
    dy: int = 600,
    wait_s: float = 3.0,
) -> str:
    """操作一个真实浏览器（每个 run 独享、有状态的 Chromium 实例）。

    画面会实时显示在对话页上；需要登录时用 wait_login 让用户自己输入 ——
    凭证不进模型上下文。
    """
    from .browser_session import get_session
    from .runner.ctx import current_run_ctx

    try:
        ctx = current_run_ctx()
    except Exception:
        ctx = {}
    run_id = str(ctx.get("run_id") or "adhoc")
    if not run_id or run_id == "adhoc":
        return "✗ 浏览器工具只能在助手执行中使用（缺少 run 上下文）"

    # 帧回调：直接发到事件总线（SSE → 前端 <img>；不落库）
    from .runner.service import bus

    def on_frame(rid: str, data: str, page_url: str, title: str) -> None:
        bus.publish(
            rid,
            {
                "seq": -1,  # 不占事件序（帧不落库，去重逻辑按 seq<=last_seq 丢掉回放段即可）
                "type": "browser_frame",
                "ts": 0,
                "payload": {"frame": data, "url": page_url, "title": title},
            },
        )

    sess = get_session(run_id, on_frame, proxy=os.environ.get("STUDIO_BROWSER_PROXY") or None)

    # 动作字幕：前端把它显示成浏览器窗口底部的一行"它正在做什么"。
    # 为什么由后端发而不是解析工具入参：动作人话化要在一个地方定（打开 host / 点击 搜索框），
    # 前端不必认识 action 枚举，也不必猜 selector 是啥。
    def _emit(summary: str, target: str = "") -> None:
        bus.publish(
            run_id,
            {
                "seq": -2,  # 与帧一样不占事件序：纯直播，刷新后由工具调用记录还原
                "type": "browser_action",
                "ts": 0,
                "payload": {"action": action, "summary": summary, "target": target, "url": url},
            },
        )

    def _host(u: str) -> str:
        try:
            from urllib.parse import urlparse

            return urlparse(u).netloc or u
        except Exception:
            return u

    # 执行过程留档：动作执行完把"当时的画面 + 这一步是什么"存进会话目录。
    # 直播帧只进内存（seq<0），不存的话刷新就没了 —— 用户没法复盘它当时看到了什么。
    # 步号跨工具调用递增：`_browser` 每调一次是新函数执行，局部计数会一直从 1 开始
    # （实测三张图全叫 01-xxx.jpg）
    _step = {"n": int(getattr(sess, "_step_n", 0))}

    async def _record(summary: str, res: str) -> None:
        if str(res).startswith("✗"):
            return  # 失败的一步也值得记，但没画面（动作没生效）—— 索引里留不了图，跳过
        try:
            from .browser_trace import record_step
            from .runner.service import session_work_dir as _swd

            sid = str(ctx.get("session_id") or "")
            if not sid:
                return
            _step["n"] += 1
            sess._step_n = _step["n"]
            frame = await sess.snapshot()
            record_step(
                _swd(sid),
                run_id,
                _step["n"],
                action,
                summary,
                url=str(getattr(sess, "_last_url", "") or url),
                title=str(getattr(sess, "_last_title", "") or ""),
                frame_b64=frame,
            )
        except Exception:  # pragma: no cover
            logger.debug("记录浏览器步骤失败", exc_info=True)

    def _short(v: str, n: int = 24) -> str:
        v = (v or "").replace("\n", " ").strip()
        return v if len(v) <= n else v[: n - 1] + "…"

    # 用户暂停/接管时，下一步动作先等着（已发出的动作不打断，避免打坏页面状态）
    if action not in ("read", "wait"):
        from .browser_session import wait_if_paused

        _blocked = await wait_if_paused(run_id)
        if _blocked:
            return _blocked

    if action == "navigate":
        _emit(f"打开 {_host(url)}")
        _res = await sess.navigate(url or "about:blank", wait_s)
        await _record(f"打开 {_host(url)}", _res)
        return _res
    if action == "click":
        if not selector:
            return "✗ click 需要 selector"
        _emit(f"点击 {_short(selector)}", selector)
        _res = await sess.click(selector)
        await _record(f"点击 {_short(selector)}", _res)
        return _res
    if action == "type":
        if not selector:
            return "✗ type 需要 selector"
        _emit(f"输入「{_short(value, 16)}」", selector)
        _res = await sess.type_text(selector, value)
        # 输入的内容不进留档（可能是密码/手机号）—— 只记"输入了 16 个字符"
        await _record(f"输入了 {len(value or '')} 个字符", _res)
        return _res
    if action == "read":
        _emit("读页面内容")
        return await sess.read(selector or "body")  # 读不产生画面变化，不留档
    if action == "scroll":
        _emit("往下滚" if dy >= 0 else "往上滚")
        _res = await sess.scroll(dy)
        await _record("往下滚" if dy >= 0 else "往上滚", _res)
        return _res
    if action == "wait":
        _emit(f"等页面 {wait_s:g}s")
        return await sess.wait(wait_s)
    if action == "wait_login":
        # 暂停执行，等用户在页面的浏览器画面里亲手操作（输入账号密码/验证码）。
        # 用户点「已登录，继续」后恢复 —— 凭证全程不经模型。
        _emit("等你登录", "login")
        await sess.navigate(url, wait_s) if url else None
        return (
            "PAUSE_FOR_USER_LOGIN：已在页面上显示浏览器画面，等用户亲自完成登录。"
            "恢复后先用 browser(read) 确认登录态再继续任务。"
        )
    return f"✗ 未知动作: {action}"


# --------------------------------------------------------------------------- #
# 后台进程（proc_*）—— 跑得住比一轮对话更久的活
# --------------------------------------------------------------------------- #
# 为什么需要：bash / python 都是同步带超时的，一轮 run 有 timeout_s，
# 一个 build、一次训练、一批下载超过它就被掐死且无法补救。
# 归属是**会话**（不是 run）：关页面、run 结束、API 重启，进程照样在跑。
PROC_START_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "command": {"type": "string", "description": "要执行的 shell 命令（可含管道、&&）"},
        "label": {
            "type": "string",
            "description": "给这次任务起个人话名字（界面上显示，比如「构建前端」）；不填就用命令",
        },
        "cwd": {
            "type": "string",
            "description": "工作目录（默认就是当前会话目录；相对路径按它解析）",
        },
        "heartbeat_s": {
            "type": "integer",
            "description": (
                "心跳间隔（秒）：填了之后平台会每隔这么久往会话里发一条「还在跑 + 最近输出」，"
                "用户不用反复问进度。跑得久（几分钟以上）就填 60~300；短活留空"
            ),
        },
    },
    "required": ["command"],
}

PROC_POLL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "id": {"type": "string", "description": "proc_start 返回的 id；不填 = 看这个会话最新那个"},
    },
    "required": [],
}

PROC_LOG_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "id": {"type": "string", "description": "后台进程 id"},
        "lines": {"type": "integer", "description": "看最后多少行（默认 200，上限 2000）"},
    },
    "required": ["id"],
}

PROC_KILL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"id": {"type": "string", "description": "要停掉的后台进程 id"}},
    "required": ["id"],
}

PROC_LIST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {},
    "required": [],
}


def _proc_ctx() -> tuple[str, str, str, str]:
    """从 run 上下文取 (session_id, run_id, agent_id, workspace)。

    session_id 必须有 —— 后台进程的归属是会话；没有它我们宁可报错，
    也不猜"最近那个会话"（猜错就是 A 的进程跑到 B 的页面里）。
    """
    from .runner.ctx import current_run_ctx

    ctx = current_run_ctx()
    return (
        str(ctx.get("session_id") or ""),
        str(ctx.get("run_id") or ""),
        str(ctx.get("agent_id") or ""),
        str(ctx.get("workspace") or ""),
    )


async def _proc_start(command: str, label: str = "", cwd: str = "", heartbeat_s: int = 0) -> str:
    """起一个后台进程，立刻返回（不等它跑完）。"""
    from . import procs

    session_id, run_id, agent_id, workspace = _proc_ctx()
    if not session_id:
        return "错误：当前不在会话里，后台进程起不了（它必须挂在某个会话上）。"

    work = workspace or ""
    if cwd:
        base = Path(work) if work else Path.cwd()
        cand = (base / cwd).resolve() if not os.path.isabs(cwd) else Path(cwd).resolve()
        work = str(cand)

    try:
        info = await procs.start(
            session_id=session_id,
            command=command,
            cwd=work or None,
            label=label,
            run_id=run_id or None,
            agent_id=agent_id or None,
            heartbeat_s=heartbeat_s or 0,
        )
    except Exception as exc:
        return f"起后台进程失败：{exc}"
    beat = int(info.get("heartbeat_s") or 0)
    return (
        f"已启动：{info['id']}（pid {info['pid']}，{info['label']}）\n"
        f"它会在后台继续跑，你现在可以接着干别的；用 proc_poll 看进度（别用同步命令等它）。"
        + (f"\n已开启心跳：每 {beat} 秒往会话里报一次进展。" if beat else "")
    )


async def _proc_poll(id: str = "") -> str:
    """看后台进程的状态 + 尾部输出。"""
    from . import procs

    session_id, _, _, _ = _proc_ctx()
    if not session_id:
        return "错误：当前不在会话里。"
    if not id:
        items = await procs.list_for_session(session_id, limit=1)
        if not items:
            return "这个会话还没有起过后台进程。"
        id = items[0]["id"]
    row = await procs.poll(id, session_id=session_id)
    if row is None:
        return f"找不到后台进程 {id}（可能不是这个会话起的）。"
    status_cn = {
        "running": "正在跑",
        "exited": "已完成",
        "failed": "失败",
        "killed": "已停止",
        "unknown": "状态不明（服务重启过）",
    }.get(row["status"], row["status"])
    head = f"{row['id']}｜{row['label']}｜{status_cn}"
    if row["status"] != "running":
        head += f"（退出码 {row['exit_code']}）"
    head += f"｜已跑 {row['elapsed_s']}s"
    tail = (row.get("tail") or "").strip()
    body = tail[-1600:] if tail else "（还没有输出）"
    return f"{head}\n--- 输出尾部 ---\n{body}"


async def _proc_log(id: str, lines: int = 200) -> str:
    """读后台进程的日志（默认最后 200 行）。"""
    from . import procs

    session_id, _, _, _ = _proc_ctx()
    if not session_id:
        return "错误：当前不在会话里。"
    n = max(1, min(int(lines or 200), 2000))
    text = (await procs.log_text(id, session_id=session_id, lines=n)).strip()
    if not text:
        return f"{id} 还没有输出（或者不是这个会话起的）。"
    return text[-(n * 220) :]


async def _proc_kill(id: str) -> str:
    """停掉一个后台进程（连同它的子进程）。"""
    from . import procs

    session_id, _, _, _ = _proc_ctx()
    if not session_id:
        return "错误：当前不在会话里。"
    res = await procs.kill(id, session_id=session_id)
    if not res.get("ok"):
        return res.get("error") or "没停掉"
    return f"{id} 已停止（{res.get('status')}）。"


async def _proc_list() -> str:
    """列出这个会话起过的后台进程。"""
    from . import procs

    session_id, _, _, _ = _proc_ctx()
    if not session_id:
        return "错误：当前不在会话里。"
    items = await procs.list_for_session(session_id, limit=20)
    if not items:
        return "这个会话没有后台进程。"
    lines = []
    for r in items:
        mark = {"running": "▶", "exited": "✓", "failed": "✕", "killed": "■"}.get(r["status"], "?")
        lines.append(
            f"{mark} {r['id']}｜{r['label']}｜{r['status']}"
            f"{'' if r['status'] == 'running' else f'（{r['exit_code']}）'}"
            f"｜{r['elapsed_s']}s"
        )
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# 跨会话检索（session_search）
# --------------------------------------------------------------------------- #
SESSION_SEARCH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "query": {
            "type": "string",
            "description": "要找的内容（几个关键词，空格分开；不用打完整句子）",
        },
        "limit": {"type": "integer", "description": "最多几条（默认 6，上限 20）"},
        "mine_only": {
            "type": "boolean",
            "description": "只搜你自己（当前助手）聊过的会话；默认 false = 搜全部会话",
        },
    },
    "required": ["query"],
}


async def _session_search(query: str, limit: int = 6, mine_only: bool = False) -> str:
    """在**以前的会话**里找原话（跨会话检索）。"""
    from .search import search_messages

    _, _, agent_id, _ = _proc_ctx()
    hits = await search_messages(
        query,
        limit=max(1, min(int(limit or 6), 20)),
        agent_id=agent_id if mine_only else None,
    )
    if not hits:
        return f"没有在历史对话里找到「{query}」。换个说法或更短的关键词再试。"
    lines = []
    for h in hits:
        when = time.strftime("%Y-%m-%d %H:%M", time.localtime(h["ts"] / 1000))
        who = "我" if h["role"] == "assistant" else "用户"
        lines.append(f"[{when}｜{h['session_title']}｜{who}] {h['snippet']}")
    return f"在历史对话里找到 {len(hits)} 条：\n" + "\n".join(lines)


# --------------------------------------------------------------------------- #
# 定时任务（助手自己排班）
# --------------------------------------------------------------------------- #
#: 为什么助手要能自己排班：Hermes 的日常用法有一半是「每天/每周自动跑一次」。
#: 以前平台只能人在界面上挂任务 —— 用户在对话里说「每天早上帮我汇总新闻」，
#: 助手只能说"我做不到"，或者答应用户明天再问它一遍。
#: 归属仍是**会话**（结果回到对话里，能接着追问），复用既有 SessionJob / tick / 投递队列。
JOB_CREATE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "prompt": {
            "type": "string",
            "description": "每次到点替你做的事（写清楚要什么、产出什么格式、多少条以内）",
        },
        "mode": {
            "type": "string",
            "enum": ["hourly", "daily", "weekly"],
            "description": "频率：每小时 / 每天 / 每周",
        },
        "at": {"type": "string", "description": "每天或每周几点几分，HH:MM（例如 09:00）；hourly 时忽略"},
        "weekdays": {
            "type": "string",
            "description": "每周几跑：1=周一 … 7=周日，可多选如 \"1,3,5\"（仅 weekly 用）",
        },
        "deliver": {
            "type": "string",
            "enum": ["session", "webhook"],
            "description": "结果送到哪：session=回到这个对话（默认）；webhook=推到一个地址",
        },
        "webhook_url": {"type": "string", "description": "deliver=webhook 时的地址（http/https）"},
    },
    "required": ["prompt"],
}

JOB_LIST_SCHEMA: dict[str, Any] = {"type": "object", "properties": {}, "required": []}

JOB_CANCEL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"id": {"type": "string", "description": "任务 id（job_list 里拿到的 sj_…）"}},
    "required": ["id"],
}

_MODE_WORD = {"hourly": "每小时的整点", "daily": "每天", "weekly": "每周"}


async def _job_create(
    prompt: str,
    mode: str = "daily",
    at: str = "09:00",
    weekdays: str = "1",
    deliver: str = "session",
    webhook_url: str = "",
) -> str:
    """在这个会话上排一个定时任务（到点自动跑一轮，结果回到这里）。"""
    from .db import SessionLocal
    from .jobs import describe_schedule, next_for, normalise_deliver
    from .models import Session, SessionJob, now_ms
    from .scheduler import SCHEDULE_MODES

    session_id, _, _, _ = _proc_ctx()
    if not session_id:
        return "错误：当前不在会话里，排不了班（定时任务必须挂在某个会话上）。"

    text = (prompt or "").strip()
    if not text:
        return "要写清楚每次到点替你做什么（一句话），否则跑起来也是空的。"

    m = (mode or "daily").strip().lower()
    if m not in SCHEDULE_MODES:
        return "频率只能是 hourly（每小时）/ daily（每天）/ weekly（每周）。"

    conf: dict[str, Any] = {"channel": (deliver or "session").strip().lower()}
    if conf["channel"] == "webhook":
        url = (webhook_url or "").strip()
        if not url.startswith(("http://", "https://")):
            return "推到 webhook 必须给 http/https 地址。"
        conf["url"] = url
        conf["format"] = "generic"

    try:
        deliver_conf = normalise_deliver(conf)
    except ValueError as exc:
        return f"投递配置不合法：{exc}"

    async with SessionLocal() as db:
        chat = await db.get(Session, session_id)
        if chat is None:
            return "会话不存在，排不了班。"
        job = SessionJob(
            session_id=session_id,
            agent_id=chat.agent_id,
            prompt=text,
            mode=m,
            at=(at or "09:00").strip(),
            weekdays=(weekdays or "1").strip(),
            enabled=1,
            deliver=deliver_conf,
            monitor_kind="",
            monitor="",
            monitor_last="",
            created_at=now_ms(),
            updated_at=now_ms(),
        )
        job.next_run_at = next_for(job)
        db.add(job)
        await db.commit()
        await db.refresh(job)

    when = describe_schedule(job.mode, job.at, job.weekdays)
    where = "这个对话" if deliver_conf.get("channel") == "session" else f"webhook（{deliver_conf.get('url', '')}）"
    return (
        f"已排好：{job.id}\n"
        f"时间：{when}（下一次 {_fmt_ts(job.next_run_at)}）\n"
        f"每次做的事：{text[:80]}\n"
        f"结果送到：{where}\n"
        "提醒：定时任务是**无人值守**的 —— 需要你点头才能做的操作会被直接拒绝，"
        "所以任务描述里别让它等你确认，能做多少做多少。"
    )


def _fmt_ts(ms: int | None) -> str:
    if not ms:
        return "（还没排上）"
    try:
        return time.strftime("%m-%d %H:%M", time.localtime(ms / 1000))
    except (ValueError, OSError):  # pragma: no cover
        return str(ms)


async def _job_list() -> str:
    """看这个会话排了哪些定时任务。"""
    from sqlalchemy import select

    from .db import SessionLocal
    from .jobs import describe_schedule
    from .models import SessionJob

    session_id, _, _, _ = _proc_ctx()
    if not session_id:
        return "错误：当前不在会话里。"
    async with SessionLocal() as db:
        rows = list(
            (
                await db.execute(
                    select(SessionJob)
                    .where(SessionJob.session_id == session_id)
                    .order_by(SessionJob.created_at.desc())
                )
            ).scalars()
        )
    if not rows:
        return "这个会话还没排过定时任务。"
    lines = [f"这个会话有 {len(rows)} 个定时任务："]
    for j in rows:
        state = "开着" if j.enabled else "已停"
        lines.append(
            f"- {j.id}｜{describe_schedule(j.mode, j.at, j.weekdays)}｜{state}｜"
            f"下次 {_fmt_ts(j.next_run_at)}｜{j.prompt[:50]}"
        )
    return "\n".join(lines)


async def _job_cancel(id: str = "") -> str:
    """删掉一个定时任务（id 从 job_list 里拿）。"""
    from .db import SessionLocal
    from .models import SessionJob

    session_id, _, _, _ = _proc_ctx()
    job_id = (id or "").strip()
    if not job_id:
        return "要给任务 id（先 job_list 看）。"
    async with SessionLocal() as db:
        job = await db.get(SessionJob, job_id)
        if job is None or job.session_id != session_id:
            return f"这个会话里没有任务 {job_id}。"
        await db.delete(job)
        await db.commit()
    return f"已删掉定时任务 {job_id}。"


# --------------------------------------------------------------------------- #
# 工具按需加载（lazy tools）
# --------------------------------------------------------------------------- #
#: 为什么要有这块：助手动辄挂 27~30 个工具，每轮请求都把**全部工具的完整 schema**
#: 发给模型 —— 实测 23 个工具约 1.7 万 token，光工具定义就比正文贵几倍，还拖慢首字。
#: 做法（与 Hermes 同一套路）：常用工具直接给；其余先只在提示里列「名字 + 一句话」，
#: 模型判断要用时 tool_search → tool_describe → tool_call 三步取用。
#: 注册表按 **run_id** 存放（不是全局）：同一进程里并行跑多个助手/子任务时互不串味。
_LAZY_BY_RUN: dict[str, dict[str, Any]] = {}
_LAZY_MAX_RUNS = 200

# --------------------------------------------------------------------------- #
# tool_search 的检索引擎状态（模块级单例，见 toolsearch.py）
# --------------------------------------------------------------------------- #
from .toolsearch import DenseIndex as _DenseIndex, LruCache as _LruCache  # noqa: E402

#: 语义缓存：⟨query+工具集指纹, 格式化结果⟩ —— agent 一轮里常重搜同义 query
_TOOLSEARCH_CACHE: "_LruCache" = _LruCache(capacity=64)
#: 稠密路向量缓存（工具集 fingerprint 变了才重算）
_TOOLSEARCH_DENSE: "_DenseIndex" = _DenseIndex()

#: embedding 端点配置的 app_setting key（与 memory_external 同一约定：JSON 文本）
_TOOLSEARCH_EMBED_KEY = "toolsearch_embedding"


def _toolsearch_embed_fn():
    """从 app_setting 读 embedding 端点，包成 toolsearch.EmbedFn。

    配置形如 ``{"base_url": ".../v1", "api_key": "...", "model": "text-embedding-v4"}``。
    没配置就返回 None —— tool_search 纯 BM25 照常工作，稠密路是增强不是依赖。
    """
    import sqlite3 as _sq

    from .models import AppSetting as _AS

    raw = None
    try:
        from .config import settings

        with _sq.connect(str(settings.db_path)) as _conn:
            _row = _conn.execute(
                f"SELECT value FROM {_AS.__tablename__} WHERE key = '{_TOOLSEARCH_EMBED_KEY}'"
            ).fetchone()
            raw = _row[0] if _row else None
    except Exception:  # noqa: BLE001 —— 读不到配置就当没配
        return None
    if not raw:
        return None
    try:
        conf = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except json.JSONDecodeError:
        return None
    base_url = str(conf.get("base_url") or "").strip().rstrip("/")
    # api_key 密文落库（app_settings.py PUT 时 Fernet 加密）——读侧解密；
    # 兼容历史明文字段（若有，直接用，等下次保存即变密文）
    api_key = str(conf.get("api_key") or "").strip()
    if not api_key:
        enc = conf.get("api_key_enc")
        if enc:
            try:
                from .security.crypto import decrypt

                api_key = decrypt(enc.encode() if isinstance(enc, str) else enc).strip()
            except Exception:  # noqa: BLE001 —— 解不开=主密钥变更，稠密路降级
                return None
    model = str(conf.get("model") or "").strip()
    if not (base_url and api_key and model):
        return None

    async def _embed(texts: list[str]):
        import httpx as _hx

        async with _hx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            resp = await client.post(
                f"{base_url}/embeddings",
                headers={"Authorization": f"Bearer {api_key}"},
                json={"model": model, "input": texts},
            )
            resp.raise_for_status()
            data = resp.json().get("data") or []
            return [d.get("embedding") for d in data if d.get("embedding")]

    return _embed


def tool_name(tool: Any) -> str:
    return str(getattr(tool, "name", "") or getattr(tool, "__name__", "") or "")


def tool_desc(tool: Any) -> str:
    d = getattr(tool, "description", "") or ""
    if not d:
        doc = getattr(tool, "__doc__", "") or ""
        d = doc
    return " ".join(str(d).split())


def tool_schema(tool: Any) -> dict[str, Any]:
    for attr in ("input_schema", "json_schema", "parameters"):
        v = getattr(tool, attr, None)
        if isinstance(v, dict) and v:
            return v
    return {"type": "object", "properties": {}}


def register_lazy_tools(run_id: str | None, tools: list[Any]) -> dict[str, Any]:
    """把「这一轮没直接给模型」的工具登记起来，供 tool_* 三个入口按名字取用。"""
    table: dict[str, Any] = {}
    for t in tools:
        n = tool_name(t)
        if n:
            table[n] = t
    if run_id:
        _LAZY_BY_RUN[str(run_id)] = table
        while len(_LAZY_BY_RUN) > _LAZY_MAX_RUNS:
            _LAZY_BY_RUN.pop(next(iter(_LAZY_BY_RUN)), None)
    return table


def drop_lazy_tools(run_id: str | None) -> None:
    if run_id:
        _LAZY_BY_RUN.pop(str(run_id), None)


def _current_lazy() -> dict[str, Any]:
    try:
        from .runner.ctx import current_run_ctx

        rid = str(current_run_ctx().get("run_id") or "")
    except Exception:  # noqa: BLE001 —— 取不到上下文就当没有懒加载工具
        return {}
    return _LAZY_BY_RUN.get(rid, {}) if rid else {}


TOOL_SEARCH_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "queries": {
            "type": "array",
            "items": {"type": "string"},
            "description": "要做的事，用几个关键词，例如 [\"后台进程\", \"定时任务\"]",
        },
        "limit": {"type": "integer", "description": "最多返回几条（默认 8）"},
    },
    "required": ["queries"],
}

TOOL_DESCRIBE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "names": {"type": "array", "items": {"type": "string"}, "description": "工具名列表"}
    },
    "required": ["names"],
}

TOOL_CALL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "description": "工具名（先 tool_describe 确认参数）"},
        # 只声明 object：某些 provider 不接受 Union 类型（实测直接 TypeError）。
        # 模型硬塞字符串也没关系 —— _tool_call 会尝试解析。
        "arguments": {
            "description": "这个工具的参数，JSON 对象",
            "type": "object",
        },
    },
    "required": ["name"],
}


async def _tool_search(queries: list[str] | None = None, limit: int = 8) -> str:
    """按需工具检索：BM25 稀疏路 + 向量稠密路 → RRF 融合。

    机制来自 MCP Gateway（ATC 2026）§4.3/§6.3：双路独立检索取并集、
    按名次 RRF 融合 —— 稀疏路保精确词匹配（工具名/参数名是标识符），
    稠密路保换说法（描述是自然语言），单路在对方强项上都会掉到 70% 以下。
    """
    table = _current_lazy()
    if not table:
        return "这一轮没有按需加载的工具：所有工具都已经直接给到你，直接调用即可。"
    qs = [str(q).strip() for q in (queries or []) if str(q).strip()]
    if not qs:
        return "queries 不能为空：用几个关键词描述要做的事。"
    query = " ".join(qs)

    from .toolsearch import (
        DenseIndex,
        LruCache,
        SparseIndex,
        cache_key,
        index_text,
        looks_like_id_only,
        rrf_fuse,
        weak_signal_hint,
    )

    # ID-only / 弱语义 query：两路都救不了（词面无实词、embedding 无语义），
    # 返回引导而不是硬搜 —— 对应论文 Lesson 4（98.2→99.7 的最后一跳）。
    if looks_like_id_only(query):
        return weak_signal_hint(query)

    # 指纹必须含**内容**而不只是名字集合：同名工具热更新描述后，
    # 旧指纹会命中旧向量（稠密路重算被跳过）和旧结果缓存
    docs = {n: index_text(n, tool_desc(t), tool_schema(t)) for n, t in table.items()}
    content_sig = ",".join(sorted(f"{n}:{hash(docs[n])}" for n in docs))
    fingerprint = f"{len(table)}:{content_sig}"
    limit_n = max(1, min(int(limit or 8), 20))

    _cache: LruCache = _TOOLSEARCH_CACHE
    ck = cache_key(query, fingerprint, limit_n)
    hit = _cache.get(ck)
    if hit is not None:
        return hit

    sparse = SparseIndex(docs)
    sparse_ranked: list[str] = []
    for q in qs:
        sparse_ranked.extend(sparse.search(q, top_l=120))

    # 稠密路：embedding 端点没配/失败时静默降级为纯稀疏 —— 增强不是依赖
    dense_ranked: list[str] = []
    embed = _toolsearch_embed_fn()
    if embed is not None:
        dense = _TOOLSEARCH_DENSE
        try:
            if await dense.ensure(docs, embed, fingerprint):
                qvecs = await embed([query])
                if qvecs and qvecs[0]:
                    # 多 query 不各嵌一次（太贵）：首 query 嵌一次，其余 query
                    # 靠稀疏路补位 —— RRF 的并集语义保证单路命中也保留
                    dense_ranked.extend(dense.search(qvecs[0], top_l=120))
        except Exception:  # noqa: BLE001 —— 稠密路任何异常都不影响稀疏路返回
            logger.debug("tool_search 稠密路失败，降级纯稀疏", exc_info=True)

    fused = rrf_fuse([sparse_ranked, dense_ranked], k=20, top_k=limit_n)
    if not fused:
        listing = "\n".join(f"- {n}：{tool_desc(t)[:90]}" for n, t in sorted(table.items()))
        return "没匹配到关键词。当前可按需取用的工具全集：\n" + listing[:3000]
    lines = ["匹配到的工具（先 tool_describe 看参数，再 tool_call 调用）："]
    for n in fused:
        lines.append(f"- {n}：{tool_desc(table[n])[:130]}")
    text = "\n".join(lines)
    _cache.put(ck, text)
    return text


async def _tool_describe(names: list[str] | None = None) -> str:
    table = _current_lazy()
    wanted = [str(n).strip() for n in (names or []) if str(n).strip()]
    if not table:
        return "这一轮没有按需加载的工具。"
    out: dict[str, Any] = {}
    missing: list[str] = []
    for n in wanted:
        t = table.get(n) or next((v for k, v in table.items() if k.lower() == n.lower()), None)
        if t is None:
            missing.append(n)
            continue
        out[tool_name(t) or n] = {"description": tool_desc(t), "parameters": tool_schema(t)}
    text = json.dumps(out, ensure_ascii=False, indent=2) if out else ""
    if missing:
        text += f"\n\n没有这些工具：{', '.join(missing)}（用 tool_search 查名字）"
    return text


def _render_tool_result(res: Any) -> str:
    content = getattr(res, "content", None)
    if isinstance(content, list):
        parts = []
        for b in content:
            txt = getattr(b, "text", None)
            if txt is None and isinstance(b, dict):
                txt = b.get("text")
            if txt:
                parts.append(str(txt))
        if parts:
            return "\n".join(parts)
    return str(res)


async def _tool_call(name: str, arguments: Any = None) -> str:
    table = _current_lazy()
    if not table:
        return "这一轮没有按需加载的工具。"
    tool = table.get(str(name or "").strip())
    if tool is None:
        return f"没有叫 {name} 的工具。先用 tool_search 查一下名字。"

    args: dict[str, Any] = {}
    if isinstance(arguments, str) and arguments.strip():
        try:
            parsed = json.loads(arguments)
            args = parsed if isinstance(parsed, dict) else {"value": parsed}
        except json.JSONDecodeError:
            return '参数不是合法 JSON：请传 JSON 对象，例如 {"query": "..."}'
    elif isinstance(arguments, dict):
        args = arguments

    try:
        fn = getattr(tool, "call", None) or tool
        res = fn(**args)
        if asyncio.iscoroutine(res) or hasattr(res, "__await__"):
            res = await res
    except TypeError as exc:
        return f"参数不对（{exc}）。先用 tool_describe 看这个工具要什么参数。"
    except Exception as exc:  # noqa: BLE001 —— 工具自己的异常原样交回模型
        return f"{name} 执行出错：{type(exc).__name__}: {exc}"
    return _render_tool_result(res)


DISPATCH_SCHEMA = {
    "type": "object",
    "properties": {
        "task": {"type": "string", "description": "要它做什么、产出什么（写清楚，越具体越好）"},
        "agent": {"type": "string", "description": "派给谁（助手名字）；不填=第一位干活的助手"},
        "title": {"type": "string", "description": "这张票叫什么（不填就取 task 前 24 字）"},
        "wait": {
            "type": "boolean",
            "description": "true=站在这儿等它做完再回话（只有必须拿到结果才能继续时才用）；默认 false，派完就回",
        },
        "mode": {
            "type": "string",
            "enum": ["auto", "reuse", "new"],
            "description": (
                "复用还是新开：auto（默认）=这条对话里他手上那件还开着且他闲着，就续用同一个 worker 会话；"
                "reuse=必须复用；new=另起一件活（新会话，上下文不共享）"
            ),
        },
    },
    "required": ["task"],
}


async def _dispatch(
    task: str,
    agent: str | None = None,
    title: str | None = None,
    wait: bool = False,
    mode: str = "auto",
) -> str:
    """把一件事派给一位 worker，**它有自己的会话和上下文**，回来只写一条报告。

    这是 Router 唯一"做事"的方式：它不自己搜、不自己读、不自己写，只决定"派给谁、做什么"。
    返回值就是 worker 的结果摘要 —— Router 拿到后决定继续派、还是回报给人。
    """
    from sqlalchemy import select

    from . import supervisor
    from .db import SessionLocal
    from .models import Agent
    from .runner.ctx import current_run_ctx

    text = (task or "").strip()
    if not text:
        return "task 不能为空：写清楚要它做什么。"
    ctx = current_run_ctx()
    agent_id = str(ctx.get("agent_id") or "")
    session_id = str(ctx.get("session_id") or "")

    async with SessionLocal() as session:
        target = None
        if agent:
            # 同名可能有两个：本地的助手，和远端 A2A 注册进来的影子 Agent。
            # 用户说名字时默认指本地那个；要派远端就写远端自己的名字。
            rows = [
                a
                for a in (
                    await session.execute(select(Agent).where(Agent.name == agent.strip()).order_by(Agent.created_at))
                ).scalars().all()
                if (a.definition or {}).get("disabled") is not True
            ]
            if not rows:
                names = list((await session.execute(select(Agent.name).order_by(Agent.created_at))).scalars())
                uniq = list(dict.fromkeys(names))
                return f"没有叫「{agent}」的助手。现有：{'、'.join(uniq) or '（一个都没有）'}"
            target = next(
                (a for a in rows if str((a.definition or {}).get("runtime") or "") != "a2a"), rows[0]
            )
        if target is None:
            rows = (await session.execute(select(Agent).order_by(Agent.created_at))).scalars().all()
            for a in rows:
                if a.id != agent_id and ((a.definition or {}).get("role") or "worker") != "orchestrator":
                    target = a
                    break
        if target is None:
            return "没有可派的助手：先去建一个干活（role=worker）的助手。"

        # ── 复用还是新开 ──────────────────────────────────────────────
        # 一个 Router 对 N 个 worker，但不是"每句话都新起一个人"：
        #   · 他手上还有没跑完的活 → 不派（同一段上下文里并发两件，结果会互相踩）
        #   · 这条对话里他还开着一件、且他闲着 → 续用那个 worker 会话（上下文连续）
        #   · 否则 → 新开一件（新票 + 新会话）
        thread = supervisor.thread_of(session_id)
        busy = await supervisor.agent_busy(session, target.id)
        if busy is not None and mode != "new":
            return (
                f"{target.name} 手上还有一件在跑（run {busy.id}），先等它回来再派；"
                f"要并行就换个人，或显式 mode=new 另起一件（上下文不共享）。"
            )
        existing = await supervisor.open_ticket_for(session, thread, target.id)
        reuse = mode == "reuse" or (mode == "auto" and existing is not None)
        ticket = (
            existing
            if (reuse and existing is not None)
            else await supervisor.ensure_ticket(
                session,
                thread_id=thread,
                title=(title or text)[:200],
                agent_id=target.id,
                source="chat",
                # 一张票 = 一件事（一块活）。同一个域的人再派同一块才复用；
                # 换个人/换块活就是另一张票 —— 否则一张票上会同时挂着几个域的人。
                force_new=True,
            )
        )
        if ticket is None:  # pragma: no cover - 类型收敛
            return "派活失败：没有拿到票。"
        parent_run = str(ctx.get("run_id") or "") or None

        # 远端 A2A 助手：同一条派活语义，只是"谁在干"在别的平台。
        # 本地照样开 run（runtime=a2a）当记录与链路，执行走后端任务。
        if str((target.definition or {}).get("runtime") or "") == "a2a":
            run = await supervisor.start_remote_worker(
                session, ticket, target, text, parent_run_id=parent_run
            )
            st, label = supervisor.stage_of(ticket)
            await supervisor.exec_remote_worker(
                run_id=run.id,
                agent_id=target.id,
                ticket_id=ticket.id,
                parent_run_id=parent_run or "",
                session_id=session_id or "",
            )
            how = "复用了他手上的会话" if reuse else "新开了一件"
            return (
                f"已派给【{target.name}】（远端 A2A · 票 {ticket.id}，现在「{label}」，{how}）。"
                f"它在对面平台执行，跑完会自己回来汇报。"
            )

        run = await supervisor.start_worker(session, ticket, target, text, parent_run_id=parent_run)

        # 默认**不等**：派完就把手腾出来继续判断、继续派（1 个 Router 对 N 个 worker）。
        # 活干完是事件 —— 由 supervisor 盯着，跑完自动写报告，攒齐一批再叫 Router 收口。
        if not wait:
            if parent_run:
                await supervisor.watch_worker(
                    parent_run_id=parent_run,
                    session_id=str(ctx.get("session_id") or "") or "",
                    run_id=run.id,
                    ticket_id=ticket.id,
                    agent_name=target.name,
                )
            st, label = supervisor.stage_of(ticket)
            how = "复用了他手上的会话" if reuse else "新开了一件"
            return (
                f"已派给【{target.name}】（票 {ticket.id}，run {run.id}，现在「{label}」，{how}）。"
                f"派完不撒手：用 worker_status 巡它的进度，发现绕路/失败用 worker_steer 纠偏，"
                f"方向错了用 worker_stop 停掉重派。它跑完的结果会自动回到这张票上。"
            )

        done = await supervisor.wait_run(session, run.id, timeout_s=900)
        body = supervisor.summarize(done)
        kind = "ready" if done.status == "ok" else ("failed" if done.status == "error" else "blocked")
        if done.status == "aborted":
            body = f"（执行被中止：{done.error or '无需原因'}）\n{body}"
        await supervisor.report(
            session, ticket, kind, body or (done.error or ""), run_id=done.id, run_status=done.status
        )
        st, label = supervisor.stage_of(ticket)
        how = "复用了他手上的会话" if reuse else "新开了一件"
        head = f"【{target.name}】{kind}（票 {ticket.id}，现在「{label}」，{how}）"
        return f"{head}\n\n{body or ('（没有产出：' + (done.error or done.status) + '）')}"



WORKERS_SCHEMA = {
    "type": "object",
    "properties": {},
    "required": [],
}


async def _workers() -> str:
    """列出现在可以派的 worker：名字 + 业务域/能力 + 挂了哪些工具。

    Router 是「项目 RDO」：需求常常跨域，得先知道有哪些域的人，再按域派。
    这个工具只读目录，不动任何东西。
    """
    from sqlalchemy import select

    from .db import SessionLocal
    from .models import Agent

    from .models import Run

    async with SessionLocal() as s:
        rows = (await s.execute(select(Agent).order_by(Agent.created_at.asc()))).scalars().all()
        running = {
            r.agent_id
            for r in (
                await s.execute(
                    select(Run).where(Run.origin == "worker", Run.status.in_(("pending", "running")))
                )
            ).scalars().all()
        }
    out = []
    for a in rows:
        d = a.definition or {}
        if (d.get("role") or "worker") == "orchestrator":
            continue
        if d.get("disabled") is True:  # 远端已停用：不在可派清单里
            continue
        desc = (a.description or "").strip().replace("\n", " ") or "（没写域/能力，按名字判断）"
        remote = str(d.get("runtime") or "") == "a2a"
        tools = [t.get("ref") for t in (d.get("tools") or []) if isinstance(t, dict)]
        # 手上有没有活：Router 据此决定"复用他的会话 / 等他回来 / 另开一件"
        hand = "手上还有一件在跑（先别派，或 mode=new 另起）" if a.id in running else "空闲（可以复用他的会话）"
        tail = "远端 A2A" if remote else f"工具 {len(tools)} 个"
        out.append(f"- {a.name}：{desc[:120]}｜{tail}｜{hand}")
    if not out:
        return "现在没有可派的 worker（去 Agents 页建一个 role=worker 的助手）。"
    return "可以派的 worker（按业务域分）：\n" + "\n".join(out)

NATIVE_TOOLS: dict[str, dict[str, Any]] = {
    "dispatch": {
        "fn": _dispatch,
        "description": (
            "把一件事派给一位 worker 去做：它有自己的会话和上下文，做完只写一条报告回来。"
            "你自己不要动手做（搜网页、读文件、跑命令），只决定派给谁、做什么。"
        ),
        "schema": DISPATCH_SCHEMA,
        # 按"只读"对待：派活本身不改任何外部状态（真正的写发生在 worker 自己的工具里，
        # 由那个会话的权限策略把关）。按非只读处理的话，AgentScope 会在每次派活前要人确认 ——
        # 定时/事件触发的场景会直接卡死在 waiting_hitl（fork 当年就是这么踩的）。
        "flags": {"read_only": True, "concurrency_safe": False, "dangerous": False, "native": True},
    },
    "workers": {
        "fn": _workers,
        "description": (
            "看现在有哪些 worker 可派、各自是什么业务域/能力（名字 + 域 + 工具数）。"
            "需求跨域时先用它看清谁合适，再按域派活。"
        ),
        "schema": WORKERS_SCHEMA,
        "flags": {"read_only": True, "concurrency_safe": True, "dangerous": False, "native": True},
    },
    "fetch": {
        "fn": _fetch,
        "description": "抓取一个网页或接口，返回文本（HTML 自动转成可读文本）。不能访问内网地址。",
        "schema": FETCH_SCHEMA,
        "flags": {"read_only": True, "concurrency_safe": True, "dangerous": False, "native": True},
    },
    "job_create": {
        "fn": _job_create,
        "description": (
            "在这个会话上排一个定时任务：到点自动跑一轮（「每天早上 9 点汇总三条新闻」）。"
            "结果默认回到这个对话。注意定时执行是无人值守的，需要人工确认的操作会被拒绝。"
        ),
        "schema": JOB_CREATE_SCHEMA,
        "flags": {"read_only": False, "concurrency_safe": True, "dangerous": False, "native": True},
    },
    "job_list": {
        "fn": _job_list,
        "description": "看这个会话排了哪些定时任务（时间、下次跑点、开着还是停了）。",
        "schema": JOB_LIST_SCHEMA,
        "flags": {"read_only": True, "concurrency_safe": True, "dangerous": False, "native": True},
    },
    "job_cancel": {
        "fn": _job_cancel,
        "description": "删掉一个定时任务（id 从 job_list 拿）。",
        "schema": JOB_CANCEL_SCHEMA,
        "flags": {"read_only": False, "concurrency_safe": True, "dangerous": True, "native": True},
    },
    "tool_search": {
        "fn": _tool_search,
        "description": (
            "按关键词查「这一轮按需加载的工具」清单，返回名字 + 一句话用途。"
            "平台默认只把常用工具直接给你，其它工具这样查出来再用。"
        ),
        "schema": TOOL_SEARCH_SCHEMA,
        "flags": {"read_only": True, "concurrency_safe": True, "dangerous": False, "native": True},
    },
    "tool_describe": {
        "fn": _tool_describe,
        "description": "看某个按需加载工具的参数定义（调用前用它确认参数，别猜）。",
        "schema": TOOL_DESCRIBE_SCHEMA,
        "flags": {"read_only": True, "concurrency_safe": True, "dangerous": False, "native": True},
    },
    "tool_call": {
        "fn": _tool_call,
        "description": (
            "调用一个按需加载的工具：name + arguments(JSON)。"
            "先用 tool_search 找名字、tool_describe 看参数，再这里传参执行。"
        ),
        "schema": TOOL_CALL_SCHEMA,
        "flags": {"read_only": False, "concurrency_safe": False, "dangerous": False, "native": True},
    },
    "web_search": {
        "fn": _web_search,
        "description": (
            "搜索互联网，返回前几条结果的标题、摘要和链接。"
            "支持 site:/lang:/after: 等语法（例如 \"DeepSeek site:github.com lang:zh after:2025\"）。"
            "配了 DeepSeek 工具密钥时会带相关度与权威度，可据此判断可信程度。"
        ),
        "schema": SEARCH_SCHEMA,
        "flags": {"read_only": True, "concurrency_safe": True, "dangerous": False, "native": True},
    },
    "read_document": {
        "fn": _read_document,
        "description": (
            "读取上传的文档（PDF / 图片 / Word / PPT）里的文字，按页返回。"
            "扫描件、截图、合同、规格书都用它；文件路径来自会话文件列表。"
        ),
        "schema": READ_DOC_SCHEMA,
        "flags": {"read_only": True, "concurrency_safe": False, "dangerous": False, "native": True},
    },
    "transcribe": {
        "fn": _transcribe,
        "description": "把上传的音频转成文字（≤120 秒）。会议录音、语音留言先转写再总结。",
        "schema": TRANSCRIBE_SCHEMA,
        "flags": {"read_only": True, "concurrency_safe": False, "dangerous": False, "native": True},
    },
    "speak": {
        "fn": _speak,
        "description": "把一段文字合成语音，文件落在 product/，用户可下载或播放。备选能力，长文分段调用。",
        "schema": SPEAK_SCHEMA,
        "flags": {"read_only": False, "concurrency_safe": False, "dangerous": False, "native": True},
    },
    "knowledge_search": {
        "fn": _knowledge_search,
        "description": (
            "在知识中心的文档库里全文检索（合同、规格书、内部规范这类长期留存的知识），"
            "返回文档名、命中片段和 doc_id。要引用公司资料、查以前归档的文档时用它；"
            "查不到再考虑 web_search。"
        ),
        "schema": KNOWLEDGE_SEARCH_SCHEMA,
        "flags": {"read_only": True, "concurrency_safe": True, "dangerous": False, "native": True},
    },
    "memory_search": {
        "fn": _memory_search,
        "description": (
            "查长期记忆（平台内置 + 配置了的话还包括外部记忆服务），返回与问题相关的事实。"
            "需要回忆用户偏好、以前定过的结论时主动用。"
        ),
        "schema": MEMORY_SEARCH_SCHEMA,
        "flags": {"read_only": True, "concurrency_safe": True, "dangerous": False, "native": True},
    },
    "memory_save": {
        "fn": _memory_save,
        "description": (
            "把值得长期记住的一句话存进记忆，**存完立刻生效**（下一轮就能用上；"
            "配了外部记忆服务会同时写过去）。适合用户明确说「记住…」时。"
        ),
        "schema": MEMORY_SAVE_SCHEMA,
        "flags": {"read_only": False, "concurrency_safe": True, "dangerous": False, "native": True},
    },
    "skill_save": {
        "fn": _skill_save,
        "description": (
            "把这次摸出来的做法沉淀成一个**全局技能**（出现在「技能」页，别的助手也能用）："
            "写清什么时候用它、步骤、命令、坑。用户说「把这个流程记成技能 / 下次照这个做」时用它；"
            "你自己做完一件以后还会再干的多步操作，也主动存一次。正文写做法，不要写这次的具体数据。"
            "调用时 **name / description / body 三个参数必须一次给全**（不许传空对象或只传一部分，"
            "缺参会直接被拒）；先想好技能名再调。"
        ),
        "schema": SKILL_SAVE_SCHEMA,
        "flags": {"read_only": False, "concurrency_safe": False, "dangerous": False, "native": True},
    },
    "session_search": {
        "fn": _session_search,
        "description": (
            "在**以前的会话**里搜原话（跨会话检索）。用户问「我们之前是不是聊过 / 那次最后怎么定的 / "
            "你以前说过什么」时用它 —— 长期记忆只记事实，具体经过在历史对话里。"
        ),
        "schema": SESSION_SEARCH_SCHEMA,
        "flags": {"read_only": True, "concurrency_safe": True, "dangerous": False, "native": True},
    },
    "proc_start": {
        "fn": _proc_start,
        "description": (
            "起一个后台进程（跑得住比一轮对话更久的活：构建、训练、批量下载、长时间脚本）。"
            "立刻返回，不阻塞这一轮；跑完状态留在会话里，之后随时 proc_poll 看。"
        ),
        "schema": PROC_START_SCHEMA,
        "flags": {"read_only": False, "concurrency_safe": False, "dangerous": True, "native": True},
    },
    "proc_poll": {
        "fn": _proc_poll,
        "description": "看后台进程现在的状态和输出尾部（正在跑 / 完成 / 失败 / 退出码 / 已跑多久）。",
        "schema": PROC_POLL_SCHEMA,
        "flags": {"read_only": True, "concurrency_safe": True, "dangerous": False, "native": True},
    },
    "proc_log": {
        "fn": _proc_log,
        "description": "读后台进程的完整日志（默认最后 200 行），要看更早的输出时用。",
        "schema": PROC_LOG_SCHEMA,
        "flags": {"read_only": True, "concurrency_safe": True, "dangerous": False, "native": True},
    },
    "proc_kill": {
        "fn": _proc_kill,
        "description": "停掉一个后台进程（整棵进程树一起停）。",
        "schema": PROC_KILL_SCHEMA,
        "flags": {"read_only": False, "concurrency_safe": False, "dangerous": True, "native": True},
    },
    "proc_list": {
        "fn": _proc_list,
        "description": "列出这个会话起过的后台进程（谁在跑、谁完事了、退出码多少）。",
        "schema": PROC_LIST_SCHEMA,
        "flags": {"read_only": True, "concurrency_safe": True, "dangerous": False, "native": True},
    },
    "python": {
        "fn": _python,
        "description": "执行一段 Python 代码（限当前工作目录，超时硬闸）。适合算数、处理数据、写文件",
        "schema": PYTHON_SCHEMA,
        "flags": {"read_only": False, "concurrency_safe": False, "dangerous": True, "native": True},
    },
    "browser": {
        "fn": _browser,
        "description": (
            "操作一个真实的浏览器：打开网页、点击、输入、读内容、滚动。"
            "画面会实时显示给用户；页面要登录时用 action=wait_login 让用户自己输入。"
            "页面内容动态加载（fetch 拿不到）或需要交互时用它。"
        ),
        "schema": BROWSER_SCHEMA,
        # dangerous=False：不逐次弹 HITL 确认 —— 实测浏览器任务平均 5-10 个动作，
        # 每步都暂停等确认 = 用户全程点"允许"，体验上等于卡死（现场反馈）。
        # 安全边界已经在工具内部收口：URL 拦内网（SSRF）、每 run 沙箱实例、
        # run 结束销毁。用户全程通过直播画面**看得见**它在干什么 —— 这本身就是
        # 比"事后确认"更强的监督。
        "flags": {"read_only": False, "concurrency_safe": False, "dangerous": False, "native": True},
    },
}


def build_native_tool(name: str):
    """把平台原生工具包成 AgentScope FunctionTool（compile.py 调用）。"""
    from agentscope.tool import FunctionTool

    entry = NATIVE_TOOLS.get(name)
    if entry is None:
        raise ValueError(f"未知平台原生工具: {name}（可用: {sorted(NATIVE_TOOLS)}）")
    return FunctionTool(
        entry["fn"],
        name=name,
        description=entry["description"],
        input_schema=entry["schema"],
        is_read_only=bool(entry["flags"].get("read_only")),
        is_concurrency_safe=bool(entry["flags"].get("concurrency_safe")),
    )
