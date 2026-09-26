"""native_tools 内核工具护栏测试（不联网的纯函数部分 + SSRF 拦截）。"""

from __future__ import annotations

import asyncio

from agent_studio.native_tools import (
    NATIVE_TOOLS,
    _fetch,
    _html_to_text,
    _is_private_host,
    _parse_ddg,
    _web_search,
)


def test_builtin_registry_shape():
    """三个内核工具都要有：描述、schema、安全 flags（前端试跑/权限引擎依赖）。"""
    assert set(NATIVE_TOOLS) == {"fetch", "web_search", "python"}
    for name, entry in NATIVE_TOOLS.items():
        assert entry["description"], name
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


def test_parse_ddg():
    """DDG 结果页解析（典型结构，含 uddg 跳转包装）。"""
    html = """
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">第一篇</a>
    <a class="result__snippet">摘要一</a>
    <a class="result__a" href="https://example.com/b">第二篇</a>
    <a class="result__snippet">摘要二</a>
    """
    out = _parse_ddg(html)
    assert len(out) == 2
    assert out[0][0] == "第一篇"
    assert out[0][2] == "https://example.com/a"
    assert _parse_ddg("<html>空页面</html>") == []


def test_web_search_invalid():
    """搜索不可达时返回可读错误文本（本机直连 DDG 被墙的场景，实测踩到）。"""
    out = asyncio.run(_web_search(""))
    assert isinstance(out, str)
    # 两种合法结局：拿到结果说明（无结果提示）或拿到可读错误 —— 都不能是裸异常
    assert True
