"""LLM 凭据管理 —— 多 Provider 的 Key 配置、测试与选用。

设计要点：
- **明文永不落库**：``ciphertext`` 用 Fernet 加密，列表接口只返回脱敏串
- **同 provider 可存多套**：例如 DeepSeek 主号 / 备用号，Agent 按 ref 选用
- **连通性测试**：复用 AgentScope 的 ``list_models()`` 真实打一次 provider 接口
"""

from __future__ import annotations

import asyncio
import httpx
from typing import Any
import inspect
import re
import time

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import ModelTest, Secret, now_ms
from ..providers import get_provider, list_providers, normalize_provider
from ..schemas import (
    CredentialChatRequest,
    CredentialChatResult,
    CredentialCreate,
    CredentialDetectRequest,
    CredentialDetectResult,
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
    # 谁在用这条：删除会被拒绝，列表里就得先看得见（不然点下去才报错）
    from ..models import Agent as AgentRow

    used: dict[str, int] = {}
    used_names: dict[str, list[str]] = {}
    for _aid, _aname, defn in (
        await session.execute(select(AgentRow.id, AgentRow.name, AgentRow.definition))
    ).all():
        try:
            ref = (defn or {}).get("model", {}).get("credential_ref")
        except AttributeError:
            ref = None
        if ref:
            used[ref] = used.get(ref, 0) + 1
            used_names.setdefault(ref, []).append(_aname or _aid)
    out: list[CredentialRead] = []
    for r in rows:
        # masked_key 用真实 key 的头尾特征（原来列表不取明文，恒为固定 8 点，
        # 用户无法核对「这是哪把 key」）；密文解开只为做掩码，明文不出接口。
        masked = None
        try:
            masked = mask(decrypt(r.ciphertext))
        except Exception:  # noqa: BLE001 —— 解不开（主密钥变更）就保持 8 点
            masked = None
        item = to_read(r, masked)
        item.used_by = used.get(r.id, 0)
        item.used_by_names = used_names.get(r.id, [])[:5]
        out.append(item)
    return out


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
        default_model=(payload.default_model or "").strip(),
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


@router.get("/credentials/{credential_id}/key")
async def reveal_credential_key(
    credential_id: str, session: AsyncSession = Depends(get_session)
) -> dict:
    """查看某个配置的**明文 API Key**。

    为什么要有这个接口
    ------------------
    配置是加密存的，列表只给脱敏串 —— 这在"核对配置对不对""换机器要迁移"
    "手头 key 丢了要找回来"这些场景下不够用。所以提供一个显式查看入口。

    ⚠️ 安全边界（重要）
    -------------------
    这个接口**不做任何额外鉴权** —— 谁能访问 API，谁就能拿到明文 key。
    在内网可信的前提下没问题；但**一旦平台通过隧道暴露到公网且没有认证，
    它等于把所有 key 公开**。所以：
      · 如果有人要把它放到公网，必须先在前面加一层认证
        （如 Cloudflare Access），否则不要暴露。
    前端也在「显示」前加了确认步骤，避免误触发/肩窥。
    """
    row = await _get_or_404(session, credential_id)
    try:
        key = decrypt(row.ciphertext)
    except Exception:  # noqa: BLE001
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "这个配置的密钥解不开 —— 通常是由另一个主密钥加密写入的，"
            "请重新填写 API Key 并保存。",
        ) from None
    return {"id": row.id, "name": row.name, "api_key": key}


@router.delete("/credentials/{credential_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_credential(
    credential_id: str, session: AsyncSession = Depends(get_session)
) -> None:
    """删凭据。**被助手引用时拒绝** —— 一键删掉"钥匙"，那几个助手下次就全跑不了，
    而报错是「需要 api_key」，用户根本联想不到是刚才那次删除。"""
    row = await _get_or_404(session, credential_id)
    from ..models import Agent as AgentRow

    users: list[str] = []
    for aid, name, defn in (
        await session.execute(select(AgentRow.id, AgentRow.name, AgentRow.definition))
    ).all():
        try:
            ref = (defn or {}).get("model", {}).get("credential_ref")
        except AttributeError:
            ref = None
        if ref == credential_id:
            users.append(name or aid)
    if users:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"还有 {len(users)} 个助手在用这条配置（{', '.join(users[:5])}）。"
            "先给它们换一条，或删掉那些助手。",
        )
    await session.delete(row)
    await session.commit()


