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
import { HitlPrompt } from "@/components/HitlPrompt";
import Link from "next/link";
import { api, fmt } from "@/lib/api";
import type {
  Agent,
  Orchestration,
  OrchestrationDetail,
  OrchestrationMode,
  OrchestrationStatusEvent,
  OrchestrationStepRead,
  OrchStep,
  RunEvent,
} from "@/lib/types";
import { RunTimeline, eventsToSteps, summarize } from "@/components/ui/run-timeline";
import { AgentTray, OrchestrationCanvas } from "@/components/OrchestrationCanvas";
import { RunDetailById } from "@/components/RunDetailDialog";
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

/**
 * 从某一步的事件里取出待人工确认的请求。
 *
 * 编排本身不会等确认（后端 `wait_for_run` 见 waiting_hitl 就回，把整次编排标
 * 成 partial）—— 但**这一步的 run 还活着**，用户点一下就能让它跑完。
 * 取最后一次 hitl_request 的 payload，交给共享的确认条。
 */
function findHitlPayload(events: RunEvent[] | undefined): Record<string, unknown> | null {
  const ev = [...(events ?? [])].reverse().find((e) => e.type === "hitl_request");
  return ev ? ((ev.payload as Record<string, unknown>) ?? {}) : null;
}


export function OrchestrationConsole({ agentIds }: { agentIds?: string[] } = {}) {
  const fb = useFeedback();

  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  // 编排态
  const [mode, setMode] = useState<OrchestrationMode>("single");
  const [workerMode, setWorkerMode] = useState<"serial" | "parallel">("parallel");
  const [masterId, setMasterId] = useState<string | null>(null);
  const [slots, setSlots] = useState<(OrchStep | null)[]>([null]);

  /**
   * 由外层预填参与者。
   *
   * 这是"合并"的关键一环：用户在单助手对话里点「+ 加一个助手」，
   * 直接就进到编排、两个助手**已经在槽里**—— 不需要他再去托盘里一个个拖。
   * 只播一次种，之后画布/托盘归用户自己管。
   */
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !agentIds?.length) return;
    seeded.current = true;
    setSlots(agentIds.map((id) => ({ agent_id: id, carry_prev: false })));
  }, [agentIds]);
  const [task, setTask] = useState("");

  // 运行态
  const [busy, setBusy] = useState(false);
  const [orcId, setOrcId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<OrchestrationStatusEvent | null>(null);
  const [events, setEvents] = useState<Record<string, RunEvent[]>>({});
  const [openRun, setOpenRun] = useState<Record<string, boolean>>({});
  // 某一步的执行详情用弹框看 —— 编排正在跑，跳页会看不到进度
  const [detailRun, setDetailRun] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  /** 历史编排（进页面就能看到之前跑过什么，而不是空白） */
  const [history, setHistory] = useState<Orchestration[]>([]);
  /** 当前正在查看的那次编排的详情（历史模式用；实时模式走 snapshot） */
  const [detail, setDetail] = useState<OrchestrationDetail | null>(null);
  const [histLoading, setHistLoading] = useState(false);




  /** 订阅某次编排的实时流（状态快照 + 各子步骤事件） */
  const subscribeLive = useCallback((id: string) => {
    esRef.current?.close();
    const es = new EventSource(api.orchestrationStreamUrl(id));
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
      // 结束后刷新历史列表，让状态徽标更新
      void api.orchestrations(20).then(setHistory).catch(() => {});
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        setBusy(false);
      }
    };
  }, []);

  /** 加载某次编排：详情 + 各子步骤的历史事件（断线/刷新后也能看到完整过程） */
  const loadOrchestration = useCallback(
    async (id: string) => {
      setHistLoading(true);
      setOrcId(id);
      setOpenRun({});
      try {
        const d = await api.orchestration(id);
        setDetail(d);
        setSnapshot(null);

        // 各子步骤的事件都在库里，逐个取回来（复用 /api/runs/events）
        const got: Record<string, RunEvent[]> = {};
        await Promise.all(
          d.steps.map(async (s) => {
            try {
              got[s.run_id] = await api.runEvents(s.run_id);
            } catch {
              got[s.run_id] = [];
            }
          }),
        );
        setEvents(got);

        // 还在跑的话，接上实时流
        if (!["ok", "partial", "error", "aborted"].includes(d.status)) {
          subscribeLive(id);
        }
      } catch (e) {
        fb.error("打开失败", e instanceof Error ? e.message : String(e));
      } finally {
        setHistLoading(false);
      }
    },
    // subscribeLive 在下面用 useCallback 定义，这里不放进依赖避免循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fb],
  );

  /* ------------------------------ 载入 ------------------------------ */
  useEffect(() => {
    void (async () => {
      try {
        const [ags, hist] = await Promise.all([api.agents(), api.orchestrations(20)]);
        setAgents(ags);
        setHistory(hist);
        // 进页面直接展示最近一次编排 —— 否则用户看到的是空白，以为功能坏了
        if (hist.length > 0) await loadOrchestration(hist[0].id);
      } catch (e) {
        fb.error("加载失败", e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      setDetail(null);
      // 刷新历史列表（新的一条要出现在最上面）
      setHistory((prev) => [orc, ...prev]);
      subscribeLive(orc.id);
    } catch (e) {
      fb.error("启动失败", e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [canRun, mode, filledSlots, workerMode, masterId, task, fb, subscribeLive]);

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

  // 统一数据源：正在跑就用实时快照（snapshot），看历史就用详情（detail）。
  // 这样两种场景共用同一套渲染，不会出现"历史记录长得不一样"的问题。
  const view = snapshot ?? detail;
  const orcSt = view ? ORC_STATUS[view.status] ?? ORC_STATUS.pending : null;
  const running = view ? !["ok", "partial", "error", "aborted"].includes(view.status) : false;
  const stepsOf: OrchestrationStepRead[] = snapshot?.steps ?? detail?.steps ?? [];
  const finalText = String((view?.output?.content as string) ?? "");
  const hasMasterSummary = stepsOf.some((s) => s.role === "master" && (s.order_index ?? 0) > 0);

  return (
    <div className="p-4 md:p-6 lg:p-7 max-w-5xl">
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
            // 必须用函数式更新：连续点两次时闭包里的 slots 是旧快照，
            // 直接读它会把第二次点击填到同一个槽位、覆盖掉第一次的结果。
            const isMaster = mode === "master_worker";
            if (isMaster && !masterId) {
              setMasterId(id);
              return;
            }
            setSlots((prev) => {
              const next = [...prev];
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

      {/* ── 最近的编排（历史）────────────────────────────────── */}
      {history.length > 0 && (
        <section className="card p-4 mb-4">
          <h2 className="text-[14px] font-medium mb-3">最近的编排</h2>
          <div className="space-y-1.5">
            {history.map((h) => {
              const on = h.id === orcId;
              const st = ORC_STATUS[h.status] ?? ORC_STATUS.pending;
              const preview = String((h.output?.content as string) ?? "").replace(/\s+/g, " ").slice(0, 44);
              return (
                <button
                  key={h.id}
                  onClick={() => void loadOrchestration(h.id)}
                  className="w-full text-left rounded-lg px-3 py-2 transition-colors"
                  style={{
                    background: on ? "color-mix(in srgb, var(--color-accent) 9%, transparent)" : "var(--color-surface-2)",
                    border: `1px solid ${on ? "var(--color-accent)" : "transparent"}`,
                  }}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[12.5px] font-medium">{h.name}</span>
                    <span className="text-[11px] text-[var(--color-muted)]">{h.step_count} 个助手</span>
                    <span className="text-[11.5px]" style={{ color: st.color }}>{st.label}</span>
                    <span className="text-[11px] text-[var(--color-muted)] ml-auto shrink-0">
                      {fmt.relative(h.started_at)}
                    </span>
                  </div>
                  {preview && (
                    <div className="text-[11.5px] text-[var(--color-muted)] mt-0.5 truncate">{preview}</div>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* ── 执行过程（每个助手在做什么）────────────────────── */}
      {stepsOf.length > 0 && (
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
            {histLoading && (
              <span className="text-[11.5px] text-[var(--color-muted)]">载入中…</span>
            )}
            {!!view?.usage?.llm_calls && (
              <span className="text-[11.5px] text-[var(--color-muted)]">
                {view.usage.llm_calls} 次模型调用 ·{" "}
                {(view.usage.tokens_in ?? 0) + (view.usage.tokens_out ?? 0)} tokens
              </span>
            )}
          </div>

          <div className="space-y-2">
            {stepsOf.map((s, i) => {
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
                      <button
                        className="text-[11.5px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
                        onClick={() => setDetailRun(s.run_id)}
                      >
                        完整记录 →
                      </button>
                    </div>
                  </div>

                  {/* 它领到的任务 —— 这是"这个助手在做什么"最直接的答案 */}
                  {s.input_text && (
                    <div className="text-[11.5px] text-[var(--color-muted)] mt-1.5 ml-7 leading-snug">
                      <span className="text-[var(--color-info)]">领到的任务：</span>
                      {s.input_text.replace(/\s+/g, " ").slice(0, 150)}
                      {s.input_text.length > 150 ? "…" : ""}
                    </div>
                  )}

                  {/* 这一步停在等待授权 —— 就地确认。
                      编排层自己不会等（它已把整次编排标为 partial），但这一步的
                      Run 还活着：点一下它就跑完，结果照样进「运行记录」。 */}
                  {s.status === "waiting_hitl" && (
                    <div className="mt-2 ml-7">
                      <HitlPrompt
                        runId={s.run_id}
                        payload={findHitlPayload(events[s.run_id])}
                        onError={(m) => fb.error("恢复失败", m)}
                      />
                    </div>
                  )}

                  {/* 不展开时给一句行动摘要（有事件时） */}
                  {!open && steps.length > 0 && (
                    <div className="text-[11.5px] text-[var(--color-muted)] mt-1 ml-7 truncate">
                      {summarize(steps)}
                    </div>
                  )}

                  {/* 产出（跑完了、没展开日志时也能一眼看到结论） */}
                  {!open && s.status === "ok" && s.output_text && (
                    <div className="text-[12px] mt-1.5 ml-7 leading-snug">
                      <span className="text-[var(--color-ok)]">产出：</span>
                      <span className="text-[var(--color-muted)]">
                        {s.output_text.replace(/\s+/g, " ").slice(0, 130)}
                        {s.output_text.length > 130 ? "…" : ""}
                      </span>
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
      {view && ["ok", "partial"].includes(view.status) && finalText && (
        <section className="card p-4">
          <h2 className="text-[14px] font-medium mb-2">
            {hasMasterSummary ? "主控汇总的最终结果" : "最终结果"}
          </h2>
          <div className="text-[13.5px] leading-relaxed whitespace-pre-wrap break-words">
            {finalText}
          </div>
          {view.status === "partial" && (
            <p className="text-[11.5px] mt-3" style={{ color: "var(--color-warn)" }}>
              有步骤失败，这里是成功的部分汇总出来的结果。
            </p>
          )}
          {view.ended_at && (
            <p className="text-[11.5px] text-[var(--color-muted)] mt-3">
              完成于 {fmt.relative(view.ended_at)}
            </p>
          )}
        </section>
      )}

      {detailRun && <RunDetailById runId={detailRun} onClose={() => setDetailRun(null)} />}
    </div>
  );
}
