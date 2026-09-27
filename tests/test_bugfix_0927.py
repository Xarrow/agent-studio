"""两个 bug 的回归测试：
1. 删 run 后空会话壳级联清理（exec 左栏不残留）
2. 严格(default)模式下平台工具(fetch 等只读)也要 ASK 确认
"""
import pytest
from agent_studio.schemas import AgentDefinition, ToolRef
from agent_studio.runtimes.agentscope_rt.compile import build_permission_state


# ── 2b：严格模式 ASK 兜底 ──────────────────────────────────────────────
class _Spec:
    def __init__(self, name, kind="native"):
        self.name = name
        self.kind = kind


def _defn(mode):
    return AgentDefinition(
        name="t",
        runtime_options={"agentscope": {"permission": {"mode": mode}}},
    )


def test_strict_mode_asks_for_readonly_tools():
    """严格模式下 fetch/web_search（只读快速通道的对象）也必须 ASK。"""
    state = build_permission_state(
        _defn("default"),
        tools=[_Spec("fetch"), _Spec("web_search"), _Spec("bash")],
    )
    ctx = state.permission_context
    asks = set(ctx.ask_rules)
    assert "fetch" in asks, "严格模式下 fetch 也要确认"
    assert "web_search" in asks, "严格模式下 web_search 也要确认"
    assert "Bash" in asks, "平台名 bash 应翻成 AgentScope 注册名 Bash"


def test_strict_mode_no_duplicate_when_user_named_tool():
    """用户已显式写了 ask 规则的工具不重复注入。"""
    defn = AgentDefinition(
        name="t",
        runtime_options={
            "agentscope": {
                "permission": {"mode": "default", "ask": [{"tool": "fetch"}]}
            }
        },
    )
    state = build_permission_state(defn, tools=[_Spec("fetch")])
    rules = state.permission_context.ask_rules.get("fetch", [])
    assert len(rules) == 1


def test_non_strict_mode_no_injected_asks():
    """accept_edits/bypass 等模式不注入 ASK 兜底（行为不变）。"""
    for mode in ("accept_edits", "bypass", "explore", "dont_ask"):
        state = build_permission_state(_defn(mode), tools=[_Spec("fetch")])
        assert not state.permission_context.ask_rules, f"{mode} 不应注入 ask"


# ── 2a：空会话壳级联 ───────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_delete_run_cleans_empty_session_shell(client):
    """删掉会话里最后一条 run → 会话壳一起删；还有 run 的会话保留。"""
    import uuid

    from agent_studio.db import SessionLocal
    from agent_studio.models import Run, Session as Sess, SessionMessage
    from sqlalchemy import select

    ag = await client.post(
        "/api/agents",
        json={
            "name": f"sess-{uuid.uuid4().hex[:6]}",
            "definition": {
                "runtime": "agentscope",
                "name": "sess",
                "model": {"provider": "deepseek", "name": "deepseek-v4-flash"},
            },
        },
    )
    assert ag.status_code == 201, ag.text
    agent_id = ag.json()["id"]

    # 直接落库造会话 + 两条 run（不真跑模型）
    async with SessionLocal() as s:
        sess = Sess(id=f"ses_{uuid.uuid4().hex[:12]}", agent_id=agent_id, title="t")
        s.add(sess)
        await s.flush()
        run1 = Run(
            id=f"run_{uuid.uuid4().hex[:16]}",
            agent_id=agent_id,
            agent_version=1,
            runtime="agentscope",
            status="ok",
            input={"text": "a"},
            output={"content": "o"},
            usage={},
            started_at=1,
            ended_at=2,
            session_id=sess.id,
        )
        run2 = Run(
            id=f"run_{uuid.uuid4().hex[:16]}",
            agent_id=agent_id,
            agent_version=1,
            runtime="agentscope",
            status="ok",
            input={"text": "b"},
            output={"content": "o"},
            usage={},
            started_at=3,
            ended_at=4,
            session_id=sess.id,
        )
        s.add(run1)
        s.add(run2)
        await s.commit()
        sid, rid1, rid2 = sess.id, run1.id, run2.id

    # 删第一条 → 会话还有第二条 → 会话保留
    d = await client.delete(f"/api/runs/{rid1}")
    assert d.status_code == 200
    async with SessionLocal() as s:
        assert await s.get(Sess, sid) is not None

    # 删第二条 → 会话空了 → 壳一起删
    d = await client.delete(f"/api/runs/{rid2}")
    assert d.status_code == 200
    async with SessionLocal() as s:
        assert await s.get(Sess, sid) is None, "空会话壳应级联删除"
        msgs = (
            await s.execute(
                select(SessionMessage).where(SessionMessage.session_id == sid)
            )
        ).scalars().all()
        assert msgs == []
