"use client";

/**
 * 侧栏里、助手身份块下面的「技能」一行。
 *
 * 以前挂技能只有一条路：点开配置对话框 → 找到技能区 → 勾 → 保存。为了一个
 * 勾选走完整条配置流程，代价太大。这里把它变成常驻的一行：当前挂着哪些一眼
 * 能看到，点「＋」直接在原地勾选/取消，改完立刻生效（写回 definition.skills，
 * 后端同步 AgentSkill 关联表 —— 和配置对话框是同一条写入路径）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent, Skill } from "@/lib/types";
import { api } from "@/lib/api";

export function SkillsStrip({
  agent,
  onChanged,
}: {
  agent: Agent | undefined;
  onChanged: () => void;
}) {
  const [all, setAll] = useState<Skill[]>([]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    void api
      .skills()
      .then((list) => setAll(list.filter((s) => (s.state ?? "active") !== "archived")))
      .catch(() => setAll([]));
  }, []);

  // 第一次就拉一次（要显示名字），之后每次打开刷新（技能库会变）
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!open) return;
    load();
    const onDoc = (e: MouseEvent) => {
      const el = rootRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, load]);

  const mountedIds = useMemo(
    () => (agent?.definition?.skills ?? []).map((s) => s.ref),
    [agent],
  );
  const mounted = useMemo(() => new Set(mountedIds), [mountedIds]);
  const mountedSkills = useMemo(
    () => all.filter((s) => mounted.has(s.id)),
    [all, mounted],
  );

  const toggle = async (id: string) => {
    if (!agent || busyId) return;
    setBusyId(id);
    const has = mounted.has(id);
    const next = has ? mountedIds.filter((x) => x !== id) : [...mountedIds, id];
    try {
      await api.updateAgent(agent.id, {
        definition: { ...agent.definition, skills: next.map((r) => ({ ref: r })) },
      });
      onChanged();
    } catch {
      /* 失败就保持原样，下一次打开还能重试 */
    } finally {
      setBusyId(null);
    }
  };

  if (!agent) return null;

  const shown = mountedSkills.slice(0, 2);
  // 「+N」按真实的挂载数算：技能清单还没拉回来时，别把已挂的显示成没挂
  const rest = Math.max(0, mountedIds.length - shown.length);
  const list = q.trim()
    ? all.filter(
        (s) =>
          s.name.toLowerCase().includes(q.trim().toLowerCase()) ||
          (s.description || "").toLowerCase().includes(q.trim().toLowerCase()),
      )
    : all;

  return (
    <div ref={rootRef} className="relative px-1.5 pt-1 pb-1">
      <div className="flex items-center gap-1.5 min-w-0">
        <span
          className="shrink-0 text-[11px]"
          style={{ color: "var(--color-muted)" }}
          title="这个助手挂载的技能"
        >
          技能
        </span>
        <div className="flex items-center gap-1 min-w-0 overflow-hidden">
          {shown.map((s) => (
            <button
              key={s.id}
              data-tap
              title={s.description || s.name}
              className="shrink-0 max-w-[92px] truncate rounded-md px-1.5 h-[22px] text-[11px] transition-colors hover:brightness-95"
              style={{
                background: "color-mix(in srgb, var(--color-accent) 9%, transparent)",
                color: "var(--color-accent)",
              }}
              onClick={() => setOpen(true)}
            >
              {s.name}
            </button>
          ))}
          {rest > 0 && (
            <button
              data-tap
              className="shrink-0 rounded-md px-1.5 h-[22px] text-[11px]"
              style={{ background: "var(--color-surface-2)", color: "var(--color-muted)" }}
              onClick={() => setOpen(true)}
            >
              +{rest}
            </button>
          )}
          {mountedSkills.length === 0 && mountedIds.length > 0 && (
            <span className="shrink-0 text-[11px]" style={{ color: "var(--color-muted)" }}>
              已挂 {mountedIds.length} 个
            </span>
          )}
          {mountedIds.length === 0 && (
            <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>
              未挂载
            </span>
          )}
        </div>
        <button
          data-tap
          title="选择技能"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto shrink-0 w-6 h-6 grid place-items-center rounded-md hover:bg-[var(--color-surface-2)]"
          style={{ color: "var(--color-muted)" }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      {open && (
        <div
          className="absolute left-1 z-50 w-[300px] rounded-xl border overflow-hidden flex flex-col"
          style={{
            background: "var(--color-surface)",
            borderColor: "var(--color-border)",
            boxShadow: "0 14px 40px rgba(15,23,42,.18)",
            top: "calc(100% + 6px)",
          }}
        >
          <div className="flex items-center justify-between px-2.5 h-9 border-b border-[var(--color-border)] shrink-0">
            <span className="text-[11.5px] font-medium" style={{ color: "var(--color-muted)" }}>
              技能 · 已挂 {mountedIds.length}
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
          {all.length > 8 && (
            <div className="px-2 pt-2 shrink-0">
              <input
                className="input h-8 text-[12.5px]"
                placeholder="搜索技能"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          )}
          <div className="overflow-auto py-1" style={{ maxHeight: "min(50vh, 340px)" }}>
            {list.length === 0 && (
              <div className="px-3 py-5 text-center text-[12px]" style={{ color: "var(--color-muted)" }}>
                {all.length === 0 ? "技能库是空的" : `没找到「${q}」`}
              </div>
            )}
            {list.map((s) => {
              const on = mounted.has(s.id);
              return (
                <button
                  key={s.id}
                  data-tap
                  disabled={busyId === s.id}
                  onClick={() => void toggle(s.id)}
                  className="w-full text-left flex items-start gap-2 px-2 py-1.5 hover:bg-[var(--color-surface-2)] transition-colors"
                  style={{ opacity: busyId === s.id ? 0.5 : 1 }}
                >
                  <span
                    className="shrink-0 mt-[3px] w-[15px] h-[15px] rounded-[4px] grid place-items-center border"
                    style={{
                      borderColor: on ? "var(--color-accent)" : "var(--color-border-strong, var(--color-border))",
                      background: on ? "var(--color-accent)" : "transparent",
                    }}
                    aria-hidden="true"
                  >
                    {on && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m5 12.5 4.5 4.5L19 7" />
                      </svg>
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px]">{s.name}</span>
                    {s.description && (
                      <span
                        className="block truncate text-[11px] mt-[1px]"
                        style={{ color: "var(--color-muted)" }}
                      >
                        {s.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          <a
            href="/skills"
            className="shrink-0 flex items-center justify-between px-2.5 h-9 border-t border-[var(--color-border)] text-[11.5px] hover:bg-[var(--color-surface-2)]"
            style={{ color: "var(--color-muted)" }}
          >
            技能库
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m9 6 6 6-6 6" />
            </svg>
          </a>
        </div>
      )}
    </div>
  );
}
