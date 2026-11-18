"""知识库的向量化：配置读取、批量 embed、存向量、暴力余弦检索。

为什么复用 tool_search 的配置键
================================
平台已经有一套「OpenAI 兼容 embedding 端点」的配置（``toolsearch_embedding``：
base_url / model / api_key，key 是 Fernet 密文）。知识库再开一套等于让用户填两遍，
所以读同一个键：配置一次，工具检索与知识检索同时受益。将来换 zvec 时，
这里只是「往哪写」变了，配置层不动。

一期为什么是暴力余弦
====================
几千到几万块正文的规模下，纯 Python + array 的点积在几十毫秒级，够用且零依赖；
规模上来再换 zvec（接口留了 ``search`` 这一层，替换只动实现不动调用方）。
"""

from __future__ import annotations

import json
import logging
import math
import struct
from array import array
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..settings_store import get_setting
from .models import Doc, DocChunk, DocEmbedding

logger = logging.getLogger(__name__)

#: 知识库自己的向量化配置（provider=local 时走本地 ONNX 模型，不需要 key）
EMBED_SETTING_KEY = "knowledge_embedding"
#: 回落：早期只有 tool_search 的 HTTP 配置，没单独配知识库就沿用它
FALLBACK_SETTING_KEY = "toolsearch_embedding"
#: 本地默认模型：中文小模型，512 维，约 95MB，纯 ONNX（不需要 torch）
LOCAL_DEFAULT_MODEL = "BAAI/bge-small-zh-v1.5"
#: 单次请求送多少块（多数 embedding 端点单请求上限 2048 token × N，16 块稳）
BATCH = 16
#: 单块送模型的字符上限（超长会 400，切一段够语义了）
MAX_CHARS = 2000


async def embed_config(session: AsyncSession) -> dict[str, Any]:
    """读出可用配置；没配就是 ``{"configured": False}``（界面据此提示去配置）。

    两档：``provider=local`` 用本地 ONNX 模型（无需 key、无需联网），
    否则按 OpenAI 兼容端点（base_url + model + key）。
    """
    raw = await get_setting(session, EMBED_SETTING_KEY, None)
    if not raw:
        raw = await get_setting(session, FALLBACK_SETTING_KEY, None)
    conf: dict[str, Any] = {}
    if isinstance(raw, str) and raw.strip():
        try:
            conf = json.loads(raw)
        except json.JSONDecodeError:
            conf = {}
    elif isinstance(raw, dict):
        conf = raw
    if str(conf.get("provider") or "").strip() == "local":
        model = str(conf.get("model") or LOCAL_DEFAULT_MODEL).strip() or LOCAL_DEFAULT_MODEL
        return {"configured": True, "provider": "local", "base_url": "", "model": model, "has_key": False}
    base_url = str(conf.get("base_url") or "").strip().rstrip("/")
    model = str(conf.get("model") or "").strip()
    api_key = str(conf.get("api_key") or "").strip()
    if not api_key:
        enc = conf.get("api_key_enc")
        if enc:
            try:
                from ..security.crypto import decrypt

                api_key = decrypt(enc.encode() if isinstance(enc, str) else enc).strip()
            except Exception:  # noqa: BLE001 —— 主密钥变了就当作没配
                api_key = ""
    return {
        "configured": bool(base_url and model and api_key),
        "provider": "http",
        "base_url": base_url,
        "model": model,
        "has_key": bool(api_key),
    }


#: 本地模型单例。加载一次约 0.4 秒、常驻约 200MB，别每个请求都建。
_LOCAL_MODELS: dict[str, Any] = {}
#: 本地推理的批大小。实测一次塞 200 条长文本峰值 3.5GB，分批 16 后压回 375MB。
LOCAL_BATCH = 16


