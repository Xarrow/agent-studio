"""闸门接进权限链之后的**行为**（不只是判定函数）。

这里验三件事，都是只看纯函数看不出来的：

1. 说 DENY 的，工具调用真的到不了执行（返回值就是 DENY，没往下传）
2. 说 ASK 的，是**安全 ASK**（``bypass_immune``）—— "总是允许"不能把它静默掉，
   而且给的理由要能让用户判断
3. 没人看着的时候，ASK 不会挂在那里等人，而是变成 DENY
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from agent_studio.runtimes.agentscope_rt.guard import DangerousActionGuard
from agent_studio.runner.ctx import clear_run_ctx, set_run_ctx

from agentscope.permission import PermissionBehavior, PermissionDecision

WS = "/srv/src/agent-studio/data/work/sessions/ses_guard"


async def _next() -> PermissionDecision:
    """模拟"闸门没意见"时下游（AgentScope 引擎）的回答。"""
    return PermissionDecision(behavior=PermissionBehavior.ALLOW, message="engine-allow")


class _Handler:
    """记录下游有没有被调用 —— 用来证明 DENY 是"真的没往下走"。"""

    def __init__(self) -> None:
        self.calls = 0

    async def __call__(self, **_: object) -> PermissionDecision:
        self.calls += 1
        return await _next()


async def _check(
    guard: DangerousActionGuard,
    name: str,
    tool_input: dict,
    interactive: bool = True,
    state: str = "pending",
):
    set_run_ctx(workspace=WS, interactive=interactive)
    handler = _Handler()
    decision = await guard.on_check_permission(
        agent=None,
        input_kwargs={
            "tool_call": SimpleNamespace(name=name, id="tc_1", state=state),
            "tool": SimpleNamespace(name=name),
            "tool_input": tool_input,
        },
        next_handler=handler,
    )
    return decision, handler


@pytest.mark.asyncio
async def test_灾难性命令直接拒绝且不下传():
    guard = DangerousActionGuard()
    d, handler = await _check(guard, "bash", {"command": "rm -rf /"})
    assert d.behavior == PermissionBehavior.DENY
    assert handler.calls == 0, "DENY 之后不该再问下游引擎"
    assert "已拦截" in d.message
    assert "rm -rf" in d.message or "/" in d.message


@pytest.mark.asyncio
async def test_破坏性命令要走人工确认且不能被总是允许静默():
    guard = DangerousActionGuard()
    d, handler = await _check(guard, "bash", {"command": "rm -rf ./build"})
    assert d.behavior == PermissionBehavior.ASK
    assert d.bypass_immune is True, "安全 ASK 必须免疫「总是允许」"
    assert handler.calls == 0
    assert "./build" in d.message


@pytest.mark.asyncio
async def test_普通命令不打扰用户():
    guard = DangerousActionGuard()
    d, handler = await _check(guard, "bash", {"command": "ls -la && cat README.md"})
    assert d.behavior == PermissionBehavior.ALLOW
    assert handler.calls == 1, "没意见就该交给引擎按工作目录边界继续判"


@pytest.mark.asyncio
async def test_无人值守时确认降级成拒绝():
    guard = DangerousActionGuard()
    d, _ = await _check(guard, "bash", {"command": "rm -rf ./build"}, interactive=False)
    assert d.behavior == PermissionBehavior.DENY
    assert "没有人在看着" in d.message


@pytest.mark.asyncio
async def test_用户显式放行的模式不再打扰():
    guard = DangerousActionGuard(allow=["rm -rf ./build"])
    d, handler = await _check(guard, "bash", {"command": "rm -rf ./build"})
    assert d.behavior == PermissionBehavior.ALLOW
    assert handler.calls == 1


@pytest.mark.asyncio
async def test_放行规则不能把拒绝洗白():
    """用户放行的是工作目录里的构建产物，不该顺带把 ``rm -rf /`` 也放过去。"""
    guard = DangerousActionGuard(allow=["rm -rf"])
    d, _ = await _check(guard, "bash", {"command": "rm -rf /"})
    assert d.behavior == PermissionBehavior.DENY


@pytest.mark.asyncio
async def test_用户已经允许过的那次调用不再重复追问():
    """中间件排在引擎前，不认 state=allowed 就会无限循环：允许 → 又问 → 允许…"""
    guard = DangerousActionGuard()
    d, handler = await _check(guard, "bash", {"command": "rm -rf ./build"}, state="allowed")
    assert d.behavior == PermissionBehavior.ALLOW
    assert handler.calls == 1


@pytest.mark.asyncio
async def test_闸门可以整体关掉():
    guard = DangerousActionGuard(enabled=False)
    d, handler = await _check(guard, "bash", {"command": "rm -rf /"})
    assert d.behavior == PermissionBehavior.ALLOW
    assert handler.calls == 1


def test_编译出来的助手真的挂着这道闸门():
    """光有规则没用 —— 得确认它在 AgentScope 的权限链上（每个真实执行都过它）。"""
    from agent_studio.runtimes.agentscope_rt.compile import build_agent
    from agent_studio.schemas import AgentDefinition

    defn = AgentDefinition.model_validate(
        {
            "runtime": "agentscope",
            "name": "闸门验收",
            "system_prompt": "x",
            "model": {"provider": "volcengine", "name": "deepseek-v4-flash"},
            "tools": [],
            "skills": [],
            "limits": {"max_iters": 1, "timeout_s": 60},
        }
    )
    agent, _model = build_agent(defn, api_key="sk-not-used", tools=[])
    chain = agent._check_permission_middlewares
    assert any(isinstance(m, DangerousActionGuard) for m in chain), chain


def teardown_function(_func) -> None:  # noqa: ANN001
    clear_run_ctx()
