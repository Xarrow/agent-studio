"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useImeGuard } from "@/lib/ime";

/* ==========================================================================
   统一反馈层 —— 替代 alert / confirm / prompt
   --------------------------------------------------------------------------
   为什么必须替换掉原生弹窗：
   1. alert/confirm/prompt 是**同步阻塞**的，弹窗期间整个 JS 线程冻结 ——
      执行观测走的是 SSE 流式连接，一个弹窗就会把事件流卡住、心跳超时。
   2. 原生弹窗样式由浏览器决定，与本平台浅色/深色双主题完全割裂。
   3. 无法展示富内容：影响范围列表、实时校验、错误可复制都做不到。

   用法（命令式，写法跟原生 API 一样简单，但返回 Promise）：
     const { success, error, warn, confirm, prompt } = useFeedback();
     if (!(await confirm({ title: "删除？", danger: true }))) return;
     success("已删除");
   ========================================================================== */

export type ToastKind = "info" | "success" | "warn" | "error";

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
  /** 倒计时进度条用的出生时间 */
  bornAt: number;
  duration: number;
}

export interface ConfirmOptions {
  title: string;
  description?: string;
  /** 影响范围清单，例如 ["将删除 12 条记录", "847 个事件"] */
  details?: string[];
  confirmText?: string;
  cancelText?: string;
  /** 危险操作用红色主按钮 */
  danger?: boolean;
  /** 危险操作主按钮延迟可点（防误触连点），单位毫秒 */
  armDelayMs?: number;
}

export interface PromptOptions {
  title: string;
  description?: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  /** 输入框下方的说明文字 */
  hint?: string;
  /** 返回错误信息字符串表示校验失败；返回 null 表示通过 */
  validate?: (value: string) => string | null;
  confirmText?: string;
  danger?: boolean;
  multiline?: boolean;
}

interface FeedbackApi {
  toast: (kind: ToastKind, title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
  success: (title: string, message?: string) => void;
  warn: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  prompt: (o: PromptOptions) => Promise<string | null>;
}

const FeedbackCtx = createContext<FeedbackApi | null>(null);

export function useFeedback(): FeedbackApi {
  const ctx = useContext(FeedbackCtx);
  if (!ctx) throw new Error("useFeedback 必须在 <FeedbackProvider> 内使用");
  return ctx;
}

/* ------------------------------- 配色 ------------------------------- */
const KIND_STYLE: Record<ToastKind, { accent: string; icon: string }> = {
  info: { accent: "var(--color-info)", icon: "i" },
  success: { accent: "var(--color-ok)", icon: "✓" },
  warn: { accent: "var(--color-warn)", icon: "!" },
  error: { accent: "var(--color-err)", icon: "✕" },
};

/* --------------------------- 基础模态框 --------------------------- */
function Modal({
  onClose,
  children,
  labelledBy,
  width = 460,
}: {
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // ESC 关闭 + 焦点陷阱
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab" && ref.current) {
        const nodes = ref.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        const list = Array.from(nodes).filter((n) => !n.hasAttribute("disabled"));
        if (list.length === 0) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    // 自动聚焦第一个可交互元素
    const t = window.setTimeout(() => {
      const el = ref.current?.querySelector<HTMLElement>(
        'input, textarea, button[data-autofocus], button',
      );
      el?.focus();
    }, 30);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
      prev?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: "var(--color-overlay)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="card w-full max-h-[85vh] overflow-auto shadow-2xl"
        style={{ maxWidth: width }}
      >
        {children}
      </div>
    </div>
  );
}

/* ============================ Provider ============================ */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<
    (ConfirmOptions & { resolve: (v: boolean) => void }) | null
  >(null);
  const [promptState, setPromptState] = useState<
    (PromptOptions & { resolve: (v: string | null) => void }) | null
  >(null);
  const seq = useRef(0);

