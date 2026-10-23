"""Agent 产物展示 —— 让 agent 写的图片/文件能在页面上直接看。

问题
----
Agent（Write 工具 / browser 截图 / Bash 导出）把产物写进服务器上的
``data/work/``，但前端没有任何端点能读到这个目录 —— 消息里出现的是
裸本地路径文本（``/srv/src/agent-studio/data/work/result.md``），
用户点不开、看不见，只能自己 ssh。

用户上传的文件（``/api/uploads``）早就有 id 化的取回端点
（``GET /api/uploads/file/{fid}``），但 agent **产出**方向的文件没有
对称的通道。这是缺口，不是设计。

方案
----
``GET /api/work/file/{path:path}``，根目录 = ``data/work/``（与 agent
的 Write/Bash 工具实际落盘位置一致，runtime 用 ``STUDIO_WORK_DIR`` 可
改，端点读同一个 env）。

安防三道：

1. resolve 后必须仍在根目录内（挡 ``../`` 逃逸）
2. 只允许白名单后缀，其他一律 404 —— 不把任意文件读做成目录遍历
3. FileResponse 带正确 Content-Type，浏览器内联显示（图片直接渲染）

另外两件"能不能播"的事（真实踩到过）：

* 浏览器只认少数视频编码 —— H.265/HEVC、ProRes、MPEG-4 Part2 一概解不了；
  AV1 新机器能播、手机与微信内置浏览器常常不能。所以给 ``/probe`` 让前端先说清原因，
  再给 ``/transcode``（ffmpeg 转 H.264）一键变成能播的版本，而不是丢个黑框。
* iOS Safari 会先发 HEAD 探测，只认 GET 的端点会 405 —— 文件端点必须同时接 HEAD。

不做目录列举端点（agent 消息里会点名路径，按路径取就够；少一个面）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from ..config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/work", tags=["work"])

#: 可展示的后缀白名单 —— 图片/文档/数据文本；可执行/敏感文件一律不放行
_ALLOWED_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp",
    ".pdf", ".txt", ".md", ".markdown", ".json", ".csv", ".tsv",
    ".html", ".htm", ".xml", ".yaml", ".yml", ".log", ".py", ".js",
    ".ts", ".sql", ".ipynb", ".mdx",
    # Office 与思维导图：本身不能内联显示，但「预览」端点会把内容解成 JSON；
    # 下载端点也要放行，否则预览失败时连下载都没得给
    ".xlsx", ".xlsm", ".docx", ".pptx", ".xmind",
    # 老格式只给下载（解不了），但别在下载这一步就 404
    ".xls", ".doc", ".ppt",
    # 音视频：对话里能直接播（浏览器原生控件），只放行 Web 能解的容器/编码
    ".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus",
    ".mp4", ".webm", ".mov", ".m4v", ".ogv",
}

#: 路径合法性粗校验：resolve 已经挡住逃逸，这里只挡控制字符与文件系统里不可能的符号。
#: 别收得太紧 —— 从 bilibili 下回来的名字带方括号（`标题 [BV1r9nF6ZE2h].mp4`），
#: 卡在这里会让文件明明在、点开却 404（当时"mp4 播不了"就是这么来的）。
#: 文件名里不允许出现的字符（文件系统/URL 语义里的分隔符）。
#: 这里**不能收太紧**：bilibili 下回来的名字带方括号（`标题 [BV1r9nF6ZE2h].mp4`），
#: 卡在这里会让文件明明在、点开却 404 —— 当时「mp4 播不了」就是这么来的。
_BAD_CHARS = set('/\\:*?"<>|')


def _bad_seg(name: str) -> bool:
    """挡住 . / .. 、控制字符（含 NUL）与分隔符 —— resolve 之外的最后一道。"""
    return (
        name in (".", "..")
        or any(ord(ch) < 32 for ch in name)
        or any(ch in _BAD_CHARS for ch in name)
    )


def _resolve(fpath: str) -> Path:
    """把相对路径解析成工作目录里的真实文件；越界/白名单外/不存在一律 404。"""
    if not fpath or fpath.startswith("/"):
        raise HTTPException(status_code=404, detail="没有这个产物")
    root = Path(settings.work_dir).resolve()
    target = (root / fpath).resolve()
    if not str(target).startswith(str(root) + os.sep):
        raise HTTPException(status_code=404, detail="没有这个产物")
    if target.suffix.lower() not in _ALLOWED_SUFFIXES:
        raise HTTPException(status_code=404, detail="该类型不支持在线展示")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="产物不存在或已被清理")
    for seg in target.relative_to(root).parts:
        if _bad_seg(seg):
            raise HTTPException(status_code=404, detail="没有这个产物")
    return target


@router.get("/file/{fpath:path}")
def get_work_file(fpath: str) -> FileResponse:
    """按相对路径取回工作目录下的产物（前端内联展示/下载）。"""
    return FileResponse(_resolve(fpath))


@router.head("/file/{fpath:path}")
def head_work_file(fpath: str) -> FileResponse:
    """HEAD 与 GET 同权 —— iOS Safari 放视频前会先探一次，405 会被当成"放不了"。"""
    return FileResponse(_resolve(fpath))


#: 浏览器真能解的编码（其余一律要转码；av1 归"看设备"，手机常常不行）
_SAFE_VIDEO = {"h264", "vp8", "vp9", "av1"}
_RISKY_VIDEO = {"av1"}
_SAFE_AUDIO = {"aac", "mp3", "opus", "vorbis", "none", ""}
_SAFE_CONTAINER = {"mp4", "m4a", "mov", "webm", "ogg", "ogv"}


def _probe(target: Path) -> dict:
    """问 ffprobe 这个视频是什么编码，并判定浏览器能不能直接播。"""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json",
             "-show_format", "-show_streams", str(target)],
            capture_output=True, text=True, timeout=15, check=True,
        )
        info = json.loads(out.stdout or "{}")
    except Exception:  # noqa: BLE001 —— 没有 ffprobe / 文件坏了：前端只给下载
        return {"ok": False, "reason": "这台机器上没有 ffprobe，无法判断编码"}
    streams = info.get("streams") or []
    fmt = info.get("format") or {}
    v = next((x for x in streams if x.get("codec_type") == "video"), None)
    a = next((x for x in streams if x.get("codec_type") == "audio"), None)
    if v is None:
        return {"ok": True, "playable": "no", "reason": "这个文件里没有画面（纯音频或已损坏）"}
    container = (fmt.get("format_name") or "").split(",")[0].lower()
    vcodec = (v.get("codec_name") or "").lower()
    acodec = (a.get("codec_name") or "").lower() if a else ""
    playable, reason = "yes", ""
    if vcodec not in _SAFE_VIDEO:
        playable, reason = "no", f"视频编码是 {vcodec.upper()}，浏览器解不了（只认 H.264 / VP8 / VP9 / AV1）"
    elif vcodec in _RISKY_VIDEO:
        playable, reason = "maybe", "视频是 AV1：电脑新版浏览器能播，手机和微信内置浏览器常常不能"
    elif acodec and acodec not in _SAFE_AUDIO:
        playable, reason = "maybe", f"音频编码是 {acodec.upper()}，有些设备会没声音"
    elif container and container not in _SAFE_CONTAINER:
        playable, reason = "no", f"容器格式是 {container}，浏览器播不了"
    return {
        "ok": True,
        "playable": playable,
        "reason": reason,
        "container": container,
        "video": vcodec,
        "audio": acodec,
        "duration": float(fmt.get("duration") or 0),
        "width": int(v.get("width") or 0),
        "height": int(v.get("height") or 0),
        "size": target.stat().st_size,
    }


@router.get("/preview")
def preview_file(fpath: str = Query(..., description="相对工作目录的路径")) -> dict:
    """把 xlsx / docx / pptx / xmind 解成前端能直接画的结构。

    为什么不让前端解：这三类 office 文件要在浏览器里解析得引三套库（+1.5MB），
    而服务端已经有现成的解析器。这里输出统一的 ``{kind, payload, notes}``，
    前端只按 kind 选渲染器 —— 加一种格式只要多一个后端分支，前端不用动。

    解析失败**不抛 500**：文件可能损坏、可能加密、可能是老格式。
    回 200 + ``error`` 让前端把原因显示在预览层里，比一个干巴巴的 500 有用。
    """
    target = _resolve(fpath)
    from ..preview import parse

    try:
        return {"ok": True, **parse(target)}
    except ValueError as exc:
        # 明确"这个格式解不了"（老 Office 格式、损坏文件）—— 是预期内的情况
        return {"ok": False, "error": str(exc), "name": target.name, "size": target.stat().st_size}
    except Exception as exc:  # noqa: BLE001 —— 第三方解析器抛什么都有可能
        logger.warning("预览解析失败 %s: %s", target, exc)
        return {
            "ok": False,
            "error": f"解析失败：{type(exc).__name__}（文件可能已损坏或带密码）",
            "name": target.name,
            "size": target.stat().st_size,
        }


@router.get("/probe")
def probe_work_file(path: str) -> dict:
    """这个文件浏览器能不能直接播？播不了就说清为什么（前端据此决定放播放器还是放转码按钮）。"""
    return _probe(_resolve(path))


#: 转码上限：再大就别在网页里等了（下载本机转更合适）
_TRANSCODE_MAX_BYTES = 800 * 1024 * 1024
_TRANSCODE_TIMEOUT = 900


@router.post("/transcode")
async def transcode_work_file(payload: dict) -> dict:
    """把播不了的视频转成 H.264/AAC 的 mp4，产物放同目录，重复点复用已有结果。"""
    rel = str(payload.get("path") or "")
    target = _resolve(rel)
    if target.suffix.lower() not in (".mp4", ".mov", ".webm", ".m4v", ".ogv", ".mkv", ".avi"):
        raise HTTPException(status_code=400, detail="这个文件不是视频")
    if target.stat().st_size > _TRANSCODE_MAX_BYTES:
        raise HTTPException(status_code=413, detail="文件太大（超过 800MB），请下载后用本机转换")
    if shutil.which("ffmpeg") is None:
        raise HTTPException(status_code=503, detail="这台机器上没有 ffmpeg，不能转换")

    out = target.with_name(f"{target.stem}.可播.mp4")
    if not (out.exists() and out.stat().st_mtime >= target.stat().st_mtime):
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error", "-i", str(target),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",   # moov 前置：手机边下边播
            str(out),
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        try:
            _, err = await asyncio.wait_for(proc.communicate(), timeout=_TRANSCODE_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            raise HTTPException(status_code=504, detail="转换超时（视频太长），请下载后用本机转换") from None
        if proc.returncode != 0 or not out.exists():
            detail = (err or b"").decode("utf-8", "ignore")[-300:] or "ffmpeg 出错"
            raise HTTPException(status_code=500, detail=f"转换失败：{detail}")

    root = Path(settings.work_dir).resolve()
    rel_out = out.relative_to(root).as_posix()
    return {
        "path": rel_out,
        "url": f"/api/work/file/{quote(rel_out)}",
        "size": out.stat().st_size,
        "probe": _probe(out),
    }


@router.get("/list")
def list_work_files(limit: int = 50) -> dict:
    """最近产物列表（诊断用；前端正常流程不走这里）。"""
    root = Path(settings.work_dir)
    if not root.is_dir():
        return {"files": []}
    items = []
    for p in sorted(root.rglob("*"), key=lambda x: x.stat().st_mtime, reverse=True):
        if p.is_file() and p.suffix.lower() in _ALLOWED_SUFFIXES:
            items.append({
                "path": str(p.relative_to(root)),
                "size": p.stat().st_size,
                "mtime": int(p.stat().st_mtime),
                "url": f"/api/work/file/{p.relative_to(root)}",
            })
            if len(items) >= limit:
                break
    return {"files": items}
