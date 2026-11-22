"""浏览器控制权状态机 —— 这个包最容易"看起来对、实际谁都能动"的部分。

守的是 v1 的两个实证病根：

① 浏览器挂在 run 上 → run 一结束画面还在、点击静默失效；
② 只有一个协作式暂停闸，没有控制权归属 → 暂停期间双方都能发动作，谁后发谁赢。

这里全部用假浏览器（不真起 Chromium）：状态迁移、闸门、交还时的上下文注入
都是纯进程内可判定的。
"""

from __future__ import annotations

import asyncio

import pytest

from agent_studio import browser_control as bc

pytestmark = pytest.mark.anyio


class FakeSess:
    """够用的假浏览器：记下动作，给一份页面摘要。"""

    def __init__(self) -> None:
        self._last_url = "https://example.com/search?q=x"
        self._last_title = "Example Search"
        self._step_n = 0
        self.clicks: list[tuple[float, float]] = []
        self.typed: list[str] = []
        self.scrolled: list[int] = []

    async def read(self, selector: str = "body") -> str:
        return f"[{self._last_title}] {self._last_url}\n搜索结果第一条：示例站点"

    async def element_label(self, x: float, y: float) -> str:
        return "input 搜索"

    async def user_click(self, x: float, y: float) -> str:
        self.clicks.append((x, y))
        self._last_url = "https://example.com/result"
        return "点了一下"

    async def user_type(self, text: str) -> str:
        self.typed.append(text)
        return f"已输入 {len(text)} 个字符"

    async def scroll(self, dy: int = 600) -> str:
        self.scrolled.append(dy)
        return f"已滚动 {int(dy)}px"


@pytest.fixture(autouse=True)
def _clean():
    bc._CONTROLS.clear()
    # 保活巡检验的是 30 分钟空闲，单测里不该留后台任务
    bc._ensure_janitor = lambda: None  # type: ignore[assignment]
    yield
    bc._CONTROLS.clear()


def _ctl(status: str = bc.AGENT, run_id: str = "run_1") -> bc.Control:
    c = bc.Control(key="ses:s1", session_id="s1", run_id=run_id, status=status)
    c.running = status == bc.AGENT
    bc._CONTROLS[c.key] = c
    c.alive = status != bc.CLOSED
    return c


def test_徽章与阶段文字同一个词_三态不漏():
    """同一屏上曾出现「等你操作」和「等你处理」两个词 —— 同一状态只能有一个说法。

    徽章 (面板/缩略条) 与 phase_text (运行条/主底部/等登录卡片标题) 必须逐字相同，
    否则用户会以为这是两件事。
    """
    c = _ctl(bc.AGENT)
    for status, running, word in [
        (bc.AGENT, True, "助手操作中"),
        (bc.AGENT, False, "助手待命"),
        (bc.USER, False, "你在操作"),
        (bc.WAITING, False, "等你处理"),
        (bc.PAUSED, False, "已暂停"),
    ]:
        c.status, c.running = status, running
        st = bc.public_state("s1")
        assert st["badge"] == st["phase_text"] == word, f"{status}/{running} 两处说法不一致"


def test_三处文案来自同一份状态():
    """徽章 / 按钮 / 底部文案必须同一个对象给出 —— v1 "已暂停但芯片写运行中"就是各判各的。"""
    c = _ctl(bc.AGENT)
    st = bc.public_state("s1")
    assert st["badge"] == "助手操作中" and st["button"] == "接管" and st["button_action"] == "take"
    assert "接管" in st["footer"]

    bc._CONTROLS[c.key].status = bc.USER
    st = bc.public_state("s1")
    assert st["badge"] == "你在操作" and st["button"] == "交还给 Agent" and st["can_click"] is True
    assert st["holder"] == "user"

    bc._CONTROLS[c.key].status = bc.WAITING
    st = bc.public_state("s1")
    assert st["badge"] == "等你处理" and st["button_action"] == "release"

    bc._CONTROLS[c.key].status = bc.CLOSED
    st = bc.public_state("s1")
    assert st["badge"] == "浏览器已过期" and st["button"] == "" and st["alive"] is False


def test_没开过浏览器时状态是_none():
    st = bc.public_state("nope")
    assert st["status"] == "none" and st["alive"] is False and st["button"] == ""


async def test_接管后助手发动作被挡住并给出人话():
    """同一轮里用户按了接管：助手下一步必须停手（不许点一半），并拿到人话原因。"""
    c = _ctl(bc.AGENT, run_id="run_1")
    ok, why = await bc.take(c)
    assert ok and why == ""
    assert c.status == bc.USER

    bc.HANDOFF_WAIT_S = 0.05
    try:
        blocked = await bc.gate_agent(c, "run_1", "click")
    finally:
        bc.HANDOFF_WAIT_S = 120.0
    assert blocked.startswith("✗")
    assert "没有执行" in blocked  # 告诉模型"这一步没做"，而不是沉默


