"use client";

/**
 * 管理对象的详情抽屉 —— 桌面右侧全高 720、手机全屏。
 *
 * 为什么全站管理页统一用它（而不是就地展开 RowDetail）：
 *   就地展开会把列表顶下去，看到第 4 项和第 9 项时得来回滚；
 *   内存/凭据/远程 Agent 这类对象的内容还都不短，展开后整页会跳。
 *   抽屉在旁边开一块固定高度的地方 —— 列表位置不动，关掉还在原处。
 *
 * 结构（从上到下 = 从"这是谁"到"它写了什么"）：
 *   身份区  [图标] 标题 · 固定标记 / 副标题（来源·状态）      [关闭]
 *   动作条  主操作 + 次级 + 危险（靠右、红）
 *   事实行  一行小图标 + 短词（不靠「·」硬分，不换行）
 *   内容    自己滚，头不动
 */

import { useEffect } from "react";
import { createPortal } from "react-dom";

export type Fact = {
  icon: React.ReactNode;
  text: React.ReactNode;
  title?: string;
  href?: string;
};

export function DetailPanel({
  title,
  subtitle,
  icon,
  iconBg,
  iconFg,
  pinned,
  facts,
  actions,
  onClose,
  children,
  closeTitle = "关闭（Esc）",
}: {
  title: string;
  subtitle?: React.ReactNode;
  icon: React.ReactNode;
  iconBg?: string;
  iconFg?: string;
  pinned?: boolean;
  facts?: Fact[];
  actions?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  closeTitle?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      <div
        className="panel-veil-in fixed inset-0 z-[69]"
        style={{ background: "rgba(15,23,42,.36)", backdropFilter: "blur(1.5px)" }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-label={title}
        aria-modal="true"
        className="panel-slide-in fixed right-0 top-0 z-[70] flex h-[100dvh] w-full flex-col overflow-hidden md:w-[720px] md:rounded-l-[16px] md:shadow-[-24px_0_60px_-24px_rgba(15,23,42,.4)]"
        style={{ background: "var(--color-surface)", borderLeft: "1px solid var(--color-border)" }}
      >
        <div
          className="shrink-0 px-4 pb-3 pt-[max(14px,env(safe-area-inset-top))] md:px-5"
          style={{
            background:
              "linear-gradient(180deg, color-mix(in srgb, var(--color-accent) 5%, transparent), transparent)",
          }}
        >
          <div className="flex items-start gap-3">
            <span
              className="grid h-11 w-11 shrink-0 place-items-center rounded-[12px]"
              style={{
                background: iconBg ?? "color-mix(in srgb, var(--color-accent) 12%, transparent)",
                color: iconFg ?? "var(--color-accent)",
              }}
            >
              {icon}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h2 className="truncate text-[17px] font-semibold tracking-tight">{title}</h2>
                {pinned && (
                  <span
                    className="shrink-0 text-[11px]"
                    style={{ color: "var(--color-accent)" }}
                    title="已固定"
                  >
                    ●
                  </span>
                )}
              </div>
              {subtitle && (
                <div
                  className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]"
                  style={{ color: "var(--color-muted)" }}
                >
                  {subtitle}
                </div>
              )}
            </div>
            <button
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
              title={closeTitle}
              aria-label="关闭"
              onClick={onClose}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          {actions && <div className="mt-3 flex flex-wrap items-center gap-1.5">{actions}</div>}
        </div>

        {facts && facts.length > 0 && (
          <div
            className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-y px-4 py-2 text-[12px] md:px-5"
            style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}
          >
            {facts.map((f, i) =>
              f.href ? (
                <a
                  key={i}
                  href={f.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 hover:underline"
                  style={{ color: "var(--color-accent)" }}
                  title={f.title}
                >
                  {f.icon}
                  <span className="truncate">{f.text}</span>
                </a>
              ) : (
                <span key={i} className="inline-flex items-center gap-1.5 whitespace-nowrap" title={f.title}>
                  {f.icon}
                  {f.text}
                </span>
              ),
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 md:px-5">
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}
