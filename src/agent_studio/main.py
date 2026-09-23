"""Agent Studio —— FastAPI 入口。

启动：``uv run uvicorn agent_studio.main:app --reload --port 8848``
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .api import api_router
from .config import settings
from .db import init_db
from .runtimes import discover_runtimes, list_runtimes

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
)
logger = logging.getLogger("agent_studio")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await init_db()
    discover_runtimes()
    runtimes = [rt.name for rt in list_runtimes()]
    logger.info("Agent Studio 启动 | db=%s | runtimes=%s", settings.db_path, runtimes)
    yield
    logger.info("Agent Studio 关闭")


app = FastAPI(
    title="Agent Studio",
    description="可视化 Agent 配置与运行观测平台（运行时无关）",
    version=__version__,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# 访问来源日志 —— 让「有没有外人来访问」变成可查的事
# --------------------------------------------------------------------------- #
# 为什么需要它：
#   平台经 Cloudflare 隧道对外时，后端看到的 peer **永远是网关**（192.168.2.7），
#   日志里分不出真实来源 —— 想监控就没抓手。Cloudflare 会把真实客户端 IP 放在
#   ``CF-Connecting-IP`` 头里，这里把它记下来。
#
# 为什么不每条都记：
#   uvicorn 自带访问日志已经记了每一条请求，再全量记一遍只是刷屏。
#   这里只记**真正需要看的**：经隧道进来的（= 来自公网）和命中敏感路径的。
#   想安静地盯，就 `journalctl -u agent-studio-api -f | grep ACCESS`。
#
# 隧道对端（= cloudflared 所在机器）。多台/换机可用环境变量覆盖。
TUNNEL_PEERS = {
    p.strip()
    for p in os.getenv("STUDIO_TUNNEL_PEERS", "192.168.2.7").split(",")
    if p.strip()
}

#: 命中这些后缀的路径视为敏感（会打标记，便于 grep）
SENSITIVE_SUFFIXES = ("/key",)


@app.middleware("http")
async def access_log(request: Request, call_next):
    peer = request.client.host if request.client else "-"
    src = request.headers.get("cf-connecting-ip") or peer
    path = request.url.path
    via_tunnel = peer in TUNNEL_PEERS

    flags: list[str] = []
    if via_tunnel:
        flags.append("公网来源")
    if path.endswith(SENSITIVE_SUFFIXES):
        flags.append("读明文密钥")

    def emit(status: int | str, extra: str = "") -> None:
        # 只记「公网来源」或「敏感路径」，避免和 uvicorn 日志重复刷屏
        if not (via_tunnel or flags):
            return
        logger.info(
            "ACCESS src=%s via=%s %s %s -> %s%s%s",
            src,
            peer,
            request.method,
            path,
            status,
            ("  [" + " ".join(flags) + "]") if flags else "",
            extra,
        )

    try:
        response = await call_next(request)
    except Exception as exc:  # noqa: BLE001
        emit("500", f"  {type(exc).__name__}: {exc}")
        raise
    emit(response.status_code)
    return response


app.include_router(api_router)


@app.get("/api/health")
async def health() -> dict:
    return {
        "status": "ok",
        "version": __version__,
        "db": str(settings.db_path),
        "runtimes": [rt.name for rt in list_runtimes()],
    }
