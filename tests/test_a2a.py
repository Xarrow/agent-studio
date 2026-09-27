"""A2A 协议接入的护栏测试。

覆盖三块：
1. **纯函数**：状态映射、Message → 文本、Run → Task 的翻译（不碰网络）
2. **发现**：agent-card 的形状（外部框架靠它决定怎么调我们）
3. **协议行为**：JSON-RPC 的成功/错误分支（建任务、查任务、方法不存在、参数错）
"""

from __future__ import annotations

import pytest

from agent_studio.api import a2a


# --------------------------------------------------------------------------- #
# 1. 纯函数
# --------------------------------------------------------------------------- #
def test_state_map_covers_all_run_statuses():
    """本平台 Run.status 的每个取值都必须有 A2A 对应态（漏一个外部就卡住）。"""
    assert set(a2a.STATE_MAP) == {
        "pending",
        "running",
        "ok",
        "error",
        "aborted",
        "waiting_hitl",
    }
    assert a2a.STATE_MAP["waiting_hitl"] == "input-required"
    assert a2a.STATE_MAP["ok"] == "completed"


def test_text_of_message_joins_text_parts():
    msg = {
        "role": "user",
        "parts": [
            {"kind": "text", "text": "第一行"},
            {"kind": "text", "text": "第二行"},
        ],
    }
    assert a2a.text_of_message(msg) == "第一行\n第二行"


def test_text_of_message_marks_files_and_data():
    msg = {
        "role": "user",
        "parts": [
            {"kind": "text", "text": "看这个"},
            {"kind": "file", "file": {"uri": "file:///tmp/a.txt"}},
            {"kind": "data", "data": {"n": 1}},
        ],
    }
    out = a2a.text_of_message(msg)
    assert "看这个" in out
    assert "file:///tmp/a.txt" in out
    assert '"n": 1' in out


def test_text_of_message_empty_when_no_usable_part():
    assert a2a.text_of_message({"role": "user", "parts": []}) == ""
    assert a2a.text_of_message({"role": "user", "parts": [{"kind": "file"}]}) != ""


class _FakeRun:
    def __init__(self, **kw):
        self.id = "run_x"
        self.agent_id = "ag_1"
        self.status = "ok"
        self.output = {"text": "答案是 2"}
        self.error = None
        self.session_id = "ses_1"
        self.started_at = 1000
        self.ended_at = 2000
        self.pending_hitl = None
        for k, v in kw.items():
            setattr(self, k, v)


def test_task_of_maps_terminal_run():
    task = a2a.task_of(_FakeRun(), "通用助手")
    assert task["id"] == "run_x"
    assert task["contextId"] == "ses_1"
    assert task["status"]["state"] == "completed"
    assert task["artifacts"][0]["parts"][0]["text"] == "答案是 2"
    assert task["metadata"]["agentName"] == "通用助手"


def test_task_of_waiting_hitl_carries_question():
    """input-required 必须把"要确认什么"带出去，否则外部无从回答。"""
    run = _FakeRun(status="waiting_hitl", pending_hitl={"tool": "shell", "cmd": "ls"})
    task = a2a.task_of(run)
    assert task["status"]["state"] == "input-required"
    assert "shell" in task["status"]["message"]["parts"][0]["text"]


def test_task_of_failed_exposes_error():
    run = _FakeRun(status="error", output={}, error="模型超时")
    task = a2a.task_of(run)
    assert task["status"]["state"] == "failed"
    assert task["metadata"]["error"] == "模型超时"
    assert "artifacts" not in task


def test_event_to_a2a_text_delta_becomes_artifact_update():
    run = _FakeRun(status="running")
    out = a2a._event_to_a2a(
        {"type": "text_delta", "payload": {"text": "你好"}}, run, 7
    )
    assert out["id"] == 7
    assert out["result"]["kind"] == "artifact-update"
    assert out["result"]["append"] is True
    assert out["result"]["artifact"]["parts"][0]["text"] == "你好"
    assert out["result"]["final"] is False


