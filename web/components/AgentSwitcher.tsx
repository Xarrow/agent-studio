"use client";

/**
 * 对话页的「当前助手」身份块 + 选择面板。
 *
 * 以前这里是一个原生 <select>：只有名字、长名字被截断、手机上是一屏系统滚轮、
 * 选的时候看不到这个助手会什么（描述 / 模型 / 是不是编排者）。7 个助手靠记忆挑。
 *
 * 现在：左上角一块身份徽章（字母块 + 名字 + 状态点），点开是一个面板 ——
 * 每个助手一行，带描述和模型，当前项打勾；助手多于 12 个才出现搜索框。
 * 手机上面板从底部弹出（触屏 52px 行高），桌面上贴着徽章往下展开。
 *
 * 只有一个入口：顶栏徽章。空状态里的「换一个」也打开这同一块面板。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "@/lib/types";

function mark(name: string) {
  const s = (name || "").trim();
  if (!s) return "?";
  // 中文取第一个字，英文取首字母
  return s.slice(0, 1).toUpperCase();
}

function modelLabel(a: Agent) {
  const m = a.definition?.model as { name?: string; model?: string } | undefined;
  return (m?.name || m?.model || "").replace(/^.*\//, "");
}

export function AgentSwitcher({
  agents,
  value,
  onChange,
  busy,
  open,
  onOpenChange,
  variant = "bar",
  className = "",
  onSettings,
}: {
  agents: Agent[];
  value: string;
  onChange: (id: string) => void;
  busy?: boolean;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** bar=顶栏紧凑徽章（手机 / 侧栏收起时）；sidebar=会话列表顶部的身份块 */
  variant?: "bar" | "sidebar" | "mini";
  className?: string;
  /** 侧栏模式下块右侧的「配置」入口：动作归属对象自己的位置 */
  onSettings?: () => void;
}) {
  const current = agents.find((a) => a.id === value);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [q, setQ] = useState("");

  const needSearch = agents.length > 12;
  const shown = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(kw) ||
        (a.description || "").toLowerCase().includes(kw),
    );
  }, [agents, q]);

  // 打开时把当前项摆在视线里，并把高亮放到它上面
  useEffect(() => {
    if (!open) {
      setQ("");
      return;
    }
    const idx = Math.max(0, shown.findIndex((a) => a.id === value));
    setActive(idx);
    // 焦点进面板，Esc / 方向键才有反应
    setTimeout(() => {
      if (needSearch) inputRef.current?.focus();
      else panelRef.current?.focus();
    }, 60);
    const t = setTimeout(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-aidx="${idx}"]`)?.scrollIntoView({ block: "nearest" });
    }, 80);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 点面板外面就收起（手机上另有遮罩，桌面靠这个）
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const el = rootRef.current;
      if (el && !el.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onOpenChange]);

  const close = () => onOpenChange(false);
  const pick = (id: string) => {
    onChange(id);
    close();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = shown.length;
      if (!n) return;
      const next = e.key === "ArrowDown" ? (active + 1) % n : (active - 1 + n) % n;
      setActive(next);
      listRef.current?.querySelector<HTMLElement>(`[data-aidx="${next}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const a = shown[active];
      if (a) pick(a.id);
    }
  };

  const side = variant === "sidebar";
  const mini = variant === "mini";

  return (
    <div ref={rootRef} className={`relative min-w-0 ${side && onSettings ? "flex items-center gap-1" : ""} ${className}`}>
      {/* ── 身份徽章 ─────────────────────────────────────────── */}
      <button
        data-tap
        onClick={() => onOpenChange(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current?.name ? `当前助手：${current.name}` : "选择助手"}
        className={
          mini
            ? "grid place-items-center w-9 h-9 rounded-lg transition-colors hover:bg-[var(--color-surface-2)]"
            : side
              ? "flex-1 min-w-0 flex items-center gap-2 h-9 px-2 rounded-lg transition-colors hover:bg-[var(--color-surface-2)]"
              /* 顶栏这一档撑满中间的空白：点名字这一下的热区越大越好（手机上
                 中间空着一大片却点不到，是这行看着"散"的原因之一）。名字超长
                 由 min-w-0 + truncate 收住，不会把右边的箭头挤出去。 */
              /* w-full 而不是 flex-1：这一档的外层是块级 div（不是 flex 容器），
                 flex-1 在这儿等于没写，按钮会缩成内容宽度、把中间留成死白。 */
              : "w-full min-w-0 flex items-center gap-2 h-9 pl-1 pr-2 rounded-lg transition-colors hover:bg-[var(--color-surface-2)]"
        }
      >
        <span
          className="shrink-0 grid place-items-center w-[26px] h-[26px] rounded-[7px] text-[12.5px] font-semibold"
          style={{
            background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
            color: "var(--color-accent)",
          }}
          aria-hidden="true"
        >
          {mark(current?.name || "")}
        </span>
        {!mini && (
        <span className="min-w-0 truncate font-medium text-[13.5px]">
          {current?.name ?? "选择助手"}
        </span>
        )}
        {!mini && (
        <>
        <span
          className="shrink-0 w-[6px] h-[6px] rounded-full"
          title={busy ? "执行中" : "就绪"}
          style={{ background: busy ? "var(--color-accent)" : "var(--color-ok)" }}
          aria-hidden="true"
        />
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0"
          style={{ color: "var(--color-muted)" }}
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
        </>
        )}
      </button>

      {side && onSettings && (
        <button
          data-tap
          title="配置这个助手"
          onClick={onSettings}
          className="shrink-0 w-9 h-9 grid place-items-center rounded-lg transition-colors hover:bg-[var(--color-surface-2)]"
          style={{ color: "var(--color-muted)" }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
      )}

      {/* ── 选择面板：桌面上贴徽章展开，手机从底部弹出 ─────────── */}
      {open && (
        <>
          <div
            className="lg:hidden fixed inset-0 z-40"
            style={{ background: "var(--color-overlay)" }}
            onClick={close}
            aria-hidden="true"
          />
          <div
            ref={panelRef}
            role="listbox"
            tabIndex={-1}
            onKeyDown={onKey}
            className={`z-50 fixed inset-x-2 bottom-2 rounded-2xl lg:absolute lg:inset-x-auto lg:bottom-auto lg:left-0 lg:top-[calc(100%+8px)] lg:rounded-xl border overflow-hidden flex flex-col ${
              side || mini ? "lg:w-[348px]" : "lg:w-[400px]"
            }`}
            style={{
              background: "var(--color-surface)",
              borderColor: "var(--color-border)",
              boxShadow: "0 14px 40px rgba(15,23,42,.18)",
              outline: "none",
            }}
          >
            <div className="flex items-center justify-between px-3 h-10 border-b border-[var(--color-border)] shrink-0">
              <span className="text-[12px] font-medium" style={{ color: "var(--color-muted)" }}>
                选择助手 · {agents.length}
              </span>
              <button
                data-tap
                className="lg:hidden text-[12.5px] px-2 h-8 rounded-md"
                style={{ color: "var(--color-muted)" }}
                onClick={close}
              >
                关闭
              </button>
            </div>

            {needSearch && (
              <div className="px-2 pt-2 shrink-0">
                <input
                  ref={inputRef}
                  className="input h-9 text-[13px]"
                  placeholder="搜索助手"
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setActive(0);
                  }}
                />
              </div>
            )}

            <div ref={listRef} className="overflow-auto py-1" style={{ maxHeight: "min(58vh, 420px)" }}>
              {shown.length === 0 && (
                <div className="px-3 py-6 text-center text-[12.5px]" style={{ color: "var(--color-muted)" }}>
                  没找到「{q}」
                </div>
              )}
              {shown.map((a, i) => {
                const on = a.id === value;
                const ml = modelLabel(a);
                const orch = a.definition?.role === "orchestrator";
                return (
                  <button
                    key={a.id}
                    data-aidx={i}
                    data-tap
                    role="option"
                    aria-selected={on}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(a.id)}
                    className="w-full text-left flex items-start gap-2.5 px-2.5 min-h-[52px] py-2 transition-colors"
                    style={{ background: i === active ? "var(--color-surface-2)" : "transparent" }}
                  >
                    <span
                      className="shrink-0 grid place-items-center w-[30px] h-[30px] rounded-lg text-[13px] font-semibold mt-0.5"
                      style={{
                        background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
                        color: "var(--color-accent)",
                      }}
                      aria-hidden="true"
                    >
                      {mark(a.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[13.5px] font-medium">{a.name}</span>
                        {orch && (
                          <span
                            className="shrink-0 text-[10.5px] px-1.5 py-[1px] rounded"
                            style={{
                              background: "var(--color-surface-3)",
                              color: "var(--color-muted)",
                            }}
                          >
                            编排者
                          </span>
                        )}
                      </span>
                      <span
                        className="block truncate text-[11.5px] mt-[2px]"
                        style={{ color: "var(--color-muted)" }}
                      >
                        {a.description || ml || "没有描述"}
                        {a.description && ml ? ` · ${ml}` : ""}
                      </span>
                    </span>
                    {on && (
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0 mt-1"
                        style={{ color: "var(--color-accent)" }}
                        aria-hidden="true"
                      >
                        <path d="m5 12.5 4.5 4.5L19 7" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>

            <a
              href="/agents"
              className="shrink-0 flex items-center justify-between px-3 h-9 border-t border-[var(--color-border)] text-[12.5px] hover:bg-[var(--color-surface-2)]"
              style={{ color: "var(--color-muted)" }}
            >
              管理全部助手
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
            </a>
          </div>
        </>
      )}
    </div>
  );
}
