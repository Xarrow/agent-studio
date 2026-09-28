"use client";

/**
 * 「运行记录」的详情弹框 —— 在一个页面里看完，不用跳到详情页。
 *
 * 为什么用弹框而不是详情页
 * ----------------------
 * 用户看运行记录的动作是「扫一遍 → 挑一条看看为什么」，看完多半还要回去继续挑。
 * 跳页会把这个来回变成"列表 → 详情 → 返回列表 → 又忘了看到哪"，还会丢掉
 * 筛选条件和选中状态。弹框则原地展开、关掉即回，上下文完全不丢。
 *
 * 两类记录形状不同，所以分两套渲染：
 *   · 助手执行（run）      → 输入/输出 + 对话过程 + LLM 调用 + 工具调用 + 原始 JSON
 *   · LLM 对话测试（裸调用）→ 请求消息 + 回复/错误（它没有工具、没有事件流）
 */

import React, { useCallback, useEffect, useState } from "react";
import { api, fmt } from "@/lib/api";
import type {
  ActivityItem,
  LlmCall,
  LlmCallPayload,
  OrchestrationDetail,
  RunEvent,
  RunTrace,
  ToolCallRow,
} from "@/lib/types";
import { RunTimeline, eventsToSteps } from "@/components/ui/run-timeline";
import { HitlPrompt } from "@/components/HitlPrompt";
import { useFeedback } from "@/components/ui/feedback";
import { SpanWaterfall } from "@/components/SpanWaterfall";
import { DLG_BACKDROP, DLG_CARD } from "@/components/ui/kit";
import { LlmCallsPanel } from "@/components/LlmCallsPanel";

/** 状态配色（与全局一致） */
const STATUS_STYLE: Record<string, string> = {
  ok: "var(--color-ok)",
  running: "var(--color-accent)",
  pending: "var(--color-muted)",
  error: "var(--color-err)",
  aborted: "var(--color-warn)",
  waiting_hitl: "var(--color-warn)",
};

/** 类型标签（人话，不用内部术语） */
export const KIND_LABEL: Record<ActivityItem["kind"], string> = {
  llm_test: "LLM 测试",
  preview: "助手试跑",
  chat: "Agent",
  a2a: "A2A 远端",
  playground: "编排",
};

const KIND_HINT: Record<ActivityItem["kind"], string> = {
  llm_test: "在「LLM 配置」里直接跟模型聊的两句 —— 用来确认这把 key 和这个模型本身能通。",
  preview: "在助手详情页「试跑与观测」里发起的执行 —— 配置时验证助手用的。",
  chat: "在「Agent 执行」页跟助手干活的一轮。",
  a2a: "派给**远端** A2A agent 执行的一路 —— 跑在别的平台上，本平台只拿结果。",
  playground: "在「对话 → 多 Agent 编排」里由编排发起的执行。",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5 border-b border-[var(--color-border)] last:border-0">
      <div className="w-20 shrink-0 text-[12px] text-[var(--color-muted)]">{label}</div>
      <div className="flex-1 min-w-0 text-[12.5px] break-words">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="text-[12.5px] font-medium text-[var(--color-muted)] mb-2">{title}</h3>
      {children}
    </section>
  );
}

