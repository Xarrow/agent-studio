"""工具资源路由：CRUD + 内置工具发现 + 试运行。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import AgentTool, Tool, now_ms
from ..schemas import ToolCreate, ToolRead, ToolTestRequest

router = APIRouter(prefix="/api/tools", tags=["tools"])


def to_read(row: Tool) -> ToolRead:
    return ToolRead(
        id=row.id,
        kind=row.kind,
        name=row.name,
        description=row.description or "",
        input_schema=row.input_schema or {},
        impl=row.impl or {},
        flags=row.flags or {},
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.get("", response_model=list[ToolRead])
async def list_tools(
    kind: str | None = None, session: AsyncSession = Depends(get_session)
) -> list[ToolRead]:
    stmt = select(Tool).order_by(Tool.updated_at.desc())
    if kind:
        stmt = stmt.where(Tool.kind == kind)
    rows = (await session.execute(stmt)).scalars().all()
    return [to_read(r) for r in rows]


@router.post("", response_model=ToolRead, status_code=status.HTTP_201_CREATED)
async def create_tool(payload: ToolCreate, session: AsyncSession = Depends(get_session)) -> ToolRead:
    if payload.kind == "builtin":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "内置工具请通过 POST /api/tools/sync-builtins 导入，不要手工创建",
        )
    dup = (
        await session.execute(select(Tool).where(Tool.name == payload.name, Tool.kind == payload.kind))
    ).scalar_one_or_none()
    if dup is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, f"同名工具已存在: {payload.name}")

    row = Tool(
        kind=payload.kind,
        name=payload.name,
        description=payload.description,
        input_schema=payload.input_schema,
        impl=payload.impl,
        flags=payload.flags,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return to_read(row)


@router.get("/{tool_id}", response_model=ToolRead)
async def get_tool(tool_id: str, session: AsyncSession = Depends(get_session)) -> ToolRead:
    row = await session.get(Tool, tool_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"工具不存在: {tool_id}")
    return to_read(row)


@router.put("/{tool_id}", response_model=ToolRead)
async def update_tool(
    tool_id: str, payload: ToolCreate, session: AsyncSession = Depends(get_session)
) -> ToolRead:
    row = await session.get(Tool, tool_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"工具不存在: {tool_id}")
    row.name = payload.name
    row.description = payload.description
    row.input_schema = payload.input_schema
    row.impl = payload.impl
    row.flags = payload.flags
    row.updated_at = now_ms()
    await session.commit()
    await session.refresh(row)
    return to_read(row)


@router.delete("/{tool_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tool(tool_id: str, session: AsyncSession = Depends(get_session)) -> None:
    row = await session.get(Tool, tool_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"工具不存在: {tool_id}")
    await session.execute(delete(AgentTool).where(AgentTool.tool_id == tool_id))
    await session.delete(row)
    await session.commit()


# --------------------------------------------------------------------------- #
# 内置工具同步（把运行时的内置工具落库，方便 UI 勾选）
# --------------------------------------------------------------------------- #
@router.post("/sync-builtins")
async def sync_builtins(
    runtime: str = "agentscope", session: AsyncSession = Depends(get_session)
) -> dict:
    """把运行时的内置工具同步入库。

    同时写入**平台适用性**元数据（例如 Linux 服务器上 PowerShell 不可用），
    让 UI 能置灰 + 说明原因，而不是等 Agent 执行到那一步才报错。
    已存在的记录会刷新 flags（平台环境可能变化）。
    """
    from ..runtimes import get_runtime

    rt = get_runtime(runtime)
    discovered = await rt.discover_tools()
    created = 0
    updated = 0
    for item in discovered:
        name = item.get("name")
        flags = dict(item.get("flags") or {})
        flags["builtin"] = True
        exists = (
            await session.execute(select(Tool).where(Tool.kind == "builtin", Tool.name == name))
        ).scalar_one_or_none()
        desc = f"{item.get('display_name', name)}（{runtime} 内置）"
        impl = {
            "runtime": runtime,
            "class_name": item.get("class_name"),
            # 参数签名：前端试跑时据此提示要填哪些参数
            "args": item.get("args") or [],
        }
        if exists is None:
            session.add(
                Tool(
                    kind="builtin",
                    name=name,
                    description=desc,
                    input_schema={"type": "object", "properties": {}},
                    impl=impl,
                    flags=flags,
                )
            )
            created += 1
        else:
            exists.flags = flags
            exists.description = desc
            exists.impl = impl
            exists.updated_at = now_ms()
            updated += 1
    await session.commit()
    return {
        "runtime": runtime,
        "discovered": len(discovered),
        "created": created,
        "updated": updated,
        "unsupported": [
            {"name": i.get("name"), "reason": i.get("platform_note")}
            for i in discovered
            if not i.get("applicable", True)
        ],
    }


# --------------------------------------------------------------------------- #
# 试运行
# --------------------------------------------------------------------------- #
@router.post("/{tool_id}/test")
async def test_tool(
    tool_id: str, payload: ToolTestRequest, session: AsyncSession = Depends(get_session)
) -> dict:
    """在服务端试跑一次工具，**按安全等级分层**：

    ==================  ==================================================
    ``http``            直接发请求
    ``builtin`` 只读    真跑，但路径参数强制限制在 workspace 内
    ``builtin`` 写/执行 **不跑**，返回结构化原因
                        （在 API 进程里执行 Bash/Write = 开放任意代码执行）
    ``code``            不跑，需沙箱（尚未实现）
    ==================  ==================================================

    平台不适用的工具（如 Linux 上的 PowerShell）直接说明不可用。
    """
    import time

    row = await session.get(Tool, tool_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"工具不存在: {tool_id}")

    if row.kind == "builtin":
        return await _test_builtin_tool(row, payload.args)

    if row.kind == "code":
        return {
            "ok": False,
            "skipped": True,
            "reason": "代码工具需要独立沙箱，暂未开放服务端试运行。",
        }

    if row.kind != "http":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"暂不支持测试的类型: {row.kind}")

    from ..runtimes.agentscope_rt.compile import build_http_tool

    started = int(time.time() * 1000)
    try:
        tool = build_http_tool(row)
        result = (
            await tool.call(**payload.args)
            if hasattr(tool, "call")
            else await tool(**payload.args)
        )
        text = str(result)
        return {
            "ok": True,
            "duration_ms": int(time.time() * 1000) - started,
            "result_preview": text[:2000],
            "result_size": len(text.encode("utf-8")),
        }
    except Exception as exc:
        return {
            "ok": False,
            "duration_ms": int(time.time() * 1000) - started,
            "error": f"{type(exc).__name__}: {exc}",
        }


# --------------------------------------------------------------------------- #
# 内置工具试运行（只读才真跑，且限制在 workspace 内）
# --------------------------------------------------------------------------- #
def _within(child: Path, parent: Path) -> bool:
    """``child`` 是否位于 ``parent`` 之内（含自身）。"""
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _guard_workspace_args(
    name: str, args: dict[str, Any], work_dir: str
) -> tuple[dict[str, Any], str | None]:
    """把只读工具的路径参数限制在 workspace 内，防止试运行变成任意文件读取。"""
    root = Path(work_dir).resolve()
    out: dict[str, Any] = dict(args or {})

    def _resolve(value: Any) -> Path:
        p = Path(str(value))
        return (p if p.is_absolute() else root / p).resolve()

    if name == "read":
        fp = out.get("file_path")
        if fp:
            target = _resolve(fp)
            if not _within(target, root):
                return out, f"出于安全考虑，试运行只能访问工作目录：{root}（请求 {target}）"
            out["file_path"] = str(target)
    elif name in ("glob", "grep"):
        for key in ("path", "directory", "root"):
            if out.get(key):
                target = _resolve(out[key])
                if not _within(target, root):
                    return out, f"出于安全考虑，试运行只能访问工作目录：{root}"
                out[key] = str(target)
    return out, None


def _chunk_to_text(chunk: Any) -> str:
    """从 AgentScope 的 ``ToolChunk`` 里抽出可读文本。"""
    if chunk is None:
        return ""
    for attr in ("text", "output", "result"):
        val = getattr(chunk, attr, None)
        if isinstance(val, str) and val:
            return val
    blocks = getattr(chunk, "content", None)
    if isinstance(blocks, list):
        parts: list[str] = []
        for b in blocks:
            if isinstance(b, dict):
                parts.append(str(b.get("text") or b.get("content") or ""))
            else:
                parts.append(str(getattr(b, "text", b)))
        joined = "\n".join(p for p in parts if p)
        if joined:
            return joined
    return str(chunk)[:4000]


async def _test_builtin_tool(row: Tool, args: dict[str, Any]) -> dict:
    """内置工具试运行。"""
    import inspect
    import time

    from .. import platform_env
    from ..config import settings
    from ..runtimes.agentscope_rt.compile import (
        BUILTIN_PLATFORMS,
        BUILTIN_SAFETY,
        build_builtin_tool,
    )

    flags = row.flags or {}
    name = row.name

    # ① 平台适用性（例如 Linux 上的 PowerShell）
    applicable, note = platform_env.check_platform(
        flags.get("platforms") or BUILTIN_PLATFORMS.get(name)
    )
    if not applicable:
        return {"ok": False, "applicable": False, "error": note}

    safety = BUILTIN_SAFETY.get(name, {})
    read_only = bool(flags.get("read_only", safety.get("read_only", False)))
    dangerous = bool(flags.get("dangerous", safety.get("dangerous", False)))

    # ② 写/执行类：不在服务端跑（安全红线）
    if dangerous or not read_only:
        return {
            "ok": True,
            "skipped": True,
            "kind": "builtin",
            "reason": (
                f"「{name}」属于写/执行类工具，默认不在服务端试运行 —— "
                "在 API 进程里执行它等于开放任意代码执行。"
                "请在 Agent「试跑与观测」中验证（由运行时在受控环境内调用）。"
            ),
            "args": args,
        }

    # ③ 只读类：真跑，但限制在 workspace 内
    guarded, guard_error = _guard_workspace_args(name, args, str(settings.work_dir))
    if guard_error:
        return {"ok": False, "error": guard_error}

    started = int(time.time() * 1000)
    try:
        tool = build_builtin_tool(name)
        call = getattr(tool, "call", None)
        if call is None:
            return {"ok": False, "error": f"该内置工具不支持直接调用: {name}"}

        sig = inspect.signature(call)
        required = [
            p.name
            for p in sig.parameters.values()
            if p.default is inspect.Parameter.empty and not p.name.startswith("_")
        ]
        missing = [r for r in required if r not in guarded]
        if missing:
            return {
                "ok": False,
                "error": f"缺少必填参数: {', '.join(missing)}",
                "required": required,
                "hint": f"参数签名 {sig}",
            }

        result = call(**guarded)
        if inspect.isawaitable(result):
            result = await result
        text = _chunk_to_text(result)
        return {
            "ok": True,
            "kind": "builtin",
            "duration_ms": int(time.time() * 1000) - started,
            "result_preview": text[:2000],
            "result_size": len(text.encode("utf-8")),
            "note": f"在受限工作目录内试运行：{settings.work_dir}",
        }
    except Exception as exc:
        return {
            "ok": False,
            "duration_ms": int(time.time() * 1000) - started,
            "error": f"{type(exc).__name__}: {exc}",
        }
