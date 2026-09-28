"use client";

/**
 * 右侧「执行」栏 —— exec 页的信息列（桌面 xl 起常驻）。
 *
 * 2026-09-28 扩成三段（原来只有执行过程）——以"跑的时候最想知道什么"排序：
 *   ① **本轮用量**：token（进/出）、模型耗时 vs 工具耗时、轮次、工具次数。
 *      跑长任务时最常问的就是"它花了多少、卡在哪一段"，这些不该藏在气泡的一行小字里。
 *   ② **执行过程**：think / tool_call / tool_result 时间线（实时推送）。
 *   ③ **产物文件**：这一轮它**写了/改了哪些文件**（从 write/edit 工具调用的参数里取，
 *      不猜目录），点一下复制路径 —— agent 干活的实物产出。
 *
 * 形态纪律：桌面常驻右栏（「多列」不是把对话挤成两列，而是给观测一个固定席位）；
 * 手机/平板不出现（消息内折叠条仍是同一份数据的另一个形态）。
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { RunEvent } from "@/lib/types";
import { RunTimeline, eventsToSteps } from "@/components/ui/run-timeline";
import { useFeedback } from "@/components/ui/feedback";

type Usage = Awaited<ReturnType<typeof api.run>>["usage"];

/** 一次工具调用（从事件流拼出来的） */
type ToolUse = { name: string; state: "ok" | "err" | "run" };

