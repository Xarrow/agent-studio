"""保存时就拦住"配了没用"的范围。

背景：限制是两层 —— 平台层按助手判（可读/可写范围），内核层按服务判（systemd
挂载）。内核是物理上限，配不进去的东西写进配置只会骗自己：

· 把 /root/.hermes 配进可读范围 → 平台凭据黑名单先拒，内核还遮着，永远读不到
· 把 /opt 配进可写范围 → 平台放行，真写的时候内核回 Read-only file system

所以校验放在模型层（创建/更新都会走），提示语要写成人话：为什么不行、去哪改。
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from agent_studio import file_scope
from agent_studio.schemas import AgentDefinition


def _defn(guard: dict) -> AgentDefinition:
    return AgentDefinition(
        name="范围验收",
        system_prompt="x",
        runtime_options={"agentscope": {"guard": guard}},
    )


@pytest.mark.parametrize(
    "guard,needle",
    [
        ({"read_roots": ["/root/.hermes"]}, "凭据位置"),
        ({"read_roots": ["/root/.ssh"]}, "凭据位置"),
        ({"roots": ["/root/.hermes"]}, "凭据位置"),
        ({"roots": ["/opt"]}, "写不进去"),
        ({"roots": ["/"]}, "写不进去"),
        ({"read_roots": ["relative/path"]}, "绝对路径"),
    ],
)
def test_配了也不会生效的直接拒(guard, needle):
    with pytest.raises(ValidationError) as exc:
        _defn(guard)
    assert needle in str(exc.value)


@pytest.mark.parametrize(
    "guard",
    [
        {},
        {"read_roots": ["/srv/src", "/tmp"]},
        {"roots": ["/srv/www"]},
        {"read_roots": ["/"], "roots": ["/srv/src/agent-studio"]},
        {"enabled": True},
    ],
)
def test_说得通的配置照常保存(guard):
    assert _defn(guard) is not None


def test_上限本身可以读出来给界面用():
    info = file_scope.describe()
    assert "/srv/www" in info["writable"]
    assert "/root/.hermes" in info["hidden"]


def test_内核写的目录可配_别的目录不行():
    assert file_scope.problems({"roots": ["/srv/src/agent-studio/dist"]}) == []
    assert file_scope.problems({"roots": ["/etc"]})
