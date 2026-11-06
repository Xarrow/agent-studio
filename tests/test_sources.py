"""来源解析的单测：只认工具真的返回过的东西。

判错的两个方向都很难看：
· 把模型编的链接当来源 → 用户以为有据可查
· 把搜到的 8 条全倒出来 → 一行回答配 8 个链接，没人看
"""

from __future__ import annotations

from agent_studio import sources as src


SEARCH_TEXT = """1. Python 3.14 有什么新特性
   PEP 649 延迟注解求值、模板字符串、free-threaded 构建进入正式支持
   https://docs.python.org/3/whatsnew/3.14.html
2. Python 3.14 release notes (cn)
   中文整理的发布说明
   https://example.com/cn/314?utm_source=weibo&id=7
3. Python 3.14 有什么新特性
   同一个页面的另一种链接形式
   https://docs.python.org/3/whatsnew/3.14.html/
"""


def test_搜索输出能解析成三段():
    items = src.parse_search(SEARCH_TEXT)
    assert len(items) == 3
    assert items[0]["title"] == "Python 3.14 有什么新特性"
    assert items[0]["url"].startswith("https://docs.python.org")
    assert items[0]["kind"] == "search"
    assert items[0]["site"] == "docs.python.org"
    assert "PEP 649" in items[0]["snippet"]


def test_url_归一化_同页不同链只算一条():
    a = src.url_key("https://docs.python.org/3/whatsnew/3.14.html")
    b = src.url_key("https://docs.python.org/3/whatsnew/3.14.html/")
    c = src.url_key("https://DOCS.python.org/3/whatsnew/3.14.html#pep-649")
    assert a == b == c


def test_跟踪参数去掉_有意义的查询串留下():
    assert src.url_key("https://example.com/x?utm_source=a&id=7") == "https://example.com/x?id=7"
    assert src.url_key("https://example.com/x?id=7") != src.url_key("https://example.com/x?id=8")


def test_抓取成功算来源_失败不算():
    ok = src.parse_fetch("https://example.com/a", "Example Domain\n\nThis domain is for use...")
    assert len(ok) == 1 and ok[0]["kind"] == "fetch" and ok[0]["site"] == "example.com"
    assert src.parse_fetch("https://example.com/a", "✗ HTTP 404 Not Found") == []
    assert src.parse_fetch("", "whatever") == []


def test_不认识的工具不产出来源():
    assert src.from_tool_call("bash", {"cmd": "ls"}, "a.txt") == []
    assert src.from_tool_call("web_search", {}, "") == []


def test_合并时去重且保序():
    rows = [
        {"tool_name": "web_search", "args": {}, "result_preview": SEARCH_TEXT},
        {
            "tool_name": "fetch",
            "args": {"url": "https://docs.python.org/3/whatsnew/3.14.html"},
            "result_preview": "What's New In Python 3.14",
        },
    ]
    data = src.collect(rows)
    # 搜索结果 3 条，其中第 3 条与第 1 条同页；fetch 的那条也已出现过
    assert data["count"] == 2
    assert [i["site"] for i in data["items"]] == ["docs.python.org", "example.com"]
    assert data["sites"] == ["docs.python.org", "example.com"]


def test_空结果不炸():
    assert src.collect([]) == {"count": 0, "items": [], "sites": []}


def test_标题里的_html_实体要还原():
    text = "1. What&#x27;s new in Python 3.14 &amp; more\n   x\n   https://docs.python.org/3/whatsnew/3.14.html"
    items = src.parse_search(text)
    assert items[0]["title"] == "What's new in Python 3.14 & more"


def test_被截断的链接不许当来源():
    """result_preview 是截断的，最后几条 URL 会断在半路 —— 不能给出打不开的链接。"""
    text = "1. ok\n   s\n   https://docs.python.org/3/whatsnew/3.14.html\n2. 断了\n   s\n   https://rea"
    items = src.parse_search(text)
    assert [i["site"] for i in items] == ["docs.python.org"]
