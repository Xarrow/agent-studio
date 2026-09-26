"""执行超时解析：**0 = 不限** 必须真的成立。

现场（2026-09-26）：用户在助手配置里写「超时 0 = 不超时」，
运行却仍按默认超时被掐断 —— 根因是 `definition.limits.timeout_s or settings.default_timeout_s`，
Python 里 `0 or X == X` ✗，0 被当成"没配"吃掉了。

本文件把这条语义钉死（回归护栏 ✓）。
"""
from agent_studio.runner.service import effective_timeout, resolve_timeout


def test_none_means_not_configured_use_default():
    assert resolve_timeout(None, 120) == 120


def test_zero_means_unlimited_not_default():
    # 就是这条曾经被 `or` 吃掉 ✗
    assert resolve_timeout(0, 120) == 0
    assert resolve_timeout(0, 120) != 120


def test_negative_means_unlimited_too():
    assert resolve_timeout(-1, 120) == -1


def test_positive_passes_through():
    assert resolve_timeout(30, 120) == 30


def test_fanout_extension_applies_only_to_positive():
    # 等子执行时延长（既有语义 ✓）
    assert resolve_timeout(30, 120, 600) == 600
    # 但"不限"不因为 fanout 反而变成有限 ✗
    assert resolve_timeout(0, 120, 600) == 0
    assert resolve_timeout(-1, 120, 600) == -1


def test_effective_timeout_keeps_unlimited_semantics():
    assert effective_timeout(0) == 0
    assert effective_timeout(-1) == -1
    assert effective_timeout(30, 600) == 600
