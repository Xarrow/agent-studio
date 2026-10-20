"""浏览器驱动管理的接口。

页面只需要四件事：现在用的哪个、这台机器上有哪些、能装哪些版本、换一个。
「装」是长动作（几十上百 MB），所以做成后台任务 + 轮询进度 —— 与 Node/Python
那一块同一套做法，用户不用在页面上干等一个转圈。
"""

from __future__ import annotations

from typing import Any

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from .. import browser_drivers as bd
from ..db import get_session

router = APIRouter(prefix="/api/browser-drivers", tags=["browser-drivers"])


class ActivateIn(BaseModel):
    kind: str
    path: str = ""
    version: str = ""
    source: str = "managed"


class InstallIn(BaseModel):
    kind: str
    version: str
    url: str


@router.get("")
async def overview(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """一屏看全：当前驱动 + 所有已安装 + 支持的引擎。"""
    active = await bd.get_active(session)
    rows = bd.installed()
    for r in rows:
        r["active"] = bool(active.get("path")) and r["path"] == active.get("path")
    return {
        "active": active,
        "installed": rows,
        "engines": [
            {
                "kind": e["kind"],
                "label": e["label"],
                "proto": e["proto"],
                "managed": bool(e["managed"]),
                "note": e["note"],
            }
            for e in bd.ENGINES
        ],
    }


@router.get("/versions")
async def versions(kind: str, limit: int = 12) -> dict[str, Any]:
    try:
        return await bd.versions(kind, limit=limit)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        # 官方清单拉不到（断网/被墙）要说清楚，而不是给一个空列表让人以为"没有版本"
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"拿不到版本清单：{exc}（网络不通时可先用系统已装的驱动）"
        ) from exc


@router.post("/install")
async def install(payload: InstallIn) -> dict[str, Any]:
    try:
        return bd.start_install(payload.kind, payload.version, payload.url)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc


@router.get("/install/{job_id}")
async def install_status(job_id: str) -> dict[str, Any]:
    j = bd.job(job_id)
    if j is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "没有这个安装任务（服务可能重启过，重试即可）")
    return j


@router.post("/active")
async def activate(payload: ActivateIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    try:
        return await bd.set_active(
            session, payload.kind, payload.path, payload.version, payload.source
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc


@router.post("/active/reset")
async def reset(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """切回系统自带的 Chromium。"""
    return await bd.reset_active(session)


@router.delete("/installed/{kind}/{version}")
async def uninstall(kind: str, version: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    active = await bd.get_active(session)
    d = bd.ROOT / f"{kind}-{version}"
    if active.get("path") and _inside(d, active["path"]):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "这个版本正在使用中 —— 先切到别的驱动再删"
        )
    try:
        bd.remove(kind, version)
    except ValueError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    return {"removed": f"{kind}-{version}"}


def _inside(d: Path, path: str) -> bool:
    """这个可执行文件是不是就在这个托管目录里（= 正在用它）。"""
    try:
        return Path(path).resolve().is_relative_to(d.resolve())
    except Exception:  # pragma: no cover
        return False
