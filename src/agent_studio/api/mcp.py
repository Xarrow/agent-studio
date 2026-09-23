"""MCP 服务器 —— 注册、探测、绑定。

为什么要有"探测"这一步，而不是让用户手填工具清单
------------------------------------------------
MCP 服务器的工具是**它自己的能力**，随时会随版本变。手填的清单一定会和实际漂移，
然后表现为"配了却调不到"这种最难查的错。所以这里只让用户填**怎么连**（命令或地址），
工具清单一律靠 ``probe`` 连上去问服务器要。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, HTTPException

from ..db import SessionLocal
from ..models import McpServer, now_ms
from ..schemas import (
    McpProbeResult,
    McpServerCreate,
    McpServerRead,
    McpServerUpdate,
)

logger = logging.getLogger(__name__)


def safe_mcp_name(name: str, fallback: str = "mcp") -> str:
    """把服务器名规整成 ``[a-zA-Z0-9_-]``。

    为什么必须做：AgentScope 拿这个名字当**工具名前缀**（``mcp__<name>__<tool>``），
    而这个名字最终要进 LLM 的函数定义 —— 很多 provider 只接受 ASCII 标识符。
    中文名会让整个 MCPClient 构造失败（实测报 "contains characters not allowed"）。
    与其让用户撞在保存后的运行时错误上，不如在这里就地转成合法名字。
    """
    raw = name.strip()
    out = "".join(
        ch if (ch.isascii() and (ch.isalnum() or ch in "_-")) else "-" for ch in raw
    ).strip("-")
    # 纯中文名会被清成空（或只剩 "v2" 这种碎片）→ 用**稳定短哈希**兜底：
    # 同名每次都得到同一个名字，不同名不会撞（"工具1"/"工具2" 必须区分得开）。
    if len(out) < 2 or (len(raw) > 4 and len(out) / len(raw) < 0.5):
        import hashlib

        digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:6]
        out = f"{fallback}-{digest}"
    return out[:48]

router = APIRouter(prefix="/api/mcp", tags=["mcp"])

#: 探测的超时：stdio 冷启动要拉包/起进程，给宽一点；连上之后列工具很快
CONNECT_TIMEOUT_S = 45.0
LIST_TIMEOUT_S = 30.0


async def probe_config(
    *,
    name: str,
    transport: str,
    command: str = "",
    args: list[str] | None = None,
    url: str = "",
    env: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[list[dict[str, str]], str]:
    """连上去把工具清单要回来。返回 ``(tools, error)`` —— 不抛异常，让调用方决定怎么报。

    stdio 必须 stateful（要显式 connect/close），http 走 stateless（每次调用临时开）。
    这两条是 AgentScope 的约束，写在这里免得每个调用点各猜一遍。
    """
    from agentscope.mcp import HttpMCPConfig, MCPClient, StdioMCPConfig

    try:
        if transport == "http":
            if not url.strip():
                return [], "还没填服务器地址"
            client = MCPClient(
                name=safe_mcp_name(name, "probe"),
                is_stateful=False,
                mcp_config=HttpMCPConfig(url=url.strip(), headers=headers or None),
            )
            tools = await asyncio.wait_for(client.list_tools(), timeout=LIST_TIMEOUT_S)
        else:
            if not command.strip():
                return [], "还没填启动命令"
            client = MCPClient(
                name=safe_mcp_name(name, "probe"),
                is_stateful=True,
                mcp_config=StdioMCPConfig(
                    command=command.strip(),
                    args=[str(a) for a in (args or [])] or None,
                    env=env or None,
                ),
            )
            await asyncio.wait_for(client.connect(), timeout=CONNECT_TIMEOUT_S)
            try:
                tools = await asyncio.wait_for(client.list_tools(), timeout=LIST_TIMEOUT_S)
            finally:
                await client.close()
        return [
            {
                "name": str(getattr(t, "name", "") or ""),
                "description": str(getattr(t, "description", "") or "")[:300],
            }
            for t in tools
            if getattr(t, "name", "")
        ], ""
    except asyncio.TimeoutError:
        return [], f"超时：{CONNECT_TIMEOUT_S:.0f} 秒内没连上（命令/地址对不对？）"
    except Exception as exc:  # noqa: BLE001 —— 探测失败的理由什么都可能是，原样带回界面
        logger.warning("MCP 探测失败 %s: %s", name, exc)
        return [], f"{type(exc).__name__}: {exc}"[:600]


def _to_read(row: McpServer) -> McpServerRead:
    return McpServerRead(
        id=row.id,
        name=row.name,
        transport=row.transport,
        command=row.command,
        args=list(row.args or []),
        url=row.url,
        env=dict(row.env or {}),
        headers=dict(row.headers or {}),
        enabled=bool(row.enabled),
        tools=list(row.tools or []),
        last_probe_ok=bool(row.last_probe_ok),
        last_probe_at=row.last_probe_at or 0,
        last_probe_error=row.last_probe_error or "",
        created_at=row.created_at or 0,
        updated_at=row.updated_at or 0,
    )


@router.get("", response_model=list[McpServerRead])
async def list_servers(limit: int = 100) -> list[McpServerRead]:
    async with SessionLocal() as session:
        rows = (
            await session.execute(
                McpServer.__table__.select().order_by(McpServer.created_at.desc()).limit(limit)
            )
        ).mappings().all()
    return [_to_read(McpServer(**dict(r))) for r in rows]


@router.post("", response_model=McpServerRead, status_code=201)
async def create_server(body: McpServerCreate) -> McpServerRead:
    async with SessionLocal() as session:
        row = McpServer(
            name=body.name.strip() or "未命名 MCP",
            transport=body.transport,
            command=body.command.strip(),
            args=[str(a) for a in body.args],
            url=body.url.strip(),
            env={str(k): str(v) for k, v in body.env.items()},
            headers={str(k): str(v) for k, v in body.headers.items()},
            enabled=body.enabled,
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)
        return _to_read(row)


@router.put("/{server_id}", response_model=McpServerRead)
async def update_server(server_id: str, body: McpServerUpdate) -> McpServerRead:
    async with SessionLocal() as session:
        row = await session.get(McpServer, server_id)
        if row is None:
            raise HTTPException(404, "没有这个 MCP 服务器")
        data = body.model_dump(exclude_unset=True)
        for key, value in data.items():
            if key in ("args",) and value is not None:
                value = [str(v) for v in value]
            if key in ("env", "headers") and value is not None:
                value = {str(k): str(v) for k, v in value.items()}
            setattr(row, key, value)
        row.updated_at = now_ms()
        await session.commit()
        await session.refresh(row)
        return _to_read(row)


@router.delete("/{server_id}", status_code=204)
async def delete_server(server_id: str) -> None:
    async with SessionLocal() as session:
        row = await session.get(McpServer, server_id)
        if row is None:
            raise HTTPException(404, "没有这个 MCP 服务器")
        await session.delete(row)
        await session.commit()


@router.post("/probe", response_model=McpProbeResult)
async def probe_unsaved(body: McpServerCreate) -> McpProbeResult:
    """保存前先试连（界面上"测试连接"按钮用），成功后不落库。"""
    tools, error = await probe_config(
        name=body.name,
        transport=body.transport,
        command=body.command,
        args=body.args,
        url=body.url,
        env=body.env,
        headers=body.headers,
    )
    return McpProbeResult(ok=not error, tools=tools, error=error)


@router.post("/{server_id}/probe", response_model=McpServerRead)
async def probe_saved(server_id: str) -> McpServerRead:
    """重新探测已保存的服务器，并把结果（工具清单 + 成功/失败）写进去。"""
    async with SessionLocal() as session:
        row = await session.get(McpServer, server_id)
        if row is None:
            raise HTTPException(404, "没有这个 MCP 服务器")
        tools, error = await probe_config(
            name=row.name,
            transport=row.transport,
            command=row.command,
            args=list(row.args or []),
            url=row.url,
            env=dict(row.env or {}),
            headers=dict(row.headers or {}),
        )
        row.tools = tools or row.tools
        row.last_probe_ok = not error
        row.last_probe_at = now_ms()
        row.last_probe_error = error
        await session.commit()
        await session.refresh(row)
        return _to_read(row)


def _unused(_: Any) -> None:  # pragma: no cover - 占位，避免 lint 报未使用
    return None
