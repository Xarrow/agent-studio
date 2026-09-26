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
from ..schemas import SkillImportRequest, SkillRead, SkillUpdateRequest

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
    target = settings.work_dir / "skills" / row.name
    target.mkdir(parents=True, exist_ok=True)
    (target / "SKILL.md").write_text(row.content or "", encoding="utf-8")
    for rel, text in (row.files or {}).items():
        f = target / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text, encoding="utf-8")

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
        name, description = parse_skill_md(item["content"], item["dir"])
        exists = (await session.execute(select(Skill).where(Skill.name == name))).scalar_one_or_none()
        if exists is not None:
            exists.content = item["content"]
            exists.description = description
            exists.files = item["files"]
            exists.source = source_meta
            exists.updated_at = now_ms()
            imported.append({"id": exists.id, "name": name, "updated": True})
        else:
            row = Skill(
                name=name,
                description=description,
                source=source_meta,
                content=item["content"],
                files=item["files"],
            )
            session.add(row)
            await session.flush()
            imported.append({"id": row.id, "name": name, "updated": False})

    await session.commit()
    return {"source": payload.source, "count": len(imported), "items": imported}


@router.post("/{skill_id}/materialize")
async def materialize_skill(skill_id: str, session: AsyncSession = Depends(get_session)) -> dict:
    """把 Skill 落盘到工作目录（Agent 运行时通过 LocalSkillLoader 读取）。"""
    row = await session.get(Skill, skill_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Skill 不存在: {skill_id}")

    target = settings.work_dir / "skills" / row.name
    target.mkdir(parents=True, exist_ok=True)
    (target / "SKILL.md").write_text(row.content or "", encoding="utf-8")
    for rel, text in (row.files or {}).items():
        f = target / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text, encoding="utf-8")
    return {"ok": True, "path": str(target)}
