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

import { useEffect, useMemo, useState } from "react";

import type { RunEvent } from "@/lib/types";
import Markdown from "@/components/Markdown";
import { isImagePath, isProductPath, workImageUrls } from "@/lib/work-paths";

export type StepKind =
  | "input"
  | "think"
  | "tool"
  | "tool_response"
  | "output"
  | "error"
  | "hitl"
  | "fallback"
  | "artifact";

export interface Step {
  kind: StepKind;
  label: string;
  body: string;
  /** 工具是否执行成功（有 tool_exec_end 时才有） */
  ok?: boolean;
  /** 产物相对路径（kind=artifact 时有）—— 相对工作目录根 */
  artifactPath?: string;
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
  fallback: {
    icon: "⇄",
    color: "#b45309",
    bg: "#fffbeb",
    border: "#fde68a",
  },
  tool: {
    icon: "⚙",
    color: "#2563eb",
    bg: "#eff6ff",
    border: "#bfdbfe",
  },
  artifact: {
    icon: "▣",
    color: "#047857",
    bg: "#ecfdf5",
    border: "#a7f3d0",
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
  kind: "text" | "think" | "tool" | "tool_res" | "error" | "hitl" | "fallback";
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

  /* 按 (kind, tool_call_id) 直接查最后一个块。
   *
   * 原来是 `[...blocks].reverse().find(...)` —— **每个 tool 增量事件都整表拷贝一次**，
   * 6000 个事件的 run 就是千万级对象拷贝，而且这函数在对话页每次渲染都要跑一遍
   * （流式期间每秒好几次）。这是标签页被拖死/Aw-Snap 的主要来源之一。
   * 现在建索引：查是 O(1)，整体回到 O(n)。 */
  const lastIdx = new Map<string, Blk>();
  const idxKey = (kind: Blk["kind"], id?: string) => `${kind}\u0000${id ?? ""}`;
  const remember = (b: Blk) => {
    if (b.kind === "tool" || b.kind === "tool_res") lastIdx.set(idxKey(b.kind, b.toolId), b);
  };
  const lastByTool = (kind: Blk["kind"], id?: string) => lastIdx.get(idxKey(kind, id));

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
      const b: Blk = {
        kind: "tool",
        text: "",
        name: str(p.tool_call_name) || str(p.name) || "工具",
        toolId: str(p.tool_call_id) || undefined,
      };
      blocks.push(b);
      remember(b);
      cur = b;
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
        const nb: Blk = { kind: "tool_res", text: d, toolId: id };
        blocks.push(nb);
        remember(nb);
        cur = nb;
      }
    } else if (t === "tool_exec_end") {
      // 标记上一个工具结果的成功/失败
      const id = str(p.tool_call_id) || undefined;
      const b = lastByTool("tool_res", id);
      const state = str(p.state);
      if (b) b.ok = state ? state === "success" || state === "ok" : undefined;
      // tool 块同样记成功态（产物卡要靠它：失败的工具不产出物）
      const tb = lastByTool("tool", id);
      if (tb) tb.ok = b ? b.ok : undefined;
    } else if (t === "error") {
      const msg = str(p.message) || str(p.error) || "执行出错";
      blocks.push((cur = { kind: "error", text: msg }));
    } else if (t === "model_fallback") {
      const from = str(p.from) || "主模型";
      const to = str(p.to) || "备用模型";
      const why = str(p.reason) || "";
      blocks.push({
        kind: "fallback",
        text: `主模型 ${from} 不可用${why ? `（${why}）` : ""}，已改用 ${to} 重跑这一轮`,
      });
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
      // 写文件类工具 + 落在产物目录 + 执行成功 → 紧跟一张「产物」卡，
      // 让 agent 写的图片/文件**在对话里直接看**（不用去服务器翻目录）。
      if (b.ok !== false) {
        const artifact = parseArtifact(b.name, b.text);
        if (artifact) {
          steps.push({
            kind: "artifact",
            label: "产物",
            body: artifact.rel,
            artifactPath: artifact.rel,
          });
        }
      }
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
    } else if (b.kind === "fallback") {
      steps.push({ kind: "fallback", label: "换模型", body: b.text });
    }
  });

  return steps;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}


/**
 * 从工具调用里提取产物：Write/Edit（args 的 file_path）落在工作目录内才认。
 * args 是流式拼回的 JSON，可能不完整 —— 解析失败返回 null，不出卡（宁缺毋滥）。
 * 返回相对工作目录的路径（后端 /api/work/file 按这个取）。
 */