def test_event_to_a2a_terminal_events_are_final():
    run = _FakeRun(status="ok")
    end = a2a._event_to_a2a({"type": "run_end", "payload": {}}, run, 1)
    assert end["result"]["status"]["state"] == "completed"
    assert end["result"]["final"] is True
    err = a2a._event_to_a2a({"type": "error", "payload": {"message": "炸了"}}, run, 1)
    assert err["result"]["status"]["state"] == "failed"
    assert err["result"]["final"] is True


def test_event_to_a2a_ignores_internal_events():
    run = _FakeRun(status="running")
    for t in ("llm_call_start", "tool_call_args", "thinking_delta"):
        assert a2a._event_to_a2a({"type": t, "payload": {}}, run, 1) is None


# --------------------------------------------------------------------------- #
# 2. 发现（agent-card）
# --------------------------------------------------------------------------- #
@pytest.fixture()
async def client_(monkeypatch):
    """最小 app：只挂 A2A 路由（不拉起整个平台）。"""
    from httpx import ASGITransport, AsyncClient
    from fastapi import FastAPI

    from agent_studio.db import get_session

    app = FastAPI()
    app.include_router(a2a.router)

    async def _fake_session():
        yield None

    app.dependency_overrides[get_session] = _fake_session
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


async def test_agent_card_shape(client_, monkeypatch):
    class _A:
        id = "ag_1"
        name = "通用助手"
        version = 3
        definition = {"runtime": "agentscope", "model": {"name": "deepseek-v4-flash"}, "description": "干活的"}

    async def _pick(session, agent_id):
        return _A()

    async def _tools(session, agent_id):
        class _T:
            name = "python"
            description = "跑 Python"
            kind = "native"

        return [_T()]

    async def _skills(session, agent_id):
        return []

    monkeypatch.setattr(a2a, "_agent_for_card", _pick)
    monkeypatch.setattr(a2a, "load_tools", _tools)
    monkeypatch.setattr(a2a, "load_skill_rows", _skills)

    r = await client_.get("/.well-known/agent-card.json")
    assert r.status_code == 200
    card = r.json()
    assert card["protocolVersion"] == "0.3.0"
    assert card["preferredTransport"] == "JSONRPC"
    assert card["capabilities"]["streaming"] is True
    assert card["url"].endswith("/a2a")
    assert card["skills"][0]["name"] == "python"
    assert card["metadata"]["agentId"] == "ag_1"


# --------------------------------------------------------------------------- #
# 3. 协议行为
# --------------------------------------------------------------------------- #
async def test_method_not_found_returns_rpc_error(client_):
    r = await client_.post("/a2a", json={"jsonrpc": "2.0", "id": 1, "method": "tasks/nope"})
    assert r.status_code == 200                 # 协议层错误走 body，不是 HTTP 码
    body = r.json()
    assert body["id"] == 1
    assert body["error"]["code"] == a2a.E_METHOD_NOT_FOUND


async def test_tasks_get_missing_id_is_invalid_params(client_):
    r = await client_.post("/a2a", json={"jsonrpc": "2.0", "id": 2, "method": "tasks/get", "params": {}})
    assert r.json()["error"]["code"] == a2a.E_INVALID_PARAMS


async def test_bad_json_body_is_parse_error(client_):
    r = await client_.post(
        "/a2a", content=b"{not json", headers={"Content-Type": "application/json"}
    )
    assert r.json()["error"]["code"] == a2a.E_PARSE


async def test_message_send_without_text_is_invalid_params(client_, monkeypatch):
    """一条没有可用文本的 message/send 必须在参数层就被挡下（别去建一个空任务）。"""
    r = await client_.post(
        "/a2a",
        json={
            "jsonrpc": "2.0",
            "id": 9,
            "method": "message/send",
            "params": {"message": {"role": "user", "parts": []}},
        },
    )
    assert r.json()["error"]["code"] == a2a.E_INVALID_PARAMS


async def test_tasks_cancel_requires_id(client_):
    r = await client_.post(
        "/a2a", json={"jsonrpc": "2.0", "id": 10, "method": "tasks/cancel", "params": {}}
    )
    assert r.json()["error"]["code"] == a2a.E_INVALID_PARAMS
