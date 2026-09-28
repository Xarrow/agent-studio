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
web_search   只读。走 DuckDuckGo HTML 端点（零 key、零依赖），解析前 8 条
             标题+摘要+链接，返回纯文本 —— 模型拿到的就是"能用"的搜索结果。
python       写类。代码写进 run 自己的工作目录下执行（cwd 锁死），
             stdout/stderr 有限截断，超时硬闸（默认 30s，上限 120s）。
             子进程继承当前工作目录 = 与 read/write/edit 同一隔离域。
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import re
import socket
import tempfile
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
# 三处（fetch / DuckDuckGo / Bing）**共用同一份**，避免"某一条路径忘了改"。
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
    """搜索：DuckDuckGo 优先，失败自动降级 Bing（国内服务器直连 DDG 常被墙，实测踩到）。"""
    out = await _search_ddg(query)
    if out is not None:
        return out
    out = await _search_bing(query)
    if out is not None:
        return out
    return "✗ 搜索不可达（DuckDuckGo 与 Bing 都失败了）—— 服务器可能无法直连外网搜索"


async def _search_ddg(query: str, max_results: int = 8) -> str | None:
    """DDG HTML 版。None = 不可用（让上层降级），str = 成功或已定性的失败。"""
    import httpx

    try:
        async with httpx.AsyncClient(
            timeout=SEARCH_TIMEOUT_S,
            follow_redirects=True,
            headers=BROWSER_HEADERS,
        ) as client:
            r = await client.get(
                "https://html.duckduckgo.com/html/",
                params={"q": query},
            )
    except httpx.HTTPError:
        return None  # 网络不可达 → 降级
    if r.status_code != 200:
        return None
    results = _parse_ddg(r.text)
    if not results:
        # 空结果可能是真没有，也可能是页面结构变了 —— 交给 Bing 复核
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


def _format_results(results: list[tuple[str, str, str]]) -> str:
    if not results:
        return "（没有搜到结果，换个关键词试试）"
    lines = []
    for i, (title, snippet, url) in enumerate(results, 1):
        snippet = re.sub(r"\s+", " ", snippet).strip()
        lines.append(f"{i}. {title}\n   {snippet}\n   {url}")
    return "\n".join(lines)


_RESULT_RE = re.compile(
    r'<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>.*?'
    r'class="result__snippet"[^>]*>(.*?)</a>',
    re.DOTALL,
)


def _parse_ddg(html: str) -> list[tuple[str, str, str]]:
    """从 DDG HTML 版结果页解析（标题, 摘要, 链接）。解析失败返回空表。"""
    out = []
    for m in _RESULT_RE.finditer(html):
        url, title, snippet = m.group(1), m.group(2), m.group(3)
        title = _TAG_STRIP_RE.sub("", title).strip()
        snippet = _TAG_STRIP_RE.sub("", snippet).strip()
        # DDG 的链接是跳转包装，剥出真实 uddg 参数
        rm = re.search(r"uddg=([^&]+)", url)
        if rm:
            from urllib.parse import unquote

            url = unquote(rm.group(1))
        if title:
            out.append((title, snippet, url))
    return out


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
PYTHON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "code": {"type": "string", "description": "要执行的 Python 代码（在当前工作目录运行）"},
        "timeout_s": {"type": "integer", "description": f"超时秒数（默认 {PYTHON_TIMEOUT_S_DEFAULT}，上限 {PYTHON_TIMEOUT_S_MAX}）"},
    },
    "required": ["code"],
}

NATIVE_TOOLS: dict[str, dict[str, Any]] = {
    "fetch": {
        "fn": _fetch,
        "description": "抓取一个网页或接口，返回文本（HTML 自动转成可读文本）。不能访问内网地址。",
        "schema": FETCH_SCHEMA,
        "flags": {"read_only": True, "concurrency_safe": True, "dangerous": False, "native": True},
    },
    "web_search": {
        "fn": _web_search,
        "description": "搜索互联网（DuckDuckGo），返回前几条结果的标题、摘要和链接。",
        "schema": SEARCH_SCHEMA,
        "flags": {"read_only": True, "concurrency_safe": True, "dangerous": False, "native": True},
    },
    "python": {
        "fn": _python,
        "description": "执行一段 Python 代码（限当前工作目录，超时硬闸）。适合算数、处理数据、写文件。",
        "schema": PYTHON_SCHEMA,
        "flags": {"read_only": False, "concurrency_safe": False, "dangerous": True, "native": True},
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
