/** 后端 API 客户端（类型化 fetch 封装）。 */

import type {
  EvalCompareRead,
  EvalRunDetail,
  EvalRunRead,
  EvalSuiteRead,
  GuardrailsRead,
  UsageBucket,
  WorkflowAuto,
  ActivityList,
  Agent,
  AgentDefinition,
  Credential,
  CredentialChatResult,
  CredentialModelsResult,
  CredentialTestResult,
  DbDriverInfo,
  DbStatus,
  DbTestResult,
  Issue,
  Memory,
  MemoryExtractResult,
  MemoryPolicy,
  MemoryStats,
  McpProbeResult,
  McpServer,
  McpServerInput,
  Orchestration,
  OrchestrationDetail,
  OrchStep,
  Workflow,
  WorkflowGraph,
  WorkflowRunBrief,
  WorkflowRunResult,
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
  UploadConfigRead,
  UploadItem,
} from "./types";

/** 内网/本机地址判定：这些主机名直连后端端口，不绕公网 */
/**
 * 访问口令（公网访问平台时需要）。
 *
 * 为什么口令存在前端、而不是让浏览器弹原生框：
 *   平台分两个域名（页面 dev.zeit.ccwu.cc / API dev-api.zeit.ccwu.cc）。
 *   浏览器的原生 Basic 认证弹窗是**按域名各弹一次**的，而且跨域 fetch
 *   **不会**自动带上缓存的口令 —— 靠浏览器原生弹窗根本走不通。
 *   所以改成：自己存、自己带，用户只需在页面上输一次。
 *
 * 内网直连（192.168.2.11:3000）后端不校验口令，本地开发完全不受影响。
 */
const TOKEN_KEY = "studio_access_token";

/** 认证失效时广播出去，由 AccessGate 弹输入框 */
export const AUTH_REQUIRED_EVENT = "studio:auth-required";

