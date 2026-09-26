"""数据库引擎与会话管理（SQLite / MySQL / PostgreSQL 可切换）。

设计要点
--------
1. **驱动来自 ``dbconfig``**（本地配置文件），不再是写死的 SQLite 路径。
2. **SQLite 专属的 PRAGMA 只在 SQLite 下挂载** —— 这些语句 MySQL/PG 不认，
   无条件执行会让"切到 MySQL"直接连不上。
3. **补列改为方言无关** —— 原来用 ``PRAGMA table_info``（SQLite 专用），
   现在走 SQLAlchemy 的 ``inspect``，三种库都能用。
4. **启动失败自动回退 SQLite**：把配置改回 SQLite 再抛错，systemd 重启后
   服务能正常起来 —— 宁可退回本地库，也不要因为填错一个地址就整个起不来。
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator

from sqlalchemy import event, inspect
from sqlalchemy.pool import NullPool
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from . import dbconfig

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    """所有 ORM 模型的基类。"""


# --------------------------------------------------------------------------- #
# 引擎构造
# --------------------------------------------------------------------------- #
def _attach_sqlite_pragmas(engine: AsyncEngine) -> None:
    """SQLite 的读写并发优化（**只在 SQLite 下挂**）。

    WAL：读写不互斥；busy_timeout：瞬时锁冲突不直接报错。
    """

    @event.listens_for(engine.sync_engine, "connect")
    def _set_sqlite_pragma(dbapi_conn, _record) -> None:  # pragma: no cover - 驱动层回调
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.close()


def build_engine(cfg: dbconfig.DbSettings) -> AsyncEngine:
    """按配置造一个异步引擎。"""
    # asyncpg 的 TLS 必须走 connect_args（它不认 `?sslmode=` 这类 libpq 参数）
    connect_args: dict = {}
    if cfg.driver == "postgresql" and cfg.ssl:
        connect_args["ssl"] = True

    engine = create_async_engine(
        cfg.url(),
        echo=False,
        future=True,
        connect_args=connect_args,
        # 网络库的连接可能被中间设备掐断，取连接前先探活
        pool_pre_ping=cfg.driver != "sqlite",
        # 网络库给个连接池上限，避免把对方连接数打满
        **({} if cfg.driver == "sqlite" else {"pool_size": 5, "max_overflow": 10}),
        # SQLite：**不池化**（NullPool）。
        # 本地文件库建一条连接只要几十微秒，池化的收益极小；而"池 + aiosqlite"会带来
        # "连接被垃圾回收时仍在使用"那一类噪音 —— 实测日志里出现过
        #   sqlalchemy "Exception terminating connection" +
        #   asyncio "Task was destroyed but it is pending"
        # （早于任何外部改库，属既有抖动）。NullPool 让每个会话用一条新连接，
        # 这类问题从根上消失；pragma / WAL 逻辑不受影响（下面照旧 attach）。
        poolclass=NullPool if cfg.driver == "sqlite" else None,
    )
    if cfg.driver == "sqlite":
        _attach_sqlite_pragmas(engine)
    return engine


_active: dbconfig.DbSettings = dbconfig.current()
engine: AsyncEngine = build_engine(_active)

SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI 依赖：每请求一个会话。

    客户端在请求中途断开时（切换页面、关掉标签、请求超时被取消），
    这个 async generator 会被 athrow 掉 —— 此刻底层连接可能已经释放，
    直接退出会抛 "no active connection"，再被 asyncio 记成
    "Task exception was never retrieved"，在日志里刷出一片吓人的红
    （实测：一个被取消的请求留下 21 行 traceback，而**没有任何请求失败**）。

    所以这里显式收尾：正常返回也好、被取消也好，都关掉会话，
    且**不让取消路径上的异常外泄** —— 取消是客户端的正常行为，服务端不该留痕迹。
    """
    session = SessionLocal()
    try:
        yield session
    finally:
        try:
            await session.close()
        except Exception:  # noqa: BLE001 — 收尾阶段的异常不影响任何请求结果
            pass


