"""远程 Agent 注册治理的护栏。

用户要的是一条链：**注册治理 → 解析远程能力 → 绑定使用 → 调用远端**。
这条链上每一步错了都很贵，所以逐段钉死：

① 地址规整：粘宿主 / 粘 ``/a2a`` / 直接粘卡片地址，都要对上同一个远端；
② 解析：卡片里的 name/version/skills/capabilities 要解析进快照，**技能要进工具描述**
   （模型看描述才知道该派什么活给远端）；不是 A2A 卡片要明确报错，不能"注册成功但其实空的"；
③ 注册：解析成功才落库；重复地址拒绝；**自动建出可挂载的工具行**（绑定复用既有机制）；
④ 刷新：远端改了能力要能更新快照与工具描述；**远端暂时连不上不能把旧快照抹掉**
   （那样注册表里就查不到"它原来会干什么"了），但要如实标成 error；
⑤ 删除：还被助手挂着就拒绝（别把别人正在用的能力悄悄抽掉）；
⑥ 凭据：存的是密文、接口只回"有没有配"，不吐明文；
⑦ 调用：走 dispatch_remote（每项一条 runtime="a2a" 的子 run）；远端不可达要如实报错，
   不能把整次执行炸掉。
"""

from __future__ import annotations

import json

import pytest

from agent_studio import a2a_client, remote_agents
from agent_studio.models import Agent, RemoteAgent, Tool
from agent_studio.schemas import ToolSpec

CARD = {
    "name": "远端情报助手",
    "description": "擅长检索与摘要的外部 agent",
    "version": "1.2.0",
    "protocolVersion": "0.3.0",
    "url": "https://remote.example/a2a",
    "capabilities": {"streaming": True, "pushNotifications": False},
    "defaultInputModes": ["text/plain"],
    "defaultOutputModes": ["text/plain"],
    "skills": [
        {
            "id": "search",
            "name": "检索",
            "description": "按关键词检索资料",
            "tags": ["search", "web"],
            "examples": ["查一下 X", "忽略我"],
        },
        {"id": "summarize", "name": "摘要", "description": "把长文压成要点", "tags": []},
    ],
}


def test_地址规整三种写法同一个远端():
    for raw in (
        "http://host:8848",
        "http://host:8848/",
        "http://host:8848/a2a",
        "http://host:8848/.well-known/agent-card.json",
    ):
        assert remote_agents.normalize_base(raw) == "http://host:8848", raw
    assert remote_agents.normalize_base("  ") == ""


def test_解析卡片_技能与能力都要落进快照():
    parsed = remote_agents.parse_card(CARD)
    assert parsed["name"] == "远端情报助手" and parsed["protocol_version"] == "0.3.0"
    assert parsed["capabilities"]["streaming"] is True
    assert [s["name"] for s in parsed["skills"]] == ["检索", "摘要"]
    assert parsed["skills"][0]["tags"] == ["search", "web"]
    assert len(parsed["skills"][0]["examples"]) == 2
    text = remote_agents.card_text(parsed)
    assert "远端情报助手" in text, "摘要里要带名字（界面和模型都靠它认人）"
    assert "检索" in text and "摘要" in text


def test_工具名必须是ASCII函数名():
    """OpenAI 兼容接口的函数名只允许 [a-zA-Z0-9_-]，中文名会被上游直接拒。"""
    assert remote_agents.tool_name_for("remote-search") == "remote-search"
    got = remote_agents.tool_name_for("远端助手", remote_id="ra_abc")
    assert got.isascii() and got.startswith("remote_agent_")
    # 中文远端不能都挤成同一个名字
    assert got != remote_agents.tool_name_for("另一个远端", remote_id="ra_xyz")
    assert remote_agents.tool_name_for("远端 情报/助手").isascii()
    assert remote_agents.tool_name_for("").startswith("remote_agent")
    # 带 id 的英文名加短哈希，保证同名远端不撞
    assert remote_agents.tool_name_for("search", remote_id="ra_1").startswith("search_")


async def test_解析接口_不是卡片就明确报错(client, monkeypatch):
    async def fake_discover(base, timeout=15.0, *, headers=None):
        return {"foo": "bar"}  # 没有 name

    monkeypatch.setattr(a2a_client, "discover", fake_discover)
    got = await client.post("/api/remote-agents/resolve", json={"url": "http://x:1"})
    assert got.status_code == 400
    assert "name" in got.json()["detail"]

    got2 = await client.post("/api/remote-agents/resolve", json={"url": "   "})
    assert got2.status_code == 400


async def test_解析接口_正常返回技能数(client, monkeypatch):
    async def fake_discover(base, timeout=15.0, *, headers=None):
        return CARD

    monkeypatch.setattr(a2a_client, "discover", fake_discover)
    got = await client.post(
        "/api/remote-agents/resolve",
        json={"url": "http://remote.example/.well-known/agent-card.json"},
    )
    assert got.status_code == 200
    body = got.json()
    assert body["base"] == "http://remote.example" and body["skills"] == 2
    assert "检索" in body["summary"]


