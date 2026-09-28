"""运行环境自检与安装的护栏。

用户要的是："检测有没有 python / nodejs，没有就下载安装"。这套东西最容易
悄悄出错 —— 装了个跑不起来的包、哈希不对还硬装、或者把系统环境弄坏。
所以守住四条：

① 架构/文件名映射要对（x86_64 → x64，aarch64 → arm64）—— 映射错了下载必然 404；
② **校验不过绝不安装**（并且把已下载的坏文件删掉），不能留下半截状态；
③ 装完**必须真跑一次 --version**：包解开但跑不起来 = 没装好 → 不写 current 软链；
④ 只装到平台自己的目录（``runtime/``），不动系统 —— 用户立过规矩：不擅自装系统包。

中间那段用**本地假包**跑完整流程（下载→校验→解包→跑版本→切软链），不联网。
"""

from __future__ import annotations

import hashlib
import io
import os
import tarfile
from pathlib import Path

import pytest

from agent_studio.api import environment as env


def _fake_node_tarxz(version: str, arch: str, *, script: str | None = None) -> bytes:
    """造一个 node 发行包：只含 bin/node（一个能打印版本的 shell 脚本）。"""
    buf = io.BytesIO()
    top = f"node-{version}-linux-{arch}"
    body = script if script is not None else f'#!/bin/sh\necho "{version}"\n'
    with tarfile.open(fileobj=buf, mode="w:xz") as tf:
        for name, data in (("bin/node", body), ("README.md", "fake\n")):
            raw = data.encode()
            info = tarfile.TarInfo(f"{top}/{name}")
            info.size = len(raw)
            info.mode = 0o755
            tf.addfile(info, io.BytesIO(raw))
    return buf.getvalue()


def _write_shasums(tmp_path: Path, asset: str, blob: bytes) -> Path:
    p = tmp_path / "SHASUMS256.txt"
    p.write_text(f"{hashlib.sha256(blob).hexdigest()}  {asset}\n")
    return p


def test_架构与包名映射():
    assert env.node_arch("x86_64") == "x64"
    assert env.node_arch("AMD64") == "x64"
    assert env.node_arch("aarch64") == "arm64"
    assert env.node_asset_name("v22.14.0", "x86_64") == "node-v22.14.0-linux-x64.tar.xz"


def test_取校验和_要能对上带星号的写法():
    text = "abc123  node-v1-linux-x64.tar.xz\n" "def456 *node-v2-linux-x64.tar.xz\n"
    assert env.parse_shasums(text, "node-v1-linux-x64.tar.xz") == "abc123"
    assert env.parse_shasums(text, "node-v2-linux-x64.tar.xz") == "def456"
    assert env.parse_shasums(text, "node-v3-linux-x64.tar.xz") is None


@pytest.mark.asyncio
async def test_完整安装流程_校验通过并真跑版本(tmp_path):
    version = "v22.14.0"
    asset = env.node_asset_name(version, "x86_64")
    blob = _fake_node_tarxz(version, env.node_arch("x86_64"))
    shasums = _write_shasums(tmp_path, asset, blob)

    async def fake_fetch(url: str) -> bytes:
        assert url.endswith("SHASUMS256.txt")
        return shasums.read_bytes()

    async def fake_download(url: str, dest: Path) -> None:
        assert url.endswith(asset)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(blob)

    job = {"id": "t1", "target": "node", "version": version, "status": "running", "steps": []}
    root = tmp_path / "runtime"
    await env._install_node(job, version, fetcher=fake_fetch, downloader=fake_download, root=root)

    node_bin = root / "node" / version / "bin" / "node"
    assert node_bin.exists(), "解包后应该有 bin/node"
    assert os.access(node_bin, os.X_OK), "可执行位要保留（不然跑不起来）"
    current = root / "node" / "current"
    assert current.is_symlink() and current.resolve() == node_bin.parent.parent.resolve()
    assert not list((root / "node").glob("*.part")), "临时文件要清掉"
    log = "\n".join(s["line"] for s in job["steps"])
    assert "校验通过" in log and "✅" in log


@pytest.mark.asyncio
async def test_校验不过就绝不安装_并删掉坏文件(tmp_path):
    version = "v22.14.0"
    asset = env.node_asset_name(version, "x86_64")
    good = _fake_node_tarxz(version, env.node_arch("x86_64"))
    shasums = _write_shasums(tmp_path, asset, good)

    async def fake_fetch(url: str) -> bytes:
        return shasums.read_bytes()

    async def bad_download(url: str, dest: Path) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"this is not the tarball")

    job = {"id": "t2", "target": "node", "version": version, "status": "running", "steps": []}
    root = tmp_path / "runtime"
    with pytest.raises(RuntimeError) as ei:
        await env._install_node(job, version, fetcher=fake_fetch, downloader=bad_download, root=root)
    assert "校验不过" in str(ei.value)
    assert not (root / "node" / version).exists(), "校验不过不能留下已解包目录"
    assert not list((root / "node").glob("*.part")), "坏文件要删掉，别留半截状态"
    assert not (root / "node" / "current").exists()


@pytest.mark.asyncio
async def test_包解开但跑不起来_也不能算装好(tmp_path):
    """假包里的 bin/node 是个跑不了的脚本 → 必须失败、且不写 current。"""
    version = "v22.14.0"
    asset = env.node_asset_name(version, "x86_64")
    blob = _fake_node_tarxz(version, env.node_arch("x86_64"), script="#!/bin/sh\nexit 3\n")
    shasums = _write_shasums(tmp_path, asset, blob)

    async def fake_fetch(url: str) -> bytes:
        return shasums.read_bytes()

    async def fake_download(url: str, dest: Path) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(blob)

    job = {"id": "t3", "target": "node", "version": version, "status": "running", "steps": []}
    root = tmp_path / "runtime"
    with pytest.raises(RuntimeError) as ei:
        await env._install_node(job, version, fetcher=fake_fetch, downloader=fake_download, root=root)
    assert "跑不起来" in str(ei.value)
    assert not (root / "node" / "current").exists(), "跑不起来就不能切成默认"


@pytest.mark.asyncio
async def test_检测接口给出结论与安装提示(client):
    got = await client.get("/api/environment/runtimes")
    assert got.status_code == 200
    body = got.json()
    assert body["python"]["found"] is True
    assert body["python"]["version"].startswith("3.")
    assert body["python"]["installable"] is True
    # node 有没有都不该报错 —— 没有就给"可安装"的说明
    node = body["node"]
    assert node["found"] in (True, False)
    if not node["found"]:
        assert node["installable"] is True and node["install_note"]
    assert body["os"]["machine"]
    assert body["runtime_dir"].endswith("runtime")
