"use client";

/**
 * 输入区工具栏上的「技能」入口。
 *
 * 以前挂技能只有两条路：侧栏那一行（桌面）、或者点开助手配置对话框。
 * 手机上侧栏在抽屉里，对话时想给这轮换个技能，得先退出对话视角。
 * 现在它是 chips 行上的一个 chip：点开就是抽屉，勾一下立刻生效
 * （写回 definition.skills，和配置页、侧栏是同一条写入路径）。
 *
 * 只做「这个助手能用什么」这一件事：不在这里新建技能、不改它的内容 ——
 * 那些属于「工具」页，别把两种意图塞进同一个面板。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Agent, Skill } from "@/lib/types";
import { api } from "@/lib/api";
import { Sheet } from "./ui/Sheet";

export function SkillPicker({
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
  const [all, setAll] = useState<Skill[]>([]);
  const [q, setQ] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    void api
      .skills()
      .then((list) => setAll(list.filter((s) => (s.state ?? "active") !== "archived")))
      .catch(() => setAll([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  /* 勾选要跟手：先就地改，接口回来再以服务端为准。
     agent 来自上层 props，一次往返期间它还是旧值，所以中间态放这里兜着。 */
  const [override, setOverride] = useState<string[] | null>(null);
  const serverIds = useMemo(
    () => (agent?.definition?.skills ?? []).map((s) => s.ref),
    [agent],
  );
  const mountedIds = override ?? serverIds;
  const mounted = useMemo(() => new Set(mountedIds), [mountedIds]);

  // 服务端的值追上来了就把中间态扔掉
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
        definition: { ...agent.definition, skills: next.map((r) => ({ ref: r })) },
      });
      onChanged();
    } catch {
      setOverride(before); // 失败退回原样，再点一次还能重试
    }
  };

  const list = q.trim()
    ? all.filter(
        (s) =>
          s.name.toLowerCase().includes(q.trim().toLowerCase()) ||
          (s.description || "").toLowerCase().includes(q.trim().toLowerCase()),
      )
    : all;

  return (
    <Sheet
      open={open}
      onClose={() => onOpenChange(false)}
      title="技能"
      hint="勾上就对这一轮生效"
      extra={
        <span className="text-[11px] tabular-nums" style={{ color: "var(--color-muted)" }}>
          已挂 {mountedIds.length} / 共 {all.length}
        </span>
      }
      maxH="84vh"
      width={380}
    >
      <div className="px-3.5 pb-2">
        <input
          className="input h-9 w-full text-[13px]"
          value={q}
          placeholder={all.length > 8 ? "搜索技能…" : "搜索"}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {list.length === 0 ? (
        <p className="px-3.5 py-8 text-center text-[12.5px]" style={{ color: "var(--color-muted)" }}>
          {all.length === 0 ? "还没有技能，去「工具」页装一个" : "没有匹配的技能"}
        </p>
      ) : (
        <div className="pb-2">
          {/* 已挂的排前面：对话时最常做的事就是"确认它挂着" */}
          {[...list].sort((a, b) => Number(mounted.has(b.id)) - Number(mounted.has(a.id))).map((s) => {
            const on = mounted.has(s.id);
            return (
              <button
                key={s.id}
                data-tap
                disabled={!!busyId}
                onClick={() => void toggle(s.id)}
                className="w-full text-left px-3.5 py-2 flex items-start gap-2.5 hover:bg-[var(--color-surface-2)] transition-colors"
              >
                <span
                  className="shrink-0 mt-0.5 w-[18px] h-[18px] grid place-items-center rounded-[5px] border transition-colors"
                  style={{
                    borderColor: on ? "var(--color-accent)" : "var(--color-border-strong, var(--color-border))",
                    background: on ? "var(--color-accent)" : "transparent",
                    opacity: busyId === s.id ? 0.5 : 1,
                  }}
                  aria-hidden="true"
                >
                  {on && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium truncate">{s.name}</span>
                  {s.description && (
                    <span
                      className="text-[11.5px] leading-[1.45] mt-0.5 line-clamp-1"
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
      )}
    </Sheet>
  );
}
