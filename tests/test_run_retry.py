"""上游抖动该不该重试（回归护栏）。

现场（2026-09-26）：最近 40 条执行 11 条失败，全是 `APITimeoutError: Request timed out.`，
但 metrics 里 **retries 一直是 0** —— 因为 is_transient 的正则里只有
`read timeout` / `connect timeout` 这类字样，**匹配不上 openai 实际抛的文案** ✗
（而且 APITimeoutError 不是 builtin TimeoutError ✗ 所以前面的 isinstance 也拦不住它 ✓）。
"""
import asyncio

from agent_studio.runner.gate import backoff_s, is_transient


class APITimeoutError(Exception):
    """形状与 openai.APITimeoutError 一致（同名 + 同文案）。"""


class APIConnectionError(Exception):
    pass


def test_api_timeout_is_transient():
    assert is_transient(APITimeoutError("Request timed out.")) is True


def test_api_connection_error_is_transient():
    assert is_transient(APIConnectionError("Connection error.")) is True


def test_user_timeout_is_not_transient():
    # 用户自己设的执行超时 → 重试只会更慢，且掩盖真问题 ✓
    assert is_transient(asyncio.TimeoutError()) is False
    assert is_transient(TimeoutError("执行超时（>300s）")) is False


def test_cancelled_is_not_transient():
    assert is_transient(asyncio.CancelledError()) is False


def test_common_provider_errors_are_transient():
    for msg in ("429 Too Many Requests", "503 Service Unavailable", "connection reset by peer", "read timeout"):
        assert is_transient(RuntimeError(msg)) is True, msg


def test_backoff_is_capped():
    assert backoff_s(1) <= 30.0 and backoff_s(9) == 30.0
