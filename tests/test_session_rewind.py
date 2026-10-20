"""会话回滚 / 分支。

两件事的区别就是产品语义：
* 回滚 = 我改主意了，把这轮擦掉重写（历史真删，不是标记作废 —— 留着模型照样看得见）
* 分支 = 想试另一条路，但原来的答案还得留着（开新会话，原会话一个字不动）
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select

from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Agent, Session as ChatSession, SessionMessage, now_ms


def _run(coro):
    return asyncio.run(coro)


async def _seed(sid: str, turns: int = 3) -> None:
    await init_db()
    async with SessionLocal() as db:
        if await db.get(Agent, "ag_rewind") is None:
            db.add(
                Agent(
                    id="ag_rewind",
                    slug="rewind-test",
                    name="回滚测试",
                    runtime="agentscope",
                    version=1,
                    definition={},
                    created_at=now_ms(),
                    updated_at=now_ms(),
                )
            )
        db.add(
            ChatSession(
                id=sid,
                agent_id="ag_rewind",
                title="回滚测试会话",
                message_count=turns * 2,
                summarized_upto=turns,
                summary="很早以前的摘要",
                created_at=now_ms(),
            )
        )
        for t in range(1, turns + 1):
            db.add(SessionMessage(session_id=sid, turn_index=t, role="user", content=f"第{t}问"))
            db.add(SessionMessage(session_id=sid, turn_index=t, role="assistant", content=f"第{t}答"))
        await db.commit()


async def _messages(sid: str) -> list[SessionMessage]:
    async with SessionLocal() as db:
        return list(
            (
                await db.execute(
                    select(SessionMessage)
                    .where(SessionMessage.session_id == sid)
                    .order_by(SessionMessage.turn_index, SessionMessage.id)
                )
            ).scalars()
        )


async def test_rewind_drops_turn_and_after(client):
    sid = "ses_rewind_a"
    await _seed(sid)
    r = await client.post(f"/api/sessions/{sid}/rewind", json={"turn_index": 2})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["deleted"] == 4 and body["remaining"] == 2

    left = await _messages(sid)
    assert [m.turn_index for m in left] == [1, 1]

    async with SessionLocal() as db:
        chat = await db.get(ChatSession, sid)
    assert chat.message_count == 2
    # 摘要覆盖范围必须跟着退（否则下一轮会带着"被删掉那几轮"的幽灵上下文）
    assert chat.summarized_upto == 1


async def test_rewind_refuses_assistant_turn(client):
    """指向助手回复那一半 → 422，别把一轮删成"助手自说自话"。"""
    sid = "ses_rewind_b"
    await _seed(sid, turns=1)
    # 把这一轮的用户消息删掉，只剩助手回复，模拟历史残缺
    async def _drop_user():
        async with SessionLocal() as db:
            rows = list(
                (
                    await db.execute(
                        select(SessionMessage).where(
                            SessionMessage.session_id == sid, SessionMessage.role == "user"
                        )
                    )
                ).scalars()
            )
            for m in rows:
                await db.delete(m)
            await db.commit()

    await _drop_user()
    r = await client.post(f"/api/sessions/{sid}/rewind", json={"turn_index": 1})
    assert r.status_code == 422, r.text


async def test_branch_copies_prefix_and_keeps_original(client):
    sid = "ses_rewind_c"
    await _seed(sid, turns=3)
    r = await client.post(f"/api/sessions/{sid}/branch", json={"turn_index": 2})
    assert r.status_code == 201, r.text
    new = r.json()
    assert new["id"] != sid and new["title"].endswith("· 分支")

    copied = await _messages(new["id"])
    assert [(m.turn_index, m.role) for m in copied] == [(1, "user"), (1, "assistant")]
    # 副本不指向别人的 run（点进"执行过程"会看到另一条对话的现场）
    assert all(m.run_id is None for m in copied)
    # 原会话一个字不动
    assert len(await _messages(sid)) == 6


async def test_rewind_unknown_session_is_404(client):
    r = await client.post("/api/sessions/ses_nope/rewind", json={"turn_index": 1})
    assert r.status_code == 404
