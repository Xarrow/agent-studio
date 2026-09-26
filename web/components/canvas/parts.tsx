"use client";

/**
 * 画布上的展示型小件 —— 拖宽/拖角把手、详情分节、区块标题、状态色板。
 *
 * 为什么单独一个文件：它们是**纯展示**（拿 props、画 UI、把事件回调丢回去），
 * 和"怎么编排、怎么算位置"完全无关；混在 3,500 行的画布文件里只会让人不敢动。
 * 行为与原来一模一样（只是搬家）。
 *
 * 两个实测踩出来的细节保留在这里（别丢）：
 *   · 把手命中区 20px、可见把手 4px×44px —— 太细会"抓不住"
 *   · **必须 touch-action: none** —— 触屏上不加它，浏览器把拖拽当滚动并取消 pointer 事件，
 *     表现就是"拖了没反应"
 */

import type React from "react";

import { STEP_STYLE, type StepKind } from "@/components/ui/run-timeline";

export type NodeState = "idle" | "wait" | "run" | "ok" | "err" | "ask" | "stale";

export const STATE_LABEL: Record<NodeState, string> = {
  idle: "待运行",
  wait: "等待",
  run: "运行中",
  ok: "完成",
  err: "失败",
  ask: "需你确认",
  stale: "需重跑",
};

export const META: Record<NodeState, { dot: string; text: string; border: string }> = {
  idle: { dot: "var(--color-border)", text: "var(--color-muted)", border: "var(--color-border)" },
  wait: { dot: "var(--color-border)", text: "var(--color-muted)", border: "var(--color-border)" },
  run: { dot: "var(--color-accent)", text: "var(--color-accent)", border: "var(--color-accent)" },
  // Dify 的状态边框是**纯实线色**（border-state-success-solid / destructive-solid），
  // 不是掺了边框色的淡版 —— 之前掺淡是"看着柔和"，但跟 Dify 不一致，改回纯色。
  ok: { dot: "var(--color-ok)", text: "var(--color-ok)", border: "var(--color-ok)" },
  err: { dot: "var(--color-err)", text: "var(--color-err)", border: "var(--color-err)" },
  ask: { dot: "var(--color-warn)", text: "var(--color-warn)", border: "var(--color-warn)" },
  stale: { dot: "var(--color-muted)", text: "var(--color-muted)", border: "var(--color-border)" },
};

/** 卡片右缘的拖宽把手 —— **节点卡 / 输入卡 / 输出卡共用一套**（行为必须一致）。
 *
 *  两个关键点（都是用户实测踩出来的）：
 *    · 命中区 20px（左右各 10px）+ 可见把手 4px×44px（原来 3px 细线 + 只 7px 在卡内 → 抓不住）
 *    · **touch-action: none** —— 触屏/触控板上不加它，浏览器会把拖拽当滚动并取消 pointer 事件，
 *      表现就是"拖了没反应"（用户反馈："为什么手动拖拽修改不了尺寸"） */
/** 卡片**右下角**的双手柄：宽和高一起调。
 *
 *  与右缘那条分工明确 —— 右缘只改宽（高度默认由内容决定更自然），角落才是"整张卡大小"。
 *  用户要求："卡片的高度也支持调整"。touch-action:none 同样必须有（触屏否则拖不动）。 */
export function ResizeCorner({ id, active, onDown }: { id: string; active: boolean; onDown: (e: React.PointerEvent) => void }) {
  return (
    <div
      data-node-resize-corner={id}
      onPointerDown={onDown}
      onClick={(e) => e.stopPropagation()}
      title="拖动我，调整这张卡的宽和高"
      className="group/corner absolute z-30"
      style={{ right: -8, bottom: -8, width: 24, height: 24, cursor: "nwse-resize", touchAction: "none" }}
    >
      <span
        className="absolute transition-opacity group-hover/corner:opacity-100"
        style={{
          right: 10,
          bottom: 10,
          width: 9,
          height: 9,
          borderRight: `2px solid ${active ? "var(--color-accent)" : "var(--color-muted)"}`,
          borderBottom: `2px solid ${active ? "var(--color-accent)" : "var(--color-muted)"}`,
          borderBottomRightRadius: 3,
          opacity: active ? 1 : 0.55,
        }}
      />
    </div>
  );
}

export function ResizeGrip({ id, active, onDown }: { id: string; active: boolean; onDown: (e: React.PointerEvent) => void }) {
  return (
    <div
      data-node-resize={id}
      onPointerDown={onDown}
      onClick={(e) => e.stopPropagation()}
      title="拖动我，调整这张卡的宽度"
      className="group/resize absolute top-0 z-30 flex h-full cursor-col-resize items-center justify-center"
      style={{ right: -10, width: 20, touchAction: "none" }}
    >
      <span
        className="rounded-full transition-opacity group-hover/resize:opacity-100"
        style={{
          width: 4,
          height: 44,
          opacity: active ? 1 : 0.55,
          background: active
            ? "var(--color-accent)"
            : "color-mix(in srgb, var(--color-border) 55%, var(--color-muted))",
        }}
      />
    </div>
  );
}

export function DetailSection({ kind, label, children }: { kind: StepKind; label: string; children: React.ReactNode }) {
  const st = STEP_STYLE[kind];
  return (
    <div className="rounded-[8px] border" style={{ borderColor: st.border, background: st.bg }}>
      <div className="flex items-center gap-1.5 px-2 py-[3px] text-[11px] font-semibold" style={{ color: st.color }}>
        <span className="text-[10px] leading-none">{st.icon}</span>
        {label}
      </div>
      <div className="px-2 pb-[6px] text-[11.5px] leading-[1.65]" style={{ color: "var(--color-text)" }}>
        {children}
      </div>
    </div>
  );
}

/** 抽屉里的小节标题 */
export function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div
        className="mb-1 text-[12px] font-semibold"
        style={{ color: "var(--color-muted)" }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}
