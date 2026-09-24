"""任务卡的上传附件（图片 / 文件）。

设计要点
--------------------------------------------------------------------
1. **存储目录由用户在「环境配置」页自定义**（GET/PUT /api/uploads/config），
   默认落在 <PROJECT_ROOT>/data/uploads —— 不写死在代码里。
2. 落盘后生成一份 meta.json（id → 原始文件名 / 类型 / 大小 / 时间），
   对外一律用 **id** 取回：既不暴露服务器真实路径，也避免中文名/特殊字符进 URL。
3. 零新依赖：用 FastAPI 自带的 multipart（python-multipart 已在依赖里）。
4. 单文件上限 32MB；同名文件不覆盖（id 唯一）。
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..config import PROJECT_ROOT

router = APIRouter(prefix="/api/uploads", tags=["uploads"])

# 单文件上限（可调）。放这里而不是散在函数里 —— 改一个数就够。
MAX_BYTES = 32 * 1024 * 1024

_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif"}

_DEFAULT_DIR = PROJECT_ROOT / "data" / "uploads"
_CONFIG_PATH = PROJECT_ROOT / "data" / "uploads.config.json"


def _load_config() -> dict:
    try:
        return json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_config(data: dict) -> None:
    _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    _CONFIG_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def current_dir() -> Path:
    """当前上传目录：配置优先，否则默认 data/uploads。"""
    raw = (_load_config().get("dir") or "").strip()
    return Path(raw).expanduser() if raw else _DEFAULT_DIR


def _meta_path() -> Path:
    return current_dir() / "meta.json"


def _load_meta() -> dict:
    try:
        return json.loads(_meta_path().read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_meta(data: dict) -> None:
    _meta_path().write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def _probe(path: Path) -> dict:
    """目录是否可用（环境配置页要显示这个，别让用户改完才发现写不进去）。"""
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return {"exists": True, "writable": True, "error": ""}
    except Exception as exc:  # noqa: BLE001 - 要把原因原样给用户看
        return {"exists": path.exists(), "writable": False, "error": str(exc)}


class UploadConfig(BaseModel):
    dir: str = Field(default="", description="上传目录（留空 = 回到默认 data/uploads）")


@router.get("/config")
def get_config() -> dict:
    cur = current_dir()
    return {
        "dir": str(cur),
        "default_dir": str(_DEFAULT_DIR),
        "is_default": cur == _DEFAULT_DIR,
        **_probe(cur),
    }


@router.put("/config")
def put_config(body: UploadConfig) -> dict:
    raw = (body.dir or "").strip()
    target = Path(raw).expanduser() if raw else _DEFAULT_DIR
    if raw and not target.is_absolute():
        raise HTTPException(status_code=422, detail="请填绝对路径（例如 /srv/agent-uploads）")
    info = _probe(target)
    if not info["writable"]:
        raise HTTPException(status_code=422, detail=f"这个目录不可写：{info['error']}")
    _save_config({"dir": "" if target == _DEFAULT_DIR else str(target)})
    return {"dir": str(target), "default_dir": str(_DEFAULT_DIR), "is_default": target == _DEFAULT_DIR, **info}


@router.get("")
def list_files(limit: int = 50) -> dict:
    meta = _load_meta()
    items = sorted(meta.values(), key=lambda m: m.get("ts", 0), reverse=True)[:limit]
    return {"dir": str(current_dir()), "items": items}


@router.post("")
async def upload(file: UploadFile = File(...)) -> dict:
    """收下一个文件 → 落盘 → 返回 {id, name, size, kind, url}。"""
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=422, detail="文件是空的")
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"文件太大（上限 {MAX_BYTES // 1024 // 1024}MB）")

    folder = current_dir()
    info = _probe(folder)
    if not info["writable"]:
        raise HTTPException(status_code=422, detail=f"上传目录不可写：{info['error']}（去「环境配置」改一个目录）")

    name = (file.filename or "未命名").strip() or "未命名"
    ext = Path(name).suffix.lower()
    fid = uuid.uuid4().hex[:16]
    stored = folder / f"{fid}{ext}"
    stored.write_bytes(raw)

    item = {
        "id": fid,
        "name": name,
        "size": len(raw),
        "ext": ext,
        "kind": "image" if ext in _IMAGE_EXT else "file",
        "path": str(stored),
        "ts": time.time(),
    }
    meta = _load_meta()
    meta[fid] = item
    _save_meta(meta)
    return {**item, "url": f"/api/uploads/file/{fid}"}


@router.get("/file/{fid}")
def download(fid: str) -> FileResponse:
    """按 id 取回（前端缩略图 / 模型读文件都走这里，不暴露真实路径）。"""
    item = _load_meta().get(fid)
    if not item:
        raise HTTPException(status_code=404, detail="没有这个附件")
    path = Path(item["path"])
    if not path.exists():
        raise HTTPException(status_code=410, detail="文件已被移走或删除")
    return FileResponse(path, filename=item.get("name") or path.name)


@router.delete("/file/{fid}")
def remove(fid: str) -> dict:
    meta = _load_meta()
    item = meta.pop(fid, None)
    if not item:
        raise HTTPException(status_code=404, detail="没有这个附件")
    try:
        Path(item["path"]).unlink(missing_ok=True)
    except Exception:
        pass
    _save_meta(meta)
    return {"deleted": 1, "id": fid}
