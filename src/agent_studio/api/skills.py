"""Skill 资源路由：导入（本地/Git/URL/内联）、列表、详情。"""

from __future__ import annotations

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
from ..db import get_session
from ..models import AgentSkill, Skill, now_ms
from ..schemas import (
    SkillImportRequest,
    SkillInstallRequest,
    SkillRead,
    SkillScanRequest,
    SkillUpdateRequest,
)
from ..skills_repo import (
    fetch_repo_tarball,
    parse_repo_ref,
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


@router.post("/scan")
async def scan_repo(payload: SkillScanRequest) -> dict:
    """预览仓库里有哪些技能（安装前先看一眼，别装一堆用不上的）。

    对应社区 CLI 的 ``npx skills add owner/repo --list``。
    """
    ref, entries, meta = await _resolve_and_scan(payload.ref, payload.ref_pin)
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
    - ``paths``：勾选的技能（仓库内目录）；给技能名也认（等价 ``--skill``）
    - 仓库里有多个技能又没勾选、也没 ``all`` → 409 + 候选清单让用户选：
      **不偷偷全装** —— skill 的 description 会常驻助手提示词，装什么得他点头
    """
    ref, entries, meta = await _resolve_and_scan(payload.ref, payload.ref_pin)

    want = payload.paths or ([payload.skill] if payload.skill else None)
    if want:
        try:
            chosen = pick_skills(entries, paths=want)
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    elif len(entries) == 1 or payload.all:
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

    return {
        "repo": meta["slug"],
        "ref": meta["ref"],
        "sha": meta.get("sha"),
        "count": len(installed),
        "items": installed,
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
