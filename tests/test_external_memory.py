"""外部记忆服务接入的护栏。

守四条：
① **契约解析要宽容**：外部服务常只实现个大概 —— ``{"results":[...]}`` / 纯数组 /
   ``{"data":[...]}``、条目是字符串或对象、score 缺省，都要认；认不出的忽略而不是炸。
② **密钥不落明文**：配置进设置表时加密；读回来能解开；换了主密钥解不开时
   按"未配置"处理（降级，不是崩）。
③ **失败要收敛成人话**：HTTP 4xx/网络错误/非 JSON，都归成 ExternalMemoryError。
④ **合并去重**：内置与外部命中同一句话时只留一条；外部分数不越权顶掉内置排序。
"""

from __future__ import annotations

import json

import httpx
import pytest
from sqlalchemy import select

from agent_studio.db import SessionLocal
from agent_studio.memory import external
from agent_studio.models import AppSetting

pytestmark = pytest.mark.asyncio


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=5)


async def test_配置往返_密钥加密不落明文(client):
    async with SessionLocal() as s:
        cfg = await external.save_config(
            s, enabled=True, base_url="http://mem.local:9000/", api_key="sk-secret",
            search_path="search", add_path="/add", timeout_s=7,
        )
        assert cfg.ready and cfg.api_key == "sk-secret"
        assert cfg.search_path == "/search", "路径没带前导斜杠要自动补上"

        raw = (
            await s.execute(select(AppSetting).where(AppSetting.key == external.SETTING_KEY))
        ).scalar_one().value
        assert "sk-secret" not in str(raw), "密钥绝不能以明文进设置表"
        assert raw.get("api_key_enc")

        again = await external.load_config(s)
        assert again.api_key == "sk-secret", "读回来要能解开（面向内部使用）"
        assert again.timeout_s == 7


async def test_搜索_三种响应形状都能认():
    def handler(request: httpx.Request) -> httpx.Response:
        body = __import__("json").loads(request.content)
        assert body["query"] == "用户偏好" and body["top_k"] == 3
        assert request.headers.get("authorization") == "Bearer k1"
        return httpx.Response(200, json={"results": [
            {"content": "用户在上海", "score": 0.9, "id": "m1", "tags": ["地点"]},
            "纯字符串条目",
            {"text": "字段名不同也认", "similarity": 0.4},
            {"content": "   "},          # 空内容忽略
        ]})

    cfg = external.ExternalMemoryConfig(enabled=True, base_url="http://mem.local", api_key="k1")
    async with _client(handler) as c:
        items = await external.search(cfg, "用户偏好", top_k=3, agent_id="ag_1", client=c)
    assert [i.content for i in items] == ["用户在上海", "纯字符串条目", "字段名不同也认"]
    assert items[0].score == 0.9 and items[0].tags == ["地点"]
    assert items[2].score == 0.4, "similarity 也要认"


async def test_写入_带标签与鉴权_2xx即可():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = __import__("json").loads(request.content)
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"id": "ext-42"})

    cfg = external.ExternalMemoryConfig(enabled=True, base_url="http://mem.local/base/", api_key="k2")
    async with _client(handler) as c:
        rid = await external.add(cfg, "记住：周五发版", tags=["发布"], agent_id="ag_9", client=c)
    assert rid == "ext-42"
    assert seen["url"] == "http://mem.local/base/add"
    assert seen["body"] == {"content": "记住：周五发版", "tags": ["发布"], "agent_id": "ag_9"}