export function RunDetailDialog({
  item,
  onClose,
  onDeleted,
}: {
  item: ActivityItem;
  onClose: () => void;
  /** 删掉这条记录后通知外层刷新列表（弹框自己不负责刷新别人的数据） */
  onDeleted?: () => void;
}) {
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [sinking, setSinking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [test, setTest] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const fb = useFeedback();

  const isTest = item.kind === "llm_test";
  /** 归组的编排行：id 就是 orchestration_id —— 详情走编排端点（步骤列表+总结） */
  const isOrch = item.kind === "playground" && item.id.startsWith("orc_");

  const [orch, setOrch] = useState<OrchestrationDetail | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      if (isTest) {
        setTest((await api.modelTest(item.id)) as unknown as Record<string, unknown>);
      } else if (isOrch) {
        setOrch(await api.orchestration(item.id));
      } else {
        setTrace(await api.runTrace(item.id));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [item.id, isTest, isOrch]);

  useEffect(() => {
    void load();
  }, [load]);

  // Esc 关闭 —— 弹框该有的基本键位
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * 把这次执行沉淀为记忆。
   *
   * 这个动作原来在 /runs/<id> 详情页上，那个页面删掉后它就没了入口 ——
   * 后端端点还在、文案还在承诺，但用户点不到。现在挪到这里反而更合理：
   * **在哪看这次执行，就在哪把它沉淀掉**，不用先跳到别处。
   *
   * 保留人工闸门：模型提炼出候选 → 用户确认 → 才落库（避免噪音进记忆库）。
   */
  const sink = async () => {
    setSinking(true);
    try {
      const r = await api.extractMemories(item.id);
      if (r.candidates.length === 0) {
        fb.warn(
          "没有提炼到值得记住的内容",
          r.skipped.length > 0 ? `跳过 ${r.skipped.length} 条：与已有记忆高度相似` : undefined,
        );
        return;
      }
      const ok = await fb.confirm({
        title: `提炼出 ${r.candidates.length} 条候选记忆，保存？`,
        description: "保存后会在后续执行时按相关度召回，并注入 System Prompt。",
        details: r.candidates.map((c) => `[${c.kind}] ${c.content}`),
        confirmText: "保存为记忆",
      });
      if (!ok) return;
      const saved = await api.extractMemories(
        item.id,
        r.candidates.map((c) => ({
          content: c.content,
          agent_id: c.agent_id,
          kind: c.kind,
        })),
      );
      fb.success(`已保存 ${saved.created} 条记忆`, "可在「记忆」页查看与编辑");
    } catch (e) {
      fb.error("提炼失败", e instanceof Error ? e.message : String(e));
    } finally {
      setSinking(false);
    }
  };

  const remove = async () => {
    const ok = await fb.confirm({
      title: "删除这条执行记录？",
      details: [item.id, "含其事件流、模型调用与工具调用明细"],
      danger: true,
      confirmText: "删除",
    });
    if (!ok) return;
    setDeleting(true);
    try {
      // 用统一入口（按 id 前缀分流）—— 助手执行和 LLM 测试都能删
      await api.bulkDeleteRuns([item.id]);
      fb.success("已删除");
      onDeleted?.();
      onClose();
    } catch (e) {
      fb.error("删除失败", e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  };

  const run = trace?.run;
  const events: RunEvent[] = trace?.events ?? [];
  const steps = events.length ? eventsToSteps(events, item.summary ?? undefined) : [];

  /**
   * 输入/输出的取数源**按记录类型分流** —— 编排行手里没有 run（都是 orchestration
   * 本体），若照 run 取会得到空，然后把 item.summary（= 用户那句输入）错当输出显示 ✗
   * （"总结输出"里出现用户自己的提问，比空白更误导）。
   */
  const orchText = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of ["text", "content", "output", "result"]) {
        if (typeof o[k] === "string" && o[k]) return o[k] as string;
      }
    }
    return "";
  };

  const inputText = isOrch
    ? orchText(orch?.input) || item.summary || ""
    : typeof run?.input === "string"
      ? run.input
      : ((run?.input as Record<string, unknown> | undefined)?.text as string) ?? "";
  const outputText = isOrch
    ? orchText(orch?.output)
    : typeof run?.output === "string"
      ? run.output
      : ((run?.output as Record<string, unknown> | undefined)?.content as string) ??
        item.summary ??
        "";

  const messages = (test?.messages as { role: string; content: string }[] | undefined) ?? [];
  const reply = (test?.reply as string | undefined) ?? "";

  /**
   * 展示用的值：一律优先用**拉回来的真实数据**，传入的 item 只当加载前的占位。
   *
   * 为什么这样写：这个弹框要从很多入口打开（对话页、试跑面板、编排、概览、
   * 记忆页……），有的入口手里只有一个 run id，什么都不知道。如果概览依赖
   * 调用方把字段准备齐全，每个入口都得先查一遍 —— 那是重复且易错的。
   * 让弹框自己按 id 取全，调用方就只需要传一个 id。
   */
  const usage = (run?.usage ?? {}) as Record<string, number>;
  const startedAt = isTest
    ? ((test?.started_at as number | undefined) ?? item.at)
    : (run?.started_at ?? item.at);
  const status = isTest
    ? ((test?.status as string | undefined) ?? item.status)
    : (run?.status ?? item.status);
  const duration = isTest
    ? ((test?.duration_ms as number | null | undefined) ?? item.duration_ms)
    : run?.ended_at != null && run?.started_at != null
      ? run.ended_at - run.started_at
      : item.duration_ms;
  const tokensIn = isTest
    ? Number(test?.tokens_in ?? item.tokens_in ?? 0)
    : Number(usage.prompt_tokens ?? usage.input_tokens ?? item.tokens_in ?? 0);
  const tokensOut = isTest
    ? Number(test?.tokens_out ?? item.tokens_out ?? 0)
    : Number(usage.completion_tokens ?? usage.output_tokens ?? item.tokens_out ?? 0);
  const title = isTest
    ? [test?.credential_name, test?.model].filter(Boolean).join(" · ") || item.title
    : (trace?.agent_name ?? item.title ?? run?.agent_id ?? "");
  const model = isTest
    ? ((test?.model as string | undefined) ?? item.model)
    : (((run?.definition_snapshot as Record<string, unknown> | undefined)?.model as
        | Record<string, string>
        | undefined)?.name ?? item.model);
  const errorText = isTest
    ? ((test?.error as string | null | undefined) ?? null)
    : (run?.error ?? null);

  return (
    <div
      className={DLG_BACKDROP}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`${DLG_CARD} max-w-4xl p-5`}>
        {/* ── 头部：类型 + 主体 + 状态 ─────────────────────────── */}
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className="text-[11px] px-1.5 py-0.5 rounded"
                style={{
                  background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
                  color: "var(--color-accent)",
                }}
                title={KIND_HINT[item.kind]}
              >
                {KIND_LABEL[item.kind]}
              </span>
              <h2 className="text-[16px] font-medium truncate">
                {title || <span className="text-[var(--color-muted)]">加载中…</span>}
              </h2>
            </div>
            <p className="text-[11.5px] text-[var(--color-muted)] mt-1 mono">{item.id}</p>
          </div>
          <button className="btn shrink-0" onClick={onClose}>
            关闭
          </button>
        </div>

        {err && (
          <div className="text-[12.5px] text-[var(--color-err)] mb-3">✗ {err}</div>
        )}

        {/* 这个 Run 卡在等待授权 —— 就地确认。
            放在最前面是因为：它是唯一挡住执行的东西，其他信息都可以等等。 */}
        {run?.status === "waiting_hitl" && (
          <div className="mb-3">
            <HitlPrompt
              runId={item.id}
              payload={run.pending_hitl as Record<string, unknown> | null | undefined}
              onResumed={() => {
                // 恢复后运行会继续，隔一会儿把详情刷新一遍就能看到后续
                setTimeout(() => void load(), 1500);
              }}
            />
          </div>
        )}

        {/* ── 概览：一屏之内看清这条是什么 ─────────────────────── */}
        <div className="card p-3.5 bg-[var(--color-surface-2)]">
          <Row label="时间">
            {new Date(startedAt).toLocaleString()}
            <span className="text-[var(--color-muted)]"> · {fmt.relative(startedAt)}</span>
          </Row>
          <Row label="状态">
            <span className="mono" style={{ color: STATUS_STYLE[status] ?? "var(--color-text)" }}>
              {status}
            </span>
            {duration != null && (
              <span className="text-[var(--color-muted)]"> · 耗时 {fmt.ms(duration)}</span>
            )}
          </Row>
          {isTest ? (
            <>
              <Row label="模型">{model || "—"}</Row>
              <Row label="端点">{(test?.base_url as string) ?? "—"}</Row>
            </>
          ) : (
            <>
              <Row label="助手">{title || "—"}</Row>
              {model && <Row label="模型">{model}</Row>}
              {item.subtitle && <Row label="上下文">{item.subtitle}</Row>}
              {run?.session_id && <Row label="会话">多轮对话</Row>}
            </>
          )}
          <Row label="Tokens">
            {tokensIn || tokensOut
              ? `输入 ${tokensIn} · 输出 ${tokensOut}`
              : loading
                ? "…"
                : "未记录"}
          </Row>
          {errorText && (
            <Row label="错误">
              <span className="text-[var(--color-err)] break-all">{errorText}</span>
            </Row>
          )}
        </div>

        {loading ? (
          <div className="p-6 text-center text-[12.5px] text-[var(--color-muted)]">加载中…</div>
        ) : isOrch && orch ? (
          /* ────────────── 编排执行（整次归组行）──────────────
              一次编排 = 编排者拆解 → 各助手分步 → 回总结。
              这里给「任务输入 + 各步骤状态一览 + 最终总结」；
              要逐步看过程，走底部「以流程查看」进画布回放。 */
          <>
            <Section title="任务输入">
              <div className="rounded-md p-2.5 bg-[var(--color-surface-2)] text-[12.5px] whitespace-pre-wrap break-words">
                {inputText || "—"}
              </div>
            </Section>
            <Section title={`执行步骤（${orch.steps.length} 步）`}>
              <div className="space-y-1.5">
                {orch.steps.map((st, i) => (
                  <div
                    key={st.run_id}
                    className="rounded-md p-2.5 bg-[var(--color-surface-2)] flex items-center gap-2.5 text-[12.5px]"
                  >
                    <span className="text-[var(--color-muted)] mono w-5 shrink-0">{i + 1}</span>
                    <span
                      className="mono text-[11px] shrink-0"
                      style={{ color: STATUS_STYLE[st.status] ?? "var(--color-text)" }}
                    >
                      {st.status}
                    </span>
                    <span className="truncate">{st.agent_name}</span>
                    {st.item_label && (
                      <span className="text-[var(--color-muted)] truncate">· {st.item_label}</span>
                    )}
                    {st.error && (
                      <span className="text-[var(--color-err)] truncate ml-auto" title={st.error}>
                        {st.error}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </Section>
            <Section title="总结输出">
              <div className="rounded-md p-2.5 bg-[var(--color-surface-2)] text-[12.5px] whitespace-pre-wrap break-words">
                {outputText || "—"}
              </div>
            </Section>
          </>
        ) : isTest ? (
          /* ────────────── LLM 对话测试 ────────────── */
          <>
            <Section title={`请求消息（${messages.length} 条）`}>
              <div className="space-y-2">
                {messages.length === 0 ? (
                  <p className="text-[12.5px] text-[var(--color-muted)]">没有记录到请求内容。</p>
                ) : (
                  messages.map((m, i) => (
                    <div key={i} className="rounded-md p-2.5 bg-[var(--color-surface-2)]">
                      <div className="text-[11px] text-[var(--color-muted)] mb-1 mono">
                        {m.role}
                      </div>
                      <div className="text-[12.5px] whitespace-pre-wrap break-words">
                        {m.content}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </Section>
            <Section title="模型回复">
              <div className="rounded-md p-2.5 bg-[var(--color-surface-2)]">
                <div className="text-[12.5px] whitespace-pre-wrap break-words">
                  {reply || <span className="text-[var(--color-muted)]">（没有回复内容）</span>}
                </div>
              </div>
            </Section>
          </>
        ) : (
          /* ────────────── 助手执行 ────────────── */
          <>
            <Section title="输入">
              <div className="rounded-md p-2.5 bg-[var(--color-surface-2)] text-[12.5px] whitespace-pre-wrap break-words">
                {inputText || "—"}
              </div>
            </Section>
            <Section title="输出">
              <div className="rounded-md p-2.5 bg-[var(--color-surface-2)] text-[12.5px] whitespace-pre-wrap break-words">
                {outputText || "—"}
              </div>
            </Section>

            {steps.length > 0 && (
              <Section title="对话过程（它想了什么、做了什么）">
                <div className="rounded-md p-3 bg-[var(--color-surface-2)]">
                  <RunTimeline steps={steps} />
                </div>
              </Section>
            )}

            {trace?.spans && trace.spans.length > 0 && (
              <Section title="耗时瀑布（谁在吃时间）">
                <SpanWaterfall spans={trace.spans} />
              </Section>
            )}

            {trace?.llm_calls && trace.llm_calls.length > 0 && (
              <Section title="模型请求（发了什么、回了什么）">
                <LlmCallsPanel runId={item.id} calls={trace.llm_calls} title="" />
              </Section>
            )}

            {trace?.tool_calls && trace.tool_calls.length > 0 && (
              <Section title={`工具调用（${trace.tool_calls.length} 次）`}>
                <div className="space-y-1.5">
                  {trace.tool_calls.map((t: ToolCallRow) => (
                    <div
                      key={t.id}
                      className="rounded-md p-2.5 bg-[var(--color-surface-2)] text-[12px]"
                    >
                      <div className="flex items-center gap-2">
                        <span className="mono">{t.tool_name}</span>
                        <span className="text-[var(--color-muted)]">
                          {fmt.ms(t.duration_ms)} · {t.status}
                        </span>
                      </div>
                      {t.args && Object.keys(t.args).length > 0 && (
                        <pre className="mt-1.5 text-[11px] text-[var(--color-muted)] whitespace-pre-wrap break-all">
                          {JSON.stringify(t.args, null, 1)}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <Section title="原始记录">
              <button className="btn btn-sm" onClick={() => setRawOpen((v) => !v)}>
                {rawOpen ? "▾ 收起" : "▸ 展开原始 JSON"}
              </button>
              {rawOpen && (
                <pre className="mt-2 max-h-72 overflow-auto rounded-md p-2.5 bg-[var(--color-surface-2)] text-[11px] whitespace-pre-wrap break-all">
                  {JSON.stringify(trace, null, 2)}
                </pre>
              )}
            </Section>
          </>
        )}

        {/* ── 底部动作区 ─────────────────────────────────────────
            把"对这条记录能做的事"放在看它的地方 —— 不用先记住 id 再跳去别处操作。 */}
        <div className="flex items-center gap-2 mt-5 pt-4 border-t border-[var(--color-border)] flex-wrap">
          {!isTest && status === "ok" && (
            <button
              className="btn btn-sm"
              disabled={sinking}
              title="用模型从这次执行里提炼候选记忆，确认后保存"
              onClick={() => void sink()}
            >
              {sinking ? "提炼中…" : "沉淀为记忆"}
            </button>
          )}
          {!isTest && status !== "ok" && (
            <span className="text-[11.5px] text-[var(--color-muted)]">
              只有成功的执行才能沉淀记忆
            </span>
          )}
          <div className="flex-1" />
          <button
            className="btn btn-sm text-[var(--color-err)]"
            disabled={deleting}
            title="删除这条记录（含事件与调用明细）"
            onClick={() => void remove()}
          >
            {deleting ? "删除中…" : "删除这条记录"}
          </button>
        </div>
      </div>
    </div>
  );
}


/**
 * 便捷入口：手里只有一个 run id 时用这个。
 *
 * 详情全部由弹框自己按 id 拉取，调用方不需要准备任何字段 ——
 * 所以「哪里点开详情」这件事在各页面都能写成一行，行为也天然一致。
 */
export function RunDetailById({ runId, onClose }: { runId: string; onClose: () => void }) {
  return (
    <RunDetailDialog
      item={{
        kind: "preview",
        id: runId,
        at: Date.now(),
        duration_ms: null,
        status: "ok",
        title: "",
        subtitle: null,
        agent_id: null,
        credential_id: null,
        model: null,
        tokens_in: 0,
        tokens_out: 0,
        summary: null,
        error: null,
      }}
      onClose={onClose}
    />
  );
}
