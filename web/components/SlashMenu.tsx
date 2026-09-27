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

export type CommandItem = {
  id: string;
  label: string;
  /** 一句话说明（显示在右侧，灰字） */
  hint?: string;
  /** 选中后回填到输入框的文本；不回填（纯动作）则为空 */
  fill?: string;
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
      className="absolute bottom-full left-0 right-0 mb-2 rounded-[10px] border overflow-hidden shadow-lg z-20"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
      ref={listRef}
      role="listbox"
    >
      {filtered.map((it, i) => (
        <button
          key={it.id}
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
          <span className="mono text-[12px] shrink-0" style={{ color: "var(--color-accent)" }}>
            {it.fill ?? "→"}
          </span>
          <span className="truncate">{it.label}</span>
          {it.hint && (
            <span className="ml-auto text-[11.5px] truncate shrink-0 max-w-[45%]" style={{ color: "var(--color-muted)" }}>
              {it.hint}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
