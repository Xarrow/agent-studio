"""远程 Agent 注册治理的接口（``/api/remote-agents``）。

一条链上的四步，界面上就是四个动作
----------------------------------
    POST /api/remote-agents/resolve        解析：给个地址，看它是什么、会干什么（不落库）
    POST /api/remote-agents                注册：解析成功才落库，并自动建好可挂载的工具行
    POST /api/remote-agents/{id}/refresh   重新解析：远端能力变了，刷新快照（同步工具描述）
    POST /api/remote-agents/{id}/test      真调一次：发一条消息走完整 A2A 往返（验证可达/鉴权）

其余是治理动作：列表（带"被哪些助手挂载"）、改名/凭据/启停、删除（**被引用就拒绝**）。
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import a2a_client, remote_agents
from ..db import SessionLocal, get_session
from ..models import RemoteAgent, Tool, now_ms
from ..schemas import (
    RemoteAgentCreateIn,
    RemoteAgentPatchIn,
    RemoteAgentRead,
    RemoteAgentResolveIn,
    RemoteAgentTestResult,
)
from ..security.crypto import encrypt

router = APIRouter(tags=["remote-agents"])


def _to_read(row: RemoteAgent, *, tool: Tool | None = None, bound: list[dict[str, str]] | None = None) -> RemoteAgentRead:
    parsed = row.parsed or {}
    return RemoteAgentRead(
        id=row.id,
        name=row.name,
        url=row.url,
        parsed=parsed,
        summary=remote_agents.card_text(parsed) if parsed else "",
        remote_agent_id=row.remote_agent_id,
        auth_header=row.auth_header or "Authorization",
        auth_scheme=row.auth_scheme or "Bearer",
        has_token=bool(row.auth_token_enc),
        timeout_s=float(row.timeout_s or 900.0),
        status=row.status or "unknown",
        last_checked_at=row.last_checked_at,
        last_ok_at=row.last_ok_at,
        last_error=row.last_error or "",
        enabled=bool(row.enabled),
        tool_id=row.tool_id,
        tool_name=(tool.name if tool is not None else ""),
        note=row.note or "",
        bound_agents=bound or [],
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def _rows_with_tools(session: AsyncSession) -> list[tuple[RemoteAgent, Tool | None]]:
    rows = (
        await session.execute(select(RemoteAgent).order_by(RemoteAgent.created_at.asc()))
    ).scalars().all()
    tools = (await session.execute(select(Tool).where(Tool.kind == remote_agents.TOOL_KIND))).scalars().all()
    by_remote = {str((t.impl or {}).get("remote_agent_id") or ""): t for t in tools}
    return [(r, by_remote.get(r.id)) for r in rows]


@router.get("", response_model=list[RemoteAgentRead])
async def list_remote_agents(session: AsyncSession = Depends(get_session)) -> list[RemoteAgentRead]:
    """已注册的远程 agent（含解析出的技能数、状态、被哪些助手挂载）。"""
    out: list[RemoteAgentRead] = []
    for row, tool in await _rows_with_tools(session):
        out.append(_to_read(row, tool=tool, bound=await remote_agents.bindings_of(row.id)))
    return out


@router.post("/resolve")
async def resolve_remote_agent(payload: RemoteAgentResolveIn) -> dict[str, Any]:
    """解析一个地址背后的远程 agent（不落库）—— 注册前先看一眼它是什么。"""
    from ..security.crypto import decrypt

    headers: dict[str, str] = {}
    if payload.token:
        headers[payload.auth_header or "Authorization"] = (
            f"{(payload.auth_scheme or 'Bearer').strip()} {payload.token}".strip()
        )
    try:
        got = await remote_agents.resolve(payload.url, headers=headers)
    except a2a_client.A2AError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    del decrypt  # 只是提醒：这里不碰库里的密文
    return {
        "base": got["base"],
        "summary": got["summary"],
        "parsed": got["parsed"],
        "skills": len(got["parsed"].get("skills") or []),
    }


@router.post("", response_model=RemoteAgentRead, status_code=status.HTTP_201_CREATED)
async def create_remote_agent(
    payload: RemoteAgentCreateIn, session: AsyncSession = Depends(get_session)
) -> RemoteAgentRead:
    """注册：**解析成功才落库**（连不上的地址不该进注册表），并建好可挂载的工具行。"""
    headers: dict[str, str] = {}
    if payload.token:
        headers[payload.auth_header or "Authorization"] = (
            f"{(payload.auth_scheme or 'Bearer').strip()} {payload.token}".strip()
        )
    try:
        got = await remote_agents.resolve(payload.url, headers=headers)
    except a2a_client.A2AError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"解析失败：{exc}") from exc

    same = (
        await session.execute(select(RemoteAgent).where(RemoteAgent.url == got["base"]))
    ).scalars().first()
    if same is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"这个地址已经注册过了：{same.name}（{same.id}）"
        )

    parsed = got["parsed"]
    row = RemoteAgent(
        name=(payload.name or parsed["name"] or got["base"]).strip()[:120],
        url=got["base"],
        card=got["card"],
        parsed=parsed,
        remote_agent_id=(payload.remote_agent_id or None),
        auth_header=payload.auth_header or "Authorization",
        auth_scheme=payload.auth_scheme or "Bearer",
        auth_token_enc=encrypt(payload.token) if payload.token else None,
        timeout_s=float(payload.timeout_s or 900.0),
        status="ok",
        last_checked_at=now_ms(),
        last_ok_at=now_ms(),
        enabled=True,
        note=payload.note or "",
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)

    tool = await remote_agents.upsert_tool(session, row)
    row.tool_id = tool.id
    row.updated_at = now_ms()
    await session.commit()
    await session.refresh(row)
    return _to_read(row, tool=tool, bound=[])


@router.post("/{remote_id}/refresh", response_model=RemoteAgentRead)
async def refresh_remote_agent(
    remote_id: str, session: AsyncSession = Depends(get_session)
) -> RemoteAgentRead:
    """重新解析卡片：远端能力可能变了，快照与工具描述都跟着更新。"""
    row = await session.get(RemoteAgent, remote_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"远程 agent 不存在: {remote_id}")
    try:
        got = await remote_agents.resolve(row.url, headers=remote_agents.auth_headers(row))
        row.card = got["card"]
        row.parsed = got["parsed"]
        row.status = "ok"
        row.last_error = ""
        row.last_ok_at = now_ms()
    except a2a_client.A2AError as exc:
        # 解析失败**不丢旧快照**：远端暂时挂了，注册表里仍应看得见它原来会干什么
        row.status = "error"
        row.last_error = f"解析失败：{exc}"
    row.last_checked_at = now_ms()
    row.updated_at = now_ms()
    await session.commit()
    await session.refresh(row)
    tool = await remote_agents.upsert_tool(session, row)
    row.tool_id = tool.id
    await session.commit()
    await session.refresh(row)
    return _to_read(row, tool=tool, bound=await remote_agents.bindings_of(row.id))


@router.post("/{remote_id}/test", response_model=RemoteAgentTestResult)
async def test_remote_agent(remote_id: str) -> RemoteAgentTestResult:
    """真调一次：发一条消息、等远端跑完，把回答带回来（验证可达 + 鉴权 + 协议）。"""
    async with SessionLocal() as session:
        row = await session.get(RemoteAgent, remote_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"远程 agent 不存在: {remote_id}")

    t0 = time.monotonic()
    try:
        status_txt, answer, task_id = await a2a_client.run_until_done(
            row.url,
            "连通性测试：请只回复四个字「远端在线」。",
            agent_id=row.remote_agent_id,
            timeout_s=min(float(row.timeout_s or 900.0), 180.0),
            headers=remote_agents.auth_headers(row),
        )
        ms = int((time.monotonic() - t0) * 1000)
        state = status_txt
        ok = status_txt == "ok"
        async with SessionLocal() as session:
            fresh = await session.get(RemoteAgent, remote_id)
            if fresh is not None:
                fresh.status = "ok" if ok else "error"
                fresh.last_checked_at = now_ms()
                fresh.last_error = "" if ok else f"远端状态：{state}"
                if ok:
                    fresh.last_ok_at = now_ms()
                await session.commit()
        return RemoteAgentTestResult(
            ok=ok, ms=ms, state=state, task_id=task_id, answer=answer[:2000],
            error="" if ok else f"远端状态：{state}",
        )
    except Exception as exc:  # noqa: BLE001 —— 连通性失败要如实回报，不抛 500
        ms = int((time.monotonic() - t0) * 1000)
        msg = f"{type(exc).__name__}: {str(exc)[:200]}"
        async with SessionLocal() as session:
            fresh = await session.get(RemoteAgent, remote_id)
            if fresh is not None:
                fresh.status = "error"
                fresh.last_checked_at = now_ms()
                fresh.last_error = msg
                await session.commit()
        return RemoteAgentTestResult(ok=False, ms=ms, error=msg)


@router.patch("/{remote_id}", response_model=RemoteAgentRead)
async def patch_remote_agent(
    remote_id: str,
    payload: RemoteAgentPatchIn,
    session: AsyncSession = Depends(get_session),
) -> RemoteAgentRead:
    """改名 / 换凭据 / 换远端助手 / 启停 / 备注（改名会同步工具行，助手那边看到的一致）。"""
    row = await session.get(RemoteAgent, remote_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"远程 agent 不存在: {remote_id}")
    if payload.name is not None:
        row.name = payload.name.strip()[:120] or row.name
    if payload.remote_agent_id is not None:
        row.remote_agent_id = payload.remote_agent_id.strip() or None
    if payload.auth_header is not None:
        row.auth_header = payload.auth_header.strip() or "Authorization"
    if payload.auth_scheme is not None:
        row.auth_scheme = payload.auth_scheme.strip() or "Bearer"
    if payload.token is not None:
        row.auth_token_enc = encrypt(payload.token) if payload.token else None
    if payload.timeout_s is not None:
        row.timeout_s = float(payload.timeout_s)
    if payload.enabled is not None:
        row.enabled = bool(payload.enabled)
    if payload.note is not None:
        row.note = payload.note
    row.updated_at = now_ms()
    await session.commit()
    await session.refresh(row)
    tool = await remote_agents.upsert_tool(session, row)
    row.tool_id = tool.id
    await session.commit()
    await session.refresh(row)
    return _to_read(row, tool=tool, bound=await remote_agents.bindings_of(row.id))


@router.delete("/{remote_id}")
async def delete_remote_agent(remote_id: str) -> dict[str, Any]:
    """删除注册项。**已经被助手挂载就拒绝** —— 先解绑再删，别悄悄把别人的能力抽掉。"""
    async with SessionLocal() as session:
        row = await session.get(RemoteAgent, remote_id)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"远程 agent 不存在: {remote_id}")
        bound = await remote_agents.bindings_of(remote_id)
        if bound:
            names = "、".join(b["agent_name"] for b in bound)
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"还有助手在用它（{names}）—— 先在那些助手的「工具」里取消勾选，再删除",
            )
        tool = await session.get(Tool, row.tool_id) if row.tool_id else None
        if tool is not None:
            await session.delete(tool)
        await session.delete(row)
        await session.commit()
    return {"deleted": remote_id}
