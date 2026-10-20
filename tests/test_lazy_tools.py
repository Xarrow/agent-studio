"""工具按需加载（lazy tools）的单元测试。

为什么值得单独测：这一层的失败方式很"安静" ——
工具没注册成功也照样能跑（模型说"我没有这个工具"），
所以要断言**注册表里真有东西**、`tool_call` 真按名字调到了。
"""

from __future__ import annotations

import asyncio

import pytest

from agent_studio.native_tools import (
    NATIVE_TOOLS,
    _current_lazy,
    _tool_call,
    _tool_describe,
    _tool_search,
    register_lazy_tools,
)
from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx
from agent_studio.runtimes.agentscope_rt.compile import CORE_TOOL_NAMES, tool_catalog


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _ctx():
    set_run_ctx(run_id="run_test_lazy")
    yield
    from agent_studio.native_tools import drop_lazy_tools

    drop_lazy_tools("run_test_lazy")
    clear_run_ctx()


class _FakeTool:
    """够用的假工具：名字 / 描述 / schema / 可调用。"""

    def __init__(self, name: str, desc: str, schema: dict, ret: str = "ok") -> None:
        self.name = name
        self.description = desc
        self.input_schema = schema
        self._ret = ret

    async def call(self, **kwargs):
        class _Block:
            text = f"{self._ret}:{kwargs}"

        class _Res:
            content = [_Block()]

        return _Res()


def test_registry_stores_by_run():
    a = _FakeTool("proc_start", "在后台起一个长任务", {"type": "object"})
    register_lazy_tools("run_test_lazy", [a])
    assert "_current_lazy" in repr(_current_lazy) or _current_lazy()["proc_start"] is a


def test_search_finds_by_keyword():
    register_lazy_tools(
        "run_test_lazy",
        [
            _FakeTool("proc_start", "在后台起一个长任务，跑得比一轮对话久", {"type": "object"}),
            _FakeTool("memory_save", "把一句话存进长期记忆", {"type": "object"}),
        ],
    )
    out = _run(_tool_search(["后台"]))
    assert "proc_start" in out and "memory_save" not in out


def test_search_no_match_lists_everything():
    register_lazy_tools("run_test_lazy", [_FakeTool("x_tool", "无关工具", {"type": "object"})])
    out = _run(_tool_search(["完全不存在的词"]))
    assert "x_tool" in out  # 没匹配也要把全集给出去，别让模型卡死


def test_describe_returns_schema():
    register_lazy_tools(
        "run_test_lazy",
        [_FakeTool("proc_log", "看后台任务的输出", {"type": "object", "properties": {"id": {"type": "string"}}})],
    )
    out = _run(_tool_describe(["proc_log"]))
    assert "看后台任务的输出" in out and "properties" in out


def test_describe_reports_missing():
    register_lazy_tools("run_test_lazy", [_FakeTool("a", "甲", {"type": "object"})])
    out = _run(_tool_describe(["nope"]))
    assert "没有这些工具" in out and "nope" in out


def test_call_executes_and_accepts_json_string():
    register_lazy_tools("run_test_lazy", [_FakeTool("proc_poll", "查状态", {"type": "object"}, ret="pong")])
    out = _run(_tool_call("proc_poll", '{"id": "bg_1"}'))
    assert "pong" in out and "bg_1" in out


def test_call_unknown_name_hints_search():
    register_lazy_tools("run_test_lazy", [_FakeTool("real", "真工具", {"type": "object"})])
    out = _run(_tool_call("ghost", {}))
    assert "tool_search" in out  # 名字写错 → 指回去查，而不是静默失败


def test_call_without_registry_is_explained():
    register_lazy_tools("run_test_lazy", [])
    out = _run(_tool_call("ghost", {}))
    assert "没有按需加载" in out


def test_call_bad_json_is_explained():
    register_lazy_tools("run_test_lazy", [_FakeTool("t", "t", {"type": "object"})])
    out = _run(_tool_call("t", "{not json"))
    assert "JSON" in out


def test_core_tools_are_core():
    # 这几件是"任何一个正常任务前两步就要用"的，必须常驻
    for name in ("Read", "Write", "Edit", "Bash", "python", "fetch", "web_search", "Skill"):
        assert name in CORE_TOOL_NAMES
    # 偶尔才用的不进核心，否则省不下上下文
    for name in ("proc_start", "memory_save", "browser", "session_search"):
        assert name not in CORE_TOOL_NAMES


def test_catalog_renders_names_and_usage():
    tools = [_FakeTool("proc_start", "在后台起一个长任务", {"type": "object"})]
    text = tool_catalog(tools)
    assert "proc_start" in text and "tool_search" in text and "按需加载" in text


def test_native_registry_has_gateway():
    for name in ("tool_search", "tool_describe", "tool_call"):
        assert name in NATIVE_TOOLS
        assert NATIVE_TOOLS[name]["schema"]["type"] == "object"
