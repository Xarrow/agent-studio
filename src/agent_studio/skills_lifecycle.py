"""技能生命周期 —— 让技能库自己收敛，而不是只涨不消。

规则（与 Hermes 的 curator 同一套思路，按本平台的现实简化）：

* **只管助手自己沉淀的技能**（``source.type == "agent"``）。仓库安装的、手写的、
  导入的一律不动 —— 那些是用户明确弄进来的东西，自动归档会让人觉得"我装的它怎么没了"。
* **只挪不删**：归档 = 把磁盘目录移到 ``skills-archive/``，正文仍在库里；
  恢复 = 搬回来 + 按库里的正文重写 SKILL.md。任何路径下都没有删除动作。
* **固定(pinned)豁免**：钉住的技能不降级、不归档，手动也归档不了（要归档先取消固定）。
* 三档状态：``active`` → （30 天没人读）``stale`` → （90 天没人读）``archived``。
  降级只是标签，**不影响助手能不能用**；只有 archived 才真的从运行时撤下。

为什么超时判定看 ``last_used_at``，没有就退回 ``updated_at``：
老数据一开始没有使用记录，用"最后改动"当近似，总比把它们一次性全判成没人用要好。
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .models import Skill, now_ms

logger = logging.getLogger(__name__)

#: 多久没人读 → 标记"闲置"（只是标签，助手照样能用）
STALE_AFTER_DAYS = 30
#: 多久没人读 → 从运行时撤下（内容仍在库里，一键能恢复）
ARCHIVE_AFTER_DAYS = 90
#: 自动整理的最小间隔：并入既有调度循环，不必单独起 cron
SWEEP_EVERY_MS = 6 * 3600 * 1000

DAY_MS = 24 * 3600 * 1000
LAST_SWEEP: dict[str, int] = {"at": 0}


def skills_dir() -> Path:
    return Path(settings.work_dir) / "skills"


def archive_dir() -> Path:
    return Path(settings.work_dir) / "skills-archive"


def write_skill_files(row: Skill, root: Path | None = None) -> Path:
    """把一条 Skill 的真身写到磁盘（同步版，运行时也要用）。

    **只在库里不算有**：LocalSkillLoader 读的是 ``work_dir/skills/<name>/``。
    这套环境迁移/重建时库里带过来了、盘上没带过来，助手就"勾了但看不见" ——
    实测东京实例挂了 8 个，目录里只有 3 个。
    """
    base = Path(root) if root is not None else skills_dir()
    target = base / (getattr(row, "dir_name", "") or row.name)
    target.mkdir(parents=True, exist_ok=True)
    (target / "SKILL.md").write_text(row.content or "", encoding="utf-8")
    for rel, text in (row.files or {}).items():
        f = target / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text, encoding="utf-8")
    return target


async def ensure_skill_files(names: list[str]) -> list[str]:
    """绑定了、库里也 active，但目录不在盘上 → 从库里补写回来。

    返回真的补了哪些。扣在运行时入口做，是因为"缺文件"这件事可能在
    任何时刻发生（换机器、清缓存、手工删目录），补一次就永久好了。
    """
    want = [str(n) for n in (names or []) if n]
    if not want:
        return []
    root = skills_dir()
    missing = [n for n in want if not (root / n / "SKILL.md").is_file()]
    if not missing:
        return []
    from .db import SessionLocal

    fixed: list[str] = []
    async with SessionLocal() as session:
        rows = (await session.execute(select(Skill).where(Skill.name.in_(missing)))).scalars().all()
        for row in rows:
            write_skill_files(row, root)
            fixed.append(row.name)
    if fixed:
        logger.warning("技能目录缺失，已按库里的正文补写：%s", "、".join(sorted(fixed)))
    return fixed


def _is_agent_skill(row: Skill) -> bool:
    src = row.source if isinstance(row.source, dict) else {}
    return str(src.get("type", "")).lower() == "agent"


def _last_seen(row: Skill) -> int:
    return int(row.last_used_at or 0) or int(row.updated_at or 0) or int(row.created_at or 0)


async def archive_skill(db: AsyncSession, row: Skill) -> bool:
    """把技能从运行时撤下：目录移走，库里留全文。"""
    slug = row.name
    src = skills_dir() / slug
    dst = archive_dir() / slug
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        # 同名归档残留：先让开（搬到带时间戳的名字，不删）
        shutil.move(str(dst), f"{dst}.{now_ms()}")
    if src.exists():
        shutil.move(str(src), str(dst))
    row.state = "archived"
    row.archived_at = now_ms()
    row.archive_path = str(dst)
    row.updated_at = now_ms()
    logger.info("技能已归档：%s → %s", slug, dst)
    return True


async def restore_skill(db: AsyncSession, row: Skill) -> bool:
    """恢复：目录搬回技能库；目录不在了就按库里的正文重建（所以永远不会丢）。"""
    slug = row.name
    dst = skills_dir() / slug
    stored = Path(row.archive_path) if row.archive_path else archive_dir() / slug
    dst.mkdir(parents=True, exist_ok=True)
    if stored.exists() and stored != dst:
        for item in stored.iterdir():
            shutil.move(str(item), str(dst / item.name))
        try:
            stored.rmdir()
        except OSError:
            pass
    skill_md = dst / "SKILL.md"
    if not skill_md.exists() and row.content:
        skill_md.write_text(row.content, encoding="utf-8")
    row.state = "active"
    row.archived_at = None
    row.archive_path = ""
    row.updated_at = now_ms()
    logger.info("技能已恢复：%s", slug)
    return True


async def sweep(db: AsyncSession, now: int | None = None, *, force: bool = False) -> dict:
    """扫一遍：该放缓的放缓、该撤下的撤下。返回这一轮做了什么。"""
    now = now_ms() if now is None else now
    rows = list((await db.execute(select(Skill))).scalars())
    done = {"stale": [], "archived": [], "skipped": 0}

    for row in rows:
        if not _is_agent_skill(row) or row.pinned:
            done["skipped"] += 1
            continue
        idle_days = (now - _last_seen(row)) / DAY_MS
        if row.state != "archived" and idle_days >= ARCHIVE_AFTER_DAYS:
            await archive_skill(db, row)
            done["archived"].append(row.name)
        elif row.state == "active" and idle_days >= STALE_AFTER_DAYS:
            row.state = "stale"
            row.updated_at = now
            done["stale"].append(row.name)

    if done["stale"] or done["archived"]:
        await db.commit()
    LAST_SWEEP["at"] = now
    return done


async def maybe_sweep(now: int | None = None) -> dict | None:
    """调度循环里调：没到间隔就什么都不做（廉价，几微秒）。"""
    now = now_ms() if now is None else now
    if now - int(LAST_SWEEP.get("at") or 0) < SWEEP_EVERY_MS:
        return None
    from .db import SessionLocal

    try:
        async with SessionLocal() as db:
            return await sweep(db, now)
    except Exception:  # noqa: BLE001 —— 整理失败绝不能影响调度主循环
        logger.exception("技能整理这一轮出错（继续）")
        return None


def stats(rows: list[Skill]) -> dict:
    out = {"total": 0, "active": 0, "stale": 0, "archived": 0, "pinned": 0, "agent": 0}
    for r in rows:
        out["total"] += 1
        state = r.state if r.state in ("active", "stale", "archived") else "active"
        out[state] += 1
        if r.pinned:
            out["pinned"] += 1
        if _is_agent_skill(r):
            out["agent"] += 1
    return out
