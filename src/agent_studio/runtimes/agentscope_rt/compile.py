"""AgentScope 侧的「定义 → 实例」编译层。

职责：把平台中立的 ``AgentDefinition`` + 工具/Skill 记录，编译成 AgentScope
可运行的 ``Agent`` 实例。这是适配器里最"脏"的一层（充满框架细节），
但它被隔离在这个文件里 —— 平台其他部分不感知。
"""

from __future__ import annotations

import importlib
import logging
from pathlib import Path
from typing import Any

from ... import platform_env
from ...schemas import AgentDefinition, ModelSpec, ToolSpec

logger = logging.getLogger(__name__)

#: provider 别名 → AgentScope Credential 类名
PROVIDER_CREDENTIALS: dict[str, str] = {
    "deepseek": "DeepSeekCredential",
    "openai": "OpenAICredential",
    "anthropic": "AnthropicCredential",
    "claude": "AnthropicCredential",
    "dashscope": "DashScopeCredential",
    "qwen": "DashScopeCredential",
    "gemini": "GeminiCredential",
    "google": "GeminiCredential",
    "moonshot": "MoonshotCredential",
    "kimi": "MoonshotCredential",
    "xai": "XAICredential",
    "grok": "XAICredential",
    "ollama": "OllamaCredential",
    "volcengine": "VolcengineCredential",
}

#: 平台工具名 → AgentScope 内置工具类名
BUILTIN_TOOLS: dict[str, str] = {
    "read": "Read",
    "write": "Write",
    "edit": "Edit",
    "glob": "Glob",
    "grep": "Grep",
    "bash": "Bash",
    "powershell": "PowerShell",
    "reset_tools": "ResetTools",
    "skill_viewer": "SkillViewer",
}

#: 内置工具的**平台约束**（``None`` = 全平台可用）。
#: 不满足的平台应当在 UI 上置灰并说明原因，而不是等 Agent 调用时才报错。
BUILTIN_PLATFORMS: dict[str, list[str] | None] = {
    "read": None,
    "write": None,
    "edit": None,
    "glob": None,
    "grep": None,
    "bash": [platform_env.LINUX, platform_env.MACOS],  # Windows 上不可用
    "powershell": [platform_env.WINDOWS],  # 仅 Windows
    "reset_tools": None,
    "skill_viewer": None,
}

#: 内置工具的安全属性 —— 决定它能否在**服务端试跑**。
#: ``dangerous=True`` 意味着会写文件或执行命令（等于任意代码执行），
#: 默认不在 API 进程里跑，只在 Agent 运行时内执行。
BUILTIN_SAFETY: dict[str, dict[str, bool]] = {
    "read": {"read_only": True, "dangerous": False},
    "glob": {"read_only": True, "dangerous": False},
    "grep": {"read_only": True, "dangerous": False},
    "skill_viewer": {"read_only": True, "dangerous": False},
    "reset_tools": {"read_only": False, "dangerous": False},
    "write": {"read_only": False, "dangerous": True},
    "edit": {"read_only": False, "dangerous": True},
    "bash": {"read_only": False, "dangerous": True},
    "powershell": {"read_only": False, "dangerous": True},
}

#: 无参数的 provider（不需要 api_key）
KEYLESS_PROVIDERS = {"ollama"}


# --------------------------------------------------------------------------- #
# 模型
# --------------------------------------------------------------------------- #
def build_credential(spec: ModelSpec, api_key: str | None):
    """按 provider 构造 AgentScope Credential（自动只传该类型支持的字段）。"""
    from agentscope import credential as cred_module
    from agentscope.credential import CredentialFactory

    cls = None
    try:
        cls = CredentialFactory.get_credential_class(spec.provider)
    except Exception:  # pragma: no cover
        cls = None

    if cls is None:
        alias = PROVIDER_CREDENTIALS.get(spec.provider)
        cls = getattr(cred_module, alias, None) if alias else None
    if cls is None:
        raise ValueError(
            f"不支持的 provider: {spec.provider}（可用: {sorted(PROVIDER_CREDENTIALS)}）"
        )

    fields = set(cls.model_fields)
    kwargs: dict[str, Any] = {}

    if "api_key" in fields:
        if spec.provider not in KEYLESS_PROVIDERS and not api_key:
            raise ValueError(f"provider={spec.provider} 需要 api_key")
        if api_key:
            kwargs["api_key"] = api_key

    if spec.base_url:
        for key in ("base_url", "api_host", "host"):
            if key in fields:
                kwargs[key] = spec.base_url
                break

    return cls(**kwargs)


