"use client";

/**
 * 运行记录 —— 三类调用合成一条时间线。
 *
 * 为什么要合并（产品视角）
 * ----------------------
 * 平台上会产生三类"调用":
 *   · LLM 测试   在「LLM 配置」里直接跟模型聊两句（验证 key/模型本身）
 *   · 助手试跑   在助手详情页「试跑与观测」里跑一次（验证配置）
 *   · 正式使用   在「对话」页聊天、或用多 Agent 编排干活
 *
 * 对用户来说这些是同一件事的不同场合：**我发起过一次调用，结果如何**。
 * 原来只有助手执行进 Runs，LLM 测试根本不落库 —— 于是"上次测试是通过还是
 * 失败、报的什么错"，刷新页面就再也找不回来了。
 *
 * 现在三类都记，并且**并到同一个页面**：类型可筛、可搜、可一起删。
 *
 * 为什么详情用弹框而不是详情页
 * --------------------------
 * 看记录的动作是「扫一遍 → 挑一条看看为什么 → 回去接着挑」。
 * 跳页会把这几步变成"列表→详情→返回→忘了看到哪"，筛选和勾选状态还会丢。
 * 弹框原地开合，上下文不丢。老路径 /runs/<id> 仍在，深链不受影响。
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { ActivityItem, Agent, RunDeleteResult } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { Hint } from "@/components/ui/hint";
import { RunDetailDialog, KIND_LABEL } from "@/components/RunDetailDialog";

/** 状态配色（与全局一致） */
const STATUS_STYLE: Record<string, string> = {
  ok: "var(--color-ok)",
  running: "var(--color-accent)",
  pending: "var(--color-muted)",
  error: "var(--color-err)",
  aborted: "var(--color-warn)",
  waiting_hitl: "var(--color-warn)",
};

/** 类型筛选的顺序与「人话」标签 */
const KIND_TABS: { key: string; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "llm_test", label: "LLM 测试" },
  { key: "preview", label: "助手试跑" },
  { key: "chat", label: "对话" },
  { key: "playground", label: "编排" },
];

/** 运行中的记录不给删（删了状态就永远悬着） */
const LIVE = ["running", "pending", "waiting_hitl"];

