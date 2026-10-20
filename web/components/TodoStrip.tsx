"use client";

/**
 * 任务清单条 —— 助手自己列的步骤，跨轮还在。
 *
 * 为什么要有这一条
 * ----------------
 * 助手列了五步、做到第二步，你隔一轮再问"继续"，它得记得做到哪了；
 * 你自己也想一眼看出还剩多少。清单存在平台上（按会话），不是某一轮的内存。
 *
 * 口径
 * ----
 * · 没有清单时**整条不出现**（空条是噪声）
 * · 一行说清进度（3/5 · 正在做：跑一遍），点开看每一步
 * · 手机 36px 点击高度；勾/圈用内联 SVG，不用 emoji
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type Todo = { id: string; subject: string; state: string };

const STATE_TEXT: Record<string, string> = {
  completed: "已完成",
  in_progress: "正在做",
  pending: "待办",
};

export default function TodoStrip({
  sessionId,
  busy = false,
  refreshKey = 0,
}: {
  sessionId: string;
  /** 这一轮在跑 —— 期间清单会变，跟着刷 */
  busy?: boolean;
  /** 外部（一轮结束）触发刷新 */
  refreshKey?: number;
}) {
  const [tasks, setTasks] = useState<Todo[]>([]);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.sessionTodos(sessionId);
      setTasks(r.tasks || []);
    } catch {
      setTasks([]);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [busy, load]);

  if (tasks.length === 0) return null;

  const done = tasks.filter((t) => t.state === "completed").length;
  const now = tasks.find((t) => t.state === "in_progress");
  const next = tasks.find((t) => t.state !== "completed" && t.state !== "in_progress");

  return (
    <div className="max-w-3xl mx-auto mt-1.5">
      <button
        type="button"
        data-tap
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1 text-[11.5px] max-md:min-h-[38px]"
        style={{ background: "var(--color-surface-2)", color: "var(--color-muted)" }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 6h11M9 12h11M9 18h11" />
          <path d="M4 6l1.2 1.2L7 5.4" />
          <path d="M4 12l1.2 1.2L7 11.4" />
          <path d="M4 18l1.2 1.2L7 17.4" />
        </svg>
        <span style={{ color: "var(--color-text)" }}>清单 {done}/{tasks.length}</span>
        {now ? (
          <span className="truncate">· 正在做：{now.subject}</span>
        ) : next ? (
          <span className="truncate">· 下一步：{next.subject}</span>
        ) : (
          <span>· 全部做完</span>
        )}
        <span className="ml-auto shrink-0">{open ? "收起" : "看清单"}</span>
      </button>

      {open && (
        <ul className="mt-1 flex flex-col gap-0.5 px-1 text-[12px]">
          {tasks.map((t) => {
            const ok = t.state === "completed";
            const running = t.state === "in_progress";
            return (
              <li key={t.id || t.subject} className="flex items-start gap-1.5 py-0.5">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={ok ? "var(--color-ok)" : running ? "var(--color-accent)" : "var(--color-muted)"}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="mt-[3px] shrink-0"
                  aria-hidden="true"
                >
                  {ok ? (
                    <path d="M20 6L9 17l-5-5" />
                  ) : running ? (
                    <>
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 7v5l3 2" />
                    </>
                  ) : (
                    <circle cx="12" cy="12" r="9" />
                  )}
                </svg>
                <span
                  className={ok ? "line-through" : ""}
                  style={{ color: ok ? "var(--color-muted)" : "var(--color-text)" }}
                >
                  {t.subject}
                </span>
                <span className="ml-auto shrink-0 text-[11px]" style={{ color: "var(--color-muted)" }}>
                  {STATE_TEXT[t.state] || t.state}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
