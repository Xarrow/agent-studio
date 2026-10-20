"""变更门（monitor）与后台进程心跳的护栏。

要防的两种浪费：
1. 定时任务每次都唤起模型看一圈，结果啥也没变 —— 一天烧 24 次 token，刷 24 条"无变化"
2. 后台长任务跑 20 分钟，用户不知道它死没死，只能反复问"跑完没"

口径：
  · 监视值一样 → **整轮跳过**（不建 run、不投递），记 last_status=skipped
  · 监视值变了 → 跑，并把「上一次 / 这一次」喂给模型（否则它只会重跑一遍旧活）
  · 探针自己坏了（命令超时/网址 502）**不能**变成"永远不跑"，照常跑一次并记原因
  · 监视命令先过危险命令闸门：deny 的命令保存时就拒（定时任务没人点允许）
  · 心跳写成会话里的系统消息（关掉页面回来还在），不是一闪而过的 SSE
"""

from __future__ import annotations

import time

import pytest
from sqlalchemy import select

from agent_studio import jobs, procs
from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Agent, BgProc, Run, Session, SessionJob, SessionMessage, now_ms


async def _seed(title: str = "变更门验收") -> str:
    await init_db()
    now = now_ms()
    agent_id = "ag_monitor_test"
    async with SessionLocal() as db:
        if await db.get(Agent, agent_id) is None:
            db.add(
                Agent(
                    id=agent_id,
                    slug=agent_id,
                    name="变更门助手",
                    definition={"name": "变更门助手", "model": {"provider": "custom", "name": "x"}},
                )
            )
        sid = f"ses_mon{now % 1000000}"
        db.add(Session(id=sid, agent_id=agent_id, title=title, created_at=now, last_active_at=now))
        await db.commit()
    return sid


async def _mk_job(sid: str, **kw) -> str:
    async with SessionLocal() as db:
        chat = await db.get(Session, sid)
        job = SessionJob(
            session_id=sid,
            agent_id=chat.agent_id,
            prompt=kw.pop("prompt", "看一下有没有新东西"),
            mode="hourly",
            enabled=1,
            deliver={"channel": "session"},
            next_run_at=now_ms() - 1000,
            **kw,
        )
        db.add(job)
        await db.commit()
        await db.refresh(job)
        return job.id


# --------------------------------------------------------------------------- #
# 读监视值
# --------------------------------------------------------------------------- #


async def test_监视命令取它的输出():
    value = await jobs.read_monitor("command", "printf 'hello-monitor'")
    assert value.strip() == "hello-monitor"


async def test_监视命令超时会报错而不是卡住(monkeypatch):
    monkeypatch.setattr(jobs, "MONITOR_TIMEOUT_S", 0.3)
    with pytest.raises((TimeoutError, asyncio.TimeoutError)):
        await jobs.read_monitor("command", "sleep 5")


async def test_监视命令也要过危险命令闸门():
    with pytest.raises(PermissionError):
        await jobs.read_monitor("command", "rm -rf /")


async def test_监视网址取正文(monkeypatch):
    class _Resp:
        text = "页面内容-ABC"

        def raise_for_status(self) -> None:
            return None

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, headers=None):
            assert url.startswith("http")
            return _Resp()

    monkeypatch.setattr(jobs.httpx, "AsyncClient", lambda **kw: _Client())
    assert await jobs.read_monitor("url", "https://example.com/x") == "页面内容-ABC"


# --------------------------------------------------------------------------- #
# 变化才跑
# --------------------------------------------------------------------------- #


async def test_没变化就整轮跳过_不建run不投递(monkeypatch):
    sid = await _seed()
    job_id = await _mk_job(
        sid, monitor_kind="command", monitor="printf 'same'", monitor_last="same"
    )

    fired = await jobs.fire_due()
    assert job_id not in fired, "监视值没变不该发起"

    async with SessionLocal() as db:
        runs = (await db.execute(select(Run).where(Run.session_id == sid))).scalars().all()
        assert runs == [], "不该建 run"
        fresh = await db.get(SessionJob, job_id)
        assert fresh.last_status == "skipped"
        assert fresh.next_run_at and fresh.next_run_at > now_ms(), "跳过也要排下一次"


