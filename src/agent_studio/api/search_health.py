"""搜索通道健康：系统设置页的「内置搜索」卡片读它。"""

from __future__ import annotations

from fastapi import APIRouter

from .. import search_health

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("/health")
async def get_search_health() -> dict:
    """只读上次自检结果，不发网络请求（页面加载不该顺带敲别人家的门）。"""
    return await search_health.state()


@router.post("/health/check")
async def run_search_health_check() -> dict:
    """立刻自检一次（用户点「立即检测」）。"""
    return await search_health.check(force=True)
