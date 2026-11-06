"""引用来源：把「这一轮模型到底读了哪些网页」从工具调用里捞出来。

为什么是"捞"而不是"记"
----------------------
模型说的来源不能信 —— 它会编链接，也会读了三个页面一个都不标。可信的只有工具
**实际返回**的东西：``web_search`` 的结果列表、``fetch`` 抓过的那个 URL。

所以这里不建表、不落库：每次要看，就从 ``tool_call`` 表里把这一轮的搜索/抓取
重新解析一遍。代价是每次几毫秒、几十行 JSON；换来的是零迁移、历史对话立刻有来源。

用户要的也只是"对话页上有个引用标识，给个参考" —— 不是一套引用管理体系。
"""

from __future__ import annotations

import html as _html
import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

#: 会产生"来源"的工具 → 怎么解析
SEARCH_TOOLS = {"web_search"}
FETCH_TOOLS = {"fetch", "web_fetch"}
BROWSE_TOOLS = {"browser"}

#: 一条来源最多带多少字的摘要（多了在对话里就是噪音）
SNIPPET_MAX = 180

_TRACKING = re.compile(r"^(utm_|fbclid$|gclid$|spm$|from$|share_)", re.I)
_SEARCH_ITEM = re.compile(r"^(\d+)\.\s*(.+)$")


def url_key(url: str) -> str:
    """归一化：同一个页面不要出现三条。

    去掉锚点、跟踪参数、末尾斜杠，域名小写。查询串里**有意义的参数要留**
    （``?id=123`` 和 ``?id=456`` 是两个页面）。
    """
    try:
        p = urlparse(url.strip())
    except ValueError:
        return url.strip()
    if not p.netloc:
        return url.strip()
    query = [
        (k, v)
        for k, v in parse_qsl(p.query, keep_blank_values=True)
        if not _TRACKING.match(k)
    ]
    path = p.path.rstrip("/") or "/"
    return urlunparse((p.scheme.lower() or "http", p.netloc.lower(), path, "", urlencode(query), ""))


def _clean(text: str) -> str:
    """搜索引擎的标题里带 HTML 实体（``What&#x27;s new``），原样显示很难看。"""
    t = _html.unescape(text or "")
    return re.sub(r"\s+", " ", t).strip()


def _looks_complete(url: str) -> bool:
    """URL 是不是个能用的地址。

    为什么要判：来源是从 ``tool_call.result_preview`` 里解析的，而 preview 是
    **截断过的**。一条 8 条结果的搜索，最后几条的 URL 会断在半路，
    解析出来就是 ``https://rea`` 这种垃圾 —— 宁可不显示，也别给出个打不开的链接。
    """
    try:
        p = urlparse(url.strip())
    except ValueError:
        return False
    host = p.netloc.split(":")[0]
    return bool(host) and "." in host and " " not in url and len(host) >= 4


def _site(url: str) -> str:
    try:
        host = urlparse(url).netloc.lower()
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def parse_search(text: str) -> list[dict[str, Any]]:
    """解析 web_search 的输出：``N. 标题 / 摘要 / URL`` 三段一组。

    这个格式是我们自己拼的（native_tools._format_results），所以能解析；
    哪天格式变了，这里退化成空表 —— 对话里不显示来源，不会报错。
    """
    out: list[dict[str, Any]] = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        m = _SEARCH_ITEM.match(lines[i].strip())
        if not m:
            i += 1
            continue
        title = m.group(2).strip()
        snippet = ""
        url = ""
        # 往后最多看两行：摘要、URL
        for j in range(i + 1, min(i + 3, len(lines))):
            raw = lines[j].strip()
            if not raw:
                continue
            if raw.startswith(("http://", "https://")):
                url = raw
            elif not snippet:
                snippet = raw
        if url and _looks_complete(url):
            out.append(
                {
                    "url": url,
                    "title": _clean(title) or _site(url),
                    "snippet": _clean(snippet)[:SNIPPET_MAX],
                    "kind": "search",
                    "site": _site(url),
                }
            )
        i += 1
    return out


def _guess_title(text: str, url: str) -> str:
    """fetch 返回的是纯文本：第一行有内容且不长，就当标题。"""
    for line in text.splitlines():
        line = line.strip()
        if line:
            return line[:120] if len(line) > 6 else _site(url)
    return _site(url)


def parse_fetch(url: str, text: str) -> list[dict[str, Any]]:
    if not url:
        return []
    body = (text or "").strip()
    if body.startswith("✗"):  # 抓取失败的不算来源
        return []
    if not _looks_complete(url):
        return []
    return [
        {
            "url": url,
            "title": _clean(_guess_title(body, url)),
            "snippet": re.sub(r"\s+", " ", body)[:SNIPPET_MAX],
            "kind": "fetch",
            "site": _site(url),
        }
    ]


def from_tool_call(tool_name: str, args: dict[str, Any] | None, result: str | None) -> list[dict[str, Any]]:
    """一条工具调用 → 0~N 条来源。"""
    args = args or {}
    text = result or ""
    if tool_name in SEARCH_TOOLS:
        return parse_search(text)
    if tool_name in FETCH_TOOLS:
        return parse_fetch(str(args.get("url") or ""), text)
    if tool_name in BROWSE_TOOLS:
        url = str(args.get("url") or args.get("goto") or "")
        if not url.startswith(("http://", "https://")):
            return []
        return [
            {
                "url": url,
                "title": _site(url),
                "snippet": "",
                "kind": "browse",
                "site": _site(url),
            }
        ]
    return []


def collect(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """把一轮里的工具调用合成来源清单（按首次出现去重、保序）。

    ``rows`` 每项: ``{tool_name, args, result_preview}`` —— 由调用方从 tool_call 表取。
    """
    seen: dict[str, dict[str, Any]] = {}
    for row in rows:
        for item in from_tool_call(
            str(row.get("tool_name") or ""), row.get("args"), row.get("result_preview")
        ):
            key = url_key(item["url"])
            if key in seen:
                continue
            seen[key] = {**item, "url_key": key}
    items = list(seen.values())
    return {
        "count": len(items),
        "items": items,
        "sites": sorted({i["site"] for i in items if i["site"]}),
    }
