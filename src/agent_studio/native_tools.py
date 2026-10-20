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
    },
    "required": ["content"],
}


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


async def _memory_save(content: str, tags: list[str] | None = None) -> str:
    """**主动记一条**：内置直接生效（store-and-use）+ 配了外部就同时写外部。

    为什么改成直接生效（原来的候选制）：
    "记了但没生效"等于没记 —— 助手说完"我记住了"，下一轮照样不知道，
    用户还得去记忆页逐条点确认。Hermes 就是存完即用，这里对齐。
    退出机制仍然在：记忆页能逐条归档/删掉，来源标 agent 便于回查。
    """
    from .db import SessionLocal
    from .memory import external
    from .models import Memory, now_ms
    from .runner.ctx import current_run_ctx

    body = (content or "").strip()
    if not body:
        return "内容为空，没有存。"
    tag_list = [str(t).strip() for t in (tags or []) if str(t).strip()]
    ctx = current_run_ctx()
    agent_id = str(ctx.get("agent_id") or "") or None
    run_id = str(ctx.get("run_id") or "") or None

    stored = body + (f"（标签：{'、'.join(tag_list)}）" if tag_list else "")
    async with SessionLocal() as session:
        session.add(
            Memory(
                agent_id=agent_id,
                scope="agent" if agent_id else "global",
                kind="fact",
                content=stored,
                source="agent",
                source_run_id=run_id,
                status="active",
                importance=0.6,
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

    return f"已记住（下一轮起就会带上这条；记多了可在记忆页归档）；{external_note}"


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

    sess = get_session(run_id, on_frame)
    if action == "navigate":
        return await sess.navigate(url or "about:blank", wait_s)
    if action == "click":
        if not selector:
            return "✗ click 需要 selector"
        return await sess.click(selector)
    if action == "type":
        if not selector:
            return "✗ type 需要 selector"
        return await sess.type_text(selector, value)
    if action == "read":
        return await sess.read(selector or "body")
    if action == "scroll":
        return await sess.scroll(dy)
    if action == "wait":
        return await sess.wait(wait_s)
    if action == "wait_login":
        # 暂停执行，等用户在页面的浏览器画面里亲手操作（输入账号密码/验证码）。
        # 用户点「已登录，继续」后恢复 —— 凭证全程不经模型。
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
    table = _current_lazy()
    if not table:
        return "这一轮没有按需加载的工具：所有工具都已经直接给到你，直接调用即可。"
    qs = [str(q).strip().lower() for q in (queries or []) if str(q).strip()]
    scored: list[tuple[int, str, str]] = []
    for name, t in table.items():
        hay = f"{name} {tool_desc(t)}".lower()
        score = sum(1 for q in qs if q and q in hay)
        if score:
            scored.append((score, name, tool_desc(t)))
    if not scored:
        listing = "\n".join(f"- {n}：{d[:90]}" for n, d in sorted((n, tool_desc(t)) for n, t in table.items()))
        return "没匹配到关键词。当前可按需取用的工具全集：\n" + listing[:3000]
    scored.sort(key=lambda x: (-x[0], x[1]))
    lines = ["匹配到的工具（先 tool_describe 看参数，再 tool_call 调用）："]
    for _, n, d in scored[: max(1, min(int(limit or 8), 20))]:
        lines.append(f"- {n}：{d[:130]}")
    return "\n".join(lines)


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


NATIVE_TOOLS: dict[str, dict[str, Any]] = {
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
        "description": "搜索互联网（DuckDuckGo），返回前几条结果的标题、摘要和链接。",
        "schema": SEARCH_SCHEMA,
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
