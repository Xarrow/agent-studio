/** 与后端 schemas.py 对应的类型定义 */

export interface Provider {
  name: string;
  display_name: string;
  default_base_url: string | null;
  models: string[];
  requires_key: boolean;
  allows_base_url: boolean;
  docs_url: string | null;
  note: string;
}

export interface Credential {
  id: string;
  name: string;
  provider: string;
  provider_display: string;
  base_url: string | null;
  masked_key: string;
  /** 用户选定的默认模型（探测后挑选或手填），可为空 */
  default_model: string | null;
  last_test_at: number | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  created_at: number;
}

export interface CredentialTestResult {
  ok: boolean;
  provider: string;
  model: string | null;
  latency_ms: number | null;
  models: string[];
  error: string | null;
  checked_at: number;
}

export interface ModelSpec {
  provider: string;
  name: string;
  params?: Record<string, unknown>;
  credential_ref?: string | null;
  base_url?: string | null;
}

export interface ToolRef {
  ref: string;
  enabled: boolean;
}

export interface SkillRef {
  ref: string;
}

export interface Limits {
  max_iters: number;
  timeout_s: number;
  max_cost_usd?: number | null;
}

export interface AgentDefinition {
  runtime: string;
  name: string;
  system_prompt: string;
  model: ModelSpec;
  tools: ToolRef[];
  skills: SkillRef[];
  middlewares: Record<string, unknown>[];
  limits: Limits;
  runtime_options: Record<string, Record<string, unknown>>;
}

export interface Agent {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  description: string | null;
  runtime: string;
  version: number;
  parent_id: string | null;
  definition: AgentDefinition;
  created_at: number;
  updated_at: number;
}

export interface Tool {
  id: string;
  kind: "builtin" | "http" | "code";
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  impl: Record<string, unknown>;
  flags: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  source: Record<string, unknown>;
  content: string;
  files: Record<string, string>;
  created_at: number;
  updated_at: number;
}

export type RunStatus =
  | "pending"
  | "running"
  | "ok"
  | "error"
  | "aborted"
  | "waiting_hitl";

export interface Run {
  id: string;
  agent_id: string;
  agent_version: number;
  runtime: string;
  status: RunStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  usage: Record<string, number | null>;
  error: string | null;
  started_at: number;
  ended_at: number | null;
  pending_hitl?: Record<string, unknown> | null;
  /** 所属会话；为空表示单轮执行 */
  session_id?: string | null;
  /** 会话内第几轮（从 1 开始） */
  turn_index?: number | null;
}

export interface RunEvent {
  seq: number;
  type: string;
  ts: number;
  payload: Record<string, unknown>;
}

export interface LlmCall {
  id: number;
  iteration: number;
  provider: string | null;
  model: string | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  ttft_ms: number | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  cost_usd: number;
  status: string;
  error: string | null;
}

export interface ToolCallRow {
  id: number;
  iteration: number;
  tool_name: string;
  args: Record<string, unknown>;
  call_id: string | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  status: string;
  result_size: number;
  result_preview: string | null;
  error: string | null;
}

export interface RunTrace {
  run: Run;
  events: RunEvent[];
  llm_calls: LlmCall[];
  tool_calls: ToolCallRow[];
  metrics: Record<string, number | null>;
}

/** Run 清理结果：deleted 为实际删除数，skipped 说明哪些被跳过及原因 */
export interface RunDeleteResult {
  deleted: number;
  skipped: { id: string; reason: string }[];
}

export interface RuntimeCapabilities {
  name: string;
  display_name: string;
  supports_hitl: boolean;
  supports_thinking: boolean;
  supports_structured_output: boolean;
  supports_skills: boolean;
  supports_middlewares: boolean;
  supports_unlimited_iters?: boolean;
  supports_no_timeout?: boolean;
  /** 是否支持多轮会话（消费会话历史） */
  supports_multi_turn?: boolean;
  /** 是否支持长期记忆注入 */
  supports_memory?: boolean;
  option_schema: Record<string, unknown>;
  notes: string;
}

export interface Issue {
  level: "error" | "warning";
  field: string | null;
  message: string;
}

/* -------------------------------------------------------------------------- */
/* 会话（多轮对话）                                                            */
/* -------------------------------------------------------------------------- */

export interface Session {
  id: string;
  workspace_id: string;
  agent_id: string;
  title: string;
  status: "active" | "archived";
  summary: string | null;
  summarized_upto: number;
  message_count: number;
  usage: Record<string, number>;
  created_at: number;
  last_active_at: number;
  turn_count: number;
  agent_name: string | null;
}

export interface SessionMessage {
  id: number;
  turn_index: number;
  role: "user" | "assistant" | "system";
  content: string;
  run_id: string | null;
  ts: number;
}

export interface SessionDetail {
  session: Session;
  messages: SessionMessage[];
}

/* -------------------------------------------------------------------------- */
/* 记忆（长期）                                                                */
/* -------------------------------------------------------------------------- */