async def test_失败都收敛成一句人话():
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    cfg = external.ExternalMemoryConfig(enabled=True, base_url="http://mem.local")
    async with _client(boom) as c:
        with pytest.raises(external.ExternalMemoryError) as ei:
            await external.search(cfg, "x", client=c)
    assert "外部记忆搜索失败" in str(ei.value)

    def bad_status(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    async with _client(bad_status) as c:
        with pytest.raises(external.ExternalMemoryError) as ei2:
            await external.search(cfg, "x", client=c)
    assert "HTTP 500" in str(ei2.value)

    # 没启用就直说，不打网络
    with pytest.raises(external.ExternalMemoryError):
        await external.add(external.ExternalMemoryConfig(), "x")


async def test_未启用时搜索直接返回空且不发请求():
    called = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        called["n"] += 1
        return httpx.Response(200, json={"results": []})

    cfg = external.ExternalMemoryConfig(enabled=False, base_url="http://mem.local")
    async with _client(handler) as c:
        assert await external.search(cfg, "x", client=c) == []
    assert called["n"] == 0


async def test_合并去重_外部不越权顶掉内置():
    local = [("用户在上海", 0.8), ("喜欢简洁的回答", 0.5)]
    ext = [
        external.ExternalMemoryItem(content="  用户在上海 ", score=1.0),  # 同一句（规范化后）
        external.ExternalMemoryItem(content="常用 Python", score=0.6),
    ]
    merged = external.merge_items(local, ext)
    texts = [t for t, _ in merged]
    assert len(merged) == 3, "同一句只留一条（大小写/空格不同也算同一句）"
    assert sum(1 for t in texts if t.strip() == "用户在上海") == 1
    assert "常用 Python" in texts, "正文要保留原始大小写，不能被规范化后的文本替掉"
    # 外部 0.6 × 0.9 = 0.54 → 排在本地 0.5 之前、0.8 之后
    assert texts[1] == "常用 Python"


async def test_预算裁剪按字符上限():
    items = [("a" * 100, 1.0), ("b" * 100, 0.9), ("c" * 100, 0.8)]
    kept = external.budget(items, max_chars=220)
    assert len(kept) == 2, "第三条塞不下就不要，不能撑爆上下文"


async def test_未配置时_recall_退回内置(client, monkeypatch):
    """记忆来源选 external 但外部没配 → 必须退回内置，而不是注入空。"""
    from agent_studio.context import build_turn_context
    from agent_studio.models import Memory, now_ms
    from agent_studio.schemas import MemoryPolicyRead

    async with SessionLocal() as s:
        s.add(Memory(id="mem_x1", agent_id="ag_ext", scope="agent", kind="fact",
                     content="用户在杭州", status="active", importance=0.9,
                     created_at=now_ms(), updated_at=now_ms()))
        await s.commit()

        policy = MemoryPolicyRead(agent_id="ag_ext", recall_backend="external", recall_top_k=5)
        ctx = await build_turn_context(s, agent_id="ag_ext", session_id=None,
                                       query="用户在哪", policy=policy)
    assert ctx.memory_text and "杭州" in ctx.memory_text, "外部没配时应退回内置记忆"

# ───────────────────────────────────────────────────────────────────────────── #
# 请求映射（把"字段名/额外头/结果路径跟标准契约不一样"的服务也接进来）
#
# 起因：实测用户自己的 tdai 网关（.13:8420 /v3/atomic/search）要
#   {"team_id","agent_id","user_id","query","limit"} + 头 x-tdai-service-id，
# 结果在 data.items[]。硬编码一套字段名就只能接"恰好长得一样"的服务。
# ───────────────────────────────────────────────────────────────────────────── #


@pytest.mark.filterwarnings("ignore::pytest.PytestWarning")
def test_请求模板_整值占位保类型_嵌入占位转字符串():
    from agent_studio.memory.external import render_body

    body = render_body(
        {"team_id": "default", "query": "{query}", "limit": "{top_k}", "note": "找 {query} 相关"},
        {"query": "蓝鲸", "top_k": 3, "agent_id": "ag1"},
    )
    assert body == {"team_id": "default", "query": "蓝鲸", "limit": 3, "note": "找 蓝鲸 相关"}
    assert isinstance(body["limit"], int), "整值占位必须保留数字类型（网关要 int）"


def test_结果点路径_能取到_tdai_那种_data_items():
    from agent_studio.memory.external import pick_by_path, _parse_results

    payload = {"code": 0, "data": {"items": [{"content": "用户在上海", "score": 0.9}]}}
    assert pick_by_path(payload, "data.items")[0]["content"] == "用户在上海"
    assert pick_by_path(payload, "data.missing") is None

    # 不配路径也要自动认出来（宽容探测钻一层 data）
    assert [i.content for i in _parse_results(payload)] == ["用户在上海"]
    assert [i.content for i in _parse_results(payload, results_path="data.items")] == ["用户在上海"]


def test_额外请求头会并进请求():
    from agent_studio.memory.external import ExternalMemoryConfig, _headers

    h = _headers(ExternalMemoryConfig(api_key="k", extra_headers={"x-tdai-service-id": "default"}))
    assert h["Authorization"] == "Bearer k"
    assert h["x-tdai-service-id"] == "default"


@pytest.mark.asyncio
async def test_配了模板就按模板发_没配就是标准契约(client):
    """搜索/写入的**请求体**要能整体替换成对方要的形状（端到端过一遍 HTTP 桩）。"""
    from agent_studio.memory import external

    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(
            {
                "url": str(request.url),
                "body": json.loads(request.content or b"{}"),
                "hdrs": dict(request.headers),
            }
        )
        return httpx.Response(200, json={"code": 0, "data": {"items": [{"content": "命中", "score": 1}]}})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http:
        cfg = external.ExternalMemoryConfig(
            enabled=True,
            base_url="http://mem.local",
            search_path="/v3/atomic/search",
            extra_headers={"x-tdai-service-id": "default"},
            search_body={"team_id": "default", "user_id": "default", "query": "{query}", "limit": "{top_k}"},
            results_path="data.items",
        )
        got = await external.search(cfg, "蓝鲸", top_k=3, agent_id="ag1", client=http)
        assert [i.content for i in got] == ["命中"]

        assert seen[0]["url"].endswith("/v3/atomic/search")
        assert seen[0]["body"] == {
            "team_id": "default",
            "user_id": "default",
            "query": "蓝鲸",
            "limit": 3,
        }, "配了模板就只发模板里的字段（不掺标准契约的 top_k）"
        assert seen[0]["hdrs"].get("x-tdai-service-id") == "default"

        # 没配模板 → 回到标准契约
        plain = external.ExternalMemoryConfig(enabled=True, base_url="http://mem.local")
        await external.search(plain, "蓝鲸", top_k=3, agent_id="ag1", client=http)
        assert seen[1]["body"] == {"query": "蓝鲸", "top_k": 3, "agent_id": "ag1"}
