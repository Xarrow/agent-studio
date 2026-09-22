"""数据库连接配置：可切换持久化驱动（SQLite / MySQL / PostgreSQL）。

为什么配置落在**本地文件**而不是数据库
--------------------------------------
"该连哪个数据库"这件事本身是**连接之前**就必须知道的。存进数据库会变成
"要先连上库，才能知道该连哪个库"的死循环。所以配置放项目本地的
``data/database.json``（该文件不进 git —— 里面是本机连接信息）。

密码处理
--------
落盘时用 Fernet 加密（复用 ``security.crypto``，与 LLM 密钥同一套主密钥），
明文永不写文件；返回给前端时一律打码。

启动回退
--------
配置的库连不上时**自动回退 SQLite** 并在日志里告警 —— 宁可退化到本地库，
也不要因为一个填错的地址让整个服务起不来。
"""

from __future__ import annotations

import base64
import json
import logging
import os
import shutil
from dataclasses import asdict, dataclass, field
from pathlib import Path
from urllib.parse import quote_plus

from .config import PROJECT_ROOT
from .security.crypto import decrypt, encrypt

logger = logging.getLogger(__name__)

#: 支持的驱动（顺序即前端展示顺序）
DRIVERS: tuple[str, ...] = ("sqlite", "mysql", "postgresql")

#: 驱动的展示信息
DRIVER_LABEL: dict[str, str] = {
    "sqlite": "SQLite（本地文件，适合开发）",
    "mysql": "MySQL / MariaDB",
    "postgresql": "PostgreSQL",
}

#: 各驱动默认端口
DEFAULT_PORT: dict[str, int] = {"mysql": 3306, "postgresql": 5432}

#: 配置文件位置
CONFIG_PATH: Path = PROJECT_ROOT / "data" / "database.json"

#: SQLite 默认文件（与 config.py 的历史默认保持一致）
DEFAULT_SQLITE_PATH: Path = PROJECT_ROOT / "data" / "studio.db"


@dataclass
class DbSettings:
    """一份数据库连接配置。

    ``password`` 在内存里是明文（连接要用），只有落盘时才加密。
    """

    driver: str = "sqlite"
    #: SQLite 的文件路径（留空用默认 data/studio.db）
    sqlite_path: str = ""
    #: 网络数据库连接信息
    host: str = "127.0.0.1"
    port: int = 0
    user: str = ""
    password: str = ""
    database: str = ""
    #: MySQL 字符集
    charset: str = "utf8mb4"
    #: 是否启用 TLS（网络数据库可选）
    ssl: bool = False

    # ------------------------------------------------------------------ #
    # 校验
    # ------------------------------------------------------------------ #
    def validate(self) -> list[str]:
        """返回问题列表（空 = 没问题）。"""
        problems: list[str] = []
        if self.driver not in DRIVERS:
            problems.append(f"不支持的驱动: {self.driver}")
            return problems

        if self.driver == "sqlite":
            path = self.sqlite_path or str(DEFAULT_SQLITE_PATH)
            # SQLite 只需父目录可建
            try:
                Path(path).expanduser().parent.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                problems.append(f"SQLite 目录不可用: {exc}")
            return problems

        if not self.host.strip():
            problems.append("主机地址不能为空")
        if not self.user.strip():
            problems.append("用户名不能为空")
        if not self.database.strip():
            problems.append("数据库名不能为空")
        if self.port and not (1 <= self.port <= 65535):
            problems.append(f"端口超出范围: {self.port}")
        if self.driver == "mysql" and not self.charset.strip():
            problems.append("MySQL 字符集不能为空")
        return problems

    # ------------------------------------------------------------------ #
    # URL
    # ------------------------------------------------------------------ #
    def effective_port(self) -> int:
        return self.port or DEFAULT_PORT.get(self.driver, 0)

    def sqlite_file(self) -> Path:
        return Path(self.sqlite_path).expanduser() if self.sqlite_path else DEFAULT_SQLITE_PATH

    def server_url(self, *, with_database: bool = True) -> str:
        """SQLAlchemy 异步 URL。

        ``with_database=False`` 时连到"服务器"而不是某个库 —— 用于
        "目标库还不存在就自动建"这个场景。
        """
        if self.driver == "sqlite":
            return f"sqlite+aiosqlite:///{self.sqlite_file()}"

        pwd = quote_plus(self.password)
        auth = f"{quote_plus(self.user)}:{pwd}@" if self.user else ""
        port = self.effective_port()

        if self.driver == "mysql":
            base = f"mysql+aiomysql://{auth}{self.host}:{port}"
            if with_database and self.database:
                base += f"/{quote_plus(self.database)}"
            q = f"?charset={self.charset}"
            if self.ssl:
                q += "&ssl=true"
            return base + q

        if self.driver == "postgresql":
            # 用 asyncpg 而不是 psycopg：psycopg 的纯 Python 实现要系统装 libpq，
            # 带二进制的 psycopg-binary 又没有 cp313 的预编译包。asyncpg 自己实现
            # 了 PG 协议，零系统依赖。
            #
            # 注意：asyncpg 不认 libpq 那套查询参数（`?sslmode=require` 会直接报错），
            # TLS 必须通过 connect_args 传 —— 见 db.build_engine。
            # 另外 asyncpg 必须指定库名，所以"连服务器"时落到默认的 postgres 库。
            db = self.database if (with_database and self.database) else "postgres"
            return f"postgresql+asyncpg://{auth}{self.host}:{port}/{quote_plus(db)}"

        raise ValueError(f"不支持的驱动: {self.driver}")

    def url(self) -> str:
        return self.server_url(with_database=True)

    # ------------------------------------------------------------------ #
    # 展示（给前端 —— 密码打码）
    # ------------------------------------------------------------------ #
    def display(self) -> dict:
        d = asdict(self)
        d["password"] = "••••••••" if self.password else ""
        d["has_password"] = bool(self.password)
        d["effective_port"] = self.effective_port()
        d["driver_label"] = DRIVER_LABEL.get(self.driver, self.driver)
        d["sqlite_file"] = str(self.sqlite_file()) if self.driver == "sqlite" else ""
        return d

    def describe(self) -> str:
        """一句话描述（日志用，不含密码）。"""
        if self.driver == "sqlite":
            return f"SQLite @ {self.sqlite_file()}"
        return f"{self.driver} @ {self.host}:{self.effective_port()}/{self.database}"


