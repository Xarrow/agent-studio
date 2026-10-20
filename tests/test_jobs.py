"""会话定时任务 + 投递的护栏。

口径（2026-10，对标 Hermes 的 cron + deliver）：
  1. "到点就跑"：next_run_at 过期 → 在**这个会话里**发起一轮（人回来能接着追问）
  2. 静默跳过不算事故：上一轮还没跑完 / 没写提示词 / 任务被停用 → 跳过并记下原因
  3. 投递不丢：排进队列再送，失败重试，次数用尽标 failed（而不是安静消失）
  4. 报文按通道成形：飞书 / 企业微信 / 钉钉 / 自定义 JSON
  5. 地址只认 http(s)：不让配置里塞 file:// 或别的协议
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from sqlalchemy import select

from agent_studio import jobs
from agent_studio.runner import run_service
from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Agent, JobDelivery, Run, Session, SessionJob, SessionMessage, now_ms


class _Recorder(BaseHTTPRequestHandler):
    """最小的 webhook 接收端：把收到的 JSON 存到类属性里。"""

    received: list[dict] = []
    status = 200

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode() or "{}"
        try:
            _Recorder.received.append(json.loads(body))
        except json.JSONDecodeError:
            _Recorder.received.append({"raw": body})
        self.send_response(_Recorder.status)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, fmt, *args):  # 静音
        pass


def _serve() -> tuple[HTTPServer, str]:
    srv = HTTPServer(("127.0.0.1", 0), _Recorder)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_port}/hook"


async def _seed_session(agent_id: str = "ag_job_test", title: str = "定时验收") -> str:
    await init_db()
    now = now_ms()
    async with SessionLocal() as db:
        if await db.get(Agent, agent_id) is None:
            db.add(
                Agent(
                    id=agent_id,
                    slug=agent_id,
                    name="定时测试助手",
                    definition={"name": "定时测试助手", "model": {"provider": "custom", "model": "x"}},
                )
            )
        sid = f"ses_job{now % 100000}"
        db.add(Session(id=sid, agent_id=agent_id, title=title, created_at=now, last_active_at=now))
        await db.commit()
    return sid


async def test_建任务会排下一次_并带人话描述():
    sid = await _seed_session()
    async with SessionLocal() as db:
        chat = await db.get(Session, sid)
        job = SessionJob(
            session_id=sid,
            agent_id=chat.agent_id,
            prompt="汇总三条新闻",
            mode="daily",
            at="09:00",
            weekdays="1",
            enabled=1,
            deliver={"channel": "session"},
        )
        job.next_run_at = jobs.next_for(job)
        db.add(job)
        await db.commit()
        await db.refresh(job)
    assert job.next_run_at and job.next_run_at > now_ms()
    assert jobs.describe_schedule("daily", "09:00", "1") == "每天 09:00"


async def test_到点就发起一轮_排一条投递(monkeypatch):
    sid = await _seed_session()
    started: list[str] = []

    async def _fake_start(run_id, definition, payload):
        started.append(run_id)

    monkeypatch.setattr(run_service, "start", _fake_start)

    async with SessionLocal() as db:
        chat = await db.get(Session, sid)
        job = SessionJob(
            session_id=sid,
            agent_id=chat.agent_id,
            prompt="今天有什么",
            mode="hourly",
            enabled=1,
            deliver={"channel": "session"},
            next_run_at=now_ms() - 1000,  # 已经到点
        )
        db.add(job)
        await db.commit()
        await db.refresh(job)
        job_id = job.id

    fired = await jobs.fire_due()
    assert job_id in fired
    assert started, "应该发起了一轮 run"

    async with SessionLocal() as db:
        run = (await db.execute(select(Run).where(Run.session_id == sid))).scalars().first()
        assert run is not None and run.origin == "schedule"
        d = (await db.execute(select(JobDelivery).where(JobDelivery.job_id == job_id))).scalars().first()
        assert d is not None and d.status == "pending"
        fresh = await db.get(SessionJob, job_id)
        assert fresh.next_run_at > now_ms(), "跑完必须排下一次（否则永远不再跑）"


async def test_停用的任务不会跑_没写的也不会():
    sid = await _seed_session()
    async with SessionLocal() as db:
        chat = await db.get(Session, sid)
        off = SessionJob(
            session_id=sid, agent_id=chat.agent_id, prompt="x", mode="hourly",
            enabled=0, deliver={}, next_run_at=now_ms() - 1000,
        )
        empty = SessionJob(
            session_id=sid, agent_id=chat.agent_id, prompt="  ", mode="hourly",
            enabled=1, deliver={}, next_run_at=now_ms() - 1000,
        )
        db.add_all([off, empty])
        await db.commit()
        empty_id = empty.id
    fired = await jobs.fire_due()
    assert off.id not in fired
    assert empty_id not in fired
    async with SessionLocal() as db:
        e = await db.get(SessionJob, empty_id)
        assert e.last_status == "skipped"


async def test_webhook_投递_飞书格式_报文成形(monkeypatch):
    srv, url = _serve()
    try:
        sid = await _seed_session(title="每日简报")
        async with SessionLocal() as db:
            job = SessionJob(
                session_id=sid, agent_id="ag_job_test", prompt="简报", mode="daily",
                at="09:00", enabled=1,
                deliver={"channel": "webhook", "url": url, "format": "feishu"},
            )
            db.add(job)
            await db.commit()
            await db.refresh(job)
            run = Run(
                agent_id="ag_job_test",
                agent_version=1,
                status="ok",
                input={"text": "简报"},
                output={"text": "三条新闻：A、B、C"},
                started_at=now_ms(),
                ended_at=now_ms(),
                session_id=sid,
            )
            db.add(run)
            await db.commit()
            await db.refresh(run)
            d = JobDelivery(
                job_id=job.id, run_id=run.id, session_id=sid,
                channel="webhook", target=url, format="feishu",
            )
            db.add(d)
            await db.commit()
            did = d.id

        sent = await jobs.deliver_pending()
        assert sent >= 1  # 同一测试库里可能还有上一用例排下的 session 投递
        got = _Recorder.received[-1]
        assert got["msg_type"] == "text"
        assert "三条新闻：A、B、C" in got["content"]["text"]
        assert "每日简报" in got["content"]["text"]
        async with SessionLocal() as db:
            fresh = await db.get(JobDelivery, did)
            assert fresh.status == "sent"
    finally:
        srv.shutdown()


async def test_投递失败会重试_用尽标失败():
    _Recorder.received.clear()
    _Recorder.status = 500
    srv, url = _serve()
    try:
        sid = await _seed_session(title="失败投递")
        async with SessionLocal() as db:
            run = Run(
                agent_id="ag_job_test", agent_version=1, status="ok", input={"text": "x"},
                output={"text": "结果"}, started_at=now_ms(), session_id=sid,
            )
            db.add(run)
            await db.commit()
            await db.refresh(run)
            d = JobDelivery(
                job_id="sj_x", run_id=run.id, session_id=sid,
                channel="webhook", target=url, format="generic",
            )
            db.add(d)
            await db.commit()
            did = d.id

        for _ in range(jobs.MAX_ATTEMPTS):
            await jobs.deliver_pending()
        async with SessionLocal() as db:
            fresh = await db.get(JobDelivery, did)
            assert fresh.status == "failed"
            assert fresh.attempts >= jobs.MAX_ATTEMPTS
            assert "HTTP 500" in (fresh.error or "")
    finally:
        _Recorder.status = 200
        srv.shutdown()


async def test_投递地址只认_http():
    for bad in ("file:///etc/passwd", "ftp://x/y", "  ", "javascript:alert(1)"):
        try:
            jobs.normalise_deliver({"channel": "webhook", "url": bad})
        except ValueError:
            continue
        raise AssertionError(f"应当拒绝：{bad}")


async def test_会话自己的投递不重复发():
    """channel=session 的结果本来就在对话里，投递队列标 skipped，不该去打网络。"""
    sid = await _seed_session()
    async with SessionLocal() as db:
        run = Run(
            agent_id="ag_job_test", agent_version=1, status="ok", input={"text": "x"},
            output={"text": "结果"}, started_at=now_ms(), session_id=sid,
        )
        db.add(run)
        await db.commit()
        await db.refresh(run)
        d = JobDelivery(job_id="sj_y", run_id=run.id, session_id=sid, channel="session", format="generic")
        db.add(d)
        await db.commit()
        did = d.id
    assert await jobs.deliver_pending() >= 1
    async with SessionLocal() as db:
        fresh = await db.get(JobDelivery, did)
        assert fresh.status == "skipped"


async def test_投递正文认_content_键_也能回退到最后一条助手消息():
    """各 runtime 落库的键不一样（content / text），投递前必须两边都认；
    实在没有就从会话里取最后一条助手消息 —— 群里收到空消息比收到失败更糟。"""
    _Recorder.received.clear()
    srv, url = _serve()
    try:
        sid = await _seed_session(title="正文兜底")
        async with SessionLocal() as db:
            r1 = Run(
                agent_id="ag_job_test", agent_version=1, status="ok", input={"text": "x"},
                output={"content": "来自 content 键的回答"}, started_at=now_ms(), session_id=sid,
            )
            r2 = Run(
                agent_id="ag_job_test", agent_version=1, status="ok", input={"text": "y"},
                output={}, started_at=now_ms(), session_id=sid,
            )
            db.add_all([r1, r2])
            db.add(SessionMessage(session_id=sid, turn_index=9, role="assistant", content="来自会话消息的回答", ts=now_ms()))
            await db.commit()
            for r in (r1, r2):
                await db.refresh(r)
                db.add(JobDelivery(job_id="sj_z", run_id=r.id, session_id=sid, channel="webhook", target=url, format="generic"))
            await db.commit()

        await jobs.deliver_pending()
        texts = [r.get("text", "") for r in _Recorder.received]
        assert any("来自 content 键的回答" in t for t in texts)
        assert any("来自会话消息的回答" in t for t in texts)
    finally:
        srv.shutdown()
