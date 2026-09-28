"""A2A 客户端与「远端分派」护栏测试。

守三件事：
① 地址规整：用户填宿主、填 /a2a、直接粘卡片地址 —— 三种都要能对上同一个端点
   （粘卡片地址是很常见的动作，不该因此报错）；
② 状态映射：A2A 的状态词要如实翻成本平台的状态（input-required → waiting_hitl，
   远端在等人确认时**不能**算成功，也不能傻等）；
③ dispatch_remote：每一路都要落一条 run（runtime="a2a"），状态/产出如实写回 ——
   否则"跨平台派活"在记录页就看不见了。
"""

import pytest

from agent_studio import a2a_client
from agent_studio.models import Run, now_ms
from agent_studio.fanout import dispatch_remote


def test_端点规整三种写法都对得上():
    for raw in (
        "http://host:8848",
        "http://host:8848/",
        "http://host:8848/a2a",
        "http://host:8848/.well-known/agent-card.json",
    ):
        assert a2a_client._rpc_url(raw) == "http://host:8848/a2a", raw


def test_状态映射如实():
    assert a2a_client.state_of({"status": {"state": "completed"}}) == "completed"
    assert a2a_client.status_of({"status": {"state": "completed"}}) == "ok"
    assert a2a_client.status_of({"status": {"state": "failed"}}) == "error"
    assert a2a_client.status_of({"status": {"state": "canceled"}}) == "aborted"
    # 远端在等人确认 ≠ 成功：必须报 waiting_hitl，让用户去远端确认
    assert a2a_client.status_of({"status": {"state": "input-required"}}) == "waiting_hitl"
    assert a2a_client.status_of({"status": {"state": "working"}}) == "running"


def test_取文本优先artifacts():
    task = {
        "status": {"state": "completed", "message": {"parts": [{"kind": "text", "text": "状态里的话"}]}},
        "artifacts": [{"parts": [{"kind": "text", "text": "正式产出"}]}],
    }
    assert a2a_client.task_text(task) == "正式产出"
    assert a2a_client.task_text({"status": {"state": "completed"}}) == ""


@pytest.mark.asyncio
async def test_远端不可用时不建记录并如实说明(client, monkeypatch):
    """地址连不上 → 直接返回失败，别建了一堆 run 才发现连不上。"""
    async def boom(base, timeout=15.0):
        raise a2a_client.A2AError("连不上远端")

    monkeypatch.setattr(a2a_client, "discover", boom)

    from agent_studio.db import SessionLocal
    from agent_studio.models import Agent, new_id

    async with SessionLocal() as s:
        ag = Agent(id=new_id("ag"), workspace_id="default", slug=f"a2a-{new_id('x')[-6:]}",
                   name=f"A2A护栏-{new_id('x')[-6:]}", runtime="agentscope",
                   definition={"name": "A2A护栏", "model": {"provider": "deepseek", "name": "deepseek-chat"}, "tools": []},
                   created_at=now_ms(), updated_at=now_ms())
        s.add(ag)
        parent = Run(id=new_id("run"), agent_id=ag.id, status="running", started_at=now_ms(),
                     input={"text": "父"})
        s.add(parent)
        await s.commit()
        aid, pid = ag.id, parent.id

    result = await dispatch_remote(
        parent_run=parent, agent_id=aid, remote_base="http://127.0.0.1:1",
        items=["a", "b"],
    )
    assert result["ok"] is False
    assert "远端不可用" in result["reason"]
    assert result["items"] == []

    # 不该建出子 run
    from sqlalchemy import select

    async with SessionLocal() as s:
        kids = (await s.execute(select(Run).where(Run.parent_run_id == pid))).scalars().all()
    assert kids == []


@pytest.mark.asyncio
async def test_远端分派每一路落一条run并标a2a(client, monkeypatch):
    """正常路径：两路 → 两条 run，runtime=a2a，产出/状态如实写回。"""
    async def fake_discover(base, timeout=15.0):
        return {"name": "远端平台"}

    async def fake_run_until_done(base, text, *, agent_id=None, timeout_s=900.0):
        if "第二" in text:
            return "error", "远端说这条做不了", "task-2"
        return "ok", f"远端产出：{text}", "task-1"

    monkeypatch.setattr(a2a_client, "discover", fake_discover)
    monkeypatch.setattr(a2a_client, "run_until_done", fake_run_until_done)

    from agent_studio.db import SessionLocal
    from agent_studio.models import Agent, new_id

    async with SessionLocal() as s:
        ag = Agent(id=new_id("ag"), workspace_id="default", slug=f"a2a2-{new_id('x')[-6:]}",
                   name=f"A2A护栏2-{new_id('x')[-6:]}", runtime="agentscope",
                   definition={"name": "A2A护栏2", "model": {"provider": "deepseek", "name": "deepseek-chat"}, "tools": []},
                   created_at=now_ms(), updated_at=now_ms())
        s.add(ag)
        parent = Run(id=new_id("run"), agent_id=ag.id, status="running", started_at=now_ms(), input={"text": "父"})
        s.add(parent)
        await s.commit()
        aid, pid = ag.id, parent.id

    result = await dispatch_remote(
        parent_run=parent, agent_id=aid, remote_base="http://remote.example:8848",
        items=["第一项", "第二项"], wait_s=30,
    )
    assert result["total"] == 2
    assert result["succeeded"] == 1
    assert len(result["failed"]) == 1

    from sqlalchemy import select

    async with SessionLocal() as s:
        kids = list(
            (await s.execute(select(Run).where(Run.parent_run_id == pid).order_by(Run.item_index)))
            .scalars()
        )
    assert len(kids) == 2
    assert {k.runtime for k in kids} == {"a2a"}
    assert [k.status for k in kids] == ["ok", "error"]
    assert "远端产出：第一项" in str(kids[0].output)
    assert "做不了" in (kids[1].error or "")
    assert (kids[0].usage or {}).get("remote_task_id") == "task-1"
