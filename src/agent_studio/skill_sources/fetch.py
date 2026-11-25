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
    """安全解压：拒绝穿越/绝对路径/链接逃逸/设备文件，限制条目与总大小。

    zip 与 tar.gz 都认（站点清单里的 ``type: archive`` 常见是 zip）。
    """
    if data[:2] == b"PK":
        return _unpack_zip(data, dest)
    dest.mkdir(parents=True, exist_ok=True)
    total = 0
    count = 0
    skipped: list[str] = []
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
            if m.ischr() or m.isblk() or m.isfifo():
                raise FetchError("unsafe_entry", f"压缩包里有设备/管道文件：{name}")
            if m.issym() or m.islnk():
                # 符号链接/硬链接：**跳过，不落盘**。
                # 真实仓库常带 .claude/.cursor 这类指向仓库内的软链（vercel-labs/agent-browser
                # 就是这样），一律拒绝会让"能装"变成"不能装"；但落盘又有逃逸风险。
                # 取中间：不创建，记一条 note，技能本身的文件照常装。
                skipped.append(name)
                continue
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


def _unpack_zip(data: bytes, dest: Path) -> None:
    import zipfile

    dest.mkdir(parents=True, exist_ok=True)
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise FetchError("bad_archive", f"zip 解析失败：{exc}", "换一个来源") from exc
    total = 0
    with zf:
        names = [n for n in zf.namelist() if n]
        tops = {n.split("/")[0] for n in names}
        strip = ""
        if len(tops) == 1 and all(n == next(iter(tops)) or n.startswith(next(iter(tops)) + "/") for n in names):
            strip = next(iter(tops)) + "/"
        if len(names) > MAX_ENTRIES:
            raise FetchError("too_many_entries", f"压缩包条目超过 {MAX_ENTRIES}")
        for info in zf.infolist():
            raw_name = info.filename
            if raw_name.startswith("/") or ".." in Path(raw_name).parts:
                raise FetchError("unsafe_path", f"压缩包里有非法路径：{raw_name}")
            name = raw_name[len(strip):] if strip and raw_name.startswith(strip) else raw_name
            if not name:
                continue
            if ".." in Path(name).parts:
                raise FetchError("unsafe_path", f"压缩包里有非法路径：{name}")
            if info.is_dir():
                (dest / name).mkdir(parents=True, exist_ok=True)
                continue
            # zip 的符号链接靠外部属性位判断（0xA000 在 Unix 权限高位）
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise FetchError("unsafe_entry", f"压缩包里有链接：{name}")
            total += info.file_size
            if total > MAX_UNPACKED_BYTES:
                raise FetchError("too_large", f"解压后超过 {MAX_UNPACKED_BYTES // (1024 * 1024)}MB")
            target = dest / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as fh:
                shutil.copyfileobj(src, fh)


SITE_INDEX_PATHS = (
    "/.well-known/agent-skills/index.json",   # agentskills.io discovery 0.2.0（archify.si 用这个）
    "/.well-known/skills/index.json",
    "/skills.json",
)

ARCHIVE_SUFFIX = (".zip", ".tar.gz", ".tgz", ".tar", ".tar.bz2", ".tar.xz")


def _is_archive(url: str) -> bool:
    path = url.split("?")[0].split("#")[0].lower()
    return path.endswith(ARCHIVE_SUFFIX)


def _verify_digest(data: bytes, digest: str) -> None:
    want = (digest or "").strip().lower()
    if not want:
        return
    algo, _, hexv = want.partition(":")
    if algo != "sha256" or not hexv:
        return                      # 不认识的摘要格式：不假装验过，也不阻断
    import hashlib

    got = hashlib.sha256(data).hexdigest()
    if got != hexv:
        raise FetchError(
            "digest_mismatch",
            f"下载内容和清单里的摘要不一致（清单 {hexv[:12]}…，实际 {got[:12]}…）",
            "站点可能正在发版；重试一次，仍然不一致就别装",
        )


def _pick_entry(entries: list[dict[str, Any]], skill: str | None) -> dict[str, Any]:
    if skill:
        for e in entries:
            if str(e.get("name") or "") == skill:
                return e
        names = ", ".join(str(e.get("name")) for e in entries[:12])
        raise FetchError("skill_not_found", f"清单里没有叫 {skill} 的技能", f"清单里有：{names}")
    if len(entries) == 1:
        return entries[0]
    names = ", ".join(str(e.get("name")) for e in entries[:12])
    raise FetchError("skill_choice_required", "这个站点索引里有多个技能，要指定一个", f"可选：{names}")


