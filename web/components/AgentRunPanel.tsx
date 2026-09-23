"use client";

/**
 * 执行观测面板（Agent 详情页「试跑与观测」Tab）
 *
 * 设计要点：
 * - **三视图**：对话（给人看）/ 事件表（给开发者看）/ 原始 JSON（协议层）
 * - **连续 text_delta 必须聚合**：每个 token 渲染成独立节点会让中文变成
 *   "一字一行"的竖排假象（这是执行观测最容易被误解的地方）
 * - **多轮会话栏**：会话选择 / 新建 / 第 N 轮 / 清空上下文
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmt, STATUS_STYLE } from "@/lib/api";
import type { RunEvent, Session } from "@/lib/types";
import { useFeedback } from "./ui/feedback";
import { Hint, HINTS } from "@/components/ui/hint";
import { RunDetailById } from "@/components/RunDetailDialog";

/** 事件类型 → 展示样式（12 类统一事件） */
const EVENT_KIND: Record<string, { label: string; color: string; icon: string }> = {
  run_start: { label: "开始", color: "var(--color-muted)", icon: "▶" },
  thinking_delta: { label: "思考", color: "var(--color-muted)", icon: "…" },
  text_delta: { label: "输出", color: "var(--color-text)", icon: "✎" },
  llm_usage: { label: "用量", color: "var(--color-muted)", icon: "∑" },
  tool_call_start: { label: "调用工具", color: "var(--color-info)", icon: "⚙" },
  tool_call_args: { label: "工具参数", color: "var(--color-info)", icon: "⚙" },
  tool_exec_start: { label: "执行中", color: "var(--color-info)", icon: "⚙" },
  tool_result_delta: { label: "工具输出", color: "var(--color-info)", icon: "⚙" },
  tool_exec_end: { label: "执行完成", color: "var(--color-info)", icon: "✓" },
  hitl_request: { label: "等待确认", color: "var(--color-warn)", icon: "?" },
  error: { label: "错误", color: "var(--color-err)", icon: "!" },
  run_end: { label: "结束", color: "var(--color-ok)", icon: "■" },
};

/** 事件摘要（截断交给 CSS，完整文本放 title 供悬停查看） */
function summarize(ev: RunEvent): string {
  const p = ev.payload as Record<string, unknown>;
  if (typeof p.text === "string") return p.text;
  if (typeof p.delta === "string") return p.delta;
  if (typeof p.tool_call_name === "string") return String(p.tool_call_name);
  if (typeof p.name === "string") return String(p.name);
  if (typeof p.message === "string") return p.message;
  if (typeof p.error === "string") return p.error;
  if (p.args) return JSON.stringify(p.args);
  const keys = Object.keys(p);
  return keys.length ? JSON.stringify(p).slice(0, 200) : "—";
}

type RenderItem =
  | { kind: "text"; text: string; ts: number }
  | { kind: "thinking"; text: string; ts: number }
  | { kind: "tool"; name: string; args: string; result: string; ts: number; done: boolean }
  | { kind: "notice"; label: string; text: string; color: string; ts: number };

