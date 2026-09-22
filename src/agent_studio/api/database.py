"""环境配置路由：数据库驱动的查看、试连与切换。

设计原则
--------
**先验证，后保存**。切换流程是：

1. ``POST /api/database/test``    → 用**一次性引擎**试连（不碰全局状态）
2. 用户确认无误后 ``POST /api/database/switch``
3. 后端再探一次，**成功才写配置**；成功时顺手把目标库和表建出来
4. 触发服务重启，新配置在启动时生效

任何一步失败都**不改动现有配置** —— 当前能用比"切过去"重要。

为什么不动态换引擎
------------------
``SessionLocal`` 被各模块在 import 时就引用了（``from ..db import SessionLocal``），
运行时重新赋值只会让新代码用新引擎、旧引用仍指向旧的 —— 这种"一半新一半旧"
的状态比重启一次危险得多。重启是这里最诚实、最可靠的做法。
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
from typing import Any

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import create_async_engine

from .. import db, dbconfig
from ..config import settings
from ..dbconfig import DRIVER_LABEL, DRIVERS, DbSettings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/database", tags=["database"])

#: 重启前的等待（秒）—— 让 HTTP 响应先回到前端
RESTART_DELAY_S = 1.5

#: 本服务的 systemd 单元名（用于切换后重启）
SERVICE_UNIT = "agent-studio-api"


# --------------------------------------------------------------------------- #
# 读取
# --------------------------------------------------------------------------- #
async def _table_count(cfg: DbSettings) -> tuple[list[str], str | None]:
    """用一次性引擎列个表名（连不上就返回错误文本）。"""
    try:
        eng = db.build_engine(cfg)
        async with eng.connect() as conn:
            names = await conn.run_sync(lambda c: inspect(c).get_table_names())
        await eng.dispose()
        return sorted(names), None
    except Exception as exc:  # noqa: BLE001
        return [], f"{type(exc).__name__}: {exc}"


def _runtime_info() -> dict[str, Any]:
    """当前进程实际在用的引擎信息（与配置文件可能不同 —— 比如刚回退过）。"""
    return {
        "driver": db._active.driver,
        "describe": db._active.describe(),
        "url_masked": _mask_url(db._active.url()),
        "sqlite_file": str(db._active.sqlite_file()) if db._active.driver == "sqlite" else "",
    }


def _mask_url(url: str) -> str:
    """把 URL 里的密码打码（展示用）。"""
    import re

    return re.sub(r"://([^:/@]+):([^@]+)@", r"://\1:••••@", url)


@router.get("")
async def get_database() -> dict[str, Any]:
    """当前配置 + 运行态 + 表清单。"""
    cfg = dbconfig.current()
    tables, err = await _table_count(cfg)
    file_based = cfg.driver == "sqlite"
    return {
        "config": cfg.display(),
        "runtime": _runtime_info(),
        "tables": tables,
        "table_count": len(tables),
        # 配置文件里写的驱动 与 进程实际用的驱动 不一致时，说明改了还没重启
        "pending_restart": cfg.driver != db._active.driver,
        "reachable": err is None,
        "error": err,
        "config_path": str(dbconfig.CONFIG_PATH),
        "file_based": file_based,
    }


@router.get("/drivers")
async def list_drivers() -> dict[str, Any]:
    """支持的驱动 + 各自需要的字段（前端据此渲染表单）。"""
    return {
        "drivers": [
            {
                "key": "sqlite",
                "label": DRIVER_LABEL["sqlite"],
                "hint": "一个文件就是整个库，零配置。适合本地开发和单机部署。",
                "fields": ["sqlite_path"],
                "default_port": 0,
            },
            {
                "key": "mysql",
                "label": DRIVER_LABEL["mysql"],
                "hint": "适合已有 MySQL/MariaDB 的场景。库不存在会自动创建。",
                "fields": ["host", "port", "user", "password", "database", "charset", "ssl"],
                "default_port": 3306,
            },
            {
                "key": "postgresql",
                "label": DRIVER_LABEL["postgresql"],
                "hint": "适合已有 PostgreSQL 的场景。库不存在会自动创建。",
                "fields": ["host", "port", "user", "password", "database", "ssl"],
                "default_port": 5432,
            },
        ],
        "current": dbconfig.current().driver,
    }


# --------------------------------------------------------------------------- #
# 试连
# --------------------------------------------------------------------------- #
def _from_payload(payload: dict[str, Any]) -> DbSettings:
    """把前端传来的字段拼成配置对象；密码留空表示"沿用已保存的"。"""
    cur = dbconfig.current()
    driver = str(payload.get("driver") or "sqlite")

    pwd = payload.get("password")
    if pwd is None or pwd == "":
        # 前端没填密码（或只改了别的字段）→ 沿用当前配置里的
        pwd = cur.password

    def _int(v: Any, default: int) -> int:
        try:
            return int(v) if v not in (None, "") else default
        except (TypeError, ValueError):
            return default

    return DbSettings(
        driver=driver,
        sqlite_path=str(payload.get("sqlite_path") or ""),
        host=str(payload.get("host") or "").strip(),
        port=_int(payload.get("port"), 0),
        user=str(payload.get("user") or "").strip(),
        password=str(pwd or ""),
        database=str(payload.get("database") or "").strip(),
        charset=str(payload.get("charset") or "utf8mb4").strip(),
        ssl=bool(payload.get("ssl")),
    )


@router.post("/test")
async def test_connection(payload: dict[str, Any]) -> dict[str, Any]:
    """试连（不保存、不改状态）。

    ``create_database=false`` 时纯探测，不动对方服务器上的任何东西。
    """
    cfg = _from_payload(payload)
    problems = cfg.validate()
    if problems:
        return {"ok": False, "stage": "validate", "problems": problems, "error": None}

    create = bool(payload.get("create_database", True))
    result = await db.probe(cfg, create_database=create)
    return {
        "ok": result["ok"],
        "stage": "connect" if not result["ok"] else "done",
        "problems": [],
        "target": cfg.describe(),
        "database_exists": result["database_exists"],
        "created_database": result["created_database"],
        "tables": result["tables"],
        "table_count": len(result["tables"]),
        "server_version": result["server_version"],
        "error": result["error"],
    }


# --------------------------------------------------------------------------- #
# 切换
# --------------------------------------------------------------------------- #
def _restart_service() -> bool:
    """让 systemd 稍后重启本服务（脱离当前进程，避免自杀式重启）。

    非 systemd 环境（比如直接 ``uv run uvicorn``）返回 False，前端会提示
    手动重启。
    """
    if not shutil.which("systemctl"):
        return False
    try:
        # setsid + 延迟：先让 HTTP 响应发出去，再重启
        subprocess.Popen(  # noqa: S603
            ["bash", "-c", f"sleep {RESTART_DELAY_S}; systemctl restart {SERVICE_UNIT}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,      # 脱离父进程组，不会随本进程一起被杀
            cwd=os.path.sep,
        )
        return True
    except OSError:  # pragma: no cover
        logger.exception("触发服务重启失败")
        return False


@router.post("/switch")
async def switch_database(payload: dict[str, Any]) -> dict[str, Any]:
    """保存并切换：**先确认新配置真的能用，才写文件**。"""
    cfg = _from_payload(payload)
    problems = cfg.validate()
    if problems:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "; ".join(problems))

    # ① 探测：连得上 + 库存在（不存在就建）+ 表建得出来
    result = await db.probe(cfg, create_database=True)
    if not result["ok"]:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"新配置连不上或建表失败，**已保持原配置不变**：{result['error']}",
        )

    # ② 落盘（写失败也不影响正在跑的进程）
    try:
        dbconfig.save(cfg)
    except OSError as exc:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, f"配置写入失败: {exc}"
        ) from exc
    dbconfig.set_current(cfg)

    # ③ 重启生效
    restarted = _restart_service()
    return {
        "ok": True,
        "target": cfg.describe(),
        "driver": cfg.driver,
        "tables": result["tables"],
        "table_count": len(result["tables"]),
        "created_database": result["created_database"],
        "server_version": result["server_version"],
        "restarting": restarted,
        "config_path": str(dbconfig.CONFIG_PATH),
        "note": (
            "服务正在重启，几秒后新配置生效（页面会自动恢复）。"
            if restarted
            else "配置已保存。当前不是 systemd 托管，请手动重启服务后生效。"
        ),
    }


@router.get("/health")
async def health_after_switch() -> dict[str, Any]:
    """切换后前端轮询这个接口，确认新配置的服务已经起来。"""
    return {
        "ok": True,
        "driver": db._active.driver,
        "describe": db._active.describe(),
        "version": settings.public_base_url or "",
    }
