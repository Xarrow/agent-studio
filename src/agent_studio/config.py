"""全局配置。

所有配置可用 ``STUDIO_`` 前缀的环境变量覆盖，例如 ``STUDIO_DB_PATH=/tmp/x.db``。
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="STUDIO_", env_file=".env", extra="ignore")

    # 数据
    db_path: Path = PROJECT_ROOT / "data" / "studio.db"

    # 工作目录：Skill 物化、代码工具临时文件都放这里
    work_dir: Path = PROJECT_ROOT / "data" / "work"

    # API
    host: str = "0.0.0.0"
    port: int = 8848
    cors_origins: list[str] = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://192.168.2.11:3000",   # 内网访问（前端跑在 HPC .11）
    ]

    # 运行约束
    default_timeout_s: int = 300
    max_tool_output_bytes: int = 64 * 1024        # 工具结果截断上限
    llm_payload_limit_bytes: int = 256 * 1024     # LLM 请求/响应入库上限（超出截断）
    stream_flush_interval_ms: int = 100           # SSE 批量推送间隔

    # 对外 API（OpenAI 兼容 /v1/*）的鉴权
    # 留空 = 不校验（默认，保持内网无认证的现状）；设了值就必须带 Bearer
    api_key: str = ""
    #: 对外暴露的 API 前缀（客户端 base_url 用）
    public_base_url: str = ""

    @property
    def db_url(self) -> str:
        return f"sqlite+aiosqlite:///{self.db_path}"


settings = Settings()
