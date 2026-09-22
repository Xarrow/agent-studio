"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const STORAGE_KEY = "agent-studio-theme";

/** 主题切换：默认浅色，选择持久化到 localStorage */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<Theme>("light");

  // 读回已保存的选择（初始渲染固定渲染 light，避免 hydration 不一致）
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const t: Theme = stored === "dark" ? "dark" : "light";
    setTheme(t);
    document.documentElement.setAttribute("data-theme", t);
  }, []);

  const apply = (t: Theme) => {
    setTheme(t);
    document.documentElement.setAttribute("data-theme", t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* 隐私模式忽略 */
    }
  };

  // 图标条模式：竖排只留图标（放不下文字）
  if (compact) {
    return (
      <div className="flex flex-col gap-0.5 p-0.5 rounded-md bg-[var(--color-surface-2)]">
        {(
          [
            ["light", "☀", "浅色"],
            ["dark", "☾", "深色"],
          ] as [Theme, string, string][]
        ).map(([value, icon, label]) => (
          <button
            key={value}
            onClick={() => apply(value)}
            title={label}
            aria-label={label}
            className={`w-11 h-11 md:w-9 md:h-9 flex items-center justify-center rounded text-[13px] transition-colors ${
              theme === value
                ? "bg-[var(--color-surface)] text-[var(--color-accent)]"
                : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            {icon}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 p-0.5 rounded-md bg-[var(--color-surface-2)]">
      {(
        [
          ["light", "☀", "浅色"],
          ["dark", "☾", "深色"],
        ] as [Theme, string, string][]
      ).map(([value, icon, label]) => (
        <button
          key={value}
          onClick={() => apply(value)}
          title={label}
          aria-label={label}
          className={`flex-1 flex items-center justify-center gap-1 py-2 md:py-1 rounded text-[12px] md:text-[11.5px] transition-colors ${
            theme === value
              ? "bg-[var(--color-surface)] text-[var(--color-accent)] font-medium"
              : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
          }`}
        >
          <span>{icon}</span>
          {label}
        </button>
      ))}
    </div>
  );
}
