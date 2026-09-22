"""运行时抽象层测试 —— 验证"运行时无关"的契约。

重点：
1. AgentScope 运行时已注册且能力声明正确
2. 校验能拦住非法定义
3. 事件归一化映射覆盖 AgentScope 的全部事件类型
4. 真实编译一个 Agent 实例（不发网络请求）
"""

from __future__ import annotations

import pytest

from agent_studio.runtimes import get_runtime, get_runtime_or_none, list_runtimes
from agent_studio.schemas import AgentDefinition, Limits, ModelSpec, ToolRef

GOOD_MODEL = ModelSpec(provider="deepseek", name="deepseek-v4-flash", api_key="sk-test-key")


# --------------------------------------------------------------------------- #
# 注册与能力
# --------------------------------------------------------------------------- #
def test_agentscope_runtime_registered():
    rt = get_runtime_or_none("agentscope")
    assert rt is not None
    assert rt.name == "agentscope"


def test_capabilities_declaration():
    caps = get_runtime("agentscope").capabilities()
    assert caps.name == "agentscope"
    assert caps.supports_hitl is True          # AgentScope 原生支持人工确认
    assert caps.supports_thinking is True
    assert caps.supports_skills is True
    assert caps.supports_middlewares is True
    assert "properties" in caps.option_schema  # 驱动前端动态表单
    assert "react_config" in caps.option_schema["properties"]


def test_unknown_runtime_raises():
    with pytest.raises(KeyError):
        get_runtime("definitely-not-registered")


def test_list_runtimes_includes_agentscope():
    assert "agentscope" in [rt.name for rt in list_runtimes()]


# --------------------------------------------------------------------------- #
# 校验
# --------------------------------------------------------------------------- #
async def test_validate_rejects_unknown_provider():
    rt = get_runtime("agentscope")
    definition = AgentDefinition(name="t", model=ModelSpec(provider="no-such-provider"))
    issues = await rt.validate(definition)
    assert any(i.level == "error" and i.field == "model.provider" for i in issues)


async def test_validate_rejects_bad_temperature():
    rt = get_runtime("agentscope")
    definition = AgentDefinition(
        name="t",
        model=ModelSpec(provider="deepseek", name="m", params={"temperature": 5}),
    )
    issues = await rt.validate(definition)
    assert any("temperature" in (i.field or "") for i in issues)


async def test_validate_warns_missing_credential():
    rt = get_runtime("agentscope")
    definition = AgentDefinition(name="t", model=ModelSpec(provider="deepseek", name="m"))
    issues = await rt.validate(definition)
    assert any(i.level == "warning" for i in issues)


async def test_validate_accepts_good_definition():
    rt = get_runtime("agentscope")
    definition = AgentDefinition(
        name="t", system_prompt="hi", model=GOOD_MODEL, limits=Limits(max_iters=10)
    )
    issues = await rt.validate(definition)
    assert not any(i.level == "error" for i in issues)


async def test_validate_rejects_blank_prompt():
    with pytest.raises(Exception):        # pydantic 校验失败
        AgentDefinition(name="t", system_prompt="   ", model=GOOD_MODEL)


# --------------------------------------------------------------------------- #
# 事件归一化
# --------------------------------------------------------------------------- #
def test_event_map_covers_core_events():
    from agent_studio.runtimes.agentscope_rt.normalize import EVENT_MAP

    expected = {
        "ReplyStartEvent": "run_start",
        "ModelCallStartEvent": "llm_call_start",
        "ModelCallEndEvent": "llm_call_end",
        "ThinkingBlockDeltaEvent": "thinking_delta",
        "TextBlockDeltaEvent": "text_delta",
        "ToolCallStartEvent": "tool_call_start",
        "ToolResultStartEvent": "tool_exec_start",
        "ToolResultEndEvent": "tool_exec_end",
        "RequireUserConfirmEvent": "hitl_request",
        "ReplyEndEvent": "run_end",
    }
    for src, dst in expected.items():
        assert EVENT_MAP.get(src) == dst, f"{src} 映射错误"


def test_normalize_real_event():
    """用真实的 AgentScope 事件对象验证归一化。"""
    from agentscope.event import TextBlockDeltaEvent

    from agent_studio.runtimes.agentscope_rt.normalize import normalize_event

    raw = TextBlockDeltaEvent(reply_id="r1", block_id="b1", delta="你好")
    unified = normalize_event(raw)
    assert unified is not None
    assert unified.type == "text_delta"
    assert unified.payload.get("delta") == "你好"
    assert unified.raw is not None       # 保留原始载荷


