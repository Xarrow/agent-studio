"use client";

/**
 * 流程管理浮层 —— 在 Playground 里就地打开，不跳页。
 *
 * 左边：全部流程（名字 · 几步 · 跑过几次 · 最近一次什么时候）
 * 右边：选中这份的**执行链路** —— 它跑过的每一次（时间 · 状态 · 任务 · 几步 · 耗时）
 *       点某一次 = 就地回放（复用 Playground 的历史回放，人不用离开这个页面）
 * 动作：打开到画布 / 重命名 / 复制 / 删除
 *
 * 两个刻意的设计：
 *  1. 动作放在头部的动作条上，不塞进每一行 —— 列表行只负责"选"这一件事
 *  2. 删除沿用全站规矩：菜单内两步确认（第一次点变红并要求再点一次，4 秒内有效），
 *     不用浏览器原生 confirm（用户明令禁止）
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Workflow } from "@/lib/types";

type Orc = {
  id: string;
  mode?: string;
  status?: string;
  task?: string | null;
  started_at?: number;
  ended_at?: number | null;
  step_count?: number;
};

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期 */
function ago(ts?: number): string {
  if (!ts) return "—";
  const d = Date.now() - ts;
  if (d < 60_000) return "刚刚";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}

/** 耗时：1.2s / 34s / 2m10s */
function took(a?: number, b?: number | null): string {
  if (!a || !b) return "—";
  const s = Math.max(0, Math.round((b - a) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

const STATUS: Record<string, { text: string; color: string }> = {
  ok: { text: "完成", color: "var(--color-ok)" },
  running: { text: "执行中", color: "var(--color-accent)" },
  error: { text: "出错", color: "var(--color-err)" },
  failed: { text: "出错", color: "var(--color-err)" },
  aborted: { text: "已中止", color: "var(--color-muted)" },
};

export function WorkflowManager({
  open,
  currentId,
  onClose,
  onOpenWorkflow,
  onNew,
  onDuplicate,
  onDeleted,
  onReplay,
}: {
  open: boolean;
  currentId?: string | null;
  onClose: () => void;
  onOpenWorkflow: (w: Workflow) => void;
  onNew: () => void;
  onDuplicate: (w: Workflow) => void;
  onDeleted: () => void;
  onReplay: (orcId: string) => void;
}) {
  const [list, setList] = useState<Workflow[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [runs, setRuns] = useState<Orc[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const d = (await api.workflows()) as unknown as Workflow[] | { items?: Workflow[] };
      const items = Array.isArray(d) ? d : (d.items ?? []);
      setList(items);
      setSel((cur) => cur ?? items[0]?.id ?? null);
    } finally {
      setLoading(false);
    }
  }, []);

  // 打开时拉列表；每次选择变化拉这一份的执行链路
  useEffect(() => {
    if (open) void loadList();
  }, [open, loadList]);

  useEffect(() => {
    if (!open || !sel) {
      setRuns([]);
      return;
    }
    let alive = true;
    void (async () => {
      const d = (await api.workflowRuns(sel)) as unknown as Orc[] | { items?: Orc[] };
      if (alive) setRuns(Array.isArray(d) ? d : (d.items ?? []));
    })();
    setConfirmDel(false);
    setRenaming(false);
    return () => {
      alive = false;
    };
  }, [open, sel]);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, onClose]);

  if (!open) return null;
  const cur = list.find((w) => w.id === sel) ?? null;
  const curRuns = runs.length;

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "rgba(16,20,26,.28)" }}>
      <div
        className="m-auto flex h-[86vh] w-[min(1080px,94vw)] flex-col overflow-hidden rounded-[14px] border shadow-2xl"
        style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
      >
        {/* 头部 */}
        <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
          <span className="text-[14.5px] font-semibold">流程管理</span>
          <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
            共 {list.length} 份 · 选中这份跑过 {curRuns} 次
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={onNew}
              className="rounded-[8px] border px-2.5 py-1.5 text-[12.5px] hover:bg-[var(--color-surface-2)]"
              style={{ borderColor: "var(--color-border)" }}
            >
              ＋ 新建
            </button>
            {cur && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    if (!renaming) {
                      setNameDraft(cur.name);
                      setRenaming(true);
                    } else if (nameDraft.trim()) {
                      void (async () => {
                        await api.updateWorkflow(cur.id, { name: nameDraft.trim() } as never);
                        setRenaming(false);
                        await loadList();
                      })();
                    }
                  }}
                  className="rounded-[8px] border px-2.5 py-1.5 text-[12.5px] hover:bg-[var(--color-surface-2)]"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  {renaming ? "保存名字" : "重命名"}
                </button>
                <button
                  type="button"
                  onClick={() => onDuplicate(cur)}
                  className="rounded-[8px] border px-2.5 py-1.5 text-[12.5px] hover:bg-[var(--color-surface-2)]"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  复制
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!confirmDel) {
                      setConfirmDel(true);
                      window.setTimeout(() => setConfirmDel(false), 4000);
                      return;
                    }
                    void (async () => {
                      await api.deleteWorkflow(cur.id);
                      setConfirmDel(false);
                      setSel(null);
                      await loadList();
                      onDeleted();
                    })();
                  }}
                  className="rounded-[8px] border px-2.5 py-1.5 text-[12.5px]"
                  style={{
                    borderColor: confirmDel ? "var(--color-err)" : "var(--color-border)",
                    color: confirmDel ? "var(--color-err)" : undefined,
                    background: confirmDel ? "color-mix(in srgb, var(--color-err) 8%, transparent)" : undefined,
                  }}
                >
                  {confirmDel ? "再点一次删除" : "删除"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onOpenWorkflow(cur);
                    onClose();
                  }}
                  className="rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium text-white"
                  style={{ background: "var(--color-accent)" }}
                >
                  打开到画布
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              title="关闭（Esc）"
              className="ml-1 rounded-[8px] px-2 py-1.5 text-[15px] leading-none hover:bg-[var(--color-surface-2)]"
              style={{ color: "var(--color-muted)" }}
            >
              ✕
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左：流程列表 */}
          <div className="w-[300px] shrink-0 overflow-auto border-r" style={{ borderColor: "var(--color-border)" }}>
            {loading && <div className="px-3 py-3 text-[12.5px]" style={{ color: "var(--color-muted)" }}>读取中…</div>}
            {!loading && list.length === 0 && (
              <div className="px-3 py-4 text-[12.5px]" style={{ color: "var(--color-muted)" }}>
                还没有流程。点右上「＋ 新建」，或回画布点一个起步模板。
              </div>
            )}
            {list.map((w) => {
              const n = (w.graph?.nodes ?? []).length;
              const on = w.id === sel;
              return (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => setSel(w.id)}
                  className="flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left hover:bg-[var(--color-surface-2)]"
                  style={{
                    borderColor: "var(--color-border)",
                    background: on ? "color-mix(in srgb, var(--color-accent) 7%, transparent)" : undefined,
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px]">{w.name || "未命名编排"}</span>
                    {w.id === currentId && (
                      <span className="shrink-0 text-[11px]" style={{ color: "var(--color-accent)" }}>
                        画布上
                      </span>
                    )}
                  </div>
                  <div className="text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                    {n} 步 · 跑过 {w.run_count ?? 0} 次 · 更新 {ago(w.updated_at)}
                  </div>
                </button>
              );
            })}
          </div>

          {/* 右：这份流程的执行链路 */}
          <div className="min-w-0 flex-1 overflow-auto">
            {renaming && cur && (
              <div className="flex items-center gap-2 border-b px-4 py-2" style={{ borderColor: "var(--color-border)" }}>
                <span className="text-[12.5px]" style={{ color: "var(--color-muted)" }}>新名字</span>
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  className="df-ctl h-[30px] flex-1 rounded-[8px] border px-2 text-[12.5px]"
                  style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
                />
              </div>
            )}
            {!cur && <div className="px-4 py-4 text-[12.5px]" style={{ color: "var(--color-muted)" }}>左边选一份流程，这里显示它跑过的每一次。</div>}
            {cur && curRuns === 0 && (
              <div className="px-4 py-4 text-[12.5px]" style={{ color: "var(--color-muted)" }}>
                这份流程还没跑过。打开到画布写个任务就能跑。
              </div>
            )}
            {curRuns > 0 && (
              <table className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr style={{ color: "var(--color-muted)" }}>
                    {["时间", "状态", "这次的任务", "步数", "耗时", ""].map((h) => (
                      <th key={h} className="border-b px-3 py-2 text-left font-normal" style={{ borderColor: "var(--color-border)" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {runs.map((o) => {
                    const st = STATUS[o.status ?? ""] ?? { text: o.status ?? "—", color: "var(--color-muted)" };
                    return (
                      <tr key={o.id} className="hover:bg-[var(--color-surface-2)]">
                        <td className="border-b px-3 py-2" style={{ borderColor: "var(--color-border)" }}>{ago(o.started_at)}</td>
                        <td className="border-b px-3 py-2" style={{ borderColor: "var(--color-border)" }}>
                          <span className="rounded-full px-1.5 py-[1px]" style={{ color: st.color, background: `color-mix(in srgb, ${st.color} 12%, transparent)` }}>
                            {st.text}
                          </span>
                        </td>
                        <td className="max-w-[380px] truncate border-b px-3 py-2" style={{ borderColor: "var(--color-border)" }} title={o.task ?? ""}>
                          {o.task || "（无任务文本）"}
                        </td>
                        <td className="border-b px-3 py-2 tabular-nums" style={{ borderColor: "var(--color-border)" }}>{o.step_count ?? "—"}</td>
                        <td className="border-b px-3 py-2 tabular-nums" style={{ borderColor: "var(--color-border)" }}>{took(o.started_at, o.ended_at)}</td>
                        <td className="border-b px-3 py-2" style={{ borderColor: "var(--color-border)" }}>
                          <button
                            type="button"
                            onClick={() => onReplay(o.id)}
                            className="rounded-[6px] border px-2 py-0.5 text-[12px] hover:bg-[var(--color-surface-2)]"
                            style={{ borderColor: "var(--color-border)", color: "var(--color-accent)" }}
                          >
                            就地回放
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
