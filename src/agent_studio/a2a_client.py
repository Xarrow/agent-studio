"""A2A 客户端 —— 让一次分派能把活派给**另一台平台上的 agent**
（零依赖：httpx + 手写 JSON-RPC 2.0，与 api/a2a.py 的服务端同一种话）。

为什么需要它（回答"agent 间 fork 支持 A2A 吗"）
--------------------------------------------
分派（fork）原来的语义是**进程内**的：子任务在本平台起一条 run，直接跑本地
运行时。所以"派给另一个 agent"只在本平台内成立 —— 跨平台就没办法了。

A2A 的定位正好补这一块：它把"一个 agent 能干活"这件事变成**网络上的一个端点**
（发现卡片 + message/send + tasks/get + cancel）。有了客户端，fork 的每一路就能
指向远端：

    本平台助手 ──fork──▶ 远端 A2A agent（可能是另一台 agent-studio、也可能是
                         别的框架实现的 agent）

实现取舍
--------
* 只用 ``message/send`` + ``tasks/get`` 轮询，不依赖 SSE（``message/stream``）：
  分派本身要并行跑 N 路，用轮询最简单也最好排查；流式留给"单任务实时看"的场景。
* 远端卡在 ``waiting_hitl``（等人工确认）时**不傻等**：如实上报"远端在等人确认"，
  因为人什么时候点是不可知的（与本地分派的处理一致）。
* 网络/协议错误一律转成**这条 run 的失败原因**，不让它炸掉整批分派。
"""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urljoin

logger = logging.getLogger(__name__)

#: 轮询间隔与单任务上限（秒）—— 远端跑多久由远端决定，这里只是"别无限等"
POLL_S = 1.5
DEFAULT_TIMEOUT_S = 900.0

#: A2A 状态 → 本平台的 run 状态（与 api/a2a.py 的 STATE_MAP 反向对应）
STATE_TO_STATUS = {
    "submitted": "running",
    "working": "running",
    "input-required": "waiting_hitl",
    "completed": "ok",
    "canceled": "aborted",
    "failed": "error",
    "rejected": "error",
    "unknown": "error",
}


class A2AError(Exception):
    """远端返回的协议层错误（JSON-RPC error）或传输错误。"""


def _rpc_url(base: str) -> str:
    """把用户填的地址规整成 JSON-RPC 端点。

    容错：允许填 ``http://host:port``（自动补 ``/a2a``）、也允许直接填完整
    ``http://host:port/a2a``，还可以填卡片地址（``.../.well-known/agent-card.json``）
    —— 用户从卡片复制粘贴是常见动作，不该因此报错。
    """
    u = (base or "").strip().rstrip("/")
    if not u:
        raise A2AError("远端地址为空")
    if u.endswith(".well-known/agent-card.json"):
        u = u[: -len(".well-known/agent-card.json")].rstrip("/")
    if u.endswith("/a2a"):
        return u
    return urljoin(u + "/", "a2a")


async def _post_json(url: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    import httpx

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=payload, headers={"Accept": "application/json"})
    except httpx.HTTPError as exc:
        raise A2AError(f"连不上远端 {url}（{type(exc).__name__}: {str(exc)[:120]}）") from exc
    if resp.status_code >= 400:
        raise A2AError(f"远端返回 HTTP {resp.status_code}（{url}）")
    try:
        body = resp.json()
    except Exception as exc:  # noqa: BLE001
        raise A2AError(f"远端返回的不是 JSON（{url}）") from exc
    if isinstance(body, dict) and body.get("error"):
        err = body["error"] or {}
        raise A2AError(f"远端协议错误 {err.get('code')}: {err.get('message')}")
    return body or {}


