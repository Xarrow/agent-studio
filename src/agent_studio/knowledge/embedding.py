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

#: 与 tool_search 共用同一个 embedding 端点配置
EMBED_SETTING_KEY = "toolsearch_embedding"
#: 单次请求送多少块（多数 embedding 端点单请求上限 2048 token × N，16 块稳）
BATCH = 16
#: 单块送模型的字符上限（超长会 400，切一段够语义了）
MAX_CHARS = 2000


async def embed_config(session: AsyncSession) -> dict[str, Any]:
    """读出可用配置；没配就是 ``{"configured": False}``（界面据此提示去配置）。"""
    raw = await get_setting(session, EMBED_SETTING_KEY, None)
    conf: dict[str, Any] = {}
    if isinstance(raw, str) and raw.strip():
        try:
            conf = json.loads(raw)
        except json.JSONDecodeError:
            conf = {}
    elif isinstance(raw, dict):
        conf = raw
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
        "base_url": base_url,
        "model": model,
        "has_key": bool(api_key),
    }


async def _client_embed(base_url: str, api_key: str, model: str, texts: list[str]) -> list[list[float]]:
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


async def embed_document(session: AsyncSession, doc: Doc) -> dict[str, Any]:
    """把一份文档的全部分块向量化并落库。返回 {ok, chunks, dim, model} 或抛 RuntimeError。"""
    conf = await embed_config(session)
    if not conf["configured"]:
        raise RuntimeError("还没配置 embedding 端点（设置 → 模型与服务 → 向量化端点）")

    raw = await get_setting(session, EMBED_SETTING_KEY, None)
    conf_raw = json.loads(raw) if isinstance(raw, str) and raw.strip() else (raw or {})
    api_key = str(conf_raw.get("api_key") or "").strip()
    if not api_key:
        enc = conf_raw.get("api_key_enc")
        from ..security.crypto import decrypt

        api_key = decrypt(enc.encode() if isinstance(enc, str) else enc).strip()

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
            vecs = await _client_embed(conf["base_url"], api_key, conf["model"], texts)
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
    conf = await embed_config(session)
    if not conf["configured"]:
        return []
    raw = await get_setting(session, EMBED_SETTING_KEY, None)
    conf_raw = json.loads(raw) if isinstance(raw, str) and raw.strip() else (raw or {})
    api_key = str(conf_raw.get("api_key") or "").strip()
    if not api_key:
        enc = conf_raw.get("api_key_enc")
        from ..security.crypto import decrypt

        api_key = decrypt(enc.encode() if isinstance(enc, str) else enc).strip()
    try:
        qv = (await _client_embed(conf["base_url"], api_key, conf["model"], [query[:MAX_CHARS]]))[0]
    except Exception:  # noqa: BLE001 —— 检索不该因为端点抖动就 500
        logger.warning("查询向量失败（跳过向量路）", exc_info=True)
        return []
    q = array("f", qv)

    rows = (
        await session.execute(
            select(DocEmbedding, Doc, DocChunk)
            .join(Doc, Doc.id == DocEmbedding.doc_id)
            .join(DocChunk, (DocChunk.doc_id == DocEmbedding.doc_id) & (DocChunk.ord == DocEmbedding.ord))
            .where(DocEmbedding.model == conf["model"], Doc.deleted_at.is_(None))
            .limit(20000)
        )
    ).all()
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
