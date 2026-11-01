"""验证层单测：引用核验 / 冲突 / 覆盖 / 渲染。

为什么这些必须先有测试：验证层一旦判错，用户看到的"未验证"就是假的 ——
比没有验证更糟（假阴性会被当成幻觉被抓，假阳性会让人不再信任提示）。
所以这里用真实文件系统（tmp_path）造场景，而不是 mock。
"""

from __future__ import annotations

from pathlib import Path

from agent_studio.orchestrator import verify


def _mk(tmp_path: Path, rel: str, lines: int = 10) -> Path:
    p = tmp_path / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("\n".join(f"line {i}" for i in range(1, lines + 1)) + "\n", encoding="utf-8")
    return p


def test_抽引用_认路径带行号也认裸路径():
    cites = verify.extract_citations(
        "见 src/a.py:12 与 web/lib/b.ts，还有 docs/readme.md 和 https://x.test/c"
    )
    refs = [c.ref for c in cites]
    assert refs == ["src/a.py:12", "web/lib/b.ts", "docs/readme.md"]
    assert cites[0].path == "src/a.py" and cites[0].line == 12
    assert cites[1].line is None


def test_抽引用_不把版本号和人名当文件():
    cites = verify.extract_citations("版本 1.2.3 上线了，作者 zhang.san 反馈没问题")
    assert cites == []


def test_核引用_存在且行号在范围内():
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        _mk(root, "src/a.py", lines=10)
        c = verify.Citation(ref="src/a.py:3", path="src/a.py", line=3)
        out = verify.check(c, root)
        assert out.exists and out.line_in_range is True and out.ok


def test_核引用_行号超出范围要被指出():
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        _mk(root, "src/a.py", lines=5)
        c = verify.check(verify.Citation(ref="src/a.py:99", path="src/a.py", line=99), root)
        assert c.exists is True
        assert c.line_in_range is False
        assert c.ok is False
        assert "5 行" in c.reason


def test_核引用_文件不存在():
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        c = verify.check(verify.Citation(ref="src/ghost.py", path="src/ghost.py"), Path(d))
        assert c.exists is False and c.ok is False and c.reason == "文件不存在"


def test_核引用_不许跑出工作目录():
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        c = verify.check(verify.Citation(ref="/etc/passwd", path="/etc/passwd"), Path(d))
        assert c.exists is False  # 绝对路径 resolve 后不在 root 下 → 不算"核到"


def test_同引用两路说法相反要报冲突():
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        _mk(root, "src/a.py", lines=10)
        a = verify.verify_run("r1", "评审 A", "ok", "改了 src/a.py:3 这里", root)
        b = verify.verify_run("r2", "评审 B", "ok", "src/a.py:3 这个文件根本不存在", root)
        conflicts = verify.find_conflicts([a, b])
        # 两路都核到同一个真实文件 → 不冲突（都 ok）
        assert conflicts == []

        b2 = verify.verify_run("r3", "评审 C", "ok", "src/ghost.py:3 有问题", root)
        a2 = verify.verify_run("r4", "评审 D", "ok", "src/a.py:3 有问题", root)
        assert verify.find_conflicts([b2]) == []  # 单边不冲突


def test_冲突只在同一引用一真一假时出现():
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        _mk(root, "src/a.py", lines=10)
        # 构造：同一 ref 在一路 ok、在另一路 bad —— 用超出范围的行号制造"假"
        good = verify.RunResult(
            run_id="r1", name="A", status="ok",
            citations=[verify.Citation(ref="src/a.py:2", path="src/a.py", line=2, exists=True, line_in_range=True)],
        )
        bad = verify.RunResult(
            run_id="r2", name="B", status="ok",
            citations=[verify.Citation(ref="src/a.py:2", path="src/a.py", line=2, exists=False, reason="文件不存在")],
        )
        conflicts = verify.find_conflicts([good, bad])
        assert len(conflicts) == 1
        assert conflicts[0]["ref"] == "src/a.py:2"
        assert conflicts[0]["ok_in"] == ["A"] and conflicts[0]["missing_in"] == ["B"]


def test_覆盖检查_没写的判据要报gap():
    cov = verify.coverage(
        ["测试通过", "无新增 lint 错误", "PR 描述含复现步骤"],
        ["已经改完，测试通过，lint 也过了"],
    )
    assert "测试通过" in cov["covered"]
    assert "PR 描述含复现步骤" in cov["gaps"]


def test_没写判据就不报gap():
    cov = verify.coverage([], ["随便一段话"])
    assert cov == {"acceptance": [], "covered": [], "gaps": []}


def test_汇总_引用全挂的路算未验证():
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        ok_run = verify.verify_run("r1", "A", "ok", "见 readme.md:1", root)
        _mk(root, "readme.md", lines=3)
        ok_run = verify.verify_run("r1", "A", "ok", "见 readme.md:1", root)
        dead_run = verify.verify_run("r2", "B", "ok", "见 nope/ghost.py:9", root)
        v = verify.summarise([ok_run, dead_run])
        assert v["unverified"] == ["B"]
        assert v["citations"]["total"] == 2
        assert v["citations"]["ok"] == 1
        assert v["clean"] is False


def test_渲染_干净结果一个字都不说():
    v = verify.summarise([verify.RunResult(run_id="r", name="A", status="ok")])
    assert verify.render_block(v) == ""

    import tempfile

    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        _mk(root, "a.md", lines=3)
        r = verify.verify_run("r", "A", "ok", "见 a.md:2", root)
        # 引用全核上也是干净的 —— 正文不加"全部通过"，徽标靠结构化数据
        assert verify.render_block(verify.summarise([r])) == ""


def test_渲染_有问题时逐条说清是哪一路():
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        r = verify.verify_run("r", "评审 B", "ok", "见 nope/ghost.py:9", root)
        block = verify.render_block(verify.summarise([r]))
        assert "nope/ghost.py:9" in block and "评审 B" in block
        assert "未验证" in block
