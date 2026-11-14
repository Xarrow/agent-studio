"""取回内容：git 路径 / 归档路径，以及提交 ID 解析。

两条路径产出的**目录内容必须一致**（同一来源、同一 ref）—— 单测用内容哈希断言。

安全：不解压到用户技能目录、不执行仓库内脚本、拒绝路径穿越/绝对路径/
符号链接逃逸/设备文件、限制条目数与解压后总大小。
"""

from __future__ import annotations

import asyncio
import io
import os
import shutil
import subprocess
import tarfile
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .netpolicy import NetError, NetPolicy, classify_error
from .parser import SourceRef
from .platforms import archive_url, platform_for

# 资源上限（与导入管线同口径）
MAX_ARCHIVE_BYTES = 60 * 1024 * 1024
MAX_UNPACKED_BYTES = 200 * 1024 * 1024
MAX_ENTRIES = 5000
MAX_FILE_BYTES = 200_000


class FetchError(RuntimeError):
    def __init__(self, code: str, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.hint = hint


@dataclass
class Fetched:
    root: Path                       # 解出来的仓库根目录（临时目录，调用方负责清理）
    commit: str = ""
    integrity: str = "verified"      # verified | mirror-unverified
    via: str = "archive"             # archive | git
    url_used: str = ""
    notes: list[str] = field(default_factory=list)

    def cleanup(self) -> None:
        shutil.rmtree(self.root.parent if self.root.name == "repo" else self.root, ignore_errors=True)


# --------------------------------------------------------------------------- #
# 环境探测（结果由 service 层缓存）
# --------------------------------------------------------------------------- #
def which(name: str) -> str | None:
    return shutil.which(name)


def git_version() -> str:
    exe = which("git")
    if not exe:
        return ""
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=10)
        return out.stdout.strip()
    except Exception:  # noqa: BLE001
        return ""


async def git_available() -> bool:
    return bool(which("git"))


