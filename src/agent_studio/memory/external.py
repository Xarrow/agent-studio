"""外部记忆服务 —— 让平台挂上"别处已有的记忆库"，并让 Agent 能主动读写。

为什么要这一层
--------------
平台内置的记忆是**自持**的：SQLite + BM25 打分 + 提炼/衰减。它够用，但有两处天花板：
① 召回只有关键词（`embedding_status` 一直预留为 none，没接向量）；
② 记忆住在平台里 —— 用户在别处（比如自己的记忆网关、Mem0/ReMe 之类服务）已有的
   积累没法复用，反过来平台攒的记忆也带不走。

所以这里定义**一个尽可能小的 HTTP 契约**（两个端点、JSON 进出、Bearer 鉴权），
让外部服务只要照着实现就能接进来：既可以把外部当唯一记忆源，也可以和内置**混用**
（`hybrid`：两边各召回一批，按分数合并去重）。

契约（有意做得极其普通，任何语言半小时就能实现）
------------------------------------------------
搜索   ``POST {base_url}{search_path}``
       请求 ``{"query": "...", "top_k": 5, "agent_id": "..."}``
       响应 ``{"results": [{"content": "...", "score": 0.8, "id": "m1", "tags": ["x"]}]}``
              （``results`` 也可直接是字符串数组；``score`` 缺省按 0 处理）
新增   ``POST {base_url}{add_path}``
       请求 ``{"content": "...", "tags": ["x"], "agent_id": "..."}``
       响应 2xx 即可（``{"id": "..."}`` 可选）

鉴权：配了 key 就带 ``Authorization: Bearer <key>``；不配则不带（内网自持场景常见）。

配置存在平台设置表（``memory_external`` 一个 JSON），密钥用主密钥加密后存 ——
与凭据同一套做法，不落明文。
"""

from __future__ import annotations

import base64
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from ..security.crypto import decrypt, encrypt
from ..settings_store import get_setting, set_setting

logger = logging.getLogger(__name__)

#: 设置表里的键（一个 JSON 装全部，改起来原子）
SETTING_KEY = "memory_external"

DEFAULT_SEARCH_PATH = "/search"
DEFAULT_ADD_PATH = "/add"
DEFAULT_TIMEOUT_S = 15.0

#: 允许的召回来源（Agent 记忆策略里选）
BACKENDS = ("local", "external", "hybrid")


class ExternalMemoryError(RuntimeError):
    """外部记忆服务不可用 / 返回了看不懂的东西。"""


@dataclass(frozen=True)
class ExternalMemoryConfig:
    enabled: bool = False
    base_url: str = ""
    #: 明文 key（只在进程内流转；落库时加密）
    api_key: str = ""
    search_path: str = DEFAULT_SEARCH_PATH
    add_path: str = DEFAULT_ADD_PATH
    timeout_s: float = DEFAULT_TIMEOUT_S

    @property
    def ready(self) -> bool:
        return bool(self.enabled and self.base_url.strip())


@dataclass(frozen=True)
class ExternalMemoryItem:
    content: str
    score: float = 0.0
    id: str = ""
    tags: list[str] = field(default_factory=list)


def _normalize_path(path: str, fallback: str) -> str:
    p = (path or "").strip() or fallback
    return p if p.startswith("/") else "/" + p


def _url(cfg: ExternalMemoryConfig, path: str) -> str:
    return cfg.base_url.rstrip("/") + _normalize_path(path, DEFAULT_SEARCH_PATH)


def _headers(cfg: ExternalMemoryConfig) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if cfg.api_key:
        headers["Authorization"] = f"Bearer {cfg.api_key}"
    return headers


# --------------------------------------------------------------------------- #
# 配置读写
# --------------------------------------------------------------------------- #
async def load_config(session: AsyncSession) -> ExternalMemoryConfig:
    raw = await get_setting(session, SETTING_KEY, None)
    if not isinstance(raw, dict):
        return ExternalMemoryConfig()
    key = ""
    blob = raw.get("api_key_enc")
    if isinstance(blob, str) and blob:
        try:
            key = decrypt(base64.b64decode(blob))
        except Exception:  # noqa: BLE001 —— 换了主密钥就解不开：当作没配，不要炸
            logger.warning("外部记忆的密钥解不开（主密钥换过？），按未配置处理")
    return ExternalMemoryConfig(
        enabled=bool(raw.get("enabled")),
        base_url=str(raw.get("base_url") or ""),
        api_key=key,
        search_path=str(raw.get("search_path") or DEFAULT_SEARCH_PATH),
        add_path=str(raw.get("add_path") or DEFAULT_ADD_PATH),
        timeout_s=float(raw.get("timeout_s") or DEFAULT_TIMEOUT_S),
    )


