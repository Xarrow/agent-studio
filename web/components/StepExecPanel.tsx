"use client";

/**
 * 编排里**每一个助手**的执行面板 —— 思考 / 工具 / 输出 / 日志 一屏看全。
 *
 * 为什么做成"每个助手一格"而不是一条总流水
 * --------------------------------------
 * 编排跑起来以后，人想知道的是"**这一步**在干什么、它想了什么、调了什么、说了什么"。
 * 摊成一条按时间排的总流水，多助手一交错就什么都看不出来（谁在说话都得靠猜）。
 * 所以按助手切块：块头给这一格的结论（状态/耗时/轮数/工具数），块内按
 * 思考 → 工具 → 输出 的顺序摊开 —— 这三样正是"看懂一步"的最小集合。
 *
 * 日志放在最后且默认折叠：它是给排障看的证据，不是给人读的正文。
 *
 * 数据来源：`/api/runs/trace/{run_id}`（一次拿全：事件流 + LLM 调用 + 工具调用）。
 * 运行中的步骤会轻量轮询，所以思考和输出是**边跑边出现**的。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { Hint } from "@/components/ui/hint";

type TraceEvent = { seq: number; type: string; ts: number; payload?: Record<string, unknown> };
export type TraceData = {
  run?: {
    id: string;
    status: string;
    input?: { text?: string };
    output?: { content?: string };
    usage?: Record<string, number>;
    error?: string | null;
    started_at?: number;
    ended_at?: number | null;
  };
  agent_name?: string;
  events?: TraceEvent[];
  llm_calls?: { iteration?: number; model?: string; duration_ms?: number; tokens_out?: number }[];
};

export type StepBrief = {
  run_id: string;
  agent_name: string;
  status: string;
  input_text?: string | null;
  output_text?: string | null;
  order_index?: number;
};

const fmtMs = (ms?: number | null) =>
  ms == null ? "—" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}秒`;

const statusText: Record<string, string> = {
  pending: "等待",
  running: "执行中",
  ok: "成功",
  error: "失败",
  aborted: "已中断",
  waiting_hitl: "等你确认",
};

const statusColor = (s: string) =>
  s === "ok"
    ? "var(--color-ok)"
    : s === "error"
      ? "var(--color-err)"
      : s === "waiting_hitl"
        ? "var(--color-warn)"
        : s === "running"
          ? "var(--color-accent)"
          : "var(--color-muted)";

/* ── 从事件流里提炼"人要看的三样" ─────────────────────────────────────── */

export function collect(events: TraceEvent[]) {
  let thinking = "";
  let answer = "";
  const tools: { name: string; args: string; state: string; result: string }[] = [];
  const byCall: Record<string, number> = {};

  for (const ev of events) {
    const p = (ev.payload ?? {}) as Record<string, string>;
    if (ev.type === "thinking_delta") thinking += p.delta ?? "";
    else if (ev.type === "text_delta") answer += p.delta ?? "";
    else if (ev.type === "tool_call_start") {
      byCall[p.tool_call_id] = tools.push({
        name: p.tool_call_name || "(未知工具)",
        args: "",
        state: "调用中",
        result: "",
      }) - 1;
    } else if (ev.type === "tool_call_args") {
      const i = byCall[p.tool_call_id];
      if (i != null) tools[i].args += p.delta ?? "";
    } else if (ev.type === "tool_exec_end") {
      const i = byCall[p.tool_call_id];
      if (i != null) tools[i].state = p.state === "success" ? "成功" : (p.state || "结束");
    } else if (ev.type === "tool_result_delta") {
      const i = byCall[p.tool_call_id];
      if (i != null) tools[i].result += p.delta ?? "";
    }
  }
  return { thinking: thinking.trim(), answer: answer.trim(), tools };
}

/** 把工具入参压成一行能看的 —— 挑最要害的那个键（和确认条一个口径） */
function argsLine(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    const key = ["command", "file_path", "path", "url", "query", "pattern"].find(
      (k) => typeof o[k] === "string",
    );
    if (key) return String(o[key]);
    return JSON.stringify(o).slice(0, 200);
  } catch {
    return s.slice(0, 200);
  }
}

const eventLabel: Record<string, string> = {
  run_start: "开始",
  llm_call_start: "请求模型",
  llm_call_end: "模型返回",
  thinking_delta: "思考（增量）",
  text_delta: "输出（增量）",
  tool_call_start: "准备调用工具",
  tool_call_args: "工具参数（增量）",
  tool_exec_start: "执行工具",
  tool_exec_end: "工具结束",
  tool_result_delta: "工具结果（增量）",
  hitl_request: "等你确认",
  run_end: "结束",
};

