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

import { ICON_PATHS, SETUP_ITEMS, SYSTEM_ITEMS, USE_ITEMS, railItems, type NavItem } from "@/lib/nav-items";
import { api } from "@/lib/api";

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
  /** 图标轨能否展开成带文字的完整菜单（用户明确要的：展开后每个入口都看得到名字） */
  const [expanded, setExpanded] = useState(false);
  /** 徽标：技能库数量 + 运行环境是否就绪（一次拉取，路由变化时刷新） */
  const [skillCount, setSkillCount] = useState<number | null>(null);
  const [envReady, setEnvReady] = useState<boolean | null>(null);
  const [dark, setDark] = useState(false);

  useEffect(() => {
    let alive = true;
    void api
      .skills()
      .then((rows) => alive && setSkillCount(rows.length))
      .catch(() => alive && setSkillCount(null));
    void api
      .health()
      .then((h) => alive && setEnvReady(String(h?.status ?? "") === "ok"))
      .catch(() => alive && setEnvReady(false));
    return () => {
      alive = false;
    };
  }, [pathname]);

  // 展开状态：记住上次选择；第一次来按屏幕宽度给个合理默认（宽屏直接展开）
  useEffect(() => {
    const saved = window.localStorage.getItem("studio.nav.expanded");
    if (saved === "1") setExpanded(true);
    else if (saved === "0") setExpanded(false);
    else setExpanded(window.innerWidth >= 1280);
  }, []);

  const toggleExpanded = () => {
    setExpanded((v) => {
      const next = !v;
      window.localStorage.setItem("studio.nav.expanded", next ? "1" : "0");
      return next;
    });
  };

  // 深浅色：跟 localStorage 走，切的时候直接改 <html data-theme>
  useEffect(() => {
    const saved = window.localStorage.getItem("studio.theme");
    const isDark = saved === "dark";
    setDark(isDark);
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
  }, []);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? "dark" : "light";
    window.localStorage.setItem("studio.theme", next ? "dark" : "light");
  };

  // Alt+1…9 跳到图标轨上对应位置（提示里的快捷键必须真的能用）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      const n = Number(e.key);
      if (!n || n < 1) return;
      const target = railItems()[n - 1];
      if (target) {
        e.preventDefault();
        window.location.assign(target.href);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < 1024) setExpanded(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
          上区 = 干活用的（对话 / 管理 / Agents / 记忆 / 工具）；
          分隔线以下 = 低频系统入口（API 密钥 / 系统设置 / 主题），固定沉底。
          每个图标常驻 tooltip（hover 与键盘 focus 都出），并写明 Alt+N。 */}
      <nav
        className={`hidden md:flex shrink-0 flex-col py-2 ${expanded ? "items-stretch px-2" : "items-center gap-1"}`}
        style={{
          background: "var(--color-surface)",
          width: expanded ? 208 : 56,
          transition: "width var(--dur-1)",
        }}
        aria-label="主导航"
        data-expanded={expanded ? "1" : "0"}
      >
        {/* 展开/收起：常驻在导轨最上方，不藏进菜单 */}
        <button
          type="button"
          onClick={toggleExpanded}
          aria-label={expanded ? "收起菜单" : "展开菜单"}
          aria-expanded={expanded}
          data-tip={expanded ? "收起" : "展开菜单"}
          className={`mb-1 flex h-8 items-center rounded-[var(--radius-md)] transition-colors hover:bg-[var(--color-surface-2)] ${
            expanded ? "w-full gap-2 px-2" : "w-10 justify-center"
          }`}
          style={{ color: "var(--color-muted)" }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {expanded ? <path d="M15 6l-6 6 6 6" /> : <path d="M9 6l6 6-6 6" />}
          </svg>
          {expanded && <span className="text-[12px]">收起</span>}
        </button>

        {expanded && <NavGroupLabel>使用</NavGroupLabel>}
        {USE_ITEMS.map((l) => {
          const withShort = railItems().find((x) => x.href === l.href) ?? l;
          return (
            <RailLink
              key={l.href}
              item={withShort}
              expanded={expanded}
              active={isActive(l.href)}
            />
          );
        })}

        {expanded && <NavGroupLabel>配置</NavGroupLabel>}
        {SETUP_ITEMS.map((l) => {
          const withShort = railItems().find((x) => x.href === l.href) ?? l;
          return (
            <RailLink
              key={l.href}
              item={withShort}
              expanded={expanded}
              active={isActive(l.href)}
              badge={l.href === "/tools" && skillCount != null ? String(skillCount) : undefined}
              dot={l.href === "/tools" && envReady === false ? "var(--color-danger)" : undefined}
            />
          );
        })}

        <div className={`my-1 h-px ${expanded ? "w-full" : "w-6"}`} style={{ background: "var(--color-border)" }} />
        {expanded && <NavGroupLabel>系统</NavGroupLabel>}

        {SYSTEM_ITEMS.map((l) => {
          const withShort = railItems().find((x) => x.href === l.href) ?? l;
          return (
            <RailLink
              key={l.href}
              item={withShort}
              expanded={expanded}
              active={isActive(l.href)}
              dot={l.href === "/environment" ? (envReady ? "var(--color-ok)" : "var(--color-warn)") : undefined}
            />
          );
        })}

        {/* 主题切换：不是页面，是开关 —— 固定在下区最后一个 */}
        <button
          onClick={toggleTheme}
          aria-label={dark ? "切到浅色" : "切到深色"}
          data-tip={`${dark ? "浅色" : "深色"}主题`}
          className={`flex items-center rounded-[var(--radius-md)] transition-colors hover:bg-[var(--color-surface-2)] ${
            expanded ? "h-9 w-full gap-2.5 px-2" : "h-10 w-10 justify-center"
          }`}
          style={{ color: "var(--color-muted)" }}
        >
          {expanded && <span className="text-[12.5px]">{dark ? "浅色主题" : "深色主题"}</span>}
          {dark ? (
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
            </svg>
          ) : (
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
            </svg>
          )}
        </button>
      </nav>
    </>
  );
}

