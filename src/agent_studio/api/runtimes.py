"""运行时资源路由：列表、能力声明、静态校验。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import platform_env
from ..db import get_session
from ..models import Tool
from ..runtimes import get_runtime, get_runtime_or_none, list_runtimes
from ..schemas import RuntimeRead, ValidateRequest, ValidateResponse

router = APIRouter(prefix="/api/runtimes", tags=["runtimes"])


@router.get("", response_model=list[RuntimeRead])
async def list_all_runtimes() -> list[RuntimeRead]:
    """所有已注册运行时。前端用这个渲染"运行时"下拉。"""
    out: list[RuntimeRead] = []
    for rt in list_runtimes():
        caps = rt.capabilities()
        out.append(RuntimeRead(**caps.model_dump()))
    return out


@router.get("/{name}/capabilities", response_model=RuntimeRead)
async def get_capabilities(name: str) -> RuntimeRead:
    """单个运行时的能力 + ``option_schema``（驱动前端动态表单）。"""
    rt = get_runtime_or_none(name)
    if rt is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"未知运行时: {name}")
    return RuntimeRead(**rt.capabilities().model_dump())


@router.get("/{name}/tools")
async def list_runtime_tools(name: str) -> list[dict]:
    """该运行时的内置工具（含平台适用性，供 UI 勾选/置灰）。"""
    rt = get_runtime_or_none(name)
    if rt is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"未知运行时: {name}")
    return await rt.discover_tools()


# --------------------------------------------------------------------------- #
# 平台层补充校验（需要查库，所以不放在运行时适配器里）
# --------------------------------------------------------------------------- #
async def _tool_platform_issues(
    definition: object, session: AsyncSession
) -> list[dict[str, object]]:
    """检查挂载的工具在当前平台上是否可用（例如 Linux 服务器上的 PowerShell）。

    这类判断依赖工具的 ``flags``（存在库里），而适配器的 ``validate`` 只能
    看到 ``ToolRef``（只有 id）—— 所以放在平台层做，符合分层原则。
    """
    refs = [t.ref for t in getattr(definition, "tools", []) if getattr(t, "enabled", True)]
    if not refs:
        return []
    rows = (await session.execute(select(Tool).where(Tool.id.in_(refs)))).scalars().all()
    issues: list[dict[str, object]] = []
    for row in rows:
        applicable, note = platform_env.check_platform((row.flags or {}).get("platforms"))
        if not applicable:
            issues.append(
                {
                    "level": "warning",
                    "field": f"tools.{row.name}",
                    "message": f"{note}，建议从该 Agent 移除",
                }
            )
    return issues


async def _validate(
    definition: object, session: AsyncSession
) -> ValidateResponse:
    """适配器校验 + 平台层补充校验。"""
    rt = get_runtime(getattr(definition, "runtime"))
    issues = list(await rt.validate(definition))  # type: ignore[arg-type]
    extra = await _tool_platform_issues(definition, session)
    payload = [i.model_dump() for i in issues] + extra
    return ValidateResponse(
        ok=not any(i["level"] == "error" for i in payload),
        issues=payload,  # type: ignore[arg-type]
    )


@router.post("/validate", response_model=ValidateResponse)
async def validate_with_declared_runtime(
    payload: ValidateRequest, session: AsyncSession = Depends(get_session)
) -> ValidateResponse:
    """用定义里声明的 runtime 校验（编辑器默认走这个）。"""
    return await _validate(payload.definition, session)


@router.post("/{name}/validate", response_model=ValidateResponse)
async def validate_definition(
    name: str, payload: ValidateRequest, session: AsyncSession = Depends(get_session)
) -> ValidateResponse:
    """指定运行时的校验。"""
    if get_runtime_or_none(name) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"未知运行时: {name}")
    return await _validate(payload.definition, session)