export function getAccessToken(): string {
  if (typeof window === "undefined") return "";
  const stored = window.localStorage.getItem(TOKEN_KEY);
  if (stored) return stored;
  // 兜底：前端 Basic 认证通过时，middleware 会写一个普通 cookie，
  // 让浏览器这边也能拿到口令去调 API —— 用户因此只需输一次口令。
  const m = document.cookie.match(/(?:^|;\s*)studio_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

export function setAccessToken(token: string): void {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

/**
 * 给 SSE 地址带上口令。
 *
 * **EventSource 无法自定义请求头** —— 所以流式接口（对话、Playground、Runs）
 * 只能通过查询参数传口令，否则这些页面会全部 401 断流。
 */
export function withToken(url: string): string {
  const t = getAccessToken();
  if (!t) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(t)}`;
}

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

/**
 * 从错误响应里读出一句**人能看懂**的话。
 *
 * 为什么不能直接 `String(detail)`：FastAPI 的 422 返回的 detail 是**数组**
 * （每个元素是 {type, loc, msg, input} 的校验错误），`String()` 一下就成了
 * `[object Object]` —— 用户看到的就是这个，完全无从下手，而我们自己也丢了线索。
 * 这里把两种形状都处理掉：字符串原样用，数组拼成"字段 位置：原因"。
 */
function readErrorDetail(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const raw = (body as { detail?: unknown }).detail;
  if (typeof raw === "string" && raw.trim()) return raw;
  if (Array.isArray(raw)) {
    const parts = raw
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const o = item as { loc?: unknown[]; msg?: string; type?: string };
          const where = Array.isArray(o.loc)
            ? o.loc.filter((x) => x !== "body" && x !== "query").join(".")
            : "";
          const msg = o.msg || o.type || "参数不合法";
          return where ? `${where}：${msg}` : msg;
        }
        return "";
      })
      .filter(Boolean);
    if (parts.length) return parts.join("；");
  }
  // 兜底：把对象序列化出来，至少不是 [object Object]
  try {
    const json = JSON.stringify(raw ?? body);
    if (json && json !== "{}") return json.slice(0, 300);
  } catch {
    /* 序列化失败就退回原文本 */
  }
  return fallback;
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
  const token = getAccessToken();
  // 上传（FormData）时**不能**自己设 Content-Type —— 必须让浏览器带 boundary
  const isForm = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      ...(isForm ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  // 口令失效/未提供 —— 广播出去让 AccessGate 弹输入框，而不是抛一个看不懂的错
  if (res.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const detail = readErrorDetail(body, text || res.statusText);
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
  /** 编排者的**平台内置职责定义**（Agents 页展示用；文案只存在后端一份，不复制） */
  orchestratorBrief: () => request<{ brief: string; abilities: string }>("/api/agents/orchestrator/brief"),
  /* ── MCP 服务器（注册 / 探测 / 绑定）────────────────────────────────── */
  mcpServers: (limit = 100) => request<McpServer[]>(`/api/mcp?limit=${limit}`),
  createMcpServer: (body: McpServerInput) => post<McpServer>("/api/mcp", body),
  updateMcpServer: (id: string, body: Partial<McpServerInput>) =>
    request<McpServer>(`/api/mcp/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteMcpServer: (id: string) =>
    request<void>(`/api/mcp/${id}`, { method: "DELETE" }),
  /** 重新探测已保存的服务器，结果（工具清单/成败）会写进去 */
  probeMcpServer: (id: string) =>
    post<McpServer>(`/api/mcp/${id}/probe`, {}),
  /** 保存前先试连（不落库）—— 让"连不上"在保存之前就暴露 */
  probeMcpDraft: (body: McpServerInput) => post<McpProbeResult>("/api/mcp/probe", body),

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
    default_model?: string | null;
    name: string;
    provider: string;
    api_key: string;
    base_url?: string | null;
  }) => post<Credential>("/api/credentials", body),
  updateCredential: (
    id: string,
    body: {
      name?: string;
      provider?: string;
      api_key?: string;
      base_url?: string | null;
      /** 空串 = 清空该字段 */
      default_model?: string;
    },
  ) => put<Credential>(`/api/credentials/${id}`, body),
  deleteCredential: (id: string) => del(`/api/credentials/${id}`),
  /**
   * 查看某个配置的**明文 API Key**。
   * 注意：这个接口没有额外鉴权 —— 谁能访问 API 谁就能拿到明文 key，
   * 所以不要在没有前置认证的情况下把平台暴露到公网。
   */
  revealCredentialKey: (id: string) =>
    request<{ id: string; name: string; api_key: string }>(`/api/credentials/${id}/key`),
  testCredential: (id: string, model?: string) =>
    post<CredentialTestResult>(`/api/credentials/${id}/test`, { model }),
  /**
   * 直接用这条凭据聊一句 —— **不经过任何 Agent**。
   *
   * 为什么要有它：配好模型要验证两件独立的事 ——「这把 key+端点+模型能不能
   * 对话」和「这个助手配得对不对」。混在一起测，报错分不清是哪一层。
   */
  credentialChat: (
    id: string,
    body: {
      model?: string;
      messages: { role: "system" | "user" | "assistant"; content: string }[];
    },
  ) => post<CredentialChatResult>(`/api/credentials/${id}/chat`, body),
  /** 探测某凭据下可用的模型清单（编辑配置时让用户挑模型） */
  credentialModels: (id: string) =>
    request<CredentialModelsResult>(`/api/credentials/${id}/models`),
  probeCredential: (body: {
    default_model?: string | null;
    name: string;
    provider: string;
    api_key: string;
    base_url?: string | null;
  }) => post<CredentialTestResult>("/api/credentials/probe", body),

  // 运行时
  /* ── 任务卡的上传附件 ──────────────────────────────────────────────
     存储目录可由用户在「环境配置」页自定义（uploadConfig / setUploadConfig） */
  uploadFile: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<UploadItem>("/api/uploads", { method: "POST", body: fd });
  },
  uploadConfig: () => request<UploadConfigRead>("/api/uploads/config"),
  setUploadConfig: (dir: string) =>
    request<UploadConfigRead>("/api/uploads/config", {
      method: "PUT",
      body: JSON.stringify({ dir }),
    }),
  deleteUpload: (id: string) =>
    request<{ deleted: number }>(`/api/uploads/file/${id}`, { method: "DELETE" }),

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
  updateTool: (
    id: string,
    body: {
      name?: string;
      description?: string;
      input_schema?: Record<string, unknown>;
      impl?: Record<string, unknown>;
      flags?: Record<string, unknown>;
    },
  ) => put<Tool>(`/api/tools/${id}`, body),
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
    /** 发起来源：chat（对话页）/ preview（助手页试跑）/ playground（编排）。
     *  只影响「运行记录」怎么分类，不影响执行。 */
    origin?: "chat" | "preview" | "playground";
  }) => post<Run>("/api/runs", body),
  runEvents: (id: string) => request<RunEvent[]>(`/api/runs/events/${id}`),
  /** 单条 LLM 对话测试的完整记录（弹框里要看请求原文与回复） */
  modelTest: (id: string) =>
    request<Record<string, unknown>>(`/api/runs/model-tests/${id}`),
  /**
   * 统一的「运行记录」时间线：助手执行（对话/试跑/编排）+ LLM 对话测试。
   * 一次请求拿全，前端不用为了看另一类再切页面。
   */
  // ── 存储体检与事件归档 ─────────────────────────────────────────────────
  /** 当前占用：事件行数 / 明细字节 / 已归档数 / 归档规则 */
  storage: () => request<{
    event_rows: number;
    stream_rows: number;
    event_payload_bytes: number;
    runs: number;
    runs_archived: number;
    last_archived_at?: number | null;
    last_auto_run_at?: number | null;
    keep_days: number;
    preview_bytes: number;
    enabled: boolean;
    db_bytes?: number | null;
  }>("/api/maintenance/storage"),
  /** 立刻整理一次（只动够老的执行：折叠逐字片段 + 截断超大 payload） */
  compactEvents: () => post<{
    ok: boolean;
    runs_archived?: number;
    rows_removed?: number;
    bytes_before?: number;
    bytes_after?: number;
    reason?: string;
  }>("/api/maintenance/compact", {}),

  // ── 版本历史与回滚 ─────────────────────────────────────────────────────
  /** 某个对象的版本列表（助手 / 流程共用；label 是"改了什么"的人话） */
  revisions: (kind: "agent" | "workflow", targetId: string, withPayload = false) =>
    request<{
      items: { id: string; version: number; label: string; created_at: number; current: boolean; payload?: Record<string, unknown> }[];
      latest_version: number;
    }>(`/api/revisions?kind=${kind}&target_id=${targetId}${withPayload ? "&with_payload=true" : ""}`),
  /** 回到某一版（**新建一条记录，不改写历史**） */
  restoreRevision: (revId: string) => post<{ ok: boolean; version: number; restored_from: number }>(`/api/revisions/${revId}/restore`, {}),

  // ── 备份与迁移（数据带走）──────────────────────────────────────────────
  /** 导出全部（助手/流程/单价/记忆）—— **包里不含任何密钥** */
  exportBundle: () =>
    request<{
      kind: string;
      version: number;
      exported_at: number;
      note: string;
      agents: { id: string; name: string; definition: Record<string, unknown>; tools: string[]; skills: string[] }[];
      workflows: { name: string; description: string; graph: WorkflowGraph; mode_override: string | null; auto: Record<string, unknown> }[];
      prices: { currency: string; items: { model: string; in_per_mtok: number; out_per_mtok: number }[] };
      memories?: unknown[];
    }>("/api/export"),
  /** 导入一个导出包（**只新增、不覆盖**） */
  importBundle: (bundle: Record<string, unknown>) => post<Record<string, unknown>>("/api/import", { bundle }),

  // ── 自动运行（无人值守）：定时 + 外部触发 ──────────────────────────────
  /** 读自动运行设置（首次打开时后端会顺手生成一把触发凭证） */
  workflowAuto: (id: string) => request<WorkflowAuto>(`/api/workflows/${id}/auto`),
  /** 存自动运行设置（整份提交；后端会立刻把"下次运行时间"排好） */
  saveWorkflowAuto: (
    id: string,
    body: { mode: string; at: string; weekdays: string; default_task: string },
  ) => put<WorkflowAuto>(`/api/workflows/${id}/auto`, body),
  /** 换一把新的触发凭证（旧的立即失效） */
  rotateWorkflowTrigger: (id: string) =>
    post<WorkflowAuto>(`/api/workflows/${id}/auto/rotate`, {}),

  // ── 单价（用量 → 金额）────────────────────────────────────────────────
  prices: () =>
    request<{
      currency: string;
      items: {
        model: string;
        in_per_mtok: number;
        out_per_mtok: number;
        calls: number;
        tokens_in: number;
        tokens_out: number;
        priced: boolean;
      }[];
      /** 用过但还没填单价的模型 —— 界面据此提示「补上才算得准」 */
      unpriced: string[];
    }>("/api/prices"),
  savePrices: (body: { currency?: string; items: { model: string; in_per_mtok: number; out_per_mtok: number }[] }) =>
    put<{ saved: number; cleared: number }>("/api/prices", body),
  // ── 用量与花费汇总 ───────────────────────────────────────────────────
  usage: (days = 7) =>
    request<{
      currency: string;
      days: number;
      today: UsageBucket;
      period: UsageBucket;
      daily: (UsageBucket & { day: string })[];
      by_model: (UsageBucket & { model: string; priced: boolean })[];
      unpriced: string[];
    }>(`/api/runs/usage?days=${days}`),

  runTimeline: (params?: {
    kind?: string;
    status?: string;
    agent_id?: string;
    q?: string;
    limit?: number;
    /** 游标：只取这个时间戳（毫秒）之前的记录 —— 分页用「加载更多」而不是页码 */
    before?: number;
    /** 游标 tiebreak：同一毫秒内的记录靠它排序（否则翻页会漏/重） */
    before_id?: string;
  }) => {
    const sp = new URLSearchParams();
    Object.entries(params ?? {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
    });
    const qs = sp.toString();
    return request<ActivityList>(`/api/runs/timeline${qs ? `?${qs}` : ""}`);
  },
  runTrace: (id: string) => request<RunTrace>(`/api/runs/trace/${id}`),
  abortRun: (id: string) => post<{ aborted: boolean }>(`/api/runs/abort/${id}`),
  /** **重跑这一条执行**：记录原地重来（归属不变）——分派的某一项失败时只重跑那一路 */
  rerunRun: (id: string) => post<Run>(`/api/runs/${id}/rerun`, {}),
  /** 评测：用例集 + 跑一次 + 结果 + 两版对比（都挂在助手维度） */
  evalSuites: (agentId: string) => request<EvalSuiteRead[]>(`/api/evals/suites?agent_id=${agentId}`),
  evalCreateSuite: (body: {
    agent_id: string;
    name: string;
    cases: { input: string; must_include?: string; rubric?: string }[];
  }) => post<EvalSuiteRead>("/api/evals/suites", body),
  evalSaveSuite: (
    id: string,
    body: {
      agent_id: string;
      name: string;
      cases: { input: string; must_include?: string; rubric?: string }[];
    },
  ) =>
    request<EvalSuiteRead>(`/api/evals/suites/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  evalDeleteSuite: (id: string) =>
    request<{ deleted: number; id: string }>(`/api/evals/suites/${id}`, { method: "DELETE" }),
  evalRunSuite: (id: string, label: string) =>
    post<EvalRunDetail>(`/api/evals/suites/${id}/run`, { label }),
  evalRuns: (suiteId: string) => request<EvalRunRead[]>(`/api/evals/runs?suite_id=${suiteId}`),
  evalRun: (id: string) => request<EvalRunDetail>(`/api/evals/runs/${id}`),
  evalCompare: (left: string, right: string) =>
    request<EvalCompareRead>(`/api/evals/compare?left=${left}&right=${right}`),
  /** 护栏：今日用量 + 两个上限（每日额度 / 分派层数） */
  guardrails: () => request<GuardrailsRead>("/api/guardrails"),
  setDailyLimit: (limit: number) =>
    request<GuardrailsRead>("/api/guardrails/daily", {
      method: "PUT",
      body: JSON.stringify({ limit }),
    }),
  setDepthLimit: (limit: number) =>
    request<GuardrailsRead>("/api/guardrails/depth", {
      method: "PUT",
      body: JSON.stringify({ limit }),
    }),
  /** 补齐失败的那几路（分派这一步重跑；已成功的路不会重跑） */
  refillFanout: (id: string) =>
    post<{ run_id: string; status: string }>(`/api/runs/${id}/refill`, {}),
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
    withToken(`${apiBase()}/api/orchestrations/stream/${id}`),

  /* ── 编排设计稿（Playground 画布）──────────────────────────────────────────
     设计稿和执行记录是两种东西：workflow 可反复改、反复跑；orchestration 是
     一次执行的事实。所以存取走 workflows，跑完拿 orchestration_id 去订阅。 */
  workflows: (limit = 50) => request<Workflow[]>(`/api/workflows?limit=${limit}`),
  workflow: (id: string) => request<Workflow>(`/api/workflows/${id}`),
  createWorkflow: (body: {
    name?: string;
    description?: string;
    graph: WorkflowGraph;
    mode_override?: string | null;
  }) => post<Workflow>("/api/workflows", body),
  updateWorkflow: (
    id: string,
    body: {
      name?: string;
      description?: string;
      graph?: WorkflowGraph;
      /** 传 "" 表示恢复"自动判断" */
      mode_override?: string | null;
    },
  ) => request<Workflow>(`/api/workflows/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteWorkflow: (id: string) =>
    request<{ deleted: number; id: string }>(`/api/workflows/${id}`, { method: "DELETE" }),
  /** 跑一次：返回 orchestration_id，用它订阅现成的编排流 */
  runWorkflow: (id: string, body: { task: string; timeout_s?: number }) =>
    post<WorkflowRunResult>(`/api/workflows/${id}/run`, body),
  /** **只跑这一步**（单步运行）：后端只裁成单节点执行，**不落任何 workflow**（脏数据红线） */
  runNode: (wfId: string, nid: string, body: { task: string }) =>
    post<{ orchestration_id: string; mode: string; nid: string; step_count: number }>(
      `/api/workflows/${wfId}/run-node?nid=${encodeURIComponent(nid)}`,
      body,
    ),
  workflowRuns: (id: string, limit = 20) =>
    request<WorkflowRunBrief[]>(`/api/workflows/${id}/runs?limit=${limit}`),

  // SSE 事件流地址（单次执行）
  streamUrl: (runId: string) => withToken(`${apiBase()}/api/runs/stream/${runId}`),

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
  /**
   * 复制一条记忆并绑定到别处。
   *
   * 平台的绑定模型是「一条记忆只属于一个 Agent」：要多个 Agent 共用同一条内容，
   * 就复制一份再换绑 —— 而不是让它同时属于多个（那样一方改动会牵动另一方）。
   */
  duplicateMemory: (
    id: string,
    body: { agent_id?: string | null; scope?: "agent" | "global"; content?: string },
  ) => post<Memory>(`/api/memories/${id}/duplicate`, body),
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
  /** 精确整数（带千分位）。存储/计数这类数字**不能压缩** —— 用户要看准 */
  int(v: number | null | undefined): string {
    return Number(v || 0).toLocaleString("zh-CN");
  },
  /** 大数压缩：3695 → 3.7k（表格里不占地方，但量级一眼看得出） */
  num(v: number | null | undefined): string {
    const n = Number(v || 0);
    if (!n) return "0";
    if (n < 1000) return String(n);
    if (n < 1000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  },
  /**
   * 金额。``null`` = **这个模型还没填单价**，显示「—」而不是 0 ——
   * "免费"和"不知道"是两件事（详见后端 pricing.py）。
   * 小额多给几位小数：Agent 单次调用常常只有几分钱，四舍五入成 0.00 就等于看不见。
   */
  money(v: number | null | undefined, currency = "¥"): string {
    if (v === null || v === undefined) return "—";
    const n = Math.abs(v);
    if (n === 0) return `${currency}0`;
    if (n < 0.01) return `${currency}${v.toFixed(4)}`;
    if (n < 1) return `${currency}${v.toFixed(3)}`;
    return `${currency}${v.toFixed(2)}`;
  },
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