# --------------------------------------------------------------------------- #
# 读写
# --------------------------------------------------------------------------- #
def _encrypt_password(plain: str) -> str:
    if not plain:
        return ""
    return base64.b64encode(encrypt(plain)).decode("ascii")


def _decrypt_password(token: str) -> str:
    if not token:
        return ""
    try:
        return decrypt(base64.b64decode(token.encode("ascii")))
    except Exception as exc:  # noqa: BLE001 —— 主密钥变了就解不开，降级为空
        logger.warning("数据库密码解密失败（主密钥是否变更？）: %s", exc)
        return ""


def load() -> DbSettings:
    """读配置。文件不存在/损坏时返回默认（SQLite）。

    ``STUDIO_DB_PATH`` 环境变量**优先级最高**，用于临时覆盖（测试、一次性
    实例）。这一点很关键：测试套件就是靠它把数据写到临时目录的 ——
    如果这里是"只看配置文件"，测试就会连上并写坏真实数据库。
    """
    override_path = os.environ.get("STUDIO_DB_PATH", "").strip()

    if not CONFIG_PATH.exists():
        settings = DbSettings()
    else:
        try:
            raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("数据库配置读取失败，回退 SQLite: %s", exc)
            raw = {}

        known = {f for f in DbSettings.__dataclass_fields__}
        kwargs = {k: v for k, v in raw.items() if k in known and k != "password"}
        settings = DbSettings(**kwargs)
        settings.password = _decrypt_password(str(raw.get("password_enc") or ""))
        if settings.driver not in DRIVERS:
            logger.warning("配置里的驱动 %r 不认识，回退 SQLite", settings.driver)
            settings.driver = "sqlite"

    # 环境变量覆盖：等价于"这个进程临时改用另一个 SQLite 文件"
    if override_path:
        settings.driver = "sqlite"
        settings.sqlite_path = override_path

    return settings


def save(settings: DbSettings, *, backup: bool = True) -> Path:
    """原子写配置（先写临时文件再替换，避免写一半断电留下坏文件）。"""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)

    if backup and CONFIG_PATH.exists():
        stamp = __import__("time").strftime("%Y%m%d-%H%M%S")
        try:
            shutil.copy2(CONFIG_PATH, CONFIG_PATH.with_suffix(f".json.bak-{stamp}"))
        except OSError:  # pragma: no cover
            pass

    payload = asdict(settings)
    payload.pop("password", None)
    payload["password_enc"] = _encrypt_password(settings.password)

    tmp = CONFIG_PATH.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    tmp.replace(CONFIG_PATH)
    return CONFIG_PATH


def current() -> DbSettings:
    """进程当前生效的配置（模块加载时读一次，之后由 API 显式刷新）。"""
    global _current
    if _current is None:
        _current = load()
    return _current


def set_current(settings: DbSettings) -> None:
    global _current
    _current = settings


_current: DbSettings | None = None
