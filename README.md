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

### 后端

```bash
cd /srv/src/agent-studio
uv sync
uv run uvicorn agent_studio.main:app --host 0.0.0.0 --port 8848
```

打开 http://127.0.0.1:8848/docs 看交互式 API 文档。

### 前端

```bash
cd web
npm install
npm run dev     # http://localhost:3000
```

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
