"""技能发现与内容哈希（纯文件操作，可离线测试）。

发现顺序（找到即停，不再往下钻）：
1. 来源子路径本身就是技能（``<sub>/SKILL.md``）
2. 仓库根是技能（``SKILL.md``）
3. 约定目录：``skills/``、``.agents/skills/``、``.claude/skills/``、``.cursor/skills/``
4. 递归搜索（深度 ≤ 4，命中目录后不再下钻；总量上限 100）

校验：frontmatter 可解析、name 与 description 必填；``internal: true`` 默认隐藏。
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

CONVENTION_DIRS = ("skills", ".agents/skills", ".claude/skills", ".cursor/skills")
MAX_DEPTH = 4
MAX_SKILLS = 100
MAX_FILES = 400
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"}

_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)


@dataclass
class DiscoveredSkill:
    path: str                      # 相对来源根的目录（"" = 根即技能）
    name: str
    description: str
    content: str
    files: dict[str, str] = field(default_factory=dict)
    internal: bool = False
    warnings: list[str] = field(default_factory=list)

    @property
    def content_hash(self) -> str:
        return skill_hash(self.content, self.files)

    def brief(self, *, show_internal: bool = False) -> dict[str, Any]:
        return {
            "path": self.path,
            "name": self.name,
            "description": self.description,
            "internal": self.internal,
            "files": len(self.files),
            "hash": self.content_hash[:16],
            "warnings": list(self.warnings),
            "hidden": self.internal and not show_internal,
        }


def parse_frontmatter(text: str) -> dict[str, Any]:
    m = _FRONTMATTER.match(text)
    if not m:
        return {}
    try:
        data = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError:
        return {}
    return data if isinstance(data, dict) else {}


def skill_hash(content: str, files: dict[str, str] | None = None) -> str:
    """技能目录内容哈希：SKILL.md + 所有附属文件（按路径排序），排除 .git。"""
    h = hashlib.sha256()
    h.update(b"SKILL.md\0")
    h.update(content.encode("utf-8", "ignore"))
    for rel in sorted(files or {}):
        h.update(b"\0" + rel.encode("utf-8", "ignore") + b"\0")
        h.update((files or {})[rel].encode("utf-8", "ignore"))
    return h.hexdigest()


def _read_text(p: Path) -> str | None:
    try:
        if p.stat().st_size > 200_000:
            return None
        return p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _collect(folder: Path, root: Path, *, warnings: list[str]) -> DiscoveredSkill | None:
    md = folder / "SKILL.md"
    text = _read_text(md)
    if text is None:
        return None
    meta = parse_frontmatter(text)
    name = str(meta.get("name") or folder.name).strip()
    desc = str(meta.get("description") or "").strip()
    if not meta:
        warnings.append(f"{folder.name}: frontmatter 解析失败，已按目录名兜底")
    if not desc:
        # 兜底：正文第一段非标题行
        body = _FRONTMATTER.sub("", text)
        for line in body.splitlines():
            s = line.strip()
            if s and not s.startswith("#"):
                desc = s[:200]
                break
    files: dict[str, str] = {}
    for f in sorted(folder.rglob("*")):
        if len(files) >= MAX_FILES:
            warnings.append(f"{folder.name}: 附属文件超过 {MAX_FILES}，其余忽略")
            break
        if not f.is_file() or f.name == "SKILL.md":
            continue
        if any(part in SKIP_DIRS for part in f.relative_to(folder).parts):
            continue
        t = _read_text(f)
        if t is not None:
            files[str(f.relative_to(folder))] = t
    rel = "" if folder == root else folder.relative_to(root).as_posix()
    return DiscoveredSkill(
        path=rel,
        name=name,
        description=desc,
        content=text,
        files=files,
        internal=bool(meta.get("internal") or meta.get("hidden")),
        warnings=warnings,
    )


def discover(root: Path, *, subpath: str | None = None) -> list[DiscoveredSkill]:
    """按发现顺序找技能。返回列表（可能为空）。"""
    base = (root / subpath) if subpath else root
    if not base.is_dir():
        return []

    # 1) 子路径本身 / 2) 根本身
    if (base / "SKILL.md").is_file():
        one = _collect(base, root, warnings=[])
        return [one] if one else []

    found: list[DiscoveredSkill] = []

    def add(folder: Path) -> bool:
        s = _collect(folder, root, warnings=[])
        if s:
            found.append(s)
            return True
        return False

    # 3) 约定目录
    for conv in CONVENTION_DIRS:
        d = base / conv
        if not d.is_dir():
            continue
        if (d / "SKILL.md").is_file():
            add(d)
        for child in sorted(d.iterdir()):
            if child.is_dir() and (child / "SKILL.md").is_file():
                add(child)
        if found:
            return _sorted(found)

    # 4) 递归（深度受限，命中即不再下钻）
    def walk(d: Path, depth: int) -> None:
        if depth > MAX_DEPTH or len(found) >= MAX_SKILLS:
            return
        if (d / "SKILL.md").is_file():
            add(d)
            return
        try:
            children = sorted(x for x in d.iterdir() if x.is_dir() and x.name not in SKIP_DIRS)
        except OSError:
            return
        for c in children:
            walk(c, depth + 1)

    walk(base, 0)
    return _sorted(found)


def _sorted(items: list[DiscoveredSkill]) -> list[DiscoveredSkill]:
    return sorted(items, key=lambda s: (s.path.count("/"), s.path))[:MAX_SKILLS]


def pick(
    items: list[DiscoveredSkill],
    *,
    skills: list[str] | None = None,
    paths: list[str] | None = None,
) -> list[DiscoveredSkill]:
    """按名字/路径选择；``*`` 表示全部；同名多个 → ambiguous_skill。"""
    if not skills and not paths:
        return items
    wanted = [x.strip() for x in (skills or []) if x.strip()]
    if "*" in wanted:
        return items
    wanted_paths = {(p or "").strip("/") for p in (paths or []) if (p or "").strip()}
    out: list[DiscoveredSkill] = []
    for w in wanted:
        hits = [s for s in items if s.name == w or s.path.rsplit("/", 1)[-1] == w]
        if len(hits) > 1:
            raise ValueError(
                "ambiguous_skill: 同名技能有多个 —— " + "、".join(h.path for h in hits) + "；请指定路径"
            )
        if hits:
            out.append(hits[0])
    for p in wanted_paths:
        for s in items:
            if s.path.strip("/") == p and s not in out:
                out.append(s)
    if not out:
        raise ValueError("没找到指定的技能：" + "、".join(wanted + sorted(wanted_paths)))
    return out
