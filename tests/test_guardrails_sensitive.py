"""凭据位置不该进助手视野 —— 这一层是**平台级**的，逐助手配规则靠不住。

线上现场：`Read {"file_path": "/root/.hermes/.env"}` 在**严格模式**下被判 allow，
原因是 AgentScope 的只读快速通道（无副作用就放行）排在所有规则之前，而 Read 工具
自己的 check_permissions 直接 PASSTHROUGH、不看路径。也就是说"文件范围"只管写、
从来不管读，凭据文件等于公开。

这里钉住三件事：
· 目录级敏感位置（/root/.hermes、/root/.ssh…）读写都拒
· 文件名级敏感件（.env、id_rsa…）读拒、写到自己目录里照常
· 换写法绕（~/.hermes、$HOME/.hermes、python 里的字符串）也要拒
"""

from __future__ import annotations

import pytest

from agent_studio import guardrails as g

WS = "/srv/src/agent-studio/data/work/sessions/ses_test"


def _call(name: str, **inp) -> g.Verdict | None:
    return g.classify_tool_call(name, inp, WS)


@pytest.mark.parametrize(
    "name,inp",
    [
        ("read", {"file_path": "/root/.hermes/.env"}),
        ("read", {"file_path": "/root/.hermes/config.yaml"}),
        ("read", {"file_path": "/root/.ssh/id_rsa"}),
        ("read", {"file_path": "/etc/shadow"}),
        ("read", {"file_path": "/etc/sudoers"}),
        ("grep", {"path": "/root/.hermes", "pattern": "KEY"}),
        ("glob", {"path": "/root/.ssh", "pattern": "*"}),
        # 换写法
        ("read", {"file_path": "~/.hermes/.env"}),
        ("bash", {"command": "cat ~/.hermes/.env"}),
        ("bash", {"command": "cat $HOME/.hermes/.env"}),
        ("bash", {"command": "python3 -c \"print(open('/root/.ssh/id_rsa').read())\""}),
        ("python", {"code": "print(open('/etc/shadow').read())"}),
        ("bash", {"command": "cp /root/.hermes/.env /tmp/x"}),
    ],
)
def test_凭据位置一律拒绝(name, inp):
    v = _call(name, **inp)
    assert v is not None, f"{name} {inp} 应该被拦"
    assert v.risk == g.RISK_DENY
    assert v.rule == "sensitive-path"


@pytest.mark.parametrize(
    "name,inp",
    [
        ("read", {"file_path": f"{WS}/notes.md"}),
        ("read", {"file_path": "/etc/hostname"}),  # 非凭据的系统文件不在这一层管
        ("read", {"file_path": "/srv/src/agent-studio/README.md"}),
        ("bash", {"command": "cat README.md"}),
        # 模板 / 脚手架不该被误伤
        ("write", {"file_path": f"{WS}/.env.example", "content": "A=1"}),
        ("write", {"file_path": f"{WS}/.env", "content": "A=1"}),  # 给自己的项目写 .env 是正经活
        ("bash", {"command": "cp a.txt .env.example"}),
    ],
)
def test_正常干活不被误伤(name, inp):
    v = _call(name, **inp)
    assert v is None or v.risk != g.RISK_DENY, f"{name} {inp} 被误判成 {v}"


def test_读别人目录里的env仍然拒():
    """写只在自己目录里放行；读一律拒（读走就是泄露）。"""
    v = _call("read", file_path="/srv/src/other-project/.env")
    assert v is not None and v.risk == g.RISK_DENY


def test_sensitive_hit_区分目录级与文件名级():
    assert g.sensitive_hit("/root/.hermes/.env") == ("name", ".env")
    assert g.sensitive_hit("/root/.hermes/config.yaml") == ("prefix", "/root/.hermes")
    assert g.sensitive_hit(f"{WS}/x.txt") == ("", "")