async def test_有变化就带着差异去跑(monkeypatch):
    sid = await _seed()
    job_id = await _mk_job(
        sid, monitor_kind="command", monitor="printf 'new-value'", monitor_last="old-value"
    )

    fired = await jobs.fire_due()
    assert job_id in fired

    async with SessionLocal() as db:
        run = (await db.execute(select(Run).where(Run.session_id == sid))).scalars().first()
        assert run is not None
        text = str(run.input)
        assert "【监视到变化】" in text, text
        assert "old-value" in text and "new-value" in text, "要说清变了什么"
        fresh = await db.get(SessionJob, job_id)
        assert fresh.monitor_last.strip() == "new-value", "基准要更新成这次的值"


async def test_第一次跑没有上一版也要跑(monkeypatch):
    sid = await _seed()
    job_id = await _mk_job(sid, monitor_kind="command", monitor="printf 'first'", monitor_last="")
    fired = await jobs.fire_due()
    assert job_id in fired


async def test_探针坏了照常跑一次并记下原因():
    sid = await _seed()
    job_id = await _mk_job(
        sid, monitor_kind="command", monitor="exit 3; echo boom", monitor_last="whatever"
    )
    fired = await jobs.fire_due()
    assert job_id in fired, "探针失败不能变成永不运行"
    async with SessionLocal() as db:
        fresh = await db.get(SessionJob, job_id)
        assert "boom" in (fresh.monitor_last or "") or "检查失败" in (fresh.monitor_last or "")


# --------------------------------------------------------------------------- #
# 接口层
# --------------------------------------------------------------------------- #


async def test_接口_危险监视命令保存时就拒(client):
    s = await client.post("/api/sessions", json={"agent_id": "ag_x", "title": "x"})
    if s.status_code >= 400:
        a = await client.post(
            "/api/agents", json={"name": "门", "definition": {"name": "门", "model": {"provider": "custom", "name": "x"}}}
        )
        sid = (await client.post("/api/sessions", json={"agent_id": a.json()["id"], "title": "x"})).json()["id"]
    else:
        sid = s.json()["id"]
    r = await client.post(
        f"/api/sessions/{sid}/jobs",
        json={"prompt": "看看", "monitor_kind": "command", "monitor": "rm -rf /"},
    )
    assert r.status_code == 422, r.text
    assert "不能用在定时任务里" in r.json()["detail"]


async def test_接口_网址必须http_且能保存(client):
    a = await client.post(
        "/api/agents", json={"name": "门2", "definition": {"name": "门2", "model": {"provider": "custom", "name": "x"}}}
    )
    sid = (await client.post("/api/sessions", json={"agent_id": a.json()["id"], "title": "x"})).json()["id"]
    bad = await client.post(
        f"/api/sessions/{sid}/jobs", json={"prompt": "看看", "monitor_kind": "url", "monitor": "file:///etc/passwd"}
    )
    assert bad.status_code == 422

    ok = await client.post(
        f"/api/sessions/{sid}/jobs",
        json={"prompt": "看看", "monitor_kind": "url", "monitor": "https://example.com/feed"},
    )
    assert ok.status_code == 201, ok.text
    assert ok.json()["monitor_kind"] == "url" and ok.json()["monitor"].startswith("https://")


async def test_接口_改了检查内容基准作废(client):
    a = await client.post(
        "/api/agents", json={"name": "门3", "definition": {"name": "门3", "model": {"provider": "custom", "name": "x"}}}
    )
    sid = (await client.post("/api/sessions", json={"agent_id": a.json()["id"], "title": "x"})).json()["id"]
    j = await client.post(
        f"/api/sessions/{sid}/jobs",
        json={"prompt": "看看", "monitor_kind": "command", "monitor": "printf a"},
    )
    jid = j.json()["id"]
    async with SessionLocal() as db:
        row = await db.get(SessionJob, jid)
        row.monitor_last = "旧的基准"
        await db.commit()
    r = await client.patch(f"/api/jobs/{jid}", json={"monitor": "printf b"})
    assert r.status_code == 200, r.text
    assert r.json()["monitor_last"] == "", "换了检查内容，旧基准必须作废"


