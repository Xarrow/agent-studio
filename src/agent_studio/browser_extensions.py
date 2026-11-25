"""浏览器插件（扩展）：上传 / 启停 / 启动时加载。

为什么单独一个模块：扩展是"进程级"参数（--load-extension 只能在启动时给），
而平台是一个常驻共享 Chromium + 每会话 BrowserContext。所以：

- 装了/停用/删了扩展 → 共享进程必须重启才生效（这里直接触发 shutdown，
  下一个会话会用新参数重新拉起，用户的"下次启动"就是下一条消息）
- 有代理的会话各自 spawn，也走同一份 enabled_dirs()

存的是**解压后的目录**：Chromium 只认目录（--load-extension），crx 文件本身不能直接用。
"""

from __future__ import annotations

import io
import json
import logging
import re
import shutil
import time
import zipfile
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: 跟驱动目录（data/browsers）放一起，跟着数据目录走（迁机器不丢）。
#: 不用 __file__ 推算：部署机是 /opt/agent-studio/app，数据却在 /var/lib/agent-studio。
from .browser_drivers import ROOT as _DRIVER_ROOT

EXT_ROOT = _DRIVER_ROOT / "extensions"
INDEX = "index.json"

#: 单个扩展解压后的体积上限（防止传个几 GB 的包把盘塞满）
MAX_UNPACKED = 200 * 1024 * 1024
MAX_FILES = 5000


def _root() -> Path:
    root = EXT_ROOT
    root.mkdir(parents=True, exist_ok=True)
    return root


def _index_path() -> Path:
    return _root() / INDEX


def _read_index() -> dict[str, Any]:
    p = _index_path()
    if not p.exists():
        return {"items": []}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("items"), list):
            return data
    except Exception:
        logger.warning("扩展索引损坏，按空处理：%s", p, exc_info=True)
    return {"items": []}


def _write_index(data: dict[str, Any]) -> None:
    _index_path().write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _slug(name: str, used: set[str]) -> str:
    base = re.sub(r"[^0-9A-Za-z._\u4e00-\u9fa5-]+", "-", name or "ext").strip("-.") or "ext"
    base = base[:60]
    cand, i = base, 2
    while cand in used:
        cand = f"{base}-{i}"
        i += 1
    used.add(cand)
    return cand


def list_extensions() -> list[dict[str, Any]]:
    """已安装的扩展（含启用状态）。目录被手删掉的条目顺手剔掉，别留幽灵。"""
    data = _read_index()
    root = _root()
    alive: list[dict[str, Any]] = []
    changed = False
    for it in data.get("items", []):
        d = root / str(it.get("dir") or "")
        if not d.is_dir():
            changed = True
            continue
        alive.append(it)
    if changed:
        data["items"] = alive
        _write_index(data)
    return alive


#: 扩展跑在哪一类浏览器上。Chromium 系与 Firefox 的打包/加载方式完全不同：
#: · Chromium：--load-extension=<目录>
#: · Firefox：profile/extensions/<id>.xpi + 放宽签名校验
#: 判错的后果是"装了但没生效"，所以安装时就把目标记住，启动时按目标过滤。
TARGETS = ("chrome", "firefox", "both")


def detect_target(manifest: dict[str, Any]) -> str:
    """从 manifest 判断这个扩展能跑在哪。

    - 有 background.service_worker 且没有 gecko 声明 → Chrome/Chromium 专用
      （Firefox 到 158 仍不支持 MV3 的 service_worker）
    - 有 browser_specific_settings.gecko（或老的 applications.gecko）→ Firefox 系
    - 其余（MV2、纯 content script）→ 两边都能试
    """
    bs = manifest.get("browser_specific_settings") or manifest.get("applications") or {}
    gecko = bool((bs or {}).get("gecko"))
    bg = manifest.get("background") or {}
    has_sw = bool(bg.get("service_worker"))
    has_scripts = bool(bg.get("scripts"))
    if has_sw and not gecko:
        return "chrome"
    if gecko and not has_sw:
        return "firefox"
    if has_sw and gecko:
        return "both"
    if has_scripts and not gecko:
        return "both"
    return "both"


def enabled_dirs(target: str | None = None) -> list[str]:
    """启用中、且与目标浏览器匹配的扩展目录（给 --load-extension 用）。

    ``target`` 传 ``chrome`` / ``firefox``；不传表示不过滤（老调用点）。
    """
    root = _root()
    out: list[str] = []
    for it in list_extensions():
        if not it.get("enabled"):
            continue
        if target:
            t = str(it.get("target") or "both")
            if t not in (target, "both"):
                continue
        d = root / it["dir"]
        if d.is_dir():
            out.append(str(d))
    return out


