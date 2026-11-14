"""编排层：模式选择、取回、发现、安装、检查更新、更新、诊断。

原则
====
- 安装一律交给既有导入管线（``api/skills.py`` 的 ``_upsert_skill`` +
  ``_materialize``）：预览/冲突/原子落盘/来源记录都在那里，这里不复制。
- 两种模式（npx 委托 / 原生）产出的 **技能内容与记录字段一致**；
  委托模式只是"换了一双手去取内容"，写库仍走同一条管线。
- 失败原因带错误码，界面据此给下一步；不做"看起来可以"的猜测。
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Skill, now_ms
from . import fetch as fetchmod
from .discover import DiscoveredSkill, discover, pick
from .netpolicy import NetError, NetPolicy
from .parser import SourceError, SourceRef, parse_source
from .platforms import platform_for
from .store import (
    DEFAULT_CHECK_INTERVAL_H,
    CHECK_INTERVAL_KEY,
    MODE_KEY,
    NET_KEY,
    NPX_ALLOW_LATEST_KEY,
    NPX_PIN_KEY,
    PLATFORMS_KEY,
    SkillSource,
    token_of,
)

#: 委托模式允许的子命令与开关（白名单，超出即拒绝）
ALLOWED_ACTIONS = {"add", "list", "check", "update", "remove"}
ALLOWED_FLAGS = {"--skill", "-s", "--agent", "-a", "--global", "-g", "--yes", "-y", "--list", "--all"}

_ENV_CACHE: dict[str, Any] = {"at": 0.0, "value": {}}
ENV_TTL = 600.0


# --------------------------------------------------------------------------- #
# 环境探测
# --------------------------------------------------------------------------- #
def probe_environment(*, refresh: bool = False) -> dict[str, Any]:
    """npx / npm / git / node 是否可用（缓存 10 分钟）。"""
    now = time.time()
    if not refresh and _ENV_CACHE["value"] and now - _ENV_CACHE["at"] < ENV_TTL:
        return _ENV_CACHE["value"]

    def ver(cmd: str, args: list[str]) -> str:
        exe = shutil.which(cmd)
        if not exe:
            return ""
        try:
            out = subprocess.run([exe, *args], capture_output=True, text=True, timeout=10)
            return (out.stdout or out.stderr).strip().split("\n")[0][:80]
        except Exception:  # noqa: BLE001
            return ""

    value = {
        "npx": shutil.which("npx") or "",
        "npm": shutil.which("npm") or "",
        "git": shutil.which("git") or "",
        "node": shutil.which("node") or "",
        "versions": {
            "node": ver("node", ["--version"]),
            "npm": ver("npm", ["--version"]),
            "git": ver("git", ["--version"]),
        },
    }
    _ENV_CACHE.update({"at": now, "value": value})
    return value


async def choose_mode(session: AsyncSession) -> tuple[str, str]:
    """返回 (实际使用的模式, 原因)。auto 的判定逻辑见 docs/decisions/。"""
    from ..settings_store import get_setting

    want = str(await get_setting(session, MODE_KEY, "auto") or "auto")
    env = probe_environment()
    pin = str(await get_setting(session, NPX_PIN_KEY, "") or "")
    if want == "native":
        return "native", "设置为 native"
    if want == "npx":
        if not env["npx"]:
            return "npx", "设置为 npx，但本机没有 npx"
        return "npx", "设置为 npx"
    # auto
    if env["npx"] and pin:
        return "npx", f"npx 可用，固定版本 {pin}"
    if env["npx"] and not pin:
        return "native", "npx 可用但没配置固定版本（默认走原生，避免拉到未验证的 CLI）"
    return "native", "本机没有 npx"


async def net_policy_for(session: AsyncSession, source: SkillSource | None = None) -> NetPolicy:
    from ..settings_store import get_setting

    base = dict(await get_setting(session, NET_KEY, {}) or {})
    if source is not None and source.net_policy:
        base.update(source.net_policy or {})
    return NetPolicy.from_settings(base)


async def platforms_config(session: AsyncSession) -> list[dict[str, Any]]:
    from ..settings_store import get_setting

    raw = await get_setting(session, PLATFORMS_KEY, []) or []
    return raw if isinstance(raw, list) else []


# --------------------------------------------------------------------------- #
# 解析 + 取回
# --------------------------------------------------------------------------- #
async def resolve_source(session: AsyncSession, raw: str) -> tuple[SourceRef, SkillSource | None]:
    rows = list((await session.execute(select(SkillSource))).scalars())
    ref = parse_source(raw, sources=rows)
    row = next((r for r in rows if r.id == ref.source_id), None)
    if row is not None:
        # 已登记来源：补上登记的仓库信息与 ref
        ref.host = ref.host or row.host
        ref.owner = ref.owner or row.owner
        ref.repo = ref.repo or row.repo
        ref.ref = ref.ref or (row.ref or None)
        ref.subpath = ref.subpath or (row.subpath or None)
    return ref, row


async def load_skills(
    session: AsyncSession,
    raw: str,
    *,
    ref_override: str | None = None,
    subpath_override: str | None = None,
    token_override: str | None = None,
) -> tuple[SourceRef, list[DiscoveredSkill], dict[str, Any]]:
    """解析 → 取回 → 发现。返回 (ref, 候选, 元信息)。"""
    ref, row = await resolve_source(session, raw)
    if ref_override:
        ref.ref = ref_override
    if subpath_override:
        ref.subpath = subpath_override
    policy = await net_policy_for(session, row)
    platforms = await platforms_config(session)
    token = token_override if token_override is not None else (token_of(row) if row else "")

    if ref.kind == "local":
        base = Path(ref.raw).expanduser()
        if not base.exists():
            raise SourceError("local_not_found", f"本地路径不存在：{base}")
        entries = discover(base, subpath=ref.subpath)
        meta = {"via": "local", "commit": "", "integrity": "local"}
    else:
        fetched = await fetchmod.fetch(ref, policy=policy, platforms=platforms, token=token)
        try:
            entries = discover(fetched.root, subpath=ref.subpath)
            meta = {
                "via": fetched.via,
                "commit": fetched.commit,
                "integrity": fetched.integrity,
                "url": fetched.url_used,
                "notes": fetched.notes,
            }
        finally:
            fetched.cleanup()

    if not entries:
        where = f"目录 {ref.subpath}/" if ref.subpath else "这个来源"
        raise SourceError("no_skills", f"{where}里没找到含 SKILL.md 的技能", "确认地址指向技能仓库，或指定子目录")
    return ref, entries, meta


# --------------------------------------------------------------------------- #
# 安装（复用导入管线）
# --------------------------------------------------------------------------- #
async def install(
    session: AsyncSession,
    raw: str,
    *,
    skills: list[str] | None = None,
    paths: list[str] | None = None,
    ref_override: str | None = None,
    subpath_override: str | None = None,
    mode: str | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    ref, entries, meta = await load_skills(
        session, raw, ref_override=ref_override, subpath_override=subpath_override
    )
    chosen = pick(entries, skills=skills, paths=paths)
    used_mode = mode or (await choose_mode(session))[0]

    planned = []
    for s in chosen:
        existing = (
            await session.execute(select(Skill).where(Skill.name == s.name))
        ).scalar_one_or_none()
        planned.append(
            {
                "name": s.name,
                "path": s.path,
                "action": "overwrite" if existing else "create",
                "existing_id": existing.id if existing else None,
            }
        )
    if dry_run:
        return {"ref": ref.to_dict(), "meta": meta, "mode": used_mode, "plan": planned}

    from ..api.skills import _materialize, _upsert_skill

    source_meta = {
        "type": "repo",
        "source_id": ref.source_id,
        "repo": ref.slug,
        "host": ref.host,
        "ref": ref.ref or "HEAD",
        "subpath": ref.subpath,
        "sha": meta.get("commit") or "",
        "commit": meta.get("commit") or "",
        "integrity": meta.get("integrity") or "verified",
        "mode": used_mode,
        "via": meta.get("via") or "",
        "url": meta.get("url") or "",
        # 原始地址：更新时要"回到同一个来源"，不能靠猜
        "address": ref.raw,
        "installed_at": now_ms(),
    }
    out = []
    for s in chosen:
        row, updated = await _upsert_skill(
            session, content=s.content, files=s.files, fallback_name=s.path.rsplit("/", 1)[-1] or s.name,
            source_meta={**source_meta, "content_hash": s.content_hash, "path": s.path},
        )
        out.append({"id": row.id, "name": row.name, "updated": updated})
    await session.commit()
    for item in out:
        row = await session.get(Skill, item["id"])
        if row is not None:
            await _materialize(row)
    return {"ref": ref.to_dict(), "meta": meta, "mode": used_mode, "installed": out}


# --------------------------------------------------------------------------- #
# 检查更新 / 更新
# --------------------------------------------------------------------------- #
def _remote_of(skill: Skill) -> dict[str, Any] | None:
    src = skill.source or {}
    if src.get("type") not in ("repo", "git", "github", "gitlab", "local"):
        return None
    if src.get("type") == "local":
        return None
    return src


async def check_updates(session: AsyncSession, *, force: bool = False) -> list[dict[str, Any]]:
    from ..settings_store import get_setting

    interval_h = float(await get_setting(session, CHECK_INTERVAL_KEY, DEFAULT_CHECK_INTERVAL_H) or 6)
    now = now_ms()
    rows = list((await session.execute(select(Skill))).scalars())
    out: list[dict[str, Any]] = []
    for sk in rows:
        src = _remote_of(sk)
        if not src:
            continue
        last = src.get("check") or {}
        if not force and last.get("at") and now - int(last["at"]) < interval_h * 3600_000:
            out.append(
                {
                    "id": sk.id,
                    "name": sk.name,
                    "status": "cached",
                    "has_update": bool(last.get("has_update")),
                    "latest_commit": last.get("latest_commit") or "",
                    "checked_at": last.get("at"),
                }
            )
            continue
        try:
            ref = SourceRef(
                kind="github" if (src.get("host") or "github.com") == "github.com" else "git",
                host=src.get("host") or "github.com",
                owner=(src.get("repo") or "/").split("/")[0],
                repo=(src.get("repo") or "/").split("/")[-1],
                ref=(src.get("ref") or None) if src.get("ref") not in (None, "HEAD") else None,
                subpath=src.get("subpath") or None,
            )
            policy = await net_policy_for(session)
            platforms = await platforms_config(session)
            latest = await fetchmod.resolve_commit(ref, policy=policy, platforms=platforms)
            status = "ok"
            has_update = False
            same_commit = bool(latest and src.get("commit") and latest == src.get("commit"))
            if not same_commit:
                # 提交变了（或当初没记下提交）不算更新：还要技能目录的内容哈希也变，
                # 否则仓库里改 README、改别的技能都会被误报成"你的技能有更新"。
                try:
                    fetched = await fetchmod.fetch(ref, policy=policy, platforms=platforms)
                    try:
                        got = discover(fetched.root, subpath=ref.subpath)
                        target = next((g for g in got if g.name == sk.name), None)
                        if target and target.content_hash != (src.get("content_hash") or ""):
                            has_update = True
                    finally:
                        fetched.cleanup()
                except Exception as exc:  # noqa: BLE001
                    status = getattr(exc, "code", "fetch_failed")
            src["check"] = {"at": now, "has_update": has_update, "latest_commit": latest, "status": status}
            sk.source = dict(src)
            out.append(
                {
                    "id": sk.id,
                    "name": sk.name,
                    "status": status,
                    "has_update": has_update,
                    "latest_commit": latest,
                    "checked_at": now,
                }
            )
        except Exception as exc:  # noqa: BLE001
            out.append(
                {"id": sk.id, "name": sk.name, "status": getattr(exc, "code", "error"), "has_update": False, "message": str(exc)[:200]}
            )
    await session.commit()
    return out


async def update_skill(session: AsyncSession, skill_id: str) -> dict[str, Any]:
    sk = await session.get(Skill, skill_id)
    if sk is None:
        raise ValueError("技能不存在")
    src = _remote_of(sk)
    if not src:
        raise ValueError("这个技能没有远程来源，不能更新")
    # 更新必须回到**同一个来源**：优先用当初登记的来源地址（本地路径/企业实例都在里面），
    # 其次才用 repo 简写。绝不能因为主机名相同的另一个来源就换源。
    raw = ""
    sid = src.get("source_id")
    if sid:
        row = await session.get(SkillSource, sid)
        if row is not None and row.address:
            raw = row.address
    if not raw:
        raw = src.get("address") or src.get("url") or ""
    if not raw and src.get("repo"):
        raw = str(src["repo"])
        if src.get("subpath"):
            raw += f"/{src['subpath']}"
        if src.get("ref") and src["ref"] != "HEAD":
            raw += f"#{src['ref']}"
    if not raw:
        raise ValueError("这个技能没有可回访的来源地址，无法更新")
    res = await install(session, raw, skills=[sk.name])
    return {"skill_id": skill_id, "name": sk.name, **res}


# --------------------------------------------------------------------------- #
# 委托 npx（白名单 + 隔离 home + 收获）
# --------------------------------------------------------------------------- #
def _validate_npx_argv(action: str, extra: list[str]) -> None:
    if action not in ALLOWED_ACTIONS:
        raise ValueError(f"不允许的子命令：{action}")
    for a in extra:
        if a.startswith("-") and a not in ALLOWED_FLAGS:
            raise ValueError(f"不允许的参数：{a}")


async def run_via_npx(
    session: AsyncSession,
    raw: str,
    *,
    action: str = "add",
    extra_argv: list[str] | None = None,
    timeout: float = 300.0,
) -> dict[str, Any]:
    """在隔离环境里跑 skills CLI，产出仍交给导入管线。

    - 固定版本来自设置（未配置则调用方不该选 npx）；
    - HOME 换成临时目录，CLI 写不到用户的技能目录；
    - 只允许白名单参数，不经 shell。
    """
    from ..settings_store import get_setting

    pin = str(await get_setting(session, NPX_PIN_KEY, "") or "")
    allow_latest = bool(await get_setting(session, NPX_ALLOW_LATEST_KEY, False))
    pkg = pin or ("skills@latest" if allow_latest else "")
    if not pkg:
        raise ValueError("没有配置 npx 的固定版本，也未允许 @latest —— 拒绝执行未验证的 CLI")
    extra = list(extra_argv or [])
    _validate_npx_argv(action, extra)

    env = probe_environment()
    if not env["npx"]:
        raise RuntimeError("npx_unavailable: 本机没有 npx")

    policy = await net_policy_for(session)
    tmp_home = Path(tempfile.mkdtemp(prefix="studio-npx-home-"))
    tmp_cwd = Path(tempfile.mkdtemp(prefix="studio-npx-run-"))
    argv = [env["npx"], "--yes", pkg, "skills", action]
    if action == "add":
        argv += [raw, "--yes"]
    argv += extra
    child_env = policy.npm_env()
    child_env.update(
        {
            "HOME": str(tmp_home),
            "XDG_CONFIG_HOME": str(tmp_home / ".config"),
            "SKILLS_TELEMETRY": "0",
            "DO_NOT_TRACK": "1",
            "CI": "1",
        }
    )
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=str(tmp_cwd), env=child_env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError("npx_timeout: skills CLI 超时")
        code = proc.returncode or 0
        harvested = _harvest(tmp_home, tmp_cwd)
        return {
            "mode": "npx",
            "package": pkg,
            "exit": code,
            "stdout": (out or b"").decode("utf-8", "ignore")[-4000:],
            "stderr": (err or b"").decode("utf-8", "ignore")[-4000:],
            "harvested": harvested,
        }
    finally:
        shutil.rmtree(tmp_home, ignore_errors=True)
        shutil.rmtree(tmp_cwd, ignore_errors=True)


def _harvest(home: Path, cwd: Path) -> list[dict[str, Any]]:
    """把 CLI 写进隔离目录的技能"捡"回来（只汇报，不直接入库）。"""
    found: list[dict[str, Any]] = []
    for base in (home, cwd):
        for md in base.rglob("SKILL.md"):
            if ".git" in md.parts:
                continue
            found.append({"path": str(md.parent.relative_to(base)), "dir": str(md.parent)})
            if len(found) >= 200:
                return found
    return found


# --------------------------------------------------------------------------- #
# 诊断
# --------------------------------------------------------------------------- #
async def doctor(session: AsyncSession, host: str = "github.com", *, source: SkillSource | None = None) -> dict[str, Any]:
    """按 DNS → TCP → TLS → 只读请求 的顺序体检，每步给耗时与结论。"""
    import socket
    import ssl
    import time as _t

    policy = await net_policy_for(session, source)
    env = probe_environment(refresh=True)
    steps: list[dict[str, Any]] = []

    t0 = _t.perf_counter()
    try:
        infos = await asyncio.get_event_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        steps.append({"step": "dns", "ok": True, "ms": round((_t.perf_counter() - t0) * 1000), "detail": f"{len(infos)} 条记录"})
    except Exception as exc:  # noqa: BLE001
        steps.append({"step": "dns", "ok": False, "code": "dns", "message": str(exc)[:200]})
        return {"host": host, "steps": steps, "env": env, "policy": policy.public_dict()}

    proxy = policy.proxy_for(host)
    t0 = _t.perf_counter()
    try:
        host_, port = host, 443
        if proxy:
            from urllib.parse import urlparse

            u = urlparse(proxy if "://" in proxy else f"http://{proxy}")
            host_, port = u.hostname or host, int(u.port or 8080)
        fut = asyncio.open_connection(host_, port)
        reader, writer = await asyncio.wait_for(fut, timeout=policy.connect_timeout)
        writer.close()
        steps.append(
            {"step": "tcp", "ok": True, "ms": round((_t.perf_counter() - t0) * 1000), "detail": f"{host_}:{port}{'（经代理）' if proxy else '（直连）'}"}
        )
    except Exception as exc:  # noqa: BLE001
        steps.append({"step": "tcp", "ok": False, "code": "connection_refused", "message": str(exc)[:200]})
        return {"host": host, "steps": steps, "env": env, "policy": policy.public_dict()}

    steps.append({"step": "tls", "ok": True, "detail": f"CA 文件：{policy.ca_file or '系统默认'}"})
    t0 = _t.perf_counter()
    try:
        await policy.get(f"https://{host}/", max_bytes=4096)
        steps.append({"step": "http", "ok": True, "ms": round((_t.perf_counter() - t0) * 1000)})
    except NetError as exc:
        steps.append({"step": "http", "ok": False, "code": exc.code, "message": str(exc)[:200], "hint": exc.hint})
    except Exception as exc:  # noqa: BLE001
        from .netpolicy import classify_error

        steps.append({"step": "http", "ok": False, "code": classify_error(exc), "message": str(exc)[:200]})
    steps.append({"step": "git", "ok": bool(env["git"]), "detail": env["versions"].get("git") or "未安装"})
    steps.append({"step": "npx", "ok": bool(env["npx"]), "detail": env["versions"].get("npm") or "未安装"})
    return {"host": host, "steps": steps, "env": env, "policy": policy.public_dict()}


# --------------------------------------------------------------------------- #
# 已登记来源：浏览 / 测试连接
# --------------------------------------------------------------------------- #
async def browse_source(session: AsyncSession, row: SkillSource, *, show_internal: bool = False) -> dict[str, Any]:
    """列出某个已登记来源里的技能（预览，不安装）。"""
    raw = row.address or (f"{row.owner}/{row.repo}" if row.owner else "")
    if row.kind == "local":
        raw = row.address
    ref, entries, meta = await load_skills(session, raw, subpath_override=row.subpath or None)
    return {
        "source": {"id": row.id, "name": row.name, "kind": row.kind},
        "ref": ref.to_dict(),
        "meta": meta,
        "skills": [e.brief(show_internal=show_internal) for e in entries],
    }