def test_normalize_skips_unmapped_event():
    from agentscope.event import TextBlockStartEvent

    from agent_studio.runtimes.agentscope_rt.normalize import normalize_event

    assert normalize_event(TextBlockStartEvent(reply_id="r1", block_id="b1")) is None


def test_to_ms_handles_multiple_formats():
    from agent_studio.runtimes.agentscope_rt.normalize import to_ms

    assert to_ms(1_700_000_000_000) == 1_700_000_000_000      # 已是毫秒
    assert to_ms(1_700_000_000.5) == 1_700_000_000_500        # 秒浮点
    assert to_ms("2024-01-01T00:00:00Z") > 0                  # ISO 字符串
    assert to_ms(None) == 0


# --------------------------------------------------------------------------- #
# 编译（真实构造，不发请求）
# --------------------------------------------------------------------------- #
async def test_compile_builds_agentscope_agent():
    rt = get_runtime("agentscope")
    definition = AgentDefinition(
        name="compile-test",
        system_prompt="你是测试助手",
        model=GOOD_MODEL,
        runtime_options={
            "agentscope": {
                "react_config": {"max_iters": 3},
                "injection_config": {"timezone": "Asia/Shanghai"},
            }
        },
    )
    compiled = await rt.compile(definition, api_key="sk-test-key", tools=[], agent_id="ag_test")
    try:
        assert compiled is not None
        assert compiled.runtime == "agentscope"
        agent = compiled.agent  # type: ignore[attr-defined]
        assert agent.name == "compile-test"
        # 配置真的传进去了
        assert agent.react_config.max_iters == 3
        assert agent.injection_config.timezone == "Asia/Shanghai"
    finally:
        await compiled.dispose()


async def test_compile_maps_limits_to_react_config():
    rt = get_runtime("agentscope")
    definition = AgentDefinition(
        name="limits-test", system_prompt="x", model=GOOD_MODEL, limits=Limits(max_iters=7)
    )
    compiled = await rt.compile(definition, api_key="sk-test-key", tools=[])
    try:
        assert compiled.agent.react_config.max_iters == 7  # type: ignore[attr-defined]
    finally:
        await compiled.dispose()


async def test_build_configs_ignores_unknown_fields():
    """不同 AgentScope 版本字段有差异，未知字段必须被安全忽略。"""
    from agent_studio.runtimes.agentscope_rt.compile import build_configs

    definition = AgentDefinition(
        name="t",
        model=GOOD_MODEL,
        runtime_options={"agentscope": {"react_config": {"max_iters": 5, "no_such_field": 1}}},
    )
    model_cfg, context_cfg, react_cfg, injection_cfg = build_configs(definition)
    assert react_cfg.max_iters == 5
    assert not hasattr(react_cfg, "no_such_field")


# --------------------------------------------------------------------------- #
# 工具编译
# --------------------------------------------------------------------------- #
def test_build_builtin_tool_read():
    from agent_studio.runtimes.agentscope_rt.compile import build_builtin_tool

    tool = build_builtin_tool("read")
    assert tool is not None
    assert getattr(tool, "name", "").lower().startswith("read")


def test_build_builtin_tool_unknown():
    from agent_studio.runtimes.agentscope_rt.compile import build_builtin_tool

    with pytest.raises(ValueError, match="未知内置工具"):
        build_builtin_tool("definitely_not_a_tool")


def test_build_tools_skips_broken_entries():
    """单个工具编译失败不能拖垮整个 Agent（用平台 DTO，不用 ORM 行）。"""
    from agent_studio.runtimes.agentscope_rt.compile import build_tools
    from agent_studio.schemas import ToolSpec

    tools = build_tools(
        [
            ToolSpec(name="read", kind="builtin"),
            ToolSpec(name="broken_tool", kind="builtin"),   # 不存在的内置工具
        ]
    )
    assert len(tools) == 1          # 只成功的那个


async def test_discover_tools_lists_builtins():
    rt = get_runtime("agentscope")
    tools = await rt.discover_tools()
    names = {t["name"] for t in tools}
    assert {"read", "write", "bash", "grep", "glob"} <= names
