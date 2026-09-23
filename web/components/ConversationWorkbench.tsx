"use client";

/**
 * 对话工作台 —— 把「单 Agent 对话」和「多 Agent 编排」合到一个页面。
 *
 * 为什么合并
 * ---------
 * 这两件事原本是两个页面（/chat 和 /playground），但用户要做的事其实是同一件：
 * **让助手干活**。区别只是"派一个"还是"派一队"。
 *
 * 分成两页的代价很具体：单助手聊到一半发现这事得分工，就得跳到另一个页面
 * 从头再来一遍（重选助手、重述任务），历史还各看各的。
 *
 * 合并后：一个入口，一段说明，两个模式复用同一套执行观测与对话日志。
 *
 * 为什么还留一个"模式选择"（和本项目"对切换保持克制"并不冲突）
 * ----------------------------------------------------------
 * 本项目对"切换"是克制的：能合并就合并，能选择就别让人填。但这里的两件事在
 * **任务语义上真的不同** —— 一个是跟一个助手连续对话，一个是编排多个助手分工。
 * 硬揉成一条流程，两边都会变含糊（"我到底在跟谁说话？"）。
 *
 * 所以保留一个**明示的**两档选择，而不是把差异藏起来。
 *
 * 路径兼容
 * -------
 * /playground 仍然可访问（走 initialMode="orchestration"），老书签不失效；
 * 侧边栏则只保留一个入口，不再让人在两个页面之间选。
 */

import { useState } from "react";
import { ChatConsole } from "@/components/ChatConsole";
import { OrchestrationConsole } from "@/components/OrchestrationConsole";

export type ConsoleMode = "chat" | "orchestration";

const MODES: { key: ConsoleMode; label: string; hint: string }[] = [
  {
    key: "chat",
    label: "单 Agent 对话",
    hint: "像聊天一样跟一个助手连续对话 —— 历史自动保存，下次接着聊。",
  },
  {
    key: "orchestration",
    label: "多 Agent 编排",
    hint: "让几个助手分工干一件事 —— 接力、同时开工，或由一个主控拆任务再汇总。",
  },
];

export function ConversationWorkbench({
  initialMode = "chat",
}: {
  initialMode?: ConsoleMode;
}) {
  const [mode, setMode] = useState<ConsoleMode>(initialMode);
  const current = MODES.find((m) => m.key === mode) ?? MODES[0];

  return (
    <div className="h-full flex flex-col">
      <header className="shrink-0 px-4 md:px-6 pt-4 md:pt-5 pb-3 border-b border-[var(--color-border)]">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-[20px] font-semibold tracking-tight">对话</h1>
            {/* 说明随模式变 —— 让人一眼知道当前这一档在干什么 */}
            <p className="text-[12.5px] text-[var(--color-muted)] mt-0.5">{current.hint}</p>
          </div>

          {/* 两档分段选择器（role=tablist，读屏能识别成一组选项） */}
          <div
            role="tablist"
            aria-label="对话模式"
            className="flex gap-0.5 p-0.5 rounded-lg bg-[var(--color-surface-2)] shrink-0"
          >
            {MODES.map((m) => {
              const active = m.key === mode;
              return (
                <button
                  key={m.key}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setMode(m.key)}
                  className={`px-3 py-1.5 rounded-md text-[12.5px] transition-colors whitespace-nowrap ${
                    active
                      ? "bg-[var(--color-surface)] text-[var(--color-accent)] font-medium shadow-sm"
                      : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
                  }`}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {/* 对话模式自己管滚动（内部是左右分栏）；编排模式整体滚动 */}
      <div
        className={`flex-1 min-h-0 ${
          mode === "orchestration" ? "overflow-auto" : "overflow-hidden"
        }`}
      >
        {mode === "chat" ? <ChatConsole /> : <OrchestrationConsole />}
      </div>
    </div>
  );
}
