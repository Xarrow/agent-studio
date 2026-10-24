"use client";

/**
 * 输入框上方那排「快速标签」。
 *
 * 反复说同一句话（「询问是否完成」「先给结论」）不该每次都打字。点一下就把
 * 文字放进输入框 —— 只是填进去，不自动发，还能改。
 *
 * 标签存在后端的 app_setting（键 chat_quick_tags），换设备还在；点末尾的 ⋯
 * 就地增删改，存完立刻生效。
 */

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { isImeEvent } from "@/lib/ime";

const MAX = 10;

/**
 * `prefix` 渲染在这一行最左边 —— 输入框上方只留一行 chips：
 * 「N 个文件」+ 常说的话。以前文件条自己占一整行 46px，
 * 手机上输入区要吃掉屏幕 1/4，现在共用一行。
 */
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

  if (tags.length === 0 && !open) {
    // 没配过标签时也留一个入口，否则永远打不开编辑器
    return (
      <div className="max-w-3xl mx-auto flex items-center gap-1.5">
        {prefix}
        <span className="flex-1" />
        <button
          data-tap
          onClick={openEditor}
          className="text-[11.5px] px-2 h-6 rounded-md hover:bg-[var(--color-surface-2)]"
          style={{ color: "var(--color-muted)" }}
        >
          + 快捷标签
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative max-w-3xl mx-auto mb-1.5">
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
        {prefix}
        {tags.map((t) => (
          <button
            key={t}
            data-tap
            onClick={() => onPick(t)}
            className="shrink-0 h-6 px-2 rounded-full border text-[11.5px] transition-colors hover:bg-[var(--color-surface-2)]"
            style={{ borderColor: "var(--color-border)", color: "var(--color-text)" }}
            title={`把「${t}」填进输入框`}
          >
            {t}
          </button>
        ))}
        <button
          data-tap
          title="管理快捷标签"
          onClick={() => (open ? setOpen(false) : openEditor())}
          className="shrink-0 w-6 h-6 grid place-items-center rounded-full hover:bg-[var(--color-surface-2)]"
          style={{ color: "var(--color-muted)" }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="5" cy="12" r="1" />
            <circle cx="12" cy="12" r="1" />
            <circle cx="19" cy="12" r="1" />
          </svg>
        </button>
      </div>

      {open && (
        <div
          className="absolute left-0 right-0 z-50 rounded-xl border overflow-hidden flex flex-col"
          style={{
            background: "var(--color-surface)",
            borderColor: "var(--color-border)",
            boxShadow: "0 14px 40px rgba(15,23,42,.18)",
            bottom: "calc(100% + 6px)",
          }}
        >
          <div className="flex items-center justify-between px-2.5 h-9 border-b border-[var(--color-border)] shrink-0">
            <span className="text-[11.5px] font-medium" style={{ color: "var(--color-muted)" }}>
              快捷标签 · 点了就填进输入框
            </span>
            <button
              data-tap
              className="text-[11.5px] px-1.5 h-6 rounded"
              style={{ color: "var(--color-muted)" }}
              onClick={() => setOpen(false)}
            >
              关闭
            </button>
          </div>

          <div className="p-2 space-y-1.5 max-h-[42vh] overflow-auto">
            {draft.length === 0 && (
              <p className="text-[12px] py-3 text-center" style={{ color: "var(--color-muted)" }}>
                还没有标签
              </p>
            )}
            {draft.map((t, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  className="input h-8 text-[12.5px]"
                  value={t}
                  placeholder="比如：询问是否完成"
                  onChange={(e) =>
                    setDraft((d) => d.map((x, j) => (j === i ? e.target.value : x)))
                  }
                  onKeyDown={(e) => {
                    if (isImeEvent(e)) return; // 中文组字中的回车是选字，不是加一行
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (i === draft.length - 1 && draft.length < MAX) {
                        setDraft((d) => [...d, ""]);
                      }
                    }
                  }}
                />
                <button
                  data-tap
                  title="删掉这条"
                  onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
                  className="shrink-0 w-8 h-8 grid place-items-center rounded-md hover:bg-[var(--color-surface-2)]"
                  style={{ color: "var(--color-muted)" }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                    <path d="M5 12h14" />
                  </svg>
                </button>
              </div>
            ))}
            {draft.length < MAX && (
              <button
                data-tap
                className="text-[12px] px-1.5 h-7 rounded-md hover:bg-[var(--color-surface-2)]"
                style={{ color: "var(--color-accent)" }}
                onClick={() => setDraft((d) => [...d, ""])}
              >
                + 添加一条
              </button>
            )}
            {err && (
              <p className="text-[11.5px] px-1" style={{ color: "var(--color-danger, #b91c1c)" }}>
                {err}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-2.5 h-10 border-t border-[var(--color-border)] shrink-0">
            <button
              data-tap
              className="btn btn-sm"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              取消
            </button>
            <button data-tap className="btn btn-sm btn-primary" onClick={() => void save()} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
