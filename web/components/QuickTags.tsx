"use client";

/**
 * 输入框上方那排「快捷标签」。
 *
 * 反复说同一句话（「询问是否完成」「先给结论」）不该每次都打字。点一下就把
 * 文字放进输入框 —— 只是填进去，不自动发，还能改。
 *
 * 标签存在后端的 app_setting（键 chat_quick_tags），换设备还在；点末尾的 ⋯
 * 就地增删改，存完立刻生效。
 *
 * 布局规则（2026-10 重排）：这一行放两类不同性质的东西 —— 左边 prefix 是「对象」
 * （这次产出的文件），右边是「动作」（点了会填进输入框）。它们不该长得一样：
 * 对象用 accent 淡色 + 数字，动作是无边框的浅底 pill，中间一条竖线分开。
 * 尺寸 32 视觉 / 36 触控，比输入框的 44 矮一档 —— 辅助行不抢主角。
 */

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { isImeEvent } from "@/lib/ime";

const MAX = 10;

export function QuickTags({ onPick, prefix }: { onPick: (text: string) => void; prefix?: React.ReactNode }) {
  const [tags, setTags] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void api
      .appSetting("chat_quick_tags")
      .then((r) => setTags(Array.isArray(r.value) ? (r.value as string[]) : []))
      .catch(() => setTags([]));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const el = rootRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const openEditor = () => {
    setDraft(tags.length ? [...tags] : [""]);
    setErr("");
    setOpen(true);
  };

  const save = async () => {
    const clean = draft.map((t) => t.trim()).filter(Boolean).slice(0, MAX);
    setSaving(true);
    setErr("");
    try {
      await api.setAppSetting("chat_quick_tags", clean);
      setTags(clean);
      setOpen(false);
    } catch {
      setErr("没存上，再试一次");
    } finally {
      setSaving(false);
    }
  };

  /* ── 编辑面板 ──────────────────────────────────────────────
     手机：从底部升起的 sheet（拇指够得到，键弹起也不跑）
     桌面：贴在「⋯」上方的小卡片。 */
  const editor = open && (
    <>
      <div
        className="lg:hidden fixed inset-0 z-[59]"
        style={{ background: "rgba(15,23,42,.32)" }}
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-label="快捷问句"
        className="sheet-up z-[60] flex flex-col overflow-hidden max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:rounded-t-[20px] max-lg:max-h-[76vh] lg:absolute lg:right-0 lg:bottom-[calc(100%+8px)] lg:w-[360px] lg:rounded-xl"
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          boxShadow: "0 -10px 44px rgba(15,23,42,.25)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        <div className="shrink-0 px-4 pt-3 pb-2.5 border-b border-[var(--color-border)] flex items-baseline gap-2">
          <span className="text-[14px] font-semibold">快捷问句</span>
          <span className="text-[11.5px] min-w-0 truncate" style={{ color: "var(--color-muted)" }}>
            点了填进输入框，不直接发送
          </span>
        </div>

        <div className="flex-1 min-h-0 overflow-auto px-3 py-2.5 space-y-2">
          {draft.length === 0 && (
            <p className="text-[12.5px] py-6 text-center" style={{ color: "var(--color-muted)" }}>
              还没有，加一条试试
            </p>
          )}
          {draft.map((t, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                className="input h-11 text-[13.5px] flex-1 min-w-0"
                value={t}
                placeholder="比如：询问是否完成"
                onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? e.target.value : x)))}
                onKeyDown={(e) => {
                  if (isImeEvent(e)) return; // 中文组字中的回车是选字，不是加一行
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (i === draft.length - 1 && draft.length < MAX) setDraft((d) => [...d, ""]);
                  }
                }}
              />
              <button
                data-tap
                title="删掉这条"
                onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
                className="shrink-0 w-9 h-11 grid place-items-center rounded-lg hover:bg-[var(--color-surface-2)]"
                style={{ color: "var(--color-muted)" }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M5 12h14" />
                </svg>
              </button>
            </div>
          ))}
          {draft.length < MAX && (
            <button
              data-tap
              className="inline-flex items-center gap-1 text-[12.5px] px-2 h-9 rounded-lg hover:bg-[var(--color-surface-2)]"
              style={{ color: "var(--color-accent)" }}
              onClick={() => setDraft((d) => [...d, ""])}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              添加一条
            </button>
          )}
          {err && (
            <p className="text-[12px] px-1" style={{ color: "var(--color-danger, #b91c1c)" }}>
              {err}
            </p>
          )}
        </div>

        <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-2.5 border-t border-[var(--color-border)]">
          <span className="text-[11.5px] tabular-nums" style={{ color: "var(--color-muted)" }}>
            {draft.filter((t) => t.trim()).length} / {MAX}
          </span>
          <div className="flex items-center gap-2">
            <button
              data-tap
              className="h-9 px-3 rounded-lg text-[13px] hover:bg-[var(--color-surface-2)]"
              style={{ color: "var(--color-muted)" }}
              onClick={() => setOpen(false)}
            >
              取消
            </button>
            <button
              data-tap
              disabled={saving}
              className="h-9 px-4 rounded-lg text-[13px] font-medium disabled:opacity-50"
              style={{ background: "var(--color-accent)", color: "#fff" }}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </>
  );

  /* 一条都没有时只留右上角一个入口 —— 这行本身不该占位 */
  if (tags.length === 0 && !open) {
    return (
      <div className="max-w-3xl mx-auto flex items-center gap-1.5">
        {prefix}
        <span className="flex-1" />
        <button
          data-tap
          onClick={openEditor}
          className="shrink-0 h-8 px-2 rounded-lg text-[12px] hover:bg-[var(--color-surface-2)]"
          style={{ color: "var(--color-muted)" }}
        >
          快捷问句
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative max-w-3xl mx-auto">
      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
        {prefix}
        {prefix && tags.length > 0 && (
          <span className="shrink-0 w-px h-4 rounded" style={{ background: "var(--color-border)" }} aria-hidden="true" />
        )}
        {tags.map((t) => (
          <button
            key={t}
            data-tap
            onClick={() => onPick(t)}
            className="shrink-0 inline-flex items-center h-8 px-2.5 rounded-lg text-[12.5px] transition-colors hover:brightness-[0.97]"
            style={{ background: "var(--color-surface-2)", color: "var(--color-text)" }}
            title={`把「${t}」填进输入框`}
          >
            {t}
          </button>
        ))}
        <button
          data-tap
          title="管理快捷问句"
          onClick={() => (open ? setOpen(false) : openEditor())}
          className="shrink-0 w-8 h-8 grid place-items-center rounded-lg hover:bg-[var(--color-surface-2)]"
          style={{ color: "var(--color-muted)" }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <circle cx="5" cy="12" r="1" />
            <circle cx="12" cy="12" r="1" />
            <circle cx="19" cy="12" r="1" />
          </svg>
        </button>
      </div>
      {editor}
    </div>
  );
}