def _local_cache_dir() -> str:
    """模型缓存目录：放在 data/work 下（跟数据一起备份），不能用临时目录。

    踩过的坑：fastembed 默认缓存到 TMPDIR，而 Hermes/系统清理会把 scratch 目录
    24 小时清掉 —— 第二天整个模型重新下 5 分钟。
    """
    from pathlib import Path as _Path

    from ..config import settings as _settings

    base = _Path(str(getattr(_settings, "work_dir", "data/work"))) / "models" / "fastembed"
    base.mkdir(parents=True, exist_ok=True)
    return str(base)


def _local_model(model: str):
    if model in _LOCAL_MODELS:
        return _LOCAL_MODELS[model]
    from fastembed import TextEmbedding  # 懒加载：没配本地模型的环境不需要这个依赖

    # threads=2：6GB 小机器上别让 onnxruntime 抢满 4 核（实测会拖慢同一台机器上的 API）
    inst = TextEmbedding(model, cache_dir=_local_cache_dir(), threads=2)
    _LOCAL_MODELS[model] = inst
    return inst


def _local_embed(model: str, texts: list[str]) -> list[list[float]]:
    inst = _local_model(model)
    out: list[list[float]] = []
    for i in range(0, len(texts), LOCAL_BATCH):
        for vec in inst.embed(texts[i : i + LOCAL_BATCH]):
            out.append([float(x) for x in vec])
    return out


async def _client_embed(
    base_url: str, api_key: str, model: str, texts: list[str], *, provider: str = "http"
) -> list[list[float]]:
    if provider == "local":
        import asyncio

        return await asyncio.to_thread(_local_embed, model, texts)

    import httpx

    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
        resp = await client.post(
            f"{base_url}/embeddings",
            headers={"Authorization": f"Bearer {api_key}"},
            json={"model": model, "input": texts},
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"{resp.status_code}: {resp.text[:200]}")
        data = resp.json().get("data") or []
        out = [d.get("embedding") for d in sorted(data, key=lambda x: x.get("index", 0))]
        if len(out) != len(texts):
            raise RuntimeError(f"向量条数不符：送了 {len(texts)}，回了 {len(out)}")
        return out


async def _resolve(session: AsyncSession) -> tuple[dict[str, Any], str]:
    """返回 (配置, api_key)。本地模型不需要 key。"""
    conf = await embed_config(session)
    if not conf["configured"] or conf.get("provider") == "local":
        return conf, ""
    raw = await get_setting(session, EMBED_SETTING_KEY, None) or await get_setting(
        session, FALLBACK_SETTING_KEY, None
    )
    conf_raw = json.loads(raw) if isinstance(raw, str) and raw.strip() else (raw or {})
    api_key = str(conf_raw.get("api_key") or "").strip()
    if not api_key:
        enc = conf_raw.get("api_key_enc")
        if enc:
            from ..security.crypto import decrypt

            api_key = decrypt(enc.encode() if isinstance(enc, str) else enc).strip()
    return conf, api_key


async def embed_document(session: AsyncSession, doc: Doc) -> dict[str, Any]:
    """把一份文档的全部分块向量化并落库。返回 {ok, chunks, dim, model} 或抛 RuntimeError。"""
    conf, api_key = await _resolve(session)
    if not conf["configured"]:
        raise RuntimeError("还没配置向量化方式（知识页流水线里选「本地模型」或填 API 端点）")
    provider = str(conf.get("provider") or "http")

    chunks = (
        await session.execute(
            select(DocChunk).where(DocChunk.doc_id == doc.id).order_by(DocChunk.ord)
        )
    ).scalars().all()
    if not chunks:
        raise RuntimeError("这份文档还没有解析文本，先等解析完成")

    doc.embed_status = "pending"
    await session.commit()

    from sqlalchemy import delete as _del

    await session.execute(_del(DocEmbedding).where(DocEmbedding.doc_id == doc.id))
    await session.commit()

    dim = 0
    done = 0
    try:
        for i in range(0, len(chunks), BATCH):
            batch = chunks[i : i + BATCH]
            texts = [(c.text or "")[:MAX_CHARS] or " " for c in batch]
            vecs = await _client_embed(
                conf["base_url"], api_key, conf["model"], texts, provider=provider
            )
            for c, v in zip(batch, vecs):
                dim = dim or len(v)
                session.add(
                    DocEmbedding(
                        doc_id=doc.id,
                        ord=c.ord,
                        dim=len(v),
                        model=conf["model"],
                        vec=struct.pack(f"<{len(v)}f", *v),
                    )
                )
                done += 1
            await session.commit()
    except Exception as exc:  # noqa: BLE001
        doc.embed_status = "failed"
        await session.commit()
        raise RuntimeError(str(exc)[:300]) from exc

    doc.embed_status = "ready"
    doc.embed_model = conf["model"]
    doc.embed_dim = dim
    await session.commit()
    return {"ok": True, "chunks": done, "dim": dim, "model": conf["model"]}


