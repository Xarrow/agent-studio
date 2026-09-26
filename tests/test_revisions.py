"""护栏：版本历史与回滚。

三条必须钉住的：
  ① 版本里存的是**内容**（不是只有一个数字），否则"回滚"无从谈起
  ② 内容没变**不记新版本**（画布是自动保存的，否则历史会被噪声刷满）
  ③ 回滚是**前进**：新建一条快照、不动历史（这样"我退回又改回来"也有记录）
"""

from __future__ import annotations

import uuid

from agent_studio.revisions import KIND_AGENT, KIND_WORKFLOW, summarize


def uniq(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def agent_payload(name: str, prompt: str, model: str = "deepseek-v4-flash", tools=None):
    return {
        "name": name,
        "definition": {
            "runtime": "agentscope",
            "name": name,
            "system_prompt": prompt,
            "model": {"provider": "deepseek", "name": model},
            "tools": tools or [],
            "skills": [],
            "limits": {"max_iters": 3, "timeout_s": 30},
        },
    }


# --------------------------------------------------------------------------- #
# 1. 纯函数：「改了什么」要说成人话
# --------------------------------------------------------------------------- #
def test_summarize_first_record():
    assert summarize(KIND_AGENT, None, {"name": "x"}) == "首次记录"


def test_summarize_detects_prompt_model_tools():
    old = {"name": "A", "definition": {"system_prompt": "旧", "model": {"name": "m1", "provider": "p1"}, "tools": []}}
    new = {
        "name": "A",
        "definition": {"system_prompt": "新", "model": {"name": "m2", "provider": "p1"}, "tools": ["read"]},
    }
    s = summarize(KIND_AGENT, old, new)
    assert "提示词" in s and "换模型" in s and "工具" in s


def test_summarize_workflow_counts_steps():
    old = {"name": "w", "graph": {"nodes": [{"nid": "n1"}], "edges": []}}
    new = {"name": "w", "graph": {"nodes": [{"nid": "n1"}, {"nid": "n2"}], "edges": [{"from": "n1", "to": "n2"}]}}
    s = summarize(KIND_WORKFLOW, old, new)
    assert "步骤 1 → 2" in s and "连线 0 → 1" in s


def test_summarize_is_never_empty():
    """界面直接显示这句话 —— 空字符串会显示成一块空白，比"细节调整"更糟。"""
    same = {"name": "A", "definition": {"system_prompt": "同", "model": {"name": "m"}}}
    assert summarize(KIND_AGENT, same, same) == "细节调整"
    assert summarize(KIND_WORKFLOW, {"graph": {}}, {"graph": {}}) == "版面或细节调整"


# --------------------------------------------------------------------------- #
# 2. 端到端：建档有第一版 → 改了记一版 → 回滚真的退回去
# --------------------------------------------------------------------------- #
async def test_agent_revision_roundtrip(client):
    name = uniq("版本助手")
    r = await client.post("/api/agents", json=agent_payload(name, "第一版提示词"))
    aid = r.json()["id"]

    r = await client.get("/api/revisions", params={"kind": "agent", "target_id": aid})
    items = r.json()["items"]
    assert [i["version"] for i in items] == [1], "建档就该有第一版（不用等第一次改）"
    assert items[0]["label"] == "首次记录" and items[0]["current"] is True
    v1_id = items[0]["id"]

    # 改提示词 → 自动记一版，并且说清改了什么
    await client.put(f"/api/agents/{aid}", json=agent_payload(name, "第二版提示词"))
    items = (await client.get("/api/revisions", params={"kind": "agent", "target_id": aid})).json()["items"]
    assert [i["version"] for i in items] == [2, 1]
    assert "提示词" in items[0]["label"], items[0]["label"]

    # **内容没变不该记新版**（自动保存会重复提交同样的内容）
    await client.put(f"/api/agents/{aid}", json=agent_payload(name, "第二版提示词"))
    items = (await client.get("/api/revisions", params={"kind": "agent", "target_id": aid})).json()["items"]
    assert [i["version"] for i in items] == [2, 1], "内容没变却又记了一版（历史会被噪声刷满）"

    # 回滚到 v1：内容真的退回去，而且**历史只增不改**
    r = await client.post(f"/api/revisions/{v1_id}/restore")
    assert r.status_code == 200 and r.json()["restored_from"] == 1
    detail = (await client.get(f"/api/agents/{aid}")).json()
    assert detail["definition"]["system_prompt"] == "第一版提示词", "回滚没把内容退回去"
    assert detail["version"] >= 3, "回滚也算一次改动（version 要前进）"

    items = (await client.get("/api/revisions", params={"kind": "agent", "target_id": aid})).json()["items"]
    assert items[0]["version"] == 3 and "回滚" in items[0]["label"], items[0]
    assert len(items) == 3, "回滚是**前进**：不该抹掉中间那版"


async def test_restore_missing_revision_404(client):
    r = await client.post("/api/revisions/rev_nope/restore")
    assert r.status_code == 404


async def test_revisions_rejects_unknown_kind(client):
    r = await client.get("/api/revisions", params={"kind": "banana", "target_id": "x"})
    assert r.status_code == 422


async def test_workflow_revisions_capture_graph(client):
    """流程也要有历史：画布自动保存最容易"改坏了还想退回去"。"""
    a = (await client.post("/api/agents", json=agent_payload(uniq("图助手"), "p"))).json()["id"]
    b = (await client.post("/api/agents", json=agent_payload(uniq("图助手2"), "p"))).json()["id"]
    wf = (
        await client.post(
            "/api/workflows",
            json={"name": uniq("版本流程"), "graph": {"nodes": [{"nid": "n1", "agent_id": a}], "edges": []}},
        )
    ).json()
    wid, v1 = wf["id"], wf["graph"]
    # 加一个节点（等于是画布上的一次编辑）
    await client.put(
        f"/api/workflows/{wid}",
        json={
            "graph": {
                "nodes": [{"nid": "n1", "agent_id": a}, {"nid": "n2", "agent_id": b}],
                "edges": [{"from": "n1", "to": "n2", "order": "serial"}],
            }
        },
    )
    items = (await client.get("/api/revisions", params={"kind": "workflow", "target_id": wid})).json()["items"]
    assert len(items) == 2 and "步骤" in items[0]["label"], items
    old_id = items[1]["id"]
    await client.post(f"/api/revisions/{old_id}/restore")
    graph = (await client.get(f"/api/workflows/{wid}")).json()["graph"]
    assert len(graph["nodes"]) == 1, "流程回滚没把图退回去"
    assert graph["nodes"][0]["agent_id"] == v1["nodes"][0]["agent_id"]
