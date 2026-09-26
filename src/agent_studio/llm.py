"""单次模型调用（零新依赖：httpx 本来就在用）。

为什么单独抽出来
----------------
评分的「AI 裁判」需要**跟被测助手无关的一次干净调用**（同一个模型、一个明确的问题、
不要历史、不要工具）。原来这种调用只写在"凭据页测试连接"那个接口里，
评测要复用它就得把那段逻辑再抄一遍 —— 抄一遍就会有两种写法，以后改一处漏一处。
所以抽成这个 15 行的函数：谁需要一次干净调用都走它。
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


def _chat_url(base_url: str) -> str:
    """把各种 base_url 归一成 ``.../chat/completions``。

    火山引擎的 plan key 要打 ``/api/plan/v3``（打 ``/api/v3`` 会 401），
    这个拼接规则与凭据页保持一致 —— 两处不一致时用户会看到"同一个 key 一个页能用一个页不行"。
    """
    base = (base_url or "").strip().rstrip("/")
    if not base:
        base = "https://api.openai.com/v1"
    if base.endswith("/chat/completions"):
        return base
    return f"{base}/chat/completions"


async def chat_once(
    *,
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    timeout: float = 120.0,
    temperature: float = 0.0,
) -> tuple[str, str]:
    """调一次模型，返回 ``(回复文本, 错误说明)``；成功时错误是空串。

    不抛异常：调用方（评测打分）需要的是"这一例没评成，原因是什么"，
    而不是让整个评测炸掉 —— 一例评不了不该毁掉整批结果。
    """
    if not api_key:
        return "", "没有可用的 API key"
    payload: dict[str, Any] = {"model": model, "messages": messages, "stream": False}
    if temperature is not None:
        payload["temperature"] = temperature
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp = await client.post(
                _chat_url(base_url),
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
    except Exception as exc:  # noqa: BLE001 - 网络层什么都可能抛
        logger.warning("单次模型调用失败：%s", exc)
        return "", f"调用失败：{exc}"
    if resp.status_code != 200:
        return "", f"HTTP {resp.status_code}：{resp.text[:200]}"
    try:
        return (resp.json()["choices"][0]["message"]["content"] or ""), ""
    except Exception:  # noqa: BLE001
        return "", "返回体里没有 choices[0].message.content"


def extract_json(text: str) -> dict[str, Any] | None:
    """从模型的回复里抠出 JSON（允许它包着 ```json 或说一句废话）。

    裁判模型经常这样回：``好的，我的评分是：{"score": 8, ...}`` ——
    严格 ``json.loads`` 会失败，然后就"整批没分数"。所以先找最外层的花括号。
    """
    raw = (text or "").strip()
    if not raw:
        return None
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except ValueError:
        pass
    start, end = raw.find("{"), raw.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        data = json.loads(raw[start : end + 1])
        return data if isinstance(data, dict) else None
    except ValueError:
        return None
