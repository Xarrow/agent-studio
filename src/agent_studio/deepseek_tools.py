"""DeepSeek 工具三件套（搜索 / 抓取 / OCR / ASR / TTS）的服务端适配。

为什么单独一层
==============
工业场景下这些能力都发生在**服务端**：文件已经在会话工作目录里、Agent 在跑、
产出要落盘成产物。前端不参与，也不该拿到 key。

这一层只干四件事：
1. 凭据解析（用户自己的 key，可多套，按「助手绑定 > 全局默认」取）；
2. 限流与重试（TTS/ASR 每账号 50 并发、OCR 15 并发；503/504 才重试）；
3. 错误归一（余额不足 / 限流 / 文件过大 / 超时 / 繁忙 / 参数错），
   让上层能给模型和用户一句人话 + 一个动作，而不是"工具调用失败"；
4. 计量（单位、预估花费），供用量页与成本上限使用。

不做的事：不缓存业务结果（音频缓存由调用方决定）、不读写数据库里的业务数据。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

logger = logging.getLogger(__name__)

#: 官方端点（企业代理可改）
DEFAULT_BASE = "https://api.deepseek.com"

#: 并发闸：按官方限制留一点余量（OCR 15 / 语音 50）
SEM_OCR = asyncio.Semaphore(15)
SEM_AUDIO = asyncio.Semaphore(50)
SEM_WEB = asyncio.Semaphore(10)

#: 单价（元）。search/fetch 官方未标价，先按"未定价"记条数。
PRICE_TTS_PER_10K_CHAR = 3.0
PRICE_ASR_PER_HOUR = 0.78
PRICE_OCR_PER_1K_PAGE = 1.5

#: 硬限制（官方文档）
LIMIT_ASR_BYTES = 8 * 1024 * 1024
LIMIT_ASR_SECONDS = 120
LIMIT_OCR_BYTES = 100 * 1024 * 1024
LIMIT_TTS_CHARS = 10_000


class ToolsError(Exception):
    """所有上游错误归一到这里：code 给程序看，message 给人看。"""

    def __init__(self, code: str, message: str, *, retry_after: int = 0) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retry_after = retry_after

    def as_tool_text(self) -> str:
        """给模型看的一句人话（模型据此决定"重试/换路/上报"）。"""
        hint = {
            "no_credential": "请让用户在「API 密钥」里添加 DeepSeek 工具密钥（provider=deepseek-tools）。",
            "no_credit": "DeepSeek 账户余额不足，请让用户充值或换一套 key。",
            "rate_limited": "上游并发已满，等几秒再试一次；连续两次就停手。",
            "too_large": "文件超过官方上限，请先拆分或压缩。",
            "too_long": "音频超过 120 秒，请分段处理后合并。",
            "timeout": "上游超时；小文件可重试一次，大文件应拆分。",
            "busy": "上游繁忙，稍后重试。",
            "bad_input": "参数或文件格式不被接受，按提示修正后重试。",
            "unavailable": "该能力当前不可用（未配置或网络不通），换用平台内置通道或改用已知 URL 直取。",
        }.get(self.code, "")
        return f"✗ {self.message}" + (f"\n{hint}" if hint else "")


@dataclass
class Usage:
    """一次调用的计量明细，交给上层落库。"""

    tool: str
    unit_kind: str = ""
    units: float = 0.0
    cost_cny: float = 0.0
    latency_ms: int = 0
    request_id: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class Credential:
    api_key: str
    base_url: str = DEFAULT_BASE


# --------------------------------------------------------------------------- #
# 凭据解析
# --------------------------------------------------------------------------- #
async def resolve_credential(session: Any = None) -> Credential | None:
    """取 DeepSeek 工具用的 key。

    优先级（与模型凭据同一套语义，用户不需要学第二遍）：
      1. 环境变量 ``DEEPSEEK_TOOLS_API_KEY``（部署时注入，适合单租户）
      2. ``secret`` 表里 provider=``deepseek-tools`` 的第一套（用户自己在界面加）
      3. 环境变量 ``DEEPSEEK_API_KEY``（复用同一个账号的 key，最省事）
    都没有 → None，上层据此降级或提示去配置。
    """
    import os

    env_key = (os.getenv("DEEPSEEK_TOOLS_API_KEY") or os.getenv("DEEPSEEK_API_KEY") or "").strip()
    if env_key:
        return Credential(api_key=env_key, base_url=(os.getenv("DEEPSEEK_BASE_URL") or DEFAULT_BASE).strip())

    # 工具调用方通常拿不到 API 请求的 DB 会话 —— 这里自己开一个短的，
    # 免得每个调用点都要把 session 一路传进来。
    if session is None:
        from .db import SessionLocal

        try:
            async with SessionLocal() as _own:
                return await resolve_credential(_own)
        except Exception:  # noqa: BLE001 —— 拿不到库就按"未配置"处理
            return None
    try:
        from sqlalchemy import select

        from .models import Secret
        from .security.crypto import decrypt

        # 先找专用凭据；没有再退到已有的 deepseek 模型凭据 ——
        # 同一个账号的 key 对模型和工具都有效，不该逼用户存第二份。
        row = (
            await session.execute(
                select(Secret).where(Secret.provider == "deepseek-tools").order_by(Secret.id).limit(1)
            )
        ).scalar_one_or_none()
        if row is None:
            row = (
                await session.execute(
                    select(Secret).where(Secret.provider == "deepseek").order_by(Secret.id).limit(1)
                )
            ).scalar_one_or_none()
        if row is None:
            return None
        base = (row.base_url or DEFAULT_BASE).strip().rstrip("/")
        if base.endswith("/v1"):      # 模型凭据常写 .../v1，工具端点是 /v1/tools/*
            base = base[:-3]
        return Credential(api_key=decrypt(row.ciphertext).strip(), base_url=base)
    except Exception:  # noqa: BLE001 —— 解析失败按未配置处理，不拖垮工具
        logger.debug("DeepSeek 工具凭据解析失败", exc_info=True)
        return None


# --------------------------------------------------------------------------- #
# 错误归一
# --------------------------------------------------------------------------- #
def _error_from(status: int, body: bytes, *, audio: bool = False) -> ToolsError:
    text = ""
    try:
        data = json.loads(body.decode("utf-8", "replace") or "{}")
        err = data.get("error") or {}
        text = str(err.get("message") or data.get("message") or "")
    except Exception:  # noqa: BLE001
        text = body.decode("utf-8", "replace")[:200]

    low = text.lower()
    if "password" in low:
        return ToolsError("bad_input", "文件有打开密码，请移除密码后重试。")
    if status == 402:
        return ToolsError("no_credit", "DeepSeek 账户余额不足。")
    if status == 413:
        return ToolsError("too_large", "文件超过官方大小限制。")
    if status == 408 or status == 504:
        return ToolsError("timeout", "上游超时（上传过慢或识别超时）。")
    if status == 429:
        return ToolsError("rate_limited", "上游并发已满。", retry_after=5)
    if status == 503:
        return ToolsError("busy", "上游繁忙。", retry_after=3)
    if status == 400:
        if audio:
            return ToolsError("too_long", text or "音频参数不被接受（需 16bit PCM WAV / Ogg Opus，≤120 秒）。")
        return ToolsError("bad_input", text or "请求参数不被接受。")
    return ToolsError("busy", text or f"上游返回 {status}。")


async def _request(
    method: str,
    path: str,
    cred: Credential,
    *,
    json_body: Any = None,
    data: Any = None,
    files: Any = None,
    timeout: float = 30.0,
    sem: asyncio.Semaphore | None = None,
    retries: int = 2,
    audio: bool = False,
) -> httpx.Response:
    """统一的请求壳：并发闸 + 503/504 退避重试 + 错误归一。"""
    url = cred.base_url.rstrip("/") + path
    headers = {"Authorization": f"Bearer {cred.api_key}"}
    delay = 0.6
    async with (sem or SEM_WEB):
        for attempt in range(retries + 1):
            try:
                async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
                    resp = await client.request(
                        method, url, headers=headers, json=json_body, data=data, files=files
                    )
            except httpx.TimeoutException as exc:
                if attempt >= retries:
                    raise ToolsError("timeout", f"请求超时（{timeout:.0f}s）") from exc
                await asyncio.sleep(delay)
                delay *= 2
                continue
            except httpx.HTTPError as exc:
                raise ToolsError("unavailable", f"连不上上游：{type(exc).__name__}") from exc

            if resp.status_code in (503, 504) and attempt < retries:
                await asyncio.sleep(delay)
                delay *= 2
                continue
            if resp.status_code >= 400:
                raise _error_from(resp.status_code, resp.content, audio=audio)
            return resp
    raise ToolsError("busy", "上游多次繁忙，已放弃。")


# --------------------------------------------------------------------------- #
# 五个能力
# --------------------------------------------------------------------------- #
async def search(
    cred: Credential,
    query: str,
    *,
    count: int = 8,
    need_content: bool = False,
    ori_question: str | None = None,
) -> tuple[list[dict[str, Any]], Usage]:
    """网页搜索。返回结构化结果（rerank_score/authority 是现成的质量信号）。"""
    started = time.perf_counter()
    body: dict[str, Any] = {"query": query[:128], "count": max(1, min(int(count), 50)), "need_content": bool(need_content)}
    if ori_question:
        body["ori_question"] = ori_question[:128]
    resp = await _request("POST", "/v1/tools/search", cred, json_body=body, timeout=20, sem=SEM_WEB)
    data = resp.json()
    results = data.get("results") or []
    usage = Usage(
        tool="search",
        unit_kind="call",
        units=1,
        latency_ms=int((time.perf_counter() - started) * 1000),
        extra={"returned": len(results)},
    )
    return results, usage


async def fetch(cred: Credential, url: str) -> tuple[dict[str, Any], Usage]:
    """抓取网页 → {title, content(Markdown)}。"""
    started = time.perf_counter()
    resp = await _request("POST", "/v1/tools/fetch", cred, json_body={"url": url}, timeout=30, sem=SEM_WEB)
    data = resp.json()
    usage = Usage(
        tool="fetch",
        unit_kind="call",
        units=1,
        latency_ms=int((time.perf_counter() - started) * 1000),
        extra={"chars": len(data.get("content") or "")},
    )
    return {"title": data.get("title") or "", "content": data.get("content") or ""}, usage


async def ocr(cred: Credential, filename: str, blob: bytes, *, purpose: str = "text_recognition") -> tuple[dict[str, Any], Usage]:
    """OCR：按页返回文本（rich_layout 时带坐标标记）。"""
    if len(blob) > LIMIT_OCR_BYTES:
        raise ToolsError("too_large", "文件超过 100MiB。")
    started = time.perf_counter()
    resp = await _request(
        "POST",
        "/v1/tools/ocr",
        cred,
        data={"purpose": purpose},
        files={"file": (filename, blob, "application/octet-stream")},
        timeout=180,
        sem=SEM_OCR,
        retries=0,          # 大文件重试代价高，失败让上层决定
    )
    data = resp.json()
    if data.get("error"):
        raise ToolsError("busy", str((data.get("error") or {}).get("message") or "OCR 失败"))
    pages = data.get("pages") or []
    usage = Usage(
        tool="ocr",
        unit_kind="page",
        units=float(data.get("page_count") or len(pages)),
        cost_cny=round(float(data.get("page_count") or len(pages)) / 1000 * PRICE_OCR_PER_1K_PAGE, 4),
        latency_ms=int((time.perf_counter() - started) * 1000),
        request_id=str(data.get("id") or ""),
    )
    return data, usage


async def asr(cred: Credential, filename: str, blob: bytes) -> tuple[dict[str, Any], Usage]:
    """语音识别：整段上传，返回 {text, duration_ms}。"""
    if len(blob) > LIMIT_ASR_BYTES:
        raise ToolsError("too_large", "音频超过 8MiB。")
    started = time.perf_counter()
    resp = await _request(
        "POST",
        "/v1/tools/asr",
        cred,
        files={"file": (filename, blob, "application/octet-stream")},
        timeout=120,
        sem=SEM_AUDIO,
        audio=True,
    )
    data = resp.json()
    seconds = float(data.get("duration_ms") or 0) / 1000
    usage = Usage(
        tool="asr",
        unit_kind="audio_second",
        units=round(seconds, 2),
        cost_cny=round(seconds / 3600 * PRICE_ASR_PER_HOUR, 5),
        latency_ms=int((time.perf_counter() - started) * 1000),
        request_id=str(data.get("request_id") or ""),
    )
    return data, usage


async def tts(
    cred: Credential,
    text: str,
    *,
    voice_id: str = "stella",
    fmt: str = "wav",
) -> tuple[bytes, Usage]:
    """语音合成：整段返回音频字节。"""
    body = (text or "").strip()
    if not body:
        raise ToolsError("bad_input", "没有可朗读的文本。")
    if len(body) > LIMIT_TTS_CHARS:
        body = body[:LIMIT_TTS_CHARS]
    started = time.perf_counter()
    resp = await _request(
        "POST",
        "/v1/tools/tts",
        cred,
        json_body={"text": body, "voice_id": voice_id, "format": fmt},
        timeout=90,
        sem=SEM_AUDIO,
        audio=True,
    )
    audio = resp.content
    if not audio:
        raise ToolsError("busy", "合成没有返回音频。")
    # 计费字符：汉字算 2，其余算 1
    chars = sum(2 if "\u4e00" <= ch <= "\u9fff" else 1 for ch in body)
    usage = Usage(
        tool="tts",
        unit_kind="tts_char",
        units=float(chars),
        cost_cny=round(chars / 10_000 * PRICE_TTS_PER_10K_CHAR, 4),
        latency_ms=int((time.perf_counter() - started) * 1000),
        extra={"bytes": len(audio), "voice": voice_id},
    )
    return audio, usage


def cache_key(text: str, voice_id: str, fmt: str) -> str:
    """合成结果的缓存键：同一句话同一个音色只花一次钱。"""
    return hashlib.sha256(f"{voice_id}|{fmt}|{text}".encode("utf-8")).hexdigest()[:16]


async def record_usage(usage: Usage, *, session_id: str = "", run_id: str = "", agent_id: str = "") -> None:
    """把一次调用记进 tool_usage（失败不影响工具本身）。"""
    try:
        from .db import SessionLocal
        from .models import ToolUsage, now_ms

        async with SessionLocal() as db:
            db.add(
                ToolUsage(
                    id=f"tu_{int(time.time() * 1000)}_{usage.tool}_{abs(hash(usage.request_id or usage.latency_ms)) % 10000}",
                    session_id=session_id,
                    run_id=run_id,
                    agent_id=agent_id,
                    tool=usage.tool,
                    unit_kind=usage.unit_kind,
                    units=usage.units,
                    cost_cny=usage.cost_cny,
                    latency_ms=usage.latency_ms,
                    request_id=usage.request_id,
                    created_at=now_ms(),
                )
            )
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.debug("工具用量记录失败（忽略）", exc_info=True)