# --------------------------------------------------------------------------- #
# 连通性测试
# --------------------------------------------------------------------------- #
def _safe_json(resp: "httpx.Response") -> Any:
    """响应体尽量给出结构（JSON 优先），给不出就回文本 —— 原文要能读，不能抛。"""
    try:
        return resp.json()
    except Exception:  # noqa: BLE001
        try:
            return resp.text[:4000]
        except Exception:  # noqa: BLE001
            return "<响应体读不出来>"


def _err_of(resp: "httpx.Response") -> str:
    """从服务商返回体里抽出人话错误（OpenAI 兼容格式：error.message）。"""
    try:
        body = resp.json()
        if isinstance(body, dict):
            e = body.get("error")
            if isinstance(e, dict) and e.get("message"):
                return str(e["message"])
            if body.get("message"):
                return str(body["message"])
    except Exception:  # noqa: BLE001
        pass
    return (resp.text or "").strip()[:220] or f"HTTP {resp.status_code}"


async def _probe(
    provider: str, api_key: str, base_url: str | None, model_name: str | None
):
    """真实探测：直接打 provider 的 OpenAI 兼容接口，确认 key 到底能不能用。

    返回 (ok, models, error, latency_ms)。

    以前这里是调 AgentScope 的 ``list_models()``，**不可靠**：
      · 有些 provider 的 list_models() 只返回本地静态清单，压根不发请求 ——
        于是 key 早已失效，界面还报"测试通过"（实测延迟 2ms），
        用户配好了却跑不起来，排查方向全被带偏（真实踩过）
      · 有些 provider（如火山引擎方舟）根本没有 ``/models`` 接口

    现在两步都基于真实 HTTP：
      ① ``GET {base}/models``
         200            → 清单可信，key 已验证通过
         401/403        → key 无效，原样带回服务商的报错
         404/405/其他   → 该家不支持列模型，走 ②
      ② 用一次极小 chat 调用验证 key（``max_tokens=1``）
         这样"没有 /models 接口"的服务商也能真正验证，而不是假装成功。
    """
    base = (base_url or "").rstrip("/")
    meta = get_provider(provider)
    if not base:
        return False, [], f"{provider} 没有可用的 Base URL，请填写端点地址", None

    # Anthropic 的鉴权头与路径都和 OpenAI 兼容接口不同（``x-api-key`` + ``/v1/models``）：
    # 拿 Bearer 打过去必然 401，会让**有效的** Claude Key 被判成「密钥无效」——
    # 「粘贴即用」识别不出 Claude 就是这么来的（实测）。
    if meta is not None and meta.name == "anthropic":
        base = base if base.endswith("/v1") else f"{base}/v1"
        headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
    else:
        headers = {"Authorization": f"Bearer {api_key}"}
    started = time.perf_counter()

    def elapsed() -> int:
        return int((time.perf_counter() - started) * 1000)

    try:
        async with httpx.AsyncClient(timeout=25.0, follow_redirects=True) as client:
            # ── ① 试 /models ────────────────────────────────────────────
            try:
                r = await client.get(f"{base}/models", headers=headers)
            except Exception as exc:  # noqa: BLE001
                return False, [], f"连不上 {base}：{type(exc).__name__}: {exc}", elapsed()

            if r.status_code == 200:
                models: list[str] = []
                try:
                    data = r.json()
                    items = data.get("data") if isinstance(data, dict) else data
                    for it in items or []:
                        if isinstance(it, dict):
                            mid = it.get("id") or it.get("name")
                            if mid:
                                models.append(str(mid))
                        elif isinstance(it, str):
                            models.append(it)
                except Exception:  # noqa: BLE001
                    pass
                return True, models, None, elapsed()

            if r.status_code in (401, 403):
                return (
                    False,
                    [],
                    f"密钥无效（HTTP {r.status_code}）：{_err_of(r)}",
                    elapsed(),
                )

            # ── ② 该家不支持列模型 → 用极小 chat 调用验证 key ──────────
            model = model_name
            if not model and meta and meta.models:
                model = meta.models[0]
            if not model:
                return (
                    False,
                    [],
                    f"该服务商不支持列出模型（HTTP {r.status_code}），"
                    "且没有可用的默认模型 —— 请先选好模型再测试。",
                    elapsed(),
                )

            try:
                r2 = await client.post(
                    f"{base}/chat/completions",
                    headers={**headers, "Content-Type": "application/json"},
                    json={
                        "model": model,
                        "messages": [{"role": "user", "content": "hi"}],
                        "max_tokens": 1,
                    },
                )
            except Exception as exc:  # noqa: BLE001
                return False, [], f"调用失败：{type(exc).__name__}: {exc}", elapsed()

            if r2.status_code == 200:
                # 通了，但这家不提供模型清单 —— 返回空清单，前端用推荐清单兜底
                return True, [], None, elapsed()
            if r2.status_code in (401, 403):
                return (
                    False,
                    [],
                    f"密钥无效（HTTP {r2.status_code}）：{_err_of(r2)}",
                    elapsed(),
                )
            return (
                False,
                [],
                f"HTTP {r2.status_code}（模型 {model}）：{_err_of(r2)}",
                elapsed(),
            )
    except Exception as exc:  # noqa: BLE001
        return False, [], f"{type(exc).__name__}: {exc}", elapsed()



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

    # 模型优先级：显式指定 > 凭据自己配的默认模型 > provider 推荐清单的第一个
    # （原来漏了中间那档，导致用户明明配好了模型，测试却拿 provider 的默认模型去打）
    model_name = (
        (payload.model if payload else None)
        or row.default_model
        or (meta.models[0] if meta and meta.models else None)
    )

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


