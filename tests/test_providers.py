"""Provider 注册表测试 —— 多 LLM Key 配置的基础。"""

from __future__ import annotations

from agent_studio.providers import PROVIDERS, get_provider, list_providers, normalize_provider

MAJOR = ["deepseek", "openai", "anthropic", "dashscope", "moonshot", "xai", "gemini", "ollama"]


def test_all_major_providers_present():
    for name in MAJOR:
        assert name in PROVIDERS, f"缺少主流 provider: {name}"


def test_providers_have_metadata():
    for p in list_providers():
        assert p.display_name, f"{p.name} 缺少显示名"
        assert p.models, f"{p.name} 缺少模型列表"


def test_aliases_resolve():
    assert normalize_provider("kimi") == "moonshot"
    assert normalize_provider("claude") == "anthropic"
    assert normalize_provider("qwen") == "dashscope"
    assert normalize_provider("tongyi") == "dashscope"
    assert normalize_provider("grok") == "xai"
    assert normalize_provider("doubao") == "volcengine"
    assert normalize_provider("google") == "gemini"


def test_alias_case_and_space_insensitive():
    assert normalize_provider("  DeepSeek  ") == "deepseek"
    assert normalize_provider("KIMI") == "moonshot"


def test_unknown_provider_returns_none():
    assert get_provider("nonexistent-llm") is None


def test_ollama_requires_no_key():
    p = get_provider("ollama")
    assert p is not None
    assert p.requires_key is False


def test_gemini_has_no_custom_base_url():
    p = get_provider("gemini")
    assert p is not None
    assert p.allows_base_url is False


def test_default_base_urls_look_right():
    assert "api.deepseek.com" in (PROVIDERS["deepseek"].default_base_url or "")
    assert "moonshot.cn" in (PROVIDERS["moonshot"].default_base_url or "")
    assert "anthropic.com" in (PROVIDERS["anthropic"].default_base_url or "")
    assert "dashscope.aliyuncs.com" in (PROVIDERS["dashscope"].default_base_url or "")


def test_models_are_non_empty_strings():
    for p in list_providers():
        for m in p.models:
            assert isinstance(m, str) and m.strip(), f"{p.name} 模型名非法: {m!r}"
