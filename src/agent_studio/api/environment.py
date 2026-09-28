"""运行环境自检与安装：Python / Node.js / uv。

用户要的是："环境配置里能检测当前环境的 python 和 nodejs，没有就支持下载安装"。

三条纪律（都是这个环境里踩出来的，不是洁癖）
--------------------------------------------
① **只装到平台自己的目录**（``<work_dir>/runtime/``），绝不动系统包 ——
   用户明确立过规矩：不擅自升级/安装系统软件（换内核那次就是这么定的）。
   装出来的 node 只给平台自己用（前端构建等），不写 /usr/bin、不碰 PATH。
② **只走国内镜像**：这台机器出不去外网（GitHub 直连不通）。node 走 npmmirror 的
   node 发行镜像、python/uv 走清华 PyPI 与 uv 的镜像配置。
③ **下载要校验哈希、装完要真跑一次 ``--version``**：npmmirror 同时提供
   ``SHASUMS256.txt``，拿它比对；装完用新解释器/新 node 真跑一次才算"装好了"。
   校验不过或跑不起来就如实报错 —— 绝不写"已安装"糊过去。

语义边界
--------
· **Python**：平台自己就跑在 Python 上，所以"缺 Python"只可能是**要装另一个解释器**
  （比如给子进程/沙箱用）。走 ``uv python install``（uv 会把独立解释器装到自己的目录）。
  uv 本身没装时，用 pip 从清华源装 uv，再装解释器。
· **Node.js**：平台只在"构建前端"时需要它。默认装 LTS，落 ``runtime/node/<版本>``
  并维护一个 ``runtime/node/current`` 软链，界面把可直接用的路径告诉用户。
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path
from typing import Any, Callable

import httpx
from fastapi import APIRouter, HTTPException

from ..config import settings

logger = logging.getLogger(__name__)

router = APIRouter(tags=["environment"])

#: npmmirror 的 node 发行镜像（国内可直连）
NODE_MIRROR = "https://npmmirror.com/mirrors/node"
#: 默认装的 node 版本（LTS 线；界面可指定别的）
DEFAULT_NODE_VERSION = "v22.14.0"
#: PyPI 镜像（装 uv 用）
PIP_INDEX = "https://pypi.tuna.tsinghua.edu.cn/simple"


# --------------------------------------------------------------------------- #
# 纯函数（能被测试钉死的那部分）
# --------------------------------------------------------------------------- #
def node_arch(machine: str | None = None) -> str:
    """把 CPU 架构映射成 node 发行包的命名（x64 / arm64 …）。"""
    m = (machine or platform.machine() or "").lower()
    if m in ("x86_64", "amd64"):
        return "x64"
    if m in ("aarch64", "arm64"):
        return "arm64"
    if m.startswith("armv7"):
        return "armv7l"
    return m or "x64"


def node_asset_name(version: str, machine: str | None = None) -> str:
    """node 发行包文件名，例如 ``node-v22.14.0-linux-x64.tar.xz``。"""
    return f"node-{version}-linux-{node_arch(machine)}.tar.xz"


def parse_shasums(text: str, filename: str) -> str | None:
    """从 SHASUMS256.txt 里取某个文件的 sha256（找不到返回 None）。"""
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].lstrip("*") == filename:
            return parts[0].strip().lower()
    return None


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def runtime_root() -> Path:
    """平台自己管的运行环境目录（不碰系统）。"""
    root = Path(settings.work_dir or ".") / "runtime"
    return root


# --------------------------------------------------------------------------- #
# 检测
# --------------------------------------------------------------------------- #
def _run_version(cmd: list[str], timeout: float = 6.0) -> str | None:
    """跑一个 ``--version`` 拿版本；跑不起来就返回 None（不抛）。"""
    try:
        out = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
    except Exception:  # noqa: BLE001
        return None
    text = ((out.stdout or "") + (out.stderr or "")).strip().splitlines()
    return text[0].strip() if text else None


def _node_candidates() -> list[tuple[str, Path]]:
    """所有可能找到 node 的地方：平台装的最优先，其次 PATH，最后 nvm。"""
    found: list[tuple[str, Path]] = []
    cur = runtime_root() / "node" / "current" / "bin" / "node"
    if cur.exists():
        found.append(("平台安装", cur))
    which = shutil.which("node")
    if which:
        found.append(("系统 PATH", Path(which)))
    nvm = Path.home() / ".nvm" / "versions" / "node"
    if nvm.is_dir():
        for d in sorted(nvm.iterdir(), reverse=True):
            p = d / "bin" / "node"
            if p.exists():
                found.append(("nvm", p))
    return found


def detect_python() -> dict[str, Any]:
    """当前 Python 的情况（平台就跑在它上面）。"""
    version = platform.python_version()
    in_venv = sys.prefix != getattr(sys, "base_prefix", sys.prefix)
    pip_path = shutil.which("pip") or shutil.which("pip3")
    uv_path = shutil.which("uv")
    deps: dict[str, str | None] = {}
    for mod in ("agentscope", "fastapi", "httpx"):
        try:
            from importlib.metadata import version as _v

            deps[mod] = _v(mod)
        except Exception:  # noqa: BLE001
            deps[mod] = None
    return {
        "found": True,
        "version": version,
        "path": sys.executable,
        "venv": sys.prefix if in_venv else None,
        "in_venv": in_venv,
        "pip": pip_path,
        "uv": uv_path,
        "deps": deps,
        # 平台自己在跑，所以"没有 python"这个状态不存在；能装的是**另一个**解释器
        "installable": True,
        "install_note": "装的是独立解释器（uv python install），给子进程/沙箱用；平台自身的 Python 不动",
    }


def detect_node() -> dict[str, Any]:
    """Node.js 的情况：平台只在构建前端时需要它。"""
    for source, path in _node_candidates():
        v = _run_version([str(path), "--version"])
        if v:
            which_npm = path.parent / "npm"
            npm = _run_version([str(which_npm), "--version"]) if which_npm.exists() else None
            return {
                "found": True,
                "version": v,
                "path": str(path),
                "source": source,
                "npm": npm,
                "npm_path": str(which_npm) if which_npm.exists() else None,
                "installable": True,
                "install_note": "",
            }
    return {
        "found": False,
        "version": None,
        "path": None,
        "source": None,
        "npm": None,
        "npm_path": None,
        "installable": True,
        "install_note": "没找到 node —— 平台只在「构建前端」时需要它，可一键装到平台目录（不动系统）",
    }


@router.get("/runtimes")
async def get_runtimes() -> dict[str, Any]:
    """检测当前运行环境（Python / Node.js / uv）。"""
    py = detect_python()
    node = detect_node()
    root = runtime_root()
    return {
        "python": py,
        "node": node,
        "os": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "runtime_dir": str(root),
        "mirror": NODE_MIRROR,
        "default_node_version": DEFAULT_NODE_VERSION,
    }


# --------------------------------------------------------------------------- #
# 安装（后台任务 + 可轮询日志）
# --------------------------------------------------------------------------- #
#: 一次只允许一个安装任务在跑（同时装 node 和 python 没意义，还容易互相踩）
_JOBS: dict[str, dict[str, Any]] = {}
_ACTIVE: str | None = None
_MAX_JOBS = 20


def _new_job(target: str, version: str | None) -> tuple[str, dict[str, Any]]:
    job_id = f"inst_{int(time.time() * 1000)}_{target}"
    job: dict[str, Any] = {
        "id": job_id,
        "target": target,
        "version": version,
        "status": "running",
        "steps": [],
        "started_at": int(time.time() * 1000),
        "ended_at": None,
        "ok": None,
        "error": None,
    }
    _JOBS[job_id] = job
    # 只留最近 N 个，防止无限增长（安装是低频操作，不需要历史）
    for k in list(_JOBS)[:-_MAX_JOBS]:
        _JOBS.pop(k, None)
    return job_id, job


def _step(job: dict[str, Any], line: str) -> None:
    job["steps"].append({"at": int(time.time() * 1000), "line": line})
    logger.info("[运行环境安装 %s] %s", job["id"], line)


def _finish(job: dict[str, Any], *, ok: bool, error: str | None = None) -> None:
    job["status"] = "ok" if ok else "error"
    job["ok"] = ok
    job["error"] = error
    job["ended_at"] = int(time.time() * 1000)
    global _ACTIVE
    _ACTIVE = None


async def _fetch_bytes(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as http:
        r = await http.get(url)
        r.raise_for_status()
        return r.content


async def _download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(timeout=600.0, follow_redirects=True) as http:
        async with http.stream("GET", url) as r:
            r.raise_for_status()
            with dest.open("wb") as f:
                async for chunk in r.aiter_bytes(1 << 16):
                    f.write(chunk)


async def _install_node(
    job: dict[str, Any],
    version: str,
    *,
    fetcher: Callable[[str], Any] | None = None,
    downloader: Callable[[str, Path], Any] | None = None,
    root: Path | None = None,
) -> None:
    """下载 → 校验 → 解包 → 真跑一次版本 → 切 current 软链。

    ``fetcher`` / ``downloader`` 可注入（测试里用本地假包跑完整流程，不联网）。
    """
    asset = node_asset_name(version)
    base = f"{NODE_MIRROR}/{version}"
    root = root or runtime_root()
    target_dir = root / "node" / version
    tmp = root / "node" / f".{asset}.part"

    _step(job, f"目标：{version}（{asset}）→ {target_dir}")

    _step(job, "① 取校验和（SHASUMS256.txt）")
    fetch = fetcher or _fetch_bytes
    shasums = await fetch(f"{base}/SHASUMS256.txt")
    text = shasums.decode("utf-8", errors="replace") if isinstance(shasums, bytes) else str(shasums)
    want = parse_shasums(text, asset)
    if not want:
        raise RuntimeError(f"镜像上的 SHASUMS256.txt 里没有 {asset} —— 装不了，别硬装")

    _step(job, f"② 下载 {asset}")
    dl = downloader or _download
    await dl(f"{base}/{asset}", tmp)
    size_mb = tmp.stat().st_size / 1024 / 1024
    _step(job, f"   已下载 {size_mb:.1f} MB")

    _step(job, "③ 校验 sha256")
    got = sha256_of(tmp)
    if got != want:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"校验不过：期望 {want[:12]}…，实际 {got[:12]}…（文件已删，不装）")
    _step(job, "   校验通过")

    _step(job, "④ 解包")
    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(tmp, "r:xz") as tf:
        # 解出来的顶层目录是 node-<version>-linux-<arch>，把它里面的内容搬平
        members = tf.getmembers()
        prefix = members[0].name.split("/")[0] if members else ""
        for m in members:
            if not m.name.startswith(prefix):
                continue
            m.name = m.name[len(prefix) :].lstrip("/")
            if not m.name:
                continue
            tf.extract(m, target_dir, filter="data")
    tmp.unlink(missing_ok=True)
    _step(job, "   解包完成")

    _step(job, "⑤ 真跑一次 --version（装没装好，跑一次才算数）")
    bin_path = target_dir / "bin" / "node"
    if not bin_path.exists():
        raise RuntimeError("解包后没有 bin/node —— 包不对，不写 current")
    got_v = _run_version([str(bin_path), "--version"])
    if not got_v:
        raise RuntimeError(f"{bin_path} 跑不起来（缺依赖？），不写 current")
    _step(job, f"   {bin_path} → {got_v}")

    cur = root / "node" / "current"
    if cur.is_symlink() or cur.exists():
        cur.unlink()
    cur.symlink_to(target_dir)
    _step(job, f"⑥ 已切成平台默认：{cur} → {target_dir}")
    _step(job, f"✅ 好了：node {got_v}（{target_dir}/bin/node）")


async def _install_python(
    job: dict[str, Any], version: str, *, runner: Callable[..., Any] | None = None
) -> None:
    """用 uv 装一个独立解释器（uv 没有就先从清华源把 uv 装上）。"""
    run = runner or _run_cmd

    uv = shutil.which("uv")
    if not uv:
        _step(job, "① 没找到 uv —— 先从清华 PyPI 装 uv")
        pip = shutil.which("pip") or shutil.which("pip3")
        if not pip:
            raise RuntimeError("连 pip 都没有，装不了 uv —— 请先在这台机器上准备 pip")
        out = await run([pip, "install", "-q", "-i", PIP_INDEX, "uv"])
        _step(job, f"   {out[:200] or 'pip 装 uv 完成'}")
        uv = shutil.which("uv") or str(Path(sys.executable).parent / "uv")
        if not Path(uv).exists():
            raise RuntimeError("uv 装完仍找不到可执行文件（可能在别的 bin 目录）")
    else:
        _step(job, f"① 已有 uv：{uv}")

    _step(job, f"② uv python install {version}")
    out = await run([uv, "python", "install", version])
    _step(job, f"   {out[:300] or '完成'}")
    find = await run([uv, "python", "find", version])
    path = find.strip().splitlines()[-1] if find.strip() else ""
    if not path or not Path(path).exists():
        raise RuntimeError("uv 装完但找不到解释器路径 —— 不写「已验证」")
    _step(job, f"✅ 好了：Python {version} → {path}")


async def _run_cmd(cmd: list[str]) -> str:
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    out, _ = await proc.communicate()
    return (out or b"").decode("utf-8", errors="replace").strip()


async def _run_job(job: dict[str, Any]) -> None:
    try:
        if job["target"] == "node":
            await _install_node(job, job["version"] or DEFAULT_NODE_VERSION)
        elif job["target"] == "python":
            await _install_python(job, job["version"] or "3.13")
        else:
            raise RuntimeError(f"不认识的目标：{job['target']}")
        _finish(job, ok=True)
    except Exception as exc:  # noqa: BLE001 —— 失败要留在日志里给用户看
        _step(job, f"❌ 失败：{type(exc).__name__}: {exc}")
        _finish(job, ok=False, error=f"{type(exc).__name__}: {exc}")


@router.post("/install")
async def install_runtime(payload: dict[str, Any]) -> dict[str, Any]:
    """一键装 node / python（后台跑，日志可轮询）。"""
    global _ACTIVE
    target = str((payload or {}).get("target") or "").strip()
    if target not in ("node", "python"):
        raise HTTPException(400, "target 只能是 node 或 python")
    if _ACTIVE and _JOBS.get(_ACTIVE, {}).get("status") == "running":
        return {"started": False, "job_id": _ACTIVE, "note": "已有一个安装任务在跑，跟着它看就行"}
    version = (payload or {}).get("version") or None
    job_id, job = _new_job(target, version)
    _ACTIVE = job_id
    _step(job, f"开始安装 {target}{' ' + str(version) if version else ''}")
    asyncio.create_task(_run_job(job))
    return {"started": True, "job_id": job_id}


@router.get("/install/{job_id}")
async def install_status(job_id: str) -> dict[str, Any]:
    job = _JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, f"没有这个安装任务：{job_id}")
    return job


@router.get("/runtime-dir")
async def runtime_dir_info() -> dict[str, Any]:
    """平台自己管的运行环境目录（以及里面已经装了什么）。"""
    root = runtime_root()
    node_dir = root / "node"
    installed: list[str] = []
    if node_dir.is_dir():
        installed = sorted(
            [d.name for d in node_dir.iterdir() if d.is_dir() and not d.name.startswith(".")]
        )
    return {
        "dir": str(root),
        "exists": root.exists(),
        "node_installed": installed,
        "current": str(node_dir / "current") if (node_dir / "current").exists() else None,
        # 界面提示用：装完怎么用（前端构建）
        "usage_note": (
            "装好的 node 只给平台自己用，不进系统 PATH；构建前端时用 "
            f"{(node_dir / 'current' / 'bin').as_posix()} 里的 node/npm"
        ),
        "os_env": {"PATH": os.environ.get("PATH", "")[:400]},
    }
