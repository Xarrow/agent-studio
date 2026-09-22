"""数据库引擎与会话管理（SQLite + WAL）。"""

from collections.abc import AsyncIterator

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import settings


class Base(DeclarativeBase):
    """所有 ORM 模型的基类。"""


engine = create_async_engine(settings.db_url, echo=False, future=True)


@event.listens_for(engine.sync_engine, "connect")
def _set_sqlite_pragma(dbapi_conn, _record) -> None:  # pragma: no cover - 驱动层回调
    """WAL 模式：读写并发不互斥；busy_timeout 避免瞬时锁冲突直接报错。"""
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA busy_timeout=5000")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.close()


SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI 依赖：每请求一个会话。"""
    async with SessionLocal() as session:
        yield session


async def init_db() -> None:
    """建表（幂等）+ 补列。"""
    from . import models  # noqa: F401  确保模型已注册到 Base.metadata

    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    settings.work_dir.mkdir(parents=True, exist_ok=True)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _ensure_columns(conn)


# --------------------------------------------------------------------------- #
# 极简补列
#
# ``create_all`` 只建表、**不改表** —— 给已有表新增字段必须显式 ALTER 才生效，
# 否则旧库会出现"模型里有列、数据库里没有"的运行时错误。
# 这里只做「加列」这一种最安全的迁移；改类型/删列需要重建表，不在此处理。
# --------------------------------------------------------------------------- #
#: (表名, 列名, 列 DDL)
_ADDED_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("run", "session_id", "session_id VARCHAR(32)"),
    ("run", "turn_index", "turn_index INTEGER"),
)


async def _ensure_columns(conn) -> None:  # pragma: no cover - 启动期执行
    for table, column, ddl in _ADDED_COLUMNS:
        rows = (await conn.exec_driver_sql(f"PRAGMA table_info({table})")).fetchall()
        if column not in {r[1] for r in rows}:
            await conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {ddl}")


async def drop_all() -> None:
    """仅供测试使用。"""
    from . import models  # noqa: F401

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
