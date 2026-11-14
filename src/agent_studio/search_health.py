"""内置搜索通道的自检 —— 每天跑一次固定查询，坏了要让界面说得出话。

为什么需要
==========
`web_search` 依赖的是**别人的页面**：腾讯搜索的卡片接口、Bing 的 RSS 出口。
这两家都不会通知我们"我改结构了/我封你了"。真实发生过的样子是：查询照常返回
200，内容却是固定池里的无关结果（查 nginx 返回冠状病毒百科）—— 工具"看起来
成功"，模型把垃圾当答案。这比报错更糟。

所以这里做一件很小的事：每天拿一句固定的中文、一句固定的英文去真搜一次，
看**首条结果里命中了多少查询词**。低于阈值或慢到不可用，就把状态落进
``app_setting: search_health``，系统设置页按它显示红/绿。

设计取舍
========
* **并进已有的 20s tick**（``scheduler.loop``），不新建 cron、不起第二个服务；
  自己带 ``INTERVAL_S``，没到点直接返回，tick 再密也不会变成每分钟敲一次门。
* **只探主通道**（腾讯搜索）。它是被依赖的那条；Bing 是备选，坏了不影响
  整体可用性，探它只会让状态忽红忽绿。
* **两次都过才算 ok**：单次抖动不算坏，但"中文问不出来"必须算坏 —— 用户
  绝大多数查询是中文。
* 自检本身**不写事件流**，只在状态翻转时记一行日志（和 remote_health 同一口径：
  心跳不该把真正的手术记录埋掉）。
"""

from __future__ import annotations

import logging
import time
from typing import Any

from sqlalchemy import select

from .db import SessionLocal
from .models import AppSetting, now_ms
from .native_tools import SEARCH_TIMEOUT_S, _clean, _relevance, _search_qq

logger = logging.getLogger(__name__)

#: app_setting 里的键（跟 memory_external 一样是 JSON 文本）
KEY = "search_health"

#: 多久自检一次（秒）。用户口径是"每天一次"，别把它做成高频心跳。
INTERVAL_S = 24 * 3600

#: 相关度阈值：首条结果标题+域名至少命中一半查询词才算这条通道健康。
THRESHOLD = 0.5

#: 慢到这个程度，即使结果对，工具在 Agent 手里也等于不可用。
LATENCY_LIMIT_MS = 8000

#: 固定探针：一句中文、一句英文。都是"技术词为主、结果稳定"的题，避免
#: 新闻类查询本身就没有稳定答案。
CANARY: list[tuple[str, str]] = [
    ("中文", "debian 12 安装 nginx"),
    ("英文", "rust async runtime"),
]


async def _probe(query: str) -> dict[str, Any]:
    started = time.perf_counter()
    out: str | None = None
    error = ""
    try:
        out = await _search_qq(query, 3)
    except Exception as exc:  # noqa: BLE001 —— 自检不能因为一次异常就整体失败
        error = f"{type(exc).__name__}: {exc}"
    ms = int((time.perf_counter() - started) * 1000)
    rel = _relevance(query, out) if out else 0.0
    return {
        "query": query,
        "ok": bool(out) and rel >= THRESHOLD and ms <= LATENCY_LIMIT_MS,
        "latency_ms": ms,
        "relevance": round(rel, 2),
        "first": (_clean(out.splitlines()[0])[:80] if out else ""),
        "error": error or ("" if out else "无结果"),
        "timeout_s": SEARCH_TIMEOUT_S,
    }


async def _read() -> dict[str, Any] | None:
    async with SessionLocal() as db:
        row = await db.get(AppSetting, KEY)
        return row.value if row and isinstance(row.value, dict) else None


async def _write(payload: dict[str, Any]) -> None:
    async with SessionLocal() as db:
        row = await db.get(AppSetting, KEY)
        if row is None:
            db.add(AppSetting(key=KEY, value=payload, updated_at=now_ms()))
        else:
            row.value = payload
            row.updated_at = now_ms()
        await db.commit()


async def check(force: bool = False) -> dict[str, Any]:
    """真搜一次，落状态并返回。``force=False`` 时未到间隔就直接返回上次结果。"""
    prev = await _read()
    now = int(time.time() * 1000)
    if not force and prev and now - int(prev.get("checked_at") or 0) < INTERVAL_S * 1000:
        return prev

    probes = [await _probe(q) for _, q in CANARY]
    payload = {
        "ok": all(p["ok"] for p in probes),
        "checked_at": now,
        "engine": "qq",
        "interval_s": INTERVAL_S,
        "threshold": THRESHOLD,
        "probes": probes,
    }
    await _write(payload)

    flipped = prev is None or bool(prev.get("ok")) != payload["ok"]
    if flipped:
        logger.warning(
            "搜索通道自检：%s（%s）",
            "正常" if payload["ok"] else "异常",
            "；".join(f"{p['query']}={p['relevance']}/{p['latency_ms']}ms" for p in probes),
        )
    else:
        logger.info("搜索通道自检完成：ok=%s", payload["ok"])
    return payload


async def maybe_check() -> None:
    """调度器每轮调一次；没到点就立刻返回（不做任何网络请求）。"""
    try:
        prev = await _read()
    except Exception:  # noqa: BLE001
        logger.debug("搜索自检：读状态失败", exc_info=True)
        return
    now = int(time.time() * 1000)
    if prev and now - int(prev.get("checked_at") or 0) < INTERVAL_S * 1000:
        return
    await check(force=True)


async def state() -> dict[str, Any]:
    """给接口用：只读不探。从来没跑过时回 ``checked_at=0``，界面显示"还没自检"。"""
    prev = await _read() or {}
    return {
        "ok": prev.get("ok"),
        "checked_at": int(prev.get("checked_at") or 0),
        "engine": prev.get("engine") or "qq",
        "interval_s": INTERVAL_S,
        "threshold": THRESHOLD,
        "probes": prev.get("probes") or [],
    }