def launch_args() -> list[str]:
    """Chromium 系的启动参数：没有任何适用的启用扩展时返回空列表。"""
    dirs = enabled_dirs("chrome")
    if not dirs:
        return []
    joined = ",".join(dirs)
    return [f"--disable-extensions-except={joined}", f"--load-extension={joined}"]


def _read_manifest(dirpath: Path) -> dict[str, Any]:
    """扩展的 manifest.json 可能在根，也可能在单层子目录里（解压后常见）。"""
    for cand in [dirpath / "manifest.json", *dirpath.glob("*/manifest.json")]:
        if cand.is_file():
            try:
                return json.loads(cand.read_text(encoding="utf-8"))
            except Exception:
                return {}
    return {}


def _crx_to_zip(data: bytes) -> bytes:
    """crx3 = "Cr24" + 版本 + 头长 + 头 + zip。截出 zip 部分；不是 crx 就原样返回。"""
    if data[:4] != b"Cr24":
        return data
    if len(data) < 16:
        return data
    version = int.from_bytes(data[4:8], "little")
    if version == 3:
        header_len = int.from_bytes(data[8:12], "little")
        start = 12 + header_len
    else:  # crx2
        pub_len = int.from_bytes(data[8:12], "little")
        sig_len = int.from_bytes(data[12:16], "little")
        start = 16 + pub_len + sig_len
    return data[start:] if 0 <= start < len(data) else data


def install_from_bytes(filename: str, data: bytes) -> dict[str, Any]:
    """上传一个 .zip / .crx，解压进 extensions/<dir>/。

    只认带 manifest.json 的包（God 知道别人会传什么）；体积与文件数都有上限。
    """
    if not data:
        raise ValueError("空文件")
    raw = _crx_to_zip(data)
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise ValueError("只支持 .zip 或 .crx（这俩都是 zip 结构）") from exc

    infos = zf.infolist()
    if len(infos) > MAX_FILES:
        raise ValueError(f"包内文件太多（{len(infos)} > {MAX_FILES}）")
    total = sum(i.file_size for i in infos)
    if total > MAX_UNPACKED:
        raise ValueError(f"解压后太大（{total // 1024 // 1024}MB > {MAX_UNPACKED // 1024 // 1024}MB）")

    root = _root()
    tmp = root / f".tmp-{int(time.time() * 1000)}"
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        for info in infos:
            if info.is_dir():
                continue
            # zip 里的软链（外部属性 0o120000）一律跳过
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                continue
            out = (tmp / info.filename).resolve()
            if tmp.resolve() not in out.parents:
                raise ValueError(f"压缩包里有越界路径：{info.filename}")
            out.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, out.open("wb") as dst:
                shutil.copyfileobj(src, dst)

        manifest = _read_manifest(tmp)
        if not manifest:
            raise ValueError("这个包里没有 manifest.json —— 不是浏览器扩展")
        # manifest 在单层子目录时，把那一层提上来（--load-extension 要指到含 manifest 的目录）
        if not (tmp / "manifest.json").exists():
            sub = next((p for p in tmp.iterdir() if p.is_dir() and (p / "manifest.json").is_file()), None)
            if sub is not None:
                for child in list(sub.iterdir()):
                    shutil.move(str(child), str(tmp / child.name))
                sub.rmdir()

        name = str(manifest.get("name") or Path(filename).stem or "extension")
        # manifest 的 name 可能是 __MSG_xxx__ 占位（本地化用），这种就退回文件名
        if name.startswith("__MSG_"):
            name = Path(filename).stem or "extension"
        data_idx = _read_index()
        used = {str(it.get("dir")) for it in data_idx["items"]}
        slug = _slug(name, used)
        target = root / slug
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
        tmp.rename(target)
        item = {
            "dir": slug,
            "name": name,
            "version": str(manifest.get("version") or ""),
            "description": str(manifest.get("description") or "")[:300],
            "manifest_version": manifest.get("manifest_version"),
            "target": detect_target(manifest),
            "enabled": True,
            "file": filename,
            "size": total,
            "installed_at": int(time.time() * 1000),
        }
        data_idx["items"] = [it for it in data_idx["items"] if it.get("dir") != slug] + [item]
        _write_index(data_idx)
        logger.info("浏览器扩展已安装：%s（%s）", name, slug)
        return item
    finally:
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)


