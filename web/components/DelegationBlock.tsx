"use client";

/**
 * 「这次派了谁去干」—— Router/Worker 最缺的那一屏。
 *
 * 问题（用户原话）：派了哪个 worker、干了什么、过程、结果，界面上什么都看不到。
 * 原因是 worker 跑在**自己的会话**里（`worker-<票>`），Router 的事件流里只有一行
 * `dispatch` 工具调用；翻过去也看不到那边发生了什么。
 *
 * 这个组件把「派出去的活」摆成一张清单：谁 · 干什么 · 什么状态 · 多久 · 结果摘要，
 * 点开就地展开那个 worker 的完整过程（它自己的事件流，六段分色）。不跳页、不弹框。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Delegation } from "@/lib/types";
import { RunTimeline, eventsToSteps, type Step } from "@/components/ui/run-timeline";

const LIVE_STATUS = new Set(["pending", "running", "queued"]);

function statusText(s: string): string {
  if (s === "ok") return "做完了";
  if (s === "error") return "失败了";
  if (s === "aborted") return "中断了";
  if (s === "pending" || s === "queued") return "排队中";
  return "在干";
}

function secs(a: number, b: number | null): string {
  const ms = Math.max(0, (b ?? Date.now()) - a);
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function DelegationBlock({
  runId,
  live = false,
  className = "",
}: {
  /** 派活那一方的 run（Router 那次执行） */
  runId: string;
  /** 父执行还在跑：要轮询，让"派给谁、进行到哪"当场可见 */
  live?: boolean;
  className?: string;
}) {
  const [items, setItems] = useState<Delegation[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [steps, setSteps] = useState<Record<string, Step[]>>({});
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!runId) return;
    try {
      const r = await api.delegations(runId);
      setItems(r.items ?? []);
    } catch {
      /* 拿不到就保持上一次的样子，不要闪 */
    }
  }, [runId]);

  useEffect(() => {
    setItems([]);
    setSteps({});
    setOpenId(null);
    void load();
  }, [load]);

  // 父执行还在跑：2 秒一拍，直到全部收尾（收尾后再补一拍，把最终状态与产出拿全）
  useEffect(() => {
    if (!live || !runId) return;
    let stopped = false;
    const tick = async () => {
      await load();
      if (stopped) return;
      timer.current = setTimeout(tick, 2000);
    };
    timer.current = setTimeout(tick, 2000);
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [live, runId, load]);

  const openChild = async (d: Delegation) => {
    if (openId === d.run_id) {
      setOpenId(null);
      return;
    }
    setOpenId(d.run_id);
    if (steps[d.run_id]) return;
    setBusyStep(d.run_id);
    try {
      const evts = await api.runEvents(d.run_id);
      setSteps((s) => ({ ...s, [d.run_id]: eventsToSteps(evts as never, d.task) }));
    } catch {
      setSteps((s) => ({ ...s, [d.run_id]: [] }));
    } finally {
      setBusyStep(null);
    }
  };

  if (items.length === 0) return null;

  const running = items.filter((d) => LIVE_STATUS.has(d.status)).length;

  return (
    <div
      className={`rounded-[10px] border text-[12px] ${className}`}
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)", minWidth: 0 }}
    >
      <div
        className="flex items-center gap-1.5 px-2 py-1.5 border-b"
        style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 6h6M4 12h6M4 18h6M14 6h6M14 12h6M14 18h6" />
        </svg>
        <span>
          派了 <b className="tabular-nums" style={{ color: "var(--color-text)" }}>{items.length}</b> 件活
          {running > 0 ? ` · ${running} 件在干` : " · 都回来了"}
        </span>
      </div>

      {items.map((d) => {
        const hot = LIVE_STATUS.has(d.status);
        const open = openId === d.run_id;
        return (
          <div key={d.run_id} className="border-b last:border-b-0" style={{ borderColor: "var(--color-border)" }}>
            <button
              type="button"
              data-tap
              onClick={() => void openChild(d)}
              className="w-full flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 text-left hover:bg-[var(--color-surface-2)] max-md:h-[44px] max-md:flex-nowrap"
              title={d.task}
            >
              <span
                className={hot ? "live-dot shrink-0" : "shrink-0"}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: hot
                    ? "var(--color-accent)"
                    : d.status === "ok"
                      ? "var(--color-ok)"
                      : "var(--color-err)",
                  display: "inline-block",
                }}
              />
              <b className="shrink-0" style={{ color: "var(--color-text)" }}>{d.agent_name}</b>
              <span className="min-w-0 flex-1 truncate" style={{ color: "var(--color-muted)" }}>
                {d.task.replace(/\s+/g, " ").slice(0, 70)}
              </span>
              <span className="shrink-0 tabular-nums" style={{ color: hot ? "var(--color-accent)" : "var(--color-muted)" }}>
                {statusText(d.status)} · {secs(d.started_at, d.ended_at)}
              </span>
              <span className="shrink-0" aria-hidden style={{ color: "var(--color-muted)" }}>
                {open ? "▴" : "▾"}
              </span>
            </button>

            {open && (
              <div className="px-2 pb-2">
                {busyStep === d.run_id && (
                  <div className="py-1" style={{ color: "var(--color-muted)" }}>正在取它的过程…</div>
                )}
                {!busyStep && (steps[d.run_id]?.length ?? 0) > 0 && (
                  <div className="rounded-md border p-1.5" style={{ borderColor: "var(--color-border)" }}>
                    <RunTimeline steps={steps[d.run_id]} compact running={hot} />
                  </div>
                )}
                {d.output_excerpt && (
                  <div className="mt-1.5">
                    <div className="mb-0.5" style={{ color: "var(--color-muted)" }}>它的产出</div>
                    <div
                      className="whitespace-pre-wrap break-words rounded-md p-1.5"
                      style={{ background: "var(--color-bg)", color: "var(--color-text)" }}
                    >
                      {d.output_excerpt}
                    </div>
                  </div>
                )}
                {d.error && (
                  <div className="mt-1.5 rounded-md p-1.5" style={{ background: "color-mix(in srgb, var(--color-err) 10%, transparent)", color: "var(--color-err)" }}>
                    {d.error}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
