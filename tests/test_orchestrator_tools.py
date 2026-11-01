"""编排者工具白名单：平台层收窄，不靠提示词劝。

背景：编排者配置里挂着 bash/edit/write，模型一旦能自己动手就不会派活 ——
原文实验也是这个结论（中性提示下 5/5 次都不委派）。所以边界的实现方式是
"编译期不给"，而不是"提示词里说你不能"。
"""

from __future__ import annotations

from types import SimpleNamespace

from agent_studio.runtimes.agentscope_rt.compile import (
    ORCHESTRATOR_ALLOW_TOOLS,
    narrow_tools_for_role,
)


def _tools(*names: str):
    return [SimpleNamespace(name=n) for n in names]


def _name_of(t) -> str:
    return str(getattr(t, "name", "") or "")


def test_编排者拿不到执行类工具():
    kept, dropped = narrow_tools_for_role(
        "orchestrator",
        _tools("bash", "write", "edit", "proc_start", "read", "fork", "web_search"),
        _name_of,
    )
    # 读文件/搜索也算"自己动手"—— 现场实测：给它 web_search，它宁可自己搜一遍
    # 也不派 worker，回复里连"派给谁"都没提。Router 只留"认路 + 派活"。
    assert [k.name for k in kept] == ["fork"]
    assert set(dropped) == {"bash", "write", "edit", "proc_start", "read", "web_search"}


def test_编排者保留分派和认路的能力():
    # 分派 + 看技能目录 + 检索工具表 + 排班；不含任何"能自己把活干完"的工具
    assert {"fork", "skill_viewer", "tool_search", "job_create"} <= ORCHESTRATOR_ALLOW_TOOLS
    assert not (
        {"bash", "write", "edit", "python", "reset_tools", "read", "grep", "glob", "fetch", "web_search"}
        & ORCHESTRATOR_ALLOW_TOOLS
    )


def test_编排者拿不到未知工具_MCP之类也不放过():
    kept, dropped = narrow_tools_for_role(
        "orchestrator", _tools("mcp_github_create_issue", "mcp_db_drop"), _name_of
    )
    assert kept == []
    assert set(dropped) == {"mcp_github_create_issue", "mcp_db_drop"}


def test_别的角色一个工具都不动():
    tools = _tools("bash", "write", "edit", "fork")
    kept, dropped = narrow_tools_for_role("worker", tools, _name_of)
    assert kept == tools and dropped == []
    kept2, dropped2 = narrow_tools_for_role(None, tools, _name_of)
    assert kept2 == tools and dropped2 == []


def test_摘掉之后工具清单里还能用tool_call取到的也不含执行工具():
    """懒加载的坑：只摘 raw_tools 不够，bash 会躲进 deferred 被 tool_call 取出来。

    这个用例盯的是**顺序**：白名单必须在懒加载拆分之前跑（compile.build_agent 里
    的那处调用就是为此）。这里用同一份清单模拟拆分，确认 deferred 里没有 bash。
    """
    raw = _tools("bash", "browser_open", "read", "fork")
    kept, _ = narrow_tools_for_role("orchestrator", raw, _name_of)
    core_names = {"read", "fork"}
    core = [t for t in kept if t.name in core_names]
    deferred = [t for t in kept if t.name not in core_names]
    assert [t.name for t in core] == ["fork"]
    assert deferred == []  # 一个都不剩，tool_call 也就无从取用
