"""会话定时任务 + 结果投递。

为什么这两件事必须一起做
------------------------
只有定时没有投递 = 跑了个寂寞：结果躺在某个列表里，没人会去翻。
只有投递没有定时 = 你得先想起来去点。Hermes 之所以"真的在替你干活"，
是因为 定时 → 跑 → 把结果推到你手机上 这一整圈是闭合的。

所以：定时任务挂在**会话**上（结果回到对话里，能接着追问），
同时按配置推一份到 webhook（飞书/企业微信/钉钉/自定义，都是 POST 一个 JSON）。

投递为什么走队列
----------------
"跑完直接 push" 在三种情况下会丢消息：服务重启、webhook 临时 502、机器断网。
所以每次触发都先写一条 ``JobDelivery(pending)``，tick 扫到运行已结束就送；
失败的记 attempts/error，界面能看出"为什么没收到"，而不是安静地消失。
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

import httpx
from sqlalchemy import select

from .db import SessionLocal
from .models import JobDelivery, Run, Session, SessionJob, SessionMessage, now_ms
from .scheduler import compute_next

logger = logging.getLogger(__name__)

#: 投递通道：本会话（就留在对话里）/ webhook
CHANNELS = ("session", "webhook")
#: webhook 的报文格式（国内几个群机器人都是"POST 一个 JSON"，字段名各不相同）
FORMATS = ("generic", "feishu", "wecom", "dingtalk")
#: 最多试几次（20 秒一拍，3 次 ≈ 1 分钟内给三次机会）
MAX_ATTEMPTS = 3

#: 定时任务单次执行的结果只取正文的前这么多个字（webhook 有长度限制，飞书 20KB）
DELIVER_CHARS = 3000


# --------------------------------------------------------------------------- #
# 变更门（monitor）—— 没变化就不跑
# --------------------------------------------------------------------------- #
#: 监视值最多留这么长（超了截断：对比只需要指纹，不需要全文）
MONITOR_CHARS = 4000
#: 跑监视命令的超时（秒）—— 它只是个探针，不该比任务本身还久
MONITOR_TIMEOUT_S = 20


def monitor_kind_of(raw: Any) -> str:
    """把界面上传来的监视类型收敛成三种之一（其余一律当没配）。"""
    kind = str(raw or "").strip().lower()
    return kind if kind in ("command", "url") else ""


async def read_monitor(kind: str, spec: str, *, cwd: str | None = None) -> str:
    """取一次监视值：命令的输出 / 网址的正文。

    取不到就抛异常 —— 调用方按"这一轮要跑"处理（宁可多跑一次，也不能因为
    探针坏了就永远不跑：那会让用户以为任务停了）。
    """
    spec = (spec or "").strip()
    if not spec:
        raise ValueError("监视内容为空")
    if kind == "url":
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            r = await client.get(spec, headers={"User-Agent": "agent-studio-monitor/1"})
            r.raise_for_status()
            text = r.text
        return text[:MONITOR_CHARS]

    # 命令：交给平台的危险命令闸门先判一次（定时任务没人看着点"允许"）
    from .guardrails import RISK_DENY, classify_command, downgrade_if_unattended

    verdict = downgrade_if_unattended(classify_command(spec, workspace=cwd))
    if verdict.risk == RISK_DENY:
        raise PermissionError(f"监视命令被拒绝执行：{verdict.reason}")

    import asyncio

    proc = await asyncio.create_subprocess_shell(
        spec,
        cwd=cwd or None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=MONITOR_TIMEOUT_S)
    except asyncio.TimeoutError:  # noqa: UP041
        proc.kill()
        raise TimeoutError(f"监视命令超过 {MONITOR_TIMEOUT_S} 秒没结束") from None
    text = out.decode("utf-8", "replace")
    if proc.returncode not in (0, None):
        # 非 0 退出 = 这个探针本身有问题（路径不存在、权限、语法错）。
        # 当成"没变化"会永久停跑，当成"有变化"会让模型看一堆噪音 —— 报出来最诚实。
        raise RuntimeError(f"监视命令退出码 {proc.returncode}：{text.strip()[:200]}")
    return text[:MONITOR_CHARS]


def monitor_prompt(prompt: str, *, before: str, after: str) -> str:
    """监视到变化时，喂给模型的这一轮该长什么样。

    要说清"变了什么"，否则模型只知道"跑一次"，用户看到的还是那套旧内容。
    """
    before_txt = (before or "").strip()
    tail = before_txt[-1200:] if before_txt else "（第一次，没有上一版）"
    return (
        f"{prompt}\n\n"
        "【监视到变化】下面这项检查的结果和上次不一样了，按上面的事做一次：\n"
        f"上一次：{tail}\n"
        f"这一次：{(after or '').strip()[:1200]}\n"
        "如果这次变化其实没有实质影响，就直接说「无实质变化」，别硬凑内容。"
    )


def next_for(job: SessionJob, now: int | None = None) -> int | None:
    """下一次什么时候跑（复用 Workflow 那套纯函数 —— 同一个"什么时候"只算一次逻辑）。"""
    return compute_next(job.mode, job.at, job.weekdays, now)


def _clean_url(url: str) -> str:
    u = (url or "").strip()
    if not u.lower().startswith(("http://", "https://")):
        raise ValueError("投递地址必须是 http:// 或 https:// 开头")
    return u


def normalise_deliver(raw: Any) -> dict[str, str]:
    """把前端传来的投递配置收拢成 ``{channel, url, format}``（脏值一律降级为"本会话"）。"""
    d = raw if isinstance(raw, dict) else {}
    channel = str(d.get("channel") or "session")
    if channel not in CHANNELS:
        channel = "session"
    if channel == "session":
        return {"channel": "session"}
    url = _clean_url(str(d.get("url") or ""))
    fmt = str(d.get("format") or "generic")
    if fmt not in FORMATS:
        fmt = "generic"
    return {"channel": "webhook", "url": url, "format": fmt}


def describe_schedule(mode: str, at: str, weekdays: str) -> str:
    """给界面/投递文案用的人话（"每天 09:00" / "每周一、三 09:00"）。"""
    from .scheduler import describe

    return describe(mode, at, weekdays)


# --------------------------------------------------------------------------- #
# 触发
# --------------------------------------------------------------------------- #
async def fire(job_id: str, *, now: int | None = None, manual: bool = False) -> str | None:
    """把这个任务跑一次：在会话里发起一轮 run，并排一条投递。

    返回 run_id（没发起就 None）。
    """
    from .api.runs import _start_session_turn  # 延迟导入：避免启动期环依赖

    now = now_ms() if now is None else now
    async with SessionLocal() as db:
        job = await db.get(SessionJob, job_id)
        if job is None:
            return None
        if not manual and not job.enabled:
            return None
        prompt = (job.prompt or "").strip()
        if not prompt:
            job.last_run_at = now
            job.last_status = "skipped"
            job.next_run_at = next_for(job, now)
            await db.commit()
            logger.warning("定时任务 %s 没有提示词，跳过", job_id)
            return None
        # 这个会话还有没跑完的一轮 → 跳过（叠着起会把上下文搅乱）
        running = (
            await db.execute(
                select(Run.id).where(
                    Run.session_id == job.session_id, Run.status.in_(("pending", "running"))
                )
            )
        ).first()
        if running:
            job.last_run_at = now
            job.last_status = "skipped"
            job.next_run_at = next_for(job, now)
            await db.commit()
            logger.info("定时任务 %s：会话里这一轮还没跑完，跳过", job_id)
            return None

        # ── 变更门：先看一眼有没有变化，没变化就整轮跳过（不唤起模型、不刷屏）──
        # 手动「立刻跑一次」不受变更门限制 —— 用户点名要跑，就不该被"没变化"挡掉
        job_kind = monitor_kind_of(job.monitor_kind) if not manual else ""
        if job_kind and (job.monitor or "").strip():
            from .runner.service import session_work_dir  # 与助手干活同一个目录

            # 会话目录可能还没建（还没跑过任何一轮）—— 建出来，
            # 否则探针拿到一个不存在的 cwd 会直接抛错，被当成"检查失败"永远照常跑
            _cwd_path = session_work_dir(job.session_id)
            _cwd_path.mkdir(parents=True, exist_ok=True)
            _cwd = str(_cwd_path)
            try:
                value = await read_monitor(job_kind, job.monitor, cwd=_cwd)
            except Exception as _exc:  # noqa: BLE001
                # 探针坏了**不能**变成"永远不跑"：按要跑处理，并把原因记下来
                logger.warning("定时任务 %s 的监视检查失败（%s），照常跑一次", job_id, _exc)
                value = None
                job.monitor_last = (job.monitor_last or "") + "\n[检查失败] " + str(_exc)[:200]
            if value is not None:
                if value == (job.monitor_last or ""):
                    job.last_run_at = now
                    job.last_status = "skipped"
                    job.next_run_at = next_for(job, now)
                    job.updated_at = now_ms()
                    await db.commit()
                    logger.info("定时任务 %s：监视值没变，跳过这一轮", job_id)
                    return None
                prompt = monitor_prompt(prompt, before=job.monitor_last or "", after=value)
                job.monitor_last = value

        chat = await db.get(Session, job.session_id)
        if chat is None:
            # 会话被删了 → 任务没有落脚点，停用（不静默转到别处）
            job.enabled = 0
            job.next_run_at = None
            await db.commit()
            logger.warning("定时任务 %s 的会话已不存在，已停用", job_id)
            return None

        run_id = await _start_session_turn(
            db,
            agent_id=job.agent_id,
            session_id=job.session_id,
            text=prompt,
            origin="schedule",
        )
        if run_id is None:
            job.last_run_at = now
            job.last_status = "error"
            job.next_run_at = next_for(job, now)
            await db.commit()
            return None

        deliver = job.deliver or {"channel": "session"}
        db.add(
            JobDelivery(
                job_id=job.id,
                run_id=run_id,
                session_id=job.session_id,
                status="pending",
                channel=str(deliver.get("channel") or "session"),
                target=str(deliver.get("url") or ""),
                format=str(deliver.get("format") or "generic"),
                created_at=now,
            )
        )
        job.last_run_at = now
        job.last_run_id = run_id
        job.last_status = None  # 等跑完再说
        job.next_run_at = next_for(job, now)
        job.updated_at = now_ms()
        await db.commit()
        logger.info("定时触发：%s → %s", job.id, run_id)
        return run_id


async def fire_due(now: int | None = None) -> list[str]:
    """tick 调用：把所有到点的任务发起来，返回本轮发起的 job_id。"""
    now = now_ms() if now is None else now
    async with SessionLocal() as db:
        due = list(
            (
                await db.execute(
                    select(SessionJob).where(
                        SessionJob.enabled == 1, SessionJob.next_run_at.is_not(None)
                    )
                )
            ).scalars()
        )
    fired: list[str] = []
    for job in due:
        if job.next_run_at is None:
            continue
        if job.next_run_at > now:
            continue
        try:
            rid = await fire(job.id, now=now)
        except Exception as exc:  # noqa: BLE001 —— 一次失败不能被调度器放大
            logger.warning("定时任务 %s 触发失败：%s", job.id, exc)
            rid = None
        if rid:
            fired.append(job.id)
    return fired


# --------------------------------------------------------------------------- #
# 投递
# --------------------------------------------------------------------------- #
def _payload(fmt: str, title: str, text: str) -> dict[str, Any]:
    body = f"{title}\n\n{text}" if title else text
    if fmt == "feishu":
        return {"msg_type": "text", "content": {"text": body}}
    if fmt in ("wecom", "dingtalk"):
        return {"msgtype": "text", "text": {"content": body}}
    return {"title": title, "text": text}


async def deliver_one(d: JobDelivery) -> bool:
    """送一条。返回是否成功（失败会记 attempts/error，交给下一拍重试）。"""
    if d.channel == "session":
        d.status = "skipped"  # 结果已经在这个会话里了，不需要再送
        d.sent_at = now_ms()
        return True

    async with SessionLocal() as db:
        run = await db.get(Run, d.run_id)
        job = await db.get(SessionJob, d.job_id)
        chat = await db.get(Session, d.session_id)
        if run is None:
            d.status = "failed"
            d.error = "运行记录已不存在"
            return False
        if run.status in ("pending", "running"):
            return False  # 还没跑完，下一拍再看

        # 正文：run.output 里各 runtime 的键不一样（AgentScope 落 content，
        # 别的落 text）—— 两个都认；再不行取这个会话最后一条助手消息。
        out = run.output if isinstance(run.output, dict) else {}
        text = str(out.get("text") or out.get("content") or "").strip()
        if not text:
            from sqlalchemy import select as _select

            last = (
                await db.execute(
                    _select(SessionMessage.content)
                    .where(
                        SessionMessage.session_id == d.session_id,
                        SessionMessage.role == "assistant",
                    )
                    .order_by(SessionMessage.ts.desc())
                    .limit(1)
                )
            ).first()
            text = (last[0] if last else "").strip()
        if not text:
            text = "（这一轮没有产出文字，去对话里看过程）"
        if len(text) > DELIVER_CHARS:
            text = text[:DELIVER_CHARS] + "…"

        status_text = {"ok": "完成", "error": "失败", "aborted": "已停止"}.get(run.status, run.status)
        title = f"【{chat.title if chat else '定时任务'}】{status_text}"
        if job is not None:
            title += f" · {describe_schedule(job.mode, job.at, job.weekdays)}"

    d.attempts += 1
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                d.target or "",
                json=_payload(d.format, title, text),
                headers={"Content-Type": "application/json"},
            )
        if resp.status_code >= 300:
            raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:120]}")
        d.status = "sent"
        d.sent_at = now_ms()
        d.error = None
        return True
    except Exception as exc:  # noqa: BLE001
        d.error = str(exc)[:300]
        if d.attempts >= MAX_ATTEMPTS:
            d.status = "failed"
        logger.warning("投递失败 %s（第 %s 次）：%s", d.id, d.attempts, exc)
        return False


async def deliver_pending() -> int:
    """tick 调用：把该送的送出去，返回送成功的条数。"""
    async with SessionLocal() as db:
        rows = list(
            (
                await db.execute(
                    select(JobDelivery).where(JobDelivery.status == "pending").limit(20)
                )
            ).scalars()
        )

    sent = 0
    for d in rows:
        try:
            ok = await deliver_one(d)
        except Exception as exc:  # noqa: BLE001
            d.error = str(exc)[:300]
            ok = False
        if ok:
            sent += 1
        async with SessionLocal() as db:
            fresh = await db.get(JobDelivery, d.id)
            if fresh is not None:
                fresh.status = d.status
                fresh.attempts = d.attempts
                fresh.error = d.error
                fresh.sent_at = d.sent_at
                await db.commit()
    return sent


async def sync_last_status() -> None:
    """把"上一轮结果"写回任务行（界面上直接显示成功/失败）。"""
    async with SessionLocal() as db:
        jobs = list((await db.execute(select(SessionJob))).scalars())
        for job in jobs:
            if not job.last_run_id:
                continue
            run = await db.get(Run, job.last_run_id)
            if run is None or run.status in ("pending", "running"):
                continue
            # 刚因为「监视值没变」跳过的那一轮，不能被上一条 run 的结果盖回去 ——
            # 否则界面会显示"成功"，用户以为它真跑了（实际什么都没做）。
            if (job.last_status == "skipped") and (job.last_run_at or 0) > (run.started_at or 0):
                continue
            # 结果落定后把投递也补上（队列里那条会自己送；这里只管状态显示）
            want = {"ok": "ok", "error": "error", "aborted": "aborted"}.get(run.status, "error")
            if job.last_status != want:
                job.last_status = want
                await db.commit()