/** 把事件流聚合成人能读的段落 */
export function groupEvents(events: RunEvent[]): RenderItem[] {
  const out: RenderItem[] = [];
  for (const ev of events) {
    const p = ev.payload as Record<string, unknown>;
    const text =
      typeof p.text === "string" ? p.text : typeof p.delta === "string" ? p.delta : "";

    switch (ev.type) {
      case "text_delta": {
        const last = out[out.length - 1];
        if (last?.kind === "text") last.text += text;
        else out.push({ kind: "text", text, ts: ev.ts });
        break;
      }
      case "thinking_delta": {
        const last = out[out.length - 1];
        if (last?.kind === "thinking") last.text += text;
        else out.push({ kind: "thinking", text, ts: ev.ts });
        break;
      }
      case "tool_call_start":
      case "tool_call_args": {
        const name = String(p.tool_call_name ?? p.name ?? "tool");
        const args = typeof p.delta === "string" ? p.delta : p.args ? JSON.stringify(p.args) : "";
        const last = out[out.length - 1];
        if (last?.kind === "tool" && !last.done && last.name === name) last.args += args;
        else out.push({ kind: "tool", name, args, result: "", ts: ev.ts, done: false });
        break;
      }
      case "tool_result_delta":
      case "tool_exec_end": {
        const last = [...out].reverse().find((x) => x.kind === "tool" && !x.done);
        if (last?.kind === "tool") {
          if (text) last.result += text;
          if (ev.type === "tool_exec_end") last.done = true;
        }
        break;
      }
      case "hitl_request":
        out.push({
          kind: "notice",
          label: "等待人工确认",
          text: JSON.stringify(p).slice(0, 300),
          color: "var(--color-warn)",
          ts: ev.ts,
        });
        break;
      case "error":
        out.push({
          kind: "notice",
          label: "错误",
          text: String(p.message ?? p.error ?? JSON.stringify(p)).slice(0, 500),
          color: "var(--color-err)",
          ts: ev.ts,
        });
        break;
      case "run_start":
        out.push({
          kind: "notice",
          label: "开始执行",
          text: "",
          color: "var(--color-muted)",
          ts: ev.ts,
        });
        break;
      case "run_end":
        out.push({
          kind: "notice",
          label: "执行结束",
          text: "",
          color: "var(--color-ok)",
          ts: ev.ts,
        });
        break;
      default:
        break;
    }
  }
  return out;
}