def build_model(spec: ModelSpec, api_key: str | None):
    """构造 AgentScope ChatModel（如 ``DeepSeekChatModel``）。"""
    cred = build_credential(spec, api_key)
    model_cls = cred.get_chat_model_class()

    params = dict(spec.params or {})
    kwargs: dict[str, Any] = {"credential": cred, "model": spec.name, "stream": True}
    if params:
        kwargs["parameters"] = params
    return model_cls(**kwargs)


# --------------------------------------------------------------------------- #
# 工具
# --------------------------------------------------------------------------- #
def build_builtin_tool(name: str):
    """按名字构造 AgentScope 内置工具实例。"""
    import agentscope.tool as tool_module

    class_name = BUILTIN_TOOLS.get(name)
    if class_name is None:
        raise ValueError(f"未知内置工具: {name}（可用: {sorted(BUILTIN_TOOLS)}）")
    cls = getattr(tool_module, class_name, None)
    if cls is None:
        raise ValueError(f"AgentScope 未导出内置工具类: {class_name}")
    return cls()


def build_http_tool(spec: ToolSpec):
    """把 HTTP 工具记录编译成 ``FunctionTool``（用户无需写代码）。

    ``impl`` 形如::

        {"method": "GET", "url": "https://api.x.com/weather?city={{city}}",
         "headers": {"X-Key": "..."}, "body_template": null,
         "timeout_s": 15}
    """
    import httpx
    from agentscope.tool import FunctionTool

    impl = spec.impl or {}
    method = str(impl.get("method", "GET")).upper()
    url_tpl = impl.get("url") or ""
    headers = impl.get("headers") or {}
    body_tpl = impl.get("body_template")
    timeout_s = float(impl.get("timeout_s", 15))
    max_bytes = int(impl.get("max_bytes", 64 * 1024))

    def _render(value: Any, args: dict[str, Any]) -> Any:
        """把 ``{{param}}`` 占位替换成实参；dict/list 递归处理。"""
        if isinstance(value, str):
            out = value
            for k, v in args.items():
                out = out.replace("{{" + k + "}}", str(v))
            return out
        if isinstance(value, dict):
            return {k: _render(v, args) for k, v in value.items()}
        if isinstance(value, list):
            return [_render(v, args) for v in value]
        return value

    async def _call(**kwargs: Any) -> str:
        url = _render(url_tpl, kwargs)
        body = _render(body_tpl, kwargs) if body_tpl is not None else None
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.request(method, url, headers=headers, json=body)
            resp.raise_for_status()
            text = resp.text
        return text[:max_bytes]

    schema = spec.input_schema or {"type": "object", "properties": {}}
    return FunctionTool(
        _call,
        name=spec.name,
        description=spec.description or spec.name,
        input_schema=schema,
        is_read_only=bool(spec.flags.get("read_only", False)),
        is_concurrency_safe=bool(spec.flags.get("concurrency_safe", True)),
    )


def build_tools(specs: list[ToolSpec]) -> list[Any]:
    """把**平台中立**的工具描述批量编译为 AgentScope 工具实例。

    注意：入参是 ``ToolSpec``（平台 DTO），不是数据库行 —— 适配器不感知存储。
    单个工具失败不影响整体（记录警告后跳过）。
    """
    tools = []
    for spec in specs:
        try:
            if spec.kind == "builtin":
                tools.append(build_builtin_tool(spec.name))
            elif spec.kind == "http":
                tools.append(build_http_tool(spec))
            else:
                logger.warning("跳过暂不支持的工具类型: %s (%s)", spec.kind, spec.name)
        except Exception as exc:
            logger.warning("工具 %s 编译失败: %s", spec.name, exc)
    return tools