/** 图标轨上的一个入口：常驻 tooltip（标签 · 快捷键）、可选数量徽标、可选状态点。 */
function RailLink({
  item,
  active,
  badge,
  dot,
  expanded = false,
}: {
  item: NavItem;
  active: boolean;
  badge?: string;
  dot?: string;
  expanded?: boolean;
}) {
  return (
    <Link
      href={item.href}
      aria-label={`${item.label}${item.short ? `（${item.short}）` : ""}`}
      data-tip={expanded ? undefined : `${item.label}${item.short ? ` · ${item.short}` : ""}`}
      title={expanded ? item.tip : undefined}
      className={
        expanded
          ? "relative flex h-9 w-full items-center gap-2.5 rounded-[var(--radius-md)] px-2 transition-colors hover:bg-[var(--color-surface-2)]"
          : "relative grid h-10 w-10 place-items-center rounded-[var(--radius-md)] transition-colors"
      }
      style={{
        color: active ? "var(--color-text)" : "var(--color-muted)",
        background: active ? "var(--bg-selected)" : "transparent",
        fontWeight: active && expanded ? 500 : undefined,
      }}
    >
      <Icon d={ICON_PATHS[item.icon] ?? ""} size={17} />
      {expanded && (
        <>
          <span className="min-w-0 flex-1 truncate text-[12.5px]" style={{ color: active ? "var(--color-text)" : "var(--color-text-2)" }}>
            {item.label}
          </span>
          {badge && (
            <span
              className="shrink-0 rounded-full px-1.5 text-[10px] leading-[16px] tabular-nums"
              style={{ background: "var(--bg-hover)", color: "var(--color-text-2)" }}
            >
              {badge}
            </span>
          )}
          <span className="shrink-0 text-[10px] tabular-nums" style={{ color: "var(--color-text-3)" }}>
            {item.short?.replace("Alt+", "⌥") ?? ""}
          </span>
        </>
      )}
      {badge && !expanded && (
        <span
          className="pointer-events-none absolute -right-0.5 -top-0.5 min-w-[15px] rounded-full px-1 text-center text-[9.5px] leading-[15px] tabular-nums"
          style={{ background: "var(--bg-hover)", color: "var(--color-text-2)" }}
        >
          {badge}
        </span>
      )}
      {dot && (
        <span
          className="pointer-events-none absolute right-1 bottom-1 h-[6px] w-[6px] rounded-full"
          style={{ background: dot }}
          aria-hidden="true"
        />
      )}
    </Link>
  );
}

/** 展开态的分组标题（收起态不显示 —— 图标轨靠分隔线与 tooltip 区分） */
function NavGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="px-2 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider"
      style={{ color: "var(--color-text-3)" }}
    >
      {children}
    </div>
  );
}
