"""DeepSeek 工具层：凭据解析、响应解析、错误归一、路径边界。

这些测试全部离线（打桩 httpx），因为它们要守的是**契约**：
上游字段名、错误码到人话的映射、以及"没配 key 时不能崩"。
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from agent_studio import deepseek_tools as dt
from agent_studio import native_tools as nt


class FakeResp:
    def __init__(self, status: int, payload: dict | bytes = b""):
        self.status_code = status
        self._payload = payload

    @property
    def content(self) -> bytes:
        if isinstance(self._payload, bytes):
            return self._payload
        return json.dumps(self._payload).encode()

    def json(self):
        if isinstance(self._payload, bytes):
            return json.loads(self._payload.decode() or "{}")
        return self._payload


def test_凭据_从环境变量取(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_TOOLS_API_KEY", "sk-test-1")
    import asyncio

    cred = asyncio.run(dt.resolve_credential())
    assert cred is not None and cred.api_key == "sk-test-1"
    assert cred.base_url.endswith("api.deepseek.com")


def test_凭据_没有就返回None(monkeypatch):
    """环境变量和库都没有 → None（上层据此降级/提示去配置）。"""
    monkeypatch.delenv("DEEPSEEK_TOOLS_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    import asyncio

    class _NoDB:
        def __call__(self, *a, **k):
            raise RuntimeError("no db in this test")

    monkeypatch.setattr("agent_studio.db.SessionLocal", _NoDB())
    assert asyncio.run(dt.resolve_credential()) is None


def test_搜索_解析结果并按字段渲染(monkeypatch):
    async def fake_request(*a, **k):
        return FakeResp(
            200,
            {
                "results": [
                    {
                        "rerank_score": 2.4,
                        "title": "Debian 12 安装 nginx",
                        "url": "https://a.example/x",
                        "snippet": "短摘要",
                        "summary": "长摘要：apt install nginx",
                        "content": "",
                        "site_name": "Example",
                        "authority": 3,
                        "date": "2026-06-01T00:00:00+00:00",
                    }
                ]
            },
        )

    import asyncio

    cred = dt.Credential(api_key="k")
    monkeypatch.setattr(dt, "_request", fake_request)
    results, usage = asyncio.run(dt.search(cred, "debian nginx", count=5))
    assert results[0]["authority"] == 3
    assert usage.tool == "search" and usage.unit_kind == "call"
    assert usage.extra["returned"] == 1

    rendered = nt._format_deepseek(results)
    assert "相关 2.4" in rendered and "权威 3" in rendered and "2026-06-01" in rendered
    assert "https://a.example/x" in rendered


def test_错误码映射成人话():
    e = dt._error_from(402, b'{"error":{"message":"insufficient balance"}}')
    assert e.code == "no_credit" and "余额" in e.message

    e = dt._error_from(429, b'{"error":{"message":"rate"}}')
    assert e.code == "rate_limited" and e.retry_after > 0

    e = dt._error_from(413, b"")
    assert e.code == "too_large"

    e = dt._error_from(400, b'{"error":{"message":"bad format"}}', audio=True)
    assert e.code == "too_long"

    text = dt.ToolsError("no_credential", "未配置").as_tool_text()
    assert "API 密钥" in text


def test_OCR_按页返回并计费(monkeypatch):
    async def fake_request(*a, **k):
        return FakeResp(
            200,
            {
                "id": "ocr-abc",
                "page_count": 2,
                "pages": [
                    {"index": 0, "text": "第一页内容", "finish_reason": "stop"},
                    {"index": 1, "text": "第二页内容", "finish_reason": "length"},
                ],
                "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
            },
        )

    import asyncio

    monkeypatch.setattr(dt, "_request", fake_request)
    data, usage = asyncio.run(dt.ocr(dt.Credential(api_key="k"), "a.pdf", b"%PDF"))
    assert data["page_count"] == 2
    assert usage.unit_kind == "page" and usage.units == 2
    assert usage.cost_cny == pytest.approx(0.003, abs=1e-6)


def test_ASR_按秒计费(monkeypatch):
    async def fake_request(*a, **k):
        return FakeResp(200, {"request_id": "asr-1", "text": "你好世界", "duration_ms": 3600})

    import asyncio

    monkeypatch.setattr(dt, "_request", fake_request)
    data, usage = asyncio.run(dt.asr(dt.Credential(api_key="k"), "a.wav", b"RIFF"))
    assert data["text"] == "你好世界"
    assert usage.units == pytest.approx(3.6)
    assert usage.cost_cny == pytest.approx(3.6 / 3600 * 0.78, rel=1e-3)


def test_TTS_汉字按两个字符计费(monkeypatch):
    async def fake_request(*a, **k):
        return FakeResp(200, b"RIFF....")

    import asyncio

    monkeypatch.setattr(dt, "_request", fake_request)
    audio, usage = asyncio.run(dt.tts(dt.Credential(api_key="k"), "你好"))  # 2 汉字 = 4 字符
    assert audio.startswith(b"RIFF")
    assert usage.units == 4
    assert usage.cost_cny == pytest.approx(4 / 10000 * 3.0, abs=1e-6)


def test_没有key时工具给出配置指引(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_TOOLS_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    async def _none(*a, **k):
        return None

    monkeypatch.setattr(nt, "_read_document", nt._read_document)   # 保持原函数
    monkeypatch.setattr(dt, "resolve_credential", _none)
    import asyncio

    out = asyncio.run(nt._read_document("a.pdf"))
    assert "未配置 DeepSeek 工具密钥" in out
    out = asyncio.run(nt._transcribe("a.wav"))
    assert "未配置" in out
    out = asyncio.run(nt._speak("你好"))
    assert "未配置" in out


def test_文件路径越界被拒():
    with pytest.raises(ValueError):
        nt._safe_file("../../etc/passwd")


def test_三个工具已注册且带安全标记():
    for name in ("read_document", "transcribe", "speak"):
        entry = nt.NATIVE_TOOLS[name]
        assert entry["schema"]["type"] == "object"
        assert entry["flags"]["native"] is True
        assert callable(entry["fn"])
