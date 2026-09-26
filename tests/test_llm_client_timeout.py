"""LLM 客户端的网络超时必须被显式设定（回归护栏）。

现场（2026-09-26）：4 轮 LLM 调用里第 4 轮"零字节 68.6s"后报
`APITimeoutError: Request timed out.`，用户以为是自己的执行超时 ✗

根因（读运行时真实值）：平台建模型时**没传 client_kwargs** → 用 openai SDK 默认
  `connect=5.0s` ✗（跨境线路一次 TLS 握手超 5s 很常见）
  且 SDK 自身 max_retries=2、AgentScope 又包一层 max_retries=3 → 嵌套重试放大成 60~70s ✓

修法：build_model 显式传 httpx.Timeout(connect=20, read=600) + max_retries=0
  （重试交给平台那一层：runner/gate.is_transient ✓ 不再嵌套 ✗）
"""
import httpx

from agent_studio.config import settings
from agent_studio.runtimes.agentscope_rt import build_model
from agent_studio.schemas import ModelSpec


def _client():
    spec = ModelSpec(provider="deepseek", name="deepseek-v4-flash", base_url="https://api.deepseek.com/v1")
    return build_model(spec, api_key="sk-shape-only").client


def test_connect_timeout_is_not_the_5s_default():
    t = _client().timeout
    assert isinstance(t, httpx.Timeout)
    # 一定是"我们设的"，而不是 SDK 默认的 5s ✗
    assert t.connect == settings.llm_connect_timeout_s
    assert t.connect > 5.0


def test_read_timeout_is_generous():
    assert _client().timeout.read == settings.llm_read_timeout_s >= 300.0


def test_sdk_retries_disabled_platform_retries_instead():
    # 平台层已有 is_transient 重试 → SDK 再重试会成倍放大等待 ✗
    assert _client().max_retries == settings.llm_sdk_retries == 0