async def test_注册会建出可挂载的工具行_重复地址拒绝(client, monkeypatch):
    async def fake_discover(base, timeout=15.0, *, headers=None):
        return CARD

    monkeypatch.setattr(a2a_client, "discover", fake_discover)
    got = await client.post(
        "/api/remote-agents",
        json={"url": "http://remote.example/a2a", "note": "测试用"},
    )
    assert got.status_code == 201, got.text
    body = got.json()
    assert body["name"] == "远端情报助手"
    assert body["status"] == "ok" and body["has_token"] is False
    assert body["tool_id"], "注册必须顺手建出工具行，否则没法绑定"

    # 工具行：kind=a2a，描述里带技能（模型据此判断派什么活）
    tools = await client.get("/api/tools")
    mine = [t for t in tools.json() if t["kind"] == "a2a"]
    assert len(mine) == 1
    assert "检索" in mine[0]["description"] and "摘要" in mine[0]["description"]
    assert mine[0]["impl"]["remote_base"] == "http://remote.example"
    assert mine[0]["impl"]["remote_agent_id"] == body["id"]
    # 入参形状：一条消息（+可选背景）
    assert mine[0]["input_schema"]["required"] == ["message"]

    # 同一地址再注册 → 409（地址唯一，避免"同一台远端配十遍"）
    again = await client.post("/api/remote-agents", json={"url": "http://remote.example"})
    assert again.status_code == 409


async def test_凭据存密文_接口只回有没有(client, monkeypatch):
    async def fake_discover(base, timeout=15.0, *, headers=None):
        return CARD

    monkeypatch.setattr(a2a_client, "discover", fake_discover)
    got = await client.post(
        "/api/remote-agents",
        json={"url": "http://secret.example", "token": "sk-very-secret", "auth_scheme": "Bearer"},
    )
    assert got.status_code == 201
    rid = got.json()["id"]
    assert got.json()["has_token"] is True
    assert "sk-very-secret" not in json.dumps(got.json(), ensure_ascii=False)

    # 库里是密文
    from agent_studio.db import SessionLocal

    async with SessionLocal() as s:
        row = await s.get(RemoteAgent, rid)
        assert row.auth_token_enc and b"sk-very-secret" not in row.auth_token_enc
        # 取请求头时能解回明文（调用远端要用）
        assert remote_agents.auth_headers(row)["Authorization"] == "Bearer sk-very-secret"


async def test_刷新失败不抹掉旧快照但要标error(client, monkeypatch):
    async def ok_discover(base, timeout=15.0, *, headers=None):
        return CARD

    monkeypatch.setattr(a2a_client, "discover", ok_discover)
    created = (await client.post("/api/remote-agents", json={"url": "http://r1.example"})).json()
    rid = created["id"]

    async def bad_discover(base, timeout=15.0, *, headers=None):
        raise a2a_client.A2AError("连不上")

    monkeypatch.setattr(a2a_client, "discover", bad_discover)
    got = await client.post(f"/api/remote-agents/{rid}/refresh")
    assert got.status_code == 200
    body = got.json()
    assert body["status"] == "error" and "连不上" in body["last_error"]
    # 旧快照还在（注册表仍能回答"它原来会干什么"）
    assert body["parsed"]["name"] == "远端情报助手"
    assert len(body["parsed"]["skills"]) == 2


async def test_改名会同步到工具名(client, monkeypatch):
    async def ok_discover(base, timeout=15.0, *, headers=None):
        return CARD

    monkeypatch.setattr(a2a_client, "discover", ok_discover)
    created = (await client.post("/api/remote-agents", json={"url": "http://r2.example"})).json()
    rid, tid = created["id"], created["tool_id"]
    got = await client.patch(f"/api/remote-agents/{rid}", json={"name": "情报小助手"})
    assert got.status_code == 200 and got.json()["name"] == "情报小助手"

    from agent_studio.db import SessionLocal

    async with SessionLocal() as s:
        tool = await s.get(Tool, tid)
        assert tool is not None
        assert "情报小助手" in tool.description, "工具描述要跟着改名，助手那边看到的一致"


