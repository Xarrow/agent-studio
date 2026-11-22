"""删除会话 = 连执行记录一起删（用户口径：一处删干净）。"""

from __future__ import annotations

import uuid

from sqlalchemy import select

from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Agent, Run
from agent_studio.models import Session as ChatSession


def _mk_session() -> tuple[str, str]:
    return "ses_" + uuid.uuid4().hex[:16], "ag_" + uuid.uuid4().hex[:16]


async def _seed():
    await init_db()
    sid, aid = _mk_session()
    async with SessionLocal() as s:
        s.add(Agent(id=aid, slug=aid, name="级联测试助手", runtime="agentscope",
                    version=1, definition={"name": "级联测试助手"}))
        s.add(ChatSession(id=sid, workspace_id="ws_default", agent_id=aid, title="级联测试会话"))
        for i in range(2):
            s.add(Run(id=f"run_{uuid.uuid4().hex[:16]}", agent_id=aid, session_id=sid,
                      status="ok", origin="chat", input={"text": f"第{i}轮"},
                      output={"content": "ok"}))
        await s.commit()
    return sid, aid


async def _runs_of(sid: str) -> list[Run]:
    async with SessionLocal() as s:
        return list((await s.execute(select(Run).where(Run.session_id == sid))).scalars())


def test_删除会话连执行记录一起清(monkeypatch):
    import asyncio

    from agent_studio.api import sessions as mod

    async def go():
        sid, _aid = await _seed()
        assert len(await _runs_of(sid)) == 2
        # 直接调实现函数（跳过 FastAPI 依赖）
        async with SessionLocal() as s:
            out = await mod.delete_session(sid, s)
        assert out["deleted_runs"] == 2, out
        assert await _runs_of(sid) == [], "会话删了，执行记录还在"
        # 用 SQL 数，别信 identity map 缓存
        from sqlalchemy import text as _text

        async with SessionLocal() as s:
            left = (
                await s.execute(_text("select count(*) from session where id=:i"), {"i": sid})
            ).scalar_one()
        assert left == 0, "会话行还在"
        async with SessionLocal() as s:
            leftm = (
                await s.execute(
                    _text("select count(*) from session_message where session_id=:i"), {"i": sid}
                )
            ).scalar_one()
        assert leftm == 0, "会话删了，消息还在"

    asyncio.run(go())
