"""Skill 资源路由：导入（本地/Git/URL/内联）、列表、详情。"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
from pathlib import Path

import httpx
import yaml
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db import SessionLocal, get_session
from ..models import AgentSkill, Skill, now_ms
from ..schemas import (
    CliInstallRequest,
    SkillImportRequest,
    SkillInstallRequest,
    SkillRead,
    SkillScanRequest,
    SkillUpdateRequest,
)
from ..skills_repo import (
    fetch_repo_tarball,
    parse_repo_ref,
    parse_skills_cmd,
    pick_skills,
    resolve_head,
    scan_tarball,
    tarball_sha,
)

router = APIRouter(prefix="/api/skills", tags=["skills"])

_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)


def to_read(row: Skill) -> SkillRead:
    return SkillRead(
        id=row.id,
        name=row.name,
        description=row.description or "",
        source=row.source or {},
        content=row.content or "",
        files=row.files or {},
        created_at=row.created_at,
        updated_at=row.updated_at,
        use_count=int(row.use_count or 0),
        last_used_at=row.last_used_at,
        state=row.state or "active",
        pinned=bool(row.pinned),
        archived_at=row.archived_at,
    )


def parse_skill_md(text: str, fallback_name: str) -> tuple[str, str]:
    """解析 SKILL.md 的 YAML frontmatter → (name, description)。

    与 Claude Code / Hermes / AgentScope 的 skill 格式一致。
    """
    name, description = fallback_name, ""
    m = _FRONTMATTER.match(text)
    if m:
        try:
            meta = yaml.safe_load(m.group(1)) or {}
            if isinstance(meta, dict):
                name = str(meta.get("name") or name)
                description = str(meta.get("description") or "")
        except yaml.YAMLError:
            pass
    if not description:
        # 退化：取正文第一个非空、非标题行
        body = _FRONTMATTER.sub("", text)
        for line in body.splitlines():
            s = line.strip()
            if s and not s.startswith("#"):
                description = s[:200]
                break
    return name, description


# --------------------------------------------------------------------------- #
@router.get("", response_model=list[SkillRead])
async def list_skills(session: AsyncSession = Depends(get_session)) -> list[SkillRead]:
    rows = (await session.execute(select(Skill).order_by(Skill.updated_at.desc()))).scalars().all()
    return [to_read(r) for r in rows]


# --------------------------------------------------------------------------- #
# npx 影子命令 —— 让「没有 Node 的机器」也能跑 npx skills add …
# --------------------------------------------------------------------------- #
_SHIM_CANDIDATES = (
    Path(__file__).resolve().parents[1] / "assets" / "studio-npx.sh",   # 随包走（推荐）
    Path(__file__).resolve().parents[3] / "scripts" / "studio-npx.sh",  # 源码树
)
# 这些名字都装一份：npx/pnpx/bunx 是「别人文档里写的」，skills 是 CLI 自己的名字
_SHIM_NAMES = ("npx", "pnpx", "bunx", "skills")


def _shim_text() -> str:
    for p in _SHIM_CANDIDATES:
        if p.is_file():
            return p.read_text(encoding="utf-8")
    raise HTTPException(
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        "找不到影子命令脚本（studio-npx.sh），这个安装包可能不完整",
    )


def _default_shim_dir() -> Path:
    """默认装到 ~/.local/bin —— 用户级、不需要 root、多数发行版默认在 PATH 里。"""
    return Path(os.path.expanduser("~/.local/bin"))


@router.get("/cli")
async def skills_cli() -> dict:
    """影子命令的脚本内容与用法（给「本机没有 Node」的部署机用）。

    部署机零 Node：技能 README 里的 ``npx skills add …`` 照抄会 not found。
    把这份脚本装成 ``npx``/``skills`` 就能直接跑 —— 它只认 skills 命令，
    其它 npm 包会转给 PATH 里真正的 npx（没有就明确报错，不假装成功）。
    """
    return {
        "dir_default": str(_default_shim_dir()),
        "names": list(_SHIM_NAMES),
        "usage": [
            "npx skills add <owner/repo[/目录]> [--skill 名] [--all] [--agent 助手名]",
            "npx skills list | remove <名> | update <引用> | find <词>",
        ],
        "env": {
            "STUDIO_URL": "平台地址（默认 http://127.0.0.1:8848）",
            "STUDIO_TOKEN": "公网访问口令（内网不用）",
            "STUDIO_PY": "自带 Python 路径（没有 curl 时用它发请求）",
        },
        "script": _shim_text(),
    }


@router.post("/cli/install")
async def install_skills_cli(payload: CliInstallRequest) -> dict:
    """把影子命令写到本机（默认 ~/.local/bin），并告诉用户怎么让 PATH 认它。

    ⚠️ **绝不覆盖已有命令**：机器上可能已经有真的 ``npx``（比如平台上自带
    Node 运行时，npx 是指向它的软链）—— 默默覆盖会把别人的工具链弄坏。
    现有同名文件一律跳过并如实报告；真想替换要显式 ``force=true``，
    替换前会先备份成 ``<名字>.studio-bak``。
    """
    target = Path(payload.dir).expanduser() if payload.dir else _default_shim_dir()
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"目录不可写: {target}（{exc}）") from exc

    text = _shim_text()
    written: list[str] = []
    skipped: list[str] = []
    unchanged: list[str] = []
    backed_up: list[str] = []
    for name in _SHIM_NAMES:
        f = target / name
        if f.exists() or f.is_symlink():
            try:
                same = f.is_file() and not f.is_symlink() and f.read_text(encoding="utf-8") == text
            except OSError:
                same = False
            if same:
                unchanged.append(str(f))
                continue
            if not payload.force:
                skipped.append(str(f))
                continue
            try:
                if f.is_symlink():
                    f.unlink()
                else:
                    bak = f.with_name(f.name + ".studio-bak")
                    if not bak.exists():
                        f.rename(bak)
                        backed_up.append(str(bak))
                    else:
                        f.unlink()
            except OSError as exc:
                skipped.append(f"{f}（备份失败：{exc}）")
                continue
        f.write_text(text, encoding="utf-8")
        f.chmod(0o755)
        written.append(str(f))

    on_path = str(target) in os.environ.get("PATH", "").split(os.pathsep)
    if on_path:
        hint = f"{target} 已在 PATH 里，直接就能用。"
    else:
        hint = f'把这个加进 shell 配置：export PATH="{target}:$PATH"'

    notes: list[str] = []
    if skipped:
        notes.append(
            "这些名字已经存在，**没有覆盖**（装上会顶掉本机已有的命令）："
            + "、".join(skipped)
            + "；确实要换成影子命令就带 force"
        )
    if unchanged:
        notes.append("已经是影子命令，没动：" + "、".join(unchanged))
    return {
        "dir": str(target),
        "written": written,
        "skipped": skipped,
        "unchanged": unchanged,
        "backed_up": backed_up,
        "on_path": on_path,
        "hint": hint,
        "notes": notes,
    }


# --------------------------------------------------------------------------- #
# 技能生命周期（整理 / 固定 / 归档 / 恢复）
# --------------------------------------------------------------------------- #
@router.get("/lifecycle")
async def skill_lifecycle() -> dict:
    """技能库体检：多少在用、多少闲置、多少已归档，以及每个技能的用量。

    为什么单独一个接口而不是塞进列表：列表是"有什么"，这里是"还该不该留"，
    两件事的读法不一样（列表要快，这里要能排序看谁最久没人用）。
    """
    from .. import skills_lifecycle as lc

    async with SessionLocal() as db:
        rows = list((await db.execute(select(Skill))).scalars())
    items = [
        {
            "id": r.id,
            "name": r.name,
            "state": r.state or "active",
            "pinned": bool(r.pinned),
            "use_count": int(r.use_count or 0),
            "last_used_at": r.last_used_at,
            "last_activity_at": lc._last_seen(r),
            "source_type": str((r.source or {}).get("type", "")),
            "agent_owned": lc._is_agent_skill(r),
            "archived_at": r.archived_at,
        }
        for r in rows
    ]
    items.sort(key=lambda x: (x["state"] != "archived", -x["use_count"], x["last_activity_at"]))
    return {
        "stats": lc.stats(rows),
        "thresholds": {"stale_days": lc.STALE_AFTER_DAYS, "archive_days": lc.ARCHIVE_AFTER_DAYS},
        "last_sweep_at": int(lc.LAST_SWEEP.get("at") or 0),
        "items": items,
    }


@router.post("/curator/run")
async def run_curator(force: bool = True) -> dict:
    """现在整理一次（界面上的「整理」按钮）。默认无视 6 小时间隔。"""
    from .. import skills_lifecycle as lc

    async with SessionLocal() as db:
        done = await lc.sweep(db, force=force)
    return done


@router.post("/{skill_id}/pin")
async def pin_skill(skill_id: str, payload: dict | None = None) -> dict:
    """固定/取消固定。固定的技能任何自动整理都不碰。"""
    pinned = True if payload is None else bool(payload.get("pinned", True))
    async with SessionLocal() as db:
        row = await db.get(Skill, skill_id)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"技能不存在: {skill_id}")
        row.pinned = pinned
        if pinned and row.state == "stale":
            row.state = "active"  # 钉住即"我在用"，顺手把闲置标签清掉
        await db.commit()
    return {"id": skill_id, "pinned": pinned, "state": row.state}


@router.post("/{skill_id}/archive")
async def archive_skill_api(skill_id: str) -> dict:
    """手动归档（从运行时撤下，内容留在库里可恢复）。固定的要先取消固定。"""
    from .. import skills_lifecycle as lc

    async with SessionLocal() as db:
        row = await db.get(Skill, skill_id)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"技能不存在: {skill_id}")
        if row.pinned:
            raise HTTPException(status.HTTP_409_CONFLICT, "这个技能被固定了，先取消固定再归档")
        await lc.archive_skill(db, row)
        await db.commit()
        return {"id": skill_id, "state": row.state, "archive_path": row.archive_path}


@router.post("/{skill_id}/restore")
async def restore_skill_api(skill_id: str) -> dict:
    from .. import skills_lifecycle as lc

    async with SessionLocal() as db:
        row = await db.get(Skill, skill_id)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"技能不存在: {skill_id}")
        await lc.restore_skill(db, row)
        await db.commit()
        return {"id": skill_id, "state": row.state}


@router.get("/{skill_id}", response_model=SkillRead)
async def get_skill(skill_id: str, session: AsyncSession = Depends(get_session)) -> SkillRead:
    row = await session.get(Skill, skill_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Skill 不存在: {skill_id}")
    return to_read(row)


@router.put("/{skill_id}")
async def update_skill(
    skill_id: str, payload: SkillUpdateRequest, session: AsyncSession = Depends(get_session)
) -> SkillRead:
    """页面自定义编辑：改正文/描述，**保存即落盘**（materialize 同步）。

    语法规范与导入路径一致：SKILL.md（YAML frontmatter 的 name/description + Markdown 正文）。
    description 是唯一会**常驻**在助手提示里的部分 —— 正文懒加载，写多细都不挤上下文。
    """
    row = await session.get(Skill, skill_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Skill 不存在: {skill_id}")

    content = row.content or ""
    if payload.content is not None:
        content = payload.content
    # 从（可能更新过的）正文重新解析 name/description —— 单一真相是 SKILL.md 本身
    name, description = parse_skill_md(content, row.name)
    if payload.name is not None:
        name = payload.name
    if payload.description is not None:
        description = payload.description

    row.name = name
    row.description = description
    row.content = content
    source = dict(row.source or {})
    source["type"] = source.get("type") or "inline"
    if source["type"] not in ("inline", "builtin", "local", "url", "git"):
        source["type"] = "inline"
    row.source = source
    row.updated_at = now_ms()
    await session.commit()
    await session.refresh(row)

    # 保存即落盘（与 materialize 端点同逻辑 —— 页面编辑不该要求用户再点一次"落盘"）
    await _materialize(row)

    return to_read(row)


@router.delete("/{skill_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_skill(skill_id: str, session: AsyncSession = Depends(get_session)) -> None:
    row = await session.get(Skill, skill_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Skill 不存在: {skill_id}")
    await session.execute(delete(AgentSkill).where(AgentSkill.skill_id == skill_id))
    await session.delete(row)
    await session.commit()


# --------------------------------------------------------------------------- #
# 共用：入库 + 落盘
# --------------------------------------------------------------------------- #
async def _materialize(row: Skill) -> Path:
    """把 Skill 落盘到工作目录（运行时 LocalSkillLoader 读的是这里）。

    **只进 DB 不落盘 = 助手看不见这个 skill** —— 所以导入/编辑/安装三处都要调。
    """
    target = settings.work_dir / "skills" / row.name
    target.mkdir(parents=True, exist_ok=True)
    (target / "SKILL.md").write_text(row.content or "", encoding="utf-8")
    for rel, text in (row.files or {}).items():
        f = target / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text, encoding="utf-8")
    return target


async def _upsert_skill(
    session: AsyncSession,
    *,
    content: str,
    files: dict[str, str],
    fallback_name: str,
    source_meta: dict,
) -> tuple[Skill, bool]:
    """按**名字**幂等：同名视为同一技能的新版本（重装/更新都走这里）。"""
    name, description = parse_skill_md(content, fallback_name)
    exists = (await session.execute(select(Skill).where(Skill.name == name))).scalar_one_or_none()
    if exists is not None:
        exists.content = content
        exists.description = description
        exists.files = files
        exists.source = source_meta
        exists.updated_at = now_ms()
        return exists, True
    row = Skill(
        name=name,
        description=description,
        source=source_meta,
        content=content,
        files=files,
    )
    session.add(row)
    await session.flush()
    return row, False


# --------------------------------------------------------------------------- #
# 导入
# --------------------------------------------------------------------------- #
def _collect_from_dir(root: Path, subpath: str | None = None) -> list[dict]:
    """扫描目录下所有含 SKILL.md 的子目录。"""
    base = root / subpath if subpath else root
    if not base.exists():
        raise ValueError(f"路径不存在: {base}")

    # 自身就是 skill
    if (base / "SKILL.md").is_file():
        candidates = [base]
    else:
        candidates = [p.parent for p in base.rglob("SKILL.md") if ".git" not in p.parts]

    if not candidates:
        raise ValueError(f"未找到 SKILL.md（目录: {base}）")

    found: list[dict] = []
    for folder in candidates[:100]:
        text = (folder / "SKILL.md").read_text(encoding="utf-8", errors="ignore")
        extras: dict[str, str] = {}
        for f in folder.rglob("*"):
            if f.is_file() and f.name != "SKILL.md" and ".git" not in f.parts:
                rel = str(f.relative_to(folder))
                try:
                    extras[rel] = f.read_text(encoding="utf-8", errors="ignore")[:200_000]
                except Exception:
                    pass
        found.append({"dir": folder.name, "content": text, "files": extras})
    return found


@router.post("/import", status_code=status.HTTP_201_CREATED)
async def import_skill(
    payload: SkillImportRequest, session: AsyncSession = Depends(get_session)
) -> dict:
    """导入 Skill。

    - ``inline``：直接给 SKILL.md 文本（页面里手写）
    - ``local`` ：服务器本地目录
    - ``url``   ：单个 SKILL.md 的 URL
    - ``git``   ：git 仓库（含 ``subpath`` 指定子目录）
    """
    try:
        if payload.source == "inline":
            if not payload.content:
                raise ValueError("inline 模式需要 content")
            items = [
                {
                    "dir": payload.name or "inline-skill",
                    "content": payload.content,
                    "files": {},
                }
            ]
            source_meta = {"type": "inline"}

        elif payload.source == "local":
            if not payload.path:
                raise ValueError("local 模式需要 path")
            items = _collect_from_dir(Path(payload.path), payload.subpath)
            source_meta = {"type": "local", "path": payload.path, "subpath": payload.subpath}

        elif payload.source == "url":
            if not payload.url:
                raise ValueError("url 模式需要 url")
            async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
                resp = await client.get(payload.url)
                resp.raise_for_status()
                text = resp.text
            items = [{"dir": payload.name or "remote-skill", "content": text, "files": {}}]
            source_meta = {"type": "url", "url": payload.url}

        elif payload.source == "git":
            if not payload.url:
                raise ValueError("git 模式需要 url")
            # 优先走 tarball（不依赖 git 二进制、不吃代理的亏，也顺带能认出
            # owner/repo 简写与网页链接）；失败再退回完整 clone。
            try:
                ref = parse_repo_ref(payload.url)
                if payload.ref:
                    ref.ref = payload.ref
                if payload.subpath:
                    ref.subpath = payload.subpath
                data, _url, root = await fetch_repo_tarball(ref)
                entries = scan_tarball(data, subpath=ref.subpath)
                items = [{"dir": e.path.rsplit("/", 1)[-1] or e.name, "content": e.content, "files": e.files} for e in entries]
                source_meta = {
                    "type": "repo",
                    "repo": ref.slug,
                    "ref": ref.ref or "HEAD",
                    "sha": tarball_sha(root),
                    "path": ref.subpath,
                    "url": ref.web_url,
                }
            except (ValueError, httpx.HTTPError):
                with tempfile.TemporaryDirectory() as tmp:
                    cmd = ["git", "clone", "--depth", "1"]
                    if payload.ref:
                        cmd += ["--branch", payload.ref]
                    cmd += [payload.url, tmp]
                    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
                    if proc.returncode != 0:
                        raise ValueError(f"git clone 失败: {proc.stderr.strip()[:300]}")
                    items = _collect_from_dir(Path(tmp), payload.subpath)
                    sha = subprocess.run(
                        ["git", "-C", tmp, "rev-parse", "HEAD"], capture_output=True, text=True
                    ).stdout.strip()
                source_meta = {
                    "type": "git",
                    "url": payload.url,
                    "ref": payload.ref,
                    "subpath": payload.subpath,
                    "sha": sha,
                }
        else:  # pragma: no cover
            raise ValueError(f"未知来源类型: {payload.source}")

    except (ValueError, httpx.HTTPError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    imported: list[dict] = []
    for item in items:
        row, updated = await _upsert_skill(
            session,
            content=item["content"],
            files=item["files"],
            fallback_name=item["dir"],
            source_meta=source_meta,
        )
        imported.append({"id": row.id, "name": row.name, "updated": updated})

    await session.commit()

    # 导入即落盘：运行时的 LocalSkillLoader 读的是 data/work/skills/<name>/SKILL.md，
    # 只进 DB 不落盘 = 助手看不见这个 skill。
    for item in imported:
        row = await session.get(Skill, item["id"])
        if row is not None:
            await _materialize(row)

    return {"source": payload.source, "count": len(imported), "items": imported}


@router.post("/{skill_id}/materialize")
async def materialize_skill(skill_id: str, session: AsyncSession = Depends(get_session)) -> dict:
    """把 Skill 落盘到工作目录（Agent 运行时通过 LocalSkillLoader 读取）。"""
    row = await session.get(Skill, skill_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Skill 不存在: {skill_id}")
    target = await _materialize(row)
    return {"ok": True, "path": str(target)}


# --------------------------------------------------------------------------- #
# 从仓库安装 —— 「像 npx skills add 那样一条引用装进来」
# --------------------------------------------------------------------------- #
_MISSING_REF = "要装什么？给一条引用（owner/repo）或整条命令（npx skills add owner/repo）"


def _from_command(command: str | None, ref: str | None, skill: str | None, all_: bool, agents: list[str] | None):
    """命令优先于引用 —— 用户手里常是 README 里那一行 ``npx skills add …``。

    命令里的 ``--skill/--all/--agent`` 一并采纳；显式给的字段覆盖命令里的。
    """
    if not command:
        return ref, skill, all_, agents
    try:
        parsed = parse_skills_cmd(command)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    if parsed is None:
        # 不是 skills 命令：当成纯引用用（用户可能只粘了 owner/repo）
        return ref or command.strip(), skill, all_, agents
    if parsed.action not in ("add", "list", "find"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"这条命令是 skills {parsed.action} —— 平台上请用「更新」按钮或删除按钮，别用 install 接口",
        )
    merged_agents = list(agents or []) + [a for a in parsed.agents if a not in (agents or [])]
    return parsed.ref or ref, skill or parsed.skill, bool(all_ or parsed.all), merged_agents


async def _resolve_and_scan(ref_text: str, ref_pin: str | None):
    """解析引用 → 下 tarball → 扫技能。返回 (RepoRef, [SkillEntry], meta)。"""
    try:
        ref = parse_repo_ref(ref_text)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    if ref_pin:
        ref.ref = ref_pin.strip() or None

    try:
        data, url_used, root = await fetch_repo_tarball(ref)
        entries = scan_tarball(data, subpath=ref.subpath)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"仓库下载失败: {exc}") from exc

    meta = await resolve_head(ref)
    if not meta.get("sha"):
        meta["sha"] = tarball_sha(root)      # 从包名兜底（archify-<sha>）
    meta["url_used"] = url_used
    meta["web_url"] = ref.web_url
    meta["slug"] = ref.slug
    meta["ref"] = ref.ref or meta.get("default_branch") or "HEAD"
    meta["subpath"] = ref.subpath
    return ref, entries, meta


def _repo_source(meta: dict, entry_path: str) -> dict:
    """来源记录 —— 「更新」按钮靠它回原仓库取新版本，所以字段要齐。"""
    url = f"https://github.com/{meta['slug']}"
    if entry_path:
        url += f"/tree/{meta['ref']}/{entry_path}"
    return {
        "type": "repo",
        "repo": meta["slug"],
        "ref": meta["ref"],
        "sha": meta.get("sha"),
        "path": entry_path,
        "url": url,
    }


async def _attach_to_agents(
    session: AsyncSession, skill_ids: list[str], names: list[str]
) -> tuple[list[str], list[str]]:
    """把技能挂到助手（``--agent <名字>``）。

    返回 (挂上的, 没找到的)。找名字或 slug 都认；找不到只警告不失败 ——
    技能已经装好了，为了一个拼错的助手名把整条命令判失败不合算。

    ⚠️ 必须改 **definition.skills**，不能只往 agent_skill 关联表里插：
    平台的关联表是**从定义派生的**（``_sync_relations`` 全量重建），
    只插表的话，用户下次在页面上点一次保存，这个技能就被抹掉了。
    """
    from ..models import Agent
    from ..revisions import KIND_AGENT, snapshot

    attached: list[str] = []
    missing: list[str] = []
    for raw in names:
        want = (raw or "").strip()
        if not want:
            continue
        row = (await session.execute(select(Agent).where(Agent.name == want))).scalar_one_or_none()
        if row is None:
            row = (await session.execute(select(Agent).where(Agent.slug == want))).scalar_one_or_none()
        if row is None:
            missing.append(want)
            continue

        defn = dict(row.definition or {})
        refs = [r for r in (defn.get("skills") or []) if isinstance(r, dict)]
        have = {str(r.get("ref")) for r in refs}
        fresh = [sid for sid in skill_ids if sid not in have]
        if fresh:
            defn["skills"] = refs + [{"ref": sid, "enabled": True} for sid in fresh]
            row.definition = defn
            row.version = (row.version or 1) + 1
            row.updated_at = now_ms()
            for sid in fresh:
                session.add(AgentSkill(agent_id=row.id, skill_id=sid))
            await snapshot(session, KIND_AGENT, row.id)
        attached.append(row.name)
    if attached:
        await session.commit()
    return attached, missing


@router.post("/scan")
async def scan_repo(payload: SkillScanRequest) -> dict:
    """预览仓库里有哪些技能（安装前先看一眼，别装一堆用不上的）。

    对应社区 CLI 的 ``npx skills add owner/repo --list``；``command`` 可直接粘整条命令。
    """
    ref_text, _skill, _all, _agents = _from_command(payload.command, payload.ref, None, False, None)
    if not ref_text:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, _MISSING_REF)
    ref, entries, meta = await _resolve_and_scan(ref_text, payload.ref_pin)
    return {
        "repo": meta["slug"],
        "ref": meta["ref"],
        "sha": meta.get("sha"),
        "description": meta.get("description"),
        "stars": meta.get("stars"),
        "license": meta.get("license"),
        "web_url": meta["web_url"],
        "download": meta["url_used"],
        "skills": [e.brief() for e in entries],
    }


@router.post("/install", status_code=status.HTTP_201_CREATED)
async def install_from_repo(
    payload: SkillInstallRequest, session: AsyncSession = Depends(get_session)
) -> dict:
    """从 GitHub 仓库安装技能。

    - ``ref``：``owner/repo``、``owner/repo/skills/foo``、``owner/repo@v1.2.0``
    - ``command``：整条命令（``npx skills add owner/repo --skill x --agent 通用助手``）；
      **没有 Node 的机器**跑的就是本接口（见 /api/skills/cli 的影子命令）
    - ``paths``：勾选的技能（仓库内目录）；给技能名也认（等价 ``--skill``）
    - 仓库里有多个技能又没勾选、也没 ``all`` → 409 + 候选清单让用户选：
      **不偷偷全装** —— skill 的 description 会常驻助手提示词，装什么得他点头
    """
    ref_text, skill, all_, agents = _from_command(
        payload.command, payload.ref, payload.skill, payload.all, payload.agents
    )
    if not ref_text:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, _MISSING_REF)
    _ref, entries, meta = await _resolve_and_scan(ref_text, payload.ref_pin)

    want = payload.paths or ([skill] if skill else None)
    if want:
        try:
            chosen = pick_skills(entries, paths=want)
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    elif len(entries) == 1 or all_:
        chosen = entries
    else:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "message": f"这个仓库里有 {len(entries)} 个技能，选一个再装",
                "skills": [e.brief() for e in entries],
            },
        )

    installed: list[dict] = []
    for entry in chosen:
        row, updated = await _upsert_skill(
            session,
            content=entry.content,
            files=entry.files,
            fallback_name=entry.path.rsplit("/", 1)[-1] or entry.name,
            source_meta=_repo_source(meta, entry.path),
        )
        installed.append({"id": row.id, "name": row.name, "updated": updated, "path": entry.path})

    await session.commit()

    for item in installed:
        row = await session.get(Skill, item["id"])
        if row is not None:
            item["materialized"] = str(await _materialize(row))

    attached: list[str] = []
    missing: list[str] = []
    if agents:
        attached, missing = await _attach_to_agents(session, [i["id"] for i in installed], agents)

    return {
        "repo": meta["slug"],
        "ref": meta["ref"],
        "sha": meta.get("sha"),
        "count": len(installed),
        "items": installed,
        "attached": attached,
        "agents_missing": missing,
    }


@router.post("/{skill_id}/reinstall")
async def reinstall_skill(skill_id: str, session: AsyncSession = Depends(get_session)) -> dict:
    """按安装时记下的来源重装一遍（= 更新到最新）。

    没有来源记录（内联手写的）就没有可更新之处 —— 直说，别假装成功。
    """
    row = await session.get(Skill, skill_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Skill 不存在: {skill_id}")
    src = row.source or {}
    if src.get("type") != "repo" or not src.get("repo"):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "这个技能不是从仓库装的，没有可更新的来源（内联/本地导入的要自己重传）",
        )
    ref_text = str(src["repo"]) + (f"/{src['path']}" if src.get("path") else "")
    _ref, entries, meta = await _resolve_and_scan(ref_text, None)
    if not entries:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "来源仓库里已经找不到这个技能了")
    entry = entries[0]
    row.content = entry.content
    row.files = entry.files
    row.description = parse_skill_md(entry.content, row.name)[1]
    row.source = _repo_source(meta, entry.path)
    row.updated_at = now_ms()
    await session.commit()
    await session.refresh(row)
    await _materialize(row)
    return {"ok": True, "id": row.id, "name": row.name, "ref": meta["ref"], "sha": meta.get("sha")}
