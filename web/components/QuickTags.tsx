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
  /* 已经确定的标签放 draft（只能删，不能就地改字），正在打的那一条放 newTag。
     一行一个输入框的写法每加一条就多一行输入框＋删除键，条目一多整块变表格；
     标签流更像「我常说的几句话」，扫一眼就知道有哪些。 */
  const [newTag, setNewTag] = useState("");
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
    setDraft([...tags]);
    setNewTag("");
    setErr("");
    setOpen(true);
  };

  const addTag = () => {
    const t = newTag.trim();
    if (!t || draft.length >= MAX) return;
    setDraft((d) => [...d, t]);
    setNewTag("");
  };

  const save = async () => {
    const pending = newTag.trim();
    const clean = [...draft, ...(pending ? [pending] : [])]
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, MAX);
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
          className="chip-thin text-[12px] px-2.5 h-7 rounded-md hover:bg-[var(--color-surface-2)]"
          style={{ color: "var(--color-muted)" }}
        >
          + 快捷标签
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative max-w-3xl mx-auto mb-1.5">
      {/* flex-wrap 而不是横向滚动：手机上"这排还能往右滑"几乎没人会想到去试，
          多出来的问句就等于不存在。换行最多两行，再多的收进 ⋯ 管理面板。 */}
      <div className="flex flex-wrap items-center gap-2 overflow-hidden" style={{ maxHeight: 68 }}>
        {prefix}
        {tags.map((t) => (
          <button
            key={t}
            data-tap
            onClick={() => onPick(t)}
            className="chip-thin shrink-0 inline-flex items-center h-7 px-2.5 rounded-full border text-[12px] transition-colors hover:bg-[var(--color-surface-2)]"
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
          className="chip-thin shrink-0 w-7 h-7 grid place-items-center rounded-full hover:bg-[var(--color-surface-2)]"
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
        <>
          {/* 手机：贴底抽屉（拇指够得到）；桌面：锚在「⋯」上方的小卡片 */}
          <div
            className="lg:hidden fixed inset-0 z-[59] veil-in"
            style={{ background: "rgba(15,23,42,.32)" }}
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-label="快捷问句"
            className="sheet-up z-[60] flex flex-col overflow-hidden max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:rounded-t-[18px] max-lg:max-h-[72vh] lg:absolute lg:right-0 lg:bottom-[calc(100%+8px)] lg:w-[340px] lg:rounded-xl"
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              boxShadow: "0 -8px 40px rgba(15,23,42,.22)",
              paddingBottom: "env(safe-area-inset-bottom)",
            }}
          >
            <div className="shrink-0 px-3.5 pt-3 pb-2 flex items-baseline gap-2">
              <span className="text-[13.5px] font-semibold">快捷问句</span>
              <span className="text-[11px] min-w-0 truncate" style={{ color: "var(--color-muted)" }}>
                点了填进输入框
              </span>
              <span className="ml-auto text-[11px] tabular-nums" style={{ color: "var(--color-muted)" }}>
                {draft.length}/{MAX}
              </span>
            </div>

            {/* 标签流：已确定的都在这里，点 ✕ 删。没有「每行一个输入框」那种表格感 */}
            <div className="px-3.5 pb-2.5 min-h-[44px] max-h-[38vh] overflow-auto">
              {draft.length === 0 ? (
                <p className="text-[12px] py-3" style={{ color: "var(--color-muted)" }}>
                  还没有，在下面加一条试试
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {draft.map((t, i) => (
                    <span
                      key={`${t}-${i}`}
                      className="inline-flex items-center gap-1 h-8 pl-2.5 pr-1 rounded-lg text-[12.5px]"
                      style={{ background: "var(--color-surface-2)", color: "var(--color-text)" }}
                    >
                      {t}
                      <button
                        data-tap
                        title={`删掉「${t}」`}
                        onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
                        className="shrink-0 w-6 h-6 grid place-items-center rounded-md hover:bg-[color-mix(in_srgb,var(--color-text)_8%,transparent)]"
                        style={{ color: "var(--color-muted)" }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                          <path d="M5 12h14" />
                        </svg>
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* 添加：一个输入框 + 一个＋，回车即加 —— 不再每行都配一个删除键 */}
            <div className="px-3.5 pb-3 flex items-center gap-1.5">
              <input
                className="input h-10 flex-1 min-w-0 text-[13.5px]"
                value={newTag}
                placeholder={draft.length >= MAX ? `最多 ${MAX} 条` : "添加一条，回车确认"}
                disabled={draft.length >= MAX}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => {
                  if (isImeEvent(e)) return; // 中文组字中的回车是选字，不是加一条
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag();
                  }
                }}
              />
              <button
                data-tap
                title="加上这一条"
                disabled={!newTag.trim() || draft.length >= MAX}
                onClick={addTag}
                className="shrink-0 w-10 h-10 grid place-items-center rounded-lg disabled:opacity-40"
                style={{ background: "var(--color-accent)", color: "#fff" }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>

            {err && (
              <p className="px-3.5 pb-2 text-[11.5px]" style={{ color: "var(--color-err, #b91c1c)" }}>
                {err}
              </p>
            )}

            <div className="shrink-0 flex items-center justify-end gap-1.5 px-3.5 py-2.5 border-t border-[var(--color-border)]">
              <button
                data-tap
                className="h-9 px-3 rounded-lg text-[13px] hover:bg-[var(--color-surface-2)]"
                style={{ color: "var(--color-muted)" }}
                onClick={() => setOpen(false)}
                disabled={saving}
              >
                取消
              </button>
              <button
                data-tap
                className="h-9 px-4 rounded-lg text-[13px] font-medium disabled:opacity-50"
                style={{ background: "var(--color-accent)", color: "#fff" }}
                onClick={() => void save()}
                disabled={saving}
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