export function RunPanel({
  agentId,
  agentName,
  disabled,
}: {
  agentId: string;
  agentName: string;
  disabled: boolean;
}) {
  const fb = useFeedback();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  // 最近执行的详情用弹框看 —— 试跑时正在看的对话和事件流不该被跳页冲掉
  const [detailRun, setDetailRun] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [view, setView] = useState<"chat" | "table" | "raw">("chat");
  const [autoScroll, setAutoScroll] = useState(true);
  const [recent, setRecent] = useState<
    { id: string; status: string; started_at: number; usage: Record<string, number> }[]
  >([]);
  // 多轮会话：选中的会话 + 该会话已有的轮次（用于显示"第 N 轮"）
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
  const [turnIndex, setTurnIndex] = useState<number>(0);
  const esRef = useRef<EventSource | null>(null);
  const streamEndRef = useRef<HTMLDivElement | null>(null);

  const currentSession = sessions.find((x) => x.id === sessionId);

  const loadRecent = useCallback(async () => {
    try {
      setRecent(await api.agentRuns(agentId, 8));
    } catch {
      /* ignore */
    }
  }, [agentId]);

  const loadSessions = useCallback(async () => {
    try {
      const list = await api.sessions(agentId);
      setSessions(list);
      return list;
    } catch {
      return [];
    }
  }, [agentId]);

  useEffect(() => {
    void loadRecent();
    void loadSessions();
  }, [loadRecent, loadSessions]);

  // 切换会话时同步轮次
  useEffect(() => {
    const s = sessions.find((x) => x.id === sessionId);
    setTurnIndex(s ? s.turn_count : 0);
  }, [sessionId, sessions]);

  /** 新建会话（多轮对话的第一轮） */
  const newSession = async () => {
    try {
      const s = await api.createSession(agentId);
      await loadSessions();
      setSessionId(s.id);
      setEvents([]);
      setRunId(null);
      setStatus("");
      fb.success("已新建会话", "接下来的执行会带上上下文");
    } catch (e) {
      fb.error("新建会话失败", e instanceof Error ? e.message : String(e));
    }
  };

  /** 清空当前会话的上下文（保留会话本身） */
  const clearContext = async () => {
    if (!sessionId) return;
    const ok = await fb.confirm({
      title: "清空当前会话的上下文？",
      description: "保留会话本身，但丢弃此前的对话历史。下一次执行将不再带上这些内容。",
      details: [
        `会话：${currentSession?.title || sessionId}`,
        `将丢弃 ${currentSession?.message_count ?? 0} 条消息记录`,
      ],
      danger: true,
      confirmText: "清空上下文",
    });
    if (!ok) return;
    try {
      const r = await api.clearSessionContext(sessionId);
      setEvents([]);
      setRunId(null);
      fb.success(`已清空 ${r.removed_messages} 条消息`);
      await loadSessions();
    } catch (e) {
      fb.error("清空失败", e instanceof Error ? e.message : String(e));
    }
  };

  // 自动滚动可关闭 —— 长输出时用户需要停下来细看
  useEffect(() => {
    if (!autoScroll) return;
    streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events, autoScroll]);

  useEffect(() => () => esRef.current?.close(), []);

  const start = async () => {
    if (!input.trim()) return;
    setBusy(true);
    setEvents([]);
    setStatus("pending");
    try {
      const run = await api.createRun({
        agent_id: agentId,
        input: input.trim(),
        // 传了 session_id 就是多轮：后端会带上历史 + 召回记忆
        session_id: sessionId || undefined,
        // 这里是「配置时试跑」，在「运行记录」里归为"助手试跑"
        origin: "preview",
      });
      setRunId(run.id);
      setStatus(run.status);
      if (run.turn_index) setTurnIndex(run.turn_index);

      const es = new EventSource(api.streamUrl(run.id));
      esRef.current = es;
      es.onmessage = (e) => {
        try {
          setEvents((prev) => [...prev, JSON.parse(e.data) as RunEvent]);
        } catch {
          /* ignore malformed */
        }
      };
      es.addEventListener("done", async () => {
        es.close();
        const r = await api.run(run.id);
        setStatus(r.status);
        setBusy(false);
        await Promise.all([loadRecent(), loadSessions()]);
      });
      es.onerror = async () => {
        es.close();
        const r = await api.run(run.id).catch(() => null);
        if (r) setStatus(r.status);
        setBusy(false);
        await Promise.all([loadRecent(), loadSessions()]);
      };
    } catch (e) {
      fb.error("执行失败", e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const abort = async () => {
    if (runId) await api.abortRun(runId);
  };

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(events, null, 2));
      fb.success(`已复制 ${events.length} 个事件`);
    } catch (e) {
      fb.error("复制失败", e instanceof Error ? e.message : String(e));
    }
  };

  const grouped = useMemo(() => groupEvents(events), [events]);

  return (
    <div className="grid gap-4 grid-cols-1 xl:grid-cols-[1fr_320px]">
      <section className="card p-4 flex flex-col min-h-[420px]">
        {/* 会话栏 —— 多轮对话的入口 */}
        <div className="flex items-center gap-2 mb-3 flex-wrap pb-3 border-b border-[var(--color-border)]">
          <span className="text-[11.5px] text-[var(--color-muted)] whitespace-nowrap">会话</span>
          <select
            className="input flex-1 min-w-[140px] sm:flex-none sm:w-56"
            value={sessionId}
            onChange={(e) => {
              setSessionId(e.target.value);
              setEvents([]);
              setRunId(null);
            }}
          >
            <option value="">单轮模式（不带上下文）</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {(s.title || s.id).slice(0, 32)} · {s.turn_count} 轮
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => void newSession()} disabled={busy}>
            + 新建会话
          </button>

          {sessionId ? (
            <>
              <span
                className="tag"
                style={{
                  color: "var(--color-accent)",
                  background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
                }}
              >
                第 {turnIndex + 1} 轮
              </span>
              <span className="text-[11px] text-[var(--color-muted)] hidden sm:inline">
                共 {currentSession?.message_count ?? 0} 条历史
                {(currentSession?.summarized_upto ?? 0) > 0 &&
                  ` · 已压缩至第 ${currentSession?.summarized_upto} 轮`}
              </span>
              <button className="btn" onClick={() => void clearContext()} disabled={busy}>
                清空上下文
              </button>
            </>
          ) : (
            <span className="text-[11px] text-[var(--color-muted)]">
              每次执行相互独立；新建会话即可让 Agent 记住前几轮
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <h2 className="text-[14px] font-medium">执行观测</h2>
          {status && (
            <span className={`tag ${busy ? "live-dot" : ""}`}>{busy ? "运行中" : status}</span>
          )}
          {events.length > 0 && (
            <span className="text-[11px] text-[var(--color-muted)] flex items-center gap-1">
              <Hint text="它这一步一步都干了什么。数字越大说明它想得越多。">
                {events.length} 个事件
              </Hint>
            </span>
          )}

          {/* 三视图：给人看 / 给开发者看 / 原始数据 */}
          <div className="flex gap-0.5 p-0.5 rounded-md bg-[var(--color-surface-2)]">
            {(
              [
                ["chat", "对话"],
                ["table", "事件表"],
                ["raw", "原始 JSON"],
              ] as ["chat" | "table" | "raw", string][]
            ).map(([k, label]) => (
              <button
                key={k}
                title={
                  k === "chat"
                    ? "用人话看：它到底说了什么、调了什么工具"
                    : k === "table"
                      ? "逐步列表：每一步的类型、耗时、摘要（排查问题用）"
                      : "协议层原始数据：每个事件的完整内容（对接调试用）"
                }
                onClick={() => setView(k)}
                className={`px-2.5 py-1 rounded text-[11.5px] whitespace-nowrap transition-colors ${
                  view === k
                    ? "bg-[var(--color-surface)] text-[var(--color-accent)] font-medium"
                    : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11.5px] text-[var(--color-muted)] cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              自动滚动
            </label>
            {events.length > 0 && (
              <button className="btn text-[11.5px]" onClick={() => void copyAll()}>
                复制
              </button>
            )}
          </div>
        </div>

        {/* 视图区 */}
        <div className="flex-1 overflow-auto rounded-md bg-[var(--color-surface-2)] p-3 min-h-[240px]">
          {events.length === 0 ? (
            <p className="text-[12.5px] text-[var(--color-muted)]">
              还没有执行。输入消息后点「执行」——
              {sessionId ? "当前会话会带上上下文" : "当前是单轮模式"}。
            </p>
          ) : view === "chat" ? (
            <div className="space-y-3">
              {grouped.map((item, i) => (
                <ChatBlock key={i} item={item} />
              ))}
            </div>
          ) : view === "table" ? (
            <EventTable events={events} />
          ) : (
            <pre className="whitespace-pre-wrap break-all text-[10.5px] mono">
              {JSON.stringify(events, null, 2)}
            </pre>
          )}
          <div ref={streamEndRef} />
        </div>

        {/* 输入区 */}
        <div className="mt-3 flex gap-2 items-end">
          <textarea
            className="input mono text-[12.5px] flex-1"
            rows={2}
            placeholder={`给「${agentName}」发消息…（Ctrl/⌘ + Enter 发送）`}
            value={input}
            disabled={busy || disabled}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void start();
            }}
          />
          {busy ? (
            <button className="btn text-[var(--color-warn)]" onClick={() => void abort()}>
              中断
            </button>
          ) : (
            <button
              className="btn btn-primary"
              disabled={disabled || !input.trim()}
              onClick={() => void start()}
            >
              执行
            </button>
          )}
        </div>
        {disabled && (
          <p className="text-[11.5px] text-[var(--color-err)] mt-2">
            定义有错误，请先在「定义」页修正后再试跑。
          </p>
        )}
      </section>

      {/* 右侧：最近执行 */}
      <aside className="card p-4">
        <h2 className="text-[14px] font-medium mb-3">最近执行</h2>
        {recent.length === 0 ? (
          <p className="text-[12px] text-[var(--color-muted)]">暂无记录</p>
        ) : (
          <div className="space-y-1">
            {recent.map((r) => (
              <button
                key={r.id}
                onClick={() => setDetailRun(r.id)}
                className="block w-full text-left p-2 rounded-md hover:bg-[var(--color-surface-2)] transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className={`text-[11px] ${STATUS_STYLE[r.status] ?? ""}`}>●</span>
                  <span className="text-[11.5px] mono truncate flex-1">{r.id.slice(0, 18)}…</span>
                </div>
                <div className="text-[10.5px] text-[var(--color-muted)] mt-0.5">
                  {fmt.relative(r.started_at)}
                  {r.usage?.total_tokens ? ` · ${r.usage.total_tokens} tokens` : ""}
                </div>
              </button>
            ))}
          </div>
        )}
        {detailRun && <RunDetailById runId={detailRun} onClose={() => setDetailRun(null)} />}
      </aside>
    </div>
  );
}

/** 对话视图的一个段落 */
function ChatBlock({ item }: { item: RenderItem }) {
  if (item.kind === "text") {
    return (
      <div className="text-[13px] leading-relaxed whitespace-pre-wrap break-words">{item.text}</div>
    );
  }
  if (item.kind === "thinking") {
    return (
      <div className="text-[12px] text-[var(--color-muted)] italic whitespace-pre-wrap break-words pl-3 border-l-2 border-[var(--color-border)]">
        {item.text}
      </div>
    );
  }
  if (item.kind === "tool") {
    return (
      <div
        className="rounded-md p-2.5"
        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
      >
        <div className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--color-info)" }}>
          <span>⚙</span>
          <span className="font-medium">{item.name}</span>
          {!item.done && <span className="live-dot">执行中…</span>}
        </div>
        {item.args && (
          <pre className="mt-1.5 text-[10.5px] mono whitespace-pre-wrap break-all text-[var(--color-muted)]">
            {item.args}
          </pre>
        )}
        {item.result && (
          <pre className="mt-1.5 text-[10.5px] mono whitespace-pre-wrap break-all max-h-40 overflow-auto">
            {item.result}
          </pre>
        )}
      </div>
    );
  }
  return (
    <div className="text-[11.5px] flex items-center gap-2 flex-wrap" style={{ color: item.color }}>
      <span>—</span>
      <span>{item.label}</span>
      {item.text && (
        <span className="text-[var(--color-muted)] truncate max-w-full">{item.text}</span>
      )}
    </div>
  );
}

/** 事件表（开发者视图）：点行展开原始 payload */
function EventTable({ events }: { events: RunEvent[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const t0 = events[0]?.ts ?? 0;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11.5px] min-w-[520px]">
        <thead className="text-[var(--color-muted)]">
          <tr>
            <th className="text-left py-1.5 pr-3 w-12">seq</th>
            <th className="text-left py-1.5 pr-3 w-28">类型</th>
            <th className="text-left py-1.5 pr-3 w-20">+ms</th>
            <th className="text-left py-1.5">摘要</th>
          </tr>
        </thead>
        <tbody>
          {events.map((ev) => {
            const meta = EVENT_KIND[ev.type] ?? {
              label: ev.type,
              color: "var(--color-muted)",
              icon: "·",
            };
            const isOpen = open === ev.seq;
            return [
              <tr
                key={ev.seq}
                onClick={() => setOpen(isOpen ? null : ev.seq)}
                className="border-t border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-surface)]"
              >
                <td className="py-1.5 pr-3 mono text-[var(--color-muted)]">{ev.seq}</td>
                <td className="py-1.5 pr-3 whitespace-nowrap" style={{ color: meta.color }}>
                  {meta.icon} {meta.label}
                </td>
                <td className="py-1.5 pr-3 mono text-[var(--color-muted)]">{ev.ts - t0}</td>
                <td className="py-1.5">
                  <div className="truncate max-w-[38rem]" title={summarize(ev)}>
                    {summarize(ev)}
                  </div>
                </td>
              </tr>,
              isOpen ? (
                <tr key={`${ev.seq}-p`} className="bg-[var(--color-surface)]">
                  <td colSpan={4} className="p-2">
                    <pre className="whitespace-pre-wrap break-all text-[10.5px] max-h-64 overflow-auto">
                      {JSON.stringify(ev.payload, null, 2)}
                    </pre>
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
