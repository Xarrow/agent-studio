"""浏览器驱动管理 —— 装在哪儿、有哪些版本、当前用哪个。

为什么需要这一层
----------------
浏览器之前是写死的 ``/usr/bin/chromium``：系统升级把它换掉、或者要试一个新版本，
只能改代码 + 重启。而「页面加载不出来」十有八九就是驱动/内核版本的问题
（内网证书、字体、headless 行为），现场却没有一个地方能看见"现在用的到底是哪个"。

支持哪些引擎（以及为什么不是全部）
--------------------------------
控制协议只有两种现实选择：

* **CDP**（Chrome DevTools Protocol）：Chromium 系原生支持 —— Chromium、Google Chrome
  及其所有衍生（Brave、Edge、ungoogled-chromium）。平台的浏览器工具就是按 CDP 写的。
* **WebDriver BiDi**：Firefox 从 129 起移除了 CDP，只有 BiDi（也是 W3C 标准）。

WebKit / Safari 两者都不完整（只有 WebDriver classic），本平台不列 —— 列了也跑不动，
摆在界面上只会让人以为能选。

安装位置
--------
托管版本装在 ``data/browsers/<kind>-<version>/``，与系统包**并行存在**、互不影响；
切换只是改一个设置项（``app_setting: browser_driver``），随时切回系统自带。
卸载托管版本 = 删目录，不会伤到系统浏览器。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import tarfile
import time
import zipfile
from pathlib import Path
from typing import Any

import httpx

from .settings_store import get_setting, set_setting

logger = logging.getLogger(__name__)

#: 托管安装的根目录（跟着数据目录走，备份/迁移时一起带走）
ROOT = Path(os.environ.get("STUDIO_WORK_DIR", "data/work")).resolve().parent / "browsers"

#: 设置项键名 —— 记录「当前用哪个驱动」
SETTING_KEY = "browser_driver"

#: 支持的引擎。``managed`` 表示可以从官方源下载安装（没有的就只能用系统装的那个）
ENGINES: list[dict[str, Any]] = [
    {
        "kind": "chromium",
        "label": "Chromium",
        "proto": "cdp",
        "bins": ["chromium", "chromium-browser", "ungoogled-chromium"],
        "managed": None,
        "note": "系统包管理器安装（apt / dnf）；要装新版本用下面的 Google Chrome",
    },
    {
        "kind": "chrome",
        "label": "Google Chrome",
        "proto": "cdp",
        "bins": ["google-chrome", "google-chrome-stable", "chrome"],
        "managed": "cft",
        "note": "Chrome for Testing 官方构建",
    },
    {
        "kind": "brave",
        "label": "Brave",
        "proto": "cdp",
        "bins": ["brave-browser", "brave"],
        "managed": None,
        "note": "Chromium 系，协议与 Chrome 一致",
    },
    {
        "kind": "edge",
        "label": "Microsoft Edge",
        "proto": "cdp",
        "bins": ["microsoft-edge", "microsoft-edge-stable"],
        "managed": None,
        "note": "Chromium 系",
    },
    {
        "kind": "firefox",
        "label": "Firefox",
        "proto": "bidi",
        "bins": ["firefox", "firefox-esr"],
        "managed": "mozilla",
        "note": "开源内核；从 129 起改用 WebDriver BiDi（不再支持 CDP）",
    },
]

_BY_KIND = {e["kind"]: e for e in ENGINES}

#: 下载/解压的进度（进程内，够前端轮询用；重启丢失无所谓 —— 任务本身也随进程结束）
_JOBS: dict[str, dict[str, Any]] = {}

CFT_KNOWN = "https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json"
CFT_LAST = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json"
FIREFOX_VERSIONS = "https://product-details.mozilla.org/1.0/firefox_versions.json"


# --------------------------------------------------------------------------- #
# 探测
# --------------------------------------------------------------------------- #
def _which(bins: list[str]) -> str | None:
    for b in bins:
        p = shutil.which(b)
        if p:
            return p
    return None


def _version_of(path: str) -> str:
    """跑一次 ``--version`` 取版本号（取不到就返回空串，不编一个）。"""
    import subprocess

    for args in ([path, "--version"], [path, "-version"]):
        try:
            out = subprocess.run(args, capture_output=True, timeout=10, text=True)
        except Exception:
            continue
        text = (out.stdout or "") + (out.stderr or "")
        m = re.search(r"(\d+\.\d+(?:\.\d+){0,2})", text)
        if m:
            return m.group(1)
    return ""


def _managed_dirs() -> list[dict[str, Any]]:
    """扫 ``data/browsers/<kind>-<version>/`` —— 托管安装的版本。"""
    out: list[dict[str, Any]] = []
    if not ROOT.exists():
        return out
    for d in sorted(ROOT.iterdir()):
        if not d.is_dir():
            continue
        name = d.name
        for kind in _BY_KIND:
            if not name.startswith(kind + "-"):
                continue
            version = name[len(kind) + 1 :]
            exe = _managed_exe(d, kind)
            if exe is None:
                continue
            out.append(
                {
                    "kind": kind,
                    "version": version,
                    "path": str(exe),
                    "source": "managed",
                    "dir": str(d),
                    "size_mb": round(_dir_size(d) / 1e6, 1),
                }
            )
            break
    return out


def _managed_exe(d: Path, kind: str) -> Path | None:
    """托管目录里的可执行文件（CfT 解压出来是 chrome-linux64/chrome）。"""
    if kind == "firefox":
        for cand in (d / "firefox" / "firefox", d / "firefox"):
            if cand.is_file():
                return cand
        return None
    names = ("chrome", "chromium")
    for cand in [d / n for n in names] + [d / "chrome-linux64" / n for n in names]:
        if cand.is_file():
            return cand
    # 兜底：目录里任意一个可执行 chrome*
    for p in d.rglob("chrome"):
        if p.is_file() and os.access(p, os.X_OK):
            return p
    return None


def _fix_perms(dest: Path) -> None:
    """给解压出来的文件补上合理权限（zip 里没有 unix mode）。

    判据刻意简单：名字带 ``chrome``、以 ``-handler`` 结尾、或者**根本没有扩展名**
    的，按可执行处理；其余给 644。Chrome 的辅助进程（crashpad_handler / sandbox /
    headless_shell）全是这类名字 —— 漏一个就启动失败。
    """
    for p in dest.rglob("*"):
        if not p.is_file() or p.is_symlink():
            continue
        name = p.name
        exe_like = "chrome" in name or name.endswith("-handler") or "." not in name
        try:
            os.chmod(p, 0o755 if exe_like else 0o644)
        except OSError:
            continue


def _dir_size(p: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(p):
        for f in files:
            try:
                total += (Path(root) / f).stat().st_size
            except OSError:
                continue
    return total


def installed() -> list[dict[str, Any]]:
    """当前机器上所有可用的驱动：系统装的 + 托管装的。"""
    rows: list[dict[str, Any]] = []
    for e in ENGINES:
        p = _which(e["bins"])
        if p:
            rows.append(
                {
                    "kind": e["kind"],
                    "label": e["label"],
                    "proto": e["proto"],
                    "version": _version_of(p),
                    "path": p,
                    "source": "system",
                    "dir": "",
                }
            )
    rows.extend(
        {**r, "label": _BY_KIND[r["kind"]]["label"], "proto": _BY_KIND[r["kind"]]["proto"]}
        for r in _managed_dirs()
    )
    return rows


async def get_active(session: Any) -> dict[str, Any]:
    """当前生效的驱动。没设过 = 系统 Chromium（平台一直以来的默认）。"""
    raw = await get_setting(session, SETTING_KEY, None) or {}
    kind = str(raw.get("kind") or "")
    path = str(raw.get("path") or "")
    if path and Path(path).exists() and kind in _BY_KIND:
        return {
            "kind": kind,
            "label": _BY_KIND[kind]["label"],
            "proto": _BY_KIND[kind]["proto"],
            "version": str(raw.get("version") or _version_of(path)),
            "path": path,
            "source": str(raw.get("source") or "managed"),
            "custom": True,
        }
    # 默认：系统 chromium
    p = _which(_BY_KIND["chromium"]["bins"]) or ""
    return {
        "kind": "chromium",
        "label": "Chromium",
        "proto": "cdp",
        "version": _version_of(p) if p else "",
        "path": p,
        "source": "system",
        "custom": False,
    }


async def set_active(session: Any, kind: str, path: str, version: str, source: str) -> dict[str, Any]:
    e = _BY_KIND.get(kind)
    if e is None:
        raise ValueError(f"不支持的引擎: {kind}")
    if not path or not Path(path).exists():
        raise ValueError(f"驱动不存在: {path}")
    await set_setting(
        session,
        SETTING_KEY,
        {"kind": kind, "path": path, "version": version, "source": source},
    )
    await session.commit()  # set_setting 只写不提交（约定），这里必须落库，否则界面点了不生效
    return await get_active(session)


async def reset_active(session: Any) -> dict[str, Any]:
    """切回系统默认（Chromium）。"""
    await set_setting(session, SETTING_KEY, {})
    await session.commit()
    return await get_active(session)


async def resolve_bin() -> dict[str, Any]:
    """给执行层用：当前该拉哪个可执行文件、什么协议。

    执行层（browser_session）不该知道"设置长什么样"，只要一个答案。
    """
    from .db import SessionLocal

    async with SessionLocal() as s:
        return await get_active(s)


# --------------------------------------------------------------------------- #
# 可用版本（联网查官方清单）
# --------------------------------------------------------------------------- #
async def versions(kind: str, limit: int = 12) -> dict[str, Any]:
    e = _BY_KIND.get(kind)
    if e is None:
        raise ValueError(f"不支持的引擎: {kind}")
    if e["managed"] is None:
        return {
            "kind": kind,
            "managed": False,
            "note": "这个引擎没有官方便携构建，只能用系统包管理器装（装完会自动出现在上面的列表里）",
            "items": [],
        }
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as c:
        if e["managed"] == "cft":
            r = await c.get(CFT_KNOWN)
            r.raise_for_status()
            data = r.json()
            stable = ""
            try:
                lk = (await c.get(CFT_LAST)).json()
                stable = str(((lk.get("channels") or {}).get("Stable") or {}).get("version") or "")
            except Exception:
                pass
            def _linux_url(row: dict[str, Any]) -> str:
                for d in ((row.get("downloads") or {}).get("chrome") or []):
                    if d.get("platform") == "linux64":
                        return str(d.get("url") or "")
                return ""

            rows_all = data.get("versions") or []
            # 稳定版单独捞出来置顶：它往往不是"最新的 12 个"之一，
            # 直接按时间倒序取会让人翻遍列表也找不到"该装哪个"。
            items: list[dict[str, Any]] = []
            if stable:
                for row in rows_all:
                    if str(row.get("version") or "") == stable:
                        url = _linux_url(row)
                        if url:
                            items.append({"version": stable, "url": url, "stable": True})
                        break
            for row in reversed(rows_all):
                if len(items) >= limit:
                    break
                ver = str(row.get("version") or "")
                if not ver or (stable and ver == stable):
                    continue
                url = _linux_url(row)
                if not url:
                    continue
                items.append({"version": ver, "url": url, "stable": False})
            return {"kind": kind, "managed": True, "stable": stable, "items": items}

        # firefox：官方给的是"当前版本号"，下载链接按版本拼
        r = await c.get(FIREFOX_VERSIONS)
        r.raise_for_status()
        d = r.json()
        cur = str(d.get("LATEST_FIREFOX_VERSION") or "")
        items = []
        if cur:
            items.append(
                {
                    "version": cur,
                    "url": f"https://download.mozilla.org/?product=firefox-{cur}-SSL&os=linux64&lang=en-US",
                    "stable": True,
                }
            )
        return {"kind": kind, "managed": True, "stable": cur, "items": items}


# --------------------------------------------------------------------------- #
# 安装（后台任务 + 进度）
# --------------------------------------------------------------------------- #
def job(job_id: str) -> dict[str, Any] | None:
    return _JOBS.get(job_id)


def _new_job(kind: str, version: str) -> dict[str, Any]:
    job_id = f"bd_{int(time.time() * 1000):x}"
    _JOBS[job_id] = {
        "id": job_id,
        "kind": kind,
        "version": version,
        "status": "running",
        "phase": "准备",
        "percent": 0,
        "error": "",
        "path": "",
        "started_at": int(time.time() * 1000),
    }
    return _JOBS[job_id]


def start_install(kind: str, version: str, url: str) -> dict[str, Any]:
    """下载 + 解压到托管目录（后台跑，前端轮询进度）。"""
    e = _BY_KIND.get(kind)
    if e is None:
        raise ValueError(f"不支持的引擎: {kind}")
    if not version or not url:
        raise ValueError("版本与下载地址不能为空")
    existing = _managed_dirs()
    for r in existing:
        if r["kind"] == kind and r["version"] == version:
            raise ValueError(f"{e['label']} {version} 已经装好了")
    j = _new_job(kind, version)
    asyncio.create_task(_install(j["id"], kind, version, url))
    return j


#: 国内镜像（官方源动不动就断在半路，实测 88MB/206MB 就被掐）。
#: 镜像与官方**内容一致**（同一个 CfT 构件），下载完还会校验大小。
def candidate_urls(kind: str, version: str, url: str) -> list[str]:
    out: list[str] = []
    if "storage.googleapis.com/chrome-for-testing-public/" in url:
        path = url.split("chrome-for-testing-public/", 1)[1]
        out.append(f"https://cdn.npmmirror.com/binaries/chrome-for-testing/{path}")
    if kind == "firefox" and "download.mozilla.org" in url:
        out.append(
            f"https://mirrors.tuna.tsinghua.edu.cn/mozilla/firefox/releases/{version}"
            f"/linux-x86_64/en-US/firefox-{version}.tar.xz"
        )
    out.append(url)  # 官方源兜底
    return out


async def _download(url: str, dest: Path, on_progress: Any) -> None:
    """下载到 dest，**断点续传**：连接被掐就带着已下字节数重试（最多 4 次）。"""
    attempts = 0
    while True:
        attempts += 1
        have = dest.stat().st_size if dest.exists() else 0
        headers = {"Range": f"bytes={have}-"} if have else {}
        try:
            async with httpx.AsyncClient(timeout=None, follow_redirects=True) as c:
                async with c.stream("GET", url, headers=headers) as r:
                    if r.status_code == 416:  # 已经下完了
                        return
                    r.raise_for_status()
                    head_total = int(r.headers.get("content-length") or 0)
                    total = head_total + have if have else head_total
                    got = have
                    on_progress(got, total)
                    with open(dest, "ab" if have else "wb") as f:
                        async for chunk in r.aiter_bytes(262144):
                            f.write(chunk)
                            got += len(chunk)
                            on_progress(got, total)
                    if total and got < total:
                        raise IOError(f"下载不完整（{got}/{total} 字节）")
                    return
        except Exception as exc:  # noqa: BLE001
            if attempts >= 4:
                raise
            logger.warning("下载中断（第 %d 次，已有 %d 字节），3 秒后续传：%s", attempts, have, exc)
            await asyncio.sleep(3)


async def _install(job_id: str, kind: str, version: str, url: str) -> None:
    j = _JOBS[job_id]
    ROOT.mkdir(parents=True, exist_ok=True)
    tmp = ROOT / f".tmp-{job_id}"
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        j["phase"] = "下载"
        fname = tmp / ("pkg.tar.xz" if kind == "firefox" else "pkg.zip")
        last_err: Exception | None = None
        for cand in candidate_urls(kind, version, url):
            try:
                j["mirror"] = cand
                await _download(cand, fname, lambda got, total: j.update(
                    {"percent": min(85, int(got * 85 / total)) if total else 0}
                ))
                last_err = None
                break
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                logger.warning("这个源下不下来，换下一个：%s（%s）", cand, exc)
                fname.unlink(missing_ok=True)
        if last_err is not None:
            raise last_err
        j["phase"] = "解压"
        dest = ROOT / f"{kind}-{version}"
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        dest.mkdir(parents=True, exist_ok=True)
        if fname.suffix == ".zip" or zipfile.is_zipfile(fname):
            with zipfile.ZipFile(fname) as z:
                z.extractall(dest)
        else:
            with tarfile.open(fname, "r:*") as t:
                t.extractall(dest)
        # 去掉一层多余目录（firefox/firefox、chrome-linux64/chrome）
        exe = _managed_exe(dest, kind)
        if exe is None:
            raise RuntimeError("解压后没找到可执行文件（下载内容可能不是这个平台的构建）")
        # ⚠ zip 不保留 unix 权限：只给主程序 chmod 的话，Chrome 一启动就死在
        # ``chrome_crashpad_handler: Permission denied``（实测），浏览器直接起不来。
        _fix_perms(dest)
        os.chmod(exe, 0o755)
        shutil.rmtree(tmp, ignore_errors=True)
        j.update({"status": "ok", "phase": "完成", "percent": 100, "path": str(exe)})
        logger.info("浏览器驱动装好了：%s %s → %s", kind, version, exe)
    except Exception as exc:  # noqa: BLE001
        logger.exception("浏览器驱动安装失败：%s %s", kind, version)
        shutil.rmtree(tmp, ignore_errors=True)
        j.update({"status": "error", "phase": "失败", "error": str(exc)})


def remove(kind: str, version: str) -> None:
    """删掉一个托管安装（系统装的不归我们管）。"""
    d = ROOT / f"{kind}-{version}"
    if not d.exists():
        raise ValueError("没有这个托管版本")
    shutil.rmtree(d)
