"""读的语义：**除禁区外不限制、不要确认**（用户 2026-11 定的第 2 条）。

以前这里是「越界读 = ASK」。改成现在这样是因为用户明确要求：

    读：除 ~/.hermes 外，读取不限制 —— 家目录 ~/ 下文件可读，
    其他目录（含其他会话的工作目录）也可读，不需要确认。

所以要守住的不再是"越界读要问"，而是三件事：
1. 读别处**不再问**（别退回去）
2. 禁区 ``~/.hermes`` 照样**硬拦**（含符号链接指向它）
3. 写归写那条线管，别被读的规则顺手放过去
"""

from __future__ import annotations

import os

import pytest

from agent_studio import guardrails as g

WS = "/srv/src/agent-studio/data/work/sessions/ses_a"


def _read(name: str, **inp) -> g.Verdict | None:
    return g.classify_tool_call(name, inp, WS, [WS])


@pytest.mark.parametrize(
    "name,inp",
    [
        ("read", {"file_path": "/etc/hostname"}),
        ("read", {"file_path": "/srv/src/other-project/app.py"}),
        ("read", {"file_path": "~/notes.md"}),
        ("read", {"file_path": "/srv/src/agent-studio/data/work/sessions/ses_b/other.md"}),
        ("grep", {"path": "/var/log", "pattern": "error"}),
        ("glob", {"path": "/home", "pattern": "**/*.md"}),
        ("bash", {"command": "cat /etc/hostname"}),
        ("bash", {"command": "head -20 /srv/src/other/x.py"}),
        ("python", {"code": "print(open('/etc/hostname').read())"}),
    ],
)
def test_越界读不再问(name, inp):
    v = _read(name, **inp)
    assert v is None or v.rule != "read-scope", f"{name} {inp} 还在问读取确认：{v}"


def test_可读范围开关还在_只是默认关():
    """口径会变，判定点只留一处：把开关打开就恢复旧行为。"""
    assert g.READ_REQUIRES_CONFIRM is False


def test_凭据位置仍然是硬拦不是问():
    v = g.classify_tool_call("read", {"file_path": "/root/.hermes/config.yaml"}, WS, [WS, "/"])
    assert v is not None and v.risk == g.RISK_DENY and v.rule == "protected-dir"
    assert "受保护" in v.reason


def test_符号链接指向禁区也算禁区(tmp_path):
    link = tmp_path / "sneaky"
    os.symlink("/root/.hermes", link)
    v = g.classify_tool_call("read", {"file_path": str(link / "config.yaml")}, WS, [WS])
    assert v is not None and v.risk == g.RISK_DENY and v.rule == "protected-dir"


def test_写归写那条线管():
    v = g.classify_tool_call("write", {"file_path": "/tmp/out.txt", "content": "x"}, WS, [WS])
    assert v is not None and v.rule == "file-write" and v.risk == g.RISK_ASK
