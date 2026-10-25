"use client";

/**
 * 输入区上方那一带的通用弹出层。
 *
 * 手机：从底部升起的抽屉（拇指够得到，键盘弹起也不跑）
 * 桌面：右下角的浮卡（避开输入坞）
 *
 * 两个必须点：
 *  ① 用 portal 挂到 body —— 面板的所在位置在输入坞内部，而输入坞自己带
 *     backdrop-filter，会给后代建立新的包含块，position:fixed 于是相对它
 *     定位，面板直接掉到屏幕外（实测 top 844 / bottom 1485）。
 *  ② 桌面也用 fixed，不依赖祖先的 relative/absolute 锚点 —— 一旦将来外壳
 *     再加上 transform 之类，锚点又会漂。
 */

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Sheet({
  open,
  onClose,
  title,
  hint,
  extra,
  children,
  footer,
  width = 360,
  maxH = "72vh",
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  hint?: string;
  extra?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  maxH?: string;
  labelledBy?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      {/* 遮罩：桌面也要。之前只在手机上给遮罩，桌面这张浮卡没有可点的背景，
          于是「点外面关掉」根本不存在，只能按 Esc —— 看起来就是弹窗挂在右边关不掉。 */}
      <div
        className="fixed inset-0 z-[59] veil-in"
        style={{ background: "rgba(15,23,42,.18)" }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-label={title}
        aria-labelledby={labelledBy}
        className="sheet-up z-[60] flex flex-col overflow-hidden max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:rounded-t-[18px] lg:fixed lg:inset-x-0 lg:mx-auto lg:bottom-24 lg:rounded-xl"
        style={
          {
            "--sheet-w": `${width}px`,
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            boxShadow: "0 -8px 40px rgba(15,23,42,.22)",
            paddingBottom: "env(safe-area-inset-bottom)",
            maxHeight: maxH,
          } as React.CSSProperties
        }
      >
        <div className="shrink-0 px-3.5 pt-3 pb-2 flex items-baseline gap-2">
          <span id={labelledBy} className="text-[13.5px] font-semibold">
            {title}
          </span>
          {hint && (
            <span className="text-[11px] min-w-0 truncate" style={{ color: "var(--color-muted)" }}>
              {hint}
            </span>
          )}
          <span className="ml-auto shrink-0">{extra}</span>
        </div>

        <div className="flex-1 min-h-0 overflow-auto">{children}</div>

        {footer && (
          <div className="shrink-0 flex items-center justify-between gap-2 px-3.5 py-2.5 border-t border-[var(--color-border)]">
            {footer}
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}