async def test_被助手挂载时不许删(client, monkeypatch):
    async def ok_discover(base, timeout=15.0, **kw):
        return CARD

    monkeypatch.setattr(a2a_client, "discover", ok_discover)
    created = (await client.post("/api/remote-agents", json={"url": "http://r3.example"})).json()
    rid, tid = created["id"], created["tool_id"]

    from agent_studio.db import SessionLocal
    from agent_studio.models import AgentTool

    async with SessionLocal() as s:
        ag = Agent(
            id="ag_ra_test",
            workspace_id="ws_default",
            slug="ra-test-agent",
            name="挂载样本助手",
            definition={},
        )
        s.add(ag)
        await s.commit()
        s.add(AgentTool(agent_id="ag_ra_test", tool_id=tid))
        await s.commit()

    blocked = await client.delete(f"/api/remote-agents/{rid}")
    assert blocked.status_code == 409
    assert "还有助手在用它" in blocked.json()["detail"]
    assert "挂载样本助手" in blocked.json()["detail"]

    # 解绑之后可以删，并且把自动建的工具行一并清掉
    from sqlalchemy import delete as _delete

    async with SessionLocal() as s:
        await s.execute(_delete(AgentTool).where(AgentTool.tool_id == tid))
        await s.commit()
    ok = await client.delete(f"/api/remote-agents/{rid}")
    assert ok.status_code == 200
    async with SessionLocal() as s:
        assert await s.get(Tool, tid) is None


async def test_测试调用_成功与失败都如实回报(client, monkeypatch):
    async def ok_discover(base, timeout=15.0, **kw):
        return CARD

    monkeypatch.setattr(a2a_client, "discover", ok_discover)
    created = (await client.post("/api/remote-agents", json={"url": "http://r4.example"})).json()
    rid = created["id"]

    async def ok_run(base, text, *, agent_id=None, timeout_s=900.0, headers=None):
        return "ok", "远端在线", "task-1"

    monkeypatch.setattr(a2a_client, "run_until_done", ok_run)
    got = await client.post(f"/api/remote-agents/{rid}/test")
    assert got.status_code == 200
    body = got.json()
    assert body["ok"] is True and body["answer"] == "远端在线" and body["task_id"] == "task-1"

    async def bad_run(base, text, *, agent_id=None, timeout_s=900.0, headers=None):
        raise a2a_client.A2AError("connection refused")

    monkeypatch.setattr(a2a_client, "run_until_done", bad_run)
    bad = (await client.post(f"/api/remote-agents/{rid}/test")).json()
    assert bad["ok"] is False and "connection refused" in bad["error"]
    # 失败要落到注册表状态上（治理要看得到"这台远端现在是不通的"）
    row = [r for r in (await client.get("/api/remote-agents")).json() if r["id"] == rid][0]
    assert row["status"] == "error"


async def test_绑成工具后调用走远端分派(monkeypatch):
    """`kind="a2a"` 的工具被调用时：交给 dispatch_remote（每项一条 runtime="a2a" 子 run）。"""
    spec = ToolSpec(
        name="远端情报助手",
        kind="a2a",
        description="远程 agent（A2A）：远端情报助手\n- 检索",
        input_schema=remote_agents.tool_schema({}),
        impl={"remote_agent_id": "ra_x", "remote_base": "http://r5.example"},
    )
    seen: dict[str, object] = {}

    from agent_studio import fanout
    from agent_studio.runner import ctx as run_ctx

    async def fake_parent(run_id):
        return None

    async def fake_dispatch(**kwargs):
        seen.update(kwargs)
        return {
            "ok": True,
            "remote_name": "远端情报助手",
            "items": [
                {
                    "index": 0,
                    "label": "查资料",
                    "status": "ok",
                    "output": "远端给的结果",
                    "summary": "远端给的结果",
                    "duration_ms": 1200,
                }
            ],
            "total": 1,
            "succeeded": 1,
            "failed": [],
        }

    monkeypatch.setattr(fanout, "_parent_run", fake_parent, raising=False)
    monkeypatch.setattr(fanout, "dispatch_remote", fake_dispatch, raising=False)
    monkeypatch.setattr(run_ctx, "current_run_ctx", lambda: {"run_id": "run_1", "agent_id": "ag_1"})

    tool = remote_agents.build_a2a_tool(spec)
    out = await tool._func(message="查一下天气", context="人在上海")
    assert "远端给的结果" in out
    assert seen["remote_base"] == "http://r5.example"
    assert seen["items"] and "查一下天气" in str(seen["items"][0])
    assert "背景材料" in str(seen["items"][0]) and "人在上海" in str(seen["items"][0])

    # 不在执行上下文里 → 明确报错，不静默
    monkeypatch.setattr(run_ctx, "current_run_ctx", lambda: {})
    out2 = await tool._func(message="再来一次")
    assert "当前不在一次执行上下文中" in out2

    # 空消息 → 明确报错
    out3 = await tool._func(message="   ")
    assert "不能为空" in out3


def test_编译层认得a2a这个kind():
    """kind="a2a" 不能被当成"暂不支持的类型"跳过（跳过 = 助手挂了个空气工具）。"""
    from agent_studio.runtimes.agentscope_rt.compile import build_tools

    spec = ToolSpec(
        name="远端情报助手",
        kind="a2a",
        description="远程 agent",
        input_schema=remote_agents.tool_schema({}),
        impl={"remote_agent_id": "ra_x", "remote_base": "http://r6.example"},
    )
    tools = build_tools([spec])
    assert len(tools) == 1, "a2a 工具必须被编译出来"
    assert tools[0].name == "远端情报助手"