async def test_交还后同一个闸放行():
    c = _ctl(bc.USER, run_id="run_1")
    sess = FakeSess()
    task = asyncio.create_task(bc.gate_agent(c, "run_1", "click"))
    await asyncio.sleep(0.05)
    assert not task.done(), "用户握着控制权时助手不该继续"
    await bc.hand_back(c, sess)
    assert await asyncio.wait_for(task, timeout=2) == ""
    assert c.status == bc.AGENT


async def test_新一轮自动收回控制权():
    """用户发新消息 = 让它接着干：新一轮第一次用浏览器时直接接管。"""
    c = _ctl(bc.USER, run_id="run_old")
    c.user_notes.append("用户点击了 input 搜索")
    blocked = await bc.gate_agent(c, "run_new", "read")
    assert blocked == ""
    assert c.status == bc.AGENT and c.run_id == "run_new"

    sess = FakeSess()
    brief = await bc.consume_brief(c, sess)
    assert "用户点击了 input 搜索" in brief
    assert "example.com" in brief  # 带着当前页面，助手知道用户停在哪
    assert await bc.consume_brief(c, sess) == "", "同一份摘要只能给一次"


async def test_用户输入在助手态被拒并给出人话原因():
    c = _ctl(bc.AGENT)
    sess = FakeSess()
    with pytest.raises(bc.UserInputDenied) as err:
        await bc.apply_user_input(c, sess, {"kind": "click", "x": 10, "y": 20})
    assert "接管" in str(err.value)  # 前端要把这句原样显示出来
    assert sess.clicks == [], "被拒时绝不能真的点下去"


async def test_用户动作记成人话并回灌助手():
    c = _ctl(bc.USER)
    sess = FakeSess()
    await bc.apply_user_input(c, sess, {"kind": "click", "x": 10, "y": 20})
    await bc.apply_user_input(c, sess, {"kind": "text", "text": "duckduckgo"})
    await bc.apply_user_input(c, sess, {"kind": "scroll", "dy": 400})
    joined = "；".join(c.user_notes)
    assert "用户点击了 input 搜索" in joined
    assert "输入了 10 个字符" in joined  # 内容不进事件流（可能是密码）
    assert "向下滚动了 400px" in joined
    assert "页面跳到了 example.com" in joined  # 点击导致跳转也要说清


async def test_run_结束不关浏览器且文案说清():
    c = _ctl(bc.AGENT, run_id="run_1")
    await bc.on_run_end("run_1")
    st = bc.public_state("s1")
    assert st["status"] == bc.USER and st["alive"] is True
    assert "本轮已结束" in st["footer"] and "还开着" in st["footer"]
    assert c.round_ended is True


async def test_wait_login_是真闸_状态转等待且交还后恢复():
    c = _ctl(bc.AGENT, run_id="run_1")
    sess = FakeSess()
    task = asyncio.create_task(bc.wait_login(c, "run_1", "请在浏览器里完成登录", sess))
    await asyncio.sleep(0.05)
    st = bc.public_state("s1")
    assert st["status"] == "waiting_user" and st["button_action"] == "release"
    assert not task.done(), "wait_login 必须真的停在这里等"
    assert c.status == "waiting_user"

    await bc.resume_agent(c)
    out = await asyncio.wait_for(task, timeout=2)
    assert "已完成操作" in out and "example.com" in out


async def test_过期后助手再动会拿到人话():
    c = _ctl(bc.CLOSED, run_id="run_1")
    c.alive = False
    blocked = await bc.gate_agent(c, "run_1", "navigate")
    assert "已过期" in blocked


# --------------------------------------------------------------------------- #
# 接口层：路由 + 409 人话（不起真浏览器，只验状态机和接线）
# --------------------------------------------------------------------------- #
async def _mk_session(sid: str) -> None:
    from agent_studio.db import SessionLocal, init_db
    from agent_studio.models import Session as ChatSession

    await init_db()
    async with SessionLocal() as s:
        if await s.get(ChatSession, sid) is None:
            s.add(ChatSession(id=sid, workspace_id="ws_default", agent_id="ag_test", title="t"))
            await s.commit()