async def fetch_via_site(ref: SourceRef, *, policy: NetPolicy) -> Fetched:
    """站点索引：先探 well-known 清单，再按清单里的地址下归档。

    这是 ``npx skills add https://archify.si`` 实际走的路径：
    站点在 ``/.well-known/agent-skills/index.json`` 列出 ``{name, type: archive, url, digest}``，
    CLI 下载 url 指向的 zip 并按 digest 校验。这里原生照做，不需要 Node。
    """
    from urllib.parse import urljoin, urlparse

    base = (ref.url or f"https://{ref.host}").rstrip("/")
    origin = "{0.scheme}://{0.netloc}".format(urlparse(base))
    cands: list[str] = []
    for root in dict.fromkeys([base, origin]):
        for path in SITE_INDEX_PATHS:
            cands.append(root + path)
    errors: list[str] = []
    index_url = ""
    payload: Any = None
    for url in cands:
        try:
            r = await policy.get(url, max_bytes=2 * 1024 * 1024)
        except NetError as exc:
            errors.append(f"{url} → {exc.code}")
            continue
        data = r[0] if isinstance(r, tuple) else r
        try:
            import json

            payload = json.loads(data.decode("utf-8", "ignore"))
        except Exception:  # noqa: BLE001
            errors.append(f"{url} → 不是 JSON")
            continue
        index_url = url
        break
    if payload is None:
        raise FetchError(
            "no_site_index",
            f"{ref.host} 没有技能清单（试过 {len(cands)} 个 well-known 地址）",
            "这个地址可能只是普通网站；换成仓库地址（owner/repo）或直链 SKILL.md",
        )

    entries = payload.get("skills") if isinstance(payload, dict) else payload
    if not isinstance(entries, list) or not entries:
        raise FetchError("no_site_index", f"{index_url} 里没有列出技能", "确认站点清单格式")
    entries = [e for e in entries if isinstance(e, dict)]
    entry = _pick_entry(entries, ref.skill)

    name = str(entry.get("name") or (ref.skill or "skill"))
    target = str(entry.get("url") or entry.get("download") or "")
    if not target:
        raise FetchError("no_site_index", f"{index_url} 里的 {name} 没有下载地址")
    file_url = urljoin(index_url, target)

    data, final = await policy.get(file_url, max_bytes=MAX_ARCHIVE_BYTES)
    _verify_digest(data, str(entry.get("digest") or ""))

    root = Path(tempfile.mkdtemp(prefix="studio-skill-site-"))
    if _is_archive(file_url):
        unpack_archive(data, root / "repo")
    else:
        # 单个 SKILL.md：按 <技能名>/SKILL.md 落位，让后续发现逻辑照常工作
        (root / "repo" / name).mkdir(parents=True, exist_ok=True)
        (root / "repo" / name / "SKILL.md").write_bytes(data)
    notes = [f"来自站点索引 {index_url}"]
    if entry.get("digest"):
        notes.append("已按清单里的 sha256 校验")
    return Fetched(
        root=root / "repo",
        commit=str(entry.get("digest") or entry.get("version") or ""),
        integrity="verified",
        via="site",
        url_used=final,
        notes=notes,
    )


async def fetch_via_file(ref: SourceRef, *, policy: NetPolicy) -> Fetched:
    """直链：SKILL.md 或归档包。"""
    url = ref.url or ref.raw
    data, final = await policy.get(url, max_bytes=MAX_ARCHIVE_BYTES)
    root = Path(tempfile.mkdtemp(prefix="studio-skill-url-"))
    if _is_archive(url):
        unpack_archive(data, root / "repo")
    else:
        name = (ref.skill or _name_from_url(url) or "skill").strip("/") or "skill"
        (root / "repo" / name).mkdir(parents=True, exist_ok=True)
        (root / "repo" / name / "SKILL.md").write_bytes(data)
    return Fetched(root=root / "repo", via="url", url_used=final, integrity="unverified", notes=["直链下载，没有摘要可校验"])


def _name_from_url(url: str) -> str:
    from urllib.parse import urlparse

    segs = [x for x in urlparse(url).path.split("/") if x]
    return segs[-2] if len(segs) >= 2 else ""


