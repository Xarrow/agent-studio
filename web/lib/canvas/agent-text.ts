/**
 * 画布上的"说人话"小函数：一句话职责、推荐打分、运行中状态、待确认提示。
 *
 * 从 WorkflowCanvas.tsx 搬出来（纯函数、零 React 依赖），
 * 现在有 agent-text.test.ts 钉着。
 */

import type { NodeLiveInfo } from "@/components/StepExecPanel";
import type { StepKind } from "@/components/ui/run-timeline";
import type { Agent } from "@/lib/types";

export function blurbOf(a: Agent): string {
  const d = (a.description ?? "").trim();
  if (d) return d;
  const raw = (a.definition?.system_prompt ?? "").trim().replace(/\s+/g, " ");
  if (!raw) return "";
  // 去掉开头的套话（"你是一个 xxx agent，" / "你是助手。"），留下实质那句
  const stripped = raw.replace(/^(你是一个|你是一位|你是)[^，,。.;；]{0,24}[，,。.;；]\s*/, "");
  const first = (stripped || raw).split(/[。\n!?；;]/)[0] || stripped || raw;
  const t = first.trim().replace(/^[，,、]\s*/, "");
  return t.length > 52 ? t.slice(0, 52) + "…" : t;
}

/** 能力信号：给**名字**，不给"8 个"——名字才能让人判断，数字只让人感觉多 */
export function skillsOf(a: Agent, toolNames: Record<string, string>): string[] {
  const out: string[] = [];
  for (const t of a.definition?.tools ?? []) {
    if (t.enabled === false) continue;
    const n = toolNames[t.ref];
    if (n) out.push(n);
  }
  return out.slice(0, 4);
}

/** 推荐打分：任务文本 vs 助手的名字/职责/提示词/工具名。
 *  中文没有空格，用**二元组**做近似（零依赖下够用）；英文按下划线词整词匹配（权重更高）。 */
export function recScore(a: Agent, task: string, toolNames: Record<string, string>): number {
  const t = (task || "").trim();
  if (t.length < 2) return 0;
  const hay = (
    a.name +
    " " +
    (a.description ?? "") +
    " " +
    (a.definition?.system_prompt ?? "") +
    " " +
    (a.definition?.tools ?? []).map((x) => toolNames[x.ref] ?? "").join(" ")
  ).toLowerCase();
  let score = 0;
  for (const w of t.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? []) if (hay.includes(w)) score += 3;
  for (let i = 0; i < t.length - 1; i++) {
    const bg = t.slice(i, i + 2);
    if (/^[\u4e00-\u9fa5]{2}$/.test(bg) && hay.includes(bg)) score += 1;
  }
  return score;
}

/** 运行中状态行的**人话**短语：不再直接贴原始事件文本（长句在窄卡里会被截得看不懂）。
 *  按阶段给动词，尽量把工具名带出来 —— 一眼知道"现在到底在干嘛"。 */
export function liveLabel(kind: string, text: string): string {
  const tool = (text.match(/[a-z][a-z0-9]*_[a-z0-9_]+/i) ?? [])[0];
  switch (kind) {
    case "input":
      return "收到任务…";
    case "think":
      return "正在思考…";
    case "tool":
      return tool ? `正在调用 ${tool}` : "正在调用工具…";
    case "tool_out":
      return tool ? `${tool} 已返回，正在整理…` : "已拿到结果，正在整理…";
    case "answer":
    case "out":
      return "正在回答…";
    default:
      return text.length > 26 ? `${text.slice(0, 26)}…` : text;
  }
}

/** 取"用户摆过的"数值：是有限数字才用，否则回退自动值 */
export function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** 节点上的「实时尾巴」：从最近的事件里挑 2~3 行，说清"它此刻正在干什么"。
 *
 *  为什么需要它：老版节点把整段产出贴在卡上（太吵，被砍掉了）；砍完只剩一行摘要
 *  （`⟳ 2.3s 思考中…`）—— 于是执行中**看不见过程**（用户原话）。
 *  这里取中间：**跑的时候给尾巴（最近一次工具调用 + 当前思考/输出），跑完只留一行摘要**。
 *  事件是流式的 delta（每次几个字），所以按"末尾连续同类型"回卷累积，才拼得出完整一句。 */
