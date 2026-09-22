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
