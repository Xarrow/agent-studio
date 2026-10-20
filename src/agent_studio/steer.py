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


class SteerResult:
    """插话的结果 —— 调用方（API/界面）要据此给人一句人话。"""

    DELIVERED = "delivered"      # 已经塞进这一轮的上下文
    GONE = "gone"                # 这一轮已经不在跑了
    UNSUPPORTED = "unsupported"  # 这个运行时还不会插话
    FAILED = "failed"            # 塞的时候出错（运行刚刚收尾）

    MESSAGES = {
        DELIVERED: "已插话：它在下一步就会看到",
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


# 这一轮收到的插话（收尾时要写进会话历史，否则刷新页面就看不见自己说过什么）
_texts: dict[str, list[str]] = {}


def remember(run_id: str, text: str) -> None:
    _texts.setdefault(run_id, []).append(text)


def take_texts(run_id: str) -> list[str]:
    """取走这一轮的插话（取完即清，避免同一条被写两次）。"""
    return _texts.pop(run_id, [])


async def detach(run_id: str) -> None:
    async with _lock:
        _live.pop(run_id, None)


def is_live(run_id: str) -> bool:
    return run_id in _live


async def deliver(run_id: str, text: str) -> str:
    """把一句话塞进正在跑的那一轮。返回 SteerResult 里的某个值。"""
    text = (text or "").strip()
    if not text:
        return SteerResult.FAILED
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
