"""API 端到端测试（ASGI 直连，无需起服务）。

覆盖：健康检查 / Provider 列表 / 多 LLM Key 管理 / Agent CRUD 与复制 /
运行时能力 / 定义校验。
"""

from __future__ import annotations

import uuid

import pytest


def uniq(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def agent_payload(name: str, provider: str = "deepseek", **over):
    payload = {
        "name": name,
        "definition": {
            "runtime": "agentscope",
            "name": name,
            "system_prompt": "你是一个测试助手。",
            "model": {"provider": provider, "name": "deepseek-v4-flash"},
            "tools": [],
            "skills": [],
            "limits": {"max_iters": 10, "timeout_s": 60},
        },
    }
    payload.update(over)
    return payload


# --------------------------------------------------------------------------- #
# 基础
# --------------------------------------------------------------------------- #
async def test_health(client):
    r = await client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "agentscope" in body["runtimes"]


async def test_list_providers(client):
    r = await client.get("/api/providers")
    assert r.status_code == 200
    names = {p["name"] for p in r.json()}
    assert {"deepseek", "openai", "anthropic", "dashscope", "moonshot", "xai", "gemini", "ollama"} <= names
    deepseek = next(p for p in r.json() if p["name"] == "deepseek")
    assert deepseek["default_base_url"]
    assert deepseek["models"]


# --------------------------------------------------------------------------- #
# 多 LLM Key 管理
# --------------------------------------------------------------------------- #
async def test_credential_lifecycle_and_masking(client):
    name = uniq("ds-main")
    r = await client.post(
        "/api/credentials",
        json={"name": name, "provider": "deepseek", "api_key": "sk-abcdefgh12345678"},
    )
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["provider"] == "deepseek"
    assert created["provider_display"] == "DeepSeek"
    # 明文绝不回传
    assert "sk-abcdefgh12345678" not in r.text
    assert created["masked_key"] != "sk-abcdefgh12345678"

    cid = created["id"]

    # 列表里同样不含明文
    listing = await client.get("/api/credentials")
    assert listing.status_code == 200
    assert "sk-abcdefgh12345678" not in listing.text
    assert any(c["id"] == cid for c in listing.json())

    # 更新（留空 key 则不改）
    r = await client.put(f"/api/credentials/{cid}", json={"name": name + "-v2"})
    assert r.status_code == 200
    assert r.json()["name"] == name + "-v2"

    # 删除
    assert (await client.delete(f"/api/credentials/{cid}")).status_code == 204
    assert all(c["id"] != cid for c in (await client.get("/api/credentials")).json())


async def test_multiple_keys_per_provider(client):
    """同一 provider 可以配置多套 key（主号/备用号）。"""
    a = uniq("ds-a")
    b = uniq("ds-b")
    for n in (a, b):
        r = await client.post(
            "/api/credentials",
            json={"name": n, "provider": "deepseek", "api_key": "sk-" + uuid.uuid4().hex},
        )
        assert r.status_code == 201, r.text

    rows = (await client.get("/api/credentials?provider=deepseek")).json()
    names = {c["name"] for c in rows}
    assert {a, b} <= names


async def test_provider_alias_normalized(client):
    """用户写 kimi / claude 也要落到规范 provider。"""
    for alias, expected in (("kimi", "moonshot"), ("claude", "anthropic")):
        r = await client.post(
            "/api/credentials",
            json={"name": uniq(alias), "provider": alias, "api_key": "sk-" + uuid.uuid4().hex},
        )
        assert r.status_code == 201, r.text
        assert r.json()["provider"] == expected


async def test_credential_rejects_unknown_provider(client):
    r = await client.post(
        "/api/credentials",
        json={"name": uniq("bad"), "provider": "no-such-llm", "api_key": "x"},
    )
    assert r.status_code == 400


async def test_credential_requires_key_except_ollama(client):
    r = await client.post(
        "/api/credentials", json={"name": uniq("nokey"), "provider": "deepseek", "api_key": ""}
    )
    assert r.status_code == 400

    r = await client.post(
        "/api/credentials",
        json={"name": uniq("ollama"), "provider": "ollama", "api_key": ""},
    )
    assert r.status_code == 201          # 本地模型无需 key


async def test_duplicate_credential_name_conflicts(client):
    name = uniq("dup")
    body = {"name": name, "provider": "openai", "api_key": "sk-x" * 3}
    assert (await client.post("/api/credentials", json=body)).status_code == 201
    assert (await client.post("/api/credentials", json=body)).status_code == 409


# --------------------------------------------------------------------------- #
# Agent CRUD + 复制
# --------------------------------------------------------------------------- #
async def test_agent_crud(client):
    name = uniq("agent")
    r = await client.post("/api/agents", json=agent_payload(name))
    assert r.status_code == 201, r.text
    created = r.json()
    aid = created["id"]
    assert created["runtime"] == "agentscope"
    assert created["version"] == 1
    assert created["definition"]["system_prompt"]

    # 读
    got = await client.get(f"/api/agents/{aid}")
    assert got.status_code == 200
    assert got.json()["name"] == name

    # 改（version 自增）
    r = await client.put(
        f"/api/agents/{aid}",
        json={"definition": {**agent_payload(name)["definition"], "system_prompt": "改过了"}},
    )
    assert r.status_code == 200
    assert r.json()["version"] == 2
    assert r.json()["definition"]["system_prompt"] == "改过了"

    # 删
    assert (await client.delete(f"/api/agents/{aid}")).status_code == 204
    assert (await client.get(f"/api/agents/{aid}")).status_code == 404


async def test_agent_duplicate(client):
    """复制：定义 + 挂载关系都要带过去，并记录血缘。"""
    src_name = uniq("src")
    r = await client.post("/api/agents", json=agent_payload(src_name))
    src_id = r.json()["id"]

    r = await client.post(f"/api/agents/{src_id}/duplicate", json={"name": src_name + "-copy"})
    assert r.status_code == 201, r.text
    clone = r.json()
    assert clone["id"] != src_id
    assert clone["name"] == src_name + "-copy"
    assert clone["parent_id"] == src_id          # 血缘
    assert clone["version"] == 1                 # 副本从 v1 开始
    assert clone["definition"]["system_prompt"] == agent_payload(src_name)["definition"]["system_prompt"]

    # 血缘链
    lineage = await client.get(f"/api/agents/{clone['id']}/lineage")
    assert lineage.status_code == 200
    assert [a["id"] for a in lineage.json()] == [clone["id"], src_id]


async def test_agent_duplicate_auto_slug(client):
    """同 slug 复制多次不应冲突。"""
    name = uniq("slugtest")
    r = await client.post("/api/agents", json=agent_payload(name))
    src_id = r.json()["id"]
    slugs = set()
    for _ in range(3):
        r = await client.post(f"/api/agents/{src_id}/duplicate", json={})
        assert r.status_code == 201, r.text
        slugs.add(r.json()["slug"])
    assert len(slugs) == 3


async def test_agent_not_found(client):
    assert (await client.get("/api/agents/ag_does_not_exist")).status_code == 404


# --------------------------------------------------------------------------- #
# 工具挂载
# --------------------------------------------------------------------------- #
async def test_mount_and_unmount_tool(client):
    # 先落一个 HTTP 工具
    tname = uniq("http-tool")
    r = await client.post(
        "/api/tools",
        json={
            "kind": "http",
            "name": tname,
            "description": "测试用 HTTP 工具",
            "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}},
            "impl": {"method": "GET", "url": "https://example.com/?city={{city}}"},
            "flags": {"read_only": True},
        },
    )
    assert r.status_code == 201, r.text
    tid = r.json()["id"]

    # 建 agent 并挂载
    r = await client.post("/api/agents", json=agent_payload(uniq("toolhost")))
    aid = r.json()["id"]
    assert (await client.post(f"/api/agents/{aid}/tools/{tid}")).status_code == 204

    mounted = (await client.get(f"/api/agents/{aid}/tools")).json()
    assert any(t["id"] == tid for t in mounted)

    # 卸载
    assert (await client.delete(f"/api/agents/{aid}/tools/{tid}")).status_code == 204
    mounted = (await client.get(f"/api/agents/{aid}/tools")).json()
    assert all(t["id"] != tid for t in mounted)


async def test_sync_builtins(client):
    r = await client.post("/api/tools/sync-builtins?runtime=agentscope")
    assert r.status_code == 200
    body = r.json()
    assert body["discovered"] >= 5
    rows = (await client.get("/api/tools?kind=builtin")).json()
    names = {t["name"] for t in rows}
    assert {"read", "write", "bash"} <= names


# --------------------------------------------------------------------------- #
# 运行时能力与校验
# --------------------------------------------------------------------------- #
async def test_runtime_capabilities(client):
    r = await client.get("/api/runtimes/agentscope/capabilities")
    assert r.status_code == 200
    caps = r.json()
    assert caps["supports_hitl"] is True
    assert "react_config" in caps["option_schema"]["properties"]


async def test_validate_endpoint(client):
    ok = await client.post(
        "/api/runtimes/validate",
        json={
            "definition": {
                "runtime": "agentscope",
                "name": "v",
                "system_prompt": "x",
                "model": {"provider": "deepseek", "name": "m", "api_key": "sk-t"},
            }
        },
    )
    assert ok.status_code == 200
    assert ok.json()["ok"] is True

    bad = await client.post(
        "/api/runtimes/validate",
        json={
            "definition": {
                "runtime": "agentscope",
                "name": "v",
                "system_prompt": "x",
                "model": {"provider": "not-a-provider", "name": "m"},
            }
        },
    )
    assert bad.status_code == 200
    assert bad.json()["ok"] is False
    assert bad.json()["issues"]


# --------------------------------------------------------------------------- #
# 未跑通的接口也要能正确报错（不 500）
# --------------------------------------------------------------------------- #
async def test_run_on_missing_agent_404(client):
    r = await client.post("/api/runs", json={"agent_id": "ag_nope", "input": "hi"})
    assert r.status_code == 404


async def test_trace_on_missing_run_404(client):
    r = await client.get("/api/runs/trace/run_nope")
    assert r.status_code == 404