# --------------------------------------------------------------------------- #
# 建表
# --------------------------------------------------------------------------- #
async def init_db() -> None:
    """建表（幂等）+ 补列。

    连不上配置里的库时：**把配置回退成 SQLite 并抛错** —— 进程重启后会以
    SQLite 正常启动，用户还有机会在界面上改正连接信息。
    """
    global engine, SessionLocal, _active

    from . import models  # noqa: F401  确保模型已注册到 Base.metadata

    _active.sqlite_file().parent.mkdir(parents=True, exist_ok=True)

    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await _ensure_columns(conn)
        logger.info("数据库就绪：%s", _active.describe())
        return
    except Exception as exc:  # noqa: BLE001 —— 任何连接/建表失败都要兜住
        if _active.driver == "sqlite":
            raise            # 本地库都建不起来就没救了，直接暴露错误
        logger.error(
            "连接 %s 失败（%s: %s），自动回退 SQLite",
            _active.describe(), type(exc).__name__, exc,
        )

    # ── 回退：配置改回 SQLite，重建引擎，再建表 ──────────────────────
    fallback = dbconfig.DbSettings(driver="sqlite")
    try:
        dbconfig.save(fallback)
    except OSError:  # pragma: no cover
        logger.exception("回退配置写入失败")

    try:
        await engine.dispose()
    except Exception:  # pragma: no cover  # noqa: BLE001
        pass

    dbconfig.set_current(fallback)
    _active = fallback
    engine = build_engine(fallback)
    SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    fallback.sqlite_file().parent.mkdir(parents=True, exist_ok=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _ensure_columns(conn)
    logger.warning("已回退到 SQLite：%s", fallback.sqlite_file())


# --------------------------------------------------------------------------- #
# 极简补列（方言无关）
#
# ``create_all`` 只建表、**不改表** —— 给已有表加字段必须显式 ALTER，
# 否则旧库会出现"模型里有列、库里没有"的运行时错误。
# 这里只做「加列」这一种最安全的迁移；改类型/删列需要重建表，不在此处理。
# --------------------------------------------------------------------------- #
#: (表名, 列名, 列 DDL)
_ADDED_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("run", "session_id", "session_id VARCHAR(32)"),
    ("run", "turn_index", "turn_index INTEGER"),
    # 编排（Playground）：三列都可空，NULL = 独立执行，既有数据不受影响
    ("run", "orchestration_id", "orchestration_id VARCHAR(32)"),
    ("run", "orch_role", "orch_role VARCHAR(16)"),
    ("run", "order_index", "order_index INTEGER"),
    # 执行来源（决定它在「运行记录」里归到哪一类）：chat / preview / playground
    ("run", "origin", "origin VARCHAR(16)"),
    # 中途暂停时的运行时状态快照（JSON，不透明）—— 人工确认后据此继续
    ("run", "pending_state", "pending_state JSON"),
    # 这次编排源自哪份设计稿（NULL = 临时摆的）—— 「运行记录」据此回链到 workflow
    ("orchestration", "workflow_id", "workflow_id VARCHAR(32)"),
    # 事件分层归档标记（NULL = 未归档）—— 幂等的关键
    ("run", "events_archived_at", "events_archived_at BIGINT"),
    # 分派（fan-out）：节点维度 + 第几路 + 那一路的名字 + 父执行
    ("run", "node_id", "node_id VARCHAR(32)"),
    ("run", "item_index", "item_index INTEGER"),
    ("run", "item_label", "item_label VARCHAR(120)"),
    ("run", "parent_run_id", "parent_run_id VARCHAR(32)"),
    # 凭据的默认模型（LLM 配置页可探测后选择 / 手动填写）
    ("secret", "default_model", "default_model VARCHAR(128)"),
    # 自动运行（无人值守）：默认任务 + 定时三件套 + 排期与外部触发凭证
    ("workflow", "default_task", "default_task TEXT"),
    ("workflow", "schedule_mode", "schedule_mode VARCHAR(16)"),
    ("workflow", "schedule_at", "schedule_at VARCHAR(8)"),
    ("workflow", "schedule_weekdays", "schedule_weekdays VARCHAR(16)"),
    ("workflow", "next_run_at", "next_run_at BIGINT"),
    ("workflow", "last_run_at", "last_run_at BIGINT"),
    ("workflow", "last_run_source", "last_run_source VARCHAR(16)"),
    ("workflow", "trigger_token", "trigger_token VARCHAR(64)"),
)


