"use client";

/**
 * 输入区工具行上的「工具」入口。
 *
 * 和「技能」是同一件事的另一半：技能是做法（SKILL.md），工具是能力（函数）。
 * 以前挂工具只能进助手配置页翻 36 个条目，对话中想临时加一个得离开这一屏。
 *
 * 只做勾选/取消（写回 definition.tools，和配置页同一条写入路径），
 * 不新建工具 —— 那是「工具」页的事。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent, Tool } from "@/lib/types";
import { api } from "@/lib/api";
import { Sheet } from "./ui/Sheet";

const KIND_LABEL: Record<string, string> = {
  native: "平台",
  builtin: "内置",
  http: "HTTP",
  code: "代码",
  fork: "分身",
  a2a: "远程",
};

export function ToolPicker({
  agent,
  onChanged,
  open,
  onOpenChange,
}: {
  agent: Agent | undefined;
  onChanged: () => void;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [all, setAll] = useState<Tool[]>([]);
  const [q, setQ] = useState("");
  const [override, setOverride] = useState<string[] | null>(null);

  const load = useCallback(() => {
    void api
      .tools()
      .then((list) => setAll(list))
      .catch(() => setAll([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const serverIds = useMemo(
    () => (agent?.definition?.tools ?? []).map((t) => t.ref),
    [agent],
  );
  const mountedIds = override ?? serverIds;
  const mounted = useMemo(() => new Set(mountedIds), [mountedIds]);

  useEffect(() => {
    if (override && serverIds.join(",") === override.join(",")) setOverride(null);
  }, [serverIds, override]);

  const toggle = async (id: string) => {
    if (!agent) return;
    const before = mountedIds;
    const next = mounted.has(id) ? before.filter((x) => x !== id) : [...before, id];
    setOverride(next);
    try {
      await api.updateAgent(agent.id, {
        definition: {
          ...agent.definition,
          // 和配置页一样：留下的一律 enabled（这个字段目前没别的地方在改）
          tools: next.map((r) => ({ ref: r, enabled: true })),
        },
      });
      onChanged();
    } catch {
      setOverride(before);
    }
  };

  /* 排序在打开那一刻定下来，之后勾选不再重排 ——
     否则点一行、它立刻跳到顶部，下一个点击就点错（实测勾两个变成勾了三个）。 */
  const orderRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (open) orderRef.current = new Set(mountedIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const base = kw
      ? all.filter(
          (t) =>
            t.name.toLowerCase().includes(kw) ||
            (t.description || "").toLowerCase().includes(kw),
        )
      : all;
    const snap = orderRef.current;
    return [...base].sort((a, b) => Number(snap.has(b.id)) - Number(snap.has(a.id)));
  }, [all, q]);

  return (
    <Sheet
      open={open}
      onClose={() => onOpenChange(false)}
      title="工具"
      hint="勾上就能用"
      extra={
        <span className="text-[11px] tabular-nums" style={{ color: "var(--color-muted)" }}>
          已挂 {mountedIds.length} / 共 {all.length}
        </span>
      }
      maxH="84vh"
      width={400}
    >
      <div className="px-3.5 pb-2">
        <input
          className="input h-9 w-full text-[13px]"
          value={q}
          placeholder="搜工具，比如：python 浏览器 文件"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {list.length === 0 ? (
        <p className="px-3.5 py-8 text-center text-[12.5px]" style={{ color: "var(--color-muted)" }}>
          {all.length === 0 ? "还没有工具，去「工具」页建一个" : "没有匹配的工具"}
        </p>
      ) : (
        <div className="pb-2">
          {list.map((t) => {
            const on = mounted.has(t.id);
            return (
              <button
                key={t.id}
                data-tap
                aria-pressed={on}
                onClick={() => void toggle(t.id)}
                className="w-full text-left px-3.5 py-2 flex items-start gap-2.5 hover:bg-[var(--color-surface-2)] transition-colors"
              >
                <span
                  className="shrink-0 mt-0.5 w-[18px] h-[18px] grid place-items-center rounded-[5px] border transition-colors"
                  style={{
                    borderColor: on ? "var(--color-accent)" : "var(--color-border-strong, var(--color-border))",
                    background: on ? "var(--color-accent)" : "transparent",
                  }}
                  aria-hidden="true"
                >
                  {on && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-[13px] font-medium truncate">{t.name}</span>
                    <span
                      className="shrink-0 text-[10px] px-1 rounded"
                      style={{ background: "var(--color-surface-2)", color: "var(--color-muted)" }}
                    >
                      {KIND_LABEL[t.kind] ?? t.kind}
                    </span>
                  </span>
                  {t.description && (
                    <span
                      className="text-[11.5px] leading-[1.45] mt-0.5 line-clamp-1"
                      style={{ color: "var(--color-muted)" }}
                    >
                      {t.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}