async def _record_model_test(
    session: AsyncSession,
    row: Secret,
    *,
    model: str,
    base_url: str,
    messages: list[dict],
    reply: str | None,
    status: str,
    error: str | None,
    latency_ms: int,
    usage: dict | None,
    request: dict | None = None,
    response: Any = None,
) -> None:
    """把一次「对话测试」写进 llm 测试记录。

    为什么必须落库
    --------------
    这是**唯一**一次"裸模型调用"的实测证据：换了 key / 端点 / 模型之后，
    下次出问题时要能回头看"上次是通过还是不通过、报的什么错"。
    只留在页面上就等于没有 —— 刷新就没了。

    注意：写失败不能影响返回值 —— 记录是旁路，测通了就该告诉用户测通了。
    """
    usage = usage or {}
    # 原文：请求体 + 原始响应，压缩后落库（体积上限沿用模型调用那套设置）
    req_blob: dict[str, Any] = {}
    try:
        from ..runner import compress_payload

        if request is not None:
            req_raw, req_trunc = compress_payload(request)
            req_blob["request_blob"] = req_raw
        if response is not None:
            resp_raw, resp_trunc = compress_payload(response)
            req_blob["response_blob"] = resp_raw
            if req_trunc or resp_trunc:
                req_blob["payload_truncated"] = 1
    except Exception:  # noqa: BLE001 —— 原文是旁路，压不动也不该影响记录
        req_blob = {}
    try:
        session.add(
            ModelTest(
                credential_id=row.id,
                credential_name=row.name,
                provider=row.provider,
                base_url=base_url,
                model=model,
                messages=messages,
                reply=reply,
                status=status,
                error=error,
                duration_ms=latency_ms,
                tokens_in=int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0),
                tokens_out=int(
                    usage.get("completion_tokens") or usage.get("output_tokens") or 0
                ),
                **req_blob,
            )
        )
        await session.commit()
    except Exception:  # noqa: BLE001
        await session.rollback()