async def test_接口_接管交还与被拒原因(client, monkeypatch):
    from agent_studio import browser_session as bs

    sid = "ses_ctl_api"
    await _mk_session(sid)
    c = bc.Control(key=f"ses:{sid}", session_id=sid, run_id="run_1")
    c.running = True
    bc._CONTROLS[c.key] = c
    # 假装浏览器还活着（真起 Chromium 是别的测试的事）
    monkeypatch.setattr(bs, "get_existing", lambda key: FakeSess())

    r = await client.get(f"/api/sessions/{sid}/browser-ctl/state")
    assert r.status_code == 200
    assert r.json()["badge"] == "助手操作中"

    # 助手态下用户输入：409 + 人话（前端直接把 detail 显示出来）
    r = await client.post(f"/api/sessions/{sid}/browser-ctl/input", json={"kind": "click", "x": 1, "y": 2})
    assert r.status_code == 409 and "接管" in r.json()["detail"]

    r = await client.post(f"/api/sessions/{sid}/browser-ctl/action", json={"action": "take"})
    assert r.status_code == 200 and r.json()["status"] == "user"
    assert r.json()["button"] == "交还给 Agent"

    r = await client.post(f"/api/sessions/{sid}/browser-ctl/action", json={"action": "release"})
    assert r.status_code == 200 and r.json()["status"] == "agent"


async def test_wait_login_会往会话里留一张卡片():
    """刷新之后卡片还在：状态写一条 system 消息（只给人看，不进模型上下文）。"""
    from sqlalchemy import select

    from agent_studio.db import SessionLocal, init_db
    from agent_studio.models import SessionMessage

    sid = "ses_ctl_card"
    await _mk_session(sid)
    c = bc.Control(key=f"ses:{sid}", session_id=sid, run_id="run_1")
    bc._CONTROLS[c.key] = c
    await bc._note_message(c, "〔需要你操作〕请在浏览器里完成登录")

    async with SessionLocal() as s:
        rows = (
            await s.execute(select(SessionMessage).where(SessionMessage.session_id == sid))
        ).scalars().all()
    assert any("需要你操作" in r.content for r in rows), "对话区的卡片要有落库的那一条"


async def test_过期后重新打开浏览器_状态回到agent而不是一直卡在closed():
    """30 分钟过期后用户发消息让它重开：闸门必须放行（否则\"发消息重开\"是个死路）。"""
    c = _ctl(bc.CLOSED, run_id="run_1")
    c.alive = False
    assert "已过期" in await bc.gate_agent(c, "run_1", "navigate")

    fresh = bc.ensure("ses:s1", "s1", "run_2")
    assert fresh is c, "还是同一条控制记录（同一个会话）"
    assert fresh.status == bc.AGENT and fresh.alive is True
    assert fresh.round_ended is False
    assert await bc.gate_agent(fresh, "run_2", "navigate") == ""


async def test_删会话把浏览器一起收掉(monkeypatch):
    """会话删了、Chromium 还在后台跑 = 没人认领的进程（用户看不到入口）。"""
    from agent_studio import browser_session as bs

    closed: list[str] = []

    async def _fake_close(key: str) -> None:
        closed.append(key)

    monkeypatch.setattr(bs, "close_key", _fake_close)
    c = _ctl(bc.USER)
    await bc.forget("s1")
    assert closed == ["ses:s1"], "要真的收掉这个会话的浏览器"
    assert bc.get_for_session("s1") is None, "控制记录也要丢，别留一个悬空状态"


async def test_助手待命与操作中的徽章不混用():
    """交还之后没人跑时不能说\"助手操作中\"（用户抓的就是这种自相矛盾的芯片）。"""
    c = _ctl(bc.USER)
    await bc.resume_agent(c)
    st = bc.public_state("s1")
    assert st["status"] == "agent" and st["running"] is False
    assert st["badge"] == "助手待命" and "发消息" in st["footer"]

    await bc.gate_agent(c, "run_1", "click")
    st = bc.public_state("s1")
    assert st["running"] is True and st["badge"] == "助手操作中"


