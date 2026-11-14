"""远程技能来源的 HTTP 接口。

约定了三件事：
1. 预览（``/api/skills/remote/scan``）和安装（``/api/skills/remote/install``）都返回
   **同一份 ref/meta**，界面可以对着看"将要装什么、从哪来"；
2. 来源（SourceDef）的读写与浏览/测试在这里，凭据永不出现在响应里；
3. 检查更新与更新分离：检查只读，更新才落库。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import now_ms
from ..skill_sources import service
from ..skill_sources.netpolicy import NetPolicy
from ..skill_sources.parser import SourceError, parse_source
from ..skill_sources.store import (
    SkillSource,
    SourceInput,
    create_source,
    get_source,
    list_sources,
    public,
    update_source,
)
from ..settings_store import get_setting, set_setting

router = APIRouter(tags=["skill-sources"])

MODE_KEY = "skills_mode"
PIN_KEY = "skills_npx_pin"
LATEST_KEY = "skills_npx_latest"
NET_KEY = "skills_net_policy"
PLATFORMS_KEY = "skills_platforms"
CHECK_INTERVAL_KEY = "skills_check_interval_h"


class SourceBody(BaseModel):
    name: str = ""
    kind: str = "git"
    address: str = ""
    ref: str = ""
    subpath: str = ""
    enabled: bool = True
    priority: int = 100
    token: str = ""
    net_policy: dict[str, Any] | None = None
    tags: list[str] = []
    note: str = ""


class RemoteRequest(BaseModel):
    ref: str | None = None
    command: str | None = None        # 整条 `npx skills add …` 也吃
    paths: list[str] | None = None
    skills: list[str] | None = None
    ref_pin: str | None = None
    dry_run: bool = False


class SettingsBody(BaseModel):
    mode: str | None = None
    npx_pin: str | None = None
    allow_latest: bool | None = None
    net_policy: dict[str, Any] | None = None
    platforms: list[dict[str, Any]] | None = None
    check_interval_h: float | None = None


def _raw_of(payload: RemoteRequest) -> str:
    if payload.ref:
        return payload.ref
    if payload.command:
        # 允许直接粘 `npx skills add owner/repo --skill x`：只取引用部分
        from ..skills_repo import parse_skills_cmd

        cmd = parse_skills_cmd(payload.command)
        if cmd and cmd.ref:
            return cmd.ref
        raise HTTPException(400, "命令里没找到仓库引用")
    raise HTTPException(400, "需要 ref 或 command")


# --------------------------------------------------------------------------- #
# 解析预览
# --------------------------------------------------------------------------- #
@router.get("/api/skills/parse")
async def parse_only(q: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    rows = await list_sources(session)
    try:
        ref = parse_source(q, sources=rows)
    except SourceError as exc:
        return {"ok": False, "code": exc.code, "message": str(exc), "hint": exc.hint}
    mode, reason = await service.choose_mode(session)
    return {"ok": True, "ref": ref.to_dict(), "mode": mode, "mode_reason": reason}


@router.post("/api/skills/remote/scan")
async def scan_remote(payload: RemoteRequest, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    raw = _raw_of(payload)
    try:
        ref, entries, meta = await service.load_skills(
            session, raw, ref_override=payload.ref_pin or None
        )
    except SourceError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{exc.code}: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        code = getattr(exc, "code", "fetch_failed")
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"{code}: {exc}") from exc
    mode, reason = await service.choose_mode(session)
    return {
        "ref": ref.to_dict(),
        "meta": meta,
        "mode": mode,
        "mode_reason": reason,
        "skills": [e.brief(show_internal=True) for e in entries],
    }


@router.post("/api/skills/remote/install", status_code=status.HTTP_201_CREATED)
async def install_remote(payload: RemoteRequest, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    raw = _raw_of(payload)
    try:
        out = await service.install(
            session,
            raw,
            skills=payload.skills,
            paths=payload.paths,
            ref_override=payload.ref_pin or None,
            dry_run=payload.dry_run,
        )
    except SourceError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{exc.code}: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        code = getattr(exc, "code", "fetch_failed")
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"{code}: {exc}") from exc
    return out


# --------------------------------------------------------------------------- #
# 来源登记
# --------------------------------------------------------------------------- #
@router.get("/api/skill-sources")
async def sources_list(session: AsyncSession = Depends(get_session)) -> list[dict[str, Any]]:
    return [public(r) for r in await list_sources(session)]


@router.post("/api/skill-sources", status_code=status.HTTP_201_CREATED)
async def sources_create(body: SourceBody, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    try:
        ref = parse_source(body.address)
    except SourceError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{exc.code}: {exc}") from exc
    if ref.kind == "git" and not ref.host:
        raise HTTPException(400, "通用 git 地址需要完整 URL（含主机名）")
    data = SourceInput(
        name=body.name,
        kind="local" if ref.kind == "local" else body.kind,
        address=body.address,
        ref=body.ref or (ref.ref or ""),
        subpath=body.subpath or (ref.subpath or ""),
        enabled=body.enabled,
        priority=body.priority,
        token=body.token,
        net_policy=body.net_policy,
        tags=body.tags,
        note=body.note,
    )
    row = await create_source(session, data, host=ref.host, owner=ref.owner, repo=ref.repo)
    await session.commit()
    return public(row)


@router.put("/api/skill-sources/{sid}")
async def sources_update(sid: str, body: SourceBody, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    row = await get_source(session, sid)
    if row is None:
        raise HTTPException(404, "来源不存在")
    data = SourceInput(
        name=body.name,
        kind=body.kind,
        address=body.address,
        ref=body.ref,
        subpath=body.subpath,
        enabled=body.enabled,
        priority=body.priority,
        token=body.token,
        net_policy=body.net_policy,
        tags=body.tags,
        note=body.note,
    )
    await update_source(session, row, data)
    await session.commit()
    return public(row)


@router.delete("/api/skill-sources/{sid}", status_code=status.HTTP_204_NO_CONTENT)
async def sources_delete(sid: str, session: AsyncSession = Depends(get_session)) -> None:
    row = await get_source(session, sid)
    if row is None:
        raise HTTPException(404, "来源不存在")
    await session.delete(row)
    await session.commit()


@router.post("/api/skill-sources/{sid}/test")
async def sources_test(sid: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    row = await get_source(session, sid)
    if row is None:
        raise HTTPException(404, "来源不存在")
    host = row.host or row.address.split("//")[-1].split("/")[0]
    return await service.doctor(session, host or "github.com", source=row)


@router.post("/api/skill-sources/{sid}/browse")
async def sources_browse(sid: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    row = await get_source(session, sid)
    if row is None:
        raise HTTPException(404, "来源不存在")
    try:
        return await service.browse_source(session, row)
    except SourceError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{exc.code}: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        code = getattr(exc, "code", "fetch_failed")
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"{code}: {exc}") from exc


# --------------------------------------------------------------------------- #
# 两级视图：来源 → 技能
# --------------------------------------------------------------------------- #
@router.get("/api/skills/grouped")
async def grouped(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """按仓库来源聚合的列表（父=来源，子=技能）。界面默认用它，平铺视图仍用 /api/skills。"""
    groups = await service.grouped_skills(session)
    return {"groups": groups, "total": sum(g["counts"]["installed"] for g in groups)}


@router.post("/api/skill-sources/adopt")
async def adopt(body: dict, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    repo = str(body.get("repo") or "").strip()
    if not repo:
        raise HTTPException(400, "需要 repo")
    try:
        return await service.adopt_legacy_source(session, repo)
    except SourceError as exc:
        raise HTTPException(400, f"{exc.code}: {exc}") from exc


@router.post("/api/skill-sources/{sid}/check")
async def source_check(sid: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    try:
        return await service.check_source(session, sid)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/api/skill-sources/{sid}/sync")
async def source_sync(sid: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    try:
        return await service.sync_source(session, sid)
    except (ValueError, SourceError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        code = getattr(exc, "code", "fetch_failed")
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"{code}: {exc}") from exc


@router.post("/api/skill-sources/{sid}/uninstall")
async def source_uninstall(sid: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return await service.uninstall_source(session, sid)


@router.post("/api/skill-sources/{sid}/state")
async def source_state(sid: str, body: dict, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """整组启用/停用：把该来源下所有技能的状态一起切（active / archived）。"""
    from ..models import Skill

    want = str(body.get("state") or "active")
    if want not in ("active", "archived"):
        raise HTTPException(400, "state 只能是 active / archived")
    rows = list((await session.execute(select(Skill))).scalars())
    hit = [sk for sk in rows if (sk.source or {}).get("source_id") == sid]
    for sk in hit:
        sk.state = want
        sk.archived_at = now_ms() if want == "archived" else None
    await session.commit()
    return {"source_id": sid, "state": want, "count": len(hit)}


# --------------------------------------------------------------------------- #
# 检查更新 / 更新 / 诊断 / 设置
# --------------------------------------------------------------------------- #
@router.get("/api/skills/updates")
async def list_updates(force: bool = False, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    items = await service.check_updates(session, force=force)
    return {
        "items": items,
        "has_updates": [i for i in items if i.get("has_update")],
        "mode": (await service.choose_mode(session))[0],
    }


@router.post("/api/skills/{skill_id}/update")
async def update_one(skill_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    try:
        return await service.update_skill(session, skill_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/api/skills/doctor")
async def doctor_view(host: str = "github.com", session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return await service.doctor(session, host)


@router.get("/api/skills/remote/settings")
async def get_remote_settings(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    policy = NetPolicy.from_settings(await get_setting(session, NET_KEY, {}) or {})
    return {
        "mode": str(await get_setting(session, MODE_KEY, "auto") or "auto"),
        "npx_pin": str(await get_setting(session, PIN_KEY, "") or ""),
        "allow_latest": bool(await get_setting(session, LATEST_KEY, False)),
        "net_policy": policy.public_dict(),
        "platforms": await get_setting(session, PLATFORMS_KEY, []) or [],
        "check_interval_h": float(await get_setting(session, CHECK_INTERVAL_KEY, 6) or 6),
        "env": service.probe_environment(),
        "effective_mode": (await service.choose_mode(session)),
    }


@router.put("/api/skills/remote/settings")
async def put_remote_settings(body: SettingsBody, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    if body.mode is not None:
        if body.mode not in ("auto", "npx", "native"):
            raise HTTPException(400, "mode 只能是 auto / npx / native")
        await set_setting(session, MODE_KEY, body.mode)
    if body.npx_pin is not None:
        await set_setting(session, PIN_KEY, body.npx_pin.strip())
    if body.allow_latest is not None:
        await set_setting(session, LATEST_KEY, bool(body.allow_latest))
    if body.net_policy is not None:
        await set_setting(session, NET_KEY, body.net_policy)
    if body.platforms is not None:
        await set_setting(session, PLATFORMS_KEY, body.platforms)
    if body.check_interval_h is not None:
        await set_setting(session, CHECK_INTERVAL_KEY, float(body.check_interval_h))
    await session.commit()
    return await get_remote_settings(session)
