"""Skills 的三来源目录布局（system / vendor / workspace）与唯一解析入口。

为什么要这一层
==============
以前技能只有"一个扁平目录 + 名字当文件夹名"：谁都能往同一个地方写，
来源只存在于数据库的 JSON 里。要做「来源隔离」，磁盘必须真的分开，
否则任何一段代码都可能写进别人的目录。

布局（与规格一致）
==================
```
{work_dir}/skills/
├─ system/{slug}/SKILL.md            只读，随产品发布
├─ vendor/{owner}/{repo}/{slug}/…    只读，仅同步任务写
└─ workspace/{slug}/…                整理 Agent 与用户可写
```

兼容
====
老数据是扁平目录 `{work_dir}/skills/{name}/`。`path_for()` 先看新位置、
再回退老位置，所以迁移可以分步进行；迁移脚本（migrate_legacy）把老目录
搬进对应命名空间并回填 `skill.ns/slug`。

运行时视图（build_skill_view）仍然要**平铺**目录：AgentScope 的
`LocalSkillLoader(scan_subdir=True)` 只认 `<name>/SKILL.md` 这一层。
所以这里额外提供 `name_index()`：给定根目录，扫三个命名空间，
返回 {技能名: 目录} 供视图与提示词目录使用。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from .config import settings

logger = logging.getLogger(__name__)

#: 命名空间（顺序即同名的解析优先级：显式 ID 不受影响，只有裸名回退时用它）
NAMESPACES = ("vendor", "system", "workspace")

READONLY_NS = ("system", "vendor")


def skills_root() -> Path:
    return Path(settings.work_dir) / "skills"


def ns_root(ns: str) -> Path:
    return skills_root() / ns


def ns_of(source: dict | None) -> str:
    """从 `skill.source` 的 JSON 推断命名空间。

    builtin → system；repo/git → vendor；其余（agent/manual/local/inline/url）→ workspace。
    """
    src = source or {}
    kind = str(src.get("type") or "").lower()
    if kind == "builtin":
        return "system"
    if kind in ("repo", "git"):
        return "vendor"
    return "workspace"


def owner_repo_of(source: dict | None) -> tuple[str, str]:
    """vendor 下的两级目录：优先用 source 里记的 owner/repo，其次解析仓库地址。"""
    src = source or {}
    owner = str(src.get("owner") or "").strip()
    repo = str(src.get("repo") or "").strip()
    if owner and repo:
        return owner, repo
    url = str(src.get("url") or "")
    # https://github.com/<owner>/<repo>/tree/main/<path>
    parts = [p for p in url.split("/") if p]
    if "github.com" in parts:
        i = parts.index("github.com")
        if len(parts) > i + 2:
            return parts[i + 1], parts[i + 2]
    key = str(src.get("source_key") or "")  # git:owner/repo:path
    if key.startswith("git:"):
        body = key[4:].split(":")[0]
        if "/" in body:
            o, r = body.split("/", 1)
            return o, r
    return "unknown", "repo"


def rel_dir(ns: str, slug: str, owner: str = "", repo: str = "") -> Path:
    """某个技能在三个命名空间里的相对目录。"""
    if ns == "vendor":
        return Path("vendor") / (owner or "unknown") / (repo or "repo") / slug
    if ns == "system":
        return Path("system") / slug
    return Path("workspace") / slug


def path_for(row) -> Path:
    """一条技能记录的真实目录（新布局优先，回退老的扁平目录）。"""
    slug = str(getattr(row, "slug", "") or getattr(row, "dir_name", "") or row.name or "").strip()
    ns = str(getattr(row, "ns", "") or "") or ns_of(getattr(row, "source", None) or {})
    owner, repo = owner_repo_of(getattr(row, "source", None) or {})
    new = skills_root() / rel_dir(ns, slug, owner, repo)
    if new.is_dir():
        return new
    legacy = skills_root() / (getattr(row, "dir_name", "") or row.name)
    if legacy.is_dir():
        return legacy
    return new  # 不存在时给新位置（调用方要写入时用它）


@dataclass
class ScannedSkill:
    ns: str
    slug: str
    path: Path
    owner: str = ""
    repo: str = ""


def scan(root: Path | None = None) -> list[ScannedSkill]:
    """扫三个命名空间（也兼容根目录下遗留的扁平技能目录）。"""
    base = Path(root) if root else skills_root()
    found: list[ScannedSkill] = []
    if not base.is_dir():
        return found
    for ns in NAMESPACES:
        nsdir = base / ns
        if not nsdir.is_dir():
            continue
        if ns == "vendor":
            for owner in sorted(p for p in nsdir.iterdir() if p.is_dir()):
                for repo in sorted(p for p in owner.iterdir() if p.is_dir()):
                    for d in sorted(p for p in repo.iterdir() if p.is_dir()):
                        if (d / "SKILL.md").is_file():
                            found.append(ScannedSkill("vendor", d.name, d, owner.name, repo.name))
        else:
            for d in sorted(p for p in nsdir.iterdir() if p.is_dir() and not p.name.startswith(".")):
                if (d / "SKILL.md").is_file():
                    found.append(ScannedSkill(ns, d.name, d))
    # 老的扁平目录（还没迁移的）：当成 workspace，保证"能用"优先
    for d in sorted(p for p in base.iterdir() if p.is_dir() and not p.name.startswith(".")):
        if d.name in NAMESPACES:
            continue
        if (d / "SKILL.md").is_file():
            found.append(ScannedSkill("workspace", d.name, d))
    return found


def name_index(root: Path | None = None) -> dict[str, Path]:
    """{技能名: 目录} —— 供运行时视图与提示词目录使用。

    同名冲突按 NAMESPACES 顺序（vendor → system → workspace）取第一个并告警：
    运行时只认平铺目录名，同名必然互相覆盖，宁可稳定取一个并留日志。
    """
    idx: dict[str, Path] = {}
    for item in scan(root):
        if item.slug in idx:
            logger.warning("技能同名冲突：%s（保留 %s，忽略 %s）", item.slug, idx[item.slug], item.path)
            continue
        idx[item.slug] = item.path
    return idx


async def migrate_legacy_async(session) -> list[str]:
    """把老扁平目录搬进对应命名空间（同步函数，调用方给 SQLAlchemy session）。

    幂等：新位置已存在就跳过；搬不动（权限/占用）只告警不中断。
    返回搬迁过的技能名。
    """
    import shutil

    from sqlalchemy import select

    from .models import Skill

    moved: list[str] = []
    rows = list((await session.execute(select(Skill))).scalars().all())
    for row in rows:
        slug = str(getattr(row, "slug", "") or getattr(row, "dir_name", "") or row.name or "").strip()
        if not slug:
            continue
        ns = getattr(row, "ns", "") or ns_of(row.source or {})
        owner, repo = owner_repo_of(row.source or {})
        dest = skills_root() / rel_dir(ns, slug, owner, repo)
        legacy = skills_root() / (getattr(row, "dir_name", "") or row.name)
        try:
            if not dest.exists() and legacy.is_dir():
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(legacy), str(dest))
                moved.append(f"{ns}:{slug}")
            row.ns = ns
            row.slug = slug
            if not getattr(row, "dir_name", ""):
                row.dir_name = slug
        except OSError:
            logger.warning("技能目录搬迁失败：%s", slug, exc_info=True)
    await session.commit()
    if moved:
        logger.info("技能目录迁移完成：%d 个（%s…）", len(moved), "、".join(moved[:5]))
    return moved
