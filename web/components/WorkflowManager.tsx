"use client";

/**
 * 流程管理浮层 —— 在 Playground 里就地打开，不跳页。
 *
 * 布局（左选流程 / 右看它跑过的每一次）：
 *   左：全部流程（名字 · 几步 · 跑过几次 · 最近更新）
 *   右：**每次执行一张卡** —— 而不是一张干巴巴的表格。
 *       每张卡讲清三件事：
 *         ① 这次的结果：状态胶囊 · 什么时候 · 耗时 · 几步
 *         ② 这次让它做什么：任务文本
 *         ③ **这条流程这次走了哪几步**：芯片链（与画布上的编号/助手名同序同名）
 *         + 「就地回放」→ 复用 Playground 的历史回放，人不用离开页面
 *
 * 为什么从表格改成卡片：用户的原话是"历史执行**在流程上**显示有问题"。
 * 表格把每次执行压成一行数字，看不出"这条流程是怎么走的"；卡片把
 * 流程本身（几步、谁在第几步）摊开在每一次执行上，一眼能对上画布。
 *
 * 动作条在头部：新建 / 重命名 / 复制 / 删除（两步确认，禁原生弹窗）/ 打开到画布。
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Agent, Workflow } from "@/lib/types";
import { RunsPanel } from "@/components/RunsPanel";
import { STEP_STYLE, eventsToSteps, type Step } from "@/components/ui/run-timeline";

type Orc = {
  id: string;
  mode?: string;
  status?: string;
  task?: string | null;
  started_at?: number;
  ended_at?: number | null;
  step_count?: number;
};

/** 相对时间 */
function ago(ts?: number): string {
  if (!ts) return "—";
  const d = Date.now() - ts;
  if (d < 60_000) return "刚刚";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}

