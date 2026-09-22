/** 后端 API 客户端（类型化 fetch 封装）。 */

import type {
  Agent,
  AgentDefinition,
  Credential,
  CredentialTestResult,
  DbDriverInfo,
  DbStatus,
  DbTestResult,
  Issue,
  Memory,
  MemoryExtractResult,
  MemoryPolicy,
  MemoryStats,
  Orchestration,
  OrchestrationDetail,
  OrchStep,
  Provider,
  Run,
  RunDeleteResult,
  RunEvent,
  RunTrace,
  RuntimeCapabilities,
  Session,
  SessionDetail,
  Skill,
  Tool,
} from "./types";

/** 内网/本机地址判定：这些主机名直连后端端口，不绕公网 */
function isLanHost(host: string): boolean {
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".local")) return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 127 || a === 10) return true;              // 回环 / 10.x
  if (a === 192 && b === 168) return true;             // 192.168.x
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16-31.x
  return false;
}

/**
 * 后端 API 地址 —— **运行时**决定，绝不能构建时写死。
 *
 * 同一份构建产物要同时服务两种访问方式，而它们的正确地址完全不同：
 *
 *   ・内网直连 http://192.168.2.11:3000 → 后端 http://192.168.2.11:8848
 *     同网段直连最短，不用绕公网
 *   ・公网域名 https://dev.zeit.ccwu.cc → 后端 https://dev-api.zeit.ccwu.cc
 *     **必须是 HTTPS**：浏览器会以「混合内容」为由拦掉 HTTPS 页面发起的
 *     HTTP 请求 —— 这是硬拦截，跟内网通不通无关。
 *
 * 早先写死了内网 IP，结果公网打开页面时界面能显示、数据全部加载失败
 * （报错就是 `fetch 192.168.2.11:8848 失败`）。
 *
 * 注意：SSE（EventSource）也走这里，所以它必须能在浏览器里被调用，
 * 不能依赖只在服务端可用的配置。
 */
export function apiBase(): string {
  if (typeof window !== "undefined") {
    const { protocol, hostname } = window.location;
    if (isLanHost(hostname)) return `${protocol}//${hostname}:8848`;
    // 通过域名访问：改用 API 子域名（同为 HTTPS，不触发混合内容）
    return "https://dev-api.zeit.ccwu.cc";
  }
  // 服务端渲染兜底（同机回环）
  return process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8848";
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const detail =
      typeof body === "object" && body && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : text || res.statusText;
    throw new ApiError(detail, res.status);
  }
  return body as T;
}

const post = <T>(p: string, body?: unknown) =>
  request<T>(p, { method: "POST", body: JSON.stringify(body ?? {}) });
const put = <T>(p: string, body?: unknown) =>
  request<T>(p, { method: "PUT", body: JSON.stringify(body ?? {}) });
const del = <T = void,>(p: string) => request<T>(p, { method: "DELETE" });

