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

/** 内联 SVG 描边图标（用户偏好：克制 emoji / 字符图标，统一用描边 SVG） */
const Icon = ({ d, size = 15 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

/** 使用 —— 日常干活的入口 */
const USE_ITEMS: Item[] = [
  {
    href: "/exec",
    label: "Agent 执行",
    icon: "exec",
    // 对话式干活入口（画布已退役）：选一个助手、说话、看它怎么想怎么做。
    tip: "干活的地方：选一个助手，把任务说给它听（可带文件）；它每一步怎么想、调了什么工具、结果是什么，全程看得见。",
  },
];

/** 配置 —— 一次性设置的地方 */
const SETUP_ITEMS: Item[] = [
  {
    href: "/runs",
    label: "管理",
    icon: "manage",
    tip: "全部运行记录：每次执行（LLM 测试 / 助手试跑 / Agent 执行）点一行就地展开，看它怎么想、调了什么、耗时花在哪。",
  },
  {
    href: "/agents",
    label: "Agents",
    icon: "agents",
    tip: "「助手」：一个会自己想办法帮你做事的 AI。你可以给不同的助手不同的分工。",
  },
  {
    href: "/memories",
    label: "记忆",
    icon: "memory",
    tip: "跨对话的长期记性：值得记住的事存下来，以后聊天会自动想起来。",
  },
  {
    href: "/tools",
    label: "工具",
    icon: "tools",
    tip: "给助手加「手」：能查网页、读文件、跑命令之类。不加就只能聊天。",
  },
    {
    href: "/remote-agents",
    label: "远程 Agent",
    icon: "exchange",
    tip: "接入别处的 A2A agent：粘地址注册或把注册地址给对方，看清它会什么，挂到助手上直接调用。",
  },
  {
    href: "/environment",
    label: "环境配置",
    icon: "database",
    tip: "选择平台把数据存在哪里：默认是本地文件（SQLite），也可以切到你自己的 MySQL 或 PostgreSQL。切换时新库会自动建好表。",
  },
  {
    href: "/credentials",
    label: "LLM 配置",
    icon: "key",
    tip: "让 AI 能工作的「钥匙」（模型服务商的密钥）。加密保存，不会明文显示。",
  },
];

/** 图标路径（24×24 描边）：与 Item.icon 对应 */
const ICON_PATHS: Record<string, string> = {
  exec: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10z", // 对话气泡
  manage: "M4 6h16M4 12h16M4 18h10", // 列表
  agents: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM12 12l8-4.5M12 12v9M12 12L4 7.5", // 立方体
  memory: "M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4", // 芯片/记忆
  tools: "M14.7 6.3a4.5 4.5 0 0 0-6 5.9L3 18l3 3 5.8-5.7a4.5 4.5 0 0 0 5.9-6L14 13l-3-3 3.7-3.7z", // 扳手
  exchange: "M7 16l-4-4 4-4M3 12h18M17 8l4 4-4 4M21 12", // 双向箭头
  database: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3", // 数据库
  key: "M14.5 4a5.5 5.5 0 1 1-4.9 8L4 17.6V20h2.4l1-1v-2h2v-2h2l1.2-1.2A5.5 5.5 0 0 1 14.5 4z", // 钥匙
};

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

      {/* ── 平板：图标条 ───────────────────────────────────── */}
      <aside className="hidden md:flex lg:hidden w-14 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex-col items-center py-3 gap-1">
        {/* 概览页已移除（用户要求）—— 平板图标条上那一条也一起去掉 */}
        {USE_ITEMS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            title={`${l.label} —— ${l.tip}`}
            className={`w-11 h-11 flex items-center justify-center rounded-md ${
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
            className={`w-11 h-11 flex items-center justify-center rounded-md ${
              isActive(l.href)
                ? "text-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]"
                : "hover:bg-[var(--color-surface-2)]"
            }`}
          >
            <Icon d={ICON_PATHS[l.icon] ?? ""} size={16} />
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
  );
}
