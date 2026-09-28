"use client";

/**
 * 页面范式零件（「管理 / 配置」类页面共用）
 * =========================================
 *
 * 为什么要有这个文件
 * ----------------
 * 老版的六个页面各写了一套「标题 + 说明 + 按钮」和一套「卡片垂直堆」，
 * 字号、间距、换行行为、危险色都不一致 —— 用户一眼就能看出「这不是一个产品」。
 *
 * 2026-09-27 定下的范式（三根柱子）：
 *   ① **一行数字代替卡带** —— 统计别再各占一张卡，收进工具条右侧一行；
 *   ② **一行一对象** —— 列表不再是每项一个框，而是同一圈边框里的若干行；
 *   ③ **点哪展开哪** —— 详情就地展开，不跳页、不弹窗，滚动位置与筛选状态都不丢。
 *
 * 用法：管理页用 PageHead + Toolbar + RowList/Row/RowDetail；配置页用 PageHead + Section。
 * 颜色一律走 CSS 变量（--color-*），别在页面里硬编码色值。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

/** 页面标题区：一行「标题 + 说明」，右侧放主操作（窄屏自动折到下一行）。 */
export function PageHead({
  title,
  desc,
  actions,
}: {
  title: string;
  desc?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {desc ? (
          <p className="mt-1 text-[13px]" style={{ color: "var(--color-muted)" }}>
            {desc}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
    </header>
  );
}

/** 一行工具条：筛选、搜索、批量动作都收在这一行里（窄屏自动折行）。 */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="mb-2.5 flex flex-wrap items-center gap-1.5">{children}</div>;
}

/** 段控（枚举值用「选」不用「填」；带上计数，一眼知道每类有多少）。 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  title,
}: {
  options: { key: T; label: string; count?: number }[];
  value: T;
  onChange: (k: T) => void;
  title?: string;
}) {
  return (
    <div
      title={title}
      className="flex items-center gap-0.5 rounded-[10px] border p-0.5"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            className="min-h-[36px] whitespace-nowrap rounded-[7px] px-2.5 text-[12.5px] transition-colors"
            style={{
              background: on ? "var(--color-accent)" : undefined,
              color: on ? "#fff" : "var(--color-muted)",
              fontWeight: on ? 500 : undefined,
            }}
          >
            {o.label}
            {o.count != null ? (
              <span className="ml-1 tabular-nums" style={{ opacity: on ? 0.85 : 0.6 }}>
                {o.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** 小标签（类型 / 状态 / 能力）。配色只有这五种，别在页面里各写一套。 */
export function Chip({
  children,
  tone = "accent",
  title,
}: {
  children: ReactNode;
  tone?: "accent" | "warn" | "ok" | "err" | "muted";
  title?: string;
}) {
  const c = {
    accent: "var(--color-accent)",
    warn: "var(--color-warn)",
    ok: "var(--color-ok)",
    err: "var(--color-err)",
    muted: "var(--color-muted)",
  }[tone];
  return (
    <span
      title={title}
      className="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px]"
      style={{ background: `color-mix(in srgb, ${c} 12%, transparent)`, color: c }}
    >
      {children}
    </span>
  );
}

/** 列表容器：整张表只画**一圈**边框，行与行之间用分隔线（不再是每项一个卡片框）。 */
export function RowList({ children }: { children: ReactNode }) {
  return (
    <div
      className="overflow-hidden rounded-[12px] border"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      {children}
    </div>
  );
}

/**
 * 一行。
 * - `children` 是行主体，**可点 = 就地展开/收起**（行不是链接，不跳页）；
 * - `actions` 独立在右侧，既不参与展开点击（避免误触），也**常驻可见**
 *   —— 用户明确否决过「把常用动作收进 ⋯ 藏起来」。
 */
export function Row({
  children,
  actions,
  expanded,
  onToggle,
  wrapActions = true,
}: {
  children: ReactNode;
  actions?: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  wrapActions?: boolean;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-2.5 gap-y-2 border-b px-3 py-2.5 last:border-b-0"
      style={{
        borderColor: "var(--color-border)",
        background: expanded ? "color-mix(in srgb, var(--color-accent) 5%, transparent)" : undefined,
      }}
    >
      {onToggle ? (
        <div
          role="button"
          tabIndex={0}
          onClick={onToggle}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggle();
            }
          }}
          className="flex min-h-[32px] min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1"
        >
          {children}
        </div>
      ) : (
        <div className="flex min-h-[32px] min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">
          {children}
        </div>
      )}
      {actions ? (
        <div className={`flex shrink-0 items-center gap-1.5 ${wrapActions ? "flex-wrap" : ""}`}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/** 行展开后的内容区（浅底、与行同宽）。 */
export function RowDetail({ children }: { children: ReactNode }) {
  return (
    <div
      className="border-b px-3 pb-3 pt-2.5 last:border-b-0"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
    >
      {children}
    </div>
  );
}

/** 空态：一句话说清「这里该有什么」+ 一个去处。 */
export function Empty({
  title,
  hint,
  action,
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="px-4 py-10 text-center">
      <div className="text-[14px]">{title}</div>
      {hint ? (
        <div className="mx-auto mt-1.5 max-w-[420px] text-[12.5px] leading-relaxed" style={{ color: "var(--color-muted)" }}>
          {hint}
        </div>
      ) : null}
      {action ? <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}

/** 键值一行（展开区里用：左边是名目，右边是值）。 */
export function KV({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px]">
      <span className="shrink-0" style={{ color: "var(--color-muted)" }}>
        {k}
      </span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

/**
 * 行首勾选框（列表批量选择用）。
 *
 * 放在 `Row` 的 children 里；点它是**勾选**，不该顺带展开这一行 ——
 * 所以自己吞掉冒泡。命中区靠 label 撑到 44px（触屏），外观还是小方框。
 */
export function SelectBox({
  checked,
  onChange,
  title,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <label
      title={title}
      onClick={(e) => e.stopPropagation()}
      className="flex h-11 w-8 shrink-0 cursor-pointer items-center justify-center lg:h-8"
    >
      <input
        type="checkbox"
        className="h-[17px] w-[17px] accent-[var(--color-accent)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

/**
 * 批量操作条 —— 勾了行才出现，且**紧贴被勾的那批行上方**。
 *
 * 为什么不做成常驻工具条：批量动作是"跟着选中对象走"的，没选中时它
 * 只是占着最贵的位置空转。出现在这批行的正上方，用户一眼能看出
 * "这些动作作用在下面这批"。
 */
export function SelectionBar({
  count,
  actions,
  onSelectAll,
  onClear,
  selectAllLabel,
  allSelected,
}: {
  count: number;
  actions: ReactNode;
  onSelectAll?: () => void;
  onClear?: () => void;
  selectAllLabel?: string;
  allSelected?: boolean;
}) {
  return (
    <div
      className="mb-2 flex flex-wrap items-center gap-2 rounded-[10px] px-3 py-2"
      style={{ background: "color-mix(in srgb, var(--color-accent) 8%, transparent)" }}
    >
      <span className="text-[12.5px]">已选 {count} 条</span>
      {actions}
      {onSelectAll ? (
        <button
          className="btn text-[12.5px]"
          style={{ color: "var(--color-muted)" }}
          onClick={onSelectAll}
        >
          {allSelected ? "取消全选" : (selectAllLabel ?? "全选")}
        </button>
      ) : null}
      {onClear ? (
        <button
          className="btn text-[12.5px]"
          style={{ color: "var(--color-muted)" }}
          onClick={onClear}
        >
          取消选择
        </button>
      ) : null}
    </div>
  );
}

/**
 * 开关（是的/否 这类二元设置）。
 *
 * 为什么要有：原来各页手写 <button role="switch"><span/></button>，
 * 圆点用 `absolute + translate-x-*` 却**没写 left** —— 绝对定位在没有
 * left/top 时取「静态位置」，而按钮里的内容默认居中，于是圆点的起点被
 * 推到了中间，再 translate 24px 就整个跑出轨道（实测溢出 20px：圆形
 * 滑块一半挂在框外）。样式问题就是这么来的。
 *
 * 两条硬要求写在零件里，页面不该再自己拼：
 *   ① 圆点用 left/top 显式定位（不依赖静态位置）；
 *   ② 命中区 ≥44px（触屏）—— 靠**本体尺寸**撑开，不用伪元素
 *      （伪元素不接收点击，之前踩过）。
 */
export function Switch({
  checked,
  onChange,
  disabled,
  ariaLabel,
  title,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      data-tap
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex h-11 shrink-0 items-center justify-center px-1 disabled:opacity-50 lg:h-8"
    >
      <span
        className="relative block h-6 w-12 rounded-full transition-colors"
        style={{ background: checked ? "var(--color-accent)" : "var(--color-border)" }}
      >
        <span
          className="absolute left-[2px] top-[2px] h-5 w-5 rounded-full bg-white shadow transition-transform"
          style={{ transform: checked ? "translateX(24px)" : "translateX(0)" }}
        />
      </span>
    </button>
  );
}

/**
 * 自研下拉菜单（禁用浏览器原生 confirm/prompt，也禁用「把动作藏进 ⋯」的写法
 * —— 这里是给**清理类/低频批量**动作用的，常用动作仍须常驻可见）。
 */
export function Menu({
  items,
  label = "⋯",
  title,
  align = "right",
}: {
  items: { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string }[];
  label?: ReactNode;
  title?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((v) => !v)}
        className="min-h-[36px] rounded-[8px] border px-2.5 text-[13px] hover:bg-[var(--color-surface-2)]"
        style={{ borderColor: "var(--color-border)" }}
      >
        {label}
      </button>
      {open ? (
        <div
          role="menu"
          className={`absolute z-30 mt-1 w-[200px] overflow-hidden rounded-[10px] border shadow-lg ${
            align === "right" ? "right-0" : "left-0"
          }`}
          style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              title={it.hint}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
              className="flex min-h-[38px] w-full flex-col items-start justify-center px-3 text-left text-[12.5px] hover:bg-[var(--color-surface-2)] disabled:opacity-40"
              style={it.danger ? { color: "var(--color-err)" } : undefined}
            >
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 表单小标签（与 .label 一致，便于页面少写重复类名）。 */
export function FieldLabel({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="label flex items-center gap-1.5">
      {children}
      {hint}
    </div>
  );
}

/**
 * 配置页的可折叠分区。
 * 目的：把「一堆卡片垂直堆」收成若干段 —— 每段一个标题 + 一句为什么需要它，
 * 内容默认展开（信息默认可见），只有明显次要的段落才 defaultOpen={false}。
 */
export function Section({
  title,
  desc,
  right,
  children,
  defaultOpen = true,
  count,
}: {
  title: ReactNode;
  desc?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  count?: number | string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      className="overflow-hidden rounded-[12px] border"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-h-[36px] min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>
            {open ? "▾" : "▸"}
          </span>
          <span className="min-w-0">
            <span className="block text-[13.5px] font-medium">
              {title}
              {count != null ? (
                <span className="ml-1.5 text-[12px] font-normal" style={{ color: "var(--color-muted)" }}>
                  {count}
                </span>
              ) : null}
            </span>
            {desc ? (
              <span className="mt-0.5 block text-[11.5px] leading-snug" style={{ color: "var(--color-muted)" }}>
                {desc}
              </span>
            ) : null}
          </span>
        </button>
        {right ? <div className="flex shrink-0 flex-wrap items-center gap-1.5">{right}</div> : null}
      </div>
      {open ? (
        <div className="border-t px-3 py-3" style={{ borderColor: "var(--color-border)" }}>
          {children}
        </div>
      ) : null}
    </section>
  );
}


/* ──────────────────────────────────────────────────────────────────────────
   弹层外壳（全站弹窗共用）
   ──────────────────────────────────────────────────────────────────────────

   老代码里 8 个弹窗各写各的外壳，其中 3 个**卡片没有高度上限也没有滚动**：
   手机上表单比屏幕高（实测「新建助手」内容 897px / 可视 776px），
   底部「创建」按钮直接被裁在视口外，手指怎么滑都够不到 ✗。

   统一成这一对常量，保证三件事：
     ① 手机上贴底（拇指够得到，和画布节点详情同一形态）、桌面居中；
     ② 卡片高度封顶 + 自己滚 → 内容再长也能翻到底；
     ③ 手机端圆角只留上沿、桌面四角（贴底时下面不该有圆角缝）。
   配合 `Dialog` 之外的场景也能用：直接引这两个常量即可，不要再手写。
   ────────────────────────────────────────────────────────────────────────── */
export const DLG_BACKDROP =
  "fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-[var(--color-overlay)] p-0 sm:items-center sm:p-4";
export const DLG_CARD =
  "card w-full max-h-[92dvh] overflow-y-auto rounded-b-none rounded-t-[14px] sm:my-auto sm:max-h-[88dvh] sm:rounded-[12px]";