def set_enabled(dir_name: str, enabled: bool) -> dict[str, Any]:
    data = _read_index()
    for it in data["items"]:
        if it.get("dir") == dir_name:
            it["enabled"] = bool(enabled)
            _write_index(data)
            return it
    raise KeyError(dir_name)


def remove(dir_name: str) -> bool:
    data = _read_index()
    keep = [it for it in data["items"] if it.get("dir") != dir_name]
    if len(keep) == len(data["items"]):
        return False
    data["items"] = keep
    _write_index(data)
    shutil.rmtree(_root() / dir_name, ignore_errors=True)
    return True


async def restart_shared_browser() -> None:
    """扩展是启动参数，改了必须重启常驻进程才会生效。

    只重启"共享池"；有代理的会话本来就各自 spawn，下条消息自然是新参数。
    正在跑的会话不受影响（它们本来就是独立实例或已有 context）。
    """
    try:
        from . import browser_pool

        await browser_pool.shutdown()
    except Exception:
        logger.debug("重启共享浏览器失败（下次启动会自然带上新参数）", exc_info=True)


def _gecko_id(manifest: dict[str, Any], fallback: str) -> str:
    bs = manifest.get("browser_specific_settings") or manifest.get("applications") or {}
    gid = str(((bs or {}).get("gecko") or {}).get("id") or "").strip()
    if gid:
        return gid
    # 没写 id：Firefox 对"散装的目录扩展"不认，必须给一个稳定 id 打成 xpi
    safe = re.sub(r"[^0-9A-Za-z._-]+", "-", fallback).strip("-.") or "ext"
    return f"{safe}@agent-studio.local"


def _build_xpi(ext_dir: Path, out: Path, gid: str) -> None:
    """把一个扩展目录打成 xpi（= zip）。没有 gecko id 的顺手补进 manifest。"""
    buf = io.BytesIO()
    manifest_path = ext_dir / "manifest.json"
    manifest = {}
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        manifest = {}
    if not (manifest.get("browser_specific_settings") or {}).get("gecko"):
        bs = manifest.get("browser_specific_settings") or {}
        bs["gecko"] = {**(bs.get("gecko") or {}), "id": gid}
        manifest["browser_specific_settings"] = bs
        manifest.setdefault("applications", {"gecko": {"id": gid}})
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        for f in ext_dir.rglob("*"):
            if not f.is_file() or f.name == "manifest.json":
                continue
            zf.write(f, str(f.relative_to(ext_dir)))
    out.write_bytes(buf.getvalue())


def prepare_firefox_profile(profile_dir: Path) -> list[str]:
    """把启用中的 Firefox 扩展装进 profile：extensions/<id>.xpi + 放宽签名。

    Firefox 没有 Chromium 那种 --load-extension；headless 下唯一稳的方式是在
    profile 里预置 xpi，并用 user.js 关掉签名校验（自建/未上架扩展否则会被禁用）。
    返回装上的扩展 id 列表（写日志用）。
    """
    root = _root()
    dirs = enabled_dirs("firefox")
    if not dirs:
        return []
    ext_dir = profile_dir / "extensions"
    ext_dir.mkdir(parents=True, exist_ok=True)
    ids: list[str] = []
    for d in dirs:
        dp = Path(d)
        try:
            manifest = json.loads((dp / "manifest.json").read_text(encoding="utf-8"))
        except Exception:
            logger.warning("Firefox 扩展缺少可读的 manifest，跳过：%s", dp)
            continue
        gid = _gecko_id(manifest, dp.name)
        target = ext_dir / f"{gid}.xpi"
        try:
            _build_xpi(dp, target, gid)
            ids.append(gid)
        except Exception:
            logger.warning("Firefox 扩展打包失败：%s", dp, exc_info=True)

    if ids:
        user_js = profile_dir / "user.js"
        lines = [
            'user_pref("xpinstall.signatures.required", false);',
            'user_pref("extensions.autoDisableScopes", 0);',
            'user_pref("extensions.enabledScopes", 15);',
            'user_pref("extensions.installDistroAddons", false);',
            'user_pref("extensions.sideloadScopes", 15);',
        ]
        try:
            old = user_js.read_text(encoding="utf-8") if user_js.exists() else ""
            merged = old
            for ln in lines:
                if ln not in merged:
                    merged += ("\n" if merged and not merged.endswith("\n") else "") + ln + "\n"
            user_js.write_text(merged, encoding="utf-8")
        except Exception:
            logger.warning("写 Firefox user.js 失败（扩展可能被禁用）", exc_info=True)
    return ids
