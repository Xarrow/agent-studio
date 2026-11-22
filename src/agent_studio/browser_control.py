"""浏览器控制权 —— **会话级的单一状态源**。

为什么要有这个模块
------------------
v1 的浏览器有两个实证病根：

1. 浏览器（Chromium 进程）挂在 **run** 上：run 一结束就 kill，画面留着但点击
   静默失效 —— 用户看到的是"画面在、点不动、也没有任何解释"。
2. 只有一个协作式暂停闸（``_PAUSE``），没有"控制权归属"：暂停期间用户和助手
   都能发动作，谁后发谁赢；用户的操作也不回灌给助手。

所以这里做两件事，且只做这两件：

* **归属**：浏览器会话属于**聊天会话**（``session_id``），run 只是"谁在用"。
  run 结束不再关浏览器；30 分钟没有任何交互才收（``IDLE_TTL_S``）。
* **控制权状态机**：``agent / user / waiting_user / paused / closed``，同一时刻
  只有一个持有者能发输入事件。前端只渲染 ``public_state()`` 给出的文案，不自己判断。

状态机（唯一的真相在 ``Control.status``）
-----------------------------------------
```
        ┌─────────── 用户点「接管」 ───────────┐
        ▼                                     │
   agent ─────────────────────────────────► user ◄── run 结束也落到 user
        ▲                                     │
        └──────── 用户点「交还给 Agent」 ───────┘
   agent ──(wait_login)──► waiting_user ──(交还)──► agent
```
* 接管是**软停**：已经发出的那一个原子动作（一次 navigate/click/type/scroll）
  会做完，下一步在 ``gate_agent`` 前停住 —— 不会点一半。
* 用户发新消息 = 明确要它干活，新一轮在第一次用浏览器时自动收回控制权。
* 交还时抓一份页面状态摘要 + 用户动过什么，塞进助手下一次动作的工具结果里。
* ``wait_login`` 是**真闸**：状态转 ``waiting_user``，工具调用停在那里等交还，
  助手这一轮不会继续往下做。
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

#: 浏览器会话保活时长（没有任何交互就收回）。用户口径：30 分钟。
IDLE_TTL_S = 30 * 60
#: 用户接管期间，助手的一步最多等多久（等不到就以人话停手，不硬抢）
HANDOFF_WAIT_S = 120.0
#: wait_login 最多等多久
LOGIN_WAIT_S = 600.0
#: 接管时等"当前原子动作做完"的上限（正常几十毫秒）
DRAIN_WAIT_S = 5.0

AGENT = "agent"
USER = "user"
WAITING = "waiting_user"
PAUSED = "paused"
CLOSED = "closed"

#: 状态 → 徽章色调（前端只认这个，不自己判状态）
_TONE = {AGENT: "live", USER: "mine", WAITING: "warn", PAUSED: "warn", CLOSED: "muted"}


def now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class Control:
    key: str
    session_id: str
    run_id: str = ""
    status: str = AGENT
    since: int = field(default_factory=now_ms)
    reason: str = ""
    url: str = ""
    title: str = ""
    alive: bool = True
    last_active: int = field(default_factory=now_ms)
    #: 是否有一轮刚结束（决定底部文案说"本轮已结束"还是"你正在操作"）
    round_ended: bool = False
    #: 现在有没有一轮真的在跑（交还后没人跑时，徽章不能说"操作中"）
    running: bool = False
    #: 用户在这一段接管里做过什么（人话，交还时进助手的上下文）
    user_notes: list[str] = field(default_factory=list)
    #: 助手真实执行过的动作 (run_id, 人话) —— 交还摘要里要分清楚"谁做的"。
    #: 没有这份清单时，模型会把自己上一轮的动作误当成用户的（实测它会反过来否认）。
    agent_actions: list[tuple[str, str]] = field(default_factory=list)
    #: 交还时抓的页面摘要，等助手下一次动作时消费
    pending_brief: str = ""
    #: 正在执行的原子动作数（接管要等它归零 —— 不许点一半）
    inflight: int = 0
    cond: asyncio.Condition = field(default_factory=asyncio.Condition)


_CONTROLS: dict[str, Control] = {}


def key_of(session_id: str, run_id: str = "") -> str:
    """浏览器归属键：有会话就跟会话，没有会话（试跑/调试）才退回 run。"""
    return f"ses:{session_id}" if session_id else f"run:{run_id}"


def get(key: str) -> Control | None:
    return _CONTROLS.get(key)


def get_for_session(session_id: str) -> Control | None:
    return _CONTROLS.get(f"ses:{session_id}") if session_id else None


def ensure(key: str, session_id: str, run_id: str = "") -> Control:
    c = _CONTROLS.get(key)
    if c is None:
        c = Control(key=key, session_id=session_id, run_id=run_id, running=bool(run_id))
        _CONTROLS[key] = c
        _ensure_janitor()
        # 第一条状态就要推出去：上一版这里不推，第一轮跑起来时前端手里还是
        # 「没有浏览器」，面板只剩一条 409 横幅、没有可点的「接管」（实测）。
        publish_state(c)
    else:
        if session_id:
            c.session_id = session_id
        # 注意：**不要**在这里覆盖 run_id —— 新一轮该不该收回控制权由
        # ``gate_agent`` / ``on_run_start`` 决定；在这里悄悄改掉，闸门就以为
        # "还是同一轮"，用户接管时助手会白等 120 秒。
        if not c.run_id:
            c.run_id = run_id
        # 过期的会话重新开浏览器：状态必须从 closed 回到 agent ——
        # 否则闸门会一直判"已过期"，用户看到"发消息让它重新打开"却永远打不开。
        if c.status == CLOSED or not c.alive:
            c.status = AGENT
            c.reason = ""
            c.round_ended = False
            c.running = False
            c.since = now_ms()
            publish_state(c)
        c.alive = True
    c.last_active = now_ms()
    return c


def touch(c: Control | None) -> None:
    if c is not None:
        c.last_active = now_ms()


def sync_page(c: Control, sess: Any) -> None:
    """把浏览器当前地址/标题同步进状态（状态接口和 SSE 都用它）。"""
    url = str(getattr(sess, "_last_url", "") or "")
    title = str(getattr(sess, "_last_title", "") or "")
    if url and (url != c.url or title != c.title):
        c.url, c.title = url, title


# --------------------------------------------------------------------------- #
# 对外文案（**后端定，前端只渲染** —— 三处永远一致的前提）
# --------------------------------------------------------------------------- #
def _phase(c: Control) -> tuple[str, str]:
    """→ (阶段, 一句话)。**所有显示面**都从这一对派生，前端不再各判各的。"""
    if not c.alive or c.status == CLOSED:
        return "expired", "浏览器已过期"
    if c.status == WAITING:
        return "waiting_user", "等你处理"
    if c.status == PAUSED:
        return "paused", "已暂停"
    if c.status == USER:
        return "user", "你在操作"
    return ("agent_running", "助手操作中") if c.running else ("agent_idle", "助手待命")


def _badge(c: Control) -> tuple[str, str, str]:
    """→ (徽章文字, 按钮文字, 按钮动作)"""
    phase, _text = _phase(c)
    if phase == "agent_running":
        return "助手操作中", "接管", "take"
    if phase == "agent_idle":
        return "助手待命", "接管", "take"
    if phase == "waiting_user":
        # 和 phase_text / 运行条 / 主底部同一个词：同一屏上「等你操作」和
        # 「等你处理」并存过一次，用户读成两套状态。
        return "等你处理", "交还给 Agent", "release"
    if phase == "user":
        return "你在操作", "交还给 Agent", "release"
    if phase == "paused":
        return "已暂停", "交还给 Agent", "release"
    return "浏览器已过期", "", ""


def _footer(c: Control) -> str:
    phase, _ = _phase(c)
    if phase == "agent_idle":
        return "已交还给助手 · 发消息让它接着干"
    if phase == "agent_running":
        return "助手正在操作 · 点「接管」可以随时接手"
    if phase == "waiting_user":
        return "等你完成操作 · 弄好后点「交还给 Agent」"
    if phase == "paused":
        return "已暂停 · 点「交还给 Agent」让它继续"
    if phase == "expired":
        return "浏览器已过期 · 发消息让它重新打开"
    if c.round_ended:
        return "本轮已结束 · 浏览器还开着，你可以继续操作，或发消息让它接着干"
    return "你在操作浏览器 · 点「交还给 Agent」让它接着干"


def _hint(c: Control) -> str:
    phase, _ = _phase(c)
    if phase == "agent_idle":
        return "控制权在助手这边，但它这一轮已经结束 —— 发一条消息让它接着干，或点「接管」自己操作。"
    if phase == "agent_running":
        return "助手正在操作页面。点「接管」它做完当前这一步就停手，画面归你。"
    if phase == "waiting_user":
        return c.reason or "请在浏览器里完成操作，好了点「交还给 Agent」。"
    if phase == "user":
        return c.reason or "现在是你在操作。交还后助手会知道你动过什么，接着往下做。"
    if phase == "paused":
        return c.reason or "已暂停。交还给 Agent 之后它才继续。"
    return c.reason or "浏览器会话已过期（30 分钟没有操作）。"


def _run_bar(c: Control) -> str:
    """顶部运行条 / 对话页眉的状态文案。

    空串 = 用执行过程自己的文案（它正按事件推进）；非空 = 覆盖它 ——
    等用户处理、用户接管这两种时候，说「正在运行 tool_call」是假话。
    """
    phase, _ = _phase(c)
    if phase == "waiting_user":
        return "等你处理 · 处理完点「交还给 Agent」继续"
    if phase == "paused":
        return "已暂停 · 交还给 Agent 之后继续"
    if phase == "user":
        return "你在操作浏览器 · 助手已停手，等你交还"
    return ""


def _chat_status(c: Control) -> str:
    """对话主底部那一行（输入坞上方）——只在这轮还在跑时显示。"""
    phase, _ = _phase(c)
    if phase == "waiting_user":
        return "等你处理 · 登录/确认后点「交还给 Agent」"
    if phase == "paused":
        return "已暂停 · 交还给 Agent 之后继续"
    if phase == "user":
        return "你在操作浏览器 · 助手在等你交还"
    return ""


def _action_line(c: Control) -> str:
    """面板底部「当前这一行」——没有实时动作时用它，避免残留上一段的
    「等你登录」。这是日志和状态最容易打架的地方。"""
    phase, _text = _phase(c)
    if phase == "agent_running":
        return ""  # 让实时动作字幕说话
    if phase == "agent_idle":
        return "助手待命 · 发消息让它接着干，或点「接管」自己操作"
    if phase == "waiting_user":
        return c.reason or "等你处理 · 弄好后点「交还给 Agent」"
    if phase == "paused":
        return c.reason or "已暂停 · 交还给 Agent 之后继续"
    if phase == "expired":
        return "浏览器已过期 · 发消息让它重新打开"
    return "本轮已结束 · 浏览器还开着，你可以继续操作" if c.round_ended else "你在操作 · 点「交还给 Agent」让它接着干"


def _denied_hint(c: Control) -> str:
    """非 user 态下用户操作画面时给他看的人话（前端立即显示在点击处）。"""
    phase, _ = _phase(c)
    if phase == "agent_running":
        return "助手正在操作浏览器 —— 先点「接管」，它就停手把画面给你"
    if phase == "agent_idle":
        return "助手这一轮已经结束，画面现在是只读 —— 先点「接管」，画面就归你"
    if phase == "paused":
        return "助手已暂停 —— 先点「交还给 Agent」让它继续"
    if phase == "expired":
        return "浏览器已过期（30 分钟没有操作）· 发消息让它重新打开"
    return ""


def step_count_for(c: Control) -> int:
    """本轮（``run_id``）浏览器真实执行的步数 —— **卡片上的唯一口径**。

    以前卡片用内存里收到几行动作（刷新清零、换个面板又变），和留档步数
    对不上；现在一律按这一轮落盘的步骤索引数，刷新前后同一个数。
    """
    if not c.session_id or not c.run_id:
        return 0
    try:
        from .browser_trace import read_index
        from .runner.service import session_work_dir

        return len(read_index(session_work_dir(c.session_id), c.run_id))
    except Exception:  # pragma: no cover —— 数不出来就说 0，不该挡住状态接口
        return 0


def public_state(session_id: str) -> dict[str, Any]:
    """给前端的完整状态：**所有文案都在这里定**，前端不做判断。"""
    c = get_for_session(session_id)
    if c is None:
        return {
            "session_id": session_id,
            "alive": False,
            "status": "none",
            "phase": "none",
            "phase_text": "浏览器未打开",
            "holder": "none",
            "badge": "",
            "tone": "muted",
            "button": "",
            "button_action": "",
            "hint": "",
            "footer": "",
            "run_bar": "",
            "chat_status": "",
            "action_line": "",
            "denied_hint": "",
            "url": "",
            "title": "",
            "reason": "",
            "since": 0,
            "expires_at": 0,
            "round_ended": False,
            "running": False,
            "can_click": False,
            "run_id": "",
            "step_count": 0,
            "step_label": "",
        }
    badge, button, action = _badge(c)
    phase, phase_text = _phase(c)
    holder = AGENT if c.status == AGENT else ("none" if c.status == CLOSED else "user")
    steps = step_count_for(c)
    return {
        "session_id": session_id,
        "alive": bool(c.alive and c.status != CLOSED),
        "status": c.status,
        "phase": phase,
        "phase_text": phase_text,
        "holder": holder,
        "badge": badge,
        "tone": _TONE.get(c.status, "muted"),
        "button": button,
        "button_action": action,
        "hint": _hint(c),
        "footer": _footer(c),
        "run_bar": _run_bar(c),
        "chat_status": _chat_status(c),
        "action_line": _action_line(c),
        "denied_hint": _denied_hint(c),
        "url": c.url,
        "title": c.title,
        "reason": c.reason,
        "since": c.since,
        "expires_at": c.last_active + IDLE_TTL_S * 1000,
        "round_ended": c.round_ended,
        "running": c.running,
        "can_click": c.status in (USER, WAITING, PAUSED),
        "run_id": c.run_id,
        # 步数口径：**本轮**。所有形态（缩略条 / 右栏 / 浮层）和刷新前后都读它。
        # 0 步时不给标签：卡片上写「本轮 0 步」既没信息量，又容易被读成"口径坏了"。
        "step_count": steps,
        "step_label": f"本轮 {steps} 步" if steps else "",
    }


def _publish(c: Control, event: dict[str, Any]) -> None:
    try:
        from .runner.service import bus

        bus.publish(f"sess:{c.session_id}", event)
    except Exception:  # pragma: no cover
        logger.debug("浏览器状态事件推送失败", exc_info=True)


def publish_state(c: Control | None) -> None:
    if c is None or not c.session_id:
        return
    _publish(c, {"seq": -3, "type": "browser_state", "ts": 0, "payload": dict(public_state(c.session_id))})


def publish_note(c: Control, text: str) -> None:
    """用户动作回灌的实时一行（界面上接在浏览器动作字幕里）。"""
    _publish(c, {"seq": -3, "type": "browser_note", "ts": 0, "payload": {"text": text}})


# --------------------------------------------------------------------------- #
# 状态迁移
# --------------------------------------------------------------------------- #
async def set_status(
    c: Control,
    status: str,
    reason: str = "",
    *,
    round_ended: bool | None = None,
) -> None:
    async with c.cond:
        c.status = status
        # 不带原因 = 清掉上一段的（否则「等你登录」会粘到下一段状态上）
        c.reason = reason or ""
        if round_ended is not None:
            c.round_ended = round_ended
        c.since = now_ms()
        c.cond.notify_all()
    publish_state(c)


async def begin_action(c: Control | None) -> None:
    if c is None:
        return
    async with c.cond:
        c.inflight += 1
        c.last_active = now_ms()


async def end_action(c: Control | None) -> None:
    if c is None:
        return
    async with c.cond:
        c.inflight = max(0, c.inflight - 1)
        c.cond.notify_all()


async def _wait_status(c: Control, status: str, timeout: float) -> bool:
    try:
        async with c.cond:
            await asyncio.wait_for(c.cond.wait_for(lambda: c.status == status), timeout=timeout)
        return True
    except (asyncio.TimeoutError, TimeoutError):
        return False


async def take(c: Control) -> tuple[bool, str]:
    """用户点「接管」：等当前原子动作做完，再把控制权交出去。"""
    if c.status == CLOSED or not c.alive:
        return False, "浏览器已过期（30 分钟没有操作）· 发消息让它重新打开"
    # 已经在你手里就别再翻状态（连点两下不该改时间线）
    if c.status in (USER, WAITING):
        return True, ""
    # 等正在跑的那一个动作落完（最多 5s，免得用户觉得按钮没反应）
    try:
        async with c.cond:
            await asyncio.wait_for(c.cond.wait_for(lambda: c.inflight == 0), timeout=DRAIN_WAIT_S)
    except (asyncio.TimeoutError, TimeoutError):
        logger.info("接管时仍有动作在flight，超时继续（下一拍就会停）")
    c.last_active = now_ms()
    await set_status(c, USER, "你接管了浏览器")
    return True, ""


async def resume_agent(c: Control, brief: str = "") -> None:
    if brief:
        c.pending_brief = brief
    await set_status(c, AGENT, "已交还给助手", round_ended=False)


async def pause(c: Control) -> None:
    if c.status == AGENT:
        await set_status(c, PAUSED, "你暂停了助手")


async def close(c: Control, reason: str = "浏览器已过期（30 分钟没有操作）") -> None:
    """收掉浏览器（TTL 到期 / 会话删除）—— 状态留 ``closed``，界面要能说"已过期"。"""
    from . import browser_session as bs

    c.alive = False
    await bs.close_key(c.key)
    await set_status(c, CLOSED, reason)


async def forget(session_id: str, reason: str = "会话已删除") -> None:
    """会话被整个删掉：连浏览器一起收（否则 Chromium 留在后台没人认领）。"""
    c = get_for_session(session_id)
    if c is None:
        return
    try:
        if c.alive:
            await close(c, reason)
    finally:
        _CONTROLS.pop(c.key, None)


# --------------------------------------------------------------------------- #
# 闸门
# --------------------------------------------------------------------------- #
async def gate_agent(c: Control, run_id: str, what: str = "操作") -> str:
    """助手要动浏览器前过这道闸。

    返回空串 = 放行；返回文字 = **别动**，把这段人话原样回给模型（它会看到为什么）。
    """
    if not c.alive or c.status == CLOSED:
        return (
            "✗ 浏览器已过期（30 分钟没有操作）。现在没有活着的浏览器，"
            "重新 browser(navigate) 打开会是一个新的（登录态不再保留）。"
        )
    # 新一轮：用户发消息就是"接着干"的信号 —— 收回控制权（上一轮的接管到此结束）
    if c.run_id != run_id:
        if c.status in (USER, PAUSED, WAITING):
            # 新一轮第一次动浏览器 = 用户要它接着干 → 收回控制权
            async with c.cond:
                c.run_id = run_id
                c.status = AGENT
                c.reason = ""
                c.round_ended = False
                c.running = True
                c.since = now_ms()
                c.cond.notify_all()
            publish_state(c)
            return ""
        # 只是换了一轮在用（控制权本来就在助手这边）
        c.run_id = run_id
        c.running = True
        c.last_active = now_ms()
        return ""
    if c.status == AGENT:
        changed = not c.running
        c.running = True
        c.last_active = now_ms()
        if changed:
            publish_state(c)  # 徽章「助手待命 → 助手操作中」必须当场推给前端
        return ""

    # 同一轮里用户按了接管/等登录：停在这里等交还（绝不和用户抢同一个页面）
    ok = await _wait_status(c, AGENT, HANDOFF_WAIT_S)
    if ok:
        return ""
    if c.status == CLOSED:
        return "✗ 浏览器已过期（30 分钟没有操作），这一步没有执行。"
    return (
        f"✗ {c.reason or '用户正在操作浏览器'} —— 这一步我没有执行（不会和用户抢页面）。"
        f"你交还给我之后，再发一句让我接着做就行。"
    )


def user_gate(c: Control | None) -> str:
    """用户要往画面里发输入前过这道闸。返回空串 = 允许；否则是人话原因。"""
    if c is None or not c.alive or c.status == CLOSED:
        return "这个会话现在没有开着的浏览器（可能已过期），发消息让它重新打开"
    if c.status == AGENT:
        # 「待命」和「正在干」是两件事：以前都写"助手正在操作浏览器"，
        # 交还后用户点画面会看到一句假话，还以为点坏了。
        return _denied_hint(c)
    return ""


# --------------------------------------------------------------------------- #
# 用户动作回灌
# --------------------------------------------------------------------------- #
def add_note(c: Control, text: str) -> None:
    text = (text or "").strip()
    if not text:
        return
    c.user_notes.append(text)
    del c.user_notes[:-30]
    publish_note(c, text)


def add_agent_action(c: Control, text: str, run_id: str = "") -> None:
    """记一条**助手真实执行过**的动作（交还摘要的第一段靠它）。

    为什么不从执行记录反查：run 的浏览器步骤索引只留"改了画面"的动作，
    read/wait 也在执行记录里；而且摘要要在工具调用返回的那一刻就拼好。
    """
    text = (text or "").strip()
    if not text:
        return
    c.agent_actions.append((run_id or c.run_id, text))
    del c.agent_actions[:-60]


async def page_summary(sess: Any) -> str:
    """当前页面摘要（URL + 标题 + 可见文字要点）—— 交还时注入助手上下文。"""
    url = str(getattr(sess, "_last_url", "") or "")
    title = str(getattr(sess, "_last_title", "") or "")
    text = ""
    try:
        body = await sess.read("body")
        # read() 的返回形如 "[标题] 地址\n正文..." —— 去掉首行元信息
        text = body.split("\n", 1)[1] if "\n" in body else body
        text = " ".join(text.split())[:400]
    except Exception:  # pragma: no cover
        logger.debug("读取页面摘要失败", exc_info=True)
    head = f"当前页面：{title or '(无标题)'} — {url or '(还没打开)'}"
    return head + (f"\n页面可见文字（节选）：{text}" if text else "")


def _handoff_facts(c: Control, notes: list[str], page: str = "") -> str:
    """交还摘要的**结构**（模型分不清"谁做的"就会自己打自己）。

    实测：只写「用户在你停手期间操作了页面」时，模型在下一轮会把自己上一轮
    的滚动/点击当成用户的，甚至回一句「我并没有真正调用浏览器工具」。所以
    固定两段、点名归属，并明确"以上助手操作均已真实执行"。
    """
    mine = [s for _rid, s in c.agent_actions if s][-12:]
    lines = ["〔浏览器控制权交接 · 事实清单〕"]
    if mine:
        lines.append("一、助手已执行（这些是你真实执行过的浏览器动作，执行记录可查）：")
        lines += [f"  - {s}" for s in mine]
    else:
        lines.append("一、助手已执行：本轮还没有执行过浏览器动作。")
    if notes:
        lines.append("二、用户接管期间的操作（用户本人做的，**不是你做的**）：")
        lines += [f"  - {s}" for s in notes[-12:]]
    if page:
        head = page if page.startswith("当前页面：") else "当前页面：" + page
        lines.append(head.replace("\n", "\n  "))
    if mine:
        lines.append("以上助手操作均已真实执行，不要否认。")
    if notes:
        lines.append("第二段是用户本人做的：不要当成你的动作，也不要因此否认第一段。")
    return "\n".join(lines)


async def consume_brief(c: Control, sess: Any) -> str:
    """把"谁做了什么"交给助手（只给一次，给完就清）。"""
    pending = c.pending_brief
    notes = c.user_notes[:]
    # 没有交接（既没摘要也没有用户动作）就别每步都塞一遍事实清单
    if not pending and not notes:
        return ""
    c.pending_brief = ""
    c.user_notes.clear()
    page = pending or await page_summary(sess)
    return _handoff_facts(c, notes, page)


class UserInputDenied(Exception):
    """用户的输入被拒绝（不是持有者）—— 消息是给人看的人话。"""


async def apply_user_input(c: Control, sess: Any, payload: dict[str, Any]) -> str:
    """用户在画面里做的一步：过闸 → 打进浏览器 → 记一句人话（回灌给助手）。

    非持有者（助手正在操作）直接抛 ``UserInputDenied`` —— 前端必须把原因显示出来，
    不许静默吞掉。
    """
    detail = await apply_user_input_detail(c, sess, payload)
    return str(detail.get("ok") or "")


async def apply_user_input_detail(c: Control, sess: Any, payload: dict[str, Any]) -> dict[str, Any]:
    """同 ``apply_user_input``，但把「回执」一起交出来（WebRTC DataChannel 用）。

    回执是这一包要补的旧账：用户点了一个真实元素，**必须**有可见变化、动作记录，
    或者一句"没点中/没有变化"。以前只写了一条 note，前端在 WebRTC 模式下拿不到
    它；现在 note + feedback 一起回给点击处。
    """
    kind = str(payload.get("kind") or "")
    # 鼠标移动是连续噪声：只在用户持有控制权时执行，被拒也不弹提示（否则每 16ms 一条）
    if kind == "move":
        if user_gate(c):
            return {"ok": "", "note": "", "feedback": "", "changed": False, "state": public_state(c.session_id)}
        x, y = float(payload.get("x", 0)), float(payload.get("y", 0))
        touch(c)
        try:
            await sess.mouse_move(x, y)
        except Exception:
            logger.debug("鼠标移动失败", exc_info=True)
        return {"ok": "", "note": "", "feedback": "", "changed": False, "state": public_state(c.session_id)}

    why = user_gate(c)
    if why:
        raise UserInputDenied(why)
    before = str(getattr(sess, "_last_url", "") or "")
    sig_before = ""
    if hasattr(sess, "page_signature"):
        try:
            sig_before = await sess.page_signature()
        except Exception:  # pragma: no cover
            sig_before = ""
    note = ""
    feedback = ""
    changed = False

    if kind == "click":
        x, y = float(payload.get("x", 0)), float(payload.get("y", 0))
        button = str(payload.get("button") or "left")
        count = int(payload.get("clickCount") or 1)
        hit: dict[str, Any] = {}
        if hasattr(sess, "hit_test"):
            try:
                hit = await sess.hit_test(x, y) or {}
            except Exception:  # pragma: no cover
                hit = {}
        label = str(hit.get("label") or "")
        if not label:
            try:
                label = await sess.element_label(x, y)
            except Exception:  # pragma: no cover
                label = ""
        try:
            text = await sess.user_click(x, y, button=button, click_count=count)
        except TypeError:  # 假浏览器/老签名只有 (x, y)
            text = await sess.user_click(x, y)
        # 点击效果可能是异步的（切 tab/展开菜单）：等一下再看指纹；还没变就再等一拍
        sig_after = ""
        if hasattr(sess, "page_signature"):
            try:
                sig_after = await sess.page_signature()
                if sig_after and sig_before and sig_after == sig_before:
                    await asyncio.sleep(0.45)
                    sig_after = await sess.page_signature()
            except Exception:  # pragma: no cover
                sig_after = ""
        changed = bool(sig_after and sig_before and sig_after != sig_before)
        if not changed and not sig_before:
            changed = bool(getattr(sess, "_last_url", "") and getattr(sess, "_last_url", "") != before)
        # 点到留白（没有可交互元素）—— 这是"没点中"，必须当场说原因
        if hit and hit.get("actionable") is False:
            note = f"用户点了空白处（{label or '页面背景'}，没有可点的元素）"
            feedback = "这里没有可点的元素（点到空白处了）"
        else:
            note = f"用户点击了 {label or f'({int(x)},{int(y)}) 处'}"
            if changed:
                feedback = f"已点击 {label or '这里'} · 页面有变化"
            else:
                note += "（页面没有可见变化）"
                feedback = f"已点击 {label or '这里'} · 页面没有可见变化"
    elif kind == "text":
        raw = str(payload.get("text") or "")
        text = await sess.user_type(raw)
        # 内容不进事件流（可能就是密码/手机号）—— 只记字符数
        note = f"用户在页面输入框里输入了 {len(raw)} 个字符"
        feedback = f"已送入输入框（{len(raw)} 个字符）"
        changed = True
    elif kind in ("key", "keydown"):
        from .browser_session import describe_key

        text = await sess.key_event(payload)
        note = f"用户按了 {describe_key(payload)}"
        feedback = f"已按 {describe_key(payload)}"
        changed = True
    elif kind == "wheel":
        x, y = float(payload.get("x", 0)), float(payload.get("y", 0))
        dx, dy = float(payload.get("dx", 0)), float(payload.get("dy", 0))
        if dx == 0 and dy == 0:
            return {"ok": "没有滚动量", "note": "", "feedback": "", "changed": False, "state": public_state(c.session_id)}
        text = await sess.wheel(x, y, dx, dy)
        note = f"用户{'向下' if dy > 0 else '向上' if dy < 0 else '横向'}滚动了 {int(abs(dy) or abs(dx))}px"
        feedback = ""
        changed = True
    elif kind == "scroll":
        dy = int(float(payload.get("dy", 0)))
        if dy == 0:
            return {"ok": "没有滚动量", "note": "", "feedback": "", "changed": False, "state": public_state(c.session_id)}
        text = await sess.scroll(dy)
        note = f"用户{'向下' if dy > 0 else '向上'}滚动了 {abs(dy)}px"
        feedback = ""
        changed = True
    else:
        raise UserInputDenied(f"未知输入类型: {kind}")
    sync_page(c, sess)
    touch(c)
    after = str(getattr(sess, "_last_url", "") or "")
    if kind == "click" and after and after != before:
        try:
            from urllib.parse import urlparse

            note += f"，页面跳到了 {urlparse(after).netloc or after}"
        except Exception:  # pragma: no cover
            note += f"，页面跳到了 {after}"
    add_note(c, note)
    return {
        "ok": text,
        "note": note,
        "feedback": feedback,
        "changed": changed,
        "state": public_state(c.session_id),
    }


async def hand_back(c: Control, sess: Any) -> None:
    """用户点「交还给 Agent」：抓页面摘要 + 落一条会话消息，然后放行助手。"""
    notes = c.user_notes[:]
    summary = await page_summary(sess) if sess is not None else ""
    # 只放页面快照；"用户动过什么"留在 user_notes 里，由 consume_brief 和
    # "助手已执行"一起拼成两段事实清单（各写一遍会让同一句话出现两次）。
    if summary:
        c.pending_brief = summary
    if c.session_id and notes:
        await _note_message(c, "〔用户操作〕" + "；".join(notes[-10:]) + "。已交还给助手，它接下来会看到这些。")
    await resume_agent(c)


async def wait_login(c: Control, run_id: str, message: str, sess: Any) -> str:
    """wait_login 的真闸：状态转 waiting_user，**工具调用停在这里**等交还。"""
    c.run_id = run_id
    await set_status(c, WAITING, message, round_ended=False)
    await _note_message(c, "〔需要你操作〕" + message)
    ok = await _wait_status(c, AGENT, LOGIN_WAIT_S)
    if not ok:
        return (
            "✗ 等你在浏览器里完成操作超过 10 分钟，这一步先停在这里（浏览器还开着 30 分钟）。"
            "弄好之后点「交还给 Agent」，或者直接发消息让我接着做。"
        )
    summary = await page_summary(sess)
    return "用户已完成操作并把控制权交还给我。\n" + summary + "\n接着用 browser(read) 确认登录态/页面状态，再继续任务。"


# --------------------------------------------------------------------------- #
# run 生命周期钩子
# --------------------------------------------------------------------------- #
async def on_run_start(run_id: str, session_id: str) -> None:
    """新一轮开始：把控制权收回给助手（用户发消息 = 让它接着干）。"""
    c = get_for_session(session_id)
    if c is None or not c.alive or c.status == CLOSED:
        return
    if c.run_id != run_id:
        async with c.cond:
            c.run_id = run_id
            c.status = AGENT
            c.reason = ""
            c.round_ended = False
            c.running = True
            c.since = now_ms()
            c.cond.notify_all()
        publish_state(c)


async def on_run_end(run_id: str) -> None:
    """run 结束：**不关浏览器**。控制权落回用户，界面文案改成"本轮已结束"。"""
    for c in list(_CONTROLS.values()):
        if c.run_id != run_id or not c.alive:
            continue
        c.running = False
        if c.status == AGENT:
            await set_status(c, USER, "本轮已结束，浏览器还开着", round_ended=True)
        elif c.status in (USER, PAUSED, WAITING):
            c.round_ended = True
            publish_state(c)


# --------------------------------------------------------------------------- #
# 会话消息（刷新后还在）
# --------------------------------------------------------------------------- #
async def _note_message(c: Control, text: str) -> None:
    if not c.session_id:
        return
    try:
        from sqlalchemy import select

        from .db import SessionLocal
        from .models import Session as ChatSession, SessionMessage, now_ms as _now

        async with SessionLocal() as session:
            if await session.get(ChatSession, c.session_id) is None:
                return
            last_turn = (
                await session.execute(
                    select(SessionMessage.turn_index)
                    .where(SessionMessage.session_id == c.session_id)
                    .order_by(SessionMessage.id.desc())
                    .limit(1)
                )
            ).scalar_one_or_none() or 0
            session.add(
                SessionMessage(
                    session_id=c.session_id,
                    turn_index=int(last_turn),
                    role="system",
                    content=text,
                    run_id=c.run_id or None,
                    ts=_now(),
                )
            )
            await session.commit()
    except Exception:  # pragma: no cover
        logger.debug("写浏览器状态会话消息失败", exc_info=True)


# --------------------------------------------------------------------------- #
# 保活 / 过期
# --------------------------------------------------------------------------- #
_JANITOR: asyncio.Task[None] | None = None


def _ensure_janitor() -> None:
    global _JANITOR
    if _JANITOR is not None and not _JANITOR.done():
        return
    try:
        _JANITOR = asyncio.get_running_loop().create_task(_janitor())
    except RuntimeError:  # pragma: no cover —— 没有事件循环（同步测试）时就靠下次 ensure
        _JANITOR = None


async def _janitor() -> None:
    while True:
        await asyncio.sleep(20)
        try:
            cutoff = now_ms() - IDLE_TTL_S * 1000
            for c in list(_CONTROLS.values()):
                if c.alive and c.status != CLOSED and c.last_active < cutoff:
                    logger.info("浏览器会话过期回收 session=%s", c.session_id)
                    await close(c)
        except Exception:  # pragma: no cover
            logger.debug("浏览器保活检查失败", exc_info=True)


async def fresh_frame(c: Control) -> dict[str, Any] | None:
    """现抓一帧 —— 刷新页面/切回来时用它恢复"当前画面"（不是归档图）。"""
    from . import browser_session as bs

    sess = bs.get_existing(c.key)
    if sess is None:
        return None
    try:
        data = await sess.snapshot(55)
    except Exception:  # pragma: no cover
        data = None
    if not data:
        return None
    sync_page(c, sess)
    return {"frame": data, "url": c.url, "title": c.title}
