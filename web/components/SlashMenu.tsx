"use client";

/**
 * `/` 命令菜单 —— 输入区通用快捷键（exec 页丰富化第二件）。
 *
 * 为什么要有：专业 Agent 对话产品的标配（Claude Code / Slack / Notion 全有）。
 * 用户在输入框敲 `/` 立即弹出命令面板：切助手、开始新对话、看历史、
 * 清屏……**让用户选择而不是输入**（能枚举的一律给列表）。
 *
 * 交互契约：
 * · `/` 开头时弹出，输入继续过滤
 * · ↑↓ 移动高亮，Enter 选中，Esc 关闭
 * · 触屏：直接点菜单项（菜单不是 hover 才出现）
 * · 选择器复用现有回调，不引入新路由/新状态源
 */

import React, { useEffect, useRef, useState } from "react";
import { isImeEvent } from "@/lib/ime";

export type CommandItem = {
  id: string;
  label: string;
  /** 一句话说明（显示在右侧，灰字） */
  hint?: string;
  /** 选中后回填到输入框的文本；不回填（纯动作）则为空 */
  fill?: string;
  /** 分组标题（同一 group 的条目上只出现一次，给几十条的长列表做眼） */
  group?: string;
  /** 右侧勾选态（技能/工具：已挂 true） */
  on?: boolean;
  run: () => void;
};

export function SlashMenu({
  query,
  items,
  onPick,
  onClose,
}: {
  /** 输入框里 `/` 之后的部分（用于过滤） */
  query: string;
  items: CommandItem[];
  /** 用户敲了 Enter 或点了某项 */
  onPick: (item: CommandItem) => void;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const filtered = items.filter(
    (it) =>
      !query ||
      it.label.toLowerCase().includes(query.toLowerCase()) ||
      (it.hint ?? "").toLowerCase().includes(query.toLowerCase()),
  );

  useEffect(() => {
    setIdx(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.children[idx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  /* 键盘导航挂在这里（open 时才挂）—— 输入框只负责透传 Esc，别的都不用管 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIdx((v) => Math.min(v + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setIdx((v) => Math.max(v - 1, 0));
      } else if (e.key === "Enter") {
        // 组字中的 Enter 属于输入法（选字），别拿来选命令
        if (isImeEvent(e)) return;
        e.preventDefault();
        const it = filtered[idx];
        if (it) {
          onPick(it);
          onClose();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [filtered, idx, onPick, onClose]);

  if (filtered.length === 0) return null;

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-2 rounded-[10px] border overflow-y-auto overscroll-contain shadow-lg z-20"

      style={{
        background: "var(--color-surface)",
        borderColor: "var(--color-border)",
        // 条目可能几十条（技能 + 工具 + 记忆 + 助手）：必须封高并自己滚，
        // 否则整块从输入框往上顶出屏幕（实测 2642px 高、top −1932）
        maxHeight: "46vh",
      }}
      ref={listRef}
      role="listbox"
    >
      {filtered.map((it, i) => (
        <div key={it.id}>
        {it.group && it.group !== filtered[i - 1]?.group && (
          <div className="px-3 pt-2 pb-1 text-[10.5px] font-medium" style={{ color: "var(--color-muted)" }}>
            {it.group}
          </div>
        )}
        <button
          type="button"
          role="option"
          aria-selected={i === idx}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-[13px]"
          style={{
            background: i === idx ? "var(--color-surface-2)" : "transparent",
            minHeight: 44,
          }}
          onMouseEnter={() => setIdx(i)}
          onClick={() => {
            onPick(it);
            onClose();
          }}
        >
          {/* 勾选态：技能/工具已挂显示 ✓（选中即取消），其余是动作箭头 */}
          <span
            className="mono text-[12px] shrink-0 w-[14px] text-center"
            style={{ color: it.on ? "var(--color-accent)" : "var(--color-muted)" }}
            aria-hidden="true"
          >
            {it.on ? "✓" : it.fill ? it.fill : "→"}
          </span>
          <span className="truncate">{it.label}</span>
          {it.hint && (
            <span className="ml-auto text-[12px] truncate shrink-0 max-w-[45%]" style={{ color: "var(--color-muted)" }}>
              {it.hint}
            </span>
          )}
        </button>
        </div>
      ))}
    </div>
  );
}
