"use client";

/**
 * 侧边导航 —— 三态 + 分组。
 *
 * 布局（响应式）
 * -------------
 *  | < 768px      | 顶部栏 + 抽屉（汉堡菜单）      |
 *  | 768–1023px   | 图标条（w-14，hover 提示）     |
 *  | ≥ 1024px     | 完整侧边栏（w-52）             |
 *
 * 分组（"小孩子也能学会"）
 * ----------------------
 * 8 个菜单平铺会让人先理解"系统有哪些模块"；分成两组后，用户只需回答
 * 一个问题：**我是想用它，还是想改它？**
 *
 *   使用 → 对话 / Runs
 *   配置 → Agents / 记忆 / 工具 / Skills / LLM 配置
 *
 * 术语保留（它们是准确的说法），但每个都挂 title 提示（鼠标悬停出白话）。
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type Item = { href: string; label: string; icon: string; tip: string };

/** 使用 —— 日常干活的入口 */
const USE_ITEMS: Item[] = [
  {
    href: "/chat",
    label: "对话",
    icon: "✦",
    tip: "像聊天一样让 AI 帮你做事。历史记录会一直留着。",
  },
  {
    href: "/runs",
    label: "Runs",
    icon: "▶",
    tip: "每次执行的详细记录（Runs）：它想了什么、调了什么工具、花了多久。想排查问题时看这里。",
  },
];

/** 配置 —— 一次性设置的地方 */
const SETUP_ITEMS: Item[] = [
  {
    href: "/agents",
    label: "Agents",
    icon: "▲",
    tip: "「助手」：一个会自己想办法帮你做事的 AI。你可以给不同的助手不同的分工。",
  },
  {
    href: "/memories",
    label: "记忆",
    icon: "❖",
    tip: "跨对话的长期记性：值得记住的事存下来，以后聊天会自动想起来。",
  },
  {
    href: "/tools",
    label: "工具",
    icon: "⚙",
    tip: "给助手加「手」：能查网页、读文件、跑命令之类。不加就只能聊天。",
  },
  {
    href: "/skills",
    label: "Skills",
    icon: "◈",
    tip: "预先写好的「做事套路」。装上之后，助手遇到这类任务就知道该按什么步骤做。",
  },
  {
    href: "/credentials",
    label: "LLM 配置",
    icon: "⚿",
    tip: "让 AI 能工作的「钥匙」（模型服务商的密钥）。加密保存，不会明文显示。",
  },
];

