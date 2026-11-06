"""运行时插话（steer）—— 一轮还在跑的时候，用户还能把它掰回来。

为什么不是「再发一条消息」：那条消息会排在这一轮**后面**，用户想拦的事情
（"别删那个目录""换个思路，用 API 不要爬页面"）发生时已经晚了。插话是把话
塞进**正在跑的这轮**上下文里，助手下一步推理就能看到。

实现上不重跑、不打断当前这一步：直接 ``runtime.steer(compiled, text)``，
由运行时把它 observe 进 agent 的上下文。已经在跑的那次工具调用/模型请求照常
完成，下一轮推理开始生效 —— 这也是产品上最不容易出事的粒度。

注册表只在**本进程**内存里：一轮结束就 detach，进程重启后表是空的（此时
run 本身也已经不在了）。所以"没人接着"的情况只需要一种回答：这一轮早结束了。
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

logger = __import__("logging").getLogger(__name__)

# run_id -> (runtime, compiled, on_delivered)
_live: dict[str, tuple[Any, Any, Callable[[str], Awaitable[None]] | None]] = {}
_lock = asyncio.Lock()

# run_id -> 现在是不是「可以安全插进去」的时机
#
# 为什么需要这个：AgentScope 每次推理都从 memory 重拼 prompt，`observe()` 是
# **直接追加到 memory 末尾**。一旦当前这一步是"助手已经发出 tool_calls、工具还没
# 回结果"，插进去的 user 消息会卡在 assistant(tool_calls) 和 tool 结果之间，
# 下一轮请求直接被服务商拒掉：
#   400 An assistant message with 'tool_calls' must be followed by tool messages…
# 实测就是这么炸的（一轮活跑到一半、用户插了句"别睡了"，整轮变成 error）。
# 所以：不安全的时候先收下，等这一步收尾（tool_exec_end / 该轮回答结束）再注入。
_state: dict[str, bool] = {}
_pending: dict[str, list[str]] = {}


class SteerResult:
    """插话的结果 —— 调用方（API/界面）要据此给人一句人话。"""

    DELIVERED = "delivered"      # 已经塞进这一轮的上下文
    DEFERRED = "deferred"        # 收到，但当前这一步还没做完，做完立刻塞进去
    GONE = "gone"                # 这一轮已经不在跑了
    UNSUPPORTED = "unsupported"  # 这个运行时还不会插话
    FAILED = "failed"            # 塞的时候出错（运行刚刚收尾）

    MESSAGES = {
        DELIVERED: "已插话：它在下一步就会看到",
        DEFERRED: "已插话：当前这一步跑完就生效（正在跑的这次调用不会被打断）",
        GONE: "这一轮已经结束了，这句话没送出去",
        UNSUPPORTED: "这个运行时还不支持运行中插话",
        FAILED: "这一轮刚好收尾，插话没送到",
    }


async def attach(
    run_id: str,
    runtime: Any,
    compiled: Any,
    on_delivered: Callable[[str], Awaitable[None]] | None = None,
) -> None:
    """这一轮开始跑了 —— 登记一下，之后才有人能往里插话。"""
    async with _lock:
        _live[run_id] = (runtime, compiled, on_delivered)
        _state[run_id] = True  # 刚起跑、还没进工具调用，可以立刻插
        _pending.pop(run_id, None)


# 这一轮收到的插话（收尾时要写进会话历史，否则刷新页面就看不见自己说过什么）
_texts: dict[str, list[str]] = {}


def remember(run_id: str, text: str) -> None:
    _texts.setdefault(run_id, []).append(text)


def take_texts(run_id: str) -> list[str]:
    """取走这一轮的插话（取完即清，避免同一条被写两次）。"""
    return _texts.pop(run_id, [])


async def detach(run_id: str) -> None:
    async with _lock:
        # 还没等到的插话不能丢：算进这一轮的留痕，收尾时会作为用户消息写进会话历史
        # （"我说了，但它在我这句话生效前就结束了" —— 至少别让人以为自己没说）。
        for text in _pending.pop(run_id, []):
            _texts.setdefault(run_id, []).append(text)
        _live.pop(run_id, None)
        _state.pop(run_id, None)


def is_live(run_id: str) -> bool:
    return run_id in _live


def mark_step(run_id: str, in_flight: bool) -> None:
    """告诉注册表：现在这一步能不能安全插进去。

    ``in_flight=True`` = 助手已经发了 tool_calls、工具还没回结果（或者正在生成回答），
    这时候 ``observe()`` 会把 user 消息插进 tool_calls 和 tool 结果中间，服务商直接
    400。所以先收下、等收尾再注入。
    """
    if run_id in _live:
        _state[run_id] = not in_flight


def is_safe(run_id: str) -> bool:
    return _state.get(run_id, False)


async def _inject(run_id: str, text: str) -> str:
    """真的塞进运行时。调用方保证此刻是安全时机。"""
    entry = _live.get(run_id)
    if entry is None:
        return SteerResult.GONE
    runtime, compiled, on_delivered = entry
    steer = getattr(runtime, "steer", None)
    if steer is None:
        return SteerResult.UNSUPPORTED
    try:
        await steer(compiled, text)
    except NotImplementedError:
        return SteerResult.UNSUPPORTED
    except Exception:  # noqa: BLE001
        logger.warning("插话失败 run=%s", run_id, exc_info=True)
        return SteerResult.FAILED
    if on_delivered is not None:
        try:
            await on_delivered(text)
        except Exception:  # noqa: BLE001
            logger.debug("插话留痕失败 run=%s", run_id, exc_info=True)
    return SteerResult.DELIVERED


async def flush(run_id: str) -> int:
    """这一步收尾了 —— 把等着的插话一次性注进去，返回注了几条。"""
    if not is_safe(run_id):
        return 0
    texts = _pending.pop(run_id, [])
    if not texts:
        return 0
    n = 0
    for text in texts:
        if await _inject(run_id, text) == SteerResult.DELIVERED:
            n += 1
    return n


def pending_count(run_id: str) -> int:
    return len(_pending.get(run_id, []))


async def deliver(run_id: str, text: str) -> str:
    """把一句话塞进正在跑的那一轮。返回 SteerResult 里的某个值。"""
    text = (text or "").strip()
    if not text:
        return SteerResult.FAILED
    entry = _live.get(run_id)
    if entry is None:
        return SteerResult.GONE
    runtime = entry[0]
    if getattr(runtime, "steer", None) is None:
        return SteerResult.UNSUPPORTED
    if not is_safe(run_id):
        # 正在工具调用 / 生成回答：先收下，等这一步收尾由 runner 注入
        _pending.setdefault(run_id, []).append(text)
        return SteerResult.DEFERRED
    return await _inject(run_id, text)