const hhmmss = (ts: number) => new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });

/* ─────────────────────────────────────────────────────────────────────── */

/** 画布节点上要显示的一行摘要（悬停卡也用这份） */
export type NodeLiveInfo = {
  status: string;
  elapsedMs: number | null;
  action: string;
  thinking: string;
  output: string;
  tools: { name: string; args: string; state: string; result: string }[];
  iters: number;
  eventCount: number;
  /** 下面三样给"画布右侧抽屉"用（悬停卡不用）：哪一次运行、这一步收到什么、原始事件 */
  runId: string;
  input: string;
  events: TraceEvent[];
};

/** 从一次运行的 trace 里提炼"节点上那一行" —— 画布与详情共用同一个提炼口径 */
export function buildNodeLive(t: TraceData, status: string): NodeLiveInfo {
  const { thinking, answer, tools } = collect(t.events ?? []);
  const started = t.run?.started_at ?? null;
  const ended = t.run?.ended_at ?? null;
  const last = tools[tools.length - 1];
  return {
    status,
    elapsedMs: started ? (ended ?? Date.now()) - started : null,
    // 一句话说清"它现在在干什么"：正在调工具 > 在思考 > 刚开始
    action: last
      ? `${last.name}${last.state === "调用中" ? " 执行中…" : " 完成"}`
      : thinking
        ? "思考中…"
        : status === "running"
          ? "刚起步…"
          : "",
    thinking,
    output: answer || t.run?.output?.content || "",
    tools,
    iters: t.llm_calls?.length ?? 0,
    eventCount: (t.events ?? []).length,
    runId: t.run?.id ?? "",
    input: (t.run?.input?.text as string | undefined) ?? "",
    events: t.events ?? [],
  };
}