# --------------------------------------------------------------------------- #
# 心跳
# --------------------------------------------------------------------------- #


async def test_后台进程心跳发进会话且不重复():
    sid = await _seed("心跳验收")
    async with SessionLocal() as db:
        now = now_ms()
        db.add(
            BgProc(
                id="bg_beat1",
                session_id=sid,
                label="构建前端",
                command="sleep 600",
                status="running",
                log_path="/tmp/bg_beat1.log",
                started_at=now - 120_000,
                heartbeat_s=60,
                last_beat_at=now - 120_000,
            )
        )
        await db.commit()
    open("/tmp/bg_beat1.log", "w").write("step 1 ok\nstep 2 ok\n")

    sent = await procs.beat_due()
    assert sent >= 1

    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(SessionMessage).where(
                    SessionMessage.session_id == sid, SessionMessage.role == "system"
                )
            )
        ).scalars().all()
        assert rows, "心跳要写进会话（关掉页面回来还在）"
        text = rows[-1].content
        assert "还在跑" in text and "构建前端" in text
        assert "step 2 ok" in text, "要带上最近输出"
        proc_row = await db.get(BgProc, "bg_beat1")
        assert proc_row.last_beat_at and proc_row.last_beat_at > now_ms() - 60_000
        before = proc_row.last_beat_at

    # 立刻再来一次不该重复发
    again = await procs.beat_due()
    assert again == 0
    async with SessionLocal() as db:
        proc_row = await db.get(BgProc, "bg_beat1")
        assert proc_row.last_beat_at == before


async def test_没开心跳的进程不会被汇报():
    sid = await _seed("无心跳")
    async with SessionLocal() as db:
        db.add(
            BgProc(
                id="bg_beat2",
                session_id=sid,
                label="静默任务",
                command="sleep 600",
                status="running",
                log_path="/tmp/bg_beat2.log",
                started_at=now_ms() - 600_000,
                heartbeat_s=0,
            )
        )
        await db.commit()
    await procs.beat_due()
    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(SessionMessage).where(
                    SessionMessage.session_id == sid, SessionMessage.role == "system"
                )
            )
        ).scalars().all()
        assert rows == []


import asyncio  # noqa: E402  (超时用例要用)


async def test_手动跑一次不受变更门限制():
    sid = await _seed("手动跑")
    job_id = await _mk_job(
        sid, monitor_kind="command", monitor="printf 'same'", monitor_last="same"
    )
    run_id = await jobs.fire(job_id, manual=True)
    assert run_id, "手动点名要跑，就不该被\"没变化\"挡掉"


async def test_跳过之后的状态不会被上一轮的成功覆盖():
    """现场：跳过的那一轮显示"成功"，用户以为它真跑了。"""
    sid = await _seed("状态覆盖")
    async with SessionLocal() as db:
        now = now_ms()
        db.add(
            Run(
                id="run_old_ok",
                agent_id="ag_monitor_test",
                session_id=sid,
                status="ok",
                origin="schedule",
                started_at=now - 60_000,
                input={"text": "旧的一轮"},
            )
        )
        job = SessionJob(
            session_id=sid,
            agent_id="ag_monitor_test",
            prompt="看",
            mode="hourly",
            enabled=1,
            deliver={},
            last_run_id="run_old_ok",
            last_status="skipped",
            last_run_at=now,          # 刚跳过
            next_run_at=now + 3_600_000,
            monitor_kind="command",
            monitor="printf x",
            monitor_last="x",
        )
        db.add(job)
        await db.commit()
        jid = job.id
    await jobs.sync_last_status()
    async with SessionLocal() as db:
        fresh = await db.get(SessionJob, jid)
        assert fresh.last_status == "skipped", "跳过不能被上一轮的 ok 盖回去"
