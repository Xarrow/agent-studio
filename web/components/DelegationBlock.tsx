"use client";

/**
 * 「这一轮编排」—— Router 对一个需求做了什么：拆给谁、谁在干、干到哪、收口没有。
 *
 * 为什么要单独一块（而不是塞在消息气泡下面）：worker 跑在**自己的会话**里
 * （`worker-<票>-<助手>`），Router 的事件流里只有一行 `dispatch`；不这样摆出来，
 * 用户看到的就只是一句结论，过程全在暗处。
 *
 * 布局是"总读数 → 进度 → 一行一个人"，收起状态也在动（实时订阅每个 worker 的事件流），
 * 点开就地看到它自己的过程与产出。不跳页、不弹框、不需要画布。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Delegation, RunEvent } from "@/lib/types";
import { RunTimeline, eventsToSteps, type Step } from "@/components/ui/run-timeline";
import { LIVE_STATUS, liveHint, secs, statusText, turnStats } from "@/lib/turn";

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
  /** Router 这一轮自己的状态：用来判断"分派完了没有、收口了没有" */
  const [parentStatus, setParentStatus] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streams = useRef<Record<string, EventSource>>({});
  const evts = useRef<Record<string, RunEvent[]>>({});
  const flushTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const load = useCallback(async () => {
    if (!runId) return;
    try {
      const [r, run] = await Promise.all([
        api.delegations(runId),
        api.run(runId).catch(() => null),
      ]);
      setItems(r.items ?? []);
      if (run) setParentStatus(run.status);
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

  // 只要还有活没干完就 2 秒一拍：dispatch 是"派完就回"，Router 那一轮早就结束了，
  // 但 worker 还在跑 —— 不能因为外层忙完了就停止刷新。
  const anyRunning = items.some((d) => LIVE_STATUS.has(d.status));
  useEffect(() => {
    if ((!live && !anyRunning) || !runId) return;
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
  }, [live, anyRunning, runId, load]);

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

  const st = turnStats(items, parentStatus);

  return (
    <div
      className={`rounded-[12px] text-[12px] overflow-hidden ${className}`}
      style={{
        border: "1px solid var(--color-border)",
        background: "color-mix(in srgb, var(--color-accent) 3%, var(--color-surface))",
        minWidth: 0,
      }}
      data-orchestration
    >
      {/* 抬头：这一轮编排的总读数 —— 派了几件、几件在干、收口没有 */}
      <div className="flex items-center gap-2 pl-2.5 pr-2 pt-1.5 pb-1">
        <span
          className="shrink-0 rounded-full px-1.5 py-[1px] text-[10.5px] font-semibold tracking-[0.04em]"
          style={{
            background: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
            color: "var(--color-accent)",
          }}
        >
          编排
        </span>
        <span className="min-w-0 truncate" style={{ color: "var(--color-muted)" }}>
          分派 <b className="tabular-nums" style={{ color: "var(--color-text)" }}>{st.total}</b> 件
          <span aria-hidden> · </span>
          {st.phrase}
          <span aria-hidden> · </span>
          {st.closing}
        </span>
        {st.active && (
          <span
            className="live-dot shrink-0 ml-auto"
            style={{ width: 6, height: 6, borderRadius: 999, background: "var(--color-accent)", display: "inline-block" }}
            aria-hidden
          />
        )}
      </div>

      {/* 进度条：绿=完成、红=失败、蓝=在干。没有它，用户得数行才知道进展 */}
      <div className="flex h-[3px] w-full" aria-hidden>
        {st.ok > 0 && <span style={{ flex: st.ok, background: "var(--color-ok)" }} />}
        {st.failed > 0 && <span style={{ flex: st.failed, background: "var(--color-err)" }} />}
        {st.running > 0 && (
          <span style={{ flex: st.running, background: "var(--color-accent)", opacity: 0.55 }} />
        )}
      </div>

      {items.map((d) => {
        const hot = LIVE_STATUS.has(d.status);
        const open = openId === d.run_id;
        const shown = liveSteps[d.run_id] ?? steps[d.run_id] ?? [];
        const hint = hot ? liveHint(shown) : "";
        const line = hot && hint ? hint : d.task.replace(/\s+/g, " ").slice(0, 90);
        // 描述的整句（"按 Hermes 的行为口径配置：直接、动手…"）当标签太长：
        // 取第一个分句，最多 12 字 —— 标签是给人扫的，不是给人读的。
        const rawDomain = (d.agent_domain || "").split(/[，。；;:：]/)[0].trim();
        const domain = rawDomain.length > 8 ? rawDomain.slice(0, 8) + "…" : rawDomain;
        return (
          <div key={d.run_id} className="border-b last:border-b-0" style={{ borderColor: "var(--color-border)" }}>
            <button
              type="button"
              data-tap
              onClick={() => void openChild(d)}
              className="w-full text-left px-2.5 py-1.5 max-md:py-[11px] hover:bg-[var(--color-surface-2)]"
              title={d.task}
            >
              <div className="flex items-center gap-1.5 min-w-0">
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
                  aria-hidden
                />
                <b className="shrink-0" style={{ color: "var(--color-text)", fontWeight: 600 }}>{d.agent_name}</b>
                {domain && (
                  <span
                    className="shrink-0 max-w-[40%] truncate rounded px-1 py-[1px] text-[10.5px]"
                    style={{ background: "var(--color-surface-2)", color: "var(--color-muted)" }}
                    title={d.agent_domain}
                  >
                    {domain}
                  </span>
                )}
                <span
                  className="ml-auto shrink-0 tabular-nums"
                  style={{ color: hot ? "var(--color-accent)" : "var(--color-muted)" }}
                >
                  {statusText(d.status)} · {secs(d.started_at, d.ended_at)}
                </span>
                <span className="shrink-0" aria-hidden style={{ color: "var(--color-muted)" }}>{open ? "▴" : "▾"}</span>
              </div>
              <div
                className="mt-0.5 pl-[14px] truncate"
                style={{ color: hot && hint ? "var(--color-text)" : "var(--color-muted)" }}
              >
                {line}
              </div>
            </button>

            {open && (
              <div className="px-2.5 pb-2">
                {busyStep === d.run_id && (
                  <div className="py-1" style={{ color: "var(--color-muted)" }}>正在取它的过程…</div>
                )}
                {shown.length > 0 && (
                  <div
                    className="rounded-md border p-1.5"
                    style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
                  >
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
                  <div
                    className="mt-1.5 rounded-md p-1.5"
                    style={{ background: "color-mix(in srgb, var(--color-err) 10%, transparent)", color: "var(--color-err)" }}
                  >
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
