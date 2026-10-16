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

不做目录列举端点（agent 消息里会点名路径，按路径取就够；少一个面）。
"""
from __future__ import annotations

import os
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ..config import settings

router = APIRouter(prefix="/api/work", tags=["work"])

#: 可展示的后缀白名单 —— 图片/文档/数据文本；可执行/敏感文件一律不放行
_ALLOWED_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp",
    ".pdf", ".txt", ".md", ".markdown", ".json", ".csv", ".tsv",
    ".html", ".htm", ".xml", ".yaml", ".yml", ".log", ".py", ".js",
    ".ts", ".sql", ".ipynb",
}

#: 路径合法性粗校验（resolve 已挡逃逸，这里挡空段/怪字符）
_SAFE_SEG = re.compile(r"^[\w.\- ()\u4e00-\u9fff]+$")


@router.get("/file/{fpath:path}")
def get_work_file(fpath: str) -> FileResponse:
    """按相对路径取回工作目录下的产物（前端内联展示/下载）。"""
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
        if not _SAFE_SEG.match(seg):
            raise HTTPException(status_code=404, detail="没有这个产物")
    return FileResponse(target)


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
