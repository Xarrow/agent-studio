"use client";

/**
 * 「快速试跑」—— 配置页里的单轮冒烟测试。
 *
 * 为什么不是把对话页搬进来：配置页要回答的是「我改的这版对不对」，
 * 不是「聊下去」。所以这里**只有一件事**：一句话进去，看它这一轮干了什么。
 *
 * 与对话页（/exec）的分工，刻意做成不重叠：
 *   · 这里：单轮、不留会话、不存历史、一个视图（时间线）
 *   · 对话页：多轮、会话列表、执行过程 + 产物 + 浏览器画面
 * 被删掉的旧实现（RunPanel）在配置页里塞了一整套会话列表 + 三视图切换
 * （对话/事件表/原始 JSON）—— 那是对话页的事，在配置页里既是第二道门
 * （同一件事两个入口）又是一堆 tab（用户明确不要 tab）。
 *
 * 最近几次执行仍然可见（配置时最想确认的就是"刚改完那次跑没跑成"），
 * 但只留一行状态，点进去看详情 = 去对话页看那一轮的完整现场。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { api, fmt } from "@/lib/api";
import { isImeEvent } from "@/lib/ime";
import { HitlPrompt } from "@/components/HitlPrompt";
import { RunTimeline, eventsToSteps, summarize } from "@/components/ui/run-timeline";
import { useFeedback } from "@/components/ui/feedback";
import type { RunEvent } from "@/lib/types";

const STATUS_COLOR: Record<string, string> = {
  ok: "var(--color-ok)",
  success: "var(--color-ok)",
  error: "var(--color-err)",
  failed: "var(--color-err)",
  running: "var(--color-accent)",
  pending: "var(--color-accent)",
  waiting_hitl: "var(--color-warn)",
};

export function AgentQuickRun({
  agentId,
  disabled = false,
  unsaved = false,
  onSave,
}: {
  agentId: string;
  /** 校验没过（比如模型没配）—— 按钮禁掉 */
  disabled?: boolean;
  /** 定义有未保存改动：试跑用的是**已保存**那版，必须说清 */
  unsaved?: boolean;
  onSave?: () => void | Promise<void>;
}) {
  const fb = useFeedback();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [hitl, setHitl] = useState<Record<string, unknown> | null>(null);
  const [recent, setRecent] = useState<
    { id: string; status: string; started_at: number; usage: Record<string, number> }[]
  >([]);
  const esRef = useRef<EventSource | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const loadRecent = useCallback(async () => {
    try {
      setRecent(await api.agentRuns(agentId, 4));
    } catch {
      /* 看不了最近执行不影响试跑 */
    }
  }, [agentId]);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);
  useEffect(() => () => esRef.current?.close(), []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [events]);

  /** 挂事件流直到这一轮结束（waiting_hitl 是暂停，不是结束） */
  const attachStream = (rid: string) => {
    const es = new EventSource(api.streamUrl(rid));
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as RunEvent;
        setEvents((prev) => [...prev, ev]);
        if (ev.type === "hitl_request") setHitl((ev.payload as Record<string, unknown>) ?? {});
      } catch {
        /* 坏帧丢掉，别让整轮崩掉 */
      }
    };
    es.addEventListener("done", async () => {
      es.close();
      const r = await api.run(rid).catch(() => null);
      if (r) {
        setStatus(r.status);
        if (r.status === "waiting_hitl") {
          setHitl((r.pending_hitl as Record<string, unknown>) ?? {});
          return;
        }
      }
      setBusy(false);
      await loadRecent();
    });
    es.onerror = async () => {
      es.close();
      const r = await api.run(rid).catch(() => null);
      if (r) setStatus(r.status);
      setBusy(false);
      await loadRecent();
    };
  };

  const start = async () => {
    if (!input.trim() || busy) return;
    if (unsaved && onSave) {
      await onSave();
    }
    setBusy(true);
    setEvents([]);
    setHitl(null);
    setStatus("pending");
    try {
      const run = await api.createRun({
        agent_id: agentId,
        input: input.trim(),
        origin: "preview",
      });
      setRunId(run.id);
      setStatus(run.status);
      attachStream(run.id);
    } catch (e) {
      fb.error("试跑失败", e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const steps = eventsToSteps(events, input);
  const done = !busy && events.length > 0;

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <textarea
          className="input flex-1 resize-none text-[13px]"
          rows={1}
          style={{ maxHeight: "6rem" }}
          placeholder="给它一句话，看它这一轮怎么干（不存会话）"
          value={input}
          disabled={busy || disabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // 组字中的 Enter 是输入法选字（中文拼音没上屏就回车会把半截拼音发出去）
            if (e.key === "Enter" && !e.shiftKey) {
              if (isImeEvent(e)) return;
              e.preventDefault();
              void start();
            }
          }}
        />
        {busy ? (
          <button
            className="btn shrink-0"
            onClick={() => {
              if (runId) void api.abortRun(runId);
            }}
          >
            停止
          </button>
        ) : (
          <button className="btn btn-primary shrink-0" disabled={!input.trim() || disabled} onClick={() => void start()}>
            试跑
          </button>
        )}
      </div>

      {unsaved && (
        <p className="text-[11.5px]" style={{ color: "var(--color-warn)" }}>
          有未保存改动 —— 试跑前会先保存，跑的就是你现在看到的这版
        </p>
      )}

      {hitl && (
        <HitlPrompt
          runId={runId ?? ""}
          payload={hitl}
          onBeforeResume={() => {
            if (runId) attachStream(runId);
          }}
          onResumed={() => setBusy(true)}
          onError={(m) => fb.error("恢复失败", m)}
        />
      )}

      {(busy || events.length > 0) && (
        <div
          className="rounded-lg border p-2.5"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
        >
          <div className="flex items-center gap-2 mb-2 text-[11.5px]">
            <span className={busy ? "live-dot" : ""} style={{ color: busy ? "var(--color-accent)" : STATUS_COLOR[status] ?? "var(--color-muted)" }}>
              {busy ? "● 跑着呢" : `● ${status || "结束"}`}
            </span>
            {done && steps.length > 0 && (
              <span className="text-[var(--color-muted)]">{summarize(steps)}</span>
            )}
          </div>
          {steps.length > 0 ? (
            <RunTimeline steps={steps} compact />
          ) : (
            <div className="text-[12px] text-[var(--color-muted)]">已提交，等它开始…</div>
          )}
          <div ref={endRef} />
        </div>
      )}

      {recent.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11.5px] text-[var(--color-muted)]">最近跑过</span>
            <Link
              href={`/exec?agent=${agentId}`}
              className="text-[11.5px] hover:underline"
              style={{ color: "var(--color-accent)" }}
            >
              打开对话（多轮 · 完整现场）→
            </Link>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {recent.map((r) => (
              <Link
                key={r.id}
                href={`/exec?agent=${agentId}`}
                title="去对话页看那一轮的完整执行现场"
                className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] hover:bg-[var(--color-surface-2)]"
                style={{ borderColor: "var(--color-border)" }}
              >
                <span style={{ color: STATUS_COLOR[r.status] ?? "var(--color-muted)" }}>●</span>
                {fmt.relative(r.started_at)}
                {r.usage?.total_tokens ? (
                  <span className="text-[var(--color-muted)]">{r.usage.total_tokens} tok</span>
                ) : null}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
