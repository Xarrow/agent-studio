"""浏览器插件（扩展）：上传/启停/删除，以及启动参数。

为什么要有：扩展只能靠 `--load-extension` 在启动时带上（Chromium 不认运行期装），
而平台是"常驻共享进程 + 每会话 context"，所以扩展变更必须走到"重启进程"这一步。
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest

from agent_studio import browser_extensions as bx


def _ext_zip(name: str = "我的插件", version: str = "1.2.3", prefix: str = "") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        manifest = {
            "manifest_version": 3,
            "name": name,
            "version": version,
            "description": "测试用扩展",
            "background": {"service_worker": "bg.js"},
        }
        base = f"{prefix}/" if prefix else ""
        zf.writestr(f"{base}manifest.json", json.dumps(manifest))
        zf.writestr(f"{base}bg.js", "console.log('hi')\n")
    return buf.getvalue()


def test_安装_列出_启停_删除(tmp_path, monkeypatch):
    monkeypatch.setattr(bx, "EXT_ROOT", tmp_path / "extensions")
    item = bx.install_from_bytes("mine.zip", _ext_zip())
    assert item["name"] == "我的插件"
    assert item["version"] == "1.2.3"
    assert item["enabled"] is True

    items = bx.list_extensions()
    assert [i["dir"] for i in items] == [item["dir"]]
    # 解压后的目录里必须有 manifest（--load-extension 指这里）
    assert (tmp_path / "extensions" / item["dir"] / "manifest.json").is_file()

    dirs = bx.enabled_dirs()
    assert dirs == [str(tmp_path / "extensions" / item["dir"])]
    args = bx.launch_args()
    assert any(a.startswith("--load-extension=") for a in args)
    assert any(a.startswith("--disable-extensions-except=") for a in args)

    bx.set_enabled(item["dir"], False)
    assert bx.enabled_dirs() == []
    assert bx.launch_args() == []

    assert bx.remove(item["dir"]) is True
    assert bx.list_extensions() == []
    assert not (tmp_path / "extensions" / item["dir"]).exists()


def test_manifest_在子目录也能装(tmp_path, monkeypatch):
    """很多扩展包解开是 <扩展名>/manifest.json 这一层，得把内层提上来。"""
    monkeypatch.setattr(bx, "EXT_ROOT", tmp_path / "extensions")
    item = bx.install_from_bytes("nested.zip", _ext_zip(prefix="nested-ext"))
    root = tmp_path / "extensions" / item["dir"]
    assert (root / "manifest.json").is_file()
    assert (root / "bg.js").is_file()


def test_crx_能识别(tmp_path, monkeypatch):
    """crx3 = 'Cr24' + 版本 + 头长 + 头 + zip；只取 zip 部分。"""
    monkeypatch.setattr(bx, "EXT_ROOT", tmp_path / "extensions")
    payload = _ext_zip(name="crx 插件")
    header = b"\x00" * 20
    crx = b"Cr24" + (3).to_bytes(4, "little") + len(header).to_bytes(4, "little") + header + payload
    item = bx.install_from_bytes("pkg.crx", crx)
    assert item["name"] == "crx 插件"


def test_没有_manifest_就拒绝(tmp_path, monkeypatch):
    monkeypatch.setattr(bx, "EXT_ROOT", tmp_path / "extensions")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("readme.txt", "not an extension")
    with pytest.raises(ValueError, match="manifest"):
        bx.install_from_bytes("bad.zip", buf.getvalue())


def test_越界路径拒绝(tmp_path, monkeypatch):
    monkeypatch.setattr(bx, "EXT_ROOT", tmp_path / "extensions")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("../evil.sh", "rm -rf /")
        zf.writestr("manifest.json", json.dumps({"name": "x", "version": "1"}))
    with pytest.raises(ValueError, match="越界"):
        bx.install_from_bytes("evil.zip", buf.getvalue())


def test_非_zip_报错(tmp_path, monkeypatch):
    monkeypatch.setattr(bx, "EXT_ROOT", tmp_path / "extensions")
    with pytest.raises(ValueError, match="zip"):
        bx.install_from_bytes("x.zip", b"not a zip at all")


def test_同名扩展自动加序号(tmp_path, monkeypatch):
    monkeypatch.setattr(bx, "EXT_ROOT", tmp_path / "extensions")
    a = bx.install_from_bytes("a.zip", _ext_zip(name="同名"))
    b = bx.install_from_bytes("b.zip", _ext_zip(name="同名"))
    assert a["dir"] != b["dir"]
    assert len(bx.list_extensions()) == 2
