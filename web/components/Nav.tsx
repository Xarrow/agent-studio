"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ThemeToggle } from "./ThemeToggle";

/**
 * 侧边导航 —— 三态响应式
 *
 *  | 视口          | 形态                    |
 *  |--------------|-------------------------|
 *  | < 768px      | 顶部栏 + 抽屉（汉堡）    |
 *  | 768–1023px   | 图标条（w-14，hover 提示）|
 *  | ≥ 1024px     | 完整侧边栏（w-52）       |
 *
 * 为什么用"三态"而不是"折叠成小图标 + 展开"：手机上横竖屏切换频繁，
 * 抽屉能覆盖整个内容区的视觉焦点，而图标条在手机上会吃掉本来就窄的宽度。
 */
const LINKS = [
  { href: "/", label: "概览", icon: "◆" },
  { href: "/chat", label: "对话", icon: "✦" },
  { href: "/agents", label: "Agents", icon: "▲" },
  { href: "/runs", label: "Runs", icon: "▶" },
  { href: "/memories", label: "记忆", icon: "❖" },
  { href: "/tools", label: "工具", icon: "⚙" },
  { href: "/skills", label: "Skills", icon: "◈" },
  { href: "/credentials", label: "LLM 配置", icon: "⚿" },
];

export function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // 路由变化时自动收起抽屉（否则点完链接抽屉还盖着）
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // 抽屉打开时锁住背景滚动
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <>
      {/* ── 移动端顶栏（< 768px） ─────────────────────────────────── */}
      <header className="md:hidden fixed top-0 inset-x-0 z-30 h-14 flex items-center gap-2 px-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <button
          onClick={() => setOpen(true)}
          aria-label="打开菜单"
          aria-expanded={open}
          className="p-2 -ml-1 rounded-md text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <span className="text-[15px] font-semibold tracking-tight">Agent Studio</span>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>

      {/* ── 抽屉遮罩 ─────────────────────────────────────────────── */}
      {open && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/45"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── 抽屉本体（< 768px） ──────────────────────────────────── */}
      <aside
        className={`md:hidden fixed inset-y-0 left-0 z-50 w-64 max-w-[82vw] bg-[var(--color-surface)] border-r border-[var(--color-border)] flex flex-col transition-transform duration-200 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-hidden={!open}
      >
        <div className="px-4 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
          <div>
            <div className="text-[15px] font-semibold tracking-tight">Agent Studio</div>
            <div className="text-[11px] text-[var(--color-muted)] mt-0.5">runtime-agnostic</div>
          </div>
          <button
            onClick={() => setOpen(false)}
            aria-label="关闭菜单"
            className="p-1.5 rounded-md text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <nav className="flex-1 p-2 space-y-0.5 overflow-auto">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`flex items-center gap-3 px-3 py-3 rounded-md text-[14px] transition-colors ${
                isActive(l.href)
                  ? "bg-[var(--color-surface-2)] text-[var(--color-accent)] font-medium"
                  : "text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
              }`}
            >
              <span className="text-[12px] opacity-70 w-4 text-center">{l.icon}</span>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="px-3 py-3 border-t border-[var(--color-border)] text-[10.5px] text-[var(--color-muted)]">
          AgentScope · pi 预留
        </div>
      </aside>

      {/* ── 图标条（768–1023px） ─────────────────────────────────── */}
      <aside className="hidden md:flex lg:hidden w-14 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex-col items-center py-3 gap-1">
        <div className="text-[13px] font-bold mb-2" title="Agent Studio">
          AS
        </div>
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            title={l.label}
            aria-label={l.label}
            className={`w-10 h-10 flex items-center justify-center rounded-md text-[14px] transition-colors ${
              isActive(l.href)
                ? "bg-[var(--color-surface-2)] text-[var(--color-accent)]"
                : "text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
            }`}
          >
            {l.icon}
          </Link>
        ))}
        <div className="mt-auto">
          <ThemeToggle compact />
        </div>
      </aside>

      {/* ── 完整侧边栏（≥ 1024px） ──────────────────────────────── */}
      <aside className="hidden lg:flex w-52 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex-col">
        <div className="px-4 py-5 border-b border-[var(--color-border)]">
          <div className="text-[15px] font-semibold tracking-tight">Agent Studio</div>
          <div className="text-[11px] text-[var(--color-muted)] mt-0.5">runtime-agnostic</div>
        </div>

        <nav className="flex-1 p-2 space-y-0.5">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition-colors ${
                isActive(l.href)
                  ? "bg-[var(--color-surface-2)] text-[var(--color-accent)] font-medium"
                  : "text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
              }`}
            >
              <span className="text-[11px] opacity-70">{l.icon}</span>
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="px-3 py-3 border-t border-[var(--color-border)] space-y-2">
          <ThemeToggle />
          <div className="text-[10.5px] text-[var(--color-muted)] px-1">AgentScope · pi 预留</div>
        </div>
      </aside>
    </>
  );
}
