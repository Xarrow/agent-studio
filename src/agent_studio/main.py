"""Agent Studio —— FastAPI 入口。

启动：``uv run uvicorn agent_studio.main:app --reload --port 8848``
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
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

app.include_router(api_router)


@app.get("/api/health")
async def health() -> dict:
    return {
        "status": "ok",
        "version": __version__,
        "db": str(settings.db_path),
        "runtimes": [rt.name for rt in list_runtimes()],
    }
