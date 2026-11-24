"use client";

/**
 * 统一下拉：一个按钮 + 一层浮层，不用原生 <select>。
 *
 * 为什么不用原生 <select>：
 *   · iOS/Android 会弹系统滚轮/全屏列表，样式和站内完全是两套语言
 *   · 选项多了是原生长列表，没有搜索、没有分组、没有"当前选中"的对勾
 *   · 原生控件的字号/高度在移动端不受 CSS 完全控制，会出现"比别的控件大一圈"
 *
 * 形态口径（跟全站一致）：
 *   · 无边框，靠 surface-2 底色区分；点开是浮层卡片（阴影 + 圆角）
 *   · 桌面 36px 高，手机 44px（触屏热区）
 *   · 选项一行一个，超长文字单行省略，选中项浅底 + 对勾
 *   · 支持分组（label 分节）与禁用项
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isImeEvent } from "@/lib/ime";

export interface SelectOption {
  value: string;
  label: string;
  /** 分节标题：同一节内的选项排在一起 */
  group?: string;
  disabled?: boolean;
  /** 右侧小字（模型的价格、凭据的 service 之类） */
  hint?: string;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = "请选择",
  disabled = false,
  ariaLabel,
  className = "",
  compact = false,
  emptyText = "没有可选项",
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  /** 再矮一档（用在表格行内） */
  compact?: boolean;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number; up: boolean } | null>(
    null,
  );

  const current = useMemo(() => options.find((o) => o.value === value) ?? null, [options, value]);

  const place = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const need = Math.min(320, Math.max(180, options.length * 44 + 16));
    const up = r.bottom + need > window.innerHeight - 8;
    setAnchor({
      x: Math.min(r.left, window.innerWidth - Math.max(r.width, 200) - 8),
      y: up ? Math.max(8, r.top - need - 4) : r.bottom + 4,
      w: Math.max(r.width, 180),
      up,
    });
  }, [options.length]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if ((t as HTMLElement).closest?.("[data-ui-select]")) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // 键盘：↑↓ 选择并回车确认
  const [cursor, setCursor] = useState(-1);
  useEffect(() => {
    if (open) {
      const i = options.findIndex((o) => o.value === value);
      setCursor(i >= 0 ? i : options.findIndex((o) => !o.disabled));
    }
  }, [open, options, value]);

  const onButtonKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    // 空格不当激活键（用户口径：空格是滚动/输入空格，不该弹开面板）
    if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      place();
      setOpen(true);
    }
  };

  const groups = useMemo(() => {
    const out: { name: string; items: SelectOption[] }[] = [];
    for (const o of options) {
      const name = o.group ?? "";
      const last = out[out.length - 1];
      if (last && last.name === name) last.items.push(o);
      else out.push({ name, items: [o] });
    }
    return out;
  }, [options]);

  const menu =
    open && anchor && typeof document !== "undefined"
      ? createPortal(
          <>
            <div className="fixed inset-0 z-[70]" onMouseDown={() => setOpen(false)} aria-hidden />
            <div
              data-ui-select
              role="listbox"
              aria-label={ariaLabel}
              className="fixed z-[71] overflow-y-auto overscroll-contain rounded-[var(--radius-md)] p-1"
              style={{
                left: anchor.x,
                top: anchor.y,
                width: anchor.w,
                maxHeight: 320,
                background: "var(--color-surface)",
                boxShadow: "var(--shadow-2)",
              }}
              onKeyDown={(e) => {
                // 中文组字中回车 = 选字，不是"确认这一项"
                if (isImeEvent(e)) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setCursor((c) => {
                    let n = c;
                    for (let i = 0; i < options.length; i++) {
                      n = (n + 1) % options.length;
                      if (!options[n].disabled) break;
                    }
                    return n;
                  });
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCursor((c) => {
                    let n = c;
                    for (let i = 0; i < options.length; i++) {
                      n = (n - 1 + options.length) % options.length;
                      if (!options[n].disabled) break;
                    }
                    return n;
                  });
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const o = options[cursor];
                  if (o && !o.disabled) {
                    onChange(o.value);
                    setOpen(false);
                  }
                }
              }}
            >
              {options.length === 0 ? (
                <div
                  className="px-3 py-6 text-center text-[length:var(--fs-sm)]"
                  style={{ color: "var(--color-text-3)" }}
                >
                  {emptyText}
                </div>
              ) : (
                groups.map((g) => (
                  <div key={g.name || "_"}>
                    {g.name ? (
                      <div
                        className="px-2.5 pb-1 pt-2 text-[length:var(--fs-xs)] font-medium"
                        style={{ color: "var(--color-text-3)" }}
                      >
                        {g.name}
                      </div>
                    ) : null}
                    {g.items.map((o) => {
                      const active = o.value === value;
                      const idx = options.indexOf(o);
                      return (
                        <button
                          key={o.value}
                          type="button"
                          role="option"
                          aria-selected={active}
                          disabled={o.disabled}
                          onMouseEnter={() => setCursor(idx)}
                          onClick={() => {
                            onChange(o.value);
                            setOpen(false);
                          }}
                          className={`flex w-full items-center gap-2 rounded-[var(--radius-xs)] px-2.5 text-left text-[length:var(--fs-sm)] ${
                            compact ? "h-8" : "h-10 max-md:h-11"
                          } ${o.disabled ? "opacity-45" : ""}`}
                          style={{
                            color: "var(--color-text)",
                            background:
                              idx === cursor ? "var(--bg-hover)" : active ? "var(--bg-selected)" : "transparent",
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate">{o.label}</span>
                          {o.hint ? (
                            <span className="shrink-0 text-[length:var(--fs-xs)]" style={{ color: "var(--color-text-3)" }}>
                              {o.hint}
                            </span>
                          ) : null}
                          {active ? (
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="var(--color-accent)"
                              strokeWidth="2.4"
                              strokeLinecap="round"
                              aria-hidden
                              className="shrink-0"
                            >
                              <path d="m5 12 5 5L20 7" />
                            </svg>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-tap
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          if (disabled) return;
          place();
          setOpen((v) => !v);
        }}
        onKeyDown={onButtonKey}
        className={`flex w-full items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 text-left transition-colors ${
          compact ? "h-8" : "h-9 max-md:h-11"
        } disabled:opacity-45 ${className}`}
        style={{
          background: "var(--color-surface-2)",
          color: current ? "var(--color-text)" : "var(--color-text-3)",
        }}
      >
        <span className="min-w-0 flex-1 truncate text-[length:var(--fs-base)]">
          {current?.label ?? placeholder}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="shrink-0"
          style={{ color: "var(--color-text-3)" }}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {menu}
    </>
  );
}
