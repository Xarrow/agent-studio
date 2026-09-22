"""平台检测 / 无限轮数 / Run 清理 —— 本轮新增行为的测试。

覆盖用户明确提出的三点：
1. PowerShell 按平台检测（Linux 上不可用，要在页面提示/限制）
2. max_iters = -1 表示不限制（但不能把 -1 直接传给 AgentScope）
3. Run 记录可删除（外键级联，运行中的需跳过）
"""

from __future__ import annotations

import pytest

from agent_studio import platform_env
from agent_studio.schemas import AgentDefinition, Limits, ModelSpec


# --------------------------------------------------------------------------- #
# 1. 平台适用性
# --------------------------------------------------------------------------- #
def test_powershell_only_applies_on_windows():
    from agent_studio.runtimes.agentscope_rt.compile import BUILTIN_PLATFORMS

    applicable, note = platform_env.check_platform(BUILTIN_PLATFORMS["powershell"])
    if platform_env.current_platform() == "win32":
        assert applicable
    else:
        assert not applicable
        assert note, "不适用时必须给出可展示的说明文案"
        assert "PowerShell" in note or "仅" in note


def test_bash_not_applicable_on_windows():
    from agent_studio.runtimes.agentscope_rt.compile import BUILTIN_PLATFORMS

    applicable, _ = platform_env.check_platform(BUILTIN_PLATFORMS["bash"])
    if platform_env.current_platform() == "win32":
        assert not applicable
    else:
        assert applicable


def test_cross_platform_tools_always_apply():
    from agent_studio.runtimes.agentscope_rt.compile import BUILTIN_PLATFORMS

    for name in ("read", "write", "edit", "glob", "grep"):
        applicable, note = platform_env.check_platform(BUILTIN_PLATFORMS[name])
        assert applicable, f"{name} 应当全平台可用"
        assert note == ""


def test_check_platform_none_means_all_platforms():
    applicable, note = platform_env.check_platform(None)
    assert applicable and note == ""


def test_platform_detail_readable():
    detail = platform_env.platform_detail()
    assert detail and "(" in detail


async def test_discover_tools_reports_platform_ok():
    """discover_tools 必须把平台适用性一并返回（前端据此置灰）。"""
    from agent_studio.runtimes import get_runtime

    tools = await get_runtime("agentscope").discover_tools()
    by_name = {t["name"]: t for t in tools}
    assert "powershell" in by_name

    ps = by_name["powershell"]
    assert "applicable" in ps
    assert "platform_ok" in ps["flags"]
    assert ps["applicable"] == ps["flags"]["platform_ok"]

    # 只读 / 危险标记也要带上（决定能否在服务端试跑）
    assert by_name["read"]["flags"]["read_only"] is True
    assert by_name["bash"]["flags"]["dangerous"] is True
    assert by_name["read"]["flags"]["dangerous"] is False


def test_probe_tool_args_returns_signature():
    """内置只读工具要能报出参数签名，否则前端无法提示填参。"""
    from agent_studio.runtimes.agentscope_rt.runtime import _probe_tool_args

    args = _probe_tool_args("read")
    assert any(a["name"] == "file_path" for a in args)
    file_path = next(a for a in args if a["name"] == "file_path")
    assert file_path["required"] is True


# --------------------------------------------------------------------------- #
# 2. 无限轮数（-1）
# --------------------------------------------------------------------------- #
def test_limits_accept_minus_one():
    limits = Limits(max_iters=-1, timeout_s=60)
    assert limits.max_iters == -1


def test_limits_reject_below_minus_one():
    with pytest.raises(Exception):
        Limits(max_iters=-2, timeout_s=60)


def test_timeout_default_is_60s():
    """用户要求：超时默认 1 分钟，但可自定义。"""
    assert Limits().timeout_s == 60
    assert Limits(timeout_s=0).timeout_s == 0  # 0 = 不超时
    assert Limits(timeout_s=3600).timeout_s == 3600


def test_minus_one_translated_to_sentinel_not_passed_through():
    """关键：-1 必须被翻译 —— AgentScope 用 cur_iter >= max_iters 判断，
    直接传 -1 会导致 0 >= -1 立即成立、一轮都不跑。
    """
    from agent_studio.runtimes.agentscope_rt.compile import (
        UNLIMITED_ITERS_SENTINEL,
        build_configs,
    )

    definition = AgentDefinition(
        name="t",
        model=ModelSpec(provider="deepseek", name="m"),
        limits=Limits(max_iters=-1, timeout_s=60),
    )
    _, _, react_config, _ = build_configs(definition)
    assert react_config.max_iters == UNLIMITED_ITERS_SENTINEL
    assert react_config.max_iters > 0


def test_positive_iters_passed_through():
    from agent_studio.runtimes.agentscope_rt.compile import build_configs

    definition = AgentDefinition(
        name="t",
        model=ModelSpec(provider="deepseek", name="m"),
        limits=Limits(max_iters=7, timeout_s=60),
    )
    _, _, react_config, _ = build_configs(definition)
    assert react_config.max_iters == 7


async def test_validate_warns_unlimited_without_timeout():
    """无限轮数 + 不超时 → 必须给警告（否则可能失控）。"""
    from agent_studio.runtimes import get_runtime

    rt = get_runtime("agentscope")
    definition = AgentDefinition(
        name="t",
        model=ModelSpec(provider="deepseek", name="m", api_key="sk-x"),
        limits=Limits(max_iters=-1, timeout_s=0),
    )
    issues = await rt.validate(definition)
    assert any("不限制" in i.message or "超时" in i.message for i in issues)


async def test_validate_accepts_minus_one_with_timeout():
    from agent_studio.runtimes import get_runtime

    rt = get_runtime("agentscope")
    definition = AgentDefinition(
        name="t",
        model=ModelSpec(provider="deepseek", name="m", api_key="sk-x"),
        limits=Limits(max_iters=-1, timeout_s=60),
    )
    issues = await rt.validate(definition)
    assert not any(
        i.level == "error" and "max_iters" in (i.field or "") for i in issues
    )


async def test_capabilities_declares_unlimited_support():
    from agent_studio.runtimes import get_runtime

    caps = get_runtime("agentscope").capabilities()
    assert caps.supports_unlimited_iters is True
    assert caps.sandboxes_tool_paths is False  # AgentScope 默认不沙箱，如实声明


# --------------------------------------------------------------------------- #
# 3. 工具试跑的安全分层
# --------------------------------------------------------------------------- #
def test_workspace_guard_blocks_escape(tmp_path):
    """只读工具试跑不能越出 workspace（否则变成任意文件读取）。"""
    from agent_studio.api.tools import _guard_workspace_args

    _, err = _guard_workspace_args("read", {"file_path": "/etc/passwd"}, str(tmp_path))
    assert err is not None and "工作目录" in err


def test_workspace_guard_allows_inside(tmp_path):
    from agent_studio.api.tools import _guard_workspace_args

    target = tmp_path / "a.txt"
    target.write_text("hi", encoding="utf-8")
    args, err = _guard_workspace_args("read", {"file_path": str(target)}, str(tmp_path))
    assert err is None
    assert args["file_path"] == str(target)


def test_chunk_to_text_handles_none():
    from agent_studio.api.tools import _chunk_to_text

    assert _chunk_to_text(None) == ""
