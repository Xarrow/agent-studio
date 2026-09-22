"""LLM Provider 注册表。

平台支持多家 provider，用户可以在页面上配置多套凭据（key），
不同 Agent 选用不同的凭据。

这里集中声明各 provider 的元数据：显示名、默认 base_url、凭据字段、
常用模型列表 —— 前端据此渲染表单，后端据此做连通性测试。
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class ProviderMeta:
    name: str
    display_name: str
    default_base_url: str | None
    #: 该 provider 常用模型（前端下拉候选，仍允许自由输入）
    models: list[str] = field(default_factory=list)
    #: 是否需要 api_key
    requires_key: bool = True
    #: 允许自定义 base_url（自建/中转场景）
    allows_base_url: bool = True
    docs_url: str | None = None
    note: str = ""


#: 支持的 provider（key 与 AgentScope CredentialFactory 的 provider 名对齐）
PROVIDERS: dict[str, ProviderMeta] = {
    "deepseek": ProviderMeta(
        name="deepseek",
        display_name="DeepSeek",
        default_base_url="https://api.deepseek.com/v1",
        models=["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
        docs_url="https://api-docs.deepseek.com",
        note="性价比高，OpenAI 兼容协议",
    ),
    "openai": ProviderMeta(
        name="openai",
        display_name="OpenAI",
        default_base_url="https://api.openai.com/v1",
        models=["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini"],
        docs_url="https://platform.openai.com/docs",
    ),
    "anthropic": ProviderMeta(
        name="anthropic",
        display_name="Anthropic Claude",
        default_base_url="https://api.anthropic.com",
        models=[
            "claude-sonnet-4-5",
            "claude-opus-4-1",
            "claude-3-5-sonnet-latest",
            "claude-3-5-haiku-latest",
        ],
        docs_url="https://docs.anthropic.com",
    ),
    "dashscope": ProviderMeta(
        name="dashscope",
        display_name="阿里云百炼（通义千问）",
        default_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        models=["qwen-max", "qwen-plus", "qwen-turbo", "qwen3-max"],
        docs_url="https://help.aliyun.com/zh/model-studio",
    ),
    "moonshot": ProviderMeta(
        name="moonshot",
        display_name="Moonshot（Kimi）",
        default_base_url="https://api.moonshot.cn/v1",
        models=["kimi-k2-0905-preview", "moonshot-v1-128k", "moonshot-v1-32k"],
        docs_url="https://platform.moonshot.cn/docs",
    ),
    "xai": ProviderMeta(
        name="xai",
        display_name="xAI（Grok）",
        default_base_url="https://api.x.ai/v1",
        models=["grok-4", "grok-3", "grok-3-mini"],
        docs_url="https://docs.x.ai",
    ),
    "gemini": ProviderMeta(
        name="gemini",
        display_name="Google Gemini",
        default_base_url=None,
        models=["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
        allows_base_url=False,
        docs_url="https://ai.google.dev",
    ),
    "volcengine": ProviderMeta(
        name="volcengine",
        display_name="火山引擎（豆包）",
        default_base_url="https://ark.cn-beijing.volces.com/api/v3",
        # 注意：方舟的「Agent Plan」类 key 不收 /api/v3（会 401），
        # 要改用 https://ark.cn-beijing.volces.com/api/plan/v3 —— 且该端点下
        # 只有部分模型可用（实测 deepseek-v4-flash 可以，doubao-* 会报
        # UnsupportedModel）。方舟不提供 /models 列表，只能靠填写。
        models=["deepseek-v4-flash", "doubao-pro-32k", "doubao-pro-128k"],
        note="Agent Plan 类 key 需把 Base URL 改成 …/api/plan/v3",
        docs_url="https://www.volcengine.com/docs/82379",
    ),
    "ollama": ProviderMeta(
        name="ollama",
        display_name="Ollama（本地）",
        default_base_url="http://127.0.0.1:11434",
        models=["qwen2.5:14b", "llama3.1:8b", "deepseek-r1:7b"],
        requires_key=False,
        docs_url="https://ollama.com",
        note="本地推理，无需 API Key",
    ),
}

#: 别名 → 规范名（用户可能按习惯写 kimi / claude / qwen）
ALIASES: dict[str, str] = {
    "claude": "anthropic",
    "kimi": "moonshot",
    "qwen": "dashscope",
    "tongyi": "dashscope",
    "google": "gemini",
    "grok": "xai",
    "doubao": "volcengine",
    "ark": "volcengine",
}


def normalize_provider(name: str) -> str:
    key = (name or "").strip().lower()
    return ALIASES.get(key, key)


def get_provider(name: str) -> ProviderMeta | None:
    return PROVIDERS.get(normalize_provider(name))


def list_providers() -> list[ProviderMeta]:
    return list(PROVIDERS.values())