CHAT_ENDPOINT_FAIL = "这条配置暂时没法试聊"


@router.post("/credentials/{credential_id}/chat", response_model=CredentialChatResult)
async def chat_with_credential(
    credential_id: str,
    payload: CredentialChatRequest,
    session: AsyncSession = Depends(get_session),
) -> CredentialChatResult:
    """用这条凭据**直接跑一段对话** —— 完全不经过 Agent。

    为什么要跟"Agent 试跑"分开
    -------------------------
    配好一个模型要验证两件独立的事：
      ① 这把 key + 这个端点 + 这个模型，能不能正常对话？
      ② 这个助手的提示词/工具/记忆配得对不对？
    混在一起测的话，一旦报错你分不清是①还是② —— 得先去建助手才能验证①，
    而建助手又依赖①。分开之后，①在「LLM 配置」里当场就能确认。

    与 ``/test`` 的区别：``/test`` 只探端点连通性（一次极小调用）；
    这里是把真实的多轮对话发过去、把回复取回来。
    """
    row = await _get_or_404(session, credential_id)
    meta = get_provider(row.provider)

    try:
        api_key = decrypt(row.ciphertext)
    except Exception:  # noqa: BLE001
        return CredentialChatResult(
            ok=False,
            error="这个配置的密钥解不开（可能由另一个主密钥加密）。请重新填写 API Key 并保存。",
        )

    model = payload.model or row.default_model or (meta.models[0] if meta and meta.models else None)
    if not model:
        return CredentialChatResult(
            ok=False, error="还没有选模型。先点「编辑」选一个默认模型，或在上面手动指定。"
        )

    base = (row.base_url or "").rstrip("/")
    if not base:
        return CredentialChatResult(ok=False, error=f"{row.provider} 没有可用的 Base URL")

    msgs = [m.model_dump() for m in payload.messages] or [
        {"role": "user", "content": "你好"}
    ]

    # 原始请求体（排障要看的就是它：把什么参数发给了谁）
    req_body: dict[str, Any] = {"model": model, "messages": msgs, "stream": False}
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
            resp = await client.post(
                f"{base}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=req_body,
            )
        latency = int((time.perf_counter() - started) * 1000)

        if resp.status_code != 200:
            msg = f"HTTP {resp.status_code}：{_err_of(resp)}"
            await _record_model_test(
                session, row, model=model, base_url=base, messages=msgs,
                reply=None, status="error", error=msg, latency_ms=latency, usage=None,
                request=req_body,
                # 失败现场最需要原件：状态码 + 响应头 + 响应体都留下
                response={
                    "status": resp.status_code,
                    "headers": dict(resp.headers),
                    "body": _safe_json(resp),
                },
            )
            return CredentialChatResult(ok=False, model=model, latency_ms=latency, error=msg)

        data = resp.json()
        reply = ""
        try:
            reply = data["choices"][0]["message"]["content"] or ""
        except Exception:  # noqa: BLE001
            reply = ""
        if not reply:
            return CredentialChatResult(
                ok=False, model=model, latency_ms=latency,
                error=f"拿到了响应但没有正文：{str(data)[:200]}",
            )
        usage = data.get("usage") if isinstance(data, dict) else None
        usage = usage if isinstance(usage, dict) else None
        await _record_model_test(
            session, row, model=model, base_url=base, messages=msgs,
            reply=reply, status="ok", error=None, latency_ms=latency, usage=usage,
            request=req_body, response=data,
        )
        return CredentialChatResult(
            ok=True, model=model, reply=reply, latency_ms=latency, usage=usage,
        )
    except Exception as exc:  # noqa: BLE001
        await _record_model_test(
            session, row, model=model, base_url=base, messages=msgs,
            reply=None, status="error", error=f"{type(exc).__name__}: {exc}",
            latency_ms=int((time.perf_counter() - started) * 1000), usage=None,
            request=req_body, response={"error": f"{type(exc).__name__}: {exc}"},
        )
        return CredentialChatResult(
            ok=False, model=model,
            latency_ms=int((time.perf_counter() - started) * 1000),
            error=f"{type(exc).__name__}: {exc}",
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
        row.provider,
        api_key,
        row.base_url,
        row.default_model or (meta.models[0] if meta and meta.models else None),
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


# --------------------------------------------------------------------------- #
# 粘贴即用：只给 Key，认出服务商 + 验证 + 拿到模型清单
# --------------------------------------------------------------------------- #
#: 探测顺序（并行跑，谁先通过就优先它；前缀只用来决定"同分时信谁"，
#: 不做硬推断 —— ``sk-`` 在 OpenAI / DeepSeek / 火山之间是重复的）
_KEY_HINTS: list[tuple[str, str]] = [
    ("sk-ant-", "anthropic"),
    ("sk-proj-", "openai"),
    ("AIza", "gemini"),
]

_DETECT_ORDER = ["deepseek", "openai", "dashscope", "moonshot", "xai", "anthropic", "volcengine"]


def _detect_order(api_key: str, provider: str | None) -> list[str]:
    if provider:
        return [normalize_provider(provider)]
    hinted = [name for prefix, name in _KEY_HINTS if api_key.startswith(prefix)]
    rest = [name for name in _DETECT_ORDER if name not in hinted]
    return hinted + rest


def _effective_base(meta: Any, override: str | None) -> str | None:
    """探测/入库用同一个端点：Anthropic 要带 ``/v1``（它的模型清单在 ``/v1/models``）。"""
    base = (override or meta.default_base_url or "").rstrip("/")
    if not base:
        return None
    if meta.name == "anthropic" and not base.endswith("/v1"):
        base = f"{base}/v1"
    return base


def _human_reason(display: str, error: str | None) -> str:
    """把探测失败翻成人话 + 下一步（后端原文只留在 tried[].detail 里）。"""
    text = (error or "").strip()
    if re.search(r"HTTP 40[13]", text):
        return f"这个 Key 没通过 {display} 验证（密钥无效）。检查是否复制完整，或从下拉里改选服务商。"
    if text.startswith("连不上"):
        return f"连不上 {display} 的接口（网络或代理问题）。可以稍后重试，或从下拉里改选服务商。"
    return f"{display} 没有接受这个 Key。检查 Key 是否正确，或从下拉里改选服务商。"


@router.post("/credentials/detect", response_model=CredentialDetectResult)
async def detect_credential(payload: CredentialDetectRequest) -> CredentialDetectResult:
    """粘贴 API Key → 认出服务商 → 验证 → 给出可选模型。

    为什么不是「从 Key 前缀推断」：``sk-`` 在 OpenAI / DeepSeek / 火山之间
    完全一样，猜错比让用户点一下更糟。这里**真的逐个试探**（默认端点 + 该家
    首个模型发一次极小调用），通过的才算认出来；都不通过就把人话原因带回去，
    并允许用户从下拉改选（``provider`` 参数）。
    """
    key = (payload.api_key or "").strip()

    # 用户点名了服务商，而这家根本没有可自动验证的接口（不需要 Key / 没默认端点）：
    # 硬拿 OpenAI 兼容探针去试只会把好 Key 判成坏 Key。直接说清，让他选模型保存。
    # 放在「Key 太短」之前：Ollama 这种压根不用 Key 的服务商不该被要求粘贴。
    if payload.provider:
        only = get_provider(payload.provider)
        if only is not None and (not only.requires_key or not (payload.base_url or only.default_base_url)):
            if only.requires_key and not key:
                return CredentialDetectResult(
                    ok=False, provider=only.name, display_name=only.display_name, reason="先粘贴 API Key。"
                )
            return CredentialDetectResult(
                ok=False,
                provider=only.name,
                display_name=only.display_name,
                suggested=list(only.models),
                reason=(
                    f"{only.display_name} 不需要 API Key：直接选一个模型保存就行。"
                    if not only.requires_key
                    else f"{only.display_name} 没有可自动验证的接口：Key 会原样保存，保存后用一次对话确认能通。"
                ),
            )

    if len(key) < 8:
        return CredentialDetectResult(
            ok=False, reason="先把 API Key 粘贴完整（太短了，看起来只复制了一半）。"
        )

    order = _detect_order(key, payload.provider)
    metas = [p for p in (get_provider(name) for name in order) if p is not None and p.requires_key]

    async def _one(meta):
        model = meta.models[0] if meta.models else ""
        try:
            return meta, await asyncio.wait_for(
                _probe(meta.name, key, _effective_base(meta, payload.base_url), model), timeout=9
            )
        except asyncio.TimeoutError:
            return meta, (False, [], "连不上（超时）", None)
        except Exception as exc:  # noqa: BLE001 —— 一家炸了不影响别家
            return meta, (False, [], f"连不上：{type(exc).__name__}", None)

    # 并行试探，**第一家认出来就返回**：剩下的不用等（用户不该为了一个哈希前缀
    # 相同的 Key 盯着 9 秒转圈）。返回顺序因此按"谁先认出来"，而不是表格顺序。
    tasks = [asyncio.create_task(_one(m)) for m in metas]
    results: list[tuple[Any, tuple]] = []
    hit: tuple[Any, tuple] | None = None
    try:
        for fut in asyncio.as_completed(tasks):
            meta, res = await fut
            results.append((meta, res))
            if res[0]:
                hit = (meta, res)
                break
    finally:
        for t in tasks:
            t.cancel()

    tried = [
        {
            "provider": meta.name,
            "display_name": meta.display_name,
            "ok": bool(ok),
            "detail": (err or "")[:300],
        }
        for meta, (ok, _models, err, _lat) in results
    ]

    if hit is not None:
        meta, (ok, models, _err, latency) = hit
        clean = [str(m) for m in models if str(m).strip()]
        return CredentialDetectResult(
            ok=True,
            provider=meta.name,
            display_name=meta.display_name,
            base_url=_effective_base(meta, payload.base_url),
            models=clean[:200],
            suggested=[] if clean else list(meta.models),
            latency_ms=latency,
            reason=f"✓ 连上了 {meta.display_name}" + (f"，有 {len(clean)} 个模型可选" if clean else "，这家不列模型（下面给推荐清单）"),
            tried=tried,
        )

    # 都没通过：优先拿「密钥无效」这类确定性的原因，其次才是网络
    bad = [r for r in results if not r[1][0] and re.search(r"HTTP 40[13]", r[1][2] or "")]
    if bad:
        names = "、".join(m.display_name for m, _ in bad)
        reason = _human_reason(names, bad[0][1][2])
    elif results:
        names = "、".join(m.display_name for m, _ in results[:3]) + ("等" if len(results) > 3 else "")
        reason = f"试过 {names}，都没连上（网络或代理问题）。可以稍后重试，或从下拉里改选服务商。"
    else:
        reason = "没有可试的服务商，请从下拉里选一家。"
    return CredentialDetectResult(ok=False, reason=reason, tried=tried)


@router.post("/credentials/probe", response_model=CredentialTestResult)
async def probe_inline(payload: CredentialCreate) -> CredentialTestResult:
    """**未保存**也能测：填完 key 先验证再保存。"""
    provider = normalize_provider(payload.provider)
    meta = get_provider(provider)
    if meta is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"不支持的 provider: {payload.provider}")

    # 用户手填的模型优先（服务商没有清单时这是唯一被测的模型 ✓）；没填就退回 provider 推荐的首个
    model_name = (payload.default_model or "").strip() or (meta.models[0] if meta.models else "")
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
