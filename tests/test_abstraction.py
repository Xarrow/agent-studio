"""抽象契约测试 —— 架构护栏。

这些测试守护"运行时无关"这条底线。一旦有人：

- 在平台层（schemas / providers / base）引入框架依赖
- 往 ``compile(**ctx)`` 里塞 ORM 行
- 让归一化丢掉 raw 载荷
- 把注册表做成封闭的

测试会立刻失败。**它们的价值在于未来**，而不是现在。
"""

from __future__ import annotations

from pathlib import Path

SRC = Path(__file__).parent.parent / "src" / "agent_studio"

#: 这些文件属于"平台层"——必须与具体框架解耦
PLATFORM_FILES = [
    "schemas.py",
    "providers.py",
    "models.py",
    "config.py",
    "runtimes/base.py",
    "runtimes/registry.py",
]

#: 不许出现在平台层 import 里的框架/厂商包
FORBIDDEN = ["agentscope", "openai", "anthropic", "dashscope", "ollama", "mcp"]


# --------------------------------------------------------------------------- #
# 1. 平台层不得依赖框架
# --------------------------------------------------------------------------- #
def test_platform_layer_has_no_framework_imports():
    violations: list[str] = []
    for name in PLATFORM_FILES:
        text = (SRC / name).read_text(encoding="utf-8")
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped.startswith(("import ", "from ")):
                continue
            for pkg in FORBIDDEN:
                if pkg in stripped:
                    violations.append(f"{name}: {stripped}")
    assert not violations, (
        "平台层出现了框架依赖（抽象泄漏）：\n  " + "\n  ".join(violations)
    )


def test_adapters_live_under_runtime_package():
    """框架相关代码必须集中在 runtimes/<name>_rt/ 下。"""
    rt_dir = SRC / "runtimes"
    adapters = [p.name for p in rt_dir.iterdir() if p.is_dir() and not p.name.startswith("__")]
    assert "agentscope_rt" in adapters


# --------------------------------------------------------------------------- #
# 2. ctx 只允许平台 DTO
# --------------------------------------------------------------------------- #
def test_compile_ctx_uses_platform_dto():
    """runner 传给适配器的必须是 ToolSpec，不是 ORM 行。"""
    service = (SRC / "runner" / "service.py").read_text(encoding="utf-8")
    assert "ToolSpec.from_row" in service, "service 应把 ORM 行转成 ToolSpec"
    assert "tools=tools" in service, "compile 应接收 tools（DTO 列表）"
    assert "tool_rows=" not in service, "不应再把 ORM 行传进 compile"


def test_adapter_source_has_no_orm_access():
    """适配器不得访问 ORM 行属性（row.kind / row.impl / row.flags）。"""
    compile_src = (SRC / "runtimes" / "agentscope_rt" / "compile.py").read_text(encoding="utf-8")
    for pat in ("row.kind", "row.impl", "row.flags", "row.input_schema"):
        assert pat not in compile_src, f"适配器仍在访问 ORM 属性: {pat}"


# --------------------------------------------------------------------------- #
# 3. AgentDefinition 的逃生舱
# --------------------------------------------------------------------------- #
def test_runtime_options_escape_hatch():
    """任何框架特有配置都必须能通过 runtime_options 表达。"""
    from agent_studio.schemas import AgentDefinition, ModelSpec

    d = AgentDefinition(
        name="t",
        model=ModelSpec(provider="deepseek"),
        runtime_options={
            "agentscope": {"react_config": {"max_iters": 3}},
            "pi": {"thinking_level": "high"},
        },
    )
    assert d.options_for("agentscope")["react_config"]["max_iters"] == 3
    assert d.options_for("pi")["thinking_level"] == "high"
    assert d.options_for("not-installed") == {}


def test_definition_is_serializable_snapshot():
    """定义必须能无损序列化（Run 快照可复现）。"""
    import json

    from agent_studio.schemas import AgentDefinition, ModelSpec

    d = AgentDefinition(
        name="t",
        model=ModelSpec(provider="deepseek", name="m"),
        runtime_options={"pi": {"x": 1}},
    )
    blob = json.dumps(d.model_dump(mode="json"), ensure_ascii=False)
    back = AgentDefinition.model_validate(json.loads(blob))
    assert back.runtime_options == d.runtime_options


