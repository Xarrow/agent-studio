"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { Agent, Memory, MemoryStats } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { MemoryCopyDialog } from "@/components/MemoryCopyDialog";

const KIND_LABEL: Record<string, string> = {
  fact: "事实",
  preference: "偏好",
  summary: "结论",
  instruction: "要求",
};

const KIND_COLOR: Record<string, string> = {
  fact: "var(--color-info)",
  preference: "var(--color-accent)",
  summary: "var(--color-ok)",
  instruction: "var(--color-warn)",
};

const WHO_LABEL: Record<string, string> = {
  agent: "仅此 Agent",
  global: "所有 Agent",
  session: "这个对话",
};

export default function MemoriesPage() {
  const fb = useFeedback();
  const [items, setItems] = useState<Memory[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);

  // 筛选
  const [agentId, setAgentId] = useState("");
  const [status, setStatus] = useState<string>("active");
  const [kind, setKind] = useState("");
  const [query, setQuery] = useState("");

  // 候选区多选
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // 新建
  const [draft, setDraft] = useState("");
  const [draftKind, setDraftKind] = useState("fact");
  /** 新记忆归给谁："__global__" = 所有助手共用，否则是某个 Agent 的 id */
  const [draftOwner, setDraftOwner] = useState("__global__");
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 正在复制哪条记忆（null = 没在复制） */
  const [copying, setCopying] = useState<Memory | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, ags, st] = await Promise.all([
        api.memories({
          agentId: agentId || undefined,
          status: status || undefined,
          kind: kind || undefined,
          q: query.trim() || undefined,
        }),
        api.agents(),
        api.memoryStats(),
      ]);
      setItems(list);
      setAgents(ags);
      setStats(st);
      setPicked(new Set());
    } catch (e) {
      fb.error("加载记忆失败", e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [agentId, status, kind, query, fb]);

  useEffect(() => {
    void load();
    // 只在真实筛选变化时重载（fb 是稳定引用）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, status, kind]);

  const candidates = useMemo(() => items.filter((m) => m.status === "candidate"), [items]);

  /* ------------------------------ 新建 ------------------------------ */
  const create = async () => {
    const content = draft.trim();
    if (!content) {
      fb.warn("内容不能为空");
      return;
    }
    // 归属由用户直接选定，不再"跟着页面上方的筛选走"——那样很绕
    // （原来要先在下面按助手筛一遍，"只给某个助手"才可选）
    const isGlobal = draftOwner === "__global__";
    setBusy(true);
    try {
      await api.createMemory({
        content,
        agent_id: isGlobal ? null : draftOwner,
        scope: isGlobal ? "global" : "agent",
        kind: draftKind,
        active: true,
      });
      setDraft("");
      fb.success("已保存记忆");
      await load();
    } catch (e) {
      fb.error("保存失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------ 操作 ------------------------------ */
  const setStatusOf = async (m: Memory, next: string) => {
    try {
      await api.updateMemory(m.id, { status: next });
      fb.success(next === "active" ? "已转正" : next === "archived" ? "已停用" : "已丢弃");
      await load();
    } catch (e) {
      fb.error("更新失败", e instanceof Error ? e.message : String(e));
    }
  };

  const edit = async (m: Memory) => {
    const next = await fb.prompt({
      title: "编辑记忆内容",
      description: "这段内容会作为「已知信息」注入到 System Prompt。",
      label: "内容",
      multiline: true,
      defaultValue: m.content,
      validate: (v) => (v.trim() ? null : "内容不能为空"),
      confirmText: "保存",
    });
    if (next === null || next.trim() === m.content) return;
    try {
      await api.updateMemory(m.id, { content: next.trim() });
      fb.success("已更新");
      await load();
    } catch (e) {
      fb.error("更新失败", e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (m: Memory) => {
    const ok = await fb.confirm({
      title: "删除这条记忆？",
      description: "删除后就彻底没了。只是暂时不想用它的话，改成「停用」更合适。",
      details: [m.content.slice(0, 120) + (m.content.length > 120 ? "…" : "")],
      danger: true,
      confirmText: "删除",
    });
    if (!ok) return;
    try {
      await api.deleteMemory(m.id);
      fb.success("已删除");
      await load();
    } catch (e) {
      fb.error("删除失败", e instanceof Error ? e.message : String(e));
    }
  };

  const bulk = async (next: string) => {
    if (picked.size === 0) return;
    const label = next === "active" ? "确认" : "丢弃";
    const ok = await fb.confirm({
      title: `${label}选中的 ${picked.size} 条候选记忆？`,
      description:
        next === "active"
          ? "确认后它会在后续对话里被用到。"
          : "停用后不再被使用（之后能在「已停用」里找回）。",
      danger: next !== "active",
      confirmText: label,
    });
    if (!ok) return;
    try {
      await api.bulkMemoryStatus([...picked], next);
      fb.success(`已${label} ${picked.size} 条`);
      await load();
    } catch (e) {
      fb.error(`${label}失败`, e instanceof Error ? e.message : String(e));
    }
  };

  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="p-4 md:p-6 lg:p-7 max-w-[1200px]">
      <header className="mb-5">
        <h1 className="text-[22px] font-semibold tracking-tight">记忆</h1>
        <p className="text-[13px] text-[var(--color-muted)] mt-1">
          跨会话的长期记忆 · 对话前自动回忆起相关的内容
        </p>
      </header>

      {/* 统计 */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          <StatCard label="在用" value={stats.active} accent="var(--color-accent)" />
          <StatCard label="待确认" value={stats.candidate} accent="var(--color-warn)" />
          <StatCard label="已停用" value={stats.archived} accent="var(--color-muted)" />
          <StatCard label="被用过（总次数）" value={stats.total_hits} accent="var(--color-ok)" />
        </div>
      )}

      {/* 候选区 —— 自动沉淀的待确认项 */}
      {candidates.length > 0 && (
        <div
          className="card p-4 mb-5"
          style={{ borderLeft: "3px solid var(--color-warn)" }}
        >
          <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
            <div>
              <h2 className="text-[14px] font-medium">
                候选区 · {candidates.length} 条待确认
              </h2>
              <p className="text-[12px] text-[var(--color-muted)] mt-0.5">
                自动总结的内容先进这里，你确认后才会被使用 —— 避免噪音干扰
              </p>
            </div>
            <div className="flex gap-2">
              <button className="btn" onClick={() => void bulk("active")} disabled={picked.size === 0}>
                确认选中{picked.size > 0 ? ` (${picked.size})` : ""}
              </button>
              <button
                className="btn text-[var(--color-err)]"
                onClick={() => void bulk("archived")}
                disabled={picked.size === 0}
              >
                丢弃选中
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            {candidates.map((m) => (
              <label
                key={m.id}
                className="flex items-start gap-2.5 p-2.5 rounded-md cursor-pointer hover:bg-[var(--color-surface-2)]"
                style={{ border: "1px solid var(--color-border)" }}
              >
                <input
                  type="checkbox"
                  className="mt-1 accent-[var(--color-accent)]"
                  checked={picked.has(m.id)}
                  onChange={() => togglePick(m.id)}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] break-words">{m.content}</div>
                  <div className="flex gap-2 mt-1 text-[11px] text-[var(--color-muted)] items-center flex-wrap">
                    <KindTag kind={m.kind} />
                    <span>{m.agent_name ?? "—"}</span>
                    <span>·</span>
                    <span>来自{m.source === "auto" ? "自动提炼" : "手动录入"}</span>
                    {m.source_run_id && (
                      <>
                        <span>·</span>
                        <a
                          className="hover:underline"
                          style={{ color: "var(--color-accent)" }}
                          href={`/runs/${m.source_run_id}`}
                        >
                          {m.source_run_id}
                        </a>
                      </>
                    )}
                  </div>
                </div>
                <button
                  className="btn text-[11px] shrink-0"
                  onClick={(e) => {
                    e.preventDefault();
                    void setStatusOf(m, "active");
                  }}
                >
                  转正
                </button>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* 新建 */}
      <div className="card p-4 mb-5">
        <h2 className="text-[14px] font-medium mb-3">新增记忆</h2>
        <textarea
          className="input mono text-[12.5px]"
          rows={2}
          placeholder="例如：用户偏好中文回复，不要 emoji。"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        {/* 默认「所有 Agent 都能用」，所以只需要写内容 + 点保存。
            类型和范围属于进阶选项，收进「更多选项」里，不占视线。 */}
        <div className="flex gap-2 mt-3 flex-wrap items-center">
          <button className="btn btn-primary" disabled={busy || !draft.trim()} onClick={() => void create()}>
            保存
          </button>
          <button
            className="text-[12.5px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
            onClick={() => setShowMore((v) => !v)}
          >
            {showMore ? "▾" : "▸"} 更多选项
          </button>
        </div>

        {showMore && (
          <div className="flex gap-2 mt-3 flex-wrap items-center pl-3 border-l-2 border-[var(--color-border)]">
            <div>
              <label className="label">类型</label>
              <select className="input w-36" value={draftKind} onChange={(e) => setDraftKind(e.target.value)}>
                {Object.entries(KIND_LABEL).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">归给谁</label>
              <select
                className="input w-48"
                value={draftOwner}
                onChange={(e) => setDraftOwner(e.target.value)}
              >
                <option value="__global__">所有助手共用</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} 专有
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      {/* 筛选 */}
      <div className="flex gap-2 mb-4 flex-wrap items-center">
        <select className="input w-48" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">全部 Agent</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select className="input w-32" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部状态</option>
          <option value="active">在用</option>
          <option value="candidate">候选</option>
          <option value="archived">已停用</option>
        </select>
        <select className="input w-28" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">全部类型</option>
          {Object.entries(KIND_LABEL).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <input
          className="input flex-1 min-w-[180px]"
          placeholder="搜索内容…（回车）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load();
          }}
        />
        <button className="btn" onClick={() => void load()}>
          刷新
        </button>
      </div>

      {/* 列表 */}
      <div className="card overflow-x-auto">
        {loading ? (
          <div className="p-6 text-[13px] text-[var(--color-muted)]">加载中…</div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-[var(--color-muted)]">
            还没有记忆。
            <br />
            可以在上面手动新增，或在 Agent 详情页执行一次后点「沉淀为记忆」。
          </div>
        ) : (
          <table className="w-full min-w-[720px] text-[12.5px]">
            <thead className="bg-[var(--color-surface-2)] text-[var(--color-muted)]">
              <tr>
                <th className="text-left px-3 py-2.5">内容</th>
                <th className="text-left px-3 py-2.5 w-20">类型</th>
                <th className="text-left px-3 py-2.5 w-36">归属</th>
                <th className="text-right px-3 py-2.5 w-16">被用过</th>
                <th className="text-left px-3 py-2.5 w-24">更新</th>
                <th className="text-left px-3 py-2.5 w-40">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id} className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
                  <td className="px-3 py-2.5">
                    <div className="break-words">{m.content}</div>
                    <div className="text-[11px] text-[var(--color-muted)] mt-0.5 flex gap-2 items-center">
                      <span>{m.source === "auto" ? "自动提炼" : "手动录入"}</span>
                      {m.source_run_id && (
                        <>
                          <span>·</span>
                          <a
                            className="hover:underline"
                            style={{ color: "var(--color-accent)" }}
                            href={`/runs/${m.source_run_id}`}
                          >
                            来源 {m.source_run_id.slice(0, 12)}…
                          </a>
                        </>
                      )}
                      {m.status !== "active" && (
                        <>
                          <span>·</span>
                          <span style={{ color: m.status === "candidate" ? "var(--color-warn)" : "var(--color-muted)" }}>
                            {m.status === "candidate" ? "候选" : "已停用"}
                          </span>
                        </>
                      )}
                    </div>
                  </td>
                  <td className="px-3">
                    <KindTag kind={m.kind} />
                  </td>
                  <td className="px-3 text-[var(--color-muted)]">
                    {m.scope === "global" ? (
                      <span>所有助手共用</span>
                    ) : (
                      m.agent_name ?? <span title="绑定的助手已被删除">（已失效）</span>
                    )}
                  </td>
                  <td className="px-3 text-right mono" title={m.last_hit_at ? `最后使用：${fmt.time(m.last_hit_at)}` : "还没用过"}>
                    {m.hits}
                  </td>
                  <td className="px-3 text-[var(--color-muted)]">{fmt.relative(m.updated_at)}</td>
                  <td className="px-3">
                    <div className="flex gap-1 whitespace-nowrap">
                      <button className="btn text-[11px] px-2 py-1" onClick={() => void edit(m)}>
                        编辑
                      </button>
                      <button
                        className="btn text-[11px] px-2 py-1"
                        title="复制一份并绑定到别的助手（原件不动）"
                        onClick={() => setCopying(m)}
                      >
                        复制到…
                      </button>
                      {m.status !== "active" && (
                        <button className="btn text-[11px] px-2 py-1" onClick={() => void setStatusOf(m, "active")}>
                          启用
                        </button>
                      )}
                      {m.status === "active" && (
                        <button
                          className="btn text-[11px] px-2 py-1"
                          onClick={() => void setStatusOf(m, "archived")}
                        >
                          停用
                        </button>
                      )}
                      <button
                        className="inline-block text-[var(--color-err)] hover:underline text-[12px] md:text-[11px] whitespace-nowrap min-w-[44px] md:min-w-[36px] text-center px-2 py-2.5 md:px-1.5 md:py-1 rounded hover:bg-[var(--color-surface-2)]"
                        onClick={() => void remove(m)}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-[11.5px] text-[var(--color-muted)] mt-3">
        相关设置在每个 Agent 的「记忆」面板里。
        长期没被用到的记忆会自动降低优先级。
        <br />
        要让多个助手共用同一条内容，用「复制到…」—— 复制出的副本单独绑定，原件不受影响。
      </p>

      {copying && (
        <MemoryCopyDialog
          key={copying.id}
          memory={copying}
          agents={agents}
          onClose={() => setCopying(null)}
          onCopied={async () => {
            setCopying(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="card p-3.5">
      <div className="text-[11.5px] text-[var(--color-muted)]">{label}</div>
      <div className="text-[20px] font-semibold mt-1" style={{ color: accent }}>
        {value}
      </div>
    </div>
  );
}

function KindTag({ kind }: { kind: string }) {
  const color = KIND_COLOR[kind] ?? "var(--color-muted)";
  return (
    <span
      className="inline-block px-1.5 py-0.5 rounded text-[10.5px] whitespace-nowrap"
      style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
    >
      {KIND_LABEL[kind] ?? kind}
    </span>
  );
}
