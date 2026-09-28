# Agent Studio · 离线一体包

可视化 Agent 配置与运行观测平台（运行时无关）。**开箱即用**：包内自带 Python 运行时与全部依赖，
不依赖 Node.js、不依赖系统 Python、不需要联网。

## 快速开始

```bash
tar xzf agent-studio-20260928-x86_64.tar.gz
cd agent-studio
./start.sh
```

浏览器打开 `http://<服务器IP>:8848` 即可（首次启动约 2~5 秒）。

## 常用参数

| 需求 | 命令 |
|---|---|
| 换端口 | `PORT=9000 ./start.sh` |
| 公网访问加口令 | `STUDIO_ACCESS_TOKEN=你的口令 ./start.sh` |
| 数据换位置 | `STUDIO_DB_PATH=/data/studio.db ./start.sh` |
| 后台常驻 | `nohup ./start.sh > studio.log 2>&1 &` |

## 目录说明

```
agent-studio/
├── start.sh                       启动脚本（唯一入口）
├── app/src/agent_studio/          后端源码
├── app/web/out/                   前端静态资源（Next.js 静态导出，无 Node 依赖）
├── runtime/<arch>/python/         内置 Python 3.13 运行时（x86_64 / aarch64）
├── vendor/<arch>/site-packages/   预装好的全部依赖（含原生扩展）
├── data/                          数据目录（SQLite + 主密钥，首启自动创建）
└── requirements-lock.txt          依赖版本清单
```

## 数据与密钥

- **数据库**：`data/studio.db`（SQLite，首启自动建表；默认每天自动留一份副本）
- **主密钥**：`data/.master_key`（首启自动生成，用于加密库中的 LLM 密钥）
  - 迁移服务器时，把整个 `data/` 一起带走，否则已存的 LLM 密钥无法解密

## 支持的环境

- 架构：Intel/AMD（x86_64）、ARM64（aarch64）
- 系统：Linux，glibc ≥ 2.17（CentOS 7 / Debian 10 / Ubuntu 18.04 及以上）
- 端口：默认 8848

## 排查

| 现象 | 处理 |
|---|---|
| 提示「不支持的架构」 | 用与服务器架构匹配的发行包（-x86_64 / -aarch64） |
| 端口被占用 | `PORT=9000 ./start.sh` |
| 页面空白 | 确认 `app/web/out/index.html` 存在 |
| 启动报 uvicorn 缺失 | 确认用的是包内 `start.sh`，不要自行改 PYTHONPATH |
