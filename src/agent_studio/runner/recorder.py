"""模型调用**完整请求与响应**的记录器（AgentScope 中间件）。

为什么需要它
------------
``llm_call`` 表从第一天就建好了，元数据（tokens/耗时/ttft/cost）也一直在写 ——
但 ``request_blob`` / ``response_blob`` **从来没被填过**（列一直空着）。结果是：
出错时只能看到"这次调用花了 1.2 万 token"，看不到"到底把哪些消息、哪些工具定义
发给了模型，模型又原样回了什么"。排障最需要的恰恰是后者。

怎么接：AgentScope 2.x 的中间件系统有 ``on_model_call`` 钩子（见
``Agent.__call__`` 里的 middleware 链），签名是
``(agent, input_kwargs, next_handler)``，``input_kwargs`` 里带着
``messages / tools / tool_choice / current_model``，返回 ``ChatResponse``
或**流式**的 ``AsyncGenerator[ChatResponse]``。这里就挂在那个钩子上。

两个必须处理对的点
------------------
1. **流式**：chunks 是增量（``TextBlock.text`` 只带这一片），必须用
   ``ChatResponse.append_chat_response`` 累加；最后一个 chunk 不是完整响应。
   累加时对首个 chunk 做深拷贝，避免改到 agent 真正在消费的那个对象。
2. **绝不能因为记录失败而让执行失败**：写库包在 try/except 里，出错只留一条
   warning。观测是配菜，执行是主菜。

体积：单侧超过 ``MAX_SIDE_CHARS`` 就截断并在 JSON 里写明（``payload_truncated``），
存 zlib 压缩后的 bytes —— 一次 ReAct 循环的请求可能几十 KB，压完通常只剩一两成。
"""

from __future__ import annotations

import dataclasses
import json
import logging
import time
import zlib
from typing import Any

from agentscope.middleware import MiddlewareBase

from ..db import SessionLocal
from ..models import LlmCall, now_ms
from .ctx import current_run_ctx

logger = logging.getLogger(__name__)

#: 单侧（请求或响应）落库前的字符上限。超了截断并写标记 ——
#: 宁可留个"这里被截了"的明确信号，也不要写进去几十 MB 把库拖垮。
MAX_SIDE_CHARS = 200_000


