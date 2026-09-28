"""会话压缩护栏 —— node/pytest 双端里的后端那份。

守两件事（都是真出过问题的）：
① **压缩必须用自己的摘要 system prompt**：复用记忆提炼那套（输出 JSON 候选）
   会得到一堆 JSON 或空串 —— 空串被上层当成"没什么可压缩"直接丢掉，
   症状是"设了阈值却永远看不到摘要"。
② 压缩**在任务收尾做**、超过阈值才做、空摘要不落库。
"""

import pytest
from sqlalchemy import select

from agent_studio.context import SUMMARY_SYSTEM_PROMPT, compress_if_needed
from agent_studio.db import SessionLocal
from agent_studio.models import Agent, Session as ChatSession, SessionMessage, new_id, now_ms


async def _seed_session(turns: int, agent_id: str) -> str:
    """造一个 N 轮的会话（每轮一问一答），返回 session_id。"""
    async with SessionLocal() as s:
        sess = ChatSession(
            id=new_id("ses"),
            agent_id=agent_id,
            title="压缩测试",
            workspace_id="default",
            created_at=now_ms(),
            last_active_at=now_ms(),
        )
        s.add(sess)
        await s.flush()
        for t in range(1, turns + 1):
            s.add(SessionMessage(session_id=sess.id, turn_index=t, role="user",
                                 content=f"第{t}问", run_id="r", ts=now_ms()))
            s.add(SessionMessage(session_id=sess.id, turn_index=t, role="assistant",
                                 content=f"第{t}答", run_id="r", ts=now_ms()))
        await s.commit()
        return sess.id


async def _seed_agent() -> str:
    """建一个最小 agent（会话必须挂在某个 agent 上）。名字避开默认助手，防测试间撞名。"""
    async with SessionLocal() as s:
        ag = Agent(
            id=new_id("ag"),
            workspace_id="default",
            slug=f"压缩护栏-{new_id('x')[-6:]}",
            name=f"压缩护栏助手-{new_id('x')[-6:]}",
            runtime="agentscope",
            definition={
                "name": "压缩护栏助手",
                "model": {"provider": "deepseek", "name": "deepseek-chat"},
                "tools": [],
            },
            created_at=now_ms(),
            updated_at=now_ms(),
        )
        s.add(ag)
        await s.commit()
        return ag.id


@pytest.mark.asyncio
async def test_compress_uses_summary_prompt_not_extract_prompt(client, monkeypatch):
    """压缩调用 LLM 时必须带摘要 prompt（不是默认的提炼 prompt）。"""
    seen: dict = {}

    async def fake_call_llm(**kw):
        seen.update(kw)
        return "用户问了几次编号问题，助手逐条作答。"

    monkeypatch.setattr("agent_studio.context.call_llm", fake_call_llm)

    aid = await _seed_agent()
    sid = await _seed_session(4, aid)
    async with SessionLocal() as s:
        out = await compress_if_needed(
            s, session_id=sid, threshold_turns=2,
            base_url="https://example.invalid/v1", api_key="k", model="m",
        )
        assert out == "用户问了几次编号问题，助手逐条作答。"
        sess = await s.get(ChatSession, sid)
        assert sess.summary == out
        assert sess.summarized_upto > 0

    assert seen.get("system_prompt") == SUMMARY_SYSTEM_PROMPT, "压缩用了提炼的 prompt"
    # 真正的红线：绝不能是记忆提炼那套（它要求输出 JSON 候选）
    from agent_studio.memory.extract import SYSTEM_PROMPT as EXTRACT_PROMPT

    assert seen["system_prompt"] != EXTRACT_PROMPT

    # 清理（测试用临时库，保险起见）
    async with SessionLocal() as s:
        await s.execute(SessionMessage.__table__.delete().where(SessionMessage.session_id == sid))
        await s.execute(ChatSession.__table__.delete().where(ChatSession.id == sid))
        await s.commit()


@pytest.mark.asyncio
async def test_compress_skips_below_threshold_and_on_empty(client, monkeypatch):
    """没超阈值不调用 LLM；LLM 返回空白不落库（避免把空摘要注入上下文）。"""
    calls = {"n": 0}

    async def fake_call_llm(**kw):
        calls["n"] += 1
        return "   "

    monkeypatch.setattr("agent_studio.context.call_llm", fake_call_llm)

    aid = await _seed_agent()
    sid = await _seed_session(2, aid)
    async with SessionLocal() as s:
        assert await compress_if_needed(
            s, session_id=sid, threshold_turns=5,
            base_url="https://example.invalid/v1", api_key="k", model="m",
        ) is None
        assert calls["n"] == 0, "没超阈值就不该花一次 LLM 调用"

        assert await compress_if_needed(
            s, session_id=sid, threshold_turns=1,
            base_url="https://example.invalid/v1", api_key="k", model="m",
        ) is None
        assert calls["n"] == 1
        sess = await s.get(ChatSession, sid)
        assert not (sess.summary or "").strip(), "空白摘要不该写进会话"

    async with SessionLocal() as s:
        await s.execute(SessionMessage.__table__.delete().where(SessionMessage.session_id == sid))
        await s.execute(ChatSession.__table__.delete().where(ChatSession.id == sid))
        await s.commit()
