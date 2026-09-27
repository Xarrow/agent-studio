"use client";

/**
 * 「Agent 执行」—— 对话式干活入口（对齐 Claude Code 的产品范式）。
 *
 * 结构：顶栏（agent 选择器 + 历史会话） / 会话流（Turn + loop 事件行） / 底部输入区。
 * P0 骨架：本页占位 + 结构样式，P1 接 SSE。
 */

export default function ExecPage() {
  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
        <span className="text-[14.5px] font-semibold">Agent 执行</span>
        <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
          选一个助手，把任务说给它听 —— 它每一步怎么想、调了什么工具、结果是什么，全程看得见
        </span>
      </div>
      {/* 会话流（P1 接入） */}
      <div className="flex-1 overflow-auto p-4">
        <div className="mx-auto max-w-[760px]" style={{ color: "var(--color-muted)" }}>
          会话流建设中（P1）
        </div>
      </div>
      {/* 输入区（P1 接入） */}
      <div className="border-t p-3" style={{ borderColor: "var(--color-border)" }}>
        <div className="mx-auto max-w-[760px] text-[13px]" style={{ color: "var(--color-muted)" }}>
          输入区建设中（P1）
        </div>
      </div>
    </div>
  );
}
