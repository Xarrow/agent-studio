"""编排者在入口：用户只说做什么，派给谁由它拆完自己决定。

为什么单独测：这条路的价值全在「不用用户点一遍人名」。要是名单只当摆设、
或者模型编个 id 就照着建 run，那就退化成"用户委托某个 agent"了 —— 正是要避免的。
"""

from __future__ import annotations

import uuid

from agent_studio.db import SessionLocal, init_db
from agent_studio.models import Agent
from agent_studio.orchestrator.service import Orchestrator
from agent_studio.orchestrator.snapshot import team_catalog


def uniq(p: str) -> str:
    return f"{p}-{uuid.uuid4().hex[:8]}"


async def _agent(name: str, desc: str = "") -> str:
    async with SessionLocal() as s:
        a = Agent(
            slug=uniq("slug"),
            name=name,
            description=desc,
            runtime="agentscope",
            definition={"runtime": "agentscope", "name": name, "tools": [], "skills": []},
        )
        s.add(a)
        await s.commit()
        await s.refresh(a)
        return a.id


# ── 派工单解析 ───────────────────────────────────────────────────────── #


def test_派工单只收名单里的人():
    text = '''好的，我这样安排：
```json
[{"agent_id": "ag_a", "task": "写周报"},
 {"agent_id": "ag_ghost", "task": "编出来的"},
 {"agent_id": "ag_b", "task": "做复盘"}]
```'''
    got = Orchestrator._parse_plan_items(text, ["ag_a", "ag_b"])
    assert [g[0] for g in got] == ["ag_a", "ag_b"], "名单外的人必须丢掉"
    assert got[0][1] == "写周报"


def test_派工单解析不出来就是空表():
    assert Orchestrator._parse_plan_items("我想想啊……", ["ag_a"]) == []
    assert Orchestrator._parse_plan_items('["给 ag_a 干"]', ["ag_a"]) == [], "字符串不算派工单"
    assert Orchestrator._parse_plan_items("", ["ag_a"]) == []


def test_派工单可以少派人也可以一人多派():
    text = '[{"agent_id":"ag_a","task":"第一件"},{"agent_id":"ag_a","task":"第二件"}]'
    got = Orchestrator._parse_plan_items(text, ["ag_a", "ag_b"])
    assert got == [("ag_a", "第一件"), ("ag_a", "第二件")], "用不用别人是编排者的事"


def test_派工单最多八条():
    rows = ",".join(f'{{"agent_id":"ag_a","task":"第{i}件"}}' for i in range(20))
    got = Orchestrator._parse_plan_items(f"[{rows}]", ["ag_a"])
    assert len(got) == 8


# ── 真跑一遍编排循环（假模型）─────────────────────────────────────────── #

class _FakeRun:
    """够 _text / _agent_name_of / _status_of 用的最小 Run。"""

    def __init__(self, rid: str, content: str, agent_name: str):
        self.id = rid
        self.status = "ok"
        self.output = {"content": content}
        self.error = None
        self.usage = {}
        self.definition_snapshot = {"name": agent_name}


async def test_编排者按自己的派工单跑(monkeypatch):
    """关键点：用户只给了名单，**干活的人来自编排者的输出**，不是名单顺序。"""
    orch = Orchestrator()
    started: list[tuple[str, str, str]] = []  # (agent_id, role, payload)
    names = {"ag_master": "编排者", "ag_x": "写手", "ag_y": "查资料", "ag_z": "没人用的"}

    async def fake_start(orc_id, agent_id, role, order, payload, node_id=None, fanout=None):
        started.append((agent_id, role, payload))
        if role == "master":
            content = (
                '```json\n[{"agent_id":"ag_y","task":"查三条新闻"},'
                '{"agent_id":"ag_x","task":"写成三句话"}]\n```'
                if order == 0
                else "汇总：三条要点。"
            )
        else:
            content = f"{names[agent_id]}干完了"
        return _FakeRun(f"run_{len(started)}", content, names[agent_id])

    async def fake_await(rid, timeout=None):
        return next(r for r in runs if r.id == rid)

    captured: dict = {}

    async def fake_finish(orc_id, status=None, **kw):
        captured["status"] = status
        captured.update(kw)

    runs: list[_FakeRun] = []

    orig_start, orig_await, orig_finish = orch._start_step, orch._await, orch._finish

    async def start_wrapper(*a, **kw):
        r = await fake_start(*a, **kw)
        runs.append(r)
        return r

    orch._start_step = start_wrapper  # type: ignore[assignment]
    orch._await = fake_await  # type: ignore[assignment]
    orch._finish = fake_finish  # type: ignore[assignment]
    try:
        spec = {
            "mode": "master_worker",
            "master_agent_id": "ag_master",
            "roster": ["ag_x", "ag_y", "ag_z"],
            "steps": [],
            "task": "看看今天有什么新闻",
            "snapshot": {"agents": {k: {"agent_id": k, "name": v, "skills": []} for k, v in names.items()}},
        }
        await orch._master_worker("orc_1", spec)
    finally:
        orch._start_step, orch._await, orch._finish = orig_start, orig_await, orig_finish

    roles = [(a, role) for a, role, _ in started]
    # 1 次拆解 + 2 次干活（编排者没用 ag_z）+ 1 次汇总
    assert roles == [
        ("ag_master", "master"),
        ("ag_y", "worker"),
        ("ag_x", "worker"),
        ("ag_master", "master"),
    ], roles
    assert "ag_z" not in [a for a, _ in roles], "没被派的助手不该跑"
    assert captured["status"] == "ok"
    assert captured["output"]["content"] == "汇总：三条要点。"


