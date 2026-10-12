# Agent Studio · 开发包

解包后一条命令起来：后端 `:8848` + 前端热更新 `:3000`。

```bash
tar xzf agent-studio-dev-<日期>.tar.gz
cd agent-studio
./start.sh
```

然后浏览器打开 `http://<本机IP>:3000`（API 文档在 `http://<本机IP>:8848/docs`）。

## 这个包和部署包的区别

| | 开发包（本包） | 部署包 |
| --- | --- | --- |
| 用途 | 继续开发、改代码即时生效 | 拿去就跑，不改代码 |
| 内容 | 源码 + web 源码 + 锁文件 | 内置 CPython + 预展开依赖 + 编译好的 `web/out` |
| 依赖 | 需要目标机有 **uv** 和 **Node ≥ 20** | 零依赖（不需要 Node、不需要系统 Python、不需要联网） |
| 前端 | `next dev`（热更新） | 编译后的静态文件，由 FastAPI 同进程托管 |
| 启动 | `./start.sh` | `./start.sh` |

## 前置条件

- **uv**：`curl -LsSf https://astral.sh/uv/install.sh | sh`
- **Node ≥ 20**（推荐 22 或 24）：建议用 nvm 管理，避免用系统里那些老旧版本
- 首次启动会跑 `uv sync` 和 `npm install`（需要网络，之后就不用）

## 启动脚本做的事

1. 检查 uv / Node（不满足直接报错并给出安装命令）
2. `uv sync` 建 `.venv`；`npm install` 装前端依赖（已存在则跳过）
3. 生成 `web/.env.local`，把前端指向本机后端（不生成的话前端会去 :3000 上找 `/api`，取不到数据）
4. 后台起后端，轮询 `/api/health` 确认真的起来了（失败会把日志尾部打出来）
5. 前台起前端；`Ctrl-C` 会连带停掉后端

端口可覆盖：

```bash
STUDIO_PORT=8850 WEB_PORT=3100 ./start.sh
```

## 数据库

首次启动自动在 `data/studio.db` 建库建表（SQLite），空库，没有任何凭据。
要连 MySQL/PostgreSQL 就在页面的「环境配置」里切。

## 目录说明

- `src/agent_studio/` — 后端（FastAPI）
- `web/` — 前端（Next.js，App Router）
- `scripts/` — 打包与验证脚本（`build-dev-bundle.sh`、`build-offline-bundle.sh`、`verify-bundle.sh`）
- `AGENTS.md` — 产品意志与仓库坑（接手前先读）

## 常见问题

**页面能打开但数据是空的**：检查 `web/.env.local` 里的 `NEXT_PUBLIC_API_BASE` 是否指向后端真实地址；用 `127.0.0.1` 时别的机器打开会连到它自己。

**按钮点了没反应**：前端没 hydrate。用内网 IP 访问时，`next.config.ts` 的 `allowedDevOrigins` 必须包含该地址（本包已含 `127.0.0.1/localhost/192.168.2.11`，换网段要自己加）。

**改了后端 schema 没生效**：重启后端；旧进程里的 pydantic 模型会把新字段静默丢弃。