def _unpack(blob: bytes) -> array:
    arr = array("f")
    arr.frombytes(blob[: len(blob) - (len(blob) % 4)])
    return arr


def _cosine(a: array, b: array) -> float:
    n = min(len(a), len(b))
    dot = 0.0
    na = 0.0
    nb = 0.0
    for i in range(n):
        x = a[i]
        y = b[i]
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0 or nb <= 0:
        return 0.0
    return dot / math.sqrt(na * nb)


async def search_vector(
    session: AsyncSession, query: str, limit: int = 10
) -> list[dict[str, Any]]:
    """向量检索：返回按相似度排序的块。没配端点或没有向量就返回空（调用方退回 BM25）。"""
    conf, api_key = await _resolve(session)
    if not conf["configured"]:
        return []
    provider = str(conf.get("provider") or "http")
    try:
        qv = (
            await _client_embed(
                conf["base_url"], api_key, conf["model"], [query[:MAX_CHARS]], provider=provider
            )
        )[0]
    except Exception:  # noqa: BLE001 —— 检索不该因为端点抖动就 500
        logger.warning("查询向量失败（跳过向量路）", exc_info=True)
        return []
    q = array("f", qv)

    # 硬护栏：只比当前模型产出的向量。跨模型余弦是"静默错"——不报错、只是排序变随机，
    # 所以这里宁可查一次「库里到底有哪些模型」，把不一致说清楚。
    models = {
        r[0]
        for r in (
            await session.execute(select(DocEmbedding.model).distinct())
        ).all()
        if r[0]
    }
    if models and conf["model"] not in models:
        raise RuntimeError(
            f"已入库向量用的是 {', '.join(sorted(models))}，与当前配置 {conf['model']} 不一致；"
            "请用同一模型重建向量（流水线里点「重建向量」）"
        )

    rows = (
        await session.execute(
            select(DocEmbedding, Doc, DocChunk)
            .join(Doc, Doc.id == DocEmbedding.doc_id)
            .join(DocChunk, (DocChunk.doc_id == DocEmbedding.doc_id) & (DocChunk.ord == DocEmbedding.ord))
            .where(DocEmbedding.model == conf["model"], Doc.deleted_at.is_(None))
            .limit(20000)
        )
    ).all()
    if not rows:
        return []

    scored: list[tuple[float, DocEmbedding, Doc, DocChunk]] = []
    for emb, doc, chunk in rows:
        scored.append((_cosine(q, _unpack(emb.vec)), emb, doc, chunk))
    scored.sort(key=lambda x: x[0], reverse=True)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for score, _emb, doc, chunk in scored:
        if doc.id in seen:
            continue
        seen.add(doc.id)
        snippet = (chunk.text or "").replace("\n", " ")[:240]
        out.append(
            {
                "id": doc.id,
                "name": doc.name,
                "kind": doc.kind,
                "status": doc.status,
                "snippet": snippet,
                "page": chunk.page,
                "sheet": chunk.sheet,
                "updated_at": doc.updated_at,
                "score": round(score, 4),
                "matched_path": "vector",
            }
        )
        if len(out) >= limit:
            break
    return out