def _plain(obj: Any) -> Any:
    """把任意对象变成可 JSON 序列化的形状（pydantic / 枚举 / 日期都兜住）。"""
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, dict):
        return {str(k): _plain(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [_plain(v) for v in obj]
    for attr in ("model_dump", "to_dict", "dict"):
        fn = getattr(obj, attr, None)
        if callable(fn):
            try:
                return _plain(fn())
            except Exception:  # noqa: BLE001 —— 兜底：序列化不了就走下面
                break
    # 非 pydantic 的普通对象（dataclass / 自定义类）：取字段，别整块退化成字符串 ——
    # 退化成 str 会把结构丢掉，排查时看到的是一坨 repr（这类"看不见结构"的坑踩过）
    if dataclasses.is_dataclass(obj):
        return _plain(dataclasses.asdict(obj))
    plain_dict = getattr(obj, "__dict__", None)
    if isinstance(plain_dict, dict) and plain_dict:
        return _plain({k: v for k, v in plain_dict.items() if not k.startswith("_")})
    return str(obj)


def _dump_json(payload: Any) -> str:
    try:
        text = json.dumps(payload, ensure_ascii=False, default=str)
    except Exception:  # noqa: BLE001
        text = json.dumps(str(payload), ensure_ascii=False)
    if len(text) > MAX_SIDE_CHARS:
        head = text[:MAX_SIDE_CHARS]
        text = json.dumps(
            {
                "_truncated": True,
                "_original_chars": len(text),
                "_note": f"超过 {MAX_SIDE_CHARS} 字符，仅保留前段",
                "_head": head,
            },
            ensure_ascii=False,
        )
    return text


def _compress(text: str) -> tuple[bytes, int]:
    """返回 (压缩字节, 是否被截断)。"""
    raw = text.encode("utf-8")
    truncated = int('"_truncated": true' in text)
    return zlib.compress(raw, 6), truncated


def _usage_of(resp: Any) -> tuple[int, int, int]:
    usage = getattr(resp, "usage", None)
    get = usage.get if isinstance(usage, dict) else (lambda k, d=0: getattr(usage, k, d) or 0)
    return (
        int(get("input_tokens", 0) or 0),
        int(get("output_tokens", 0) or 0),
        int(get("cache_input_tokens", 0) or 0),
    )


class ModelCallRecorder(MiddlewareBase):
    """AgentScope 中间件：记下每次模型调用的完整请求与响应。

    只实现 ``on_model_call`` 一个钩子（`is_implemented` 会据方法存在与否判断，
    所以不要去实现其它钩子）。
    """

    def __init__(self, *, provider: str = "", model: str = "") -> None:
        self._provider = provider
        self._model = model
        #: 这条执行里的第几次调用（1 起）。实例是**每次编译一个**（即每次执行一个），
        #: 所以计数天然按执行隔离。
        self._seq = 0

    # ------------------------------------------------------------------ #
    # 钩子
    # ------------------------------------------------------------------ #
    async def on_model_call(self, agent: Any, input_kwargs: dict, next_handler: Any) -> Any:
        run_id = str(current_run_ctx().get("run_id") or "")
        self._seq += 1
        seq = self._seq
        started = now_ms()
        t0 = time.monotonic()

        model_obj = input_kwargs.get("current_model")
        model_name = self._model or str(getattr(model_obj, "model_name", "") or "")
        provider = self._provider or str(getattr(model_obj, "provider", "") or "")
        request_text = _dump_json(
            {
                "model": model_name,
                "provider": provider,
                # 生成参数（温度/最大长度等）—— 模型实例上，不在 input_kwargs 里
                "generate_kwargs": _plain(getattr(model_obj, "generate_kwargs", {}) or {}),
                "messages": _plain(input_kwargs.get("messages")),
                "tools": _plain(input_kwargs.get("tools")),
                "tool_choice": _plain(input_kwargs.get("tool_choice")),
            }
        )

        try:
            result = await next_handler(**input_kwargs)
        except BaseException as exc:  # noqa: BLE001 —— 失败的调用同样要留证
            await self._save(
                run_id, seq, provider, model_name, request_text, "", started, t0, 0, 0, 0,
                error=f"{type(exc).__name__}: {exc}",
            )
            raise

        if hasattr(result, "__aiter__"):
            return self._wrap_stream(result, run_id, seq, provider, model_name, request_text, started, t0)

        await self._save(
            run_id, seq, provider, model_name, request_text,
            _dump_json(_response_payload(result)), started, t0, *_usage_of(result),
        )
        return result

    # ------------------------------------------------------------------ #
    # 流式：累加增量分片，流结束再落库
    # ------------------------------------------------------------------ #
    async def _wrap_stream(self, stream: Any, run_id: str, seq: int, provider: str,
                           model_name: str, request_text: str, started: int, t0: float) -> Any:
        acc = None
        last = None
        failed: BaseException | None = None
        try:
            async for chunk in stream:
                last = chunk
                if acc is None:
                    # 深拷贝首片：后面 append 会改它，不能动 agent 正在消费的那个对象
                    try:
                        acc = chunk.model_copy(deep=True)
                    except Exception:  # noqa: BLE001
                        acc = chunk
                elif acc is not chunk:
                    try:
                        acc.append_chat_response(chunk)
                    except Exception:  # noqa: BLE001
                        acc = chunk
                yield chunk
        except BaseException as exc:  # noqa: BLE001
            failed = exc
            raise
        finally:
            try:
                target = acc if acc is not None else last
                payload = _dump_json(_response_payload(target)) if target is not None else ""
                err = f"{type(failed).__name__}: {failed}" if failed else None
                usage = _usage_of(target) if target is not None else (0, 0, 0)
                await self._save(run_id, seq, provider, model_name, request_text,
                                 payload, started, t0, *usage, error=err)
            except Exception:  # noqa: BLE001
                logger.warning("模型调用记录（流式）落库失败", exc_info=True)

    # ------------------------------------------------------------------ #
    # 落库
    # ------------------------------------------------------------------ #
    async def _save(self, run_id: str, seq: int, provider: str, model_name: str,
                    request_text: str, response_text: str, started: int, t0: float,
                    tokens_in: int, tokens_out: int, cache_read: int,
                    error: str | None = None) -> None:
        if not run_id:
            return  # 没有执行上下文（例如离线测试）→ 不写
        try:
            req_blob, req_trunc = _compress(request_text)
            resp_blob, resp_trunc = _compress(response_text) if response_text else (None, 0)
            async with SessionLocal() as session:
                session.add(
                    LlmCall(
                        run_id=run_id,
                        iteration=seq,
                        provider=provider or None,
                        model=model_name or None,
                        started_at=started,
                        ended_at=now_ms(),
                        duration_ms=int((time.monotonic() - t0) * 1000),
                        tokens_in=tokens_in,
                        tokens_out=tokens_out,
                        tokens_cache_read=cache_read,
                        status="error" if error else "ok",
                        error=error,
                        request_blob=req_blob,
                        response_blob=resp_blob,
                        payload_truncated=int(req_trunc or resp_trunc),
                    )
                )
                await session.commit()
        except Exception:  # noqa: BLE001 —— 记录失败不能影响执行
            logger.warning("模型调用记录落库失败 run=%s seq=%s", run_id, seq, exc_info=True)


def _response_payload(resp: Any) -> dict[str, Any]:
    """把 ChatResponse 变成可读的 JSON（内容块 + 结束原因 + 用量）。"""
    if resp is None:
        return {}
    out: dict[str, Any] = {"content": _plain(getattr(resp, "content", None))}
    for key in ("finished_reason", "usage", "id", "metadata"):
        value = getattr(resp, key, None)
        if value is not None:
            out[key] = _plain(value)
    if not out.get("content"):
        out["repr"] = str(resp)
    return out


def decode_payload(blob: bytes | None) -> Any:
    """读回来：zlib 解压 + JSON 解析（接口层用它给界面出原文）。"""
    if not blob:
        return None
    try:
        return json.loads(zlib.decompress(blob).decode("utf-8"))
    except Exception:  # noqa: BLE001 —— 老数据可能不是 zlib，兜底当文本
        try:
            return json.loads(bytes(blob).decode("utf-8"))
        except Exception:  # noqa: BLE001
            return {"_raw": str(blob)[:2000]}
