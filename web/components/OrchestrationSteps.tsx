"use client";

/**
 * 编排执行详情 —— **不做画布**，全部用「一行一对象 + 就地展开」表达。
 *
 * 为什么不用画布
 * --------------
 * 编排的真实使用以串行/小扇出为主（库里 42 条多步编排里，绝大多数是 2~4 步），
 * 画布在这种规模下只带来两件事：看不清（节点缩得很小）、点不准（触屏）。
 * 真正要回答的只有三个问题：
 *
 *   现在跑到哪一步 / 谁和谁同时在跑 / 这一步到底干了什么
 *
 * 所以这里用三样东西回答，全部是行内信息：
 *
 *   ① 汇总一行：几步 · 并行几路 · 多久 · 多少 token · 结论
 *   ② 步骤列表：序号 + 助手名 + 状态词 + 结论首行 + 耗时
 *   ③ 行尾微条：宽度=耗时占比、左偏移=开始位置 —— 重叠即并行、首尾相接即串行
 *
 * 并行不用缩进硬猜：按**时间区间重叠**分组（重叠的就是同时在跑），组头写明
 * "并行 N 路 · 完成 M/N"。这样无论并行/串行/DAG 哪种模式，同一套渲染都成立。
 *
 * 点行就地展开：输入 / 输出 / 错误（红块在最上面）+ 失败可重跑这一步。
 */

import { useCallback, useMemo, useState } from "react";

import Markdown from "@/components/Markdown";
import { HitlPrompt } from "@/components/HitlPrompt";
import { api } from "@/lib/api";
import type { OrchestrationDetail, OrchestrationStepRead } from "@/lib/types";

const STATUS_TEXT: Record<string, string> = {
  pending: "待跑",
  running: "跑中",
  ok: "完成",
  error: "失败",
  aborted: "已中止",
  waiting_hitl: "等你确认",
};

const STATUS_COLOR: Record<string, string> = {
  pending: "var(--color-muted)",
  running: "var(--color-accent)",
  ok: "var(--color-text)",
  error: "var(--color-err)",
  aborted: "var(--color-muted)",
  waiting_hitl: "var(--color-warn)",
};