async def discover(base: str, timeout: float = 15.0) -> dict[str, Any]:
    """读远端 agent card（发现：这台远端有什么能力、叫什么名字）。"""
    import httpx

    u = (base or "").strip().rstrip("/")
    if not u:
        raise A2AError("远端地址为空")
    if u.endswith(".well-known/agent-card.json"):
        card_url = u
    else:
        card_url = urljoin(u + "/", ".well-known/agent-card.json")
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(card_url, headers={"Accept": "application/json"})
    except httpx.HTTPError as exc:
        raise A2AError(f"拉取卡片失败 {card_url}（{type(exc).__name__}: {str(exc)[:120]}）") from exc
    if resp.status_code >= 400:
        raise A2AError(f"卡片地址返回 HTTP {resp.status_code}（{card_url}）")
    try:
        return resp.json() or {}
    except Exception as exc:  # noqa: BLE001
        raise A2AError(f"卡片不是 JSON（{card_url}）") from exc


async def send(
    base: str,
    text: str,
    *,
    agent_id: str | None = None,
    timeout: float = 60.0,
) -> str:
    """发一条消息，返回远端 Task id。

    ``agent_id`` 会放进 message.metadata.agentId —— 远端平台据此选具体助手
    （本平台的 a2a.py 认这个字段；远端若不认，忽略即可，走它的默认助手）。
    """
    url = _rpc_url(base)
    message: dict[str, Any] = {
        "role": "user",
        "parts": [{"kind": "text", "text": text}],
    }
    if agent_id:
        message["metadata"] = {"agentId": agent_id}
    body = await _post_json(
        url,
        {"jsonrpc": "2.0", "id": 1, "method": "message/send", "params": {"message": message}},
        timeout,
    )
    task = (body.get("result") or {}) if isinstance(body, dict) else {}
    task_id = str(task.get("id") or "")
    if not task_id:
        raise A2AError("远端没有返回 task id")
    return task_id


async def get_task(base: str, task_id: str, *, timeout: float = 30.0) -> dict[str, Any]:
    """查一个远端 Task 的当前状态。"""
    url = _rpc_url(base)
    body = await _post_json(
        url,
        {"jsonrpc": "2.0", "id": 1, "method": "tasks/get", "params": {"id": task_id}},
        timeout,
    )
    return (body.get("result") or {}) if isinstance(body, dict) else {}


async def cancel(base: str, task_id: str, *, timeout: float = 30.0) -> None:
    url = _rpc_url(base)
    await _post_json(
        url,
        {"jsonrpc": "2.0", "id": 1, "method": "tasks/cancel", "params": {"id": task_id}},
        timeout,
    )


def task_text(task: dict[str, Any]) -> str:
    """从 Task 里取回答文本（artifacts 优先，其次 status.message）。"""
    for art in task.get("artifacts") or []:
        for part in art.get("parts") or []:
            t = part.get("text")
            if isinstance(t, str) and t.strip():
                return t
    msg = (task.get("status") or {}).get("message") or {}
    for part in msg.get("parts") or []:
        t = part.get("text")
        if isinstance(t, str) and t.strip():
            return t
    return ""


def state_of(task: dict[str, Any]) -> str:
    return str(((task.get("status") or {}).get("state")) or "unknown")


def status_of(task: dict[str, Any]) -> str:
    return STATE_TO_STATUS.get(state_of(task), "error")


async def run_until_done(
    base: str,
    text: str,
    *,
    agent_id: str | None = None,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> tuple[str, str, str]:
    """发一条消息并等到终态。

    返回 ``(状态, 文本, 远端 task_id)``；状态是**本平台的 run 状态**（ok/error/
    aborted/waiting_hitl）。远端在等人确认时**立即返回 waiting_hitl**，不傻等 ——
    人什么时候点不可知，等着只会把它拖成"跑太久"（误导）。
    """
    import asyncio
    import time

    task_id = await send(base, text, agent_id=agent_id)
    deadline = time.monotonic() + max(30.0, timeout_s)
    while True:
        task = await get_task(base, task_id)
        state = state_of(task)
        if state == "input-required":
            return "waiting_hitl", task_text(task), task_id
        if state in ("completed", "canceled", "failed", "rejected"):
            return status_of(task), task_text(task), task_id
        if time.monotonic() >= deadline:
            return "error", f"等远端超时（>{int(timeout_s)}s，远端任务 {task_id} 仍在跑）", task_id
        await asyncio.sleep(POLL_S)
