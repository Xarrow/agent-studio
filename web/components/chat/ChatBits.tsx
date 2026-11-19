"use client";

/**
 * 对话页的小零件：顶栏图标按钮、会话行菜单项。
 * 从 ChatConsole 拆出来 —— 主组件、会话列表两边都用，放这里避免互相 import 成环。
 */

import { useEffect, useRef, useState } from "react";

export function IconBtn({
  label,
  onClick,
  path,
  active,
}: {
  label: string;
  onClick: () => void;
  path: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      data-tap
      data-tip={label}
      aria-label={label}
      onClick={onClick}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-xs)] hover:bg-[var(--bg-selected)]"
      style={{ color: active ? "var(--color-text)" : "var(--color-text-2)" }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={path} />
      </svg>
    </button>
  );
}

export function MenuItem({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center px-2.5 py-1.5 text-left text-[length:var(--fs-sm)] hover:bg-[var(--bg-selected)]"
      style={{ color: danger ? "var(--color-err)" : "var(--color-text)" }}
      data-tap
    >
      {label}
    </button>
  );
}