export const api = {
  // 健康
  health: () =>
    request<{ status: string; version: string; runtimes: string[] }>(
      "/api/health",
    ),

  // Provider 与 LLM 配置
  providers: () => request<Provider[]>("/api/providers"),
  credentials: (provider?: string) =>
    request<Credential[]>(
      `/api/credentials${provider ? `?provider=${provider}` : ""}`,
    ),
  createCredential: (body: {
    name: string;
    provider: string;
    api_key: string;
    base_url?: string | null;
  }) => post<Credential>("/api/credentials", body),
  updateCredential: (
    id: string,
    body: { name?: string; api_key?: string; base_url?: string },
  ) => put<Credential>(`/api/credentials/${id}`, body),
  deleteCredential: (id: string) => del(`/api/credentials/${id}`),
  testCredential: (id: string, model?: string) =>
    post<CredentialTestResult>(`/api/credentials/${id}/test`, { model }),
  probeCredential: (body: {
    name: string;
    provider: string;
    api_key: string;
    base_url?: string | null;
  }) => post<CredentialTestResult>("/api/credentials/probe", body),

  // 运行时
  runtimes: () => request<RuntimeCapabilities[]>("/api/runtimes"),
  runtimeCapabilities: (name: string) =>
    request<RuntimeCapabilities>(`/api/runtimes/${name}/capabilities`),
  validate: (definition: AgentDefinition) =>
    post<{ ok: boolean; issues: Issue[] }>("/api/runtimes/validate", {
      definition,
    }),

  // Agent
  agents: () => request<Agent[]>("/api/agents"),
  agent: (id: string) => request<Agent>(`/api/agents/${id}`),
  createAgent: (body: {
    name: string;
    description?: string;
    definition: AgentDefinition;
  }) => post<Agent>("/api/agents", body),
  updateAgent: (
    id: string,
    body: { name?: string; description?: string; definition?: AgentDefinition },
  ) => put<Agent>(`/api/agents/${id}`, body),
  deleteAgent: (id: string) => del(`/api/agents/${id}`),
  duplicateAgent: (id: string, body?: { name?: string }) =>
    post<Agent>(`/api/agents/${id}/duplicate`, body ?? {}),
  agentLineage: (id: string) => request<Agent[]>(`/api/agents/${id}/lineage`),
  agentTools: (id: string) =>
    request<{ id: string; name: string; kind: string }[]>(
      `/api/agents/${id}/tools`,
    ),
  mountTool: (agentId: string, toolId: string) =>
    post<void>(`/api/agents/${agentId}/tools/${toolId}`),
  unmountTool: (agentId: string, toolId: string) =>
    del(`/api/agents/${agentId}/tools/${toolId}`),
  mountSkill: (agentId: string, skillId: string) =>
    post<void>(`/api/agents/${agentId}/skills/${skillId}`),
  unmountSkill: (agentId: string, skillId: string) =>
    del(`/api/agents/${agentId}/skills/${skillId}`),
  agentRuns: (id: string, limit = 20) =>
    request<
      {
        id: string;
        status: string;
        started_at: number;
        ended_at: number | null;
        usage: Record<string, number>;
      }[]
    >(`/api/agents/${id}/runs?limit=${limit}`),

  // 工具
  tools: (kind?: string) =>
    request<Tool[]>(`/api/tools${kind ? `?kind=${kind}` : ""}`),
  createTool: (body: {
    kind: string;
    name: string;
    description: string;
    input_schema?: Record<string, unknown>;
    impl?: Record<string, unknown>;
    flags?: Record<string, unknown>;
  }) => post<Tool>("/api/tools", body),
  deleteTool: (id: string) => del(`/api/tools/${id}`),
  syncBuiltins: (runtime = "agentscope") =>
    post<{
      runtime: string;
      discovered: number;
      created: number;
      updated?: number;
      unsupported?: { name: string; reason: string }[];
    }>(`/api/tools/sync-builtins?runtime=${runtime}`),
  testTool: (id: string, args: Record<string, unknown>) =>
    post<{
      ok: boolean;
      skipped?: boolean;
      applicable?: boolean;
      kind?: string;
      duration_ms?: number;
      result_preview?: string;
      result_size?: number;
      note?: string;
      reason?: string;
      error?: string;
      hint?: string;
      required?: string[];
    }>(`/api/tools/${id}/test`, { args }),

  // Skill
  skills: () => request<Skill[]>("/api/skills"),
  skill: (id: string) => request<Skill>(`/api/skills/${id}`),
  deleteSkill: (id: string) => del(`/api/skills/${id}`),
  importSkill: (body: {
    source: "local" | "url" | "git" | "inline";
    path?: string;
    url?: string;
    ref?: string;
    subpath?: string;
    content?: string;
    name?: string;
  }) =>
    post<{ count: number; items: { id: string; name: string }[] }>(
      "/api/skills/import",
      body,
    ),

  // Run
  runs: (agentId?: string, limit = 50) =>
    request<Run[]>(
      `/api/runs?limit=${limit}${agentId ? `&agent_id=${agentId}` : ""}`,
    ),
  run: (id: string) => request<Run>(`/api/runs/${id}`),
  createRun: (body: {
    agent_id: string;
    input: string | Record<string, unknown>;
    timeout_s?: number;
    /** 多轮会话：传了就带上会话历史 + 召回记忆 */
    session_id?: string;
  }) => post<Run>("/api/runs", body),
  runEvents: (id: string) => request<RunEvent[]>(`/api/runs/events/${id}`),
  runTrace: (id: string) => request<RunTrace>(`/api/runs/trace/${id}`),
  abortRun: (id: string) => post<{ aborted: boolean }>(`/api/runs/abort/${id}`),
  resumeRun: (
    id: string,
    body: { confirm: boolean; reason?: string; payload?: unknown },
  ) => post<{ resumed: boolean }>(`/api/runs/resume/${id}`, body),
  compareRuns: (a: string, b: string) =>
    request<{
      a: { run: Run; event_count: number };
      b: { run: Run; event_count: number };
    }>(`/api/runs/compare/two?a=${a}&b=${b}`),

  // Run 清理（危险操作分级）
  deleteRun: (id: string) => del(`/api/runs/${id}`),
  bulkDeleteRuns: (ids: string[]) =>
    post<RunDeleteResult>("/api/runs/bulk-delete", { ids }),
  pruneRuns: (body: {
    before_ts?: number;
    status?: string[];
    agent_id?: string;
    dry_run?: boolean;
  }) => post<RunDeleteResult>("/api/runs/prune", body),
  clearRuns: (confirm: string, agentId?: string) =>
    request<RunDeleteResult>(
      `/api/runs?confirm=${encodeURIComponent(confirm)}${agentId ? `&agent_id=${agentId}` : ""}`,
      { method: "DELETE" },
    ),

  /* ---------------------- 环境配置（数据库驱动切换） ---------------------- */

  database: () => request<DbStatus>("/api/database"),
  databaseDrivers: () =>
    request<{ drivers: DbDriverInfo[]; current: string }>("/api/database/drivers"),
  databaseTest: (body: Record<string, unknown>) =>
    post<DbTestResult>("/api/database/test", body),
  databaseSwitch: (body: Record<string, unknown>) =>
    post<{
      ok: boolean;
      target: string;
      driver: string;
      tables: string[];
      table_count: number;
      created_database: boolean;
      restarting: boolean;
      note: string;
    }>("/api/database/switch", body),
  /** 切换后轮询这个确认服务回来了 */
  databaseHealth: () =>
    request<{ ok: boolean; driver: string; describe: string }>("/api/database/health"),

  /* ---------------------- Playground（多助手编排） ---------------------- */

  orchestrations: (limit = 50) =>
    request<Orchestration[]>(`/api/orchestrations?limit=${limit}`),
  orchestration: (id: string) =>
    request<OrchestrationDetail>(`/api/orchestrations/${id}`),
  createOrchestration: (body: {
    mode: string;
    worker_mode?: string | null;
    master_agent_id?: string | null;
    steps: OrchStep[];
    task: string;
    name?: string | null;
  }) => post<Orchestration>("/api/orchestrations", body),
  abortOrchestration: (id: string) =>
    post<{ aborted: number; status: string }>(`/api/orchestrations/${id}/abort`),
  /** 编排的实时流（聚合所有子步骤的事件） */
  orchestrationStreamUrl: (id: string) =>
    `${apiBase()}/api/orchestrations/stream/${id}`,

  // SSE 事件流地址（单次执行）
  streamUrl: (runId: string) => `${apiBase()}/api/runs/stream/${runId}`,

  /* ----------------------------- 会话（多轮） ----------------------------- */
  sessions: (agentId?: string) =>
    request<Session[]>(`/api/sessions${agentId ? `?agent_id=${agentId}` : ""}`),
  session: (id: string) => request<SessionDetail>(`/api/sessions/${id}`),
  createSession: (agentId: string, title?: string) =>
    post<Session>("/api/sessions", { agent_id: agentId, title: title ?? null }),
  updateSession: (id: string, patch: { title?: string; status?: string }) =>
    request<Session>(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteSession: (id: string) => del<{ deleted: number }>(`/api/sessions/${id}`),
  clearSessionContext: (id: string, keepSummary = false) =>
    post<{ removed_messages: number }>(`/api/sessions/${id}/clear-context`, {
      keep_summary: keepSummary,
    }),

  /* ----------------------------- 记忆（长期） ----------------------------- */
  memories: (params?: {
    agentId?: string;
    status?: string;
    kind?: string;
    q?: string;
    scope?: string;
  }) => {
    const qs = new URLSearchParams();
    if (params?.agentId) qs.set("agent_id", params.agentId);
    if (params?.status) qs.set("status", params.status);
    if (params?.kind) qs.set("kind", params.kind);
    if (params?.q) qs.set("q", params.q);
    if (params?.scope) qs.set("scope", params.scope);
    const suffix = qs.toString() ? `?${qs}` : "";
    return request<Memory[]>(`/api/memories${suffix}`);
  },
  createMemory: (body: {
    content: string;
    agent_id?: string | null;
    scope?: string;
    kind?: string;
    importance?: number;
    active?: boolean;
  }) => post<Memory>("/api/memories", body),
  updateMemory: (
    id: string,
    patch: Partial<{
      content: string;
      kind: string;
      importance: number;
      status: string;
      scope: string;
    }>,
  ) =>
    request<Memory>(`/api/memories/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteMemory: (id: string) => del<{ deleted: number }>(`/api/memories/${id}`),
  memoryStats: () => request<MemoryStats>("/api/memories/stats"),
  bulkMemoryStatus: (ids: string[], status: string) =>
    post<{ updated: number }>("/api/memories/bulk-status", { ids, status }),
  extractMemories: (
    runId: string,
    items?: {
      content: string;
      agent_id?: string | null;
      kind?: string;
      importance?: number;
    }[],
    asCandidate = false,
  ) =>
    post<MemoryExtractResult>("/api/memories/extract", {
      run_id: runId,
      items: items ?? null,
      as_candidate: asCandidate,
    }),

  agentMemories: (agentId: string) => request<Memory[]>(`/api/agents/${agentId}/memories`),
  agentMemoryBindings: (agentId: string) =>
    request<{ memory_ids: string[] }>(`/api/agents/${agentId}/memory-bindings`),
  setAgentMemories: (agentId: string, memoryIds: string[]) =>
    put<{ bound: number; ignored: number }>(`/api/agents/${agentId}/memories`, {
      memory_ids: memoryIds,
    }),
  agentMemoryPolicy: (agentId: string) =>
    request<MemoryPolicy>(`/api/agents/${agentId}/memory-policy`),
  updateAgentMemoryPolicy: (agentId: string, patch: Partial<MemoryPolicy>) =>
    request<MemoryPolicy>(`/api/agents/${agentId}/memory-policy`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
};

/** 格式化辅助 */
export const fmt = {
  ms(v: number | null | undefined): string {
    if (v === null || v === undefined) return "—";
    if (v < 1000) return `${v}ms`;
    return `${(v / 1000).toFixed(2)}s`;
  },
  bytes(v: number | null | undefined): string {
    if (!v) return "0B";
    if (v < 1024) return `${v}B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB`;
    return `${(v / 1024 / 1024).toFixed(1)}MB`;
  },
  time(ts: number | null | undefined): string {
    if (!ts) return "—";
    return new Date(ts).toLocaleString("zh-CN", { hour12: false });
  },
  relative(ts: number | null | undefined): string {
    if (!ts) return "—";
    const diff = Date.now() - ts;
    if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return `${Math.floor(diff / 86_400_000)} 天前`;
  },
};

export const STATUS_STYLE: Record<string, string> = {
  ok: "text-[var(--color-ok)]",
  error: "text-[var(--color-err)]",
  aborted: "text-[var(--color-warn)]",
  running: "text-[var(--color-accent)]",
  pending: "text-[var(--color-muted)]",
  waiting_hitl: "text-[var(--color-warn)]",
};
