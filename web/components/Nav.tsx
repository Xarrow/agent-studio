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
  /** 「设置」二级面板：配置类入口收在这里，不占常驻宽度 */
  const [setupOpen, setSetupOpen] = useState(false);

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

  // 路由变化 / Esc 关掉设置面板
  useEffect(() => setSetupOpen(false), [pathname]);
  useEffect(() => {
    if (!setupOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSetupOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setupOpen]);

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
      <header className="md:hidden fixed top-0 inset-x-0 z-40 h-[calc(44px+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] flex items-center gap-3 px-3 border-b border-[var(--color-border)]">
        {/* 毛玻璃放在独立的一层里，不挂在 header 自己身上：
            backdrop-filter 会给「它的后代」建立新的包含块，header 里那些
            position:fixed 的面板（助手选择、技能选择）就会改成相对 header
            定位，直接跑到屏幕外。放进子层，对兄弟节点没有影响。 */}
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10"
          style={{
            background: "color-mix(in srgb, var(--color-bg) 70%, transparent)",
            backdropFilter: "blur(20px) saturate(1.8)",
            WebkitBackdropFilter: "blur(20px) saturate(1.8)",
          }}
        />
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
          <aside className="md:hidden fixed inset-y-0 left-0 z-50 w-[17rem] max-w-[82vw] bg-[var(--color-surface)] flex flex-col overflow-auto">
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

      {/* ── 一级导航：固定 56px 图标轨（md 以上）─────────────────────
          只有一列图标，没有折叠按钮 —— 收起/展开这件事只留在会话栏那一个 « 。
          配置类 6 项收进「设置」一个入口，点开是二级面板（不占常驻宽度）。
          每个图标都带常驻 tooltip（hover / 键盘 focus 都出）。 */}
      <nav
        className="hidden md:flex w-14 shrink-0 flex-col items-center gap-1 py-2"
        style={{ background: "var(--color-surface)" }}
        aria-label="主导航"
      >
        {USE_ITEMS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            aria-label={l.label}
            data-tip={l.label}
            className="grid h-10 w-10 place-items-center rounded-[var(--radius-md)] transition-colors"
            style={{
              color: isActive(l.href) ? "var(--color-text)" : "var(--color-muted)",
              background: isActive(l.href) ? "var(--bg-selected)" : "transparent",
            }}
          >
            <Icon d={ICON_PATHS[l.icon] ?? ""} size={17} />
          </Link>
        ))}

        <div className="relative mt-1">
          <button
            type="button"
            data-tap
            data-tip="设置"
            aria-label="设置"
            aria-expanded={setupOpen}
            onClick={() => setSetupOpen((v) => !v)}
            className="grid h-10 w-10 place-items-center rounded-[var(--radius-md)] transition-colors"
            style={{
              color: SETUP_ITEMS.some((l) => isActive(l.href))
                ? "var(--color-text)"
                : "var(--color-muted)",
              background: SETUP_ITEMS.some((l) => isActive(l.href))
                ? "var(--bg-selected)"
                : "transparent",
            }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
            </svg>
          </button>

          {setupOpen && (
            <>
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                className="fixed inset-0 z-40 cursor-default"
                onClick={() => setSetupOpen(false)}
              />
              <div
                className="absolute left-[calc(100%+8px)] top-0 z-50 w-[230px] rounded-[var(--radius-lg)] p-1"
                style={{
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-border)",
                  boxShadow: "var(--shadow-2)",
                }}
                role="menu"
              >
                {SETUP_ITEMS.map((l) => (
                  <Link
                    key={l.href}
                    href={l.href}
                    role="menuitem"
                    onClick={() => setSetupOpen(false)}
                    className="flex min-h-[34px] items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 text-[var(--fs-base)]"
                    style={{
                      color: isActive(l.href) ? "var(--color-text)" : "var(--color-text-2)",
                      background: isActive(l.href) ? "var(--bg-selected)" : "transparent",
                    }}
                    title={l.tip}
                  >
                    <Icon d={ICON_PATHS[l.icon] ?? ""} size={15} />
                    <span className="truncate">{l.label}</span>
                  </Link>
                ))}
              </div>
            </>
          )}
        </div>
      </nav>
    </>
  );
}
