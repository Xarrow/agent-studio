"use client";

/**
 * 执行过程时间线 —— 把一次执行拆成可读的段落，每段一个颜色。
 *
 *   ▶ 输入      （蓝）你说的话
 *   ◆ 思考      （紫）它在想什么
 *   ⚙ 调用工具  （橙）它要动手做什么、参数是什么
 *   ◀ 工具结果  （青）工具回了什么
 *   ● 回答      （绿）最终给你的答复
 *   ✕ 出错      （红）
 *   ? 等待确认  （黄）需要你先点头
 *
 * 为什么按颜色分段：一次执行里的这些步骤性质完全不同 ——
 * 「它想的」不等于「它做的」，「它做的」不等于「工具回的」，
 * 混在一段文字里根本读不出来。分色之后，扫一眼就知道它卡在哪一步。
 *
 * 数据来源是后端的**统一事件流**（runtime 无关）：不管底层是 AgentScope
 * 还是别的框架，平台层看到的都是同样的事件类型，所以这里的分段逻辑对
 * 所有运行时通用。
 *
 * 归一化规则（事件 → 段落）
 * ------------------------
 *   text_delta（它之后还有工具调用）  → 思考
 *   tool_call_start + tool_call_args  → 调用工具（合并成一段）
 *   tool_result_delta + tool_exec_end → 工具结果（合并成一段）
 *   text_delta（整段里的最后一块）    → 回答
 *   error / hitl_request              → 出错 / 等待确认
 */

import type { RunEvent } from "@/lib/types";

export type StepKind =
  | "input"
  | "think"
  | "tool"
  | "tool_response"
  | "output"
  | "error"
  | "hitl";

export interface Step {
  kind: StepKind;
  label: string;
  body: string;
  /** 工具是否执行成功（有 tool_exec_end 时才有） */
  ok?: boolean;
}

/** 每类的图标与配色（浅色主题下都保证可读） */
export const STEP_STYLE: Record<
  StepKind,
  { icon: string; color: string; bg: string; border: string }
> = {
  input: {
    icon: "▶",
    color: "#1d4ed8",
    bg: "#eff6ff",
    border: "#bfdbfe",
  },
  think: {
    icon: "◆",
    color: "#6d28d9",
    bg: "#f5f3ff",
    border: "#ddd6fe",
  },
  tool: {
    icon: "⚙",
    color: "#c2410c",
    bg: "#fff7ed",
    border: "#fed7aa",
  },
  tool_response: {
    icon: "◀",
    color: "#0e7490",
    bg: "#ecfeff",
    border: "#a5f3fc",
  },
  output: {
    icon: "●",
    color: "#15803d",
    bg: "#f0fdf4",
    border: "#bbf7d0",
  },
  error: {
    icon: "✕",
    color: "#b91c1c",
    bg: "#fef2f2",
    border: "#fecaca",
  },
  hitl: {
    icon: "?",
    color: "#a16207",
    bg: "#fffbeb",
    border: "#fde68a",
  },
};

/** 内部：把连续的事件压成"块" */
interface Blk {
  kind: "text" | "think" | "tool" | "tool_res" | "error" | "hitl";
  text: string;
  name?: string;
  toolId?: string;
  ok?: boolean;
}

/**
 * 统一事件流 → 可读的步骤列表。
 *
 * @param events   该次执行的全部事件（按 seq 升序）
 * @param userInput 用户这次说的话（可选；会作为第一段「输入」）
 */
