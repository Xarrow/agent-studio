"""native_tools 内核工具护栏测试（不联网的纯函数部分 + SSRF 拦截）。"""

from __future__ import annotations

import asyncio

from agent_studio.native_tools import (
    NATIVE_TOOLS,
    _fetch,
    _html_to_text,
    _is_private_host,
    _parse_bing,
    _parse_bing_rss,
    _relevance,
    _parse_qq,
    _web_search,
)


def test_builtin_registry_shape():
    """内核工具都要有：描述、schema、安全 flags（前端试跑/权限引擎依赖）。

    memory_search / memory_save 是后加的一对：**主动**查记忆与记一条
    （以前记忆只能在执行开始时自动注入一次，Agent 没法"想起来去查"）。
    """
    assert set(NATIVE_TOOLS) == {
        "fetch",
        "web_search",
        "python",
        "memory_search",
        "memory_save",
        "dispatch",
        "workers",
        "browser",
        # 跨会话检索：用户问"以前聊过什么"时用
        "session_search",
        # 后台进程（2026-10）：跑得住比一轮对话更久的活
        "proc_start",
        "proc_poll",
        "proc_log",
        "proc_kill",
        "proc_list",
        # 把对话里摸出来的做法沉淀成全局技能（2026-10）
        "skill_save",
        # 助手自己排班（2026-10）：定时任务以前只能人在界面上挂
        "job_create",
        "job_list",
        "job_cancel",
        # 工具按需加载的三个入口（不直接给模型的工具靠它们取用）
        "tool_search",
        "tool_describe",
        "tool_call",
    }
    #: 无参工具（proc_list）的 required 本来就该是空的
    NO_ARG = {"proc_list", "proc_poll", "job_list", "workers"}  # 都不填参数也合法（默认看最新那个）
    for name, entry in NATIVE_TOOLS.items():
        assert entry["description"], name
        if name not in NO_ARG:
            assert entry["schema"].get("required"), name
        assert "read_only" in entry["flags"], name


def test_private_host_blocked():
    """SSRF：内网/环回地址必须被识别（fetch 会拒）。"""
    for host in ("127.0.0.1", "192.168.2.11", "10.0.0.1", "169.254.1.1", "localhost"):
        assert _is_private_host(host), host


def test_fetch_rejects_bad_url():
    """协议/主机缺失直接拒，不出网。"""
    out = asyncio.run(_fetch("ftp://example.com/x"))
    assert out.startswith("✗")
    out = asyncio.run(_fetch("http://127.0.0.1:8848/api/tools"))
    assert out.startswith("✗")  # 内网拒绝


def test_html_to_text():
    html = "<html><script>bad()</script><style>.x{}</style><h1>标题</h1><p>正文&amp;更多</p></html>"
    text = _html_to_text(html)
    assert "标题" in text and "正文&更多" in text
    assert "bad()" not in text and ".x{}" not in text


def test_parse_bing_rss():
    """Bing 的 RSS 出口（首选通道）：XML 解析，标题/摘要/链接都要取到。

    为什么换 RSS：HTML 版是给浏览器渲染的，实测同一查询会拿到"固定池里的
    随机结果"（查 nginx 返回冠状病毒百科），而且结构一改解析就静默变空。
    """
    from pathlib import Path

    xml = (Path(__file__).parent / "fixtures" / "bing_rss.xml").read_text(encoding="utf-8")
    out = _parse_bing_rss(xml)
    assert len(out) >= 5
    title, snippet, url = out[0]
    assert title and url.startswith("http")
    assert "<" not in title                       # 高亮标签已剥掉
    assert _parse_bing_rss("<rss><channel></channel></rss>") == []
    assert _parse_bing_rss("不是 XML") == []       # 解析失败返回空表，不抛异常


