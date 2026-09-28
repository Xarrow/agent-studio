"""「各个功能配置导入导出」的护栏。

守住五条（都是"做错了代价很大"的地方）：
① **密钥绝不进包**：自定义 http 工具请求头里的 Bearer/token 会被清空，包里的
   LLM 配置只有清单（名字/端点/默认模型）；
② **分区导出**：只要助手就别把流程/记忆一起塞进来（dropped 里如实列出没导的）；
③ **导入只增不改**：同名工具/技能不重复建、已有记忆策略的助手保持用户原来的调参；
④ **关联要接上**：包里既有助手又有自定义工具时，助手 → 工具的关联必须补上
   （顺序问题：导出时助手在前，导入时先建助手，那时工具还不存在）；
⑤ **如实回报**：新建了什么、跳过了什么、哪些 LLM 配置要重填，都要在结果里。
"""

from __future__ import annotations

import json

import pytest
from sqlalchemy import select

from agent_studio.db import SessionLocal
from agent_studio.models import Agent, AgentTool, MemoryPolicy, Secret, Skill, Tool, now_ms

pytestmark = pytest.mark.asyncio


async def _seed() -> dict[str, str]:
    """造一份最小样本：一个助手 + 一个带密钥头的自定义工具 + 一个技能 + 记忆策略。

    **幂等**：多个用例共用同一个测试库（同一个 fixture），重复造会撞 slug 唯一键。
    """
    async with SessionLocal() as s:
        if (await s.execute(select(Agent).where(Agent.id == "ag_sec_seed"))).scalars().first():
            return {"agent": "ag_sec_seed"}
        ag = Agent(
            id="ag_sec_seed", workspace_id="default", slug="sec-seed", name="分区样本助手",
            runtime="agentscope",
            definition={"name": "分区样本助手", "model": {"provider": "deepseek", "name": "deepseek-chat"}, "tools": []},
            created_at=now_ms(), updated_at=now_ms(),
        )
        tl = Tool(
            id="tl_sec_seed", kind="http", name="分区样本工具", description="带密钥头的工具",
            input_schema={"type": "object", "properties": {}},
            impl={"url": "https://example.com/x", "method": "POST",
                  "headers": {"Authorization": "Bearer SECRET-VALUE", "X-Trace": "1"}},
        )
        sk = Skill(
            id="sk_sec_seed", name="分区样本技能", description="d", source={"type": "manual"},
            content="# 技能正文", files={},
        )
        sec = Secret(
            id="sec_seed", name="分区样本配置", provider="deepseek",
            ciphertext=b"ENCRYPTED-SECRET-BYTES",
            base_url="https://api.deepseek.com", default_model="deepseek-chat",
        )
        s.add_all([ag, tl, sk, sec])
        await s.commit()
        s.add(AgentTool(agent_id=ag.id, tool_id=tl.id))
        s.add(MemoryPolicy(agent_id=ag.id, auto_extract=1, recall_enabled=1, recall_top_k=7,
                           recall_strategy="keyword", compress_after_turns=20))
        await s.commit()
    return {"agent": "ag_sec_seed"}


async def test_导出的工具不带密钥_凭据只有清单(client):
    await _seed()
    got = await client.get("/api/export", params={"sections": "tools,credentials"})
    assert got.status_code == 200
    bundle = got.json()
    tool = next(t for t in bundle["tools"] if t["name"] == "分区样本工具")
    assert tool["impl"]["headers"]["Authorization"] == "", "请求头里的密钥必须被清空"
    assert tool["impl"]["headers"]["X-Trace"] == "1", "普通头不该被误清"
    assert tool["secrets_scrubbed"] is True
    cred = next(c for c in bundle["credentials"] if c["name"] == "分区样本配置")
    assert set(cred) == {"name", "provider", "base_url", "default_model"}, "凭据只能出清单字段"
    assert "ENCRYPTED-SECRET-BYTES" not in json.dumps(bundle, ensure_ascii=False), "密文绝不进包"
    assert "credential_note" in bundle
    # 没点名要的分区不该被带出来
    assert "agents" not in bundle or bundle.get("dropped")
    assert "workflows" in bundle.get("dropped", [])


async def test_分区导出只带点名的东西(client):
    await _seed()
    got = await client.get("/api/export", params={"sections": "agents"})
    bundle = got.json()
    assert bundle["sections"] == ["agents"]
    assert "workflows" not in bundle and "memories" not in bundle and "prices" not in bundle
    assert set(bundle["dropped"]) >= {"workflows", "memories", "tools", "skills"}