export function tailOf(evts: NodeLiveInfo["events"], max = 3): { kind: StepKind; text: string }[] {
  type Ev = { type?: string; payload?: Record<string, unknown> };
  const list = evts as unknown as Ev[];
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  /** 单行化 + 截断（保留**尾部**：正在发生的东西在末尾） */
  const one = (t: string, n = 52) => {
    const x = t.replace(/\s+/g, " ").trim();
    return x.length > n ? `…${x.slice(-n)}` : x;
  };

  const lines: { kind: StepKind; text: string }[] = [];

  // ① 最近一次工具调用（入参 + 返回）—— 分两类颜色：发出是"工具"，回来是"工具输出"
  let lastToolAt = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].type === "tool_call_start" || list[i].type === "tool_exec_start") {
      lastToolAt = i;
      break;
    }
  }
  if (lastToolAt >= 0) {
    const name = str(list[lastToolAt].payload?.tool_call_name);
    let args = "";
    let result = "";
    for (let i = lastToolAt; i < list.length; i++) {
      if (list[i].type === "tool_call_args") args += str(list[i].payload?.delta);
      else if (list[i].type === "tool_result_delta") result += str(list[i].payload?.delta);
    }
    if (name) lines.push({ kind: "tool", text: `${name} ${one(args, 32)}` });
    if (result.trim()) {
      const firstLine = result.split("\n").find((x) => x.trim()) ?? result;
      lines.push({ kind: "tool_response", text: one(firstLine) });
    }
  }

  // ② 当前正在说的：输出优先，没有就显示思考（两类颜色不同）
  const runOf = (type: string) => {
    let acc = "";
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].type === type) acc = str(list[i].payload?.delta) + acc;
      else if (acc) break;
    }
    return acc;
  };
  const out = runOf("text_delta");
  const think = runOf("thinking_delta");
  if (out.trim()) lines.push({ kind: "output", text: one(out) });
  else if (think.trim()) lines.push({ kind: "think", text: one(think) });

  return lines.slice(-max);
}

/** 详情里的一片：**输入 / 思考 / 调用 / 回复** 各一段、各一色。
 *
 *  用户："点击 agent 可以查看执行的详情，input，think，call，response 完整的详情通过不同颜色区分"。
 *  配色复用全站 STEP_STYLE（输入蓝 / 思考紫 / 调用橙 / 工具输出青 / 回复绿 / 出错红），
 *  和 Runs 页、日志里的分色同一套 —— 同一个概念全站同色 ✓ */
/** 压成一行并截断（详情里的小块文字用；超长就截 + 省略号） */
export function clip(v: unknown, n: number): string {
  const t = String(v ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 把待确认的调用说人话：input 可能是对象，也可能是 JSON 字符串（AgentScope 两种都给） */
export function hitlText(payload: Record<string, unknown> | null | undefined): string {
  const calls = (payload?.tool_calls as { name?: string; input?: unknown }[] | undefined) ?? [];
  if (!calls.length) return "（等待确认）";
  const c = calls[0];
  let input: Record<string, unknown> | null = null;
  if (c.input && typeof c.input === "object") input = c.input as Record<string, unknown>;
  else if (typeof c.input === "string") {
    try {
      const parsed = JSON.parse(c.input) as unknown;
      if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
    } catch {
      /* 不是 JSON 就原样显示 */
    }
  }
  if (!input) return `${c.name ?? "工具"} ${String(c.input ?? "").slice(0, 120)}`;
  const key = ["command", "file_path", "path", "url", "query"].find((k) => typeof input![k] === "string");
  return key ? `${c.name} · ${key}: ${String(input[key])}` : `${c.name} ${JSON.stringify(input).slice(0, 120)}`;
}