async def save_config(
    session: AsyncSession,
    *,
    enabled: bool | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    search_path: str | None = None,
    add_path: str | None = None,
    timeout_s: float | None = None,
    clear_api_key: bool = False,
) -> ExternalMemoryConfig:
    """局部更新配置（只覆盖显式传入的字段）。密钥加密后存。"""
    current = await load_config(session)
    key = "" if clear_api_key else (api_key if api_key is not None else current.api_key)
    data: dict[str, Any] = {
        "enabled": current.enabled if enabled is None else bool(enabled),
        "base_url": current.base_url if base_url is None else base_url.strip(),
        "search_path": _normalize_path(
            search_path if search_path is not None else current.search_path, DEFAULT_SEARCH_PATH
        ),
        "add_path": _normalize_path(
            add_path if add_path is not None else current.add_path, DEFAULT_ADD_PATH
        ),
        "timeout_s": float(
            timeout_s if timeout_s is not None else current.timeout_s or DEFAULT_TIMEOUT_S
        ),
    }
    if key:
        data["api_key_enc"] = base64.b64encode(encrypt(key)).decode("ascii")
    await set_setting(session, SETTING_KEY, data)
    await session.commit()
    return await load_config(session)


# --------------------------------------------------------------------------- #
# 调用外部服务
# --------------------------------------------------------------------------- #
def _parse_results(payload: Any) -> list[ExternalMemoryItem]:
    """容忍三种常见形状：{results:[...]} / [...] / {"data":[...]}。"""
    rows: Any = payload
    if isinstance(payload, dict):
        rows = payload.get("results")
        if rows is None:
            rows = payload.get("data")
        if rows is None:
            rows = payload.get("memories")
    if not isinstance(rows, list):
        return []
    items: list[ExternalMemoryItem] = []
    for row in rows:
        if isinstance(row, str):
            items.append(ExternalMemoryItem(content=row))
        elif isinstance(row, dict):
            text = str(row.get("content") or row.get("text") or row.get("memory") or "").strip()
            if not text:
                continue
            try:
                score = float(row.get("score") or row.get("similarity") or 0.0)
            except (TypeError, ValueError):
                score = 0.0
            tags = row.get("tags") or row.get("labels") or []
            items.append(
                ExternalMemoryItem(
                    content=text,
                    score=score,
                    id=str(row.get("id") or ""),
                    tags=[str(t) for t in tags] if isinstance(tags, list) else [],
                )
            )
    return items


async def search(
    cfg: ExternalMemoryConfig,
    query: str,
    *,
    top_k: int = 5,
    agent_id: str | None = None,
    client: httpx.AsyncClient | None = None,
) -> list[ExternalMemoryItem]:
    """问外部记忆要 top_k 条。查询为空直接返回（省一次往返）。"""
    if not cfg.ready or not query.strip():
        return []
    url = _url(cfg, cfg.search_path)
    body = {"query": query, "top_k": max(1, int(top_k))}
    if agent_id:
        body["agent_id"] = agent_id
    own = client is None
    http = client or httpx.AsyncClient(timeout=cfg.timeout_s)
    try:
        resp = await http.post(url, json=body, headers=_headers(cfg))
        if resp.status_code >= 400:
            raise ExternalMemoryError(f"外部记忆搜索失败 HTTP {resp.status_code}：{resp.text[:200]}")
        return _parse_results(resp.json())
    except ExternalMemoryError:
        raise
    except Exception as exc:  # noqa: BLE001 —— 网络/JSON 都归成一句人话
        raise ExternalMemoryError(f"外部记忆搜索失败：{type(exc).__name__}: {exc}") from exc
    finally:
        if own:
            await http.aclose()


