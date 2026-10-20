"""MCP 服务器 —— 注册、探测、绑定。

为什么要有"探测"这一步，而不是让用户手填工具清单
------------------------------------------------
MCP 服务器的工具是**它自己的能力**，随时会随版本变。手填的清单一定会和实际漂移，
然后表现为"配了却调不到"这种最难查的错。所以这里只让用户填**怎么连**（命令或地址），
工具清单一律靠 ``probe`` 连上去问服务器要。
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from ..db import SessionLocal
from ..models import McpServer, now_ms
from ..security.crypto import decrypt, encrypt
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


# --------------------------------------------------------------------------- #
# env / headers 落盘加密
# --------------------------------------------------------------------------- #
#: 为什么这两个字段必须加密：MCP 的鉴权几乎都走 headers（``Authorization: Bearer ...``）
#: 或 env（``GITHUB_TOKEN``）。以前明文存 SQLite —— 备份、复制库、发个诊断包都会把
#: 别人的 token 一起带走。这里与 LLM 密钥用同一套主密钥（``security.crypto``）。
def seal(env: dict[str, str] | None, headers: dict[str, str] | None) -> tuple[str, str]:
    """把 env / headers 加密成两段密文（空字典也存，表示"明确没有"）。"""
    return (
        encrypt(json.dumps(env or {}, ensure_ascii=False)).decode(),
        encrypt(json.dumps(headers or {}, ensure_ascii=False)).decode(),
    )


def _loads(blob: str | None) -> dict[str, str]:
    if not blob:
        return {}
    try:
        data = json.loads(decrypt(blob.encode()))
    except Exception:  # noqa: BLE001 —— 主密钥换过/密文坏了：当没有，别让整页崩
        logger.warning("MCP 凭据解密失败（主密钥换过？）")
        return {}
    return {str(k): str(v) for k, v in (data or {}).items()} if isinstance(data, dict) else {}


def open_io(row: McpServer) -> tuple[dict[str, str], dict[str, str]]:
    """读回 (env, headers)：有密文用密文，没有就回落到明文列（老数据）。"""
    env = _loads(row.env_enc) if row.env_enc else dict(row.env or {})
    headers = _loads(row.headers_enc) if row.headers_enc else dict(row.headers or {})
    return env, headers


def apply_io(row: McpServer, env: dict[str, str] | None, headers: dict[str, str] | None) -> None:
    """写入：密文进新列，明文列清空（不留第二份明文）。"""
    row.env_enc, row.headers_enc = seal(env, headers)
    row.env = {}
    row.headers = {}


def _to_read(row: McpServer) -> McpServerRead:
    env, headers = open_io(row)
    return McpServerRead(
        id=row.id,
        name=row.name,
        transport=row.transport,
        command=row.command,
        args=list(row.args or []),
        url=row.url,
        env=env,
        headers=headers,
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


#: 标准 mcpServers JSON 里的 type → 本平台的 transport（本平台只有 stdio 与 http 两种）
_TYPE_MAP = {
    "stdio": "stdio",
    "http": "http",
    "sse": "http",
    "streamable-http": "http",
    "streamablehttp": "http",
}


def _coerce_env(raw: Any) -> dict[str, str]:
    """env 有两种写法：对象 ``{"K":"V"}``，或数组 ``["K=V"]``（不少客户端用后者）。"""
    if isinstance(raw, dict):
        return {str(k): str(v) for k, v in raw.items()}
    if isinstance(raw, list):
        out: dict[str, str] = {}
        for item in raw:
            s = str(item)
            if "=" in s:
                k, v = s.split("=", 1)
                out[k.strip()] = v
        return out
    return {}


def _from_mcp_servers(payload: Any) -> list[McpServerCreate]:
    """把标准 ``mcpServers`` JSON 解析成注册项（Claude Desktop / Cursor 那一套直接粘）。

    形态一（stdio）：``{"command":"npx","args":[...],"env":{...}}``
    形态二（http） ：``{"url":"...","type":"http","headers":{"Authorization":"Bearer ..."}}``

    判据是**字段存在性**而不是 type：有 command 走 stdio、有 url 走 http，
    type 只用来兜底（sse / streamable-http 都归到本平台的 http）。
    这样即便对方把 type 写错、或者干脆不写 type，也能正确注册。
    """
    servers = payload.get("mcpServers") if isinstance(payload, dict) else None
    if servers is None and isinstance(payload, dict):
        servers = payload  # 也接受不带 mcpServers 外壳的 {"名字": {...}}
    if not isinstance(servers, dict) or not servers:
        raise HTTPException(400, '没找到 mcpServers 配置：应为 {"mcpServers": {"名字": {...}}}')

    out: list[McpServerCreate] = []
    for name, cfg in servers.items():
        if not isinstance(cfg, dict):
            raise HTTPException(400, f"「{name}」的配置不是对象")
        command = str(cfg.get("command") or "").strip()
        url = str(cfg.get("url") or "").strip()
        if not command and not url:
            raise HTTPException(400, f"「{name}」既没有 command（stdio）也没有 url（http）")
        transport = "stdio" if command else _TYPE_MAP.get(str(cfg.get("type") or "").lower(), "http")
        if transport not in ("stdio", "http"):
            transport = "http"
        headers = cfg.get("headers") if isinstance(cfg.get("headers"), dict) else {}
        out.append(
            McpServerCreate(
                name=safe_mcp_name(str(name)),
                transport=transport,
                command=command,
                args=[str(a) for a in (cfg.get("args") or [])],
                url=url,
                env=_coerce_env(cfg.get("env")),
                headers={str(k): str(v) for k, v in headers.items()},
                enabled=True,
            )
        )
    return out


@router.post("/import", response_model=list[McpServerRead], status_code=201)
async def import_servers(payload: dict[str, Any]) -> list[McpServerRead]:
    """直接吃标准 ``mcpServers`` JSON：一次可多条，逐条落库。

    同名（safe_mcp_name 之后）视为**更新**：改连接，而不是再插一条——
    同一份配置粘两次不该得到两个同名服务器。
    """
    out: list[McpServerRead] = []
    async with SessionLocal() as session:
        for it in _from_mcp_servers(payload):
            row = (
                await session.execute(select(McpServer).where(McpServer.name == it.name))
            ).scalar_one_or_none()
            if row is None:
                row = McpServer(name=it.name)
                session.add(row)
            row.transport = it.transport
            row.command = it.command
            row.args = list(it.args)
            row.url = it.url
            # 导入/同步也走加密（否则"从文件导入"会成为绕过加密的后门）
            apply_io(row, dict(it.env), dict(it.headers))
            row.enabled = it.enabled
            await session.commit()
            await session.refresh(row)
            out.append(_to_read(row))
    return out


@router.post("", response_model=McpServerRead, status_code=201)
async def create_server(body: McpServerCreate) -> McpServerRead:
    async with SessionLocal() as session:
        row = McpServer(
            name=body.name.strip() or "未命名 MCP",
            transport=body.transport,
            command=body.command.strip(),
            args=[str(a) for a in body.args],
            url=body.url.strip(),
            enabled=body.enabled,
        )
        # 凭据只进密文列（明文列一律留空）
        apply_io(
            row,
            {str(k): str(v) for k, v in body.env.items()},
            {str(k): str(v) for k, v in body.headers.items()},
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
        # env/headers 单独处理：它们要进密文列，不能 setattr 明文
        if "env" in data or "headers" in data:
            cur_env, cur_headers = open_io(row)
            new_env = (
                {str(k): str(v) for k, v in (data.pop("env") or {}).items()}
                if "env" in data
                else cur_env
            )
            new_headers = (
                {str(k): str(v) for k, v in (data.pop("headers") or {}).items()}
                if "headers" in data
                else cur_headers
            )
            apply_io(row, new_env, new_headers)
        for key, value in data.items():
            if key in ("args",) and value is not None:
                value = [str(v) for v in value]
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
        env, headers = open_io(row)
        tools, error = await probe_config(
            name=row.name,
            transport=row.transport,
            command=row.command,
            args=list(row.args or []),
            url=row.url,
            env=env,
            headers=headers,
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


async def migrate_plaintext_secrets() -> int:
    """把历史明文 env/headers 迁进密文列（幂等，启动时跑）。

    为什么每次启动都跑：升级上来的库里躺着一批明文 token，用户不会去"点一下迁移"。
    """
    moved = 0
    async with SessionLocal() as session:
        rows = list((await session.execute(select(McpServer))).scalars())
        for row in rows:
            if row.env_enc or row.headers_enc:
                continue
            if not (row.env or row.headers):
                continue
            apply_io(row, dict(row.env or {}), dict(row.headers or {}))
            moved += 1
        if moved:
            await session.commit()
    return moved