function dur(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

function tokens(usage: Record<string, number> | undefined): number {
  const u = usage ?? {};
  return Number(u.tokens_in ?? 0) + Number(u.tokens_out ?? 0);
}

function firstLine(text: string): string {
  const line = (text || "").split("\n").map((x) => x.trim()).find((x) => x.length > 0) ?? "";
  return line.replace(/^[#>*\-\s]+/, "").slice(0, 70);
}

type Group = { steps: OrchestrationStepRead[]; start: number; end: number };

/** 按时间区间重叠分组：重叠的算"同时在跑"。 */
function groupByOverlap(steps: OrchestrationStepRead[], now: number): Group[] {
  const list = [...steps].sort(
    (a, b) => a.started_at - b.started_at || (a.order_index ?? 0) - (b.order_index ?? 0),
  );
  const out: Group[] = [];
  for (const st of list) {
    const end = st.ended_at ?? now;
    const last = out[out.length - 1];
    if (last && st.started_at < last.end) {
      last.steps.push(st);
      last.end = Math.max(last.end, end);
    } else {
      out.push({ steps: [st], start: st.started_at, end });
    }
  }
  return out;
}

export function OrchestrationSteps({
  orch,
  onRefresh,
}: {
  orch: OrchestrationDetail;
  onRefresh: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>("");
  const [note, setNote] = useState<string>("");

  const now = Date.now();
  const groups = useMemo(() => groupByOverlap(orch.steps, now), [orch.steps, now]);

  /** 这份编排当时由谁跑、第几版 —— 从冻结的 spec 里取，缺失（老记录）就整行不显示 */
  const snapshot = useMemo(() => {
    const snap = (orch.spec ?? {}).snapshot as
      | { hash?: string; agents?: Record<string, { name?: string | null; version?: number | null }> }
      | undefined;
    if (!snap?.hash) return null;
    const rows = Object.values(snap.agents ?? {})
      .map((a) => (a?.name ? `${a.name} v${a.version ?? "?"}` : ""))
      .filter(Boolean);
    return { hash: snap.hash, team: rows.join("、") || "（团队信息缺失）" };
  }, [orch.spec]);

  const span = useMemo(() => {
    if (orch.steps.length === 0) return { start: orch.started_at, end: orch.ended_at ?? now };
    const start = Math.min(...orch.steps.map((s) => s.started_at));
    const end = Math.max(...orch.steps.map((s) => s.ended_at ?? now));
    return { start, end: Math.max(end, start + 1) };
  }, [orch.steps, orch.started_at, orch.ended_at, now]);

  const total = Math.max(span.end - span.start, 1);
  const doneCount = orch.steps.filter((s) => s.status === "ok").length;
  const failed = orch.steps.filter((s) => s.status === "error" || s.status === "aborted").length;
  const wide = groups.reduce((m, g) => Math.max(m, g.steps.length), 1);
  const totalTokens = orch.steps.reduce((n, s) => n + tokens(s.usage), 0);

  const verification = useMemo(() => {
    const out = (orch.output ?? {}) as Record<string, unknown>;
    const v = out.verification as Record<string, unknown> | undefined;
    if (!v) return null;
    const cites = (v.citations ?? {}) as { total?: number; ok?: number; missing?: unknown[] };
    const cov = (v.coverage ?? {}) as { acceptance?: string[]; gaps?: string[] };
    const conflicts = (v.conflicts ?? []) as unknown[];
    return {
      total: Number(cites.total ?? 0),
      ok: Number(cites.ok ?? 0),
      missing: (cites.missing ?? []).length,
      gaps: (cov.gaps ?? []).length,
      acceptance: (cov.acceptance ?? []).length,
      conflicts: conflicts.length,
    };
  }, [orch.output]);

  const rerun = useCallback(
    async (runId: string) => {
      setBusy(runId);
      setNote("");
      try {
        await api.rerunRun(runId);
        setNote("已重新排进队列，稍等几秒刷新");
        onRefresh();
      } catch (e) {
        setNote(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy("");
      }
    },
    [onRefresh],
  );

  const conclusion =
    orch.status === "ok" ? "全部完成" : failed > 0 ? `${failed} 步失败` : orch.status === "running" ? "进行中" : orch.status;

  return (
    <div className="space-y-2">
      {/* ① 汇总一行：一行数字代替一堆卡片 */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-[var(--color-muted)]">
        <span className="mono text-[var(--color-text)]">{orch.steps.length} 步</span>
        {wide > 1 && <span>· 并行 {wide} 路</span>}
        <span>· {dur(span.end - span.start)}</span>
        {totalTokens > 0 && <span>· {(totalTokens / 1000).toFixed(1)}k token</span>}
        <span style={{ color: failed > 0 ? "var(--color-err)" : "var(--color-text)" }}>· {conclusion}</span>
        {verification && verification.total > 0 && (
          <span
            title={`引用 ${verification.ok}/${verification.total} 核上，未覆盖判据 ${verification.gaps} 条`}
            style={{ color: verification.missing > 0 ? "var(--color-warn)" : "var(--color-muted)" }}
          >
            · 验证 {verification.ok}/{verification.total}
            {verification.gaps > 0 ? ` · 未覆盖 ${verification.gaps}` : ""}
          </span>
        )}
        {/* 这次跑的是哪一份编排：结构指纹 + 每位助手的版本。
            助手会被改（v3→v4），没有这一行，复盘时说不清"当时它是什么样"。 */}
        {snapshot && (
          <span
            className="mono"
            title={`结构指纹 ${snapshot.hash}\n${snapshot.team}`}
          >
            · {snapshot.hash.slice(0, 6)} · {snapshot.team}
          </span>
        )}
      </div>

      {/* ② 步骤列表 + ③ 行尾微条 */}
      <div className="space-y-1">
        {groups.map((g, gi) => {
          const parallel = g.steps.length > 1;
          const okInGroup = g.steps.filter((s) => s.status === "ok").length;
          return (
            <div key={`g${gi}`} className="space-y-1">
              {parallel && (
                <div className="flex items-center gap-2 text-[11px] text-[var(--color-muted)] pl-1">
                  <span className="mono">▾ 并行 {g.steps.length} 路</span>
                  <span>· {dur(g.end - g.start)}</span>
                  <span>
                    · {okInGroup}/{g.steps.length} 完成
                  </span>
                </div>
              )}
              {g.steps.map((st, si) => {
                const open = openId === st.run_id;
                const isParallel = parallel;
                const left = ((st.started_at - span.start) / total) * 100;
                const w = Math.max((((st.ended_at ?? now) - st.started_at) / total) * 100, 1.5);
                const idx = parallel ? `${gi + 1}${String.fromCharCode(97 + si)}` : String(gi + 1);
                return (
                  <div key={st.run_id} className={isParallel ? "pl-4" : ""}>
                    <button
                      type="button"
                      onClick={() => setOpenId(open ? null : st.run_id)}
                      className="w-full text-left rounded-md px-2.5 py-2 bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-3)] transition-colors min-h-[44px] lg:min-h-0"
                    >
                      <div className="flex items-center gap-2 text-[12px]">
                        <span className="mono text-[var(--color-muted)] w-6 shrink-0">{idx}</span>
                        <span className="truncate font-medium">{st.agent_name}</span>
                        {st.item_label && (
                          <span className="text-[var(--color-muted)] truncate shrink-0 max-w-[30%]">
                            · {st.item_label}
                          </span>
                        )}
                        <span
                          className="mono shrink-0"
                          style={{ color: STATUS_COLOR[st.status] ?? "var(--color-text)" }}
                        >
                          {STATUS_TEXT[st.status] ?? st.status}
                        </span>
                        <span className="text-[var(--color-muted)] truncate flex-1 min-w-0">
                          {st.error ? st.error : firstLine(st.output_text)}
                        </span>
                        <span className="mono text-[11px] text-[var(--color-muted)] shrink-0">
                          {dur((st.ended_at ?? now) - st.started_at)}
                        </span>
                      </div>
                      {/* 行尾微条：重叠=并行，首尾相接=串行 */}
                      <div className="relative h-[3px] mt-1.5 rounded bg-[var(--color-surface-3)] overflow-hidden">
                        <span
                          className="absolute top-0 h-full rounded"
                          style={{
                            left: `${Math.min(Math.max(left, 0), 99)}%`,
                            width: `${Math.min(w, 100 - Math.min(Math.max(left, 0), 99))}%`,
                            background:
                              st.status === "error"
                                ? "var(--color-err)"
                                : st.status === "ok"
                                  ? "var(--color-accent)"
                                  : "var(--color-muted)",
                          }}
                        />
                      </div>
                    </button>

                    {/* 停在「要你确认」：就地给允许/拒绝 —— 藏在折叠里等于没有入口 */}
                    {st.status === "waiting_hitl" && st.hitl ? (
                      <div className="mt-1">
                        <HitlPrompt
                          runId={st.run_id}
                          payload={st.hitl as Record<string, unknown>}
                          compact
                          onResumed={() => onRefresh()}
                          onError={(m) => setNote(m)}
                        />
                      </div>
                    ) : null}

                    {open && (
                      <div className="mt-1 space-y-1.5 rounded-md p-2.5 bg-[var(--color-surface-1)] border border-[var(--color-border)]">
                        {st.error && (
                          <div
                            className="rounded p-2 text-[12px] break-all"
                            style={{ background: "var(--color-err-bg, #fef2f2)", color: "var(--color-err)" }}
                          >
                            {st.error}
                          </div>
                        )}
                        <div className="text-[11px] text-[var(--color-muted)]">领到的任务</div>
                        <div className="text-[12px] whitespace-pre-wrap break-words max-h-40 overflow-auto">
                          {st.input_text || "—"}
                        </div>
                        <div className="text-[11px] text-[var(--color-muted)]">产出</div>
                        <div className="text-[12px] max-h-72 overflow-auto">
                          {st.output_text ? <Markdown text={st.output_text} /> : "—"}
                        </div>
                        <div className="flex items-center gap-2 pt-1">
                          {(st.status === "error" || st.status === "aborted") && (
                            <button
                              type="button"
                              disabled={busy === st.run_id}
                              onClick={() => void rerun(st.run_id)}
                              className="text-[12px] px-2.5 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 min-h-[36px]"
                            >
                              {busy === st.run_id ? "重跑中…" : "重跑这一步"}
                            </button>
                          )}
                          <span className="mono text-[11px] text-[var(--color-muted)]">{st.run_id}</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
        {orch.steps.length === 0 && (
          <div className="text-[12px] text-[var(--color-muted)] p-2">还没有步骤（或这次编排只跑了一个助手）。</div>
        )}
      </div>

      {note && <div className="text-[11px] text-[var(--color-muted)]">{note}</div>}
      <div className="text-[11px] text-[var(--color-muted)]">
        {doneCount}/{orch.steps.length} 步完成 · 点任一行看这一步的输入与产出
      </div>
    </div>
  );
}
