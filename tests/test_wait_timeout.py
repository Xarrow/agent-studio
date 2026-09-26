"""护栏：节点上的「最多等多久」必须一路走到执行 spec。

背景（血泪）：`normalise()` 原来只保留 nid/agent_id，于是画布上给节点设的
`wait_timeout_s` 在 `graph_to_spec()` 这一步就被丢掉了 —— 执行层
`node.get("wait_timeout_s")` 永远拿到 None，界面上设的值等于没设。
这几个断言就是钉住这条链路：图 → normalise → spec（四种模式都要）。
"""

from __future__ import annotations

from agent_studio.api.workflows import graph_to_spec
from agent_studio.orchestrator.graph import normalise
from agent_studio.schemas import WorkflowGraph


def _graph(nodes, edges):
    return WorkflowGraph.model_validate({"nodes": nodes, "edges": edges})


def test_normalise_keeps_wait_timeout():
    raw = {
        "nodes": [
            {"nid": "n1", "agent_id": "a1", "wait_timeout_s": 300},
            {"nid": "n2", "agent_id": "a2"},
        ],
        "edges": [{"from": "n1", "to": "n2"}],
    }
    nodes, _ = normalise(raw)
    by_nid = {n["nid"]: n for n in nodes}
    assert by_nid["n1"]["wait_timeout_s"] == 300
    assert "wait_timeout_s" not in by_nid["n2"], "没设就别带上（执行层要能落回平台默认）"


def test_normalise_ignores_junk_wait_timeout():
    raw = {
        "nodes": [
            {"nid": "n1", "agent_id": "a1", "wait_timeout_s": "很快"},
            {"nid": "n2", "agent_id": "a2", "wait_timeout_s": True},
            {"nid": "n3", "agent_id": "a3", "wait_timeout_s": None},
        ],
        "edges": [],
    }
    nodes, _ = normalise(raw)
    assert all("wait_timeout_s" not in n for n in nodes)


def test_dag_spec_carries_per_node_timeout():
    g = _graph(
        [{"nid": "n1", "agent_id": "a1"}, {"nid": "n2", "agent_id": "a2", "wait_timeout_s": -1}],
        [{"from": "n1", "to": "n2", "order": "serial"}],
    )
    spec = graph_to_spec(g, "dag", "干点活")
    by_nid = {n["nid"]: n for n in spec["nodes"]}
    assert by_nid["n2"]["wait_timeout_s"] == -1, "不限 = -1 也要原样传下去"
    assert "wait_timeout_s" not in by_nid["n1"]


def test_serial_spec_carries_per_step_timeout():
    g = _graph(
        [
            {"nid": "n1", "agent_id": "a1"},
            {"nid": "n2", "agent_id": "a2", "wait_timeout_s": 1800},
        ],
        [{"from": "n1", "to": "n2", "order": "serial"}],
    )
    spec = graph_to_spec(g, "serial", "干点活")
    assert spec["mode"] == "serial"
    timeout_by_agent = {s["agent_id"]: s.get("wait_timeout_s") for s in spec["steps"]}
    assert timeout_by_agent == {"a1": None, "a2": 1800}, "编排者那一步的上限必须落到它自己的 step 上"


def test_master_worker_spec_carries_master_and_worker_timeouts():
    g = _graph(
        [
            {"nid": "m", "agent_id": "am", "wait_timeout_s": 3600},
            {"nid": "w1", "agent_id": "a1", "wait_timeout_s": 60},
            {"nid": "w2", "agent_id": "a2"},
        ],
        [
            {"from": "m", "to": "w1", "order": "serial"},
            {"from": "m", "to": "w2", "order": "serial"},
        ],
    )
    spec = graph_to_spec(g, "master_worker", "干点活")
    assert spec["mode"] == "master_worker"
    assert spec["master_wait_timeout_s"] == 3600, "主控拆任务 / 汇总两跳等多久，由主控节点说了算"
    assert {s.get("wait_timeout_s") for s in spec["steps"]} == {60, None}, (
        "worker 各自的上限跟着各自的 step（没设的不能带值）"
    )