export function Nav() {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // 路由变化就收起抽屉
  useEffect(() => setDrawerOpen(false), [pathname]);

  // 抽屉打开时锁背景滚动
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [drawerOpen]);

  // Esc 收起抽屉
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawerOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  const rowCls = (active: boolean) =>
    `flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition-colors ${
      active
        ? "bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-[var(--color-accent)] font-medium"
        : "text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
    }`;

  const groupLabel = (t: string) => (
    <div className="px-3 pt-3 pb-1 text-[10.5px] font-semibold tracking-wider text-[var(--color-muted)] uppercase">
      {t}
    </div>
  );

  return (
    <>
      {/* ── 移动端顶栏 ─────────────────────────────────────── */}
      <header className="md:hidden fixed top-0 inset-x-0 z-40 h-14 flex items-center gap-3 px-4 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="打开菜单"
          className="w-11 h-11 -ml-2 flex items-center justify-center rounded-md hover:bg-[var(--color-surface-2)] active:bg-[var(--color-surface-2)]"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path
              d="M2 4.5h14M2 9h14M2 13.5h14"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        </button>
        <span className="font-semibold text-[15px] tracking-tight">Agent Studio</span>
      </header>

      {/* ── 移动端抽屉 ─────────────────────────────────────── */}
      {drawerOpen && (
        <>
          <div
            className="md:hidden fixed inset-0 z-40 bg-black/45"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <aside className="md:hidden fixed inset-y-0 left-0 z-50 w-[17rem] max-w-[82vw] bg-[var(--color-surface)] border-r border-[var(--color-border)] flex flex-col overflow-auto">
            <div className="px-4 py-4 border-b border-[var(--color-border)] flex items-center">
              <Link href="/" className="font-semibold text-[15px] tracking-tight">
                Agent Studio
              </Link>
              <button
                onClick={() => setDrawerOpen(false)}
                aria-label="关闭菜单"
                className="ml-auto w-10 h-10 flex items-center justify-center rounded-md hover:bg-[var(--color-surface-2)]"
              >
                ✕
              </button>
            </div>
            <nav className="p-2 flex-1">
              <Link href="/" className={rowCls(pathname === "/")} title="总览：接着上次继续，或建个新助手">
                <span className="w-4 text-center text-[12px]">◆</span>
                <span>概览</span>
              </Link>
              {groupLabel("使用")}
              {USE_ITEMS.map((l) => (
                <Link key={l.href} href={l.href} className={rowCls(isActive(l.href))} title={l.tip}>
                  <span className="w-4 text-center text-[12px]">{l.icon}</span>
                  <span>{l.label}</span>
                </Link>
              ))}
              {groupLabel("配置")}
              {SETUP_ITEMS.map((l) => (
                <Link key={l.href} href={l.href} className={rowCls(isActive(l.href))} title={l.tip}>
                  <span className="w-4 text-center text-[12px]">{l.icon}</span>
                  <span>{l.label}</span>
                </Link>
              ))}
            </nav>
          </aside>
        </>
      )}

      {/* ── 平板：图标条 ───────────────────────────────────── */}
      <aside className="hidden md:flex lg:hidden w-14 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex-col items-center py-3 gap-1">
        <Link
          href="/"
          title="概览"
          className={`w-11 h-11 flex items-center justify-center rounded-md text-[15px] ${
            pathname === "/" ? "text-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]" : "hover:bg-[var(--color-surface-2)]"
          }`}
        >
          ◆
        </Link>
        <div className="w-6 border-t border-[var(--color-border)] my-1" />
        {USE_ITEMS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            title={`${l.label} —— ${l.tip}`}
            className={`w-11 h-11 flex items-center justify-center rounded-md text-[15px] ${
              isActive(l.href)
                ? "text-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]"
                : "hover:bg-[var(--color-surface-2)]"
            }`}
          >
            {l.icon}
          </Link>
        ))}
        <div className="w-6 border-t border-[var(--color-border)] my-1" />
        {SETUP_ITEMS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            title={`${l.label} —— ${l.tip}`}
            className={`w-11 h-11 flex items-center justify-center rounded-md text-[13.5px] ${
              isActive(l.href)
                ? "text-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]"
                : "hover:bg-[var(--color-surface-2)]"
            }`}
          >
            {l.icon}
          </Link>
        ))}
      </aside>

      {/* ── 桌面：完整侧边栏 ───────────────────────────────── */}
      <aside className="hidden lg:flex w-52 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex-col">
        <div className="px-4 py-4 border-b border-[var(--color-border)]">
          <Link href="/" className="font-semibold text-[15px] tracking-tight block">
            Agent Studio
          </Link>
          <div className="text-[10.5px] text-[var(--color-muted)] mt-0.5">
            runtime-agnostic
          </div>
        </div>

        <nav className="p-2 flex-1 overflow-auto">
          <Link
            href="/"
            className={rowCls(pathname === "/")}
            title="总览：接着上次继续，或建个新助手"
          >
            <span className="w-4 text-center text-[12px]">◆</span>
            <span>概览</span>
          </Link>

          {groupLabel("使用")}
          {USE_ITEMS.map((l) => (
            <Link key={l.href} href={l.href} className={rowCls(isActive(l.href))} title={l.tip}>
              <span className="w-4 text-center text-[12px]">{l.icon}</span>
              <span>{l.label}</span>
            </Link>
          ))}

          {groupLabel("配置")}
          {SETUP_ITEMS.map((l) => (
            <Link key={l.href} href={l.href} className={rowCls(isActive(l.href))} title={l.tip}>
              <span className="w-4 text-center text-[12px]">{l.icon}</span>
              <span>{l.label}</span>
            </Link>
          ))}
        </nav>

      </aside>
    </>
  );
}