async def test_拆解失败时名单前几位各领原任务(monkeypatch):
    orch = Orchestrator()
    started: list[tuple[str, str]] = []
    runs: list[_FakeRun] = []

    async def fake_start(orc_id, agent_id, role, order, payload, node_id=None, fanout=None):
        started.append((agent_id, role))
        content = "我不太确定该怎么做" if order == 0 else "做了"
        r = _FakeRun(f"run_{len(started)}", content, agent_id)
        runs.append(r)
        return r

    async def fake_await(rid, timeout=None):
        return next(r for r in runs if r.id == rid)

    async def fake_finish(orc_id, status=None, **kw):
        return None

    orig = orch._start_step, orch._await, orch._finish
    orch._start_step, orch._await, orch._finish = fake_start, fake_await, fake_finish  # type: ignore[assignment]
    try:
        await orch._master_worker(
            "orc_2",
            {
                "mode": "master_worker",
                "master_agent_id": "ag_m",
                "roster": ["ag_1", "ag_2", "ag_3"],
                "steps": [],
                "task": "干活",
            },
        )
    finally:
        orch._start_step, orch._await, orch._finish = orig

    assert [a for a, role in started if role == "worker"] == ["ag_1", "ag_2", "ag_3"], "拆不出来也要有人干活"


# ── API：发起时只指定编排者 ───────────────────────────────────────────── #


async def test_只指定编排者就能发起(client):
    await init_db()
    master = await _agent("编排者甲", "分析任务、派活、汇总")
    w1 = await _agent("干活甲", "写代码")
    w2 = await _agent("干活乙", "跑测试")

    r = await client.post(
        "/api/orchestrations",
        json={
            "mode": "master_worker",
            "master_agent_id": master,
            "roster": [w1, w2],
            "task": "把这个需求做完",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "编排者拆活"

    detail = (await client.get(f"/api/orchestrations/{body['id']}")).json()
    spec = detail["spec"]
    assert spec["roster"] == [w1, w2]
    assert spec["master_agent_id"] == master
    # 快照要把备选名单也记住：复盘时要能看出"当时能挑谁"
    assert set(spec["snapshot"]["agents"]) == {master, w1, w2}


async def test_花名册里有干活的人_编排者才能挑中(client):
    await init_db()
    master = await _agent("编排者乙", "派活")
    w = await _agent("干活丙", "写代码")
    body = (
        await client.post(
            "/api/orchestrations",
            json={"mode": "master_worker", "master_agent_id": master, "roster": [w], "task": "干活"},
        )
    ).json()
    spec = (await client.get(f"/api/orchestrations/{body['id']}")).json()["spec"]
    text = team_catalog(spec)
    assert "干活丙" in text, "编排者看不到名单就等于没有名单"


async def test_没指定编排者不能挑人(client):
    await init_db()
    w = await _agent("干活丁", "写代码")
    r = await client.post(
        "/api/orchestrations",
        json={"mode": "master_worker", "roster": [w], "task": "干活"},
    )
    assert r.status_code == 422
    assert "编排者" in r.json()["detail"]


async def test_名单里有不存在的助手(client):
    await init_db()
    master = await _agent("编排者丙", "派活")
    r = await client.post(
        "/api/orchestrations",
        json={"mode": "master_worker", "master_agent_id": master, "roster": ["ag_ghost"], "task": "干活"},
    )
    assert r.status_code == 404


async def test_既有写法_指定每人一格_照旧工作(client):
    await init_db()
    master = await _agent("编排者丁", "派活")
    w = await _agent("干活戊", "写代码")
    r = await client.post(
        "/api/orchestrations",
        json={
            "mode": "master_worker",
            "master_agent_id": master,
            "steps": [{"agent_id": w, "carry_prev": False}],
            "task": "干活",
        },
    )
    assert r.status_code == 201, r.text
    spec = (await client.get(f"/api/orchestrations/{r.json()['id']}")).json()["spec"]
    assert spec["steps"] and "roster" not in spec