function parseArtifact(
  toolName: string | undefined,
  argsText: string,
): { rel: string } | null {
  if (!toolName || !["Write", "Edit"].includes(toolName) || !argsText) return null;
  try {
    const args = JSON.parse(argsText) as { file_path?: string };
    const fp = args.file_path;
    if (!fp) return null;
    const m = /\/data\/work\/(.+)$/.exec(fp);
    const rel = m ? m[1] : fp.replace(/^\//, "");
    if (!rel || rel.includes("..") || !isProductPath(rel)) return null;
    return { rel };
  } catch {
    return null;
  }
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
  running = false,
}: {
  steps: Step[];
  compact?: boolean;
  /** 还在跑：最后一步按类型给动效 */
  running?: boolean;
}) {
  if (steps.length === 0) return null;

  return (
    <div className={compact ? "space-y-1" : "space-y-2"}>
      {steps.map((s, i) => (
        <TimelineRow
          key={i}
          s={s}
          compact={compact}
          isLast={i === steps.length - 1}
          active={running && i === steps.length - 1}
        />
      ))}
    </div>
  );
}

/** 单条：长的折叠（点开看全文），正文按性质选字体 —— 人看思考用正文字体，
 *  工具参数/结果才用 mono。失败的工具红框标出来，扫一眼就知道哪步坏了。 */
