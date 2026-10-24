"""远程 A2A agent 的**定时探活** —— 让注册表上的「可用/异常」是自己更新的。

为什么需要
----------
远端 agent 在别人机器上：它挂了、域名过期、证书过期、被防火墙挡了，本平台
都不知道。以前只有「点一下重新解析」才刷新状态 —— 也就是说，注册表上那个
绿点代表的是「上次我手动看它的时候它是好的」，不是「它现在是好的」。

实现取舍
--------
* **并进已有的 20s tick**（``scheduler.loop``），不新建 cron、不起第二个服务。
  每个 agent 自己带 ``health_interval_s``（默认 300s），没到点就跳过 ——
  所以 tick 再密也不会把它变成每分钟敲一次门。
* 探活用**只读的发现请求**（GET 卡片），不跑任务：
  探活要能每 5 分钟做一次，就不能有副作用、不能占远端的执行并发。
* **连续 2 次失败才翻红**。单次抖动（CF 边缘抖动、远端刚好重启）不该让一个
  好好的 agent 在界面上变红 —— 那会让人开始不信任这个指示灯。
* 失败**不清空旧卡片**：远端暂时不可达，注册表里仍应看得见它原来会干什么。
* 只在**状态真的翻转**时写事件（ok→error / error→ok），探活本身不写 ——
  否则事件流里全是心跳，真正的手术记录被埋掉。
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select

from . import a2a_client, remote_agents as _ra
from .db import SessionLocal
from .models import RemoteAgent, now_ms

logger = logging.getLogger(__name__)

#: 同时探几个。远端可能一大堆，一次全打出去像 SYN 洪水。
CONCURRENCY = 5

#: 单次探活超时（秒）。只读卡片，10 秒都拿不回来基本就是不通了。
PROBE_TIMEOUT_S = 10.0

#: 连续失败到这个次数才翻红（1 次抖动不算）
FAIL_THRESHOLD = 2


async def _probe_one(row: RemoteAgent, sem: asyncio.Semaphore) -> dict:
    """探一个。返回 ``{id, name, before, after, error}``，不抛异常。"""
    async with sem:
        before = row.status
        stamp = now_ms()
        try:
            await a2a_client.discover(
                row.url, timeout=PROBE_TIMEOUT_S, headers=_ra.auth_headers(row)
            )
            row.status = "ok"
            row.last_ok_at = stamp
            row.last_error = ""
            row.health_fail_count = 0
        except Exception as exc:  # noqa: BLE001 —— 探测失败有十几种原因，一律记下继续
            row.health_fail_count = (row.health_fail_count or 0) + 1
            if row.health_fail_count >= FAIL_THRESHOLD:
                row.status = "error"
            row.last_error = f"探活失败（第 {row.health_fail_count} 次）：{str(exc)[:200]}"
        row.last_checked_at = stamp
        row.updated_at = stamp
        return {
            "id": row.id,
            "name": row.name or row.url,
            "before": before,
            "after": row.status,
            "error": row.last_error[:160] if row.status == "error" else "",
        }


async def sweep(force: bool = False) -> dict:
    """把所有到点的远端探一遍。``force=True`` 时忽略间隔（手动触发用）。"""
    stamp = now_ms()
    async with SessionLocal() as session:
        rows = (
            await session.execute(select(RemoteAgent).where(RemoteAgent.enabled.is_(True)))
        ).scalars().all()

        due: list[RemoteAgent] = []
        for row in rows:
            interval = row.health_interval_s if row.health_interval_s is not None else 300
            if interval <= 0 and not force:
                continue  # 用户明确关掉了自动探活
            last = row.last_checked_at or 0
            if force or stamp - last >= max(30, interval) * 1000:
                due.append(row)

        if not due:
            return {"checked": 0, "ok": 0, "flipped": []}

        sem = asyncio.Semaphore(CONCURRENCY)
        results = await asyncio.gather(
            *[_probe_one(row, sem) for row in due], return_exceptions=True
        )

        flipped = []
        for res in results:
            if isinstance(res, BaseException):  # noqa: F821 —— gather 的异常分支
                logger.warning("探活时出错：%s", res)
                continue
            if res["before"] != res["after"]:
                flipped.append(res)

        await session.commit()

        # 状态翻转才留痕（心跳不写，否则事件流全是噪音）
        for item in flipped:
            row = await session.get(RemoteAgent, item["id"])
            if row is None:
                continue
            if item["after"] == "error":
                msg = f"「{item['name']}」探活连续失败，标记为不可用：{item['error']}"
            else:
                msg = f"「{item['name']}」恢复可用"
            await _ra.log_event(session, row, "health", msg, {"status": item["after"]})
        await session.commit()

    ok_count = sum(1 for r in results if not isinstance(r, BaseException) and r["after"] == "ok")
    if due:
        logger.info(
            "远程 agent 探活：检查 %d 个，正常 %d 个，状态翻转 %d 个",
            len(due), ok_count, len(flipped),
        )
    return {"checked": len(due), "ok": ok_count, "flipped": flipped}