/** 耗时 */
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
  agents,
  onClose,
  onOpenWorkflow,
  onNew,
  onDuplicate,
  onDeleted,
  onReplay,
  onRenamed,
  variant = "overlay",
}: {
  open: boolean;
  currentId?: string | null;
  agents: Agent[];
  onClose: () => void;
  onOpenWorkflow: (w: Workflow) => void;
  onNew: () => void;
  onDuplicate: (w: Workflow) => void;
  onDeleted: () => void;
  onReplay: (orcId: string) => void;
  onRenamed?: (w: Workflow) => void;
  /** overlay = Playground 里的浮层（默认）；page = 整页（/runs 「管理」页），无遮罩、无 ✕、Esc 不关 */
  variant?: "overlay" | "page";
}) {
  /** 左列置顶的伪条目「全部运行记录」—— 选中它右侧就是原来 Runs 页那张表 */
  const ALL = "__all__";
  const [list, setList] = useState<Workflow[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [runs, setRuns] = useState<Orc[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  /** 就地展开的某一步执行详情（用户："agent 节点执行详情展示"——
   *  流程管理里原来只画了"走了哪几步"，点它没有任何反应 ✗，现在点开就地看这一步的
   *  输入/思考/调用/回复（与画布上点 agent 卡同一套分色，不跳页） */
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [stepDetail, setStepDetail] = useState<{ loading: boolean; steps: Step[]; note?: string } | null>(null);
  const showStep = useCallback(async (orcId: string, idx: number) => {
    const key = `${orcId}:${idx}`;
    if (openStep === key) {
      setOpenStep(null);
      setStepDetail(null);
      return;
    }
    if (!orcId) return;                 // 这份流程还没跑过 → 没有可展开的执行
    setOpenStep(key);
    setStepDetail({ loading: true, steps: [] });
    try {
      const d = (await api.orchestration(orcId)) as unknown as {
        steps?: { run_id: string; input_text?: string; agent_name?: string }[];
      };
      const st = (d.steps ?? [])[idx];
      if (!st?.run_id) {
        setStepDetail({ loading: false, steps: [], note: "这一步没有独立的执行记录" });
        return;
      }
      const evts = await api.runEvents(st.run_id);
      setStepDetail({ loading: false, steps: eventsToSteps(evts, st.input_text ?? "") });
    } catch (e) {
      setStepDetail({ loading: false, steps: [], note: e instanceof Error ? e.message : String(e) });
    }
  }, [openStep, runs]);   // runs 必须在依赖里 —— 否则回调捕获首次渲染的空数组，runs[0] 永远为空 ✗
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const d = (await api.workflows()) as unknown as Workflow[] | { items?: Workflow[] };
      const items = Array.isArray(d) ? d : (d.items ?? []);
      setList(items);
      setSel((cur) => cur ?? (variant === "page" ? ALL : items[0]?.id ?? null));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void loadList();
  }, [open, loadList]);

  useEffect(() => {
    if (!open || !sel || sel === ALL) {   // 选中「全部运行记录」时不需要这条流程的执行
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
    if (!open || variant === "page") return;   // 整页模式 Esc 不该关掉页面
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, onClose, variant]);

  if (!open) return null;
  const cur = list.find((w) => w.id === sel) ?? null;
  const curRuns = runs.length;

  /** 这条流程的步骤顺序（与画布同一套编号/名字）：给"每次执行走了哪几步"用 */
  const chainOf = (w: Workflow | null) => {
    const nodes = w?.graph?.nodes ?? [];
    const edges = w?.graph?.edges ?? [];
    // 拓扑序：从没有入边的节点开始（与画布 layers 的直觉一致）
    const indeg = new Map<string, number>();
    nodes.forEach((n) => indeg.set(n.nid, 0));
    edges.forEach((e) => indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1));
    const out: typeof nodes = [];
    const seen = new Set<string>();
    const queue = nodes.filter((n) => (indeg.get(n.nid) ?? 0) === 0);
    while (queue.length) {
      const n = queue.shift()!;
      if (seen.has(n.nid)) continue;
      seen.add(n.nid);
      out.push(n);
      edges.filter((e) => e.from === n.nid).forEach((e) => {
        const t = nodes.find((x) => x.nid === e.to);
        if (t && !seen.has(t.nid)) queue.push(t);
      });
    }
    nodes.forEach((n) => {
      if (!seen.has(n.nid)) out.push(n);
    });
    return out.map((n, i) => ({
      no: i + 1,
      nid: n.nid,
      name: agents.find((a) => a.id === n.agent_id)?.name ?? "助手",
    }));
  };

  const chain = chainOf(cur);

  return (
    <div
      className={variant === "page" ? "flex min-h-0 flex-col" : "fixed inset-0 z-50 flex flex-col"}
      style={variant === "page" ? undefined : { background: "rgba(16,20,26,.28)" }}
    >
      <div
        className={
          variant === "page"
            ? "flex h-[calc(100vh-116px)] min-h-[520px] w-full flex-col overflow-hidden rounded-[14px] border"
            : "m-auto flex h-[86vh] w-[min(1080px,94vw)] flex-col overflow-hidden rounded-[14px] border shadow-2xl"
        }
        style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
      >
        {/* 头部 */}
        <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
          <span className="text-[14.5px] font-semibold">
            {variant === "page" ? "管理" : "流程管理"}
          </span>
          <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
            {sel === ALL
              ? `共 ${list.length} 份流程 —— 左边的流程 + 右边的运行记录，一处管完`
              : `共 ${list.length} 份 · 选中这份跑过 ${curRuns} 次`}
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
                        const saved = (await api.updateWorkflow(cur.id, {
                          name: nameDraft.trim(),
                        } as never)) as unknown as Workflow;
                        setRenaming(false);
                        await loadList();
                        onRenamed?.(saved ?? { ...cur, name: nameDraft.trim() });
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
            {variant !== "page" && (
            <button
              type="button"
              onClick={onClose}
              title="关闭（Esc）"
              className="ml-1 rounded-[8px] px-2 py-1.5 text-[15px] leading-none hover:bg-[var(--color-surface-2)]"
              style={{ color: "var(--color-muted)" }}
            >
              ✕
            </button>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左：流程列表 */}
          <div className="w-[280px] shrink-0 overflow-auto border-r" style={{ borderColor: "var(--color-border)" }}>
            {loading && (
              <div className="px-3 py-3 text-[12.5px]" style={{ color: "var(--color-muted)" }}>
                读取中…
              </div>
            )}
            {!loading && list.length === 0 && (
              <div className="px-3 py-4 text-[12.5px]" style={{ color: "var(--color-muted)" }}>
                还没有流程。点右上「＋ 新建」，或回画布点一个起步模板。
              </div>
            )}
            {/* 置顶：全部运行记录（原 Runs 页那张表）—— 与各条流程**并列选择**，不做 tab 切换 */}
            <button
              type="button"
              onClick={() => setSel(ALL)}
              className="flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left hover:bg-[var(--color-surface-2)]"
              style={{
                borderColor: "var(--color-border)",
                background: sel === ALL ? "color-mix(in srgb, var(--color-accent) 7%, transparent)" : undefined,
              }}
            >
              <span
                className="flex items-center gap-1.5 text-[13px] font-medium"
                style={{ color: sel === ALL ? "var(--color-accent)" : undefined }}
              >
                <span className="shrink-0 text-[12px] opacity-70">▤</span>
                <span className="min-w-0 flex-1 truncate">全部运行记录</span>
              </span>
              <span className="text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                LLM 测试 · 助手试跑 · 流程执行，全在一张表
              </span>
            </button>
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
                    boxShadow: on ? "inset 2px 0 0 var(--color-accent)" : undefined,
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

          {/* 右：选中「全部运行记录」→ 原 Runs 页那张表；选中某条流程 → 骨架 + 每次执行一张卡 */}
          <div className="min-w-0 flex-1 overflow-auto">
            {sel === ALL ? (
              <div className="p-4">
                <RunsPanel />
              </div>
            ) : (
              <>
            {/* 骨架段：即使一次都没跑过，右边也有内容 —— 之前只写"跑过几次"，
                没跑过就是一片空白，用户看成了"点开流程显示不全"。
                这里把流程本身摊开：几步、每步是谁、怎么连的（与画布同一套编号 + 助手名）。 */}
            {cur && (
              <div className="border-b px-3 py-3" style={{ borderColor: "var(--color-border)" }}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                    这条流程
                  </span>
                  <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                    · {chain.length} 步
                  </span>
                </div>
                {chain.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1">
                    {chain.map((c, i) => (
                      <span key={c.nid} className="flex items-center gap-1">
                        {i > 0 && (
                          <span className="px-0.5 text-[11px]" style={{ color: "var(--color-border)" }}>
                            →
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => void showStep(runs[0]?.id ?? "", i)}
                          className="flex items-center gap-1.5 rounded-full border px-2 py-[2px] text-[11.5px] hover:brightness-[.97]"
                          style={{
                            borderColor: "color-mix(in srgb, var(--color-accent) 34%, var(--color-border))",
                            background:
                              openStep === `${runs[0]?.id ?? ""}:${i}`
                                ? "color-mix(in srgb, var(--color-accent) 16%, transparent)"
                                : "color-mix(in srgb, var(--color-accent) 6%, transparent)",
                            color: "var(--color-accent)",
                          }}
                          title={runs.length ? `第 ${c.no} 步 · ${c.name} —— 点开看这一步的执行详情` : `第 ${c.no} 步 · ${c.name}（这份流程还没跑过）`}
                        >
                          <span className="tabular-nums opacity-70">{c.no}</span>
                          {c.name}
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-[12.5px]" style={{ color: "var(--color-muted)" }}>
                    这份流程还没有助手。打开到画布，点节点右边的 ＋ 起步。
                  </div>
                )}
                {/* 就地展开：这一步的 输入/思考/调用/回复（与画布点 agent 卡同一套分色） */}
                {openStep && openStep.startsWith(`${runs[0]?.id ?? ""}:`) && stepDetail && (
                  <div className="mt-2 rounded-[8px] border" style={{ borderColor: "var(--color-border)" }}>
                    <div className="flex items-center gap-2 border-b px-2 py-1" style={{ borderColor: "var(--color-border)" }}>
                      <span className="text-[11.5px] font-medium" style={{ color: "var(--color-muted)" }}>
                        这一步的执行详情
                      </span>
                      <button
                        type="button"
                        className="ml-auto text-[11.5px]"
                        style={{ color: "var(--color-muted)" }}
                        onClick={() => { setOpenStep(null); setStepDetail(null); }}
                      >
                        收起
                      </button>
                    </div>
                    {stepDetail.loading ? (
                      <div className="px-2 py-2 text-[12px]" style={{ color: "var(--color-muted)" }}>读取中…</div>
                    ) : stepDetail.note ? (
                      <div className="px-2 py-2 text-[12px]" style={{ color: "var(--color-muted)" }}>{stepDetail.note}</div>
                    ) : (
                      <div className="flex flex-col gap-1.5 px-2 py-2">
                        {stepDetail.steps.map((st, k) => {
                          const sty = STEP_STYLE[st.kind];
                          return (
                            <div key={k} className="rounded-[8px] border" style={{ borderColor: sty.border, background: sty.bg }}>
                              <div className="flex items-center gap-1.5 px-2 py-[3px] text-[11px] font-semibold" style={{ color: sty.color }}>
                                <span className="text-[10px] leading-none">{sty.icon}</span>
                                {st.label}
                              </div>
                              <div className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words px-2 pb-[6px] text-[11.5px] leading-[1.65]">
                                {st.body}
                              </div>
                            </div>
                          );
                        })}
                        {stepDetail.steps.length === 0 && (
                          <div className="text-[12px]" style={{ color: "var(--color-muted)" }}>这一步没有留下事件</div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {renaming && cur && (
              <div className="flex items-center gap-2 border-b px-4 py-2" style={{ borderColor: "var(--color-border)" }}>
                <span className="text-[12.5px]" style={{ color: "var(--color-muted)" }}>
                  新名字
                </span>
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  className="df-ctl h-[30px] flex-1 rounded-[8px] border px-2 text-[12.5px]"
                  style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
                />
              </div>
            )}
            {!cur && (
              <div className="px-4 py-4 text-[12.5px]" style={{ color: "var(--color-muted)" }}>
                左边选一份流程，这里显示它跑过的每一次。
              </div>
            )}
            {cur && curRuns === 0 && (
              <div className="px-4 py-4 text-[12.5px]" style={{ color: "var(--color-muted)" }}>
                这份流程还没跑过。打开到画布写个任务就能跑。
              </div>
            )}
            {cur && curRuns > 0 && (
              <div className="flex flex-col gap-2.5 p-3">
                {runs.map((o) => {
                  const st = STATUS[o.status ?? ""] ?? { text: o.status ?? "—", color: "var(--color-muted)" };
                  return (
                    <div
                      key={o.id}
                      className="rounded-[10px] border px-3 py-2.5"
                      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
                    >
                      {/* ① 结果一行 */}
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className="rounded-full px-2 py-[1px] text-[11.5px]"
                          style={{ color: st.color, background: `color-mix(in srgb, ${st.color} 12%, transparent)` }}
                        >
                          {st.text}
                        </span>
                        <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                          {ago(o.started_at)} · 耗时 {took(o.started_at, o.ended_at)} · 走了 {o.step_count ?? chain.length} 步
                        </span>
                        <button
                          type="button"
                          onClick={() => onReplay(o.id)}
                          className="ml-auto rounded-[7px] border px-2.5 py-1 text-[12px] hover:bg-[var(--color-surface-2)]"
                          style={{ borderColor: "var(--color-border)", color: "var(--color-accent)" }}
                        >
                          就地回放
                        </button>
                      </div>

                      {/* ② 这次让它做什么 */}
                      <div className="mt-1.5 text-[12.5px] leading-[1.6]" title={o.task ?? ""}>
                        {o.task || <span style={{ color: "var(--color-muted)" }}>（无任务文本）</span>}
                      </div>

                      {/* ③ 这次走了哪几步 —— 和画布同一套编号与名字 */}
                      {chain.length > 0 && (
                        <div className="mt-2 flex flex-wrap items-center gap-1">
                          {chain.map((c, i) => {
                            // 只跑了一部分（step_count < 链长）时，后面的标灰：一眼看出"走到哪停的"
                            const reached = i < (o.step_count ?? chain.length);
                            return (
                              <span key={c.nid} className="flex items-center gap-1">
                                {i > 0 && (
                                  <span style={{ color: "var(--color-border)" }} className="px-0.5 text-[11px]">
                                    →
                                  </span>
                                )}
                                <span
                                  className="flex items-center gap-1 rounded-full border px-1.5 py-[1px] text-[11px]"
                                  style={{
                                    borderColor: reached
                                      ? "color-mix(in srgb, var(--color-accent) 40%, var(--color-border))"
                                      : "var(--color-border)",
                                    color: reached ? "var(--color-accent)" : "var(--color-muted)",
                                    background: reached
                                      ? "color-mix(in srgb, var(--color-accent) 7%, transparent)"
                                      : undefined,
                                  }}
                                  title={`第 ${c.no} 步 · ${c.name}`}
                                >
                                  <span className="tabular-nums opacity-70">{c.no}</span>
                                  {c.name}
                                </span>
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
