# Agent Studio

> 可视化 Agent 配置与运行观测平台 —— **运行时无关**（Runtime-Agnostic）。

在一个页面里定义 Agent、挂载工具与 Skill、执行并**完整观测**每一次调用的日志与耗时。

```
┌──────────────── Next.js WebUI (:3000) ────────────────┐
│ Agent 编辑器 │ 工具库 │ Skill 库 │ Run 控制台 │ Trace  │
└───────────────────────┬───────────────────────────────┘
                        │ REST + SSE
┌───────────────────────▼───────────────────────────────┐
│              FastAPI (:8848, Python 3.13)              │
│  ┌─────────────┬─────────────┬────────────┬─────────┐  │
│  │ Definition  │ Tool/Skill  │  Run 编排   │ 凭据管理 │  │
│  │  Service    │  Registry   │ + 指标采集  │ (多Key) │  │
│  └──────┬──────┴──────┬──────┴─────┬──────┴────┬────┘  │
│  ┌──────▼─────────────▼────────────▼───────────▼────┐  │
│  │        Runtime 抽象层（AgentRuntime）★核心        │  │
│  │   capabilities / validate / compile / run / resume│  │
│  └──────┬────────────────────────────────────┬───────┘  │
│  ┌──────▼──────────────┐         ┌───────────▼──────┐  │
│  │ AgentScopeRuntime   │         │  PiRuntime(预留)  │  │
│  │ (进程内 import)      │         │  (Node 子进程)    │  │
│  └─────────────────────┘         └──────────────────┘  │
│                        SQLite (WAL)                     │
└─────────────────────────────────────────────────────────┘
```

## 快速开始

### 开发模式（改代码时用）

```bash
# 后端
cd /srv/src/agent-studio
uv sync
uv run uvicorn agent_studio.main:app --host 0.0.0.0 --port 8848

# 前端（另开一个终端）
cd /srv/src/agent-studio/web
npm install
npm run dev     # http://192.168.2.11:3000
```

### 生产部署（systemd，开机自启）

服务已装成两个 systemd 单元，机器重启后自动拉起：

| 单元 | 内容 | 端口 |
|---|---|---|
| `agent-studio-api.service` | FastAPI（跑 `.venv/bin/uvicorn`） | 8848 |
| `agent-studio-web.service` | Next.js **生产模式**（`npm run start`，依赖 api） | 3000 |

```bash
systemctl status agent-studio-api agent-studio-web      # 看状态
systemctl restart agent-studio-api agent-studio-web     # 重启
journalctl -u agent-studio-api -f                       # 跟后端日志
journalctl -u agent-studio-web -f                       # 跟前端日志
```

**改了前端代码后必须重新构建**，否则页面还是旧版本：

```bash
cd /srv/src/agent-studio/web && npm run build && systemctl restart agent-studio-web
```

**改了后端代码**只需重启（uvicorn 直接读源码）：

```bash
systemctl restart agent-studio-api
```

#### 部署时的两个注意点

1. **不要给服务设 `STUDIO_MASTER_KEY`**
   `security/crypto.py` 在未设置时用代码里的开发默认值，**现有凭据就是用那个值加密的**。
   给 systemd 换一个值 → 已存的 LLM 密钥全部解不开。要正式轮换密钥就得先把凭据
   逐条解密再重新加密。
2. **前端的环境变量在构建时固化**
   `NEXT_PUBLIC_API_BASE`（在 `web/.env.local`）是 `next build` 时内联进产物的，
   改了它必须重新 `npm run build`。拿不准就把 `.env.local` 留在原地。

## 核心概念

| 概念 | 说明 |
|---|---|
| **Agent** | 一份可运行的智能体定义（运行时 + 模型 + 提示词 + 挂载的工具/Skill），支持复制与版本 |
| **Tool** | 可被 Agent 调用的能力：`builtin`（框架内置）/ `http`（表单配置）/ `code`（沙箱，待实现） |
| **Skill** | Markdown 指令包（`SKILL.md` + frontmatter），可从本地/Git/URL 导入 |
| **Run** | 一次执行实例，含完整事件流，不可变、可回放 |
| **Credential** | LLM Provider 凭据（加密存储，支持同一 provider 多套 Key） |

## 支持的 LLM Provider

DeepSeek · OpenAI · Anthropic · 阿里云百炼(通义千问) · Moonshot(Kimi) · xAI(Grok) · Google Gemini · 火山引擎(豆包) · Ollama(本地)

同一 provider 可配置多套 Key（如主号/备用号），Agent 通过 `model.credential_ref` 选用。

## 可观测性

**不额外埋点** —— 所有耗时从事件流配对推导：

| 指标 | 推导方式 |
|---|---|
| LLM 调用耗时 | `llm_call_end.ts - llm_call_start.ts` |
| **TTFT**（首 token 延迟） | 首个 `thinking/text delta` − `llm_call_start` |
| 工具执行耗时 | `tool_exec_end.ts - tool_exec_start.ts` |
| 阶段占比 | `llm_ms / total_ms`（模型瓶颈）vs `tool_ms / total_ms`（工具瓶颈） |

数据落在 `llm_call` / `tool_call` 两张表，前端渲染成瀑布图。

## 测试

```bash
uv run pytest tests/ -v
```

覆盖：指标采集（耗时/TTFT/并发配对）、Provider 注册表、运行时抽象层（含真实编译 AgentScope Agent）、API 端到端。

## 关键设计

1. **`AgentDefinition` 统一数据结构** —— 通用层 + `runtime_options` 命名空间逃生舱
2. **`AgentRuntime` 协议** —— 6 个方法接入任意框架；`capabilities()` 驱动前端动态表单
3. **统一事件模型**（13 类）—— 取各框架事件并集，保留 `raw` 防信息丢失
4. **Run 与 HTTP 解耦** —— 后台 asyncio task，SSE 断线可从 `run_event` 回放
5. **明文永不落库** —— 凭据 Fernet 加密，列表只返回脱敏串

## 目录结构

```
agent-studio/
├── src/agent_studio/
│   ├── models.py          ORM（agent/tool/skill/run/run_event/llm_call/tool_call/secret）
│   ├── schemas.py         DTO + AgentDefinition
│   ├── providers.py       LLM Provider 注册表
│   ├── runtimes/          ★ 抽象层
│   │   ├── base.py        AgentRuntime / UnifiedEvent
│   │   ├── registry.py    运行时注册
│   │   └── agentscope_rt/ compile / runtime / normalize
│   ├── runner/            Run 编排 + 指标采集
│   ├── api/               agents / tools / skills / runs / runtimes / credentials
│   └── security/          密钥加解密
├── tests/                 62 个测试
└── web/                   Next.js 前端
```
