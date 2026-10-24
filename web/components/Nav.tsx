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

import { ICON_PATHS, SETUP_ITEMS, USE_ITEMS, type NavItem } from "@/lib/nav-items";

type Item = NavItem;

/** 内联 SVG 描边图标（用户偏好：克制 emoji / 字符图标，统一用描边 SVG） */
const Icon = ({ d, size = 15 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

export function Nav() {
  const pathname = usePathname();
  /** 对话页自己有一条顶栏（菜单 + 当前助手 + 配置），全局这条不再叠一层 —— 
      手机上两条 bar 摞着要吃掉 108px，而且中间那条大片空白看着像没做完。 */
  const isExecPage = pathname === "/exec";
  /** 顶栏中间显示当前在哪，而不是固定的产品名 —— 对话页那一条同一个位置放
      的是"当前助手"，两边对齐后走哪儿都长一个样。 */
  const currentLabel =
    [...USE_ITEMS, ...SETUP_ITEMS].find((i) => i.href === pathname)?.label ?? "Agent Studio";
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

  // ── 侧栏折叠（lg 及以上：完整栏 ⇄ 图标条）───────────────────────────────
  // 多栏布局里最左边这栏也让人能收起来，把宽度让给内容；选择写 localStorage。
  const [navFolded, setNavFolded] = useState(false);
  useEffect(() => {
    try {
      setNavFolded(localStorage.getItem("nav.folded") === "1");
    } catch {}
  }, []);
  const toggleNav = () => {
    setNavFolded((v) => {
      try { localStorage.setItem("nav.folded", v ? "0" : "1"); } catch {}
      return !v;
    });
  };

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
      {/* ── 移动端顶栏（对话页除外：那条由 ChatConsole 自己出）──────── */}
      {!isExecPage && (
      <header className="md:hidden fixed top-0 inset-x-0 z-40 h-[calc(52px+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] flex items-center gap-3 px-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="打开菜单"
          className="w-9 h-9 -ml-2 flex items-center justify-center rounded-md hover:bg-[var(--color-surface-2)] active:bg-[var(--color-surface-2)]"
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
        <span className="font-semibold text-[15px] tracking-tight">{currentLabel}</span>
      </header>
      )}

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
              {/* 手机上整块做成 44 高的可点区（抽屉顶上这一下常点，14px 的字高不够） */}
              <Link href="/" className="inline-flex min-h-[36px] items-center font-semibold text-[15px] tracking-tight">
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
              {groupLabel("使用")}
              {USE_ITEMS.map((l) => (
                <Link key={l.href} href={l.href} className={rowCls(isActive(l.href))} title={l.tip}>
                  <Icon d={ICON_PATHS[l.icon] ?? ""} size={14} />
                  <span>{l.label}</span>
                </Link>
              ))}
              {groupLabel("配置")}
              {SETUP_ITEMS.map((l) => (
                <Link key={l.href} href={l.href} className={rowCls(isActive(l.href))} title={l.tip}>
                  <Icon d={ICON_PATHS[l.icon] ?? ""} size={14} />
                  <span>{l.label}</span>
                </Link>
              ))}
            </nav>
          </aside>
        </>
      )}

      {/* ── 平板图标条 / 桌面折叠后的图标条 ─────────────────── */}
      <aside className={`hidden md:flex ${navFolded ? "" : "lg:hidden"} w-14 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex-col items-center py-3 gap-1`}>
        {/* 折叠态（lg+）的展开按钮：只在这一档出现，平板宽度靠汉堡菜单 */}
        {navFolded && (
          <button
            data-tap
            title="展开导航栏"
            onClick={toggleNav}
            className="hidden lg:flex w-11 h-9 items-center justify-center rounded-md text-[13px] text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] mb-1"
          >
            »
          </button>
        )}
        {/* 概览页已移除（用户要求）—— 平板图标条上那一条也一起去掉 */}
        {USE_ITEMS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            title={`${l.label} —— ${l.tip}`}
            className={`w-9 h-9 flex items-center justify-center rounded-md ${
              isActive(l.href)
                ? "text-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]"
                : "hover:bg-[var(--color-surface-2)]"
            }`}
          >
            <Icon d={ICON_PATHS[l.icon] ?? ""} size={16} />
          </Link>
        ))}
        <div className="w-6 border-t border-[var(--color-border)] my-1" />
        {SETUP_ITEMS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            title={`${l.label} —— ${l.tip}`}
            className={`w-9 h-9 flex items-center justify-center rounded-md ${
              isActive(l.href)
                ? "text-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]"
                : "hover:bg-[var(--color-surface-2)]"
            }`}
          >
            <Icon d={ICON_PATHS[l.icon] ?? ""} size={16} />
          </Link>
        ))}
      </aside>

      {/* ── 桌面：完整侧边栏（可折叠成上面的图标条）─────────── */}
      {!navFolded && (
      <aside className="hidden lg:flex w-52 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex-col">
        <div className="px-4 py-4 border-b border-[var(--color-border)] flex items-start">
          <div className="min-w-0">
            <Link href="/" className="font-semibold text-[15px] tracking-tight block">
              Agent Studio
            </Link>
            <div className="text-[10.5px] text-[var(--color-muted)] mt-0.5">
              runtime-agnostic
            </div>
          </div>
          <button
            data-tap
            title="收起导航栏"
            onClick={toggleNav}
            className="ml-auto shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-[12px] text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]"
          >
            «
          </button>
        </div>

        <nav className="p-2 flex-1 overflow-auto">
          {groupLabel("使用")}
          {USE_ITEMS.map((l) => (
            <Link key={l.href} href={l.href} className={rowCls(isActive(l.href))} title={l.tip}>
              <Icon d={ICON_PATHS[l.icon] ?? ""} size={14} />
              <span>{l.label}</span>
            </Link>
          ))}

          {groupLabel("配置")}
          {SETUP_ITEMS.map((l) => (
            <Link key={l.href} href={l.href} className={rowCls(isActive(l.href))} title={l.tip}>
              <Icon d={ICON_PATHS[l.icon] ?? ""} size={14} />
              <span>{l.label}</span>
            </Link>
          ))}
        </nav>

      </aside>
      )}
    </>
  );
}
