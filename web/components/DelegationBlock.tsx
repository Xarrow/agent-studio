"use client";

/**
 * 「这次派了谁去干」—— Router/Worker 最缺的那一屏。
 *
 * 问题（用户原话）：派了哪个 worker、干了什么、过程、结果，界面上什么都看不到。
 * 原因是 worker 跑在**自己的会话**里（`worker-<票>`），Router 的事件流里只有一行
 * `dispatch` 工具调用；翻过去也看不到那边发生了什么。
 *
 * 这个组件把「派出去的活」摆成一张清单：谁 · 干什么 · 什么状态 · 多久 · 结果摘要。
 * 还在干的那些会**直接订阅那个 worker 自己的事件流**（SSE），于是：
 *   - 收起时这一行跟着跳（现在在做什么 + 已经多久）；
 *   - 点开就地看到它的六段过程实时长出来，不用等它跑完。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Delegation, RunEvent } from "@/lib/types";
import { RunTimeline, eventsToSteps, type Step } from "@/components/ui/run-timeline";

const LIVE_STATUS = new Set(["pending", "queued", "running"]);

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

/** 一行说清"它现在在干嘛"（收起状态也要能看出动静；回答段不占这句） */
function liveHint(steps: Step[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.kind === "output") continue;
    const body = (s.body || "").replace(/\s+/g, " ").trim();
    const label = (s.label || "").replace(/\s+/g, " ").trim();
    const text = label && body ? `${label}：${body}` : label || body;
    if (text) return text.slice(0, 60);
  }
  return "";
}

export function DelegationBlock({
  runId,
  live = false,
  className = "",
}: {
  /** 派活那一方的 run（Router 那次执行） */
  runId: string;
  /** 父执行还在跑：要轮询清单，让"派给谁、进行到哪"当场可见 */
  live?: boolean;
  className?: string;
}) {
  const [items, setItems] = useState<Delegation[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  /** 跑完的：展开时拉一次历史过程就够 */
  const [steps, setSteps] = useState<Record<string, Step[]>>({});
  /** 还在跑的：直接吃它自己的事件流（每 200ms 把累积事件重算一遍步骤） */
  const [liveSteps, setLiveSteps] = useState<Record<string, Step[]>>({});
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streams = useRef<Record<string, EventSource>>({});
  const evts = useRef<Record<string, RunEvent[]>>({});
  const flushTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

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
    setLiveSteps({});
    setOpenId(null);
    evts.current = {};
    void load();
  }, [load]);

  // 父执行还在跑：2 秒一拍拉清单（有几件、各自状态）。清单本身很轻。
  useEffect(() => {
    if (!live || !runId) return;
    let stopped = false;
    const tick = async () => {
      await load();
      if (stopped) return;
      pollTimer.current = setTimeout(tick, 2000);
    };
    pollTimer.current = setTimeout(tick, 2000);
    return () => {
      stopped = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [live, runId, load]);

  // 还在干的行：每秒重算一次"多久了"
  useEffect(() => {
    if (!items.some((d) => LIVE_STATUS.has(d.status))) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [items]);

  /**
   * 还在干的 worker：订阅**它自己**的事件流。
   *
   * 为什么不复用外层那条：外层是 Router 的流，worker 在另一个会话里跑，
   * 事件压根不在那条流上 —— 这正是"点开只有历史、过程不会跟着长"的原因。
   */
  useEffect(() => {
    for (const d of items) {
      if (!LIVE_STATUS.has(d.status)) continue;
      if (streams.current[d.run_id]) continue;
      if (!evts.current[d.run_id]) evts.current[d.run_id] = [];
      const all = evts.current[d.run_id];
      const es = new EventSource(api.streamUrl(d.run_id));
      streams.current[d.run_id] = es;
      es.onmessage = (e: MessageEvent) => {
        try {
          const ev = JSON.parse(e.data) as RunEvent;
          all.push(ev);
          if (flushTimers.current[d.run_id]) return;
          flushTimers.current[d.run_id] = setTimeout(() => {
            delete flushTimers.current[d.run_id];
            setLiveSteps((m) => ({ ...m, [d.run_id]: eventsToSteps(all as never, d.task) }));
          }, 200);
        } catch {
          /* ignore */
        }
      };
      const close = () => {
        es.close();
        delete streams.current[d.run_id];
        if (flushTimers.current[d.run_id]) {
          clearTimeout(flushTimers.current[d.run_id]);
          delete flushTimers.current[d.run_id];
        }
        // 收尾后再拉一次清单：状态、产出、耗时以服务端为准
        void load();
      };
      es.addEventListener("done", close);
      es.onerror = close;
    }
    // 已经不跑了：关流，并把收到的事件定成最终步骤
    for (const [rid, es] of Object.entries(streams.current)) {
      const row = items.find((d) => d.run_id === rid);
      if (row && LIVE_STATUS.has(row.status)) continue;
      es.close();
      delete streams.current[rid];
      if (flushTimers.current[rid]) {
        clearTimeout(flushTimers.current[rid]);
        delete flushTimers.current[rid];
      }
      const buf = evts.current[rid];
      if (buf && buf.length) {
        setSteps((s) => (s[rid] ? s : { ...s, [rid]: eventsToSteps(buf as never, row?.task) }));
      }
    }
  }, [items, load]);

  useEffect(() => {
    return () => {
      for (const es of Object.values(streams.current)) es.close();
      streams.current = {};
      for (const t of Object.values(flushTimers.current)) clearTimeout(t);
      flushTimers.current = {};
    };
  }, []);

  const openChild = async (d: Delegation) => {
    if (openId === d.run_id) {
      setOpenId(null);
      return;
    }
    setOpenId(d.run_id);
    if (steps[d.run_id] || liveSteps[d.run_id]) return;
    setBusyStep(d.run_id);
    try {
      const list = await api.runEvents(d.run_id);
      setSteps((s) => ({ ...s, [d.run_id]: eventsToSteps(list as never, d.task) }));
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
        const shown = liveSteps[d.run_id] ?? steps[d.run_id] ?? [];
        const hint = hot ? liveHint(shown) : "";
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
              <span
                className="min-w-0 flex-1 truncate"
                style={{ color: hot && hint ? "var(--color-text)" : "var(--color-muted)" }}
              >
                {hot && hint ? hint : d.task.replace(/\s+/g, " ").slice(0, 70)}
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
                {shown.length > 0 && (
                  <div className="rounded-md border p-1.5" style={{ borderColor: "var(--color-border)" }}>
                    <RunTimeline steps={shown} compact running={hot} />
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