def test_definition_accepts_future_runtime():
    """runtime 字段不能限定枚举 —— 否则接入 pi 要改平台代码。"""
    from agent_studio.schemas import AgentDefinition, ModelSpec

    d = AgentDefinition(name="t", runtime="pi", model=ModelSpec(provider="anthropic"))
    assert d.runtime == "pi"


# --------------------------------------------------------------------------- #
# 4. ToolSpec 与存储无关
# --------------------------------------------------------------------------- #
def test_toolspec_constructible_without_storage():
    from agent_studio.schemas import ToolSpec

    spec = ToolSpec(name="x", kind="http", impl={"url": "https://a"})
    assert spec.id == ""
    assert spec.impl["url"] == "https://a"
    assert spec.flags == {}


def test_toolspec_from_duck_typed_row():
    """from_row 能吃任何 duck-typed 对象（含 None 字段）。"""

    class FakeRow:
        id = "tl_1"
        name = "read"
        description = None
        kind = "builtin"
        input_schema = None
        impl = None
        flags = None

    from agent_studio.schemas import ToolSpec

    spec = ToolSpec.from_row(FakeRow())
    assert spec.name == "read"
    assert spec.input_schema == {}
    assert spec.flags == {}
    assert spec.kind == "builtin"


def test_adapter_accepts_platform_dto_only():
    """适配器用 ToolSpec 直接编译（不经数据库）。"""
    from agent_studio.runtimes.agentscope_rt.compile import build_tools
    from agent_studio.schemas import ToolSpec

    tools = build_tools(
        [
            ToolSpec(name="read", kind="builtin"),
            ToolSpec(
                name="probe",
                kind="http",
                description="探测",
                impl={"method": "GET", "url": "https://example.com"},
            ),
        ]
    )
    assert len(tools) == 2


# --------------------------------------------------------------------------- #
# 5. 事件归一化不丢信息
# --------------------------------------------------------------------------- #
def test_normalization_keeps_raw_payload():
    """raw 必须保留 —— 归一化必然丢信息，留着才能事后补全。"""
    from agentscope.event import TextBlockDeltaEvent

    from agent_studio.runtimes.agentscope_rt.normalize import normalize_event

    unified = normalize_event(TextBlockDeltaEvent(reply_id="r", block_id="b", delta="x"))
    assert unified is not None
    assert unified.raw is not None
    assert unified.raw.get("delta") == "x"


def test_unified_event_type_set_is_platform_owned():
    """统一事件类型必须写在平台层（base.py），不由某个框架决定。"""
    from agent_studio.runtimes.base import UnifiedEvent

    src = (SRC / "runtimes" / "base.py").read_text(encoding="utf-8")
    for et in ("run_start", "llm_call_start", "tool_exec_end", "hitl_request", "run_end"):
        assert et in src, f"base.py 缺少统一事件类型: {et}"
    assert "EventType" in src
    assert UnifiedEvent is not None


# --------------------------------------------------------------------------- #
# 6. 注册表开放（第三方运行时能接入）
# --------------------------------------------------------------------------- #
def test_third_party_runtime_can_register():
    from agent_studio.runtimes import (
        get_runtime_or_none,
        list_runtimes,
        register_runtime,
    )
    from agent_studio.runtimes.base import AgentRuntime, RuntimeCapabilities

    class DummyRuntime(AgentRuntime):
        name = "dummy-test-runtime"

        def capabilities(self):
            return RuntimeCapabilities(name=self.name, display_name="Dummy")

        async def validate(self, definition):
            return []

        async def compile(self, definition, **ctx):
            raise NotImplementedError

        def run(self, agent, run_input):
            async def _gen():
                return
                yield  # pragma: no cover

            return _gen()

        async def dispose(self, agent):
            return None

    register_runtime(DummyRuntime())
    assert get_runtime_or_none("dummy-test-runtime") is not None
    assert "dummy-test-runtime" in [r.name for r in list_runtimes()]
