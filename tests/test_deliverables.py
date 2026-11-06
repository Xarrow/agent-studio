"""产物（deliverable）识别的单测。

产物是这个产品里唯一"用户要带走的东西"，认错了等于这一轮白干：
入口认错 → 预览空白；越界没挡住 → 能读整台机器；发布不是原子 → 链接打开是半个。
"""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from agent_studio import deliverables as dlv


def _mk(root: Path, files: dict[str, str]) -> Path:
    for rel, content in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
    return root


def test_没有产物目录就是不存在(tmp_path: Path):
    info = dlv.scan(tmp_path)
    assert info.exists is False
    assert info.entry is None
    assert info.to_dict()["file_count"] == 0


def test_空目录不算产物_助手先mkdir后写(tmp_path: Path):
    (tmp_path / dlv.PRODUCT_DIR).mkdir()
    assert dlv.scan(tmp_path).exists is False


def test_网页产物认index_html并给出入口(tmp_path: Path):
    _mk(tmp_path / dlv.PRODUCT_DIR, {"index.html": "<h1>计算器</h1>", "app.js": "1", "style.css": "a{}"})
    info = dlv.scan(tmp_path)
    assert info.exists and info.entry == "index.html" and info.kind == "web"
    assert info.to_dict()["file_count"] == 3
    assert info.size > 0 and info.updated_at


def test_文档产物认readme(tmp_path: Path):
    _mk(tmp_path / dlv.PRODUCT_DIR, {"README.md": "# 报告", "data.csv": "a,b"})
    info = dlv.scan(tmp_path)
    assert info.entry == "README.md" and info.kind == "doc"


def test_没有入口文件时退化成第一个html(tmp_path: Path):
    _mk(tmp_path / dlv.PRODUCT_DIR, {"report.html": "<h1>x</h1>"})
    info = dlv.scan(tmp_path)
    assert info.entry == "report.html" and info.kind == "web"


def test_工程噪音不进清单(tmp_path: Path):
    _mk(tmp_path / dlv.PRODUCT_DIR, {"index.html": "x", "node_modules/a/b.js": "1", ".DS_Store": "1"})
    info = dlv.scan(tmp_path)
    assert [f["path"] for f in info.files] == ["index.html"]


def test_读产物文件不能跳出产物目录(tmp_path: Path):
    _mk(tmp_path / dlv.PRODUCT_DIR, {"index.html": "x"})
    (tmp_path / "secret.txt").write_text("不许读", encoding="utf-8")

    with pytest.raises(PermissionError):
        dlv.resolve_file(tmp_path, "../secret.txt")

    path, rel = dlv.resolve_file(tmp_path, "index.html")
    assert path.read_text(encoding="utf-8") == "x" and rel == "index.html"


def test_没有产物时读文件要报找不到而不是500(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        dlv.resolve_file(tmp_path, "index.html")


def test_打包只打产物里的文件(tmp_path: Path):
    _mk(tmp_path / dlv.PRODUCT_DIR, {"index.html": "x", "sub/a.txt": "a"})
    (tmp_path / "outside.txt").write_text("不算", encoding="utf-8")
    dest = tmp_path / "out.zip"
    n = dlv.write_zip(tmp_path / dlv.PRODUCT_DIR, dest)
    assert n == 2
    with zipfile.ZipFile(dest) as zf:
        assert sorted(zf.namelist()) == ["index.html", "sub/a.txt"]


def test_同一个会话反复发布用同一个slug(tmp_path: Path):
    work = tmp_path / "work"
    _mk(work / dlv.PRODUCT_DIR, {"index.html": "v1"})
    pub = tmp_path / "www"

    first = dlv.publish(work, pub, "ses_abc123def456xyz")
    assert first["slug"] == dlv.slug_for("ses_abc123def456xyz")
    assert (pub / first["slug"] / "index.html").read_text(encoding="utf-8") == "v1"

    (work / dlv.PRODUCT_DIR / "index.html").write_text("v2", encoding="utf-8")
    second = dlv.publish(work, pub, "ses_abc123def456xyz")
    assert second["slug"] == first["slug"]
    assert (pub / second["slug"] / "index.html").read_text(encoding="utf-8") == "v2"
    # 临时目录不许留下
    assert [p.name for p in pub.iterdir()] == [first["slug"]]


def test_没有产物时发布要拒绝(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        dlv.publish(tmp_path / "work", tmp_path / "www", "ses_x")
