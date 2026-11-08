"""可读范围：会话目录之外的文件，读之前要人点头。

为什么读也要管：AgentScope 的只读快速通道是**无条件**放行的（Read /etc/hostname
在严格模式也 allow），平台许诺的"文件范围"其实只管写。这一层把范围补回来：
越界读 = ASK（问一次），不是 DENY —— 很多时候它确实需要看一眼别人的目录。

判定的难点在"别吵"：系统自带的 /usr、/bin、运行时 python 不该问；
相对路径就是在自己目录里，不该问；URL、命令行开关也不是路径。
"""

from __future__ import annotations

import pytest

from agent_studio import guardrails as g

WS = "/srv/src/agent-studio/data/work/sessions/ses_a"


def _read(name: str, **inp) -> g.Verdict | None:
    return g.classify_tool_call(name, inp, WS, [WS])


@pytest.mark.parametrize(
    "name,inp,expect",
    [
        ("read", {"file_path": "/etc/hostname"}, "/etc/hostname"),
        ("read", {"file_path": "/srv/src/other-project/app.py"}, "/srv/src/other-project/app.py"),
        ("read", {"file_path": "~/notes.md"}, "~/notes.md"),
        ("grep", {"path": "/var/log", "pattern": "error"}, "/var/log"),
        ("glob", {"path": "/home", "pattern": "**/*.md"}, "/home"),
        ("bash", {"command": "cat /etc/hostname"}, "/etc/hostname"),
        ("bash", {"command": "head -20 /srv/src/other/x.py"}, "/srv/src/other/x.py"),
        ("bash", {"command": "grep -rn secret /var/log/"}, "/var/log/"),
        ("python", {"code": "print(open('/etc/hostname').read())"}, "/etc/hostname"),
    ],
)
def test_越界读要问(name, inp, expect):
    v = _read(name, **inp)
    assert v is not None, f"{name} {inp} 应该触发确认"
    assert v.risk == g.RISK_ASK
    assert v.rule == "read-scope"
    assert expect in v.reason


@pytest.mark.parametrize(
    "name,inp",
    [
        ("read", {"file_path": f"{WS}/notes.md"}),
        ("read", {"file_path": "notes.md"}),  # 相对 = 就在自己目录
        ("read", {"file_path": "/usr/share/doc/readme", "limit": 10}),
        ("bash", {"command": "ls /usr/bin/python3"}),
        ("bash", {"command": "cat README.md"}),
        ("bash", {"command": "python3 -m pytest tests/"}),
        ("bash", {"command": "curl https://example.com/a/b"}),
        ("grep", {"path": WS, "pattern": "TODO"}),
        ("grep", {"pattern": "/api/runs"}),  # 正则不是路径
        ("write", {"file_path": "/tmp/out.txt", "content": "x"}),  # 写归写那条线管
    ],
)
def test_不吵人(name, inp):
    v = _read(name, **inp)
    assert v is None or v.rule != "read-scope", f"{name} {inp} 被 read-scope 误伤：{v}"


def test_配了额外可读目录就不问():
    other = "/srv/src/other-project/app.py"
    assert g.classify_tool_call("read", {"file_path": other}, WS, [WS]) is not None
    assert g.classify_tool_call("read", {"file_path": other}, WS, [WS, "/srv/src"]) is None


def test_申请了全盘就不判():
    """"和 Hermes 一样的权限"这个口径要留：配了 / 就一层都不管。"""
    assert g.classify_tool_call("read", {"file_path": "/etc/hostname"}, WS, [WS, "/"]) is None


def test_凭据位置仍然是硬拦不是问():
    v = g.classify_tool_call("read", {"file_path": "/root/.hermes/config.yaml"}, WS, [WS, "/"])
    assert v is not None and v.risk == g.RISK_DENY and v.rule == "sensitive-path"
