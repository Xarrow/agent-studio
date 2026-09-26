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
        # 走 Cloudflare 隧道的外网访问：页面在 dev.zeit.ccwu.cc、API 在
        # dev-api.zeit.ccwu.cc，两者不同源，必须显式放行。
        # （同源代理方案不需要这条，但那样 SSE 要过一层代理，直连更稳。）
        "https://dev.zeit.ccwu.cc",
    ]

    # 运行约束
    default_timeout_s: int = 300

    # ── LLM 客户端（httpx）网络超时 ──────────────────────────────────────
    # 为什么必须显式设：不设时用的是 openai SDK 默认 **connect=5s** ✗
    # 跨境线路（家宽 → 方舟/DeepSeek）一次 TLS 握手超 5s 很常见 ✓
    # 而 SDK 还会自己重试 + AgentScope 再包一层 → 一次抖动放大成 60~70s 的"零字节"，
    # 最终报 APITimeoutError（现场：4 轮调用里第 4 轮 68.6s 后失败 ✓）
    llm_connect_timeout_s: float = 20.0
    #: 读到第一个字节之后，两次数据之间的最长等待（流式；给足，别掐断长思考 ✓）
    llm_read_timeout_s: float = 600.0
    #: SDK 自身重试次数。**建议 0** ✓ —— 平台层已有"上游抖动自动重试"（gate.is_transient）
    #  两层都重试会成倍放大等待 ✗ 交给平台那一层就够 ✓
    llm_sdk_retries: int = 0
    #: **同时最多跑几个执行**（并发闸）。0 = 不限制。
    #: 为什么要有它：画布同层节点并发 + 多条流程 + 定时触发会一起打在同一个 key 上，
    #: 没有闸就容易自己把自己限流（用户看到的却是"这一步失败"）。
    max_concurrent_runs: int = 4
    #: 执行遇到**临时性错误**（429 / 5xx / 连接断 / provider 侧读超时）最多再试几次
    run_retry_max: int = 2
    #: 重试退避基数（秒）：1.5 → 3 → 6（封顶 30）
    run_retry_backoff_s: float = 1.5
    #: 排队最多等多久（秒）；超时则明确失败并说明"排队太久"。0 = 一直等
    run_gate_wait_s: float = 300.0
    #: 服务重启后，把重启前**没跑完**的单步执行重新排队跑起来（编排内的执行不续跑，见 dispatcher）
    resume_runs_after_restart: bool = True
    #: 一条执行最多被续跑几次（反复重启不该变成无限重跑）
    run_max_resume: int = 1
    #: 事件分层归档：最近多少天的执行保留**完整**事件（更早的只留骨架）
    event_keep_days: int = 7
    #: 归档时旧 payload 截断到多少字节（保留开头，能看出"这里被截过"）
    event_preview_bytes: int = 4096
    #: 是否允许自动归档（关掉就只有手动整理）
    event_compact_enabled: bool = True

    #: 数据库每日副本（并入调度循环；只留最近几份）
    db_backup_enabled: bool = True
    db_backup_interval_s: int = 24 * 3600
    #: 自动归档的最小间隔（秒）—— 并进已有的调度 tick，不新建脚本/cron
    event_compact_interval_s: int = 3600
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