export function StepExecPanel({
  step,
  index,
  open,
  onToggle,
  live,
  trace,
}: {
  step: StepBrief;
  index: number;
  open: boolean;
  onToggle: () => void;
  /** 这一步还在跑（决定要不要轮询） */
  live: boolean;
  /** 外部已拉的 trace（Playground 统一轮询一份，画布和这里共用，不重复请求） */
  trace?: TraceData;
}) {
  const [data, setData] = useState<TraceData | null>(trace ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const t = (await api.runTrace(step.run_id)) as unknown as TraceData;
      setData(t);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [step.run_id]);

  useEffect(() => {
    if (trace) setData(trace);        // 外部给了就用外部的（一份数据两处用）
  }, [trace]);

  useEffect(() => {
    if (trace) return;                // 外部统一轮询时，这里不再自己拉
    // 折叠时也拉一次：块头的耗时/轮数要有数（不然展开前是个空壳）
    void load();
  }, [load, trace]);

  useEffect(() => {
    if (trace || !live) return;
    // 运行中的步骤轻量轮询 —— 思考和输出就会边跑边长出来
    timer.current = window.setInterval(() => void load(), 2000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [live, load]);

  const run = data?.run;
  const { thinking, answer, tools } = data?.events ? collect(data.events) : { thinking: "", answer: "", tools: [] };
  const started = run?.started_at ?? null;
  const ended = run?.ended_at ?? null;
  const durMs = started ? (ended ?? (live ? Date.now() : null)) && (ended ?? Date.now()) - started : null;
  const iters = data?.llm_calls?.length ?? (run?.usage?.iterations ?? 0);
  const tokens = (run?.usage?.tokens_in ?? 0) + (run?.usage?.tokens_out ?? 0);
  const out = answer || step.output_text || run?.output?.content || "";

  return (
    <div
      className="rounded-[10px] border"
      style={{ borderColor: live ? "var(--color-accent)" : "var(--color-border)" }}
    >
      {/* 块头：这一格的结论 */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
      >
        <span
          className="shrink-0 text-[11px] font-semibold"
          style={{ color: "var(--color-muted)" }}
        >
          {index + 1}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{step.agent_name}</span>
        <span className="shrink-0 text-[11.5px]" style={{ color: statusColor(step.status) }}>
          {live && step.status === "running" ? "● " : ""}
          {statusText[step.status] ?? step.status}
        </span>
        {durMs != null && durMs > 0 && (
          <span className="shrink-0 text-[11px]" style={{ color: "var(--color-muted)" }}>
            {fmtMs(durMs)}
          </span>
        )}
        {iters > 0 && (
          <span className="shrink-0 text-[11px]" style={{ color: "var(--color-muted)" }}>
            ↻{iters}
          </span>
        )}
        {tools.length > 0 && (
          <span className="shrink-0 text-[11px]" style={{ color: "var(--color-muted)" }}>
            🛠{tools.length}
          </span>
        )}
        {tokens > 0 && (
          <span className="shrink-0 text-[11px]" style={{ color: "var(--color-muted)" }}>
            {tokens} 字
          </span>
        )}
        <span className="shrink-0 text-[11px]" style={{ color: "var(--color-muted)" }}>
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="border-t px-3 py-2.5" style={{ borderColor: "var(--color-border)" }}>
          {err && (
            <p className="text-[12px]" style={{ color: "var(--color-err)" }}>
              取不到这一步的过程：{err}
            </p>
          )}

          {/* 输入（这一步收到什么） */}
          {step.input_text && (
            <Section label="这一步收到" tone="muted">
              <div className="whitespace-pre-wrap text-[12px]">{step.input_text}</div>
            </Section>
          )}

          {/* 思考 */}
          <Section label="思考" hint="模型在动手前/动手时想到的内容">
            {thinking ? (
              <div
                className="whitespace-pre-wrap rounded-[6px] px-2 py-1.5 text-[12px] leading-[1.65]"
                style={{ background: "color-mix(in srgb, var(--color-accent) 5%, transparent)" }}
              >
                {thinking}
              </div>
            ) : (
              <Muted>{live ? "还在想…（模型没输出思考内容时这里是空的）" : "这一步没有思考内容"}</Muted>
            )}
          </Section>

          {/* 工具 */}
          <Section label={`工具（${tools.length} 次）`} hint="它实际调用了什么、结果如何">
            {tools.length === 0 ? (
              <Muted>没调用工具</Muted>
            ) : (
              <div className="flex flex-col gap-1.5">
                {tools.map((t, i) => (
                  <div key={i} className="rounded-[6px] border px-2 py-1.5" style={{ borderColor: "var(--color-border)" }}>
                    <div className="flex flex-wrap items-baseline gap-2 text-[12px]">
                      <code className="mono font-semibold">{t.name}</code>
                      <span
                        style={{
                          color: t.state === "成功" ? "var(--color-ok)" : t.state === "调用中" ? "var(--color-accent)" : "var(--color-err)",
                        }}
                        className="text-[11px]"
                      >
                        {t.state}
                      </span>
                    </div>
                    {argsLine(t.args) && (
                      <div className="mono mt-0.5 break-all text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                        {argsLine(t.args)}
                      </div>
                    )}
                    {t.result.trim() && (
                      <div className="mono mt-1 max-h-[120px] overflow-auto whitespace-pre-wrap break-all rounded-[4px] px-1.5 py-1 text-[11.5px]" style={{ background: "var(--color-surface-2)" }}>
                        {t.result.trim().slice(0, 800)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* 输出 */}
          <Section label="输出">
            {out ? (
              <div className="whitespace-pre-wrap text-[12.5px] leading-[1.7]">{out}</div>
            ) : (
              <Muted>{live ? "还没输出最终回答" : "这一步没有输出"}</Muted>
            )}
          </Section>

          {run?.error && (
            <Section label="报错">
              <div className="whitespace-pre-wrap text-[12px]" style={{ color: "var(--color-err)" }}>
                {run.error}
              </div>
            </Section>
          )}

          {/* 日志：默认折叠（是排障证据，不是正文） */}
          <div className="mt-2 border-t pt-2" style={{ borderColor: "var(--color-border)" }}>
            <button
              type="button"
              onClick={() => setShowLog((v) => !v)}
              className="text-[11.5px]"
              style={{ color: "var(--color-muted)" }}
            >
              {showLog ? "收起日志" : `日志（${data?.events?.length ?? 0} 条事件）`}
            </button>
            {showLog && (
              <div className="mono mt-1.5 max-h-[200px] overflow-auto text-[11px] leading-[1.7]">
                {(data?.events ?? []).map((ev) => (
                  <div key={ev.seq} className="flex gap-2">
                    <span className="shrink-0" style={{ color: "var(--color-muted)" }}>
                      {hhmmss(ev.ts)}
                    </span>
                    <span className="shrink-0" style={{ color: "var(--color-accent)" }}>
                      {eventLabel[ev.type] ?? ev.type}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-2 text-right">
            <a
              href={`/runs?run=${step.run_id}`}
              className="text-[11.5px]"
              style={{ color: "var(--color-accent)" }}
            >
              这一步的完整记录 →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  tone?: "muted";
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-[11.5px] font-semibold" style={{ color: "var(--color-muted)" }}>
        {label}
        {hint && <Hint text={hint} />}
      </div>
      {children}
    </div>
  );
}

const Muted = ({ children }: { children: React.ReactNode }) => (
  <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
    {children}
  </span>
);