def test_parse_qq():
    """腾讯搜索卡片树 → 结果三元组（JSON 夹具来自真实响应）。"""
    import json
    from pathlib import Path

    data = json.loads(
        (Path(__file__).parent / "fixtures" / "qq_search.json").read_text(encoding="utf-8")
    )
    out = _parse_qq(data)
    assert len(out) == 3
    title, snippet, url = out[0]
    assert title and url.startswith("http")
    assert snippet.startswith("[")                 # 带来源名
    assert _parse_qq({"cards": []}) == []
    # 缺 title 或 url 的卡片直接跳过，不能抛
    assert _parse_qq({"cards": [{"data": {"vm": {"title": "", "url": "https://x"}}}]}) == []


def test_web_search_引擎协作_按相关度择优(monkeypatch):
    """编排契约：腾讯先答；只有它不够相关才去问 Bing，最后按命中率择优。

    写死"永远腾讯"或"永远 Bing"都不行——两个引擎都会按查询词抽风，
    判据只能是"这一份结果里命中了多少查询词"。
    """
    import agent_studio.native_tools as nt

    calls: list[str] = []

    async def good_qq(q, n=8):
        calls.append("qq")
        return "1. 甲 nginx debian\n   a\n   https://a\n2. debian nginx 安装\n   b\n   https://b"

    async def irrelevant_rss(q, n=8):
        calls.append("rss")
        return "1. Coronavirus\n   x\n   https://x"

    async def boom(*a, **k):
        calls.append("html")
        raise AssertionError("腾讯够相关时不该走 HTML")

    monkeypatch.setattr(nt, "_search_qq", good_qq)
    monkeypatch.setattr(nt, "_search_bing_rss", irrelevant_rss)
    monkeypatch.setattr(nt, "_search_bing", boom)

    out = asyncio.run(_web_search("debian nginx 安装"))
    assert "甲" in out and calls == ["qq"]          # 相关度够高，不再问别人

    # 腾讯给的是无关结果 → 降级 Bing，并采用更相关的那份
    async def junk_qq(q, n=8):
        calls.append("qq")
        return "1. Coronavirus\n   x\n   https://x\n2. WHO\n   y\n   https://y"

    async def good_rss(q, n=8):
        calls.append("rss")
        return "1. debian nginx 安装指南\n   a\n   https://a\n2. nginx debian\n   b\n   https://b"

    calls.clear()
    monkeypatch.setattr(nt, "_search_qq", junk_qq)
    monkeypatch.setattr(nt, "_search_bing_rss", good_rss)
    monkeypatch.setattr(nt, "_search_bing", boom)
    out = asyncio.run(_web_search("debian nginx 安装"))
    assert "安装指南" in out and calls == ["qq", "rss"]

    # 全都不相关 → 如实标注，不能把垃圾当答案
    async def junk_html(q, n=8):
        calls.append("html")
        return "1. WHO\n   z\n   https://z"

    calls.clear()
    monkeypatch.setattr(nt, "_search_bing_rss", junk_qq)
    monkeypatch.setattr(nt, "_search_bing", junk_html)
    out = asyncio.run(_web_search("debian nginx 安装"))
    assert "与查询词基本无关" in out

    # 全部不可用 → 兜底文案
    async def none(*a, **k):
        calls.append("none")
        return None

    monkeypatch.setattr(nt, "_search_qq", none)
    monkeypatch.setattr(nt, "_search_bing_rss", none)
    monkeypatch.setattr(nt, "_search_bing", none)
    out = asyncio.run(_web_search("随便"))
    assert "搜索不可达" in out


def test_relevance_打分():
    """引擎切换的判据：结果标题里到底命中了多少查询词。

    这条很重要——两个搜索引擎都会"看查询词抽风"（中文查 nginx 返回冠状病毒、
    英文查 async 返回垃圾站），没有打分就只能靠品牌拍脑袋。
    """
    good = "1. Debian 12 install nginx guide\n   x\n   https://a\n2. nginx on Debian\n   y\n   https://b"
    bad = "1. Coronavirus - Wikipedia\n   z\n   https://c"
    assert _relevance("Debian 12 install nginx", good) >= 0.75
    assert _relevance("Debian 12 install nginx", bad) == 0.0
    # 中文按二元组命中
    zh = "1. 黄仁勋（英伟达 CEO）\n   x\n   https://a"
    assert _relevance("黄仁勋 英伟达", zh) >= 0.4
    assert _relevance("", good) == 0.0
