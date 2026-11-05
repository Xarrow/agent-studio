/**
 * 执行时间线的排布与措辞（纯函数，可单测）
 * =====================================
 *
 * 后端给的是「一次交互一条」的扁平数组（带 parent_id）。界面要的是
 * "第几层、从哪开始、多宽"。把这些算清楚放在这里，组件只管画。
 *
 * 一个刻意的取舍：**并行不另开泳道**。同一次执行里两个工具并行时，
 * 它们的时间条在同一横轴的不同行上自然叠着——一眼就看得出重叠，
 * 又不占用手机那点宽度。
 */

export type TimelineKind = "llm" | "think" | "tool" | "hitl" | string;

export type TimelineItem = {
  id: string;
  kind: TimelineKind;
  name: string;
  started_at: number;
  ended_at?: number | null;
  duration_ms?: number | null;
  parent_id?: string | null;
  attributes?: Record<string, unknown>;
};

export type TimelineData = {
  items: TimelineItem[];
  started_at: number;
  ended_at: number;
  total_ms: number;
  slowest: TimelineItem | null;
  agent_name?: string | null;
};

export type Row = {
  item: TimelineItem;
  /** 缩进层级：0 = 一轮，1 = 轮内的思考/工具/等待 */
  depth: number;
  /** 相对整段执行的左偏移与宽度（百分比） */
  left: number;
  width: number;
};

export const KIND_LABEL: Record<string, string> = {
  llm: "请求",
  worker: "分派",
  think: "思考",
  tool: "工具",
  hitl: "等你点",
  run: "整次",
};

export const KIND_COLOR: Record<string, string> = {
  llm: "var(--color-accent)",
  worker: "var(--color-accent)",
  think: "var(--color-warn)",
  tool: "var(--color-ok)",
  hitl: "var(--color-err)",
};

/** 层级：顺着 parent_id 往上数（认不出的父级按 0 处理，不报错） */
export function depthOf(items: TimelineItem[]): Map<string, number> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const cache = new Map<string, number>();
  const depth = (item: TimelineItem, guard = 0): number => {
    const hit = cache.get(item.id);
    if (hit !== undefined) return hit;
    if (!item.parent_id || !byId.has(item.parent_id) || guard > 6) {
      cache.set(item.id, 0);
      return 0;
    }
    const d = depth(byId.get(item.parent_id)!, guard + 1) + 1;
    cache.set(item.id, d);
    return d;
  };
  for (const i of items) depth(i);
  return cache;
}

/** 排布：左偏移 / 宽度按整段执行的时长归一（短条给 0.5% 保底，否则看不见） */
export function layout(data: TimelineData): Row[] {
  const items = data.items || [];
  const total = Math.max(data.total_ms || 0, 1);
  const start = data.started_at;
  const depths = depthOf(items);
  return items.map((item) => {
    const d = depths.get(item.id) ?? 0;
    const left = Math.max(0, Math.min(100, ((item.started_at - start) / total) * 100));
    const dur = item.duration_ms ?? Math.max(0, (item.ended_at ?? item.started_at) - item.started_at);
    const width = Math.max(Math.min((dur / total) * 100, 100 - left), 0.5);
    return { item, depth: d, left, width };
  });
}

/** 一行右侧的一句话摘要：先让用户判断"是不是这条"，再决定点不点 */
export function digest(item: TimelineItem): string {
  const a = (item.attributes || {}) as Record<string, any>;
  switch (item.kind) {
    case "llm": {
      const bits: string[] = [];
      if (a.model) bits.push(String(a.model));
      if (a.tokens_in || a.tokens_out) bits.push(`${fmtTokens(a.tokens_in)} → ${fmtTokens(a.tokens_out)}`);
      if (a.ttft_ms) bits.push(`首字 ${fmtSeconds(a.ttft_ms)}`);
      if (a.cache_read) bits.push(`缓存 ${fmtTokens(a.cache_read)}`);
      if (a.status === "error") bits.push("失败");
      return bits.join(" · ");
    }
    case "think":
      return a.chars ? `${fmtTokens(a.chars)} 字` : "";
    case "tool": {
      const bits: string[] = [];
      if (a.status === "error") bits.push("失败");
      if (a.args_preview) bits.push(String(a.args_preview).slice(0, 60));
      return bits.join(" · ");
    }
    case "worker": {
      const bits: string[] = [];
      if (a.status && a.status !== "ok") bits.push(String(a.status));
      if (a.tokens_in || a.tokens_out) bits.push(`${fmtTokens(a.tokens_in)} → ${fmtTokens(a.tokens_out)}`);
      bits.push("点开看这一路的执行");
      return bits.join(" · ");
    }
    case "hitl": {
      const bits: string[] = [];
      if (a.decision) bits.push(`你选了${a.decision}`);
      if (a.waited_ms) bits.push(`等了 ${fmtSeconds(a.waited_ms)}`);
      return bits.join(" · ");
    }
    default:
      return "";
  }
}

/** 时间：超过 1 分钟给「1:23」，否则「12.4s」——比一律毫秒好读 */
export function fmtSeconds(ms: number | null | undefined): string {
  const n = Math.max(0, Number(ms || 0));
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(n / 60_000);
  const s = Math.round((n % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtTokens(n: number | null | undefined): string {
  const v = Number(n || 0);
  if (!v) return "0";
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}

/** 顶部那句话：总耗时 + 最慢的一条（占比） */
export function headline(data: TimelineData): string {
  if (!data.items?.length) return "这次执行没有留下过程记录。";
  const parts = [`总 ${fmtSeconds(data.total_ms)}`];
  const slow = data.slowest;
  if (slow && slow.duration_ms) {
    const pct = Math.round((slow.duration_ms / Math.max(data.total_ms, 1)) * 100);
    parts.push(`最慢：${labelOf(slow)} ${fmtSeconds(slow.duration_ms)}（${pct}%）`);
  }
  const hitl = data.items.filter((i) => i.kind === "hitl").reduce((s, i) => s + (i.duration_ms || 0), 0);
  if (hitl) parts.push(`其中等你点 ${fmtSeconds(hitl)}`);
  return parts.join(" · ");
}

export function labelOf(item: TimelineItem): string {
  const a = (item.attributes || {}) as Record<string, any>;
  if (item.kind === "llm") {
    const iter = a.iteration;
    return `第 ${iter || "?"} 轮${a.model ? ` · ${a.model}` : ""}`;
  }
  // 派活类工具带上"派给谁"：时间和颜色都要能落到某个助手身上
  if (item.kind === "worker") return a.agent || item.name;
  if (a.agent) return `${item.name || "派活"} → ${a.agent}`;
  return item.name || KIND_LABEL[item.kind] || item.kind;
}

/** 时间线里出现过的被派助手（按首次出现顺序）—— 颜色按这个顺序发 */
export function agentsIn(items: TimelineItem[]): string[] {
  const seen: string[] = [];
  for (const it of items) {
    const agent = (it.attributes || {}).agent;
    if (typeof agent === "string" && agent.trim() && !seen.includes(agent.trim())) seen.push(agent.trim());
  }
  return seen;
}
