"""取回：git 与归档两条路径产物一致；恶意压缩包被拒；提交 ID 与来源标注。"""

from __future__ import annotations

import tarfile
from pathlib import Path

import pytest

from agent_studio.skill_sources import fetch as F
from agent_studio.skill_sources.discover import discover
from agent_studio.skill_sources.netpolicy import NetPolicy
from agent_studio.skill_sources.parser import SourceRef

from fixtures_skills import (
    ArchiveServer,
    evil_tarball,
    make_git_repo,
    skill_tree,
    tarball_of,
)

pytestmark = pytest.mark.anyio

SKILLS = {"alpha": "第一个技能", "beta": "第二个技能"}


@pytest.fixture
def repo(tmp_path: Path) -> tuple[Path, str]:
    root = skill_tree(tmp_path / "repo", SKILLS)
    sha = make_git_repo(root)
    return root, sha


async def test_git_and_archive_produce_identical_skills(repo, tmp_path, monkeypatch):
    root, sha = repo
    g = await F.fetch_via_git(SourceRef(kind="local", raw=str(root)), policy=NetPolicy(proxy_mode="off"))
    try:
        a = discover(g.root)
    finally:
        g.cleanup()

    data = tarball_of(root)
    srv = ArchiveServer(routes={"/repo.tar.gz": data}).start()
    try:
        plat = [{"name": "fixture", "host": "127.0.0.1",
                 "archive_template": srv.base + "/repo.tar.gz", "api_template": "", "ref_template": ""}]
        t = await F.fetch_via_archive(
            SourceRef(kind="git", host="127.0.0.1", owner="o", repo="r"), policy=NetPolicy(proxy_mode="off", bypass_loopback=False), platforms=plat
        )
        try:
            b = discover(t.root)
        finally:
            t.cleanup()
    finally:
        srv.stop()

    assert [x.name for x in a] == [x.name for x in b]
    assert [x.content_hash for x in a] == [x.content_hash for x in b]
    assert g.commit == sha


@pytest.mark.parametrize("kind,code", [
    ("traversal", "unsafe_path"),
    ("absolute", "unsafe_path"),
    ("symlink", "unsafe_entry"),
    ("device", "unsafe_entry"),
])
async def test_evil_archive_rejected(tmp_path, kind, code):
    with pytest.raises(F.FetchError) as ei:
        F.unpack_archive(evil_tarball(kind), tmp_path / "out")
    assert ei.value.code == code


async def test_entry_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(F, "MAX_ENTRIES", 3)
    buf = tmp_path / "many.tar.gz"
    import io

    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:gz") as tf:
        for i in range(10):
            p = tmp_path / f"f{i}.txt"
            p.write_text("x", encoding="utf-8")
            tf.add(p, arcname=f"top/f{i}.txt")
    with pytest.raises(F.FetchError) as ei:
        F.unpack_archive(data.getvalue(), tmp_path / "o")
    assert ei.value.code == "too_many_entries"


async def test_size_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(F, "MAX_UNPACKED_BYTES", 10)
    import io

    p = tmp_path / "big.txt"
    p.write_text("x" * 100, encoding="utf-8")
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:gz") as tf:
        tf.add(p, arcname="top/big.txt")
    with pytest.raises(F.FetchError) as ei:
        F.unpack_archive(data.getvalue(), tmp_path / "o2")
    assert ei.value.code == "too_large"


async def test_archive_top_dir_stripped(tmp_path):
    import io

    src = skill_tree(tmp_path / "s", {"one": "只有一个"})
    data = tarball_of(src, strip_top="anything-hash")
    F.unpack_archive(data, tmp_path / "out")
    assert (tmp_path / "out" / "skills" / "one" / "SKILL.md").is_file()


async def test_mirror_marks_unverified(tmp_path):
    src = skill_tree(tmp_path / "s", {"m": "镜像来源"})
    data = tarball_of(src)
    srv = ArchiveServer(routes={"/good.tar.gz": data, "/mirror.tar.gz": data}).start()
    try:
        plat = [{"name": "fx", "host": "127.0.0.1", "archive_template": srv.base + "/missing.tar.gz"}]
        policy = NetPolicy(proxy_mode="off", bypass_loopback=False, mirrors=[srv.base + "/good.tar.gz"])
        # 镜像模板：base + 路径片段
        got = await F.fetch_via_archive(
            SourceRef(kind="git", host="127.0.0.1", owner="o", repo="r"), policy=policy, platforms=plat
        )
        try:
            assert got.integrity == "mirror-unverified"
            assert any("镜像" in n for n in got.notes)
        finally:
            got.cleanup()
    finally:
        srv.stop()


async def test_needs_git_for_unknown_host():
    with pytest.raises(F.FetchError) as ei:
        await F.fetch_via_archive(
            SourceRef(kind="git", host="git.internal", owner="o", repo="r"),
            policy=NetPolicy(proxy_mode="off"), platforms=[],
        )
    assert ei.value.code == "needs_git"


async def test_local_source_not_downloaded():
    with pytest.raises(F.FetchError):
        await F.fetch(SourceRef(kind="local", raw="/tmp"), policy=NetPolicy())
