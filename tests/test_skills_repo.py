"""仓库引用解析与发现（skills_repo）—— 纯函数单测，不打网络。

守的是「一条引用就能装」的契约：用户脑子里是 ``tt-a1i/archify`` 这样的地址，
平台必须接受它（以及社区文档里出现的各种变体），而不是逼他换算成
clone URL + 子目录 + 版本号。
"""

from __future__ import annotations

import io
import tarfile

import pytest

from agent_studio.skills_repo import (
    RepoRef,
    parse_repo_ref,
    parse_skill_md,
    pick_skills,
    scan_tarball,
    tarball_sha,
    tarball_urls,
)


# --------------------------------------------------------------------------- #
# 解析
# --------------------------------------------------------------------------- #
def test_解析最常用的一条引用():
    r = parse_repo_ref("tt-a1i/archify")
    assert (r.owner, r.repo, r.ref, r.subpath) == ("tt-a1i", "archify", None, None)
    assert r.slug == "tt-a1i/archify"
    assert r.web_url == "https://github.com/tt-a1i/archify"


def test_解析仓库内子目录与版本():
    r = parse_repo_ref("vercel-labs/skills/skills/web-design")
    assert (r.owner, r.repo, r.subpath, r.ref) == ("vercel-labs", "skills", "skills/web-design", None)

    r2 = parse_repo_ref("tt-a1i/archify@v2.16.0")
    assert (r2.repo, r2.ref, r2.subpath) == ("archify", "v2.16.0", None)

    r3 = parse_repo_ref("minio/skills/aimem@main")
    assert (r3.repo, r3.subpath, r3.ref) == ("skills", "aimem", "main")


def test_解析网页链接与_ssh_地址():
    a = parse_repo_ref("https://github.com/tt-a1i/archify")
    assert (a.owner, a.repo, a.ref, a.subpath) == ("tt-a1i", "archify", None, None)

    b = parse_repo_ref("https://github.com/tt-a1i/archify/tree/main/skills/diagramming")
    assert (b.owner, b.repo, b.ref, b.subpath) == ("tt-a1i", "archify", "main", "skills/diagramming")

    c = parse_repo_ref("git@github.com:tt-a1i/archify.git")
    assert (c.owner, c.repo) == ("tt-a1i", "archify")

    d = parse_repo_ref("git+https://github.com/tt-a1i/archify.git")
    assert (d.owner, d.repo) == ("tt-a1i", "archify")


def test_解析拒绝无效输入():
    for bad in ["", "   ", "archify", "/", "https://gitlab.com/a/b"]:
        with pytest.raises(ValueError):
            parse_repo_ref(bad)


def test_下载地址先直连后镜像且不用_git():
    urls = tarball_urls("tt-a1i", "archify", "v2.16.0")
    assert urls[0] == "https://codeload.github.com/tt-a1i/archify/tar.gz/v2.16.0"
    assert any(u.startswith("https://gh-proxy.com/") for u in urls), "要有镜像兜底"
    assert all("git clone" not in u for u in urls)


def test_没有版本时用_HEAD():
    assert tarball_urls("o", "r", None)[0].endswith("/tar.gz/HEAD")


# --------------------------------------------------------------------------- #
# 发现（用合成的 tarball，不打网络）
# --------------------------------------------------------------------------- #
def _tarball(files: dict[str, str | bytes], root: str = "archify-abc123") -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for rel, content in files.items():
            raw = content.encode() if isinstance(content, str) else content
            info = tarfile.TarInfo(f"{root}/{rel}")
            info.size = len(raw)
            tf.addfile(info, io.BytesIO(raw))
    return buf.getvalue()


SKILL_MD = """---
name: archify
description: 把架构、流程、时序需求变成可交互的 HTML 图
version: 2.16.0
---

# Archify

用 Excalidraw/HTML 出图。
"""


def test_仓库根就是技能():
    data = _tarball({"SKILL.md": SKILL_MD, "references/api.md": "# 参考"})
    entries = scan_tarball(data)
    assert len(entries) == 1
    e = entries[0]
    assert (e.path, e.name) == ("", "archify")
    assert "可交互的 HTML 图" in e.description
    assert e.files == {"references/api.md": "# 参考"}


def test_多技能仓库按约定目录排序():
    data = _tarball(
        {
            "README.md": "说明",
            "skills/web-design/SKILL.md": "---\nname: web-design\ndescription: 设计\n---\n",
            ".agents/skills/atlas/SKILL.md": "---\nname: atlas\ndescription: 代码地图\n---\n",
            "docs/inner/SKILL.md": "---\nname: inner\ndescription: 非约定位置\n---\n",
        }
    )
    entries = scan_tarball(data)
    assert [e.name for e in entries] == ["atlas", "web-design", "inner"], "约定目录优先，其它排后"
    assert entries[0].convention and not entries[-1].convention


def test_子目录限定与单技能短路():
    data = _tarball(
        {
            "skills/a/SKILL.md": "---\nname: a\ndescription: A\n---\n",
            "skills/b/SKILL.md": "---\nname: b\ndescription: B\n---\n",
            "skills/b/scripts/run.sh": "echo hi",
        }
    )
    only_a = scan_tarball(data, subpath="skills/a")
    assert [e.name for e in only_a] == ["a"]

    only_b = scan_tarball(data, subpath="skills/b")
    assert [e.name for e in only_b] == ["b"]
    assert only_b[0].files == {"scripts/run.sh": "echo hi"}


def test_子目录与技能名两种挑法():
    data = _tarball(
        {
            "skills/a/SKILL.md": "---\nname: alpha\ndescription: A\n---\n",
            "skills/b/SKILL.md": "---\nname: beta\ndescription: B\n---\n",
        }
    )
    entries = scan_tarball(data)
    assert [e.name for e in pick_skills(entries, paths=["skills/b"])] == ["beta"]
    assert [e.name for e in pick_skills(entries, paths=["beta"])] == ["beta"], "给技能名也能挑中"
    assert [e.name for e in pick_skills(entries, paths=["alpha"])] == ["alpha"]
    assert len(pick_skills(entries, paths=None)) == 2
    with pytest.raises(ValueError) as ei:
        pick_skills(entries, paths=["不存在"])
    assert "没找到指定的技能" in str(ei.value)


def test_没找到_SKILL_md_时报错说人话():
    data = _tarball({"README.md": "只有说明"})
    with pytest.raises(ValueError) as ei:
        scan_tarball(data)
    assert "没找到 SKILL.md" in str(ei.value)


def test_二进制与超大文件不入库():
    data = _tarball(
        {
            "SKILL.md": SKILL_MD,
            "assets/logo.png": b"\x89PNG\r\n\x1a\n\x00\x00binary",
            "assets/big.md": "x" * 300_000,
            "notes.txt": "纯文本",
        }
    )
    e = scan_tarball(data)[0]
    assert set(e.files) == {"notes.txt"}, "二进制和超 200KB 的文件要跳过"


def test_从根目录名里认出_commit():
    assert tarball_sha("archify-" + "a" * 40) == "a" * 40
    assert tarball_sha("archify-v2.16.0") is None
    assert tarball_sha(None) is None


def test_frontmatter_缺失时退化成目录名与首行():
    name, desc = parse_skill_md("# 标题\n\n这是一句话说明。\n", "my-skill")
    assert name == "my-skill"
    assert desc == "这是一句话说明。"