  /* -------------------------- Toast -------------------------- */
  const pushToast = useCallback(
    (kind: ToastKind, title: string, message?: string) => {
      const id = ++seq.current;
      const duration = kind === "error" ? 7000 : 4200;
      setToasts((prev) => [...prev, { id, kind, title, message, bornAt: Date.now(), duration }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, duration);
    },
    [],
  );

  const api = useMemo<FeedbackApi>(
    () => ({
      toast: pushToast,
      info: (t, m) => pushToast("info", t, m),
      success: (t, m) => pushToast("success", t, m),
      warn: (t, m) => pushToast("warn", t, m),
      error: (t, m) => pushToast("error", t, m),
      confirm: (o) => new Promise<boolean>((resolve) => setConfirmState({ ...o, resolve })),
      prompt: (o) => new Promise<string | null>((resolve) => setPromptState({ ...o, resolve })),
    }),
    [pushToast],
  );

  return (
    <FeedbackCtx.Provider value={api}>
      {children}

      {/* ------------------------- Toast 容器 ------------------------- */}
      <div className="fixed top-4 right-4 z-[200] flex flex-col gap-2 w-[360px] max-w-[calc(100vw-2rem)] pointer-events-none">
        {toasts.map((t) => {
          const s = KIND_STYLE[t.kind];
          return (
            <div
              key={t.id}
              role="status"
              className="card pointer-events-auto overflow-hidden shadow-lg"
              style={{
                borderLeft: `3px solid ${s.accent}`,
                animation: "toast-in 0.18s ease-out",
              }}
            >
              <div className="flex gap-2.5 p-3">
                <span
                  className="shrink-0 w-[18px] h-[18px] rounded-full flex items-center justify-center text-[11px] font-bold mt-[1px]"
                  style={{ background: s.accent, color: "var(--color-accent-fg)" }}
                >
                  {s.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium break-words">{t.title}</div>
                  {t.message && (
                    <div
                      className="text-[12px] mt-0.5 whitespace-pre-wrap break-words"
                      style={{ color: "var(--color-muted)" }}
                    >
                      {t.message}
                    </div>
                  )}
                </div>
                <button
                  aria-label="关闭"
                  className="shrink-0 text-[14px] leading-none px-1 opacity-50 hover:opacity-100"
                  onClick={() => setToasts((p) => p.filter((x) => x.id !== t.id))}
                >
                  ×
                </button>
              </div>
              {/* 剩余时间进度条 */}
              <div
                style={{
                  height: 2,
                  background: s.accent,
                  opacity: 0.35,
                  animation: `toast-bar ${t.duration}ms linear forwards`,
                }}
              />
            </div>
          );
        })}
      </div>

      {/* ------------------------- Confirm ------------------------- */}
      {confirmState && (
        <ConfirmDialog
          opt={confirmState}
          onDone={(ok) => {
            confirmState.resolve(ok);
            setConfirmState(null);
          }}
        />
      )}

      {/* -------------------------- Prompt -------------------------- */}
      {promptState && (
        <PromptDialog
          opt={promptState}
          onDone={(v) => {
            promptState.resolve(v);
            setPromptState(null);
          }}
        />
      )}
    </FeedbackCtx.Provider>
  );
}

/* ========================== ConfirmDialog ========================== */
function ConfirmDialog({
  opt,
  onDone,
}: {
  opt: ConfirmOptions;
  onDone: (ok: boolean) => void;
}) {
  const danger = !!opt.danger;
  const armDelay = danger ? (opt.armDelayMs ?? 0) : 0;
  const [armed, setArmed] = useState(armDelay === 0);

  useEffect(() => {
    if (armDelay <= 0) return;
    const t = window.setTimeout(() => setArmed(true), armDelay);
    return () => window.clearTimeout(t);
  }, [armDelay]);

  return (
    <Modal onClose={() => onDone(false)} labelledBy="cfm-title" width={opt.details?.length ? 520 : 440}>
      <div className="p-5">
        <h2 id="cfm-title" className="text-[15px] font-semibold mb-2">
          {opt.title}
        </h2>
        {opt.description && (
          <p className="text-[13px] leading-relaxed" style={{ color: "var(--color-muted)" }}>
            {opt.description}
          </p>
        )}

        {opt.details && opt.details.length > 0 && (
          <div
            className="mt-3 rounded-md p-3 text-[12.5px] mono"
            style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
          >
            {opt.details.map((d, i) => (
              <div key={i} className="flex gap-2">
                <span style={{ color: danger ? "var(--color-err)" : "var(--color-accent)" }}>·</span>
                <span className="break-all">{d}</span>
              </div>
            ))}
          </div>
        )}

        {danger && (
          <p className="mt-3 text-[12.5px]" style={{ color: "var(--color-err)" }}>
            此操作不可撤销。
          </p>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button className="btn" onClick={() => onDone(false)}>
            {opt.cancelText ?? "取消"}
          </button>
          <button
            data-autofocus
            className="btn"
            disabled={!armed}
            style={
              danger
                ? {
                    background: "var(--color-err)",
                    borderColor: "var(--color-err)",
                    color: "#fff",
                    fontWeight: 600,
                  }
                : {
                    background: "var(--color-accent)",
                    borderColor: "var(--color-accent)",
                    color: "var(--color-accent-fg)",
                    fontWeight: 600,
                  }
            }
            onClick={() => onDone(true)}
          >
            {!armed ? "请稍候…" : (opt.confirmText ?? "确认")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ========================== PromptDialog ========================== */
function PromptDialog({
  opt,
  onDone,
}: {
  opt: PromptOptions;
  onDone: (v: string | null) => void;
}) {
  const [value, setValue] = useState(opt.defaultValue ?? "");
  const [err, setErr] = useState<string | null>(null);
  /** 输入法守卫：单行输入框里回车提交，中文组字中的回车是选字（别提交） */
  const ime = useImeGuard();

  const check = (v: string) => (opt.validate ? opt.validate(v) : null);
  const liveErr = check(value);
  const run = () => {
    const e = check(value);
    if (e) {
      setErr(e);
      return;
    }
    onDone(value);
  };

  const inputCls = "input mono text-[12.5px]";
  const inputStyle =
    liveErr || err
      ? { borderColor: "var(--color-err)" }
      : undefined;

  return (
    <Modal onClose={() => onDone(null)} labelledBy="prm-title" width={560}>
      <div className="p-5">
        <h2 id="prm-title" className="text-[15px] font-semibold mb-2">
          {opt.title}
        </h2>
        {opt.description && (
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--color-muted)" }}>
            {opt.description}
          </p>
        )}

        {opt.label && <label className="label mt-3">{opt.label}</label>}
        {opt.multiline ? (
          <textarea
            data-autofocus
            className={inputCls}
            style={{ ...inputStyle, minHeight: 120, marginTop: opt.label ? 0 : 12 }}
            rows={6}
            placeholder={opt.placeholder}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setErr(null);
            }}
          />
        ) : (
          <input
            data-autofocus
            className={inputCls}
            style={{ ...inputStyle, marginTop: opt.label ? 0 : 12 }}
            placeholder={opt.placeholder}
            value={value}
            {...ime.props}
            onChange={(e) => {
              setValue(e.target.value);
              setErr(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (ime.blocked(e)) return;
                e.preventDefault();
                run();
              }
            }}
          />
        )}

        {/* 校验反馈：实时红字，不用弹窗 */}
        {(liveErr || err) && (
          <p className="mt-1.5 text-[12px]" style={{ color: "var(--color-err)" }}>
            {liveErr ?? err}
          </p>
        )}
        {!liveErr && opt.hint && (
          <p className="mt-1.5 text-[12px]" style={{ color: "var(--color-muted)" }}>
            {opt.hint}
          </p>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button className="btn" onClick={() => onDone(null)}>
            取消
          </button>
          <button
            className="btn"
            disabled={!!liveErr || value.length === 0}
            style={
              opt.danger
                ? { background: "var(--color-err)", borderColor: "var(--color-err)", color: "#fff", fontWeight: 600 }
                : {
                    background: "var(--color-accent)",
                    borderColor: "var(--color-accent)",
                    color: "var(--color-accent-fg)",
                    fontWeight: 600,
                  }
            }
            onClick={run}
          >
            {opt.confirmText ?? "确定"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
