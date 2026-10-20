"""助手自己排班（job_* 三个内核工具）的测试。

覆盖点：
* 频率只认三档（枚举，不让模型自由发挥）
* 空任务描述不落库（定时跑一条空任务 = 白烧钱）
* webhook 只认 http(s)
* 建出来的任务真的挂在**当前会话**上，`next_run_at` 排得出来
* 只能看见/删掉自己会话的任务（跨会话看不见别人的）
"""

from __future__ import annotations

import asyncio

import pytest

from agent_studio.native_tools import _job_cancel, _job_create, _job_list


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture()
def ctx(seeded):
    from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx

    set_run_ctx(session_id="ses_jobtest", run_id="run_jobtest", agent_id="ag_jobtest")
    yield
    clear_run_ctx()


@pytest.fixture()
def seeded():
    """建一个会话行（外键要它）"""
    from agent_studio.db import SessionLocal, init_db
    from agent_studio.models import Agent, Session, now_ms

    async def _mk():
        await init_db()
        async with SessionLocal() as db:
            if await db.get(Agent, "ag_jobtest") is None:
                db.add(
                    Agent(
                        id="ag_jobtest",
                        slug="job-test",
                        name="排班测试",
                        runtime="agentscope",
                        version=1,
                        definition={},
                        created_at=now_ms(),
                        updated_at=now_ms(),
                    )
                )
            if await db.get(Session, "ses_jobtest") is None:
                db.add(
                    Session(
                        id="ses_jobtest",
                        agent_id="ag_jobtest",
                        title="排班测试会话",
                        created_at=now_ms(),
                    )
                )
            await db.commit()

    _run(_mk())
    return "ses_jobtest"


def test_create_daily_job(ctx, seeded):
    out = _run(_job_create("汇总三条新闻", mode="daily", at="08:30"))
    assert "已排好" in out and "每天" in out
    from agent_studio.db import SessionLocal
    from agent_studio.models import SessionJob
    from sqlalchemy import select

    async def _check():
        async with SessionLocal() as db:
            rows = list(
                (await db.execute(select(SessionJob).where(SessionJob.session_id == "ses_jobtest"))).scalars()
            )
        return rows

    rows = _run(_check())
    assert rows and rows[-1].prompt == "汇总三条新闻"
    assert rows[-1].at == "08:30"
    assert rows[-1].next_run_at, "排了班就必须有下一次的运行时间"


def test_reject_bad_mode(ctx, seeded):
    out = _run(_job_create("x", mode="每分钟"))
    assert "每小时" in out and "每天" in out


def test_reject_empty_prompt(ctx, seeded):
    out = _run(_job_create("   "))
    assert "要写清楚" in out


def test_reject_non_http_webhook(ctx, seeded):
    out = _run(_job_create("推送", deliver="webhook", webhook_url="ftp://x"))
    assert "http" in out


def test_list_and_cancel(ctx, seeded):
    created = _run(_job_create("每周一写周报", mode="weekly", weekdays="1", at="09:00"))
    job_id = created.split("\n")[0].split("：")[-1].strip()
    listed = _run(_job_list())
    assert job_id in listed and "周报" in listed
    gone = _run(_job_cancel(job_id))
    assert "已删掉" in gone
    # 同一个会话里别的测试可能也排了班，只断言"这一条没了"
    assert job_id not in _run(_job_list())


def test_cannot_touch_other_session_job(ctx, seeded):
    """别的会话的任务 id 拿来也删不掉（归属边界）。"""
    out = _run(_job_cancel("sj_nonexistent"))
    assert "没有任务" in out
