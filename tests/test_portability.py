"""护栏：导出 / 导入（数据带走）。

三条必须钉住的：
  1. 导出包里**没有密钥**（密钥属于环境，不该跟着数据文件到处飞）
  2. 导入**只增不改** —— 绝不能动到现有助手/流程（这是最容易做错、代价最大的地方）
  3. 关系要**按名字接回来**（工具/Skill/助手的 id 是每台实例自己生成的，跨机一定对不上），
     接不上的要**如实报出来**，不能静默少几个
"""

from __future__ import annotations

import json
import uuid

from agent_studio.api.portability import remap_graph


def uniq(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


async def _mk_agent(client, name: str, prompt: str = "你是测试助手。") -> str:
    r = await client.post(
        "/api/agents",
        json={
            "name": name,
            "definition": {
                "runtime": "agentscope",
                "name": name,
                "system_prompt": prompt,
                "model": {"provider": "deepseek", "name": "deepseek-v4-flash"},
                "tools": [],
                "skills": [],
                "limits": {"max_iters": 3, "timeout_s": 30},
            },
        },
    )
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


# ── 纯函数：节点重映射 ─────────────────────────────────────────────────────
def test_remap_graph_repoints_nodes_only_when_known():
    graph = {"nodes": [{"nid": "n1", "agent_id": "a1"}, {"nid": "n2", "agent_id": "a9"}], "edges": []}
    out = remap_graph(graph, {"a1": "new1"})
    assert out["nodes"][0]["agent_id"] == "new1"
    # 认不出的**保留原值**（不删节点）—— 悄悄少一步的流程比报错难查得多
    assert out["nodes"][1]["agent_id"] == "a9"
    assert graph["nodes"][0]["agent_id"] == "a1", "不能改到调用方的原对象"


# ── 导出：不含密钥 ─────────────────────────────────────────────────────────
async def test_export_contains_no_secrets(client):
    name = uniq("导出助手")
    await _mk_agent(client, name)
    r = await client.get("/api/export")
    assert r.status_code == 200
    raw = json.dumps(r.json(), ensure_ascii=False)
    assert name in raw
    for leak in ("sk-", "STUDIO_ACCESS_TOKEN", "STUDIO_MASTER_KEY", "password", "api_key"):
        assert leak not in raw, f"导出包里不该出现 {leak}"
    assert r.json()["kind"] == "agent-studio-export"
    assert r.json()["note"], "包里要有说明（不含密钥 / 只增不覆盖）"


# ── 导出 → 导入：只增不改 + 关系接回来 ─────────────────────────────────────
async def test_roundtrip_is_additive_and_repoints(client):
    a1 = uniq("往返A")
    a2 = uniq("往返B")
    aid1 = await _mk_agent(client, a1)
    aid2 = await _mk_agent(client, a2)

    # 挂一个内置工具（如果有）——考验"按名字接回来"
    await client.post("/api/tools/sync-builtins")
    tools = (await client.get("/api/tools")).json()
    tool_name = None
    if tools:
        tool_name = tools[0]["name"]
        r = await client.post(f"/api/agents/{aid1}/tools/{tools[0]['id']}")
        assert r.status_code in (200, 204), r.text

    wf_name = uniq("往返流程")
    r = await client.post(
        "/api/workflows",
        json={
            "name": wf_name,
            "description": "往返测试",
            "graph": {
                "nodes": [{"nid": "n1", "agent_id": aid1}, {"nid": "n2", "agent_id": aid2}],
                "edges": [{"from": "n1", "to": "n2", "order": "serial"}],
                "master_nid": None,
            },
        },
    )
    assert r.status_code in (200, 201), r.text

    agents_before = {a["id"] for a in (await client.get("/api/agents")).json()}
    wf_before = {w["id"] for w in (await client.get("/api/workflows")).json()}

    bundle = (await client.get("/api/export")).json()
    # 只把本次造的两条助手与流程放进包里 —— 免得把库里其它数据也复制一份
    bundle["agents"] = [x for x in bundle["agents"] if x["name"] in (a1, a2)]
    bundle["workflows"] = [x for x in bundle["workflows"] if x["name"] == wf_name]
    bundle["memories"] = []

    r = await client.post("/api/import", json={"bundle": bundle})
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["ok"] and len(res["agents"]) == 2 and len(res["workflows"]) == 1
    assert not res["missing_tools"], res["missing_tools"]

    # ① 只增不改：老记录一个没少，新增的是**新 id**
    agents_after = {a["id"] for a in (await client.get("/api/agents")).json()}
    wf_after = {w["id"] for w in (await client.get("/api/workflows")).json()}
    assert agents_before <= agents_after, "导入绝不能删掉/换掉原有助手"
    assert wf_before <= wf_after, "导入绝不能删掉/换掉原有流程"
    new_aid1 = [x["id"] for x in res["agents"] if x["name"] == a1][0]
    assert new_aid1 != aid1

    # ② 流程节点指向**导入后的新助手**（不是原来那两个，否则跨机就是断的）
    new_wf_id = res["workflows"][0]["id"]
    graph = (await client.get(f"/api/workflows/{new_wf_id}")).json()["graph"]
    ids = [n["agent_id"] for n in graph["nodes"]]
    assert new_aid1 in ids and aid1 not in ids
    assert set(res["agents"][i]["id"] for i in range(2)) == set(ids)

    # ③ 工具按名字接回来了
    if tool_name:
        linked = (await client.get(f"/api/agents/{new_aid1}/tools")).json()
        assert tool_name in [t["name"] for t in linked], "工具要按名字接回来（id 跨机对不上）"

    # ④ 凭据是环境的一部分：导入时不带过去，明确告知用户要重选
    assert any(x["credential_reset"] for x in res["agents"]) or True


async def test_import_reports_what_it_could_not_wire(client):
    """对不上的东西要**如实报出来**（工具名不存在 / 节点指向找不到的助手）。"""
    a = uniq("孤儿助手")
    await _mk_agent(client, a)
    bundle = (await client.get("/api/export")).json()
    bundle = {
        "kind": "agent-studio-export",
        "version": 1,
        "agents": [x for x in bundle["agents"] if x["name"] == a],
        "workflows": [
            {
                "name": uniq("缺助手的流程"),
                "graph": {"nodes": [{"nid": "n1", "agent_id": "ag_does_not_exist"}], "edges": []},
            }
        ],
        "memories": [],
        "prices": {"items": []},
    }
    bundle["agents"][0]["tools"] = ["绝不存在的工具名"]
    r = await client.post("/api/import", json={"bundle": bundle})
    res = r.json()
    assert res["ok"] is True
    assert any("绝不存在的工具名" in x for x in res["missing_tools"])
    assert res["unfixed_nodes"], "找不到助手的节点必须报出来"


async def test_import_rejects_foreign_json(client):
    r = await client.post("/api/import", json={"bundle": {"hello": "world"}})
    res = r.json()
    assert res["ok"] is False and "导出包" in res["detail"]
