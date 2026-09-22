"""LLM 凭据管理 —— 多 Provider 的 Key 配置、测试与选用。

设计要点：
- **明文永不落库**：``ciphertext`` 用 Fernet 加密，列表接口只返回脱敏串
- **同 provider 可存多套**：例如 DeepSeek 主号 / 备用号，Agent 按 ref 选用
- **连通性测试**：复用 AgentScope 的 ``list_models()`` 真实打一次 provider 接口
"""

from __future__ import annotations

import inspect
import re
import time

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import Secret, now_ms
from ..providers import get_provider, list_providers, normalize_provider
from ..schemas import (
    CredentialCreate,
    CredentialRead,
    CredentialTestRequest,
    CredentialTestResult,
    CredentialUpdate,
    ProviderRead,
)
from ..security.crypto import decrypt, encrypt, mask

router = APIRouter(prefix="/api", tags=["credentials"])


# --------------------------------------------------------------------------- #
def to_read(row: Secret, plain: str | None = None) -> CredentialRead:
    """ORM → DTO。``plain`` 仅在有权限取明文时传入（用于生成脱敏串）。"""
    meta = get_provider(row.provider)
    return CredentialRead(
        id=row.id,
        name=row.name,
        provider=row.provider,
        provider_display=meta.display_name if meta else row.provider,
        base_url=row.base_url,
        masked_key=mask(plain) if plain else "••••••••",
        default_model=row.default_model,
        last_test_at=row.last_test_at,
        last_test_ok=bool(row.last_test_ok) if row.last_test_ok is not None else None,
        last_test_error=row.last_test_error,
        created_at=row.created_at,
    )


async def _get_or_404(session: AsyncSession, credential_id: str) -> Secret:
    row = await session.get(Secret, credential_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"凭据不存在: {credential_id}")
    return row


# --------------------------------------------------------------------------- #
# Provider 元数据
# --------------------------------------------------------------------------- #
@router.get("/providers", response_model=list[ProviderRead])
async def list_provider_meta() -> list[ProviderRead]:
    """支持的 provider 列表（前端据此渲染表单与模型下拉）。"""
    return [
        ProviderRead(
            name=p.name,
            display_name=p.display_name,
            default_base_url=p.default_base_url,
            models=p.models,
            requires_key=p.requires_key,
            allows_base_url=p.allows_base_url,
            docs_url=p.docs_url,
            note=p.note,
        )
        for p in list_providers()
    ]


# --------------------------------------------------------------------------- #
# 凭据 CRUD
# --------------------------------------------------------------------------- #
@router.get("/credentials", response_model=list[CredentialRead])
async def list_credentials(
    provider: str | None = None, session: AsyncSession = Depends(get_session)
) -> list[CredentialRead]:
    stmt = select(Secret).order_by(Secret.created_at.desc())
    if provider:
        stmt = stmt.where(Secret.provider == normalize_provider(provider))
    rows = (await session.execute(stmt)).scalars().all()
    return [to_read(r) for r in rows]


@router.post("/credentials", response_model=CredentialRead, status_code=status.HTTP_201_CREATED)
async def create_credential(
    payload: CredentialCreate, session: AsyncSession = Depends(get_session)
) -> CredentialRead:
    provider = normalize_provider(payload.provider)
    meta = get_provider(provider)
    if meta is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"不支持的 provider: {payload.provider}")
    if meta.requires_key and not payload.api_key.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{meta.display_name} 需要 api_key")

    dup = (
        await session.execute(select(Secret).where(Secret.name == payload.name))
    ).scalar_one_or_none()
    if dup is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, f"凭据名已存在: {payload.name}")

    base_url = payload.base_url or meta.default_base_url
    row = Secret(
        name=payload.name,
        provider=provider,
        base_url=base_url,
        ciphertext=encrypt(payload.api_key.strip()),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return to_read(row, payload.api_key.strip())


@router.put("/credentials/{credential_id}", response_model=CredentialRead)
async def update_credential(
    credential_id: str,
    payload: CredentialUpdate,
    session: AsyncSession = Depends(get_session),
) -> CredentialRead:
    row = await _get_or_404(session, credential_id)

    if payload.name is not None:
        new_name = payload.name.strip()
        if new_name and new_name != row.name:
            dup = (
                await session.execute(select(Secret).where(Secret.name == new_name))
            ).scalar_one_or_none()
            if dup is not None:
                raise HTTPException(status.HTTP_409_CONFLICT, f"凭据名已存在: {new_name}")
            row.name = new_name

    # provider 允许改（选错了可以纠正）；改了就把 base_url 归位到新 provider 默认值
    if payload.provider is not None:
        provider = normalize_provider(payload.provider)
        meta = get_provider(provider)
        if meta is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"不支持的 provider: {payload.provider}")
        if provider != row.provider:
            row.provider = provider
            if payload.base_url is None:
                row.base_url = meta.default_base_url

    if payload.base_url is not None:
        row.base_url = payload.base_url

    # 默认模型：空字符串表示"清空"，None 表示"不动"
    if payload.default_model is not None:
        row.default_model = payload.default_model.strip() or None

    plain = None
    if payload.api_key:                       # 留空则不改 key
        plain = payload.api_key.strip()
        row.ciphertext = encrypt(plain)
        # key 变了，历史测试结果作废
        row.last_test_at = row.last_test_ok = row.last_test_error = None
    await session.commit()
    await session.refresh(row)
    return to_read(row, plain)


@router.delete("/credentials/{credential_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_credential(
    credential_id: str, session: AsyncSession = Depends(get_session)
) -> None:
    row = await _get_or_404(session, credential_id)
    await session.delete(row)
    await session.commit()