function TimelineRow({
  s,
  compact,
  isLast,
  active = false,
}: {
  s: Step;
  compact: boolean;
  isLast: boolean;
  /** 正在跑的就是这一行（只给最新一步）→ 按类型给不同动效 */
  active?: boolean;
}) {
  const st = STEP_STYLE[s.kind];
  const isErr = s.kind === "tool" && s.ok === false;
  const bodyLines = s.body ? s.body.split("\n") : [];
  const long = bodyLines.length > 6 || s.body.length > 400;
  const [open, setOpen] = useState(false);
  const monoBody = s.kind === "tool" || s.kind === "tool_response";
  return (
    <div
      className="proc-row flex gap-2.5"
      data-active={active ? "1" : "0"}
      data-kind={s.kind}
      style={{ ["--proc-kind-color" as string]: st.color }}
    >
      {/* 左侧：图标 + 连接线（把"一连串步骤"这件事视觉化） */}
      <div className="flex flex-col items-center shrink-0">
        <div
          className="relative w-6 h-6 rounded-md flex items-center justify-center text-[12px] shrink-0"
          style={{
            background: isErr ? "#fef2f2" : st.bg,
            color: isErr ? "#b91c1c" : st.color,
            border: `1px solid ${isErr ? "#fecaca" : st.border}`,
          }}
        >
          {/* 工具在跑：虚线环转起来（"这步在动"）；思考：三个点呼吸；
              两者形态不同，一眼分得清是"在想"还是"在做" */}
          {active && s.kind === "tool" && <span className="proc-run-ring" aria-hidden="true" />}
          {active && s.kind === "think" ? (
            <span className="proc-think-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          ) : (
            <KindIcon kind={s.kind} />
          )}
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
        {s.kind === "artifact" && s.artifactPath ? (
          /* 产物卡：图片直接内联显示，其他文件给可点链接（后端 /api/work/file） */
          <div>
            <span
              className="text-[12px] font-medium mb-0.5 block"
              style={{ color: st.color }}
            >
              产物 · {s.artifactPath.split("/").pop()}
            </span>
            {isImagePath(s.artifactPath) ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={`/api/work/file/${s.artifactPath}`}
                alt={s.artifactPath.split("/").pop()}
                className="max-h-56 rounded-md border my-1"
                style={{ borderColor: st.border }}
              />
            ) : (
              <a
                href={`/api/work/file/${s.artifactPath}`}
                target="_blank"
                rel="noreferrer"
                className="text-[12px] underline underline-offset-2 inline-flex min-h-[32px] items-center lg:min-h-0"
                style={{ color: st.color }}
              >
                {s.artifactPath.split("/").pop()}
              </a>
            )}
          </div>
        ) : (
        <>
        <button
          type="button"
          data-tap
          className="text-[12px] font-medium mb-0.5 inline-flex min-h-[32px] min-w-[32px] items-center gap-1 text-left lg:min-h-0"
          style={{ color: isErr ? "#b91c1c" : st.color }}
          onClick={() => long && setOpen(!open)}
        >
          {s.label}
          {isErr && (
            <span
              className="rounded px-1 text-[10.5px]"
              style={{ background: "#fef2f2", color: "#b91c1c" }}
            >
              失败
            </span>
          )}
          {long && (
            <span className="text-[10.5px] font-normal" style={{ color: "var(--color-muted)" }}>
              {open ? "收起" : "展开全部"}
            </span>
          )}
        </button>
        {long && !open ? (
          <div
            className={`text-[12px] leading-relaxed whitespace-pre-wrap break-words ${monoBody ? "mono" : ""}`}
            style={{ color: "var(--color-text)" }}
          >
            {bodyLines.slice(0, 6).join("\n") + "\n…"}
          </div>
        ) : monoBody ? (
          /* 工具调用 / 工具结果：原样等宽（是日志，重排反而看不清） */
          <div
            className="text-[12px] leading-relaxed whitespace-pre-wrap break-words mono"
            style={{ color: "var(--color-text)" }}
          >
            {s.body}
          </div>
        ) : (
          /* 思考 / 回答这类正话：走 Markdown（图片、列表、加粗、公式都能显示） */
          <div className="text-[12px] leading-relaxed" style={{ color: "var(--color-text)" }}>
            <Markdown text={s.body} />
          </div>
        )}
        {(() => {
          // 这一步的输出里提到了工作目录下的图片 → 直接显示（不要只给路径）
          const urls = workImageUrls(s.body);
          if (!urls.length) return null;
          return (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {urls.map((u) => (
                <a
                  key={u}
                  href={u}
                  target="_blank"
                  rel="noreferrer"
                  data-tap
                  title="点开看原图"
                  className="block"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={u}
                    alt={decodeURIComponent(u.split("/").pop() || "")}
                    loading="lazy"
                    className="max-h-40 rounded-md border"
                    style={{ borderColor: st.border }}
                  />
                </a>
              ))}
            </div>
          );
        })()}
        </>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   过程条（ProcessBar）—— 对话页里执行过程的**唯一**入口
   ---------------------------------------------------------------------------
   用户 2026-10 要求：think / tool / 过程**默认隐藏，只给结果**；
   过程与结果要用不同颜色和样式拉开距离；执行中不同类型的动效也不一样。
   所以这里是「一行摘要 + 点开才看细节」，收起时也能看出它在干什么。
   ═══════════════════════════════════════════════════════════════════════════ */

/** 每类动作的描边图标（12px、1.8 线宽，和全站一致；不用 emoji） */
function KindIcon({ kind, size = 12 }: { kind: StepKind; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "think":
      return (
        <svg {...common}>
          <path d="M12 3a5 5 0 0 0-3 9v3h6v-3a5 5 0 0 0-3-9Z" />
          <path d="M10 20h4" />
        </svg>
      );
    case "tool":
      return (
        <svg {...common}>
          <path d="m4 17 4.5-4.5" />
          <path d="M14 4a4 4 0 0 0 5 5l-9.5 9.5a2.5 2.5 0 0 1-3.5-3.5L14 4Z" />
        </svg>
      );
    case "tool_response":
      return (
        <svg {...common}>
          <path d="M9 10 4 15l5 5" />
          <path d="M20 4v7a4 4 0 0 1-4 4H4" />
        </svg>
      );
    case "fallback":
      return (
        <svg {...common}>
          <path d="M4 8h13l-3-3" />
          <path d="M20 16H7l3 3" />
        </svg>
      );
    case "artifact":
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      );
    case "error":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </svg>
      );
    case "hitl":
      return (
        <svg {...common}>
          <path d="M9 11V6a2 2 0 1 1 4 0v5" />
          <path d="M13 11V5a2 2 0 1 1 4 0v7" />
          <path d="M17 12v-1a2 2 0 1 1 4 0v4a6 6 0 0 1-6 6h-2a6 6 0 0 1-6-6v-3a2 2 0 1 1 4 0" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
        </svg>
      );
  }
}

/** 过程条里的「步骤」＝ 除输入和最终回答之外的一切（回答是结果，不在过程里） */
export function processSteps(steps: Step[]): Step[] {
  return steps.filter((s) => s.kind !== "input" && s.kind !== "output");
}

/** 按类型数一下（收起态的摘要就靠它） */
function tally(steps: Step[]) {
  const n = { think: 0, tool: 0, tool_response: 0, artifact: 0, error: 0, hitl: 0 };
  for (const s of steps) {
    if (s.kind in n) n[s.kind as keyof typeof n] += 1;
  }
  return n;
}

/** 正在跑的时候说人话：先给动作，不给术语 */
function phaseText(steps: Step[], running: boolean): string {
  const n = tally(steps);
  if (running) {
    const last = steps[steps.length - 1];
    if (!last) return "正在启动…";
    // 工具调用还没等到结果 = 正在跑它
    if (last.kind === "tool") {
      const name = last.label.replace(/^调用工具\s*·\s*/, "").trim();
      return name ? `正在运行 ${name}…` : "正在调用工具…";
    }
    if (last.kind === "tool_response") return "工具返回了，继续推进…";
    if (last.kind === "think") return "正在思考…";
    if (last.kind === "artifact") return "写出了一个文件…";
    if (last.kind === "hitl") return "等你在下面确认…";
    if (last.kind === "error") return "这一步失败了…";
    return "正在推进…";
  }
  const parts: string[] = [];
  if (n.think) parts.push(`${n.think} 段思考`);
  if (n.tool) parts.push(`${n.tool} 次工具`);
  if (n.tool_response) parts.push(`${n.tool_response} 条结果`);
  if (n.artifact) parts.push(`${n.artifact} 个产物`);
  if (!parts.length) return "这次没有可展示的过程";
  return parts.join(" · ");
}

/**
 * 过程条：默认收起（只看结果），点开看每一步。
 *
 * @param steps       eventsToSteps() 的结果（内部会剔掉输入与回答）
 * @param running     是否正在执行
 * @param elapsedMs   已耗时 / 总耗时（收起态右侧那个数字）
 * @param detail      展开后在底部的附加动作（例如「完整记录 →」）
 * @param defaultOpen 默认是否展开（一般 false）
 */
export function ProcessBar({
  steps,
  running = false,
  elapsedMs,
  detail,
  usage,
  defaultOpen = false,
  className = "",
  open: openProp,
  onToggle,
  loading = false,
}: {
  steps: Step[];
  running?: boolean;
  elapsedMs?: number;
  detail?: React.ReactNode;
  /** 收起态也要显示的用量（「N tokens」）——审计实测收起行只有耗时，看不出跑了多少 */
  usage?: { tokens: number } | null;
  defaultOpen?: boolean;
  className?: string;
  /** 受控展开（历史消息要懒加载事件，展开动作由外层发起） */
  open?: boolean;
  onToggle?: () => void;
  /** 展开态正在拉事件 */
  loading?: boolean;
}) {
  const [openState, setOpenState] = useState(defaultOpen);
  const controlled = typeof openProp === "boolean";
  const open = controlled ? (openProp as boolean) : openState;
  const [anim, setAnim] = useState(true);

  // 动效开关（localStorage 记住）。读放在 effect 里，避免 SSR/首帧不一致
  useEffect(() => {
    try {
      setAnim(localStorage.getItem("chat.procAnim") !== "0");
    } catch {
      /* 隐私模式下拿不到 localStorage，就当开着 */
    }
  }, []);

  const proc = useMemo(() => processSteps(steps), [steps]);
  const n = tally(proc);
  /** 当前这一步的类型 —— 收起态的动画和颜色都跟着它走 */
  const activeKind: StepKind | null = running
    ? (proc[proc.length - 1]?.kind ?? "think")
    : null;
  const failures = proc.filter((s) => s.kind === "tool" && s.ok === false).length;

  // 受控时（历史消息）即使还没拉到事件也要露出这一行 —— 它自己就是"点开"的入口
  if (proc.length === 0 && !running && !controlled) return null;

  const toggle = () => {
    if (controlled) onToggle?.();
    else setOpenState((v) => !v);
  };
  const saveAnim = (on: boolean) => {
    setAnim(on);
    try {
      localStorage.setItem("chat.procAnim", on ? "1" : "0");
    } catch {
      /* 忽略 */
    }
  };

  return (
    <div
      className={`proc ${className}`}
      data-open={open ? "1" : "0"}
      data-running={running ? "1" : "0"}
      data-anim={anim ? "on" : "off"}
    >
      <button
        type="button"
        data-tap
        className="proc-head"
        onClick={toggle}
        aria-expanded={open}
        style={
          running
            ? ({ ["--proc-active-color" as string]: STEP_STYLE[activeKind ?? "think"].color } as React.CSSProperties)
            : undefined
        }
      >
        {/* 收起态左侧这枚图标 = 当前动作的"心跳"：
              思考 → 紫色三个点波浪；工具 → 蓝色圆弧转圈；工具结果 → 青色弹一下；
              停下 → 三个灰点（静态）。这就是"think / tool 各有各的动画"。 */}
        {running ? (
          <span className="proc-act" aria-hidden="true">
            {activeKind === "tool" ? (
              <>
                <svg
                  className="proc-spin"
                  width={13}
                  height={13}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                >
                  <circle cx="12" cy="12" r="9" strokeDasharray="4 4" opacity="0.9" />
                </svg>
                <span className="proc-spin-dot" />
              </>
            ) : activeKind === "tool_response" || activeKind === "artifact" ? (
              <svg
                className="proc-pop"
                width={13}
                height={13}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 10 4 15l5 5" />
                <path d="M20 4v7a4 4 0 0 1-4 4H4" />
              </svg>
            ) : activeKind === "error" ? (
              <svg
                width={13}
                height={13}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v4" />
                <path d="M12 16h.01" />
              </svg>
            ) : (
              <span className="proc-think-dots">
                <i />
                <i />
                <i />
              </span>
            )}
          </span>
        ) : (
          <span className="proc-dots" style={{ color: "#8b93a1" }} aria-hidden="true">
            <span className="proc-dot" />
            <span className="proc-dot" />
            <span className="proc-dot" />
          </span>
        )}

        <span className="proc-title">
          {running
            ? phaseText(proc, true)
            : proc.length === 0
              ? loading
                ? "执行过程 · 加载中…"
                : "执行过程 · 点开看每一步"
              : `执行过程 · ${phaseText(proc, false)}`}
        </span>

        {failures > 0 && (
          <span
            className="shrink-0 rounded px-1 text-[10.5px] font-medium"
            style={{ background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca" }}
          >
            {failures} 步失败
          </span>
        )}

        {usage && usage.tokens > 0 && (
          <span className="shrink-0 text-[11px]" style={{ color: "var(--color-muted)" }}>
            {new Intl.NumberFormat("en-US").format(usage.tokens)} tokens
          </span>
        )}

        {typeof elapsedMs === "number" && elapsedMs > 0 && (
          <span className="proc-time">{fmtDuration(elapsedMs)}</span>
        )}

        <svg
          className="proc-chev"
          width={12}
          height={12}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      </button>

      {open && (
        <div className="proc-body">
          {loading && proc.length === 0 ? (
            <div className="text-[12px]" style={{ color: "var(--color-muted)" }}>
              正在加载这一步的过程…
            </div>
          ) : (
            <RunTimeline steps={proc} running={running} />
          )}
          <div className="mt-2 flex items-center gap-3 flex-wrap">
            {detail}
            <button
              type="button"
              data-tap
              className="ml-auto text-[11.5px] inline-flex items-center gap-1.5"
              style={{ color: anim ? "var(--color-accent)" : "var(--color-muted)" }}
              onClick={() => saveAnim(!anim)}
              title="执行动效（思考 / 工具 / 结果）"
            >
              <span
                className="relative inline-flex items-center rounded-full transition-colors"
                style={{
                  width: 26,
                  height: 15,
                  background: anim ? "var(--color-accent)" : "#cbd2dc",
                }}
              >
                <span
                  className="absolute rounded-full bg-white transition-transform"
                  style={{
                    width: 11,
                    height: 11,
                    left: 2,
                    transform: anim ? "translateX(11px)" : "translateX(0)",
                  }}
                />
              </span>
              动效
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 刚跑完的那一轮，摘要先放内存里。
 *
 * 历史消息的事件是**点开才拉**的（一进对话页不发 N 个请求），所以收起态只有
 * 「点开看每一步」；可用户刚看着它跑完，这一行立刻变成没有信息量的字样很怪。
 * 这里把刚结束那轮的结果记一下，气泡首帧就能显示"2 段思考 · 2 次工具 · 7.0s"。
 * 刷新页面后没有了也无所谓 —— 点开照样能拉到。
 */
const PROC_MEMO = new Map<string, { steps: Step[]; ms: number }>();

export function rememberProc(runId: string, steps: Step[], ms: number): void {
  if (!runId) return;
  PROC_MEMO.set(runId, { steps, ms });
  if (PROC_MEMO.size > 50) {
    // 只要最近几十轮，别无限长
    const oldest = PROC_MEMO.keys().next().value;
    if (oldest) PROC_MEMO.delete(oldest);
  }
}

export function recallProc(runId: string): { steps: Step[]; ms: number } | null {
  return PROC_MEMO.get(runId) ?? null;
}

/** 毫秒 → 1.2s / 12s / 2m03s（收起态那个数字，别给 ms） */
function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 0.1) return "0.1s";
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return `${m}m${String(rest).padStart(2, "0")}s`;
}
