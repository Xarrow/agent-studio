"""验证层接进编排汇总的那一段（不跑真模型，只验接线对不对）。

要点：
* 干净的结果**一个字都不加**（"验证通过"这种噪声会占掉结论的位置）；
* 有问题时既追加人话，也留结构化 `verification`（界面/回放要吃它）；
* 完成判据从 spec 读，最多 12 条，空行丢掉。
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from types import SimpleNamespace

from agent_studio.orchestrator.service import Orchestrator


def _run(rid: str, name: str, text: str, status: str = "ok", workspace: str = ""):
    return SimpleNamespace(
        id=rid,
        status=status,
        output={"content": text},
        definition_snapshot={"name": name, "workspace": workspace},
        usage={},
    )


def test_完成判据_去空行_最多12条():
    spec = {"acceptance": ["  测试通过 ", "", "  ", *[f"判据{i}" for i in range(20)]]}
    got = Orchestrator._acceptance(spec)
    assert got[0] == "测试通过"
    assert len(got) == 12
    assert "" not in got


def test_完成判据_也接受一段换行文本():
    got = Orchestrator._acceptance({"acceptance": "测试通过\n无新增 lint\n"})
    assert got == ["测试通过", "无新增 lint"]


def test_汇总_干净结果不加任何字():
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        (root / "a.md").write_text("x\n", encoding="utf-8")
        run = _run("r1", "评审 A", "见 a.md:1，无需改动", workspace=str(root))
        out = Orchestrator._with_verification({"content": "结论：无需改动"}, [run], None)
        assert out == {"content": "结论：无需改动"}
        assert "verification" not in out


def test_汇总_引用找不到时追加验证块并留结构化数据():
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        run = _run("r1", "评审 B", "问题在 src/ghost.py:9 这里", workspace=str(root))
        out = Orchestrator._with_verification({"content": "结论：需改"}, [run], ["测试通过"])
        assert "验证" in out["content"]
        assert "src/ghost.py:9" in out["content"]
        assert out["verification"]["unverified"] == ["评审 B"]
        # 判据没被覆盖 → gap 要显式列出，而不是假装完成
        assert out["verification"]["coverage"]["gaps"] == ["测试通过"]
        # 原文保留在最前面，验证只是追加
        assert out["content"].startswith("结论：需改")


def test_汇总_没有runs就原样返回():
    assert Orchestrator._with_verification({"content": "x"}, [], None) == {"content": "x"}
    assert Orchestrator._with_verification(None, [], None) is None