# --------------------------------------------------------------------------- #
# 连通性测试
# --------------------------------------------------------------------------- #
async def _probe(provider: str, api_key: str, base_url: str | None, model_name: str | None):
    """真实探测：用 AgentScope 的 ``list_models()`` 打一次 provider 接口。

    返回 (ok, models, error, latency_ms)。
    """
    from ..runtimes.agentscope_rt.compile import build_model
    from ..schemas import ModelSpec

    started = time.perf_counter()
    try:
        spec = ModelSpec(provider=provider, name=model_name or "", base_url=base_url)
        model = build_model(spec, api_key)
    except Exception as exc:
        return False, [], f"构造模型失败: {type(exc).__name__}: {exc}", None

    fn = getattr(model, "list_models", None)
    if not callable(fn):
        return (
            True,
            [],
            "该 provider 不支持 list_models，已跳过探测（key 已保存）",
            int((time.perf_counter() - started) * 1000),
        )

    try:
        result = fn()
        if inspect.isawaitable(result):
            result = await result
        models: list[str] = []
        items = result if isinstance(result, (list, tuple)) else []
        for item in items:
            if isinstance(item, str):
                # AgentScope 可能返回对象的 repr，尝试提取 name='xxx'
                m = re.search(r"name='([^']+)'", item)
                models.append(m.group(1) if m else item[:60])
            elif isinstance(item, dict):
                models.append(str(item.get("id") or item.get("name") or item))
            else:
                models.append(str(getattr(item, "name", None) or getattr(item, "id", item)))
        latency = int((time.perf_counter() - started) * 1000)
        return True, models, None, latency
    except Exception as exc:
        latency = int((time.perf_counter() - started) * 1000)
        return False, [], f"{type(exc).__name__}: {exc}", latency
    finally:
        for attr in ("aclose", "close"):
            closer = getattr(model, attr, None)
            if callable(closer):
                try:
                    r = closer()
                    if inspect.isawaitable(r):
                        await r
                except Exception:
                    pass
                break


@router.post("/credentials/{credential_id}/test", response_model=CredentialTestResult)
async def test_credential(
    credential_id: str,
    payload: CredentialTestRequest | None = None,
    session: AsyncSession = Depends(get_session),
) -> CredentialTestResult:
    row = await _get_or_404(session, credential_id)
    meta = get_provider(row.provider)

    # 解密失败要**明确告知**，而不是抛 500。
    # 500 会绕过 CORSMiddleware（异常冒泡到最外层中间件），浏览器拿不到
    # 跨域头，于是把「配置损坏」误报成「CORS 错误」—— 排查方向直接被带偏。
    try:
        api_key = decrypt(row.ciphertext)
    except Exception:  # noqa: BLE001
        msg = (
            "这个配置的密钥解不开。通常是因为它由**另一个主密钥**加密写入的"
            "（例如测试或临时实例用 STUDIO_MASTER_KEY 覆盖后写进了同一个库）。"
            "请在下方重新填写 API Key 并保存。"
        )
        ts = now_ms()
        row.last_test_at = ts
        row.last_test_ok = 0
        row.last_test_error = msg
        await session.commit()
        return CredentialTestResult(
            ok=False, provider=row.provider, model=None, latency_ms=0,
            models=[], error=msg, checked_at=ts,
        )

    model_name = (payload.model if payload else None) or (meta.models[0] if meta and meta.models else "")

    ok, models, error, latency = await _probe(row.provider, api_key, row.base_url, model_name)

    row.last_test_at = now_ms()
    row.last_test_ok = 1 if ok else 0
    row.last_test_error = error
    await session.commit()

    return CredentialTestResult(
        ok=ok,
        provider=row.provider,
        model=model_name or None,
        latency_ms=latency,
        models=models[:50],
        error=error,
        checked_at=row.last_test_at,
    )


@router.get("/credentials/{credential_id}/models")
async def list_credential_models(
    credential_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """探测某个**已保存**凭据下可用的模型清单。

    与 ``/test`` 的区别：这里只为"让用户挑模型"，所以不写入测试结果、
    也不要求真实推理 —— 拿不到清单时把错误原文带回去，前端可以提示用户
    改用手动填写。
    """
    row = await _get_or_404(session, credential_id)
    try:
        api_key = decrypt(row.ciphertext)
    except Exception:  # noqa: BLE001
        return {
            "ok": False, "models": [], "current": row.default_model,
            "error": "这个配置的密钥解不开（可能由另一个主密钥加密）。请重新填写 API Key。",
        }

    meta = get_provider(row.provider)
    ok, models, error, latency = await _probe(
        row.provider, api_key, row.base_url, meta.models[0] if meta and meta.models else None
    )
    return {
        "ok": ok,
        "models": models,
        "current": row.default_model,
        "provider": row.provider,
        "suggested": list(meta.models) if meta else [],
        "latency_ms": latency,
        "error": error,
    }


@router.post("/credentials/probe", response_model=CredentialTestResult)
async def probe_inline(payload: CredentialCreate) -> CredentialTestResult:
    """**未保存**也能测：填完 key 先验证再保存。"""
    provider = normalize_provider(payload.provider)
    meta = get_provider(provider)
    if meta is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"不支持的 provider: {payload.provider}")

    model_name = meta.models[0] if meta.models else ""
    ok, models, error, latency = await _probe(
        provider, payload.api_key.strip(), payload.base_url or meta.default_base_url, model_name
    )
    return CredentialTestResult(
        ok=ok,
        provider=provider,
        model=model_name or None,
        latency_ms=latency,
        models=models[:50],
        error=error,
        checked_at=now_ms(),
    )