async def test_分区清单给出数量与是否可导入(client):
    await _seed()
    got = await client.get("/api/export/sections")
    assert got.status_code == 200
    secs = {s["key"]: s for s in got.json()["sections"]}
    assert secs["agents"]["count"] >= 1
    assert secs["tools"]["count"] >= 1
    assert secs["credentials"]["importable"] is False, "凭据永远不可导入（密钥不进包）"
    assert secs["agents"]["importable"] is True


async def test_导入自定义工具与技能_并接回新助手(client):
    """顺序问题：导出时助手在工具之前，导入时先建助手 → 关联必须补上。"""
    bundle = {
        "kind": "agent-studio-export",
        "version": 1,
        "agents": [
            {
                "id": "ag_from_bundle",
                "name": "带工具的导入助手",
                "slug": "imported-with-tool",
                "runtime": "agentscope",
                "definition": {"name": "带工具的导入助手",
                               "model": {"provider": "deepseek", "name": "deepseek-chat"}, "tools": []},
                "tools": ["导入来的工具"],
                "skills": ["导入来的技能"],
            }
        ],
        "tools": [
            {"name": "导入来的工具", "kind": "http", "description": "d",
             "input_schema": {"type": "object"}, "impl": {"url": "https://example.com/y"}}
        ],
        "skills": [
            {"name": "导入来的技能", "description": "d", "source": {"type": "manual"},
             "content": "# 内容", "files": {}}
        ],
        "policies": [{"agent": "带工具的导入助手", "recall_top_k": 9, "recall_strategy": "recent"}],
        "credentials": [{"name": "本机的 deepseek", "provider": "deepseek",
                         "base_url": "https://api.deepseek.com", "default_model": "deepseek-chat"}],
    }
    got = await client.post("/api/import", json={"bundle": bundle})
    assert got.status_code == 200, got.text
    res = got.json()
    assert res["ok"] is True
    assert "导入来的工具" in res["tools"] and "导入来的技能" in res["skills"]
    assert res["policies"] == ["带工具的导入助手"]
    assert res["credentials_to_fill"] == ["本机的 deepseek"], "要告诉用户哪条 LLM 配置得重填密钥"
    assert not res["missing_tools"] and not res["missing_skills"]

    async with SessionLocal() as s:
        ag = (await s.execute(select(Agent).where(Agent.name == "带工具的导入助手"))).scalars().first()
        assert ag is not None
        tid = (await s.execute(select(Tool).where(Tool.name == "导入来的工具"))).scalar_one().id
        linked = (
            await s.execute(select(AgentTool).where(AgentTool.agent_id == ag.id, AgentTool.tool_id == tid))
        ).scalars().first()
        assert linked is not None, "助手 → 新工具的关联必须补上（否则助手看着有工具、实际没挂）"
        pol = await s.get(MemoryPolicy, ag.id)
        assert pol is not None and pol.recall_top_k == 9


async def test_再导一次不重复建_也不覆盖已有策略(client):
    """导入永远"只增不改"：同名工具/技能跳过；已有记忆策略的助手保留用户自己的调参。"""
    await _seed()
    async with SessionLocal() as s:
        ag = (await s.execute(select(Agent).where(Agent.name == "分区样本助手"))).scalars().first()
        before = await s.get(MemoryPolicy, ag.id)
        assert before is not None and before.recall_top_k == 7

    bundle = {
        "kind": "agent-studio-export",
        "version": 1,
        "tools": [{"name": "分区样本工具", "kind": "http", "impl": {"url": "https://other"}}],
        "skills": [{"name": "分区样本技能", "content": "# 别的正文"}],
        "policies": [{"agent": "分区样本助手", "recall_top_k": 3}],
        "agents": [{"name": "分区样本助手", "slug": "sec-seed-copy", "runtime": "agentscope",
                    "definition": {"name": "分区样本助手",
                                   "model": {"provider": "deepseek", "name": "deepseek-chat"}}}],
    }
    got = await client.post("/api/import", json={"bundle": bundle})
    res = got.json()
    assert res["tools"] == [] and res["skills"] == [], "同名不该重复建"
    assert any("已存在" in x for x in res["skipped"])

    async with SessionLocal() as s:
        # 工具还是原来那一个（没被"别的 url"改掉）
        tools = (await s.execute(select(Tool).where(Tool.name == "分区样本工具"))).scalars().all()
        assert len(tools) == 1
        assert tools[0].impl.get("url") == "https://example.com/x", "导入绝不改已有工具"
        ag = (await s.execute(select(Agent).where(Agent.slug == "sec-seed"))).scalars().first()
        pol = await s.get(MemoryPolicy, ag.id)
        assert pol.recall_top_k == 7, "已有策略的助手要保留用户自己的调参"
