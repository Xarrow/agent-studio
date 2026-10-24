"use client";

/**
 * 输入区工具栏上的「记忆」入口。
 *
 * 两件事都在这里做完，不用跳记忆页：
 *   · 勾一下 = 这条记忆生效 / 失效（status: active / disabled）
 *   · 点内容 = 把这段文案填进输入框（想让它照着做的时候）
 *
 * 不做新建/编辑（那是记忆页的事）—— 两处都能改只会让人猜哪边才是真的。
 */

import { useCallback, useEffect, useState } from "react";
import type { Memory, MemoryStatus } from "@/lib/types";
import { api } from "@/lib/api";
import { Sheet } from "./ui/Sheet";

export function MemoryPicker({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPick: (text: string) => void;
}) {
  const [items, setItems] = useState<Memory[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  const load = useCallback((kw?: string) => {
    setBusy(true);
    void api
      .memories({ q: kw?.trim() || undefined })
      .then((r) => setItems(Array.isArray(r) ? r : []))
      .catch(() => setItems([]))
      .finally(() => setBusy(false));
  }, []);

  // 挂载就拉一次：打开面板时数据已经在，不会先空再填（那 300ms 很显眼）
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (open) load(q); // 打开时静默刷新，旧数据先显示
  }, [open, load]);

  // 输入停下来再查，别每个字都打一次接口
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => load(q), 260);
    return () => clearTimeout(t);
  }, [q, open, load]);

  const toggle = async (m: Memory) => {
    if (toggling) return;
    setToggling(m.id);
    const next: MemoryStatus = m.status === "active" ? "archived" : "active";
    // 先就地改，失败再退回 —— 勾选要跟手，等一个往返才亮会显得卡
    setItems((cur) => cur.map((x) => (x.id === m.id ? { ...x, status: next } : x)));
    try {
      await api.updateMemory(m.id, { status: next });
    } catch {
      setItems((cur) => cur.map((x) => (x.id === m.id ? { ...x, status: m.status } : x)));
    } finally {
      setToggling(null);
    }
  };

  const activeCount = items.filter((m) => m.status === "active").length;

  return (
    <Sheet
      open={open}
      onClose={() => onOpenChange(false)}
      title="记忆"
      hint="勾上生效，点内容填进输入框"
      extra={
        <span className="text-[11px] tabular-nums" style={{ color: "var(--color-muted)" }}>
          {busy ? "…" : `${activeCount} / ${items.length}`}
        </span>
      }
      maxH="84vh"
      width={400}
    >
      <div className="px-3.5 pb-2">
        <input
          className="input h-9 w-full text-[13px]"
          value={q}
          placeholder="搜内容，比如：部署 端口 偏好"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {items.length === 0 ? (
        <p className="px-3.5 py-8 text-center text-[12.5px]" style={{ color: "var(--color-muted)" }}>
          {busy ? "正在找…" : q.trim() ? "没有匹配的记忆" : "还没有记忆"}
        </p>
      ) : (
        <div className="pb-2">
          {items.map((m) => {
            const on = m.status === "active";
            return (
              <div
                key={m.id}
                className="flex items-start gap-2.5 px-3.5 py-2 hover:bg-[var(--color-surface-2)] transition-colors"
              >
                {/* 外层 36×36 是点按区（[data-tap] 在手机端会把按钮兜到 36 高，
                    所以框必须画在里面那层，否则 18×18 的方框会被撑成长条）。 */}
                <button
                  type="button"
                  data-tap
                  aria-pressed={on}
                  title={on ? "点一下这条就不生效了" : "点一下让它生效"}
                  onClick={() => void toggle(m)}
                  className="shrink-0 -ml-1.5 -my-1.5 w-9 h-9 grid place-items-center rounded-lg"
                  style={{ opacity: toggling === m.id ? 0.5 : 1 }}
                >
                  <span
                    className="w-[18px] h-[18px] grid place-items-center rounded-[5px] border transition-colors"
                    style={{
                      borderColor: on ? "var(--color-accent)" : "var(--color-border-strong, var(--color-border))",
                      background: on ? "var(--color-accent)" : "transparent",
                    }}
                  >
                    {on && (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    onPick(m.content);
                    onOpenChange(false);
                  }}
                  className="min-w-0 flex-1 text-left"
                  title="填进输入框"
                >
                  <span
                    className="text-[12px] leading-[1.5] line-clamp-2"
                    style={{ color: on ? "var(--color-text)" : "var(--color-muted)" }}
                  >
                    {m.content}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-[10.5px]" style={{ color: "var(--color-muted)" }}>
                    <span className="px-1.5 py-px rounded" style={{ background: "var(--color-surface-2)" }}>
                      {m.layer === "user" ? "关于你" : "助手笔记"}
                    </span>
                    {m.pinned === 1 && <span>常驻</span>}
                    {!on && <span style={{ color: "var(--color-err)" }}>已停用</span>}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}
