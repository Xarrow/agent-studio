"""远程 Agent 注册与治理 —— 把外部 A2A agent 变成平台里可挂载的能力。

用户要的三件事（一条链）
-----------------------
1. **注册治理**：填一个地址 → 解析它的 agent card → 存成平台里的一个资源（改名、备注、
   凭据、启停、重新解析、删除），一个远端只注册一次、多个助手共用（与 MCP 服务器同一套思路）。
2. **解析远程 agent 功能**：卡片里的 ``skills`` / ``capabilities`` / 协议版本全部解析出来
   存快照 —— 界面上要能看见"这个远端到底会干什么"，模型调用时也要把技能写进工具描述
   （不然模型不知道该派什么活给它）。
3. **绑定使用**：注册时会**自动 upsert 一个 ``kind="a2a"`` 的工具行**，于是助手的
   「工具」勾选里就出现它 —— 绑定完全复用既有机制，不新造一套。
   调用时走 ``fanout.dispatch_remote``：每一项照旧建一条 ``runtime="a2a"`` 的子 run，
   所以记录页／调用链／耗时统计这些能力**不用为远端另写一套**。

卡片快照与漂移
--------------
卡片是**探测来的结果**、不是手填的（手填必然漂移）。远端改了能力，界面上点「重新解析」
刷新快照；快照里的技能会同步进工具描述，模型看到的永远是最近一次解析的结果。
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select

from . import a2a_client
from .db import SessionLocal
from .models import RemoteAgent, Tool, new_id, now_ms

logger = logging.getLogger(__name__)

#: 工具行名前缀（用于识别"这个工具是远程 agent 带来的"，和内置工具区分）
TOOL_KIND = "a2a"


def normalize_base(url: str) -> str:
    """把用户可能粘贴的几种地址统一成 base。

    允许：``http://host:port`` / ``http://host:port/a2a`` /
    ``http://host:port/.well-known/agent-card.json``（从卡片地址直接复制）。
    """
    u = (url or "").strip().rstrip("/")
    if not u:
        return ""
    if u.endswith("/.well-known/agent-card.json"):
        u = u[: -len("/.well-known/agent-card.json")]
    if u.endswith("/a2a"):
        u = u[:-4]
    return u.rstrip("/")


def skill_rows(card: dict[str, Any]) -> list[dict[str, Any]]:
    """卡片 skills → 平台内统一的技能条目（只有字段名换一下，不丢内容）。"""
    out: list[dict[str, Any]] = []
    for s in card.get("skills") or []:
        if not isinstance(s, dict):
            continue
        out.append(
            {
                "id": str(s.get("id") or ""),
                "name": str(s.get("name") or s.get("id") or ""),
                "description": str(s.get("description") or ""),
                "tags": [str(t) for t in (s.get("tags") or []) if isinstance(t, (str, int))],
                "examples": [str(e) for e in (s.get("examples") or []) if isinstance(e, str)][:3],
            }
        )
    return out


def parse_card(card: dict[str, Any]) -> dict[str, Any]:
    """A2A agent card → 平台需要的摘要（名称/描述/版本/协议/能力/技能）。"""
    caps = card.get("capabilities") if isinstance(card.get("capabilities"), dict) else {}
    return {
        "name": str(card.get("name") or "").strip(),
        "description": str(card.get("description") or "").strip(),
        "version": str(card.get("version") or "").strip(),
        "protocol_version": str(
            card.get("protocolVersion") or card.get("protocol_version") or ""
        ).strip(),
        "url": str(card.get("url") or "").strip(),
        "capabilities": {
            "streaming": bool(caps.get("streaming")),
            "push_notifications": bool(caps.get("pushNotifications") or caps.get("push_notifications")),
            "state_transition_history": bool(
                caps.get("stateTransitionHistory") or caps.get("state_transition_history")
            ),
        },
        "default_input_modes": [str(x) for x in (card.get("defaultInputModes") or [])],
        "default_output_modes": [str(x) for x in (card.get("defaultOutputModes") or [])],
        "skills": skill_rows(card),
    }


def card_text(parsed: dict[str, Any], *, limit: int | None = None) -> str:
    """把解析结果写成一段给人看、也给**模型看**的说明（工具描述就用它）。

    模型靠这段判断"这个远端能干什么"，所以技能名 + 描述必须带全。
    """
    head = (parsed.get("name") or "").strip()
    desc = (parsed.get("description") or "").strip()
    lines = [f"{head}：{desc}" if head and desc else (head or desc or "远程 A2A agent")]
    skills = parsed.get("skills") or []
    if skills:
        lines.append("可用技能：")
        for s in skills:
            tail = f"（{s['description']}）" if s.get("description") else ""
            tags = f" [{'/'.join(s['tags'])}]" if s.get("tags") else ""
            lines.append(f"- {s['name']}{tags}{tail}")
    if parsed.get("version") or parsed.get("protocol_version"):
        lines.append(
            f"远端版本 {parsed.get('version') or '-'} · A2A {parsed.get('protocol_version') or '-'}"
        )
    text = "\n".join(lines)
    return text[:limit] if limit else text


def tool_name_for(name: str, *, remote_id: str = "") -> str:
    """工具名（模型可见）= 函数名。

    **只能是 ASCII 的字母数字/-/_**: 这是 OpenAI 兼容接口对 function name 的硬约束
    （``^[a-zA-Z0-9_-]{1,64}$``），中文/空格/斜杠都会被上游直接拒掉。所以：
    远端名字是中文时**压不出好名字就用兜底名 + 短哈希**（保证唯一、且可读地从界面找到对应）。
    """
    keep = [c if (c.isascii() and (c.isalnum() or c in "-_")) else "_" for c in (name or "")]
    out = "".join(keep).strip("_")
    while "__" in out:
        out = out.replace("__", "_")
    tail = ""
    if not out:
        # 全非 ASCII：兜底名 + 短哈希（同一台机器上多个中文远端不会撞名）
        import hashlib

        h = hashlib.sha1((remote_id or name or "remote").encode("utf-8")).hexdigest()[:4]
        return f"remote_agent_{h}"
    if remote_id:
        import hashlib

        tail = hashlib.sha1(remote_id.encode("utf-8")).hexdigest()[:4]
    return (out if not tail else f"{out}_{tail}")[:40]


def tool_schema(parsed: dict[str, Any]) -> dict[str, Any]:
    """工具入参：一条消息（可选背景）。远程 agent 要什么由远端决定，这里只给最小形状。"""
    return {
        "type": "object",
        "properties": {
            "message": {
                "type": "string",
                "description": "要交给远程 agent 的任务（自然语言，写清楚想要什么产出）",
            },
            "context": {
                "type": "string",
                "description": "可选的背景材料（会把内容附在任务前面一起发过去）",
            },
        },
        "required": ["message"],
    }


def auth_headers(remote: RemoteAgent) -> dict[str, str]:
    """远端要鉴权时的请求头（密钥加密存在库里，用时才解出来）。"""
    token = ""
    if remote.auth_token_enc:
        from .security.crypto import decrypt

        try:
            token = decrypt(remote.auth_token_enc)
        except Exception:  # noqa: BLE001 —— 解不开就当没配，不要让整次调用炸掉
            logger.warning("远程 agent %s 的凭据解不开（主密钥变了？）", remote.id)
            return {}
    if not token:
        return {}
    header = (remote.auth_header or "Authorization").strip() or "Authorization"
    scheme = (remote.auth_scheme or "Bearer").strip()
    return {header: f"{scheme} {token}".strip()}


# --------------------------------------------------------------------------- #
# 注册 / 刷新 / 绑定
# --------------------------------------------------------------------------- #
async def resolve(url: str, *, timeout: float = 15.0, headers: dict[str, str] | None = None) -> dict[str, Any]:
    """解析一个地址背后的远程 agent（不落库）—— 注册前的"看一眼"。"""
    base = normalize_base(url)
    if not base:
        raise a2a_client.A2AError("地址为空")
    card = await a2a_client.discover(base, timeout=timeout, headers=headers)
    parsed = parse_card(card)
    if not parsed["name"]:
        raise a2a_client.A2AError("卡片里没有 name —— 这地址可能不是 A2A agent card")
    return {"base": base, "card": card, "parsed": parsed, "summary": card_text(parsed)}


async def self_register(
    session: Any,
    card: dict[str, Any],
    *,
    declared_base: str = "",
) -> dict[str, Any]:
    """远端 agent **自己**通过 A2A 把卡片推上来注册（方向与 resolve 相反）。

    信任口径（架构师视角必须说清）：
    · 卡片是**远端自己声明**的 —— name/skills 全是它说的，我们不验证真伪；
      但调用时我们真连的是它给的地址，若连不上刷新会标 error，不构成安全面。
    · 与手工注册同一张表、同一条治理链（启停/删除/重新解析）—— 远端自己注册
      没有任何特权，用户照样能停用/删掉它。
    · 幂等：同一地址重复推送 = 更新卡片快照（远端改了技能清单后重推一次即可），
      并照旧 upsert 工具行 —— 新技能立即出现在助手的可挂载清单里。
    · ``declared_base`` 是推送方声明的回连地址；不信任它指向任意内网 —— 与手工
      注册一样只按这个地址去连，权限治理仍在远端侧。
    """
    parsed = parse_card(card)
    if not parsed["name"]:
        raise a2a_client.A2AError("卡片里没有 name —— 这不是有效的 A2A agent card")

    base = normalize_base(declared_base or parsed.get("url") or "")
    if not base:
        raise a2a_client.A2AError(
            "卡片里没有可用的地址（url 字段缺失，且推送方未声明地址）—— 无法回连"
        )

    same = (
        await session.execute(select(RemoteAgent).where(RemoteAgent.url == base))
    ).scalars().first()
    now = now_ms()
    if same is None:
        row = RemoteAgent(
            name=parsed["name"][:120],
            url=base,
            card=card,
            parsed=parsed,
            status="unknown",  # 自注册只代表"它说了"，还没实测过 —— 首次测试/刷新后转 ok
            last_checked_at=now,
            enabled=True,
            note="（远端自注册）",
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)
        created = True
    else:
        same.card = card
        same.parsed = parsed
        if not same.name or same.note == "（远端自注册）":
            same.name = parsed["name"][:120]
        same.last_checked_at = now
        same.updated_at = now
        created = False
        row = same
        await session.commit()
        await session.refresh(row)

    tool = await upsert_tool(session, row)
    if row.tool_id != tool.id:
        row.tool_id = tool.id
        row.updated_at = now
        await session.commit()
        await session.refresh(row)
    return {"remote": row, "tool": tool, "created": created}


async def upsert_tool(session: Any, remote: RemoteAgent) -> Tool:
    """把远程 agent 同步成一个 ``kind="a2a"`` 的工具行（助手就能勾选挂载了）。

    **同名只建一次**：用 impl.remote_agent_id 认领，已存在就更新（名字/描述/入参都可能
    随远端卡片变化）—— 只建不更新会让新技能/新描述永远不生效。
    """
    name = tool_name_for(remote.name, remote_id=remote.id)
    rows = (await session.execute(select(Tool).where(Tool.kind == TOOL_KIND))).scalars().all()
    mine = next(
        (t for t in rows if (t.impl or {}).get("remote_agent_id") == remote.id), None
    )
    impl = {
        "remote_agent_id": remote.id,
        "remote_base": remote.url,
        "remote_agent_id_on_remote": remote.remote_agent_id or None,
        "timeout_s": remote.timeout_s,
    }
    parsed = remote.parsed or {}
    desc = f"远程 agent（A2A）：{remote.name}\n" + card_text(parsed, limit=1500)
    if mine is None:
        mine = Tool(
            id=new_id("tl_"),
            workspace_id=remote.workspace_id,
            name=name,
            kind=TOOL_KIND,
            description=desc,
            input_schema=tool_schema(parsed),
            impl=impl,
            # 与「分派」同口径：调用本身不直接改本地状态（副作用在远端，由远端的权限策略把关），
            # 按只读对待 —— 否则严格模式下每次调用都要人点确认，定时任务会卡死在 waiting_hitl。
            flags={"read_only": True, "concurrency_safe": False},
            created_at=now_ms(),
        )
        session.add(mine)
    else:
        mine.name = name
        mine.description = desc
        mine.input_schema = tool_schema(parsed)
        mine.impl = impl
    await session.commit()
    await session.refresh(mine)
    return mine


async def bindings_of(remote_id: str) -> list[dict[str, str]]:
    """哪些助手挂了这个远程 agent（删之前要看一眼，别把别人的能力删掉）。"""
    from .models import Agent, AgentTool

    async with SessionLocal() as session:
        rows = (
            await session.execute(select(Tool).where(Tool.kind == TOOL_KIND))
        ).scalars().all()
        tool_ids = [t.id for t in rows if (t.impl or {}).get("remote_agent_id") == remote_id]
        if not tool_ids:
            return []
        out: list[dict[str, str]] = []
        for tid in tool_ids:
            links = (
                await session.execute(select(AgentTool).where(AgentTool.tool_id == tid))
            ).scalars().all()
            for link in links:
                ag = await session.get(Agent, link.agent_id)
                if ag is not None:
                    out.append({"agent_id": ag.id, "agent_name": ag.name})
        return out


# --------------------------------------------------------------------------- #
# 绑成工具后：调用（走既有的 A2A 分派路径）
# --------------------------------------------------------------------------- #
def build_a2a_tool(spec: Any):
    """``kind="a2a"`` 的工具实例 —— 执行体是平台自己的函数（与 fork 工具同构）。

    真正的调用逻辑在 ``fanout.dispatch_remote``：每一条消息照旧建一条 ``runtime="a2a"``
    的子 run，于是记录页/调用链/汇总形状全部复用。
    """
    from agentscope.tool import FunctionTool

    impl = dict(spec.impl or {})
    name = spec.name
    description = spec.description or name

    async def _call(message: str = "", context: str | None = None, **_: Any) -> str:
        from .fanout import _parent_run, dispatch_remote, render_summary
        from .runner.ctx import current_run_ctx

        text = (message or "").strip()
        if not text:
            return "调用失败：message 不能为空。"
        if context:
            text = f"背景材料：\n{context}\n\n任务：\n{text}"

        ctx = current_run_ctx()
        run_id, agent_id = ctx.get("run_id"), ctx.get("agent_id")
        if not run_id or not agent_id:
            return "调用失败：当前不在一次执行上下文中（远程 agent 只能由正在运行的助手调用）。"

        remote_base = str(impl.get("remote_base") or "").strip()
        headers: dict[str, str] = {}
        async with SessionLocal() as session:
            row = await session.get(RemoteAgent, str(impl.get("remote_agent_id") or ""))
        if row is not None:
            if not row.enabled:
                return f"调用失败：远程 agent「{row.name}」已停用（在「远程 Agent」页可以重新启用）。"
            headers = auth_headers(row)
            if not remote_base:
                remote_base = row.url
        if not remote_base:
            return "调用失败：这个远程 agent 已从平台删除，请在「远程 Agent」页重新注册。"
        try:
            parent = await _parent_run(run_id)
            result = await dispatch_remote(
                parent_run=parent,
                agent_id=str(agent_id),
                remote_base=remote_base,
                items=[text],
                max_items=1,
                wait_s=impl.get("timeout_s"),
                remote_agent_id=impl.get("remote_agent_id_on_remote"),
                headers=headers,
            )
        except Exception as exc:  # noqa: BLE001 —— 远端不可达不能炸掉整次执行
            logger.exception("远程 agent 调用失败")
            return f"调用远端失败（{type(exc).__name__}）：{str(exc)[:200]}"
        head = f"（这是发给远端 A2A agent「{result.get('remote_name') or remote_base}」执行的：{remote_base}）\n"
        return head + render_summary(result)

    return FunctionTool(
        _call,
        name=name,
        description=description,
        input_schema=spec.input_schema or tool_schema({}),
        is_read_only=True,
        is_concurrency_safe=False,
    )
