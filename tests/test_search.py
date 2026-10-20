"""跨会话检索的护栏。

口径（2026-10，对标 Hermes 的 session_search）：
  1. 能跨会话找到原话，结果带**会话标题 + 时间 + 片段**（人点的是会话，不是孤立一句）
  2. 多关键词 = AND（每个词都要出现），不是整串子串匹配
  3. 能按助手 / 单会话收窄
  4. 找不到就返回空 —— 不编、不返回不相干的东西
"""

from __future__ import annotations

import time

from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Session, SessionMessage
from agent_studio.search import search_messages, search_sessions_titles


async def _seed(agent_id: str, title: str, pairs: list[tuple[str, str]]) -> str:
    """建一个会话 + 若干消息，返回 session_id。"""
    now = int(time.time() * 1000)
    async with SessionLocal() as db:
        sid = f"ses_{title[:6]}{now % 100000}"
        db.add(
            Session(
                id=sid,
                agent_id=agent_id,
                title=title,
                created_at=now,
                last_active_at=now,
                message_count=len(pairs),
            )
        )
        for i, (role, text) in enumerate(pairs, start=1):
            db.add(
                SessionMessage(
                    session_id=sid,
                    turn_index=(i + 1) // 2,
                    role=role,
                    content=text,
                    ts=now + i,
                )
            )
        await db.commit()
    return sid


async def test_跨会话能找到原话_带标题和片段():
    await init_db()
    sid = await _seed(
        "ag_search_a",
        "SSO 排障",
        [
            ("user", "移动端登录一直跳回首页"),
            ("assistant", "最后定位到 X-Frame-Options 配成了 DENY，改成 SAMEORIGIN 就好了"),
        ],
    )
    hits = await search_messages("X-Frame-Options DENY")
    assert hits, "应该搜得到"
    top = hits[0]
    assert top["session_id"] == sid
    assert top["session_title"] == "SSO 排障"
    assert "X-Frame-Options" in top["snippet"]
    assert top["ts"] > 0


async def test_多词是并且_不是整串子串():
    await init_db()
    await _seed("ag_search_b", "两个词分开出现", [("user", "端口是 8443 协议是 https")])
    # 两个词都在同一句里但不连续 → 应该命中
    assert await search_messages("8443 https")
    # 有一个词根本不存在 → 不该命中
    assert await search_messages("8443 grpc") == []


async def test_能按助手和单会话收窄():
    await init_db()
    sid_a = await _seed("ag_search_c", "助手甲的会话", [("user", "关键词 zebra 甲")])
    await _seed("ag_search_d", "助手乙的会话", [("user", "关键词 zebra 乙")])

    mine = await search_messages("zebra", agent_id="ag_search_c")
    assert mine and all(h["agent_id"] == "ag_search_c" for h in mine)

    only = await search_messages("zebra", session_id=sid_a)
    assert len(only) == 1 and only[0]["session_id"] == sid_a


async def test_条数上限与空结果():
    await init_db()
    for i in range(8):
        await _seed("ag_search_e", f"批量 {i}", [("user", f"重复词 quokka 第 {i} 次")])
    assert len(await search_messages("quokka", limit=3)) == 3
    assert await search_messages("zzz不存在的词") == []


async def test_标题搜索():
    await init_db()
    await _seed("ag_search_f", "画布拖拽修复记录", [("user", "随便说一句")])
    titles = await search_sessions_titles("拖拽")
    assert any(t["title"] == "画布拖拽修复记录" for t in titles)
