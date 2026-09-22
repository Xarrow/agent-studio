"""护栏：测试必须跑在临时数据库上，绝不能写到真实库。

背景（为什么需要这个文件）
--------------------------
实现「环境配置」时，数据库地址的来源从环境变量改成了配置文件
（``data/database.json``），**顺手丢掉了对 ``STUDIO_DB_PATH`` 的响应**。
后果是 ``tests/conftest.py`` 的隔离失效 —— 测试直接连上并写坏了生产库：

  · 测试用 STUDIO_MASTER_KEY=test-master-key 加密的凭据写进真实库
  · 生产进程用默认主密钥解密 → ValueError → 接口 500
  · 500 又绕过 CORSMiddleware，浏览器把它误报成「CORS 错误」，
    排查方向被彻底带偏

这类事故**不该靠人记得**，所以在这里钉死。
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from agent_studio import dbconfig
from agent_studio.db import engine


def test_engine_points_at_temp_db() -> None:
    """引擎连的必须是临时目录里的库，不是项目 data/studio.db。"""
    url = str(engine.url)
    tmp = tempfile.gettempdir()

    assert tmp in url, f"测试库不在临时目录，测试会污染真实数据：{url}"
    assert str(dbconfig.DEFAULT_SQLITE_PATH) not in url, (
        f"测试竟然连上了项目默认库：{url}"
    )


def test_studio_db_path_env_is_honored() -> None:
    """``STUDIO_DB_PATH`` 必须能覆盖配置文件里的路径。

    这是测试隔离的**唯一**依靠：conftest 靠它把数据引到临时目录。
    如果这条断言挂了，说明配置加载逻辑又开始忽略环境变量了。
    """
    cfg = dbconfig.current()
    assert cfg.driver == "sqlite"
    assert cfg.sqlite_path, "STUDIO_DB_PATH 没被采纳（sqlite_path 为空）"

    actual = Path(cfg.sqlite_file()).resolve()
    assert str(actual).startswith(str(Path(tempfile.gettempdir()).resolve())), (
        f"临时覆盖没生效，落到了 {actual}"
    )


def test_master_key_override_active() -> None:
    """测试进程的主密钥必须是被覆盖过的，否则解密行为会跟生产混淆。"""
    import os

    env_key = os.environ.get("STUDIO_MASTER_KEY")
    assert env_key == "test-master-key", (
        f"测试主密钥未被覆盖（当前 {env_key!r}）—— 隔离前提不成立"
    )