export function ProcessRail({
  liveEvents,
  busy,
  liveInput,
  lastRunId,
}: {
  /** 跑动中的事件（SSE 实时推来的） */
  liveEvents: RunEvent[];
  busy: boolean;
  liveInput: string;
  /** 最后一轮的 run id —— 停下来后拉全量补齐（live 可能截尾） */
  lastRunId: string | null;
}) {
  const fb = useFeedback();
  const [restored, setRestored] = useState<RunEvent[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  /**
   * 已经拉过哪个 run —— 必须用 **ref**，不能放进 state：
   * 它是依赖数组的一员，用 state 会在 effect 里"先 set 再继续"，
   * 触发重渲染 → cleanup 把在途请求标记为取消 → 拉回来的数据被丢掉，
   * 右栏就一直空着（踩过：日志显示 790 条事件到手，界面还是空态）。
   */
  const fetchedFor = useRef<string | null>(null);

  // 停下后补拉一次全量事件 + 这一次的用量（对齐消息内折叠条的懒加载口径）
  useEffect(() => {
    if (busy) return;
    if (!lastRunId || fetchedFor.current === lastRunId) return;
    fetchedFor.current = lastRunId;
    let cancelled = false;
    void (async () => {
      try {
        const [evs, run] = await Promise.all([
          api.runEvents(lastRunId),
          api.run(lastRunId).catch(() => null),
        ]);

        if (cancelled) return;
        setRestored(evs);
        if (run) {
          setUsage((run.usage as Usage) ?? null);
          setSeconds(
            run.ended_at && run.started_at
              ? Math.max(0, (run.ended_at - run.started_at) / 1000)
              : null,
          );
        }
      } catch {
        if (!cancelled) setRestored([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [busy, lastRunId]);

  // 新一轮开始：把上一轮的用量/秒数清掉，别让旧数字挂在新一轮上
  useEffect(() => {
    if (busy) {
      setUsage(null);
      setSeconds(null);
    }
  }, [busy]);

  const events = busy ? liveEvents : restored;
  const steps = useMemo(
    () => (events && events.length ? eventsToSteps(events, liveInput) : []),
    [events, liveInput],
  );

  /** 工具调用：tool_call_start 建条目，tool_exec_end 按 tool_call_id 收口 */
  const tools = useMemo<ToolUse[]>(() => {
    if (!events || events.length === 0) return [];
    const byId = new Map<string, ToolUse>();
    for (const e of events) {
      const p = e.payload as Record<string, unknown>;
      const id = String(p.tool_call_id ?? "");
      if (!id) continue;
      if (e.type === "tool_call_start" || e.type === "tool_exec_start") {
        const name = String(p.tool_call_name ?? byId.get(id)?.name ?? "工具");
        byId.set(id, { name, state: byId.get(id)?.state ?? "run" });
      } else if (e.type === "tool_exec_end") {
        const prev = byId.get(id);
        byId.set(id, {
          name: prev?.name ?? "工具",
          state: p.state === "success" ? "ok" : "err",
        });
      }
    }
    return [...byId.values()];
  }, [events]);

  /** 按工具名聚合（「哪个工具被调了几次」比逐条流水更好读） */
  const toolSummary = useMemo(() => {
    const m = new Map<string, { n: number; bad: number }>();
    for (const t of tools) {
      const cur = m.get(t.name) ?? { n: 0, bad: 0 };
      cur.n += 1;
      if (t.state === "err") cur.bad += 1;
      m.set(t.name, cur);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [tools]);

  /**
   * 产物文件：从 write / edit 这类工具调用的参数里把路径取出来。
   *
   * 为什么不列工作目录：工作目录是**多个执行共用**的（data/work），
   * 列目录会把别人的文件也算进来。只认"这一轮真的写了哪个文件"才是实话。
   */
  const files = useMemo(() => {
    if (!events || events.length === 0) return [];
    const argsOf = new Map<string, string>(); // tool_call_id → 拼接出的参数 JSON
    const names = new Map<string, string>();
    const out = new Set<string>();
    for (const e of events) {
      const p = e.payload as Record<string, unknown>;
      const id = String(p.tool_call_id ?? "");
      if (!id) continue;
      if (e.type === "tool_call_start") {
        names.set(id, String(p.tool_call_name ?? ""));
      } else if (e.type === "tool_call_args") {
        argsOf.set(id, (argsOf.get(id) ?? "") + String(p.delta ?? ""));
      } else if (e.type === "tool_exec_start") {
        const name = names.get(id) ?? String(p.tool_call_name ?? "");
        if (!/write|edit|create|append/i.test(name)) continue;
        const raw = argsOf.get(id) ?? "";
        const m = /"(?:file_path|path|filename)"\s*:\s*"([^"]+)"/.exec(raw);
        if (m) out.add(m[1]);
      }
    }
    return [...out];
  }, [events]);

  const tokensIn = usage?.tokens_in ?? 0;
  const tokensOut = usage?.tokens_out ?? 0;
  const hasUsage = tokensIn + tokensOut > 0 || (usage?.iterations ?? 0) > 0;

  return (
    <aside
      className="hidden xl:flex w-[340px] shrink-0 border-l flex-col min-h-0"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <div
        className="px-3 py-2.5 border-b flex items-center gap-2"
        style={{ borderColor: "var(--color-border)" }}
      >
        <span className="text-[12.5px] font-medium">执行</span>
        {busy ? (
          <span className="text-[11px] live-dot" style={{ color: "var(--color-accent)" }}>
            ● 实时
          </span>
        ) : (
          <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>
            {steps.length ? `共 ${steps.length} 步` : ""}
          </span>
        )}
      </div>

      {/* ① 本轮用量 —— 跑的时候最想知道的几个数，一行摆开 */}
      {(hasUsage || busy) && (
        <div className="border-b px-3 py-2.5" style={{ borderColor: "var(--color-border)" }}>
          <div className="mb-1.5 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
            本轮用量
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
            <span>
              <span style={{ color: "var(--color-muted)" }}>进</span>{" "}
              <span className="tabular-nums">{fmt.num(tokensIn)}</span>
            </span>
            <span>
              <span style={{ color: "var(--color-muted)" }}>出</span>{" "}
              <span className="tabular-nums">{fmt.num(tokensOut)}</span>
            </span>
            {usage?.llm_calls ? (
              <span>
                <span style={{ color: "var(--color-muted)" }}>模型调用</span>{" "}
                <span className="tabular-nums">{usage.llm_calls}</span>
              </span>
            ) : null}
            {usage?.tool_calls ? (
              <span>
                <span style={{ color: "var(--color-muted)" }}>工具</span>{" "}
                <span className="tabular-nums">{tools.length || usage.tool_calls}</span>
              </span>
            ) : null}
            {seconds !== null ? (
              <span>
                <span style={{ color: "var(--color-muted)" }}>耗时</span>{" "}
                <span className="tabular-nums">{seconds.toFixed(1)}s</span>
              </span>
            ) : null}
          </div>
          {usage && (usage.llm_ms || usage.tool_ms) ? (
            <div className="mt-1 text-[11px]" style={{ color: "var(--color-muted)" }}>
              模型 {fmt.ms(usage.llm_ms ?? 0)} · 工具 {fmt.ms(usage.tool_ms ?? 0)}
              {usage.retries ? ` · 重试 ${usage.retries}` : ""}
              {usage.errors ? ` · 报错 ${usage.errors}` : ""}
            </div>
          ) : null}
        </div>
      )}

      {/* ② 执行过程 */}
      <div className="flex-1 overflow-auto px-2.5 py-2 min-h-0">
        {steps.length ? (
          <RunTimeline steps={steps} compact />
        ) : (
          <div className="px-1 py-6 text-center text-[12px]" style={{ color: "var(--color-muted)" }}>
            {busy ? "等它开始干活…" : "跑一轮，这里实时展示它的思考与工具调用。"}
          </div>
        )}
      </div>

      {/* ③ 工具调用 + 产物文件 —— 详情放底部（滚到才看，不抢过程的视线） */}
      {toolSummary.length > 0 && (
        <div className="border-t px-3 py-2.5" style={{ borderColor: "var(--color-border)" }}>
          <div className="mb-1.5 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
            用到的工具
          </div>
          <div className="flex flex-wrap gap-1.5">
            {toolSummary.map(([name, s]) => (
              <span
                key={name}
                className="rounded px-1.5 py-0.5 text-[11px]"
                title={s.bad ? `${s.n} 次，其中 ${s.bad} 次失败` : `${s.n} 次`}
                style={{
                  background:
                    s.bad > 0
                      ? "color-mix(in srgb, var(--color-err) 12%, transparent)"
                      : "var(--color-surface-2)",
                  color: s.bad > 0 ? "var(--color-err)" : "var(--color-text)",
                }}
              >
                <span className="mono">{name}</span>
                {s.n > 1 ? <span className="ml-1 tabular-nums">{s.n}×</span> : null}
              </span>
            ))}
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div className="border-t px-3 py-2.5" style={{ borderColor: "var(--color-border)" }}>
          <div className="mb-1.5 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
            这一轮写了 {files.length} 个文件
          </div>
          <div className="flex flex-col gap-1">
            {files.map((f) => (
              <button
                key={f}
                type="button"
                data-tap
                title="点一下复制完整路径"
                className="mono truncate rounded px-1.5 py-1 text-left text-[11.5px] hover:bg-[var(--color-surface-2)]"
                onClick={() =>
                  void navigator.clipboard?.writeText(f).then(
                    () => fb.success("已复制路径", f),
                    () => fb.info("路径", f),
                  )
                }
              >
                {f}
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