# --------------------------------------------------------------------------- #
# Toolkit / Skill
# --------------------------------------------------------------------------- #
def build_toolkit(specs: list[ToolSpec], skills_dir: Path | None = None):
    """构造 Toolkit（工具 + Skill 的唯一注册源）。"""
    from agentscope.tool import Toolkit

    skills_or_loaders = []
    if skills_dir is not None and skills_dir.exists():
        try:
            from agentscope.skill import LocalSkillLoader

            skills_or_loaders.append(LocalSkillLoader(str(skills_dir)))
        except Exception as exc:  # pragma: no cover
            logger.warning("Skill loader 初始化失败: %s", exc)

    return Toolkit(tools=build_tools(specs), skills_or_loaders=skills_or_loaders)


# --------------------------------------------------------------------------- #
# Agent
# --------------------------------------------------------------------------- #
#: ``max_iters = -1``（不限制）时传给运行时的哨兵值。
#:
#: AgentScope 内部用 ``cur_iter >= max_iters`` 判断是否停止，
#: 直接把 -1 传下去会导致 ``0 >= -1`` 立即成立 —— **一轮都不跑**。
#: 所以平台必须翻译成一个足够大的轮数，并依赖 ``timeout_s`` 兜底。
UNLIMITED_ITERS_SENTINEL = 999_999


def build_configs(defn: AgentDefinition):
    """把定义里的通用/专有配置翻译成 AgentScope 的四个 Config。"""
    from agentscope.agent import ContextConfig, InjectionConfig, ModelConfig, ReActConfig

    opts = defn.options_for("agentscope")
    limits = defn.limits

    react_kwargs = dict(opts.get("react_config") or {})
    # 平台语义：-1 = 不限制 → 翻译成哨兵值；正数原样传递
    effective_iters = (
        limits.max_iters if limits.max_iters > 0 else UNLIMITED_ITERS_SENTINEL
    )
    react_kwargs.setdefault("max_iters", effective_iters)

    model_kwargs = dict(opts.get("model_config") or {})
    context_kwargs = dict(opts.get("context_config") or {})
    injection_kwargs = dict(opts.get("injection_config") or {})

    def _safe(cls, kwargs: dict[str, Any]):
        """只传该 Config 认识的字段，避免因版本差异炸掉。"""
        allowed = set(cls.model_fields)
        return cls(**{k: v for k, v in kwargs.items() if k in allowed})

    return (
        _safe(ModelConfig, model_kwargs),
        _safe(ContextConfig, context_kwargs),
        _safe(ReActConfig, react_kwargs),
        _safe(InjectionConfig, injection_kwargs),
    )


def build_agent(
    defn: AgentDefinition,
    api_key: str | None,
    tools: list[ToolSpec],
    skills_dir: Path | None = None,
    memory_text: str | None = None,
):
    """编译出 ``(agent, model)`` —— 二者都需在 dispose 时收尾。

    ``memory_text`` 是平台召回的**长期记忆**（已渲染成文本）。它属于
    "已知信息"，所以拼在 System Prompt 末尾 —— 这样任何模型都能看到，
    不依赖具体框架的上下文机制（换成 pi 也只需同样拼一次）。
    """
    from agentscope.agent import Agent

    model = build_model(defn.model, api_key)
    toolkit = build_toolkit(tools, skills_dir)
    model_cfg, context_cfg, react_cfg, injection_cfg = build_configs(defn)

    system_prompt = defn.system_prompt or ""
    if memory_text:
        system_prompt = f"{system_prompt.rstrip()}\n\n{memory_text}".strip()

    agent = Agent(
        name=defn.name,
        system_prompt=system_prompt,
        model=model,
        toolkit=toolkit,
        model_config=model_cfg,
        context_config=context_cfg,
        react_config=react_cfg,
        injection_config=injection_cfg,
    )
    return agent, model
