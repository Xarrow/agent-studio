"use client";

/**
 * 输入区工具栏上的「记忆」入口。
 *
 * 对话中想起「上次说过的那条约定」时，以前得离开对话去记忆页翻，
 * 找到了也只能靠自己复述。这里把记忆搬到手边：搜一下、点一条，
 * 内容直接填进输入框（不自动发，还能改）。
 *
 * 不做管理（停用/删除/编辑）—— 那是记忆页的事，两处都能改只会让人猜
 * 哪边才是真的。
 */

import { useCallback, useEffect, useState } from "react";
import type { Memory } from "@/lib/types";
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

  const load = useCallback((kw?: string) => {
    setBusy(true);
    void api
      .memories({ status: "active", q: kw?.trim() || undefined })
      .then((r) => setItems(Array.isArray(r) ? r : []))
      .catch(() => setItems([]))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // 输入停下来再查，别每个字都打一次接口
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => load(q), 260);
    return () => clearTimeout(t);
  }, [q, open, load]);

  return (
    <Sheet
      open={open}
      onClose={() => onOpenChange(false)}
      title="记忆"
      hint="点一条填进输入框"
      extra={
        <span className="text-[11px] tabular-nums" style={{ color: "var(--color-muted)" }}>
          {busy ? "…" : items.length}
        </span>
      }
      maxH="76vh"
      width={380}
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
          {items.map((m) => (
            <button
              key={m.id}
              data-tap
              onClick={() => {
                onPick(m.content);
                onOpenChange(false);
              }}
              className="w-full text-left px-3.5 py-2.5 hover:bg-[var(--color-surface-2)] transition-colors"
            >
              <span
                className="block text-[12px] leading-[1.55] line-clamp-3"
                style={{ color: "var(--color-text)" }}
              >
                {m.content}
              </span>
              <span className="mt-1 flex items-center gap-1.5 text-[10.5px]" style={{ color: "var(--color-muted)" }}>
                <span
                  className="px-1.5 py-px rounded"
                  style={{ background: "var(--color-surface-2)" }}
                >
                  {m.layer === "user" ? "关于你" : "助手笔记"}
                </span>
                {m.agent_name && <span className="truncate">{m.agent_name}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}