async def _ensure_columns(conn) -> None:  # pragma: no cover - 启动期执行
    """给已有表补列。

    用 SQLAlchemy 的 ``inspect`` 取代原先 SQLite 专用的 ``PRAGMA table_info``，
    这样 SQLite / MySQL / PostgreSQL 三种库都能安全跑同一段逻辑。
    """

    def _columns_of(sync_conn, table: str) -> set[str]:
        try:
            insp = inspect(sync_conn)
            if not insp.has_table(table):
                return set()
            return {c["name"] for c in insp.get_columns(table)}
        except Exception:  # noqa: BLE001 —— 表还不存在等情形
            return set()

    for table, column, ddl in _ADDED_COLUMNS:
        existing = await conn.run_sync(_columns_of, table)
        if existing and column not in existing:
            await conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {ddl}")


async def drop_all() -> None:
    """仅供测试使用。"""
    from . import models  # noqa: F401

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


# --------------------------------------------------------------------------- #
# 运行时探测（环境配置页要用）
# --------------------------------------------------------------------------- #
async def probe(cfg: dbconfig.DbSettings, *, create_database: bool = True) -> dict:
    """试连一个配置：能否连上、目标库是否存在、表有多少。

    不碰全局 engine —— 用一个一次性引擎，测完就销毁。
    ``create_database=True`` 时，库不存在就顺手建出来（这样"切换即用"才成立）。
    """
    from sqlalchemy import text

    result: dict = {"ok": False, "database_exists": None, "created_database": False,
                    "tables": [], "error": None, "server_version": None}

    if cfg.driver == "sqlite":
        # 本地文件没有"库不存在"的问题，直接建表探一下
        try:
            eng = build_engine(cfg)
            cfg.sqlite_file().parent.mkdir(parents=True, exist_ok=True)
            async with eng.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
                names = await conn.run_sync(lambda c: inspect(c).get_table_names())
            await eng.dispose()
            result.update(ok=True, database_exists=True, tables=sorted(names))
        except Exception as exc:  # noqa: BLE001
            result["error"] = f"{type(exc).__name__}: {exc}"
        return result
    # ── 网络数据库：先连"服务器"（不带库名），确认能通 ──────────────
    try:
        from sqlalchemy import text

        server = create_async_engine(cfg.server_url(with_database=False), future=True)
        # CREATE DATABASE 不能在事务块里执行（PostgreSQL 限制），所以这条连接
        # 显式用 AUTOCOMMIT —— 顺带也让 MySQL 的 DDL 行为更直白。
        async with server.connect() as conn:
            conn = await conn.execution_options(isolation_level="AUTOCOMMIT")

            ver = (await conn.exec_driver_sql("SELECT version()")).scalar()
            result["server_version"] = str(ver)[:120] if ver else None

            # 库是否存在。
            # 注意用 ``text()`` 而不是 ``exec_driver_sql`` —— 后者把参数原样丢给
            # 驱动，不做事先的参数风格转换（asyncpg 要 $1、pymysql 要 %s），
            # 写死的 ``:n`` 会被 asyncpg 当成 SQL 语法错误。
            if cfg.driver == "mysql":
                q = text("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = :n")
            else:
                q = text("SELECT datname FROM pg_database WHERE datname = :n")
            exists = (await conn.execute(q, {"n": cfg.database})).scalar() is not None
            result["database_exists"] = exists

            if not exists and create_database:
                # 库名不能参数化（DDL 限制），这里做白名单校验后拼接
                name = cfg.database.strip()
                if not name.replace("_", "").replace("-", "").isalnum():
                    raise ValueError(f"库名含不安全字符，拒绝自动创建: {name!r}")
                charset = f" CHARACTER SET {cfg.charset}" if cfg.driver == "mysql" else ""
                await conn.exec_driver_sql(f'CREATE DATABASE `{name}`{charset}' if cfg.driver == "mysql"
                                           else f'CREATE DATABASE "{name}"')
                result["created_database"] = True
                result["database_exists"] = True
        await server.dispose()
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"{type(exc).__name__}: {exc}"
        return result

    # ── 再连目标库，建表 ─────────────────────────────────────────────
    try:
        eng = build_engine(cfg)
        async with eng.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            names = await conn.run_sync(lambda c: inspect(c).get_table_names())
        await eng.dispose()
        result.update(ok=True, tables=sorted(names))
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"{type(exc).__name__}: {exc}"

    return result