# --------------------------------------------------------------------------- #
# 路径一：git
# --------------------------------------------------------------------------- #
async def fetch_via_git(
    ref: SourceRef,
    *,
    policy: NetPolicy,
    dest: Path | None = None,
    token: str = "",
) -> Fetched:
    exe = which("git")
    if not exe:
        raise FetchError("needs_git", "本机没有 git，无法用 git 取回", "改用归档路径，或安装 git")
    # 本地来源走"开发模式"：直接 clone 本地路径（只读使用，不改它）

    tmp = dest or Path(tempfile.mkdtemp(prefix="studio-skill-git-"))
    repo_dir = tmp / "repo"
    url = _clone_url(ref)
    argv = [exe, "clone", "--depth", "1", "--filter=blob:none", "--no-tags"]
    if ref.ref:
        argv += ["--branch", ref.ref]
    if ref.subpath:
        argv += ["--sparse"]
    argv += [url, str(repo_dir)]

    env = policy.git_env()
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        _, err = await asyncio.wait_for(proc.communicate(), timeout=180)
    except asyncio.TimeoutError as exc:
        raise FetchError("timeout", "git clone 超时", "检查网络或代理") from exc
    finally:
        _scrub_gitconfig(env)

    if proc.returncode != 0:
        msg = (err or b"").decode("utf-8", "ignore").strip()[:400]
        raise FetchError(_git_code(msg), f"git clone 失败：{msg}", "确认仓库地址与权限")

    if ref.subpath:
        sub = await asyncio.create_subprocess_exec(
            exe, "-C", str(repo_dir), "sparse-checkout", "set", ref.subpath,
            env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        await sub.communicate()

    sha = ""
    try:
        p = await asyncio.create_subprocess_exec(
            exe, "-C", str(repo_dir), "rev-parse", "HEAD",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await p.communicate()
        sha = (out or b"").decode().strip()
    except Exception:  # noqa: BLE001
        sha = ""
    shutil.rmtree(repo_dir / ".git", ignore_errors=True)
    return Fetched(root=repo_dir, commit=sha, via="git", url_used=url)


def _scrub_gitconfig(env: dict[str, str]) -> None:
    p = env.get("GIT_CONFIG_GLOBAL")
    if p:
        try:
            os.unlink(p)
        except OSError:
            pass


def _clone_url(ref: SourceRef) -> str:
    """组装 clone 地址。

    令牌**不进 URL**（会被写进 .git/config、进程参数、日志）。私有仓库走
    git 的凭据助手/环境变量，由调用方决定；这里只产出干净地址。
    本地路径与 file:// 原样透传（夹具测试与"开发模式"都用它）。
    """
    raw = (ref.raw or "").strip()
    if raw.startswith("file://") or os.path.isdir(raw):
        return raw
    if ref.kind == "local":
        return raw
    host = ref.host or "github.com"
    return f"https://{host}/{ref.slug}.git"


def _git_code(msg: str) -> str:
    m = msg.lower()
    if "could not resolve host" in m:
        return "dns"
    if "authentication failed" in m or "permission denied" in m or "403" in m:
        return "auth"
    if "repository not found" in m or "does not exist" in m:
        return "not_found"
    if "proxy" in m:
        return "proxy"
    if "certificate" in m or "ssl" in m:
        return "certificate"
    return "git_failed"


# --------------------------------------------------------------------------- #
# 路径二：归档（不需要 git）
# --------------------------------------------------------------------------- #
async def fetch_via_archive(
    ref: SourceRef,
    *,
    policy: NetPolicy,
    platforms: list[dict[str, Any]] | None = None,
    token: str = "",
) -> Fetched:
    if ref.kind == "local":
        raise FetchError("invalid_source", "本地来源不需要下载")
    plat = platform_for(ref.host, platforms)
    if plat is None or not plat.archive_template:
        raise FetchError(
            "needs_git",
            f"没有适配 {ref.host} 的归档接口",
            "安装 git 后用 git 取回，或在设置里给这个主机加一条平台适配",
        )
    ref_name = ref.ref or "HEAD"
    urls: list[tuple[str, str]] = []
    primary = archive_url(plat, host=ref.host, owner=ref.owner, repo=ref.repo, ref=ref_name)
    urls.append((primary, "verified"))
    for mirror in policy.mirrors:
        if "{url}" in mirror:
            candidate = mirror.replace("{url}", primary)
        elif mirror.startswith("http://") or mirror.startswith("https://"):
            # 完整地址（带路径）直接用；只有域名/前缀时按前缀拼
            candidate = mirror if Path(mirror.split("?")[0]).suffix in (".gz", ".tgz", ".zip", ".tar") else archive_url(
                plat, host=ref.host, owner=ref.owner, repo=ref.repo, ref=ref_name, base=mirror
            )
        else:
            candidate = archive_url(plat, host=ref.host, owner=ref.owner, repo=ref.repo, ref=ref_name, base=mirror)
        urls.append((candidate, "mirror-unverified"))

    headers: dict[str, str] = {}
    if token:
        headers[plat.auth_header] = f"{plat.auth_scheme} {token}".strip()

    errors: list[str] = []
    for url, integrity in urls:
        try:
            data, final = await policy.get(url, headers=headers, auth_host=ref.host, max_bytes=MAX_ARCHIVE_BYTES)
        except NetError as exc:
            errors.append(f"{exc.code}:{exc}"[:160])
            continue
        root = Path(tempfile.mkdtemp(prefix="studio-skill-tar-"))
        unpack_archive(data, root / "repo")
        commit = _commit_from_archive_name(final)
        if not commit:
            commit = await resolve_commit(ref, policy=policy, platforms=platforms, token=token)
        return Fetched(
            root=root / "repo",
            commit=commit or "",
            integrity=integrity,
            via="archive",
            url_used=url,
            notes=([f"内容来自镜像，未经原始主机核验：{url}"] if integrity != "verified" else []),
        )
    raise FetchError("download_failed", "仓库下载失败：" + "；".join(errors[:3]), "跑一次「测试连接」看卡在哪一步")


def _commit_from_archive_name(url: str) -> str:
    import re

    m = re.search(r"/([0-9a-f]{40})(?:\.tar\.gz|/|$)", url)
    return m.group(1) if m else ""


def unpack_archive(data: bytes, dest: Path) -> None:
    """安全解压：拒绝穿越/绝对路径/链接逃逸/设备文件，限制条目与总大小。"""
    dest.mkdir(parents=True, exist_ok=True)
    total = 0
    count = 0
    try:
        tf = tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")
    except tarfile.TarError as exc:
        raise FetchError("bad_archive", f"压缩包解析失败：{exc}", "换一个来源") from exc
    with tf:
        members = tf.getmembers()
        # 去掉包顶层目录（GitHub 的 o-r-sha/）
        tops = {m.name.split("/")[0] for m in members if m.name}
        strip = ""
        if len(tops) == 1:
            only = next(iter(tops))
            if all(m.name == only or m.name.startswith(only + "/") for m in members):
                strip = only + "/"
        for m in members:
            raw_name = m.name
            if raw_name.startswith("/") or ".." in Path(raw_name).parts:
                raise FetchError("unsafe_path", f"压缩包里有非法路径：{raw_name}")
            count += 1
            if count > MAX_ENTRIES:
                raise FetchError("too_many_entries", f"压缩包条目超过 {MAX_ENTRIES}")
            name = m.name[len(strip) :] if strip and m.name.startswith(strip) else m.name
            if not name:
                continue
            if name.startswith("/") or ".." in Path(name).parts:
                raise FetchError("unsafe_path", f"压缩包里有非法路径：{name}")
            if m.isdir():
                (dest / name).mkdir(parents=True, exist_ok=True)
                continue
            if m.issym() or m.islnk() or m.ischr() or m.isblk() or m.isfifo():
                raise FetchError("unsafe_entry", f"压缩包里有链接/设备文件：{name}")
            if not m.isfile():
                continue
            if m.size > MAX_FILE_BYTES * 50:
                raise FetchError("too_large", f"单个文件过大：{name}（{m.size} 字节）")
            total += m.size
            if total > MAX_UNPACKED_BYTES:
                raise FetchError("too_large", f"解压后超过 {MAX_UNPACKED_BYTES // (1024 * 1024)}MB")
            fobj = tf.extractfile(m)
            if fobj is None:
                continue
            target = dest / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(target, "wb") as fh:
                shutil.copyfileobj(fobj, fh)


async def resolve_commit(
    ref: SourceRef,
    *,
    policy: NetPolicy,
    platforms: list[dict[str, Any]] | None = None,
    token: str = "",
) -> str:
    """解析 ref 指向的提交 ID。优先原始主机；失败返回空串（由调用方标注）。"""
    if ref.kind == "local":
        return ""
    # 有 git：ls-remote 最可靠，也不吃 API 限流
    exe = which("git")
    if exe:
        try:
            env = policy.git_env()
            p = await asyncio.create_subprocess_exec(
                exe, "ls-remote", f"https://{ref.host or 'github.com'}/{ref.slug}.git",
                ref.ref or "HEAD",
                env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
            out, _ = await asyncio.wait_for(p.communicate(), timeout=45)
            _scrub_gitconfig(env)
            line = (out or b"").decode().split("\n")[0].strip()
            if line:
                return line.split()[0]
        except Exception:  # noqa: BLE001
            pass
    plat = platform_for(ref.host, platforms)
    if plat and plat.ref_template:
        headers = {}
        if token:
            headers[plat.auth_header] = f"{plat.auth_scheme} {token}".strip()
        url = plat.ref_template.format(owner=ref.owner, repo=ref.repo, ref=ref.ref or "HEAD", host=ref.host)
        try:
            raw, _ = await policy.get(url, headers=headers, auth_host=ref.host)
            import json

            j = json.loads(raw.decode("utf-8", "ignore"))
            return str(j.get("sha") or j.get("id") or "")
        except Exception:  # noqa: BLE001
            return ""
    return ""


async def fetch(
    ref: SourceRef,
    *,
    policy: NetPolicy,
    mode: str = "native",
    platforms: list[dict[str, Any]] | None = None,
    token: str = "",
    prefer: str = "archive",
) -> Fetched:
    """按可用性选路：prefer=archive 且平台已适配 → 归档；否则 git。"""
    if ref.kind == "local":
        raise FetchError("invalid_source", "本地来源不走下载")
    plat = platform_for(ref.host, platforms)
    if prefer == "archive" and plat and plat.archive_template:
        return await fetch_via_archive(ref, policy=policy, platforms=platforms, token=token)
    if not await git_available():
        if plat and plat.archive_template:
            return await fetch_via_archive(ref, policy=policy, platforms=platforms, token=token)
        raise FetchError("needs_git", "没有 git，也没有可用的归档接口", "安装 git 或补充平台适配")
    return await fetch_via_git(ref, policy=policy, token=token)