# --------------------------------------------------------------------------- #
# 2026-11 复测的四个缺陷：显示面单一来源 / 就地反馈 / 步数口径 / 交还摘要
# --------------------------------------------------------------------------- #
def test_所有显示面同一口径_三态各自说什么():
    """徽章/状态行/底部/运行条/主底部/横幅提示都从 public_state 派生。

    复测原话：已是「你在操作」时横幅还写「助手正在操作」；等登录时顶部芯片
    仍「执行中」、运行条仍「正在运行 tool_call」。
    """
    c = _ctl(bc.AGENT)
    st = bc.public_state("s1")
    assert st["phase"] == "agent_running"
    assert st["badge"] == "助手操作中" and st["button_action"] == "take"
    assert st["run_bar"] == "" and st["chat_status"] == ""  # 交给过程条自己说
    assert "接管" in st["denied_hint"]

    # 交还后（没人跑）：徽章是待命，不许再说「正在操作」
    c.status, c.running = bc.AGENT, False
    st = bc.public_state("s1")
    assert st["phase"] == "agent_idle" and st["badge"] == "助手待命"
    assert "正在操作" not in st["action_line"]

    # 用户接管：横幅提示必须为空（不是 user 态就没有"要你先接管"这句话）
    c.status, c.running, c.round_ended = bc.USER, False, False
    st = bc.public_state("s1")
    assert st["phase_text"] == "你在操作" and st["denied_hint"] == ""
    assert "助手正在操作" not in st["footer"]
    assert "你在操作" in st["run_bar"] and "助手已停手" in st["run_bar"]

    # 等用户登录：顶部芯片/运行条/主底部都写「等你处理」，不再写执行中
    c.status, c.reason = bc.WAITING, "请在浏览器里完成登录"
    st = bc.public_state("s1")
    assert st["phase_text"] == "等你处理" and st["badge"] == "等你处理"
    assert st["run_bar"].startswith("等你处理")
    assert "等你处理" in st["chat_status"]
    assert "tool_call" not in st["run_bar"] and "正在执行" not in st["chat_status"]


async def test_等登录交还后不残留等你登录():
    c = _ctl(bc.WAITING)
    c.reason = "请在浏览器里完成登录"
    await bc.resume_agent(c)
    st = bc.public_state("s1")
    for k in ("badge", "footer", "hint", "run_bar", "chat_status", "action_line"):
        assert "登录" not in st[k], f"{k} 还残留登录文案：{st[k]}"


def test_助手待命时点画面给的是待命原因():
    """交还后（助手待命）用户点画面：必须解释"这一轮已结束，先点接管"，
    不能复读"助手正在操作浏览器"（复测就是被这句假话挡住）。"""
    c = _ctl(bc.AGENT)
    c.running = False
    why = bc.user_gate(c)
    assert "这一轮已经结束" in why and "接管" in why
    assert "正在操作" not in why


async def test_交还摘要分两段且明确助手动作真实执行过():
    """模型曾回「我并没有真正调用浏览器工具」—— 摘要必须点名归属。"""
    c = _ctl(bc.USER)
    bc.add_agent_action(c, "打开 duckduckgo.com", "run_1")
    bc.add_agent_action(c, "往下滚", "run_1")
    c.user_notes.append("用户点击了 搜索框")
    c.pending_brief = "当前页面：DuckDuckGo — https://duckduckgo.com"

    brief = await bc.consume_brief(c, FakeSess())
    assert "一、助手已执行" in brief and "二、用户接管期间的操作" in brief
    assert "以上助手操作均已真实执行" in brief
    assert "不是你做的" in brief
    assert brief.index("打开 duckduckgo.com") < brief.index("用户点击了 搜索框")
    assert await bc.consume_brief(c, FakeSess()) == "", "同一份摘要只给一次"


def test_步数口径是本轮_刷新前后同一个数(monkeypatch, tmp_path):
    from agent_studio.browser_trace import record_step
    from agent_studio.runner import service as svc

    monkeypatch.setattr(svc, "session_work_dir", lambda sid: tmp_path)
    c = _ctl(bc.AGENT, run_id="run_a")
    for i in range(3):
        record_step(tmp_path, "run_a", i + 1, "click", f"第{i + 1}步")

    st = bc.public_state("s1")
    assert st["step_count"] == 3 and st["step_label"] == "本轮 3 步"
    # 再读一次 = 刷新：同一个数（以前内存里数动作，刷新就变）
    assert bc.public_state("s1")["step_count"] == 3
    # 新的一轮从 0 开始，不带上一轮
    c.run_id = "run_b"
    assert bc.public_state("s1")["step_count"] == 0


async def test_第一轮一建控制权就把状态推给前端(monkeypatch):
    """上一版 ensure() 不推状态：第一轮跑起来时前端手里还是「没有浏览器」，
    面板只有 409 横幅、没有可点的接管（复测缺陷 1 的根）。"""
    seen: list[dict] = []
    monkeypatch.setattr(bc, "_publish", lambda c, ev: seen.append(ev))
    c = bc.ensure("ses:s1", "s1", "run_1")
    assert seen and seen[-1]["type"] == "browser_state"
    assert seen[-1]["payload"]["badge"] == "助手操作中", "第一轮正在跑，不能说待命"
    assert seen[-1]["payload"]["button_action"] == "take"

    c.running = False
    await bc.gate_agent(c, "run_1", "click")
    assert seen[-1]["payload"]["badge"] == "助手操作中"