export function eventsToSteps(events: RunEvent[], userInput?: string): Step[] {
  const blocks: Blk[] = [];
  let cur: Blk | null = null;

  const lastByTool = (kind: Blk["kind"], id?: string) =>
    [...blocks].reverse().find((b) => b.kind === kind && b.toolId === id);

  for (const ev of events) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const t = ev.type;

    if (t === "text_delta") {
      const d = str(p.delta) || str(p.text);
      if (!d) continue;
      if (cur?.kind === "text") cur.text += d;
      else blocks.push((cur = { kind: "text", text: d }));
    } else if (t === "thinking_delta" || t === "think_delta") {
      const d = str(p.delta) || str(p.text);
      if (!d) continue;
      if (cur?.kind === "think") cur.text += d;
      else blocks.push((cur = { kind: "think", text: d }));
    } else if (t === "tool_call_start") {
      blocks.push(
        (cur = {
          kind: "tool",
          text: "",
          name: str(p.tool_call_name) || str(p.name) || "工具",
          toolId: str(p.tool_call_id) || undefined,
        }),
      );
    } else if (t === "tool_call_args") {
      const d = str(p.delta);
      if (d) {
        const b = lastByTool("tool", str(p.tool_call_id) || undefined);
        if (b) b.text += d;
      }
    } else if (t === "tool_call_end") {
      // 参数收完，无额外内容
    } else if (t === "tool_result_delta") {
      const d = str(p.delta);
      const id = str(p.tool_call_id) || undefined;
      const b = lastByTool("tool_res", id);
      if (b) {
        if (d) b.text += d;
      } else if (d) {
        blocks.push((cur = { kind: "tool_res", text: d, toolId: id }));
      }
    } else if (t === "tool_exec_end") {
      // 标记上一个工具结果的成功/失败
      const b = lastByTool("tool_res", str(p.tool_call_id) || undefined);
      const state = str(p.state);
      if (b) b.ok = state ? state === "success" || state === "ok" : undefined;
    } else if (t === "error") {
      const msg = str(p.message) || str(p.error) || "执行出错";
      blocks.push((cur = { kind: "error", text: msg }));
    } else if (t === "hitl_request") {
      const q = str(p.question) || str(p.message) || str(p.prompt) || "等待你确认后才能继续";
      blocks.push((cur = { kind: "hitl", text: q }));
    }
  }

  // 最后一块正文 = 最终回答；中间出现的正文 = 思考（它边想边说）
  const textIdxs = blocks
    .map((b, i) => (b.kind === "text" ? i : -1))
    .filter((i) => i >= 0);
  const lastText = textIdxs.length > 0 ? textIdxs[textIdxs.length - 1] : -1;

  const steps: Step[] = [];
  if (userInput?.trim()) {
    steps.push({ kind: "input", label: "输入", body: userInput.trim() });
  }

  blocks.forEach((b, i) => {
    const body = b.text.trim();
    if (b.kind === "text") {
      if (i === lastText) steps.push({ kind: "output", label: "回答", body });
      else if (body) steps.push({ kind: "think", label: "思考", body });
    } else if (b.kind === "think") {
      if (body) steps.push({ kind: "think", label: "思考", body });
    } else if (b.kind === "tool") {
      steps.push({
        kind: "tool",
        label: `调用工具 · ${b.name ?? "工具"}`,
        body: body || "（无参数）",
      });
    } else if (b.kind === "tool_res") {
      steps.push({
        kind: "tool_response",
        label: b.ok === false ? "工具结果（失败）" : "工具结果",
        body: body || "（空结果）",
        ok: b.ok,
      });
    } else if (b.kind === "error") {
      steps.push({ kind: "error", label: "出错", body: b.text });
    } else if (b.kind === "hitl") {
      steps.push({ kind: "hitl", label: "等待确认", body: b.text });
    }
  });

  return steps;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 步骤统计（用于折叠时的一行摘要） */
export function summarize(steps: Step[]): string {
  const n = { think: 0, tool: 0, out: 0 };
  for (const s of steps) {
    if (s.kind === "think") n.think++;
    else if (s.kind === "tool") n.tool++;
    else if (s.kind === "output") n.out++;
  }
  const parts: string[] = [];
  if (n.think) parts.push(`${n.think} 段思考`);
  if (n.tool) parts.push(`${n.tool} 次工具调用`);
  parts.push(n.out ? "已给出回答" : "未完成");
  return parts.join(" · ");
}

/**
 * 按颜色渲染执行过程。
 *
 * @param steps   eventsToSteps() 的结果
 * @param compact 生成中（流式）用：更紧凑、不显示左侧连接线
 */
export function RunTimeline({
  steps,
  compact = false,
}: {
  steps: Step[];
  compact?: boolean;
}) {
  if (steps.length === 0) return null;

  return (
    <div className={compact ? "space-y-1" : "space-y-2"}>
      {steps.map((s, i) => {
        const st = STEP_STYLE[s.kind];
        const isLast = i === steps.length - 1;
        return (
          <div key={i} className="flex gap-2.5">
            {/* 左侧：图标 + 连接线（把"一连串步骤"这件事视觉化） */}
            <div className="flex flex-col items-center shrink-0">
              <div
                className="w-6 h-6 rounded-md flex items-center justify-center text-[11px] shrink-0"
                style={{
                  background: st.bg,
                  color: st.color,
                  border: `1px solid ${st.border}`,
                }}
              >
                {st.icon}
              </div>
              {!isLast && !compact && (
                <div
                  className="w-px flex-1 min-h-[6px] my-0.5"
                  style={{ background: st.border }}
                />
              )}
            </div>

            {/* 右侧：标签 + 内容 */}
            <div className="min-w-0 flex-1 pb-1">
              <div
                className="text-[11.5px] font-medium mb-0.5"
                style={{ color: st.color }}
              >
                {s.label}
              </div>
              <div
                className="text-[12.5px] leading-relaxed whitespace-pre-wrap break-words mono"
                style={{ color: "var(--color-text)" }}
              >
                {s.body}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