async def add(
    cfg: ExternalMemoryConfig,
    content: str,
    *,
    tags: list[str] | None = None,
    agent_id: str | None = None,
    client: httpx.AsyncClient | None = None,
) -> str:
    """往外部记忆写一条。返回外部给的 id（没有就空串）。"""
    if not cfg.ready:
        raise ExternalMemoryError("外部记忆未配置（或未启用）")
    text = (content or "").strip()
    if not text:
        raise ExternalMemoryError("内容为空，不写")
    body: dict[str, Any] = {"content": text, "tags": list(tags or [])}
    if agent_id:
        body["agent_id"] = agent_id
    own = client is None
    http = client or httpx.AsyncClient(timeout=cfg.timeout_s)
    try:
        resp = await http.post(_url(cfg, cfg.add_path), json=body, headers=_headers(cfg))
        if resp.status_code >= 400:
            raise ExternalMemoryError(f"外部记忆写入失败 HTTP {resp.status_code}：{resp.text[:200]}")
        try:
            data = resp.json()
        except Exception:  # noqa: BLE001 —— 2xx 就够了，body 不是 JSON 也认
            return ""
        return str((data or {}).get("id") or "") if isinstance(data, dict) else ""
    except ExternalMemoryError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ExternalMemoryError(f"外部记忆写入失败：{type(exc).__name__}: {exc}") from exc
    finally:
        if own:
            await http.aclose()


async def test_connection(cfg: ExternalMemoryConfig) -> dict[str, Any]:
    """「测试连接」：真发一次搜索（拿一个必然存在的词），把结果如实回报。"""
    if not cfg.base_url.strip():
        return {"ok": False, "detail": "还没填地址"}
    started = time.monotonic()
    try:
        items = await search(cfg, "test", top_k=1)
    except ExternalMemoryError as exc:
        return {"ok": False, "detail": str(exc), "ms": int((time.monotonic() - started) * 1000)}
    return {
        "ok": True,
        "detail": f"通了，返回 {len(items)} 条"
        + (f"（示例：{items[0].content[:60]}）" if items else "（这次没命中任何内容）"),
        "ms": int((time.monotonic() - started) * 1000),
    }


# --------------------------------------------------------------------------- #
# 与内置记忆合并（纯函数，好测）
# --------------------------------------------------------------------------- #
def _norm(text: str) -> str:
    return " ".join((text or "").lower().split())


def merge_items(
    local: list[tuple[str, float]], external: list[ExternalMemoryItem]
) -> list[tuple[str, float]]:
    """把内置命中和外部命中并起来：**同一句话只留一条**（取分高的位置），按分排序。"""
    # key（规范化）→ (原始正文, 分数)。**必须留着原始正文**：
    # 规范化只是用来判重，拿它当正文会把大小写、空格全改掉（注入的记忆就失真了）。
    merged: dict[str, tuple[str, float]] = {}
    for content, score in local:
        key = _norm(content)
        if not key:
            continue
        cur = merged.get(key)
        if cur is None or float(score) > cur[1]:
            merged[key] = (content, float(score))
    for item in external:
        key = _norm(item.content)
        if not key:
            continue
        # 外部分数与内置分数不是同一把尺子 —— 外部只用来"补位"，
        # 所以给它一个略低于同分内置命中的权重，避免把内部排序顶掉。
        score = float(item.score or 0.0) * 0.9
        cur = merged.get(key)
        if cur is None or score > cur[1]:
            merged[key] = (item.content.strip(), score)
    return sorted(merged.values(), key=lambda kv: kv[1], reverse=True)


def render(items: list[tuple[str, float]], *, source_tag: str = "") -> str:
    """渲染成注入文本（与内置 recall.render 同形，便于合并后统一渲染）。"""
    if not items:
        return ""
    head = "## 长期记忆（与本次任务相关）"
    if source_tag:
        head += f" · {source_tag}"
    lines = [head]
    for content, _score in items:
        lines.append(f"- {content}")
    return "\n".join(lines)


def budget(items: list[tuple[str, float]], max_chars: int) -> list[tuple[str, float]]:
    """字符预算裁剪：宁可少注入，也不撑爆上下文（与内置同一口径）。"""
    kept: list[tuple[str, float]] = []
    used = 0
    for content, score in items:
        cost = len(content) + 8
        if used + cost > max_chars:
            break
        kept.append((content, score))
        used += cost
    return kept


def dumps(cfg: ExternalMemoryConfig) -> dict[str, Any]:
    """给界面看的配置（**绝不回明文密钥**，只报"配没配"）。"""
    return {
        "enabled": cfg.enabled,
        "base_url": cfg.base_url,
        "search_path": cfg.search_path,
        "add_path": cfg.add_path,
        "timeout_s": cfg.timeout_s,
        "has_api_key": bool(cfg.api_key),
        "ready": cfg.ready,
    }


def _json_or_none(text: str) -> Any:  # pragma: no cover - 调试辅助
    try:
        return json.loads(text)
    except Exception:  # noqa: BLE001
        return None