async def resolve_commit(
    ref: SourceRef,
    *,
    policy: NetPolicy,
    platforms: list[dict[str, Any]] | None = None,
    token: str = "",
    timeout: float = 45.0,
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
            out, _ = await asyncio.wait_for(p.communicate(), timeout=timeout)
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


# --------------------------------------------------------------------------- #
# npm registry（第三方包，含公司内网 registry）
# --------------------------------------------------------------------------- #
async def fetch_via_npm(ref: SourceRef, *, policy: NetPolicy, timeout: float = 60.0) -> Fetched:
    """从 npm registry 取一个"技能包"并解到临时目录。

    为什么不用 npx：部署机是**零 Node** 的（离线一体包只带 CPython），
    真跑 npx 在东京那台上直接失败。registry 协议本身是纯 HTTP + tgz，
    自己取不依赖任何运行时。

    ``ref.url`` 可以是 ``--registry=`` 给的地址；不给我按顺序回落到
    环境变量 STUDIO_NPM_REGISTRY、https://registry.npmjs.org。
    """
    import os
    import tarfile
    import tempfile

    import httpx

    registry = (ref.url or os.environ.get("STUDIO_NPM_REGISTRY") or "https://registry.npmjs.org").rstrip("/")
    pkg = ref.repo
    if not pkg:
        raise FetchError("invalid_source", "npm 来源缺少包名")
    # scoped 包：@scope/name → @scope%2Fname（registry 只对斜杠转义）
    meta_url = f"{registry}/{pkg.replace('/', '%2F')}"
    want = (ref.ref or "").strip()

    headers = {"Accept": "application/vnd.npm.install-v1+json, application/json"}
    fetch_headers = policy.headers_for(registry) if hasattr(policy, "headers_for") else {}
    headers.update(fetch_headers or {})

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, trust_env=False) as client:
        r = await client.get(meta_url, headers=headers)
        if r.status_code == 404:
            raise FetchError(
                "npm_package_missing",
                f"{registry} 上没有这个包：{pkg}",
                "确认包名，或用 --registry= 指定内网 registry",
            )
        r.raise_for_status()
        meta = r.json()
        tags = meta.get("dist-tags") or {}
        versions = meta.get("versions") or {}
        version = want or tags.get("latest") or ""
        if version in tags:  # @latest / @next / @beta
            version = tags[version]
        if not version:
            raise FetchError("npm_version_missing", f"{pkg} 没有可用的版本")
        if version not in versions:
            raise FetchError(
                "npm_version_missing",
                f"{pkg}@{version} 不存在（可用：{', '.join(list(versions)[:5])}…）",
            )
        dist = versions[version].get("dist") or {}
        tarball = str(dist.get("tarball") or "")
        if not tarball:
            raise FetchError("npm_tarball_missing", f"{pkg}@{version} 没有 tarball 地址")
        t = await client.get(tarball, headers=headers)
        t.raise_for_status()
        data = t.content
    if not data:
        raise FetchError("npm_tarball_missing", f"{pkg}@{version} 下载为空")

    tmp = Path(tempfile.mkdtemp(prefix="skill-npm-"))
    root = tmp / "repo"
    root.mkdir(parents=True, exist_ok=True)
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as tf:
            for m in tf.getmembers():
                if not m.isfile():
                    continue
                name = m.name.lstrip("./")
                # npm 包的 tarball 顶层固定是 package/ —— 去掉它，让结构和仓库归档一致
                if name.startswith("package/"):
                    name = name[len("package/"):]
                if not name or ".." in Path(name).parts:
                    continue
                out = (root / name).resolve()
                if root.resolve() not in out.parents:
                    continue
                out.parent.mkdir(parents=True, exist_ok=True)
                fp = tf.extractfile(m)
                if fp is None:
                    continue
                with fp, out.open("wb") as dst:
                    shutil.copyfileobj(fp, dst)
    except tarfile.TarError as exc:
        raise FetchError("npm_tarball_broken", f"包内容解不开：{exc}") from exc

    shasum = str(dist.get("shasum") or "")[:12]
    return Fetched(
        root=root,
        commit=shasum,
        via="npm",
        url_used=meta_url,
        notes=[f"npm 包 {pkg}@{version}"],
    )


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
    if ref.kind == "site":
        return await fetch_via_site(ref, policy=policy)
    if ref.kind == "file":
        return await fetch_via_file(ref, policy=policy)
    if ref.kind == "npm":
        return await fetch_via_npm(ref, policy=policy)
    plat = platform_for(ref.host, platforms)
    if prefer == "archive" and plat and plat.archive_template:
        return await fetch_via_archive(ref, policy=policy, platforms=platforms, token=token)
    if not await git_available():
        if plat and plat.archive_template:
            return await fetch_via_archive(ref, policy=policy, platforms=platforms, token=token)
        raise FetchError("needs_git", "没有 git，也没有可用的归档接口", "安装 git 或补充平台适配")
    return await fetch_via_git(ref, policy=policy, token=token)
