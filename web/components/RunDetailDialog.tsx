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

import { useCallback, useEffect, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { ActivityItem, LlmCall, RunEvent, RunTrace, ToolCallRow } from "@/lib/types";
import { RunTimeline, eventsToSteps } from "@/components/ui/run-timeline";

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
  chat: "对话",
  playground: "编排",
};

const KIND_HINT: Record<ActivityItem["kind"], string> = {
  llm_test: "在「LLM 配置」里直接跟模型聊的两句 —— 用来确认这把 key 和这个模型本身能通。",
  preview: "在助手详情页「试跑与观测」里发起的执行 —— 配置时验证助手用的。",
  chat: "在「对话」页跟助手正式聊天的一轮。",
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
}: {
  item: ActivityItem;
  onClose: () => void;
}) {
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [test, setTest] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState(false);

  const isTest = item.kind === "llm_test";

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      if (isTest) {
        setTest((await api.modelTest(item.id)) as unknown as Record<string, unknown>);
      } else {
        setTrace(await api.runTrace(item.id));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [item.id, isTest]);

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

  const run = trace?.run;
  const events: RunEvent[] = trace?.events ?? [];
  const steps = events.length ? eventsToSteps(events, item.summary ?? undefined) : [];

  const inputText =
    typeof run?.input === "string"
      ? run.input
      : ((run?.input as Record<string, unknown> | undefined)?.text as string) ?? "";
  const outputText =
    typeof run?.output === "string"
      ? run.output
      : ((run?.output as Record<string, unknown> | undefined)?.content as string) ??
        item.summary ??
        "";

  const messages = (test?.messages as { role: string; content: string }[] | undefined) ?? [];
  const reply = (test?.reply as string | undefined) ?? "";

  return (
    <div
      className="fixed inset-0 bg-[var(--color-overlay)] flex items-start justify-center p-4 z-50 overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card w-full max-w-4xl p-5 my-8">
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
              <h2 className="text-[16px] font-medium truncate">{item.title}</h2>
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

        {/* ── 概览：一屏之内看清这条是什么 ─────────────────────── */}
        <div className="card p-3.5 bg-[var(--color-surface-2)]">
          <Row label="时间">
            {new Date(item.at).toLocaleString()}
            <span className="text-[var(--color-muted)]"> · {fmt.relative(item.at)}</span>
          </Row>
          <Row label="状态">
            <span
              className="mono"
              style={{ color: STATUS_STYLE[item.status] ?? "var(--color-text)" }}
            >
              {item.status}
            </span>
            {item.duration_ms != null && (
              <span className="text-[var(--color-muted)]"> · 耗时 {fmt.ms(item.duration_ms)}</span>
            )}
          </Row>
          {isTest ? (
            <>
              <Row label="模型">{item.model || "—"}</Row>
              <Row label="端点">{(test?.base_url as string) ?? "—"}</Row>
            </>
          ) : (
            <>
              <Row label="助手">{item.title}</Row>
              {item.model && <Row label="模型">{item.model}</Row>}
              {item.subtitle && <Row label="上下文">{item.subtitle}</Row>}
            </>
          )}
          <Row label="Tokens">
            {item.tokens_in || item.tokens_out
              ? `输入 ${item.tokens_in} · 输出 ${item.tokens_out}`
              : loading
                ? "…"
                : "未记录"}
          </Row>
          {item.error && (
            <Row label="错误">
              <span className="text-[var(--color-err)] break-all">{item.error}</span>
            </Row>
          )}
        </div>

        {loading ? (
          <div className="p-6 text-center text-[12.5px] text-[var(--color-muted)]">加载中…</div>
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

            {trace?.llm_calls && trace.llm_calls.length > 0 && (
              <Section title={`模型调用（${trace.llm_calls.length} 次）`}>
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px] min-w-[520px]">
                    <thead className="text-[var(--color-muted)]">
                      <tr>
                        <th className="text-left py-1.5 font-normal">#</th>
                        <th className="text-left py-1.5 font-normal">模型</th>
                        <th className="text-right py-1.5 font-normal">首字延迟</th>
                        <th className="text-right py-1.5 font-normal">耗时</th>
                        <th className="text-right py-1.5 font-normal">Tokens</th>
                        <th className="text-left py-1.5 font-normal pl-3">状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trace.llm_calls.map((c: LlmCall) => (
                        <tr key={c.id} className="border-t border-[var(--color-border)]">
                          <td className="py-1.5 text-[var(--color-muted)]">{c.iteration}</td>
                          <td className="py-1.5 mono">{c.model ?? "—"}</td>
                          <td className="py-1.5 text-right">{fmt.ms(c.ttft_ms)}</td>
                          <td className="py-1.5 text-right">{fmt.ms(c.duration_ms)}</td>
                          <td className="py-1.5 text-right">
                            {c.tokens_in}/{c.tokens_out}
                          </td>
                          <td className="py-1.5 pl-3 mono" style={{ color: STATUS_STYLE[c.status] ?? "" }}>
                            {c.status}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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
      </div>
    </div>
  );
}
