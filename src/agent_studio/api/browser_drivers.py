"""浏览器驱动管理的接口。

页面只需要四件事：现在用的哪个、这台机器上有哪些、能装哪些版本、换一个。
「装」是长动作（几十上百 MB），所以做成后台任务 + 轮询进度 —— 与 Node/Python
那一块同一套做法，用户不用在页面上干等一个转圈。
"""

from __future__ import annotations

from typing import Any

from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from .. import browser_drivers as bd
from .. import browser_extensions as bx
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


# ── 浏览器插件（扩展）───────────────────────────────────────────────
# 扩展只能在启动时给（--load-extension），所以每次增删改都要重启共享进程，
# 否则用户会看到"装了但没生效"。重启是懒的：下一条消息自然会拉起新进程。


class ExtToggleIn(BaseModel):
    enabled: bool


@router.get("/extensions")
async def list_extensions() -> dict[str, Any]:
    items = bx.list_extensions()
    # 当前在用的浏览器类型：Chrome 系（CDP）还是 Firefox（BiDi）。
    # 扩展开关按它判断"能不能用"，免得用户装了个 Chrome 专用插件却发现在 Firefox 里没动静。
    act = bd.last_active()
    cur = "firefox" if str(act.get("proto") or "cdp") == "bidi" else "chrome"
    for it in items:
        t = str(it.get("target") or "both")
        it["usable"] = t in (cur, "both")
        it["active_browser"] = cur
    return {
        "items": items,
        "count": len(items),
        "enabled": sum(1 for i in items if i.get("enabled")),
        "browser": cur,
        # 给界面一句话说清"什么时候生效"
        "note": "改动会在下次启动浏览器时生效（正在跑的会话不受影响）",
    }


@router.post("/extensions", status_code=status.HTTP_201_CREATED)
async def upload_extension(file: UploadFile = File(...)) -> dict[str, Any]:
    """上传 .zip / .crx。装完顺手重启共享浏览器，下条消息就带上它。"""
    data = await file.read()
    if len(data) > 64 * 1024 * 1024:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "包太大（>64MB）")
    try:
        item = bx.install_from_bytes(file.filename or "extension.zip", data)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    await bx.restart_shared_browser()
    return item


@router.post("/extensions/{dir_name}/enabled")
async def toggle_extension(dir_name: str, payload: ExtToggleIn) -> dict[str, Any]:
    try:
        item = bx.set_enabled(dir_name, payload.enabled)
    except KeyError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"没有这个插件：{dir_name}") from exc
    await bx.restart_shared_browser()
    return item


@router.delete("/extensions/{dir_name}")
async def delete_extension(dir_name: str) -> dict[str, Any]:
    ok = bx.remove(dir_name)
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"没有这个插件：{dir_name}")
    await bx.restart_shared_browser()
    return {"ok": True, "removed": dir_name}


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


@router.post("/deps")
async def install_deps(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """给浏览器补系统运行库（全新机器上常见：解压成功、一启动就缺 libnss3）。

    能自己装就装；进程没有 root 就把**可以直接复制执行的命令**交回去 —— 页面照着显示。
    """
    import asyncio

    res = await asyncio.to_thread(bd.install_system_deps)
    active = await bd.get_active(session)  # 装完顺手重判一次（缓存已清）
    return {**res, "active": active}


class CheckIn(BaseModel):
    """自检入参：都不给就查当前生效的那个。"""
    kind: str = ""
    path: str = ""


@router.post("/check")
async def check(payload: CheckIn | None = None, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """真拉起来跑一次：这台机器上它到底能不能用。

    不给参数就查当前生效的那个。结果会进缓存，页面下次打开直接能看见。
    """
    if payload is not None and payload.path:
        kind = payload.kind or "chromium"
        if kind not in {e["kind"] for e in bd.ENGINES}:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"不支持的引擎: {kind}")
        path = payload.path
    else:
        active = await bd.get_active(session)
        path = str(active.get("path") or "")
        kind = str(active.get("kind") or "chromium")
    if not path:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "没有可自检的驱动（这台机器上还没装）")
    return {"path": path, "kind": kind, "verify": bd.verify(path, kind, force=True)}


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
