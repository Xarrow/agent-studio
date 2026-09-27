"use client";

/**
 * 右侧执行过程栏 —— exec 页丰富化第三件（桌面多列的信息列）。
 *
 * 为什么要有：现在「执行过程」藏在每条消息的折叠条里，跑长任务时
 * 用户全程只看到一行「执行中…」+ 时间线被压在气泡里。Claude Code /
 * Cursor 的做法是把过程放**侧栏常驻**：中间聊、右边看它干活。
 *
 * 形态：
 * · xl 起常驻右栏（会话流让宽但信息密度不降 —— 这是「多列」的正解：
 *   不是把对话挤成两列，而是给过程观测一个固定席位）
 * · 跑动中实时刷（分色时间线，SSE 同源数据，零新请求）
 * · 空态不占屏：没选会话/没有过程时收成窄条
 * · 手机/平板不出现（消息内折叠条仍在 —— 同一数据两个视口形态）
 */

import React, { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { RunEvent } from "@/lib/types";
import { RunTimeline, eventsToSteps } from "@/components/ui/run-timeline";

export function ProcessRail({
  liveEvents,
  busy,
  liveInput,
  lastRunId,
}: {
  /** 跑动中的事件（SSE 实时推来的） */
  liveEvents: RunEvent[];
  busy: boolean;
  liveInput: string;
  /** 最后一轮的 run id —— 停下来后拉全量补齐（live 可能截尾） */
  lastRunId: string | null;
}) {
  const [restored, setRestored] = useState<RunEvent[] | null>(null);
  const [lastFor, setLastFor] = useState<string | null>(null);

  // 停下后补拉一次全量事件（对齐消息内折叠条的懒加载口径）
  useEffect(() => {
    if (busy || !lastRunId || lastRunId === lastFor) return;
    let cancelled = false;
    setLastFor(lastRunId);
    void (async () => {
      try {
        const evs = await api.runEvents(lastRunId);
        if (!cancelled) setRestored(evs);
      } catch {
        if (!cancelled) setRestored([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [busy, lastRunId, lastFor]);

  const events = busy ? liveEvents : restored;
  const steps = useMemo(
    () => (events && events.length ? eventsToSteps(events, liveInput) : []),
    [events, liveInput],
  );

  return (
    <aside
      className="hidden xl:flex w-[340px] shrink-0 border-l flex-col min-h-0"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <div
        className="px-3 py-2.5 border-b flex items-center gap-2"
        style={{ borderColor: "var(--color-border)" }}
      >
        <span className="text-[12.5px] font-medium">执行过程</span>
        {busy ? (
          <span className="text-[11px] live-dot" style={{ color: "var(--color-accent)" }}>
            ● 实时
          </span>
        ) : (
          <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>
            {steps.length ? `共 ${steps.length} 步` : ""}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-auto px-2.5 py-2 min-h-0">
        {steps.length ? (
          <RunTimeline steps={steps} compact />
        ) : (
          <div className="text-[12px] px-1 py-6 text-center" style={{ color: "var(--color-muted)" }}>
            {busy ? "等它开始干活…" : "跑一轮，这里实时展示它的思考与工具调用。"}
          </div>
        )}
      </div>
    </aside>
  );
}
