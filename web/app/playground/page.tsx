"use client";

/**
 * Playground —— 把几个助手编排起来完成一件事，并看着它跑完。
 *
 * 页面结构（从上到下就是使用顺序）
 * ------------------------------
 *   ① 执行方式  四个选项，选一个
 *   ② 编排      把助手拖进槽位（手机点一下也行）
 *   ③ 任务      写清楚要干什么 → 开始运行
 *   ④ 执行过程  实时显示每个助手在做什么（复用对话页那套分色时间线）
 *   ⑤ 最终结果  主从模式下是主控汇总出来的结论
 *
 * 一个复用上的便宜：每个子步骤都是一条普通的 Run，所以"它想了什么、调了什么
 * 工具、拿到了什么"直接用现成的分色时间线渲染 —— 不用为编排另写一套日志。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api, fmt } from "@/lib/api";
import type {
  Agent,
  OrchestrationMode,
  OrchestrationStatusEvent,
  OrchStep,
  RunEvent,
} from "@/lib/types";
import { RunTimeline, eventsToSteps, summarize } from "@/components/ui/run-timeline";
import { AgentTray, OrchestrationCanvas } from "@/components/OrchestrationCanvas";
import { useFeedback } from "@/components/ui/feedback";

const STEP_STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: "等待中", color: "var(--color-muted)" },
  running: { label: "运行中", color: "var(--color-accent)" },
  ok: { label: "完成", color: "var(--color-ok)" },
  error: { label: "失败", color: "var(--color-err)" },
  aborted: { label: "已中止", color: "var(--color-warn)" },
  waiting_hitl: { label: "等待确认", color: "var(--color-warn)" },
};

const ORC_STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: "准备中", color: "var(--color-muted)" },
  running: { label: "运行中", color: "var(--color-accent)" },
  ok: { label: "全部完成", color: "var(--color-ok)" },
  partial: { label: "部分完成", color: "var(--color-warn)" },
  error: { label: "失败", color: "var(--color-err)" },
  aborted: { label: "已中止", color: "var(--color-warn)" },
};

//: 用得上串行开关的模式
const SERIAL_LIKE: OrchestrationMode[] = ["serial", "master_worker"];

export default function PlaygroundPage() {
  const fb = useFeedback();

  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  // 编排态
  const [mode, setMode] = useState<OrchestrationMode>("single");
  const [workerMode, setWorkerMode] = useState<"serial" | "parallel">("parallel");
  const [masterId, setMasterId] = useState<string | null>(null);
  const [slots, setSlots] = useState<(OrchStep | null)[]>([null]);
  const [task, setTask] = useState("");

  // 运行态
  const [busy, setBusy] = useState(false);
  const [orcId, setOrcId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<OrchestrationStatusEvent | null>(null);
  const [events, setEvents] = useState<Record<string, RunEvent[]>>({});
  const [openRun, setOpenRun] = useState<Record<string, boolean>>({});
  const esRef = useRef<EventSource | null>(null);

  /* ------------------------------ 载入 ------------------------------ */
  useEffect(() => {
    void (async () => {
      try {
        setAgents(await api.agents());
      } catch (e) {
        fb.error("加载助手失败", e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [fb]);

  /* --------------------- 模式变化时调整槽位数量 --------------------- */
  useEffect(() => {
    setSlots((prev) => {
      const filled = prev.filter(Boolean) as OrchStep[];
      if (mode === "single") return [prev[0] ?? null];
      const want = Math.max(2, filled.length);
      const next: (OrchStep | null)[] = [];
      for (let i = 0; i < want; i++) next.push(prev[i] ?? null);
      return next;
    });
  }, [mode]);

  /* ------------------------------ 运行 ------------------------------ */
  const filledSlots = useMemo(() => slots.filter(Boolean) as OrchStep[], [slots]);

  const canRun =
    !busy &&
    task.trim().length > 0 &&
    (mode === "master_worker" ? !!masterId && filledSlots.length >= 1 : filledSlots.length >= 1);

  const start = useCallback(async () => {
    if (!canRun) return;
    // 单个助手模式只取第一个槽
    const steps = mode === "single" ? filledSlots.slice(0, 1) : filledSlots;
    setBusy(true);
    setEvents({});
    setSnapshot(null);
    setOpenRun({});
    try {
      const orc = await api.createOrchestration({
        mode,
        worker_mode: mode === "master_worker" ? workerMode : null,
        master_agent_id: mode === "master_worker" ? masterId : null,
        steps,
        task: task.trim(),
      });
      setOrcId(orc.id);

      // 订阅实时流：状态快照 + 各子步骤的事件
      const es = new EventSource(api.orchestrationStreamUrl(orc.id));
      esRef.current = es;
      es.addEventListener("status", (e) => {
        try {
          setSnapshot(JSON.parse((e as MessageEvent).data) as OrchestrationStatusEvent);
        } catch {
          /* ignore */
        }
      });
      es.onmessage = (e) => {
        try {
          const item = JSON.parse(e.data) as { kind: string; run_id: string } & RunEvent;
          if (item.kind !== "event") return;
          setEvents((prev) => ({
            ...prev,
            [item.run_id]: [...(prev[item.run_id] ?? []), item],
          }));
        } catch {
          /* ignore */
        }
      };
      es.addEventListener("done", () => {
        es.close();
        setBusy(false);
      });
      es.onerror = () => {
        // 编排结束时服务端会关流，这里只在真的还在跑时报错
        if (es.readyState === EventSource.CLOSED) setBusy(false);
      };
    } catch (e) {
      fb.error("启动失败", e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [canRun, mode, filledSlots, workerMode, masterId, task, fb]);

  const stop = useCallback(async () => {
    if (!orcId) return;
    try {
      await api.abortOrchestration(orcId);
      fb.warn("已请求中止", "正在跑的步骤会被中断");
    } catch (e) {
      fb.error("中止失败", e instanceof Error ? e.message : String(e));
    }
  }, [orcId, fb]);

  useEffect(() => () => esRef.current?.close(), []);

  /* ------------------------------ 渲染 ------------------------------ */
  if (loading) {
    return <div className="p-4 md:p-6 lg:p-7 text-[13px] text-[var(--color-muted)]">加载中…</div>;
  }

  if (agents.length === 0) {
    return (
      <div className="h-[calc(100dvh-3.5rem)] md:h-dvh flex items-center justify-center p-6">
        <div className="card p-6 max-w-md text-center">
          <div className="text-[28px] mb-2">⛓</div>
          <h2 className="text-[16px] font-medium mb-2">还没有可以编排的助手</h2>
          <p className="text-[12.5px] text-[var(--color-muted)] leading-relaxed mb-4">
            编排就是把几个助手的分工定下来：谁先做、谁同时做、谁最后汇总。
            <br />
            先去创建至少一个助手吧。
          </p>
          <Link href="/agents" className="btn btn-primary">
            去创建助手
          </Link>
        </div>
      </div>
    );
  }

  const orcSt = snapshot ? ORC_STATUS[snapshot.status] ?? ORC_STATUS.pending : null;
  const running = snapshot ? !["ok", "partial", "error", "aborted"].includes(snapshot.status) : false;

  return (
    <div className="p-4 md:p-6 lg:p-7 max-w-5xl">
      <header className="mb-5">
        <h1 className="text-[22px] font-semibold tracking-tight">Playground</h1>
        <p className="text-[13px] text-[var(--color-muted)] mt-1">
          让几个助手分工干一件事 —— 接力、同时开工，或由一个主控拆任务再汇总。
        </p>
      </header>

      {/* ── 编排 ─────────────────────────────────────────────── */}
      <section className="card p-4 mb-4">
        <OrchestrationCanvas
          mode={mode}
          onModeChange={setMode}
          workerMode={workerMode}
          onWorkerModeChange={setWorkerMode}
          agents={agents}
          masterId={masterId}
          onMasterChange={setMasterId}
          slots={slots}
          onSlotsChange={setSlots}
        />
      </section>

      {/* ── 任务 + 运行 ──────────────────────────────────────── */}
      <section className="card p-4 mb-4">
        <div className="label mb-2">要完成的任务</div>
        <textarea
          className="input text-[13px]"
          rows={3}
          placeholder="例如：帮我把「远程办公的利弊」整理成一份简短的分析，先查资料再动笔。"
          value={task}
          disabled={busy}
          onChange={(e) => setTask(e.target.value)}
        />
        <div className="flex items-center gap-3 mt-3 flex-wrap">
          {busy ? (
            <button className="btn text-[var(--color-warn)]" onClick={() => void stop()}>
              中止
            </button>
          ) : (
            <button className="btn btn-primary" disabled={!canRun} onClick={() => void start()}>
              ▶ 开始运行
            </button>
          )}
          <span className="text-[11.5px] text-[var(--color-muted)]">
            {(() => {
              const n = mode === "master_worker" ? filledSlots.length + 1 : filledSlots.length;
              const calls = mode === "master_worker" ? filledSlots.length + 2 : n;
              return `将调用模型 ${calls} 次（${n} 个助手${mode === "master_worker" ? "，主控跑 2 次" : ""}）`;
            })()}
          </span>
        </div>
      </section>

      {/* ── 助手栏（拖或点）──────────────────────────────────── */}
      <section className="card p-4 mb-4">
        <AgentTray
          agents={agents}
          disabled={busy}
          onPick={(id) => {
            // 手机通道：点一下 → 填进第一个空位。
            // 注意必须用**函数式更新**：连续点两次时，闭包里的 slots 还是旧快照，
            // 直接读它会把第二次点击填到同一个槽位、覆盖掉第一次的结果。
            const isMaster = mode === "master_worker";
            if (isMaster && !masterId) {
              setMasterId(id);
              return;
            }
            setSlots((prev) => {
              const next = [...prev];
              // 同一个助手不重复占位
              const dup = next.findIndex((s) => s?.agent_id === id);
              if (dup >= 0) next[dup] = null;
              const emptyIdx = next.findIndex((s) => !s);
              if (emptyIdx >= 0) {
                next[emptyIdx] = { agent_id: id, carry_prev: false };
                return next;
              }
              if (mode !== "single" && next.length < 8) {
                next.push({ agent_id: id, carry_prev: false });
                return next;
              }
              if (mode === "single") {
                next[0] = { agent_id: id, carry_prev: false };
                return next;
              }
              fb.warn("槽位满了", "先移出一些助手，或点「加一个」");
              return prev;
            });
          }}
        />
      </section>

      {/* ── 执行过程（实时）──────────────────────────────────── */}
      {snapshot && (
        <section className="card p-4 mb-4">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <h2 className="text-[14px] font-medium">执行过程</h2>
            {orcSt && (
              <span
                className="text-[11.5px] px-2 py-0.5 rounded-full"
                style={{
                  background: `color-mix(in srgb, ${orcSt.color} 13%, transparent)`,
                  color: orcSt.color,
                }}
              >
                {running && <span className="live-dot">● </span>}
                {orcSt.label}
              </span>
            )}
            {snapshot.usage && (snapshot.usage.llm_calls ?? 0) > 0 && (
              <span className="text-[11.5px] text-[var(--color-muted)]">
                {snapshot.usage.llm_calls} 次模型调用 ·{" "}
                {(snapshot.usage.tokens_in ?? 0) + (snapshot.usage.tokens_out ?? 0)} tokens
              </span>
            )}
          </div>

          <div className="space-y-2">
            {snapshot.steps.map((s, i) => {
              const st = STEP_STATUS[s.status] ?? STEP_STATUS.pending;
              const evs = events[s.run_id] ?? [];
              const steps = evs.length ? eventsToSteps(evs) : [];
              const open = openRun[s.run_id] ?? false;
              const isMaster = s.role === "master";
              return (
                <div
                  key={s.run_id}
                  className="rounded-lg p-3"
                  style={{
                    background: "var(--color-surface-2)",
                    border: isMaster ? "1px solid var(--color-accent)" : "1px solid transparent",
                  }}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11.5px] text-[var(--color-muted)] w-5 shrink-0">
                      {i + 1}
                    </span>
                    {isMaster && (
                      <span
                        className="text-[10.5px] px-1.5 py-0.5 rounded shrink-0"
                        style={{
                          background: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
                          color: "var(--color-accent)",
                        }}
                      >
                        主控
                      </span>
                    )}
                    <span className="text-[13px] font-medium truncate">{s.agent_name}</span>
                    <span className="text-[11.5px] shrink-0" style={{ color: st.color }}>
                      {s.status === "running" && <span className="live-dot">● </span>}
                      {st.label}
                    </span>
                    {s.error && (
                      <span className="text-[11.5px]" style={{ color: "var(--color-err)" }}>
                        {s.error.slice(0, 60)}
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-3 shrink-0">
                      {steps.length > 0 && (
                        <button
                          className="text-[11.5px] text-[var(--color-accent)] hover:underline"
                          onClick={() =>
                            setOpenRun((prev) => ({ ...prev, [s.run_id]: !prev[s.run_id] }))
                          }
                        >
                          {open ? "▾" : "▸"} 它的操作
                        </button>
                      )}
                      <Link
                        className="text-[11.5px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
                        href={`/runs/${s.run_id}`}
                      >
                        完整记录 →
                      </Link>
                    </div>
                  </div>

                  {/* 这一步正在做什么（实时）*/}
                  {!open && steps.length > 0 && (
                    <div className="text-[11.5px] text-[var(--color-muted)] mt-1.5 ml-7 truncate">
                      {summarize(steps)}
                    </div>
                  )}

                  {open && steps.length > 0 && (
                    <div
                      className="mt-2.5 ml-7 p-3 rounded-lg"
                      style={{
                        background: "var(--color-surface)",
                        border: "1px solid var(--color-border)",
                      }}
                    >
                      <RunTimeline steps={steps} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── 最终结果 ─────────────────────────────────────────── */}
      {snapshot && ["ok", "partial"].includes(snapshot.status) && (
        <section className="card p-4">
          <h2 className="text-[14px] font-medium mb-2">
            {snapshot.steps.some((s) => s.role === "master" && s.order_index !== 0)
              ? "主控汇总的最终结果"
              : "最终结果"}
          </h2>
          <div className="text-[13.5px] leading-relaxed whitespace-pre-wrap break-words">
            {String((snapshot.output?.content as string) ?? "(无产出)")}
          </div>
          {snapshot.status === "partial" && (
            <p className="text-[11.5px] mt-3" style={{ color: "var(--color-warn)" }}>
              有步骤失败，这里是成功的部分汇总出来的结果。
            </p>
          )}
          {snapshot.ended_at && (
            <p className="text-[11.5px] text-[var(--color-muted)] mt-3">
              完成于 {fmt.relative(snapshot.ended_at)}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
