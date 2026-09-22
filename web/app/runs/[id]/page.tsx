"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, fmt, STATUS_STYLE } from "@/lib/api";
import type { RunTrace } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";

/** 记忆类型的中文名（提炼确认框里展示用） */
const KIND_LABEL: Record<string, string> = {
  fact: "事实",
  preference: "偏好",
  summary: "结论",
  instruction: "要求",
};

export default function RunTracePage() {
  const fb = useFeedback();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const runId = params.id;
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"waterfall" | "logs" | "output">("waterfall");
  const [deleting, setDeleting] = useState(false);
  const [sinking, setSinking] = useState(false);

  useEffect(() => {
    api
      .runTrace(runId)
      .then(setTrace)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [runId]);

  if (err) {
    return <div className="p-4 md:p-6 lg:p-7 text-[13px] text-[var(--color-err)]">加载失败：{err}</div>;
  }
  if (!trace) {
    return <div className="p-4 md:p-6 lg:p-7 text-[13px] text-[var(--color-muted)]">加载中…</div>;
  }

  const { run, metrics, llm_calls, tool_calls, events } = trace;
  const totalMs =
    (run.ended_at ?? Date.now()) - run.started_at ||
    Number(metrics.llm_ms) + Number(metrics.tool_ms) ||
    1;

  return (
    <div className="p-4 md:p-6 lg:p-7 max-w-6xl">
      <header className="mb-5">
        <Link href="/runs" className="text-[12px] text-[var(--color-muted)]">
          ← Runs
        </Link>
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          <h1 className="text-[21px] font-semibold tracking-tight mono">{run.id}</h1>
          <span className={`tag ${STATUS_STYLE[run.status] ?? ""}`}>{run.status}</span>

          {/* 手动沉淀路径：从这次执行提炼记忆（模型提炼 → 用户确认 → 落库） */}
          <button
            className="btn ml-auto"
            disabled={sinking || run.status !== "ok"}
            title={run.status !== "ok" ? "只有成功的执行才能沉淀记忆" : "用模型从这次执行里提炼候选记忆"}
            onClick={async () => {
              setSinking(true);
              try {
                const r = await api.extractMemories(run.id);
                if (r.candidates.length === 0) {
                  fb.warn(
                    "没有提炼到值得记住的内容",
                    r.skipped.length > 0
                      ? `跳过 ${r.skipped.length} 条：与已有记忆高度相似`
                      : undefined,
                  );
                  return;
                }
                // 人工闸门：确认后才落库，避免把噪音写进记忆库
                const ok = await fb.confirm({
                  title: `提炼出 ${r.candidates.length} 条候选记忆，保存？`,
                  description: "保存后会在后续执行时按相关度召回，并注入 System Prompt。",
                  details: r.candidates.map(
                    (c) => `[${KIND_LABEL[c.kind] ?? c.kind}] ${c.content}`,
                  ),
                  confirmText: "保存为记忆",
                });
                if (!ok) return;

                const saved = await api.extractMemories(
                  run.id,
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
            }}
          >
            {sinking ? "提炼中…" : "沉淀为记忆"}
          </button>

          <button
            className="btn text-[var(--color-err)]"
            disabled={deleting || ["running", "pending", "waiting_hitl"].includes(run.status)}
            title={
              ["running", "pending", "waiting_hitl"].includes(run.status)
                ? "运行中的记录需先中断"
                : "删除这条记录（含事件与调用明细）"
            }
            onClick={async () => {
              const ok = await fb.confirm({
                title: "删除这条执行记录？",
                details: [run.id, "含其事件流、LLM 调用与工具调用明细"],
                danger: true,
                confirmText: "删除",
              });
              if (!ok) return;
              setDeleting(true);
              try {
                await api.deleteRun(run.id);
                router.push("/runs");
              } catch (e) {
                fb.error("删除失败", e instanceof Error ? e.message : String(e));
                setDeleting(false);
              }
            }}
          >
            {deleting ? "删除中…" : "删除此记录"}
          </button>
        </div>
        <div className="text-[12px] text-[var(--color-muted)] mt-1">
          <Link href={`/agents/${run.agent_id}`} className="text-[var(--color-accent)]">
            {run.agent_id}
          </Link>{" "}
          · v{run.agent_version} · {run.runtime} · 开始于 {fmt.time(run.started_at)}
        </div>
      </header>

      {run.error && (
        <div className="card p-3.5 mb-4 text-[12.5px] text-[var(--color-err)]">
          ✗ {run.error}
        </div>
      )}

      {/* 指标卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
        <Metric label="总耗时" value={fmt.ms(totalMs)} />
        <Metric
          label="LLM 耗时"
          value={fmt.ms(metrics.llm_ms as number)}
          sub={`${metrics.llm_calls ?? 0} 次调用`}
        />
        <Metric
          label="工具耗时"
          value={fmt.ms(metrics.tool_ms as number)}
          sub={`${metrics.tool_calls ?? 0} 次调用`}
        />
        <Metric
          label="TTFT 均值"
          value={fmt.ms(metrics.ttft_ms_avg as number)}
          sub={`峰值 ${fmt.ms(metrics.ttft_ms_max as number)}`}
        />
        <Metric
          label="tokens"
          value={`${metrics.tokens_in ?? 0}/${metrics.tokens_out ?? 0}`}
          sub={`缓存 ${metrics.tokens_cache_read ?? 0}`}
        />
      </div>

      {/* 阶段占比 */}
      <div className="card p-4 mb-5">
        <div className="text-[12.5px] text-[var(--color-muted)] mb-2">
          阶段耗时占比（判断瓶颈在模型还是工具）
        </div>
        <div className="flex h-6 rounded-md overflow-hidden bg-[var(--color-bg)]">
          <div
            className="bg-[var(--color-accent)] flex items-center justify-center text-[11px] text-[var(--color-accent-fg)]"
            style={{
              width: `${(Number(metrics.llm_ms) / totalMs) * 100}%`,
            }}
            title={`模型 ${fmt.ms(metrics.llm_ms as number)}`}
          >
            {Number(metrics.llm_ms) / totalMs > 0.12 && "模型"}
          </div>
          <div
            className="bg-[var(--color-ok)] flex items-center justify-center text-[11px] text-[var(--color-accent-fg)]"
            style={{
              width: `${(Number(metrics.tool_ms) / totalMs) * 100}%`,
            }}
            title={`工具 ${fmt.ms(metrics.tool_ms as number)}`}
          >
            {Number(metrics.tool_ms) / totalMs > 0.12 && "工具"}
          </div>
        </div>
      </div>

      <div className="flex gap-1 mb-4 border-b border-[var(--color-border)]">
        {(
          [
            ["waterfall", "耗时瀑布图"],
            ["logs", `事件日志 (${events.length})`],
            ["output", "最终输出"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-4 py-2 text-[13px] border-b-2 -mb-px transition-colors ${
              tab === k
                ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "waterfall" && (
        <section className="card p-4">
          <h2 className="text-[14px] font-medium mb-3">调用时间线</h2>
          <div className="space-y-2.5">
            {llm_calls.map((c) => (
              <Bar
                key={`l${c.id}`}
                base={run.started_at}
                total={totalMs}
                start={c.started_at}
                duration={c.duration_ms ?? 0}
                ttft={c.ttft_ms}
                label={`LLM #${c.iteration} · ${c.model ?? ""}`}
                color="var(--color-accent)"
                right={`${fmt.ms(c.duration_ms)} · ttft ${fmt.ms(c.ttft_ms)} · ${c.tokens_in}/${c.tokens_out} tok`}
              />
            ))}
            {tool_calls.map((t) => (
              <Bar
                key={`t${t.id}`}
                base={run.started_at}
                total={totalMs}
                start={t.started_at}
                duration={t.duration_ms ?? 0}
                label={`工具 ${t.tool_name}`}
                color={t.status === "ok" ? "var(--color-ok)" : "var(--color-err)"}
                right={`${fmt.ms(t.duration_ms)} · ${fmt.bytes(t.result_size)} · ${t.status}`}
              />
            ))}
            {llm_calls.length === 0 && tool_calls.length === 0 && (
              <p className="text-[12.5px] text-[var(--color-muted)]">
                没有采集到调用记录
              </p>
            )}
          </div>

          {llm_calls.length > 0 && (
            <>
              <h3 className="text-[13.5px] font-medium mt-6 mb-2">LLM 调用明细</h3>
              <table className="w-full text-[12px]">
                <thead className="text-[var(--color-muted)]">
                  <tr>
                    <th className="text-left py-1.5 font-medium">轮次</th>
                    <th className="text-left font-medium">模型</th>
                    <th className="text-right font-medium">耗时</th>
                    <th className="text-right font-medium">TTFT</th>
                    <th className="text-right font-medium">in/out</th>
                    <th className="text-right font-medium">缓存</th>
                    <th className="text-left font-medium pl-3">状态</th>
                  </tr>
                </thead>
                <tbody className="mono">
                  {llm_calls.map((c) => (
                    <tr key={c.id} className="border-t border-[var(--color-border)]">
                      <td className="py-1.5">#{c.iteration}</td>
                      <td>{c.model}</td>
                      <td className="text-right">{fmt.ms(c.duration_ms)}</td>
                      <td className="text-right">{fmt.ms(c.ttft_ms)}</td>
                      <td className="text-right">
                        {c.tokens_in}/{c.tokens_out}
                      </td>
                      <td className="text-right">{c.tokens_cache_read}</td>
                      <td className={`pl-3 ${STATUS_STYLE[c.status] ?? ""}`}>{c.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {tool_calls.length > 0 && (
            <>
              <h3 className="text-[13.5px] font-medium mt-6 mb-2">工具调用明细</h3>
              <div className="space-y-2">
                {tool_calls.map((t) => (
                  <div key={t.id} className="p-2.5 rounded-md bg-[var(--color-bg)]">
                    <div className="flex items-center justify-between text-[12px]">
                      <span className="mono">
                        {t.tool_name}
                        <span className="text-[var(--color-muted)]">
                          {" "}
                          · 轮次 #{t.iteration}
                        </span>
                      </span>
                      <span className="text-[var(--color-muted)] mono">
                        {fmt.ms(t.duration_ms)} · {fmt.bytes(t.result_size)} ·{" "}
                        <span className={STATUS_STYLE[t.status] ?? ""}>{t.status}</span>
                      </span>
                    </div>
                    {t.args && Object.keys(t.args).length > 0 && (
                      <pre className="text-[11px] text-[var(--color-muted)] mt-1.5 whitespace-pre-wrap break-all">
                        参数 {JSON.stringify(t.args)}
                      </pre>
                    )}
                    {t.result_preview && (
                      <pre className="text-[11px] text-[var(--color-ok)] mt-1.5 whitespace-pre-wrap break-all max-h-24 overflow-auto">
                        {t.result_preview}
                      </pre>
                    )}
                    {t.error && (
                      <div className="text-[11px] text-[var(--color-err)] mt-1">
                        {t.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {tab === "logs" && (
        <section className="card p-4">
          <div className="font-mono text-[11.5px] space-y-1 max-h-[560px] overflow-auto">
            {events.map((e) => (
              <div key={e.seq} className="flex gap-3">
                <span className="text-[var(--color-muted)] shrink-0 w-10 text-right">
                  {e.seq}
                </span>
                <span className="shrink-0 w-36 text-[var(--color-accent)]">{e.type}</span>
                <span className="text-[var(--color-muted)] shrink-0">
                  +{e.ts - run.started_at}ms
                </span>
                <span className="text-[var(--color-text)] break-all opacity-80">
                  {JSON.stringify(e.payload).slice(0, 300)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === "output" && (
        <section className="card p-4">
          <h2 className="text-[14px] font-medium mb-3">最终输出</h2>
          {run.output ? (
            <pre className="text-[12.5px] whitespace-pre-wrap break-all bg-[var(--color-bg)] p-3 rounded-md">
              {String((run.output as Record<string, unknown>).content ?? JSON.stringify(run.output, null, 2))}
            </pre>
          ) : (
            <p className="text-[12.5px] text-[var(--color-muted)]">（无输出）</p>
          )}

          <h3 className="text-[13.5px] font-medium mt-5 mb-2">输入</h3>
          <pre className="text-[12px] whitespace-pre-wrap break-all bg-[var(--color-bg)] p-3 rounded-md text-[var(--color-muted)]">
            {JSON.stringify(run.input, null, 2)}
          </pre>
        </section>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- //
function Metric({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="card p-3.5">
      <div className="text-[11px] text-[var(--color-muted)] uppercase tracking-wide">
        {label}
      </div>
      <div className="text-[17px] font-semibold mt-1 mono">{value}</div>
      {sub && <div className="text-[11px] text-[var(--color-muted)] mt-0.5">{sub}</div>}
    </div>
  );
}

/** 单条时间条：位置与宽度按在 Run 内的相对偏移计算 */
function Bar({
  base,
  total,
  start,
  duration,
  ttft,
  label,
  color,
  right,
}: {
  base: number;
  total: number;
  start: number;
  duration: number;
  ttft?: number | null;
  label: string;
  color: string;
  right: string;
}) {
  const leftPct = Math.max(0, Math.min(100, ((start - base) / total) * 100));
  const widthPct = Math.max(0.8, Math.min(100 - leftPct, (duration / total) * 100));
  const ttftPct =
    ttft && duration > 0 ? Math.min(100, (ttft / duration) * 100) : null;

  return (
    <div>
      <div className="flex items-center justify-between text-[11.5px] mb-1">
        <span className="truncate">{label}</span>
        <span className="text-[var(--color-muted)] mono shrink-0 ml-3">{right}</span>
      </div>
      <div className="relative h-5 rounded bg-[var(--color-bg)]">
        <div
          className="absolute h-full rounded flex items-center overflow-hidden"
          style={{ left: `${leftPct}%`, width: `${widthPct}%`, background: color }}
          title={`${label} · ${duration}ms`}
        >
          {ttftPct !== null && (
            <div
              className="h-full bg-[var(--color-overlay)]"
              style={{ width: `${ttftPct}%` }}
              title={`TTFT ${ttft}ms`}
            />
          )}
        </div>
      </div>
    </div>
  );
}
