"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, fmt, STATUS_STYLE } from "@/lib/api";
import type { Agent, Run, RunDeleteResult } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { Hint, HINTS } from "@/components/ui/hint";

export default function RunsPage() {
  const fb = useFeedback();
  const [runs, setRuns] = useState<Run[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, a] = await Promise.all([
        api.runs(agentId || undefined, 100),
        api.agents(),
      ]);
      setRuns(r);
      setAgents(a);
      setSelected(new Set());
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const agentName = (id: string) =>
    agents.find((a) => a.id === id)?.name ?? id.slice(0, 12);

  const selectable = runs.filter((r) => !["running", "pending", "waiting_hitl"].includes(r.status));
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
      title: `删除选中的 ${ids.length} 条执行记录？`,
      description: "每条记录会连同它的事件流、LLM 调用与工具调用明细一并清理。",
      details: [
        ...ids.slice(0, 6),
        ...(ids.length > 6 ? [`…另有 ${ids.length - 6} 条`] : []),
      ],
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
      label: "清理多少天前的终态记录",
      defaultValue: "7",
      placeholder: "7",
      hint: "只清理已结束（ok / error / cancelled）的记录，运行中的会自动跳过。",
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
    const before = Date.now() - days * 86400_000;
    setBusy(true);
    try {
      // 先 dry_run 拿到真实影响条数，再让用户确认（而不是"一句话式"确认）
      const preview = await api.pruneRuns({
        before_ts: before,
        agent_id: agentId || undefined,
        dry_run: true,
      });
      const n = preview.skipped.length;
      const ok = await fb.confirm({
        title: `确认清理 ${days} 天前的记录？`,
        description: agentId ? "范围：当前选中的 Agent" : "范围：全部 Agent",
        details:
          n > 0
            ? [`将删除 ${n} 条终态记录`, "含其事件流、LLM 调用与工具调用明细"]
            : ["没有符合条件的记录"],
        danger: n > 0,
        confirmText: n > 0 ? `删除 ${n} 条` : "关闭",
        armDelayMs: 300,
      });
      if (!ok || n === 0) return;
      report(
        `清理 ${days} 天前`,
        await api.pruneRuns({ before_ts: before, agent_id: agentId || undefined }),
      );
      await load();
    } catch (e) {
      fb.error("清理失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    const scope = agentId ? "当前 Agent" : "所有 Agent";
    const word = await fb.prompt({
      title: `清空全部执行记录（${scope}）`,
      description: "此操作不可撤销，会连同全部事件流与调用明细一并删除。",
      label: "请输入 DELETE 确认",
      placeholder: "DELETE",
      hint: "输入完全匹配才可执行。建议优先使用「按时间清理」保留近期记录。",
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
      <header className="flex items-start justify-between mb-5 gap-4 flex-wrap">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight flex items-center gap-1.5">
            <Hint text={HINTS.run}>Runs</Hint>
          </h1>
          <p className="text-[13px] text-[var(--color-muted)] mt-1">
            每次执行的详细记录 —— 想弄清楚「它为什么这么回答」「哪一步慢了」就看这里。
            <span className="text-[11.5px]"> 共 {runs.length} 条</span>
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            className="input w-52"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          >
            <option value="">全部 Agent</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button
            className="btn"
            disabled={busy || selected.size === 0}
            onClick={deleteSelected}
          >
            删除选中{selected.size > 0 ? ` (${selected.size})` : ""}
          </button>
          <button className="btn" disabled={busy} onClick={pruneOld}>
            按时间清理
          </button>
          <button
            className="btn text-[var(--color-err)]"
            disabled={busy || runs.length === 0}
            onClick={clearAll}
          >
            清空
          </button>
        </div>
      </header>

      <div className="card overflow-x-auto">
        {loading ? (
          <div className="p-6 text-[13px] text-[var(--color-muted)]">加载中…</div>
        ) : runs.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-[var(--color-muted)]">
            还没有执行记录。
            <Link href="/agents" className="text-[var(--color-accent)] ml-1">
              去试跑一个 Agent →
            </Link>
          </div>
        ) : (
          <table className="w-full min-w-[760px] text-[12.5px]">
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
                <th className="text-left px-2 py-2.5 font-medium"><Hint text={HINTS.run}>Run</Hint></th>
                <th className="text-left px-3 font-medium">Agent</th>
                <th className="text-left px-3 font-medium">状态</th>
                <th className="text-right px-3 font-medium"><Hint text={HINTS.maxIters}>迭代</Hint></th>
                <th className="text-right px-3 font-medium"><Hint text="AI 思考花掉的时间（不包括它调用工具的时间）。">LLM 耗时</Hint></th>
                <th className="text-right px-3 font-medium"><Hint text="它调用工具（查网页、跑命令等）花掉的时间。">工具耗时</Hint></th>
                <th className="text-right px-3 font-medium"><Hint text={HINTS.ttft}>TTFT</Hint></th>
                <th className="text-right px-3 font-medium"><Hint text={HINTS.token}>tokens</Hint></th>
                <th className="text-left px-3 font-medium">时间</th>
                <th className="w-16 px-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const inFlight = ["running", "pending", "waiting_hitl"].includes(r.status);
                return (
                  <tr
                    key={r.id}
                    className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
                  >
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        disabled={inFlight}
                        checked={selected.has(r.id)}
                        onChange={() => toggle(r.id)}
                        className="accent-[var(--color-accent)]"
                        title={inFlight ? "运行中的记录需先中断" : "选择"}
                      />
                    </td>
                    <td className="px-2 py-2.5">
                      <Link href={`/runs/${r.id}`} className="mono text-[var(--color-accent)]">
                        {r.id}
                      </Link>
                    </td>
                    <td className="px-3 truncate max-w-[160px]">
                      <Link href={`/agents/${r.agent_id}`} className="hover:underline">
                        {agentName(r.agent_id)}
                      </Link>
                    </td>
                    <td className={`px-3 ${STATUS_STYLE[r.status] ?? ""}`}>
                      {r.status === "running" && <span className="live-dot">● </span>}
                      {r.status}
                    </td>
                    <td className="px-3 text-right mono">{r.usage?.iterations ?? 0}</td>
                    <td className="px-3 text-right mono">
                      {fmt.ms(r.usage?.llm_ms as number)}
                    </td>
                    <td className="px-3 text-right mono">
                      {fmt.ms(r.usage?.tool_ms as number)}
                    </td>
                    <td className="px-3 text-right mono">
                      {fmt.ms(r.usage?.ttft_ms_avg as number)}
                    </td>
                    <td className="px-3 text-right mono">
                      {r.usage?.tokens_in ?? 0}/{r.usage?.tokens_out ?? 0}
                    </td>
                    <td className="px-3 text-[var(--color-muted)]">
                      {fmt.relative(r.started_at)}
                    </td>
                    <td className="px-3">
                      <button
                        className="inline-block text-[var(--color-err)] hover:underline text-[12.5px] md:text-[12px] whitespace-nowrap min-w-[52px] md:min-w-[44px] text-center px-2.5 py-2.5 md:px-2 md:py-1 rounded hover:bg-[var(--color-surface-2)] disabled:opacity-40 disabled:no-underline disabled:hover:bg-transparent"
                        disabled={inFlight || busy}
                        title={inFlight ? "运行中的记录需先中断" : "删除这条记录"}
                        onClick={async () => {
                          const ok = await fb.confirm({
                            title: "删除这条执行记录？",
                            details: [r.id, "含其事件流、LLM 调用与工具调用明细"],
                            danger: true,
                            confirmText: "删除",
                          });
                          if (!ok) return;
                          try {
                            await api.deleteRun(r.id);
                            fb.success(`已删除 ${r.id}`);
                            await load();
                          } catch (e) {
                            fb.error("删除失败", e instanceof Error ? e.message : String(e));
                          }
                        }}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-[11.5px] text-[var(--color-muted)] mt-3">
        删除会连同该次执行的 <span className="mono">run_event / llm_call / tool_call</span> 一起清理（外键级联）。
        记录多时建议用「按时间清理」——事件表增长最快。
      </p>
    </div>
  );
}
