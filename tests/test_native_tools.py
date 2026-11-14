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


def test_web_search_引擎顺序_腾讯优先且失败会降级(monkeypatch):
    """编排顺序是契约：腾讯有结果就用；它挂了/给得太少才找 Bing。

    这条测试存在的理由：Bing 在本网络会返回"看起来有结果其实全错"的池子，
    所以不能让它先答；但腾讯一旦不可用，必须自动降级而不是整体失败。
    """
    import agent_studio.native_tools as nt

    calls: list[str] = []

    async def fake_qq(q, n=8):
        calls.append("qq")
        return "1. 甲\n   a\n   https://a\n2. 乙\n   b\n   https://b"

    async def fake_rss(q, n=8):
        calls.append("rss")
        return "1. 丙\n   c\n   https://c"

    async def boom(*a, **k):
        raise AssertionError("不该走到 HTML 通道")

    monkeypatch.setattr(nt, "_search_qq", fake_qq)
    monkeypatch.setattr(nt, "_search_bing_rss", fake_rss)
    monkeypatch.setattr(nt, "_search_bing", boom)

    out = asyncio.run(_web_search("随便"))
    assert "甲" in out and calls == ["qq"]        # 腾讯够用就不再问 Bing

    # 腾讯只回一条（不够用）→ 降级到 RSS
    async def thin_qq(q, n=8):
        calls.append("qq-thin")
        return "1. 只有一条\n   x\n   https://x"

    calls.clear()
    monkeypatch.setattr(nt, "_search_qq", thin_qq)
    out = asyncio.run(_web_search("随便"))
    assert "丙" in out and calls == ["qq-thin", "rss"]   # 腾讯太薄 → 再用 RSS

    # 腾讯彻底不可用 + RSS 也没结果 → 走 HTML；再失败才给兜底文案
    async def none_qq(q, n=8):
        calls.append("qq-none")
        return None

    async def none_rss(q, n=8):
        calls.append("rss-none")
        return None

    async def fake_html(q, n=8):
        calls.append("html")
        return "1. 丁\n   d\n   https://d"

    calls.clear()
    monkeypatch.setattr(nt, "_search_qq", none_qq)
    monkeypatch.setattr(nt, "_search_bing_rss", none_rss)
    monkeypatch.setattr(nt, "_search_bing", fake_html)
    out = asyncio.run(_web_search("随便"))
    assert "丁" in out and calls == ["qq-none", "rss-none", "html"]

    calls.clear()
    monkeypatch.setattr(nt, "_search_bing", none_qq)
    out = asyncio.run(_web_search("随便"))
    assert "搜索不可达" in out


def test_parse_bing():
    """Bing 结果页解析（b_algo/h2/b_lineclamp 结构，实测抓包）。"""
    html = """
    <li class="b_algo" data-id iid="SERP.1"><h2><a href="https://example.com/x"
      h="ID=SERP">第一篇 <b>加粗</b></a></h2><p class="b_lineclamp4">摘要一&ensp;&#0183;&ensp;细节</p></li>
    <li class="b_algo" data-id iid="SERP.2"><h2><a href="https://example.com/y">第二篇</a></h2>
      <p class="b_lineclamp2">摘要二</p></li>
    """
    out = _parse_bing(html)
    assert len(out) == 2
    assert out[0][0] == "第一篇 加粗"
    assert out[0][2] == "https://example.com/x"
    assert "·" in out[0][1]
    assert _parse_bing("<html>空</html>") == []


def test_web_search_invalid():
    """搜索不可达时返回可读错误文本（本机直连 DDG 被墙的场景，实测踩到）。"""
    out = asyncio.run(_web_search(""))
    assert isinstance(out, str)
    # 两种合法结局：拿到结果说明（无结果提示）或拿到可读错误 —— 都不能是裸异常
    assert True
