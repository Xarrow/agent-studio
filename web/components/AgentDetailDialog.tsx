"use client";

/**
 * 「配置助手」的整屏浮层 —— 从对话页直接打开，不离开对话。
 *
 * 为什么是整屏浮层而不是小弹框
 * --------------------------
 * 助手配置本身内容很多（定义 / 工具 / Skills / 试跑与观测 / 记忆），塞进小弹框
 * 会立刻需要内部滚动 + 内部 tab，又变成"框里的切来切去"。整屏浮层既保留了
 * 完整的配置空间，又**没有真的离开当前页面** —— 关掉就回到刚才的对话，
 * 输入框、滚动位置、正在看的结果都还在。
 *
 * 复用 components/AgentDetail.tsx（和独立页面 /agents/<id> 是同一份实现）。
 */

import { useEffect } from "react";
import { AgentDetail } from "@/components/AgentDetail";

export function AgentDetailDialog({
  agentId,
  onClose,
}: {
  agentId: string;
  onClose: () => void;
}) {
  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-[var(--color-bg)] overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 md:px-6 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <span className="text-[12.5px] text-[var(--color-muted)]">
          配置助手 —— 关掉就回到刚才的对话，聊天记录不会丢
        </span>
        <button className="btn btn-sm shrink-0" onClick={onClose}>
          关闭
        </button>
      </div>
      <AgentDetail agentId={agentId} inDialog />
    </div>
  );
}
