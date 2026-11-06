"""产物（deliverable）：Agent 这一轮到底交付了什么。

为什么单独一层
--------------
在这之前，一个会话的"产出"就是消息流里的一段文字 + 一堆散落的文件。用户要拿走的
东西（一个页面、一份文档、一个小工具）得自己去文件区里翻，翻完还不知道哪个是入口。

约定一个目录就够了：会话工作目录下的 ``product/``。约定越少越不会被绕过 ——
助手只要"把成品放进去"，平台负责认出入口、给预览、给下载、能发布成链接。

识别规则（按顺序取第一个命中的）::

    product/index.html   → 网页产物（能预览、能发布）
    product/index.htm    → 同上
    product/README.md    → 文档产物
    product/*.html       → 网页产物
    其它有文件的        → 普通产物（只能下载）

目录本身由助手创建；平台只在**读**的时候约定它，写坏了最多是"没认出产物"。
"""

from __future__ import annotations

import shutil
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

#: 会话工作目录下的产物目录名。改这里 = 改整个产品的约定，别轻易动。
PRODUCT_DIR = "product"

#: 清单最多列多少个文件。产物是给人看的，不是备份工具。
MAX_FILES = 500

#: 打包/发布时跳过的东西（产物目录里出现这些基本是助手把工作区当成了产物目录）
_SKIP_DIRS = {"node_modules", "__pycache__", ".git", ".venv", ".next"}
_SKIP_NAMES = {".DS_Store"}

_ENTRY_CANDIDATES = ("index.html", "index.htm", "README.md", "readme.md")

_MIME = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".pdf": "application/pdf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
}


def product_path(session_work_dir: Path | str) -> Path:
    return Path(session_work_dir) / PRODUCT_DIR


def _walk(root: Path) -> list[Path]:
    """产物目录下的文件（相对 root 的绝对路径），排序稳定。"""
    out: list[Path] = []
    for p in sorted(root.rglob("*")):
        if len(out) >= MAX_FILES:
            break
        if not p.is_file():
            continue
        rel = p.relative_to(root)
        if any(part in _SKIP_DIRS for part in rel.parts[:-1]):
            continue
        if p.name in _SKIP_NAMES:
            continue
        out.append(p)
    return out


def _pick_entry(root: Path, files: list[Path]) -> str | None:
    for name in _ENTRY_CANDIDATES:
        cand = root / name
        if cand.is_file():
            return name
    for p in files:
        if p.suffix.lower() in (".html", ".htm"):
            return str(p.relative_to(root))
    return None


def _kind_of(entry: str | None) -> str:
    if not entry:
        return "file"
    suffix = Path(entry).suffix.lower()
    if suffix in (".html", ".htm"):
        return "web"
    if suffix in (".md", ".mdx"):
        return "doc"
    return "file"


@dataclass
class Deliverable:
    """一次产物的快照。``exists=False`` 时其它字段无意义。"""

    exists: bool = False
    entry: str | None = None
    kind: str = "file"
    files: list[dict[str, Any]] = field(default_factory=list)
    size: int = 0
    updated_at: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "exists": self.exists,
            "entry": self.entry,
            "kind": self.kind,
            "files": self.files,
            "file_count": len(self.files),
            "size": self.size,
            "updated_at": self.updated_at,
        }


def scan(session_work_dir: Path | str) -> Deliverable:
    """看这个会话有没有产物。不改任何东西。"""
    root = product_path(session_work_dir)
    if not root.is_dir():
        return Deliverable()
    files = _walk(root)
    if not files:
        # 空目录不算产物 —— 助手常见动作是先 mkdir 再写，中间态不打扰用户
        return Deliverable()
    entry = _pick_entry(root, files)
    rows = []
    total = 0
    newest = 0.0
    for p in files:
        try:
            st = p.stat()
        except OSError:
            continue
        total += st.st_size
        newest = max(newest, st.st_mtime)
        rows.append(
            {
                "path": str(p.relative_to(root)),
                "size": st.st_size,
                "kind": _kind_of(str(p.relative_to(root))),
            }
        )
    return Deliverable(
        exists=True,
        entry=entry,
        kind=_kind_of(entry),
        files=rows,
        size=total,
        updated_at=int(newest * 1000) if newest else None,
    )


def resolve_file(session_work_dir: Path | str, rel: str) -> tuple[Path, str]:
    """把 ``rel`` 解析成产物目录里的真实文件，越界一律拒。

    返回 ``(绝对路径, 相对路径)``。路径写在 URL 里，任何形式的跳出都要挡住 ——
    产物目录是**只读边界**，不是"会话目录"。
    """
    root = product_path(session_work_dir).resolve()
    if not root.is_dir():
        raise FileNotFoundError("这个会话还没有产物")
    target = (root / rel.strip().lstrip("/")).resolve()
    if target != root and root not in target.parents:
        raise PermissionError(f"路径越界：{rel}")
    if not target.is_file():
        raise FileNotFoundError(f"产物里没有这个文件：{rel}")
    return target, str(target.relative_to(root))


def mime_of(path: Path | str) -> str:
    return _MIME.get(Path(path).suffix.lower(), "application/octet-stream")


def write_zip(src_dir: Path | str, dest: Path) -> int:
    """把产物目录打成 zip，返回文件数。已存在则覆盖。"""
    root = Path(src_dir)
    files = _walk(root)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for p in files:
            zf.write(p, str(p.relative_to(root)))
    tmp.replace(dest)
    return len(files)


def slug_for(session_id: str) -> str:
    """发布用的小名：同一个会话反复发布 = 覆盖同一个地址（链接不会遍地都是）。"""
    core = session_id[4:] if session_id.startswith("ses_") else session_id
    return f"p-{core[:12]}"


def publish(session_work_dir: Path | str, publish_root: Path | str, session_id: str) -> dict[str, Any]:
    """把产物目录整体发到静态目录下，返回可访问的路径。

    先拷到临时目录再原子替换：发布过程中有人打开链接，看到的是上一版，不是半个。
    """
    src = product_path(session_work_dir)
    if not src.is_dir() or not any(src.iterdir()):
        raise FileNotFoundError("这个会话没有可发布的产物")
    root = Path(publish_root)
    root.mkdir(parents=True, exist_ok=True)
    slug = slug_for(session_id)
    dest = root / slug
    staging = root / f".{slug}.{int(time.time())}.tmp"
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)
    shutil.copytree(src, staging, ignore=shutil.ignore_patterns(*_SKIP_DIRS, *_SKIP_NAMES))
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    staging.rename(dest)
    files = _walk(dest)
    entry = _pick_entry(dest, files)
    return {
        "slug": slug,
        "entry": entry,
        "file_count": len(files),
        "size": sum(p.stat().st_size for p in files if p.exists()),
        "published_at": int(time.time() * 1000),
    }
