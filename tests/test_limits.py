"""分派树的四道闸（纯函数）—— 判据错一个，整棵树就会无限 fork。"""

from __future__ import annotations

from agent_studio import limits


def test_指纹_同助手同任务_标点大小写无关():
    a = limits.fingerprint_of("ag_1", "把 这份报告  总结一下。")
    b = limits.fingerprint_of("ag_1", "把这份报告总结一下")
    assert a == b
    assert len(a) == 16


def test_指纹_换助手或换任务就不同():
    base = limits.fingerprint_of("ag_1", "总结报告")
    assert limits.fingerprint_of("ag_2", "总结报告") != base
    assert limits.fingerprint_of("ag_1", "总结代码") != base


def test_结构环_派发链里已有这个助手():
    path = limits.extend_path("ag_a", "ag_b")
    assert path == "ag_a>ag_b"
    # ag_a 是祖先 → 派回它就是 A→B→A
    assert limits.would_cycle(path, "ag_a") is True
    assert limits.would_cycle(path, "ag_c") is False


def test_结构环_自己派自己放行():
    """分派最常见的用法就是把活拆成 N 路派给自己 —— 判成环等于关掉这个功能。"""
    assert limits.would_cycle("ag_a", "ag_a") is False
    assert limits.would_cycle("ag_a>ag_b", "ag_b") is False


def test_结构环_空路径不算环():
    assert limits.would_cycle(None, "ag_a") is False
    assert limits.would_cycle("", "ag_a") is False


def test_路径超长只留最后几段():
    path = ""
    for i in range(40):
        path = limits.extend_path(path, f"ag_{i}")
    parts = limits.path_agents(path)
    assert len(parts) == limits.PATH_MAX
    assert parts[-1] == "ag_39"


def test_预算_没设上限就是None():
    assert limits.remaining(None, 100) is None
    assert limits.remaining(1000, 300) == 700
    assert limits.remaining(1000, 1200) == -200


def test_预算_累计真花掉的token():
    used = limits.spend([
        {"tokens_in": 10, "tokens_out": 5},
        {"prompt_tokens": 7, "completion_tokens": 3},
        {"llm_calls": 2},
    ])
    assert used == 25


def test_停滞_同一步重复三次():
    marks = [
        {"tool": "bash", "args": "pytest", "status": "error"},
        {"tool": "bash", "args": "pytest", "status": "error"},
        {"tool": "bash", "args": "pytest", "status": "error"},
    ]
    reason = limits.stall_reason(marks)
    assert reason and "重复" in reason and "bash" in reason


def test_停滞_重复但中间有别的调用就不算():
    marks = [
        {"tool": "bash", "args": "pytest", "status": "error"},
        {"tool": "read", "args": "a.py", "status": "ok"},
        {"tool": "bash", "args": "pytest", "status": "error"},
    ]
    assert limits.stall_reason(marks) is None


def test_停滞_连续八步全失败():
    marks = [{"tool": f"t{i}", "args": str(i), "status": "error"} for i in range(8)]
    reason = limits.stall_reason(marks)
    assert reason and "没有" in reason


def test_停滞_有成功结果就不算():
    marks = [{"tool": f"t{i}", "args": str(i), "status": "error"} for i in range(7)]
    marks.append({"tool": "t8", "args": "8", "status": "ok"})
    assert limits.stall_reason(marks) is None


def test_停滞_空输入不误报():
    assert limits.stall_reason([]) is None
    assert limits.stall_reason([{"tool": "bash"}]) is None