export type MemoryKind = "fact" | "preference" | "summary" | "instruction";
export type MemoryStatus = "active" | "candidate" | "archived";
export type MemoryScope = "agent" | "global" | "session";

export interface Memory {
  id: string;
  agent_id: string | null;
  agent_name: string | null;
  scope: MemoryScope;
  session_id: string | null;
  kind: MemoryKind;
  content: string;
  source: "manual" | "auto" | "import";
  source_run_id: string | null;
  status: MemoryStatus;
  importance: number;
  hits: number;
  last_hit_at: number | null;
  embedding_status: string;
  ttl_s: number | null;
  created_at: number;
  updated_at: number;
}

export interface MemoryPolicy {
  agent_id: string;
  auto_extract: boolean;
  recall_enabled: boolean;
  recall_top_k: number;
  recall_strategy: "recent" | "keyword" | "hybrid";
  max_inject_chars: number;
  extract_model: string | null;
  compress_after_turns: number;
}

export interface MemoryStats {
  active: number;
  candidate: number;
  archived: number;
  total_hits: number;
  by_kind: Record<MemoryKind, number>;
}

export interface MemoryExtractResult {
  run_id: string;
  candidates: Memory[];
  created: number;
  skipped: { content?: string; reason: string }[];
}

/* ------------------------------ Playground 编排 ------------------------------ */

/** 编排模式 */
export type OrchestrationMode = "single" | "serial" | "parallel" | "master_worker";

/** 编排里的一个槽位（前端编排态） */
export interface OrchStep {
  agent_id: string;
  /** 串行模式：这一步要不要接收上一步的产出（用户在界面上逐个勾选） */
  carry_prev: boolean;
}

/** 编排下的一个子步骤（后端返回，就是一条 Run 的摘要） */
export interface OrchestrationStepRead {
  run_id: string;
  agent_id: string;
  agent_name: string;
  role: string | null;
  order_index: number | null;
  status: string;
  usage: Record<string, number>;
  error: string | null;
  started_at: number;
  ended_at: number | null;
  /** 这个助手领到的任务（串行/主从下会和原任务不同） */
  input_text: string;
  /** 它的产出 */
  output_text: string;
}

export interface Orchestration {
  id: string;
  name: string;
  mode: OrchestrationMode;
  worker_mode: string | null;
  status: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  usage: Record<string, number>;
  error: string | null;
  started_at: number;
  ended_at: number | null;
  step_count: number;
}

export interface OrchestrationDetail extends Orchestration {
  spec: Record<string, unknown>;
  steps: OrchestrationStepRead[];
}

/** 编排实时流的状态快照 */
export interface OrchestrationStatusEvent {
  kind: "status";
  id: string;
  status: string;
  output: Record<string, unknown> | null;
  error: string | null;
  usage: Record<string, number>;
  ended_at: number | null;
  steps: {
    run_id: string;
    agent_id: string;
    agent_name: string;
    role: string | null;
    order_index: number | null;
    status: string;
    error: string | null;
    usage: Record<string, number>;
    input_text: string;
    output_text: string;
    started_at: number;
    ended_at: number | null;
  }[];
}

/* ------------------------------ 环境配置（数据库驱动） ------------------------------ */

export type DbDriver = "sqlite" | "mysql" | "postgresql";

/** 一份数据库连接配置（后端返回，密码已打码） */
export interface DbConfig {
  driver: DbDriver;
  sqlite_path: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  charset: string;
  ssl: boolean;
  has_password: boolean;
  effective_port: number;
  driver_label: string;
  sqlite_file: string;
}

export interface DbRuntime {
  driver: DbDriver;
  describe: string;
  url_masked: string;
  sqlite_file: string;
}

export interface DbStatus {
  config: DbConfig;
  runtime: DbRuntime;
  tables: string[];
  table_count: number;
  /** 配置里写的驱动 ≠ 进程实际用的驱动（说明改了还没重启） */
  pending_restart: boolean;
  reachable: boolean;
  error: string | null;
  config_path: string;
  file_based: boolean;
}

export interface DbDriverInfo {
  key: DbDriver;
  label: string;
  hint: string;
  fields: string[];
  default_port: number;
}

export interface DbTestResult {
  ok: boolean;
  stage: string;
  problems: string[];
  target?: string;
  database_exists?: boolean | null;
  created_database?: boolean;
  tables?: string[];
  table_count?: number;
  server_version?: string | null;
  error: string | null;
}

/** GET /api/credentials/{id}/models 的返回：探测某凭据可用的模型 */
export interface CredentialModelsResult {
  ok: boolean;
  models: string[];
  current: string | null;
  provider?: string;
  /** provider 推荐清单（探测失败时也能给用户一个起点） */
  suggested?: string[];
  latency_ms?: number | null;
  error?: string | null;
}

/** 在「LLM 配置」里直接试聊一段（不经过 Agent）的结果 */
export interface CredentialChatResult {
  ok: boolean;
  model: string | null;
  reply: string | null;
  latency_ms: number | null;
  usage: Record<string, number> | null;
  error: string | null;
}
