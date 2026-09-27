"use client";

/**
 * 运行记录 id 的可点标记 —— 点开是**弹框**，不是跳页。
 *
 * 为什么单独抽这个小组件
 * --------------------
 * 1. 行为一致：全平台"看执行详情"只有一种交互（弹框），不再有的地方跳页、
 *    有的地方弹框。用户在对话/试跑/编排/概览/记忆页点开同一个东西，
 *    体验必须一模一样。
 * 2. 概况页（app/page.tsx）是**服务端组件**，自己没法持有弹框状态 ——
 *    把这个交互下沉到一个客户端小组件，服务端页面照样能用。
 *
 * 详情内容全部由弹框按 id 自己取，所以这里只需要一个 id。
 */

import { useState } from "react";
import { RunDetailById } from "@/components/RunDetailDialog";

export function RunIdLink({
  runId,
  label,
  className,
}: {
  runId: string;
  /** 显示文本，默认取 id 的中间一段（run_ 后面 8 位） */
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="点开看这次执行的完整过程（不离开本页）"
        data-tap
        className={
          className ??
          "mono text-[var(--color-accent)] hover:underline"
        }
      >
        {label ?? runId.slice(4, 12)}
      </button>
      {open && <RunDetailById runId={runId} onClose={() => setOpen(false)} />}
    </>
  );
}
