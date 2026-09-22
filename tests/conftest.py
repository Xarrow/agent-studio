"""pytest 全局配置。

关键：**在 import agent_studio 之前**改写环境变量，让配置单例指向临时
数据库与工作目录，避免污染真实数据。
"""

from __future__ import annotations

import os
import tempfile

_TMP = tempfile.mkdtemp(prefix="agent-studio-test-")
os.environ["STUDIO_DB_PATH"] = os.path.join(_TMP, "test.db")
os.environ["STUDIO_WORK_DIR"] = os.path.join(_TMP, "work")
os.environ["STUDIO_MASTER_KEY"] = "test-master-key"

import pytest  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

from agent_studio.db import init_db  # noqa: E402
from agent_studio.main import app  # noqa: E402


@pytest.fixture(scope="session")
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def client():
    """异步 HTTP 客户端（直连 ASGI，无需起服务）。"""
    await init_db()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture
def tmp_workdir() -> str:
    return tempfile.mkdtemp(prefix="agent-studio-work-")