export default function RunsPage() {
  const fb = useFeedback();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [agents, setAgents] = useState<Agent[]>([]);
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("");
  const [agentId, setAgentId] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<ActivityItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tl, a] = await Promise.all([
        api.runTimeline({
          kind: kind === "all" ? undefined : kind,
          status: status || undefined,
          agent_id: agentId || undefined,
          q: q.trim() || undefined,
          limit: 300,
        }),
        api.agents(),
      ]);
      setItems(tl.items);
      setCounts(tl.counts);
      setAgents(a);
      setSelected(new Set());
    } catch (e) {
      fb.error("加载运行记录失败", e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  // 注意：fb 不进依赖 —— useFeedback() 每次渲染返回新对象，进依赖会变成无限重取。
  // 与仓库里其它页面的写法保持一致（fb 只在回调里用）。
  }, [kind, status, agentId, q]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 300 : 0); // 搜索防抖，其余立刻
    return () => clearTimeout(t);
  }, [load, q]);

  const total = useMemo(
    () => Object.values(counts).reduce((a, b) => a + b, 0),
    [counts],
  );

  /** 只有已经结束的记录能删 —— 运行中的删了状态就永远悬着 */
  const selectable = items.filter((r) => !LIVE.includes(r.status));
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(selectable.map((r) => r.id)));

  const report = (label: string, r: RunDeleteResult) => {
    const skipped = r.skipped.filter((s) => s.reason !== "dry_run（未删除）").length;
    fb.success(`${label}：已删除 ${r.deleted} 条` + (skipped ? `，跳过 ${skipped} 条` : ""));
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    const ids = [...selected];
    const ok = await fb.confirm({
      title: `删除选中的 ${ids.length} 条记录？`,
      description:
        "助手执行会连同它的事件流、模型调用与工具调用明细一并清理；LLM 测试记录直接删除。",
      details: [...ids.slice(0, 6), ...(ids.length > 6 ? [`…另有 ${ids.length - 6} 条`] : [])],
      danger: true,
      confirmText: `删除 ${ids.length} 条`,
      armDelayMs: 400,
    });
    if (!ok) return;
    setBusy(true);
    try {
      report("批量删除", await api.bulkDeleteRuns(ids));
      await load();
    } catch (e) {
      fb.error("批量删除失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // 按条件清理：比"清空全部"更实用（run_event 是大表）
  const pruneOld = async () => {
    const raw = await fb.prompt({
      title: "按时间清理",
      label: "清理多少天前的记录",
      defaultValue: "7",
      placeholder: "7",
      hint: "只清理已结束的记录，运行中的会自动跳过。",
      validate: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return "请输入大于 0 的天数";
        if (n > 3650) return "天数过大（最多 3650）";
        return null;
      },
      confirmText: "预览影响范围",
    });
    if (raw === null) return;
    const days = Number(raw);
    setBusy(true);
    try {
      const preview = await api.pruneRuns({
        before_ts: Date.now() - days * 86400_000,
        agent_id: agentId || undefined,
        dry_run: true,
      });
      const n = preview.skipped.length;
      const ok = await fb.confirm({
        title: `确认清理 ${days} 天前的记录？`,
        description: agentId ? "范围：当前选中的 Agent" : "范围：全部 Agent",
        details:
          n > 0
            ? [`将删除 ${n} 条已结束的助手执行记录`, "含其事件流、模型调用与工具调用明细"]
            : ["没有符合条件的记录"],
        danger: n > 0,
        confirmText: n > 0 ? `删除 ${n} 条` : "关闭",
        armDelayMs: 300,
      });
      if (!ok || n === 0) return;
      report(
        `清理 ${days} 天前`,
        await api.pruneRuns({ before_ts: Date.now() - days * 86400_000, agent_id: agentId || undefined }),
      );
      await load();
    } catch (e) {
      fb.error("清理失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    const word = await fb.prompt({
      title: `清空全部助手执行记录（${agentId ? "当前 Agent" : "所有 Agent"}）`,
      description:
        "不可撤销，会连同全部事件流与调用明细一并删除。LLM 测试记录请用「删除选中」。",
      label: "请输入 DELETE 确认",
      placeholder: "DELETE",
      hint: "输入完全匹配才可执行。建议优先用「按时间清理」保留近期记录。",
      validate: (v) => (v === "DELETE" ? null : "需输入大写 DELETE 才能继续"),
      danger: true,
      confirmText: "清空",
    });
    if (word !== "DELETE") return;
    setBusy(true);
    try {
      report("清空", await api.clearRuns("DELETE", agentId || undefined));
      await load();
    } catch (e) {
      fb.error("清空失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };


  return (
    <div className="p-4 md:p-6 lg:p-7 max-w-[1400px]">
      <header className="mb-4">
        <h1 className="text-[22px] font-semibold tracking-tight flex items-center gap-1.5">
          <Hint text="每一次调用的完整流水：在 LLM 配置里的裸模型测试、助手试跑、正式对话、多 Agent 编排，都在这一条时间线上。点任意一行即可在原地看详情。">
            运行记录
          </Hint>
        </h1>
        <p className="text-[13px] text-[var(--color-muted)] mt-1">
          所有调用流水 —— LLM 测试、助手试跑、对话、编排，一处看完。
          <span className="text-[11.5px]"> 共 {total} 条</span>
        </p>
      </header>

      {/* ── 类型筛选：带计数，一眼看出各有多少 ─────────────────── */}
      <div className="flex gap-1 mb-3 overflow-x-auto pb-0.5">
        {KIND_TABS.map((t) => {
          const n = t.key === "all" ? total : (counts[t.key] ?? 0);
          const on = kind === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setKind(t.key)}
              className={`px-3 py-1.5 rounded-md text-[12.5px] whitespace-nowrap transition-colors ${
                on
                  ? "bg-[var(--color-accent)] text-white font-medium"
                  : "bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              {t.label}
              <span className={`ml-1.5 ${on ? "opacity-80" : "opacity-60"}`}>{n}</span>
            </button>
          );
        })}
      </div>

      {/* ── 工具条 ──────────────────────────────────────────── */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <input
          className="input w-56"
          placeholder="搜索：主体 / 模型 / 摘要 / 错误"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="input w-32" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部状态</option>
          <option value="ok">ok</option>
          <option value="error">error</option>
          <option value="running">running</option>
          <option value="aborted">aborted</option>
        </select>
        <select className="input w-44" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">全部助手</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>

        <div className="flex-1" />

        <button className="btn" disabled={busy || selected.size === 0} onClick={deleteSelected}>
          删除选中{selected.size > 0 ? ` (${selected.size})` : ""}
        </button>
        <button className="btn btn-sm text-[var(--color-muted)]" disabled={busy} onClick={pruneOld}>
          按时间清理
        </button>
        <button
          className="btn btn-sm text-[var(--color-err)]"
          disabled={busy || items.length === 0}
          onClick={clearAll}
        >
          清空
        </button>
      </div>

      <div className="card overflow-x-auto">
        {loading ? (
          <div className="p-6 text-[13px] text-[var(--color-muted)]">加载中…</div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-[var(--color-muted)]">
            {q || status || agentId || kind !== "all" ? (
              <>
                没有符合条件的记录。
                <button
                  className="text-[var(--color-accent)] ml-1"
                  onClick={() => {
                    setQ("");
                    setStatus("");
                    setAgentId("");
                    setKind("all");
                  }}
                >
                  清空筛选 →
                </button>
              </>
            ) : (
              <>
                还没有任何调用记录。
                <Link href="/chat" className="text-[var(--color-accent)] ml-1">
                  去聊一句试试 →
                </Link>
              </>
            )}
          </div>
        ) : (
          <table className="w-full min-w-[880px] text-[12.5px]">
            <thead className="bg-[var(--color-surface-2)] text-[var(--color-muted)]">
              <tr>
                <th className="w-10 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="accent-[var(--color-accent)]"
                    title="全选（不含运行中的记录）"
                  />
                </th>
                <th className="text-left px-3 py-2.5 font-medium w-40">时间</th>
                <th className="text-left px-3 py-2.5 font-medium w-24">类型</th>
                <th className="text-left px-3 py-2.5 font-medium">主体</th>
                <th className="text-left px-3 py-2.5 font-medium w-24">状态</th>
                <th className="text-right px-3 py-2.5 font-medium w-20">耗时</th>
                <th className="text-right px-3 py-2.5 font-medium w-28">Tokens</th>
                <th className="text-left px-3 py-2.5 font-medium">摘要</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const live = LIVE.includes(it.status);
                return (
                  <tr
                    key={it.id}
                    className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)] cursor-pointer"
                    onClick={() => setOpen(it)}
                  >
                    <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                      {!live && (
                        <input
                          type="checkbox"
                          checked={selected.has(it.id)}
                          onChange={() => toggle(it.id)}
                          className="accent-[var(--color-accent)]"
                        />
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-[var(--color-muted)] whitespace-nowrap">
                      {new Date(it.at).toLocaleString([], {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className="text-[11px] px-1.5 py-0.5 rounded whitespace-nowrap"
                        style={{
                          background: "color-mix(in srgb, var(--color-accent) 10%, transparent)",
                          color: "var(--color-accent)",
                        }}
                      >
                        {KIND_LABEL[it.kind]}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="truncate max-w-[240px]">{it.title}</div>
                      {it.model && it.kind !== "llm_test" && (
                        <div className="text-[11px] text-[var(--color-muted)] truncate mono">
                          {it.model}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="mono" style={{ color: STATUS_STYLE[it.status] ?? "" }}>
                        {live && "● "}
                        {it.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-[var(--color-muted)] whitespace-nowrap">
                      {it.duration_ms != null ? fmt.ms(it.duration_ms) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right text-[var(--color-muted)] whitespace-nowrap">
                      {it.tokens_in || it.tokens_out ? `${it.tokens_in}/${it.tokens_out}` : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-[var(--color-muted)]">
                      <div className="truncate max-w-[320px]">
                        {it.error ? (
                          <span className="text-[var(--color-err)]">✗ {it.error}</span>
                        ) : (
                          it.summary ?? "—"
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {open && (
        <RunDetailDialog item={open} onClose={() => setOpen(null)} onDeleted={() => void load()} />
      )}
    </div>
  );
}
