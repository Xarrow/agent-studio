"use client";

/**
 * 「管理」页 —— **只有运行记录**（点一行就地展开，看它怎么跑的）。
 *
 * 2026-09-28 按用户口径改了结构：
 *   · 移除「编排」：流程管理（左边一份份流程 / 右边它的历史执行）从这里撤掉。
 *     画布已退役、新任务都在「Agent 执行」里发起，管理页再摆一份流程列表
 *     只会让人以为"还得先编排才能干活"。**数据没删**——旧编排的执行记录
 *     仍在这张表里（「全部」里看得到），只是不再作为一等工作流呈现。
 *   · 「对话」筛选改名「Agent」：这些记录本来就是"某个 Agent 被跑了一次"，
 *     叫对话会把"带文件的、多轮的、试跑的"都排除在直觉之外。
 */

import { PageHead } from "@/components/ui/kit";
import { RunsPanel } from "@/components/RunsPanel";

export default function ManagePage() {
  return (
    <div className="p-4 md:p-6 lg:p-7">
      <PageHead
        title="管理"
        desc="全部运行记录：每次执行（LLM 测试 / 助手试跑 / Agent 执行）点一行就地展开，看它怎么想、调了什么、耗时花在哪。"
      />
      <RunsPanel />
    </div>
  );
}
