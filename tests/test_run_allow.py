"""同一次运行里点过一次「允许」，后续同名工具调用不该再弹。

实测现场：模型循环调 worker_status，用户点一次允许 → 引擎续跑 → 又一次 ASK →
再弹一次，点十次也停不下来。会话级白名单只在编译期读一次，中途写库救不了
正在跑的这轮，所以这里用进程内按 run 记一份。
"""

from __future__ import annotations

from agent_studio.runtimes.agentscope_rt.guard import (
    _RUN_ALLOW,
    allow_for_run,
    clear_run_allow,
    run_allowed,
)


def test_允许后同一运行内同名工具直接放行():
    allow_for_run("run_x", "worker_status")
    assert run_allowed("run_x", "worker_status") is True
    # 别的工具、别的运行都不受影响
    assert run_allowed("run_x", "bash") is False
    assert run_allowed("run_y", "worker_status") is False


def test_运行结束清掉记录():
    allow_for_run("run_z", "bash")
    clear_run_allow("run_z")
    assert run_allowed("run_z", "bash") is False
    assert "run_z" not in _RUN_ALLOW


def test_空参数不记():
    allow_for_run("", "bash")
    allow_for_run("run_a", "")
    assert run_allowed("", "bash") is False
    assert run_allowed("run_a", "") is False
