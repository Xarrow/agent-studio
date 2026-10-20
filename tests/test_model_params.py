"""模型参数（temperature 等）的护栏。

现场：界面上给助手填了 temperature → 整轮报
``AttributeError: 'dict' object has no attribute 'max_tokens'``。

原因：AgentScope 2.x 的 ``parameters`` 要的是 ``<Model>.Parameters`` 对象，
塞 dict 进去它照样接收，直到真正调用时读 ``.max_tokens`` 才炸 ——
所以默认参数为空的助手全看不出来，只有"认真调过参数"的用户会踩。
"""

from __future__ import annotations

import pytest

agentscope = pytest.importorskip("agentscope")

from agent_studio.runtimes.agentscope_rt.compile import build_model  # noqa: E402
from agent_studio.schemas import ModelSpec  # noqa: E402


def test_带参数构建出来的是_Parameters_对象不是_dict():
    model = build_model(
        ModelSpec(provider="volcengine", name="deepseek-v4-flash", params={"temperature": 0.3}),
        "sk-not-used",
    )
    params = getattr(model, "parameters", None)
    assert params is not None, "参数没传进去"
    assert not isinstance(params, dict), "必须构造 Parameters 对象，否则调用时炸 .max_tokens"
    assert getattr(params, "temperature", None) == 0.3


def test_未知参数被丢掉而不是让构建失败():
    """用户手写一个 provider 不认的字段，不该让整轮都跑不起来。"""
    model = build_model(
        ModelSpec(provider="volcengine", name="deepseek-v4-flash", params={"no_such_field": 1}),
        "sk-not-used",
    )
    assert model is not None


def test_没有参数时仍然能构建():
    model = build_model(ModelSpec(provider="volcengine", name="deepseek-v4-flash"), "sk-not-used")
    assert model is not None
