"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { Agent, Memory, MemoryStats } from "@/lib/types";
import { Chip, Empty, PageHead, Row, RowList, Segmented, Toolbar } from "@/components/ui/kit";
import { useFeedback } from "@/components/ui/feedback";
import { MemoryCopyDialog } from "@/components/MemoryCopyDialog";
import { RunIdLink } from "@/components/RunIdLink";

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
  /* 默认**不筛状态**：待确认的才是要用户动手的（现在 10 条里 8 条待确认）。
     默认只显示"在用"= 8 条待办默认看不见，还得手动切筛选 —— 违背「操作更少」。 */
  const [status, setStatus] = useState<string>("");
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
  /** 新增记忆的输入区默认收起：常态只留一个「+ 记一条」按钮，
   *  避免一块空白表单长期占着首屏（数据默认可见 ≠ 表单必须常驻）。 */
  const [composeOpen, setComposeOpen] = useState(false);

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
      fb.success(next === "active" ? "已确认使用" : next === "archived" ? "已停用" : "已丢弃");
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
    <div className="p-4 md:p-6 lg:p-7 max-w-[1000px]">
      <PageHead
        title="记忆"
        desc="跨会话的长期记忆 · 对话前自动回忆起相关的内容；自动总结出来的先进候选区，你点头之后才会被使用"
        actions={
          <button className="btn btn-primary" onClick={() => setComposeOpen((v) => !v)}>
            {composeOpen ? "收起" : "+ 记一条"}
          </button>
        }
      />

      {/* 新增（常态收起，点「+ 记一条」就地展开；打开即聚焦，可以直接打字） */}
      {composeOpen && (
        <div className="card mb-3 p-3">
          <textarea
            autoFocus
            className="input mono text-[12.5px]"
            rows={2}
            placeholder="例如：用户偏好中文回复，不要 emoji。"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          {/* 默认「所有助手都能用」，所以只写内容 + 保存就完事；
              类型与归属属于进阶选项，收进「更多选项」不占视线。 */}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              className="btn btn-primary"
              disabled={busy || !draft.trim()}
              onClick={() => void create()}
            >
              保存
            </button>
            <button
              type="button"
              className="text-[12.5px]"
              style={{ color: "var(--color-muted)" }}
              data-tap
              onClick={() => setShowMore((v) => !v)}
            >
              {showMore ? "▾" : "▸"} 更多选项
            </button>
            <span className="text-[11.5px]" style={{ color: "var(--color-muted)" }}>
              默认所有助手共用
            </span>
          </div>

          {showMore && (
            <div
              className="mt-3 flex flex-wrap items-end gap-3 border-l-2 pl-3"
              style={{ borderColor: "var(--color-border)" }}
            >
              <div>
                <label className="label">类型</label>
                <select
                  className="input w-36"
                  value={draftKind}
                  onChange={(e) => setDraftKind(e.target.value)}
                >
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
      )}

      {/* 工具条一行：状态（点一下即筛，计数就在旁边）+ 归属 + 类型 + 搜索 + 刷新。
          原来是左栏三张卡（状态卡 / 新增卡 / 筛选卡）竖着堆，把主区挤到 1200px 里的右边一窄条。 */}
      <Toolbar>
        <Segmented
          value={status}
          onChange={setStatus}
          options={[
            {
              key: "",
              label: "全部",
              count: stats ? stats.active + stats.candidate + stats.archived : undefined,
            },
            { key: "candidate", label: "待确认", count: stats?.candidate },
            { key: "active", label: "在用", count: stats?.active },
            { key: "archived", label: "已停用", count: stats?.archived },
          ]}
        />
        <select
          className="input h-[36px] w-auto min-w-0"
          title="只看某个助手的记忆"
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
        <select
          className="input h-[36px] w-auto min-w-0"
          title="只看某种类型"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">全部类型</option>
          {Object.entries(KIND_LABEL).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <input
          className="input h-[36px] w-full min-w-0 sm:w-[200px]"
          placeholder="搜索内容…（回车）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load();
          }}
        />
        <button className="btn ml-auto" onClick={() => void load()}>
          刷新
        </button>
      </Toolbar>

      {/* 候选区 —— 自动沉淀的待确认项（确认/丢弃的动作就落在每一行上） */}
      {candidates.length > 0 && (
        <div className="mb-3">
          <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13px] font-medium" style={{ color: "var(--color-warn)" }}>
              候选区 · {candidates.length} 条待确认
            </span>
            <span className="text-[11.5px]" style={{ color: "var(--color-muted)" }}>
              自动提炼的内容要先经你点头，避免噪音干扰
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <button
                className="btn text-[12.5px]"
                disabled={picked.size === 0}
                onClick={() => void bulk("active")}
              >
                确认选中{picked.size > 0 ? `（${picked.size}）` : ""}
              </button>
              <button
                className="btn text-[12.5px]"
                style={{ color: "var(--color-err)" }}
                disabled={picked.size === 0}
                onClick={() => void bulk("archived")}
              >
                丢弃选中
              </button>
            </div>
          </div>
          <RowList>
            {candidates.map((m) => (
              <Row
                key={m.id}
                actions={
                  <>
                    <button
                      type="button"
                      className="btn text-[12.5px]"
                      style={{
                        background: "var(--color-warn)",
                        borderColor: "var(--color-warn)",
                        color: "#fff",
                      }}
                      onClick={() => void setStatusOf(m, "active")}
                    >
                      确认使用
                    </button>
                    <button
                      type="button"
                      className="btn text-[12.5px]"
                      onClick={() => void setStatusOf(m, "archived")}
                    >
                      丢弃
                    </button>
                  </>
                }
              >
                {/* 勾选框仍是 label：点框旁边的空白也算勾选，且不冒泡（勾选 ≠ 别的动作） */}
                <label
                  className="flex h-9 w-6 shrink-0 cursor-pointer items-center justify-center"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    className="h-[17px] w-[17px] accent-[var(--color-accent)]"
                    checked={picked.has(m.id)}
                    onChange={() => togglePick(m.id)}
                  />
                </label>
                <span className="min-w-0 flex-1 basis-[240px]">
                  <span className="block break-words text-[13px]">{m.content}</span>
                  <span
                    className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px]"
                    style={{ color: "var(--color-muted)" }}
                  >
                    <KindTag kind={m.kind} />
                    <span>{m.agent_name ?? "—"}</span>
                    <span>·</span>
                    <span>来自{m.source === "auto" ? "自动提炼" : "手动录入"}</span>
                    {m.source_run_id && (
                      <>
                        <span>·</span>
                        <RunIdLink
                          runId={m.source_run_id}
                          label={m.source_run_id}
                          className="hover:underline"
                        />
                      </>
                    )}
                  </span>
                </span>
              </Row>
            ))}
          </RowList>
        </div>
      )}

      {/* 记忆列表 —— 内容默认**全展开**（表格把内容压进一列窄字里最难读），
          状态用左边条 + 徽章两条视觉通道表达；一行一条，共用一个外框。 */}
      <RowList>
        {loading ? (
          <div className="px-4 py-6 text-[13px]" style={{ color: "var(--color-muted)" }}>
            加载中…
          </div>
        ) : items.filter((m) => !(status === "" && m.status === "candidate")).length === 0 ? (
          <Empty
            title="这里还没有记忆"
            hint="点右上「+ 记一条」手动新增；或打开任意一次执行记录（运行记录 / 对话页 / 助手页都能点开）点「沉淀为记忆」。"
            action={
              <button className="btn btn-primary" onClick={() => setComposeOpen(true)}>
                + 记一条
              </button>
            }
          />
        ) : (
          items
            /* 看「全部」时，待确认的由上面的候选区负责（那里有批量选中），
               这里就不再重复显示一遍；筛到具体状态时才由列表负责。 */
            .filter((m) => !(status === "" && m.status === "candidate"))
            .map((m) => {
              const cand = m.status === "candidate";
              const arch = m.status === "archived";
              return (
                <div
                  key={m.id}
                  data-mem={m.id}
                  className="border-b px-3 py-2.5 last:border-b-0"
                  style={{
                    borderColor: "var(--color-border)",
                    borderLeft: `3px solid ${
                      cand
                        ? "var(--color-warn)"
                        : arch
                          ? "var(--color-border)"
                          : "var(--color-accent)"
                    }`,
                    opacity: arch ? 0.62 : 1,
                  }}
                >
                  <div className="max-w-[780px] whitespace-pre-wrap break-words text-[13px] leading-relaxed">
                    {m.content}
                  </div>

                  <div
                    className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]"
                    style={{ color: "var(--color-muted)" }}
                  >
                    <KindTag kind={m.kind} />
                    {cand ? <Chip tone="warn">待你确认</Chip> : null}
                    {arch ? <Chip tone="muted">已停用</Chip> : null}
                    <span>{m.source === "auto" ? "自动提炼" : "手动录入"}</span>
                    {m.source_run_id && (
                      <>
                        <span>·</span>
                        <RunIdLink
                          runId={m.source_run_id}
                          label={`来源 ${m.source_run_id.slice(0, 12)}…`}
                          className="hover:underline"
                        />
                      </>
                    )}
                    <span>·</span>
                    <span>
                      {m.scope === "global" ? "所有助手共用" : (m.agent_name ?? "（绑定助手已失效）")}
                    </span>
                    <span>·</span>
                    <span
                      title={m.last_hit_at ? `最后使用：${fmt.time(m.last_hit_at)}` : "还没用过"}
                    >
                      用过 {m.hits} 次
                    </span>
                    <span>·</span>
                    <span>{fmt.relative(m.updated_at)}</span>
                  </div>

                  {/* 动作：常用在前、危险靠最右；待确认的一步到位（确认使用 / 丢弃） */}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {cand && (
                      <>
                        <button
                          type="button"
                          className="btn min-h-[36px] text-[11.5px] px-2.5"
                          style={{
                            background: "var(--color-warn)",
                            borderColor: "var(--color-warn)",
                            color: "#fff",
                          }}
                          onClick={() => void setStatusOf(m, "active")}
                        >
                          确认使用
                        </button>
                        <button
                          type="button"
                          className="btn min-h-[36px] text-[11.5px] px-2.5"
                          onClick={() => void setStatusOf(m, "archived")}
                        >
                          丢弃
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="btn min-h-[36px] text-[11.5px] px-2.5"
                      onClick={() => void edit(m)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn min-h-[36px] text-[11.5px] px-2.5"
                      title="复制一份并绑定到别的助手（原件不动）"
                      onClick={() => setCopying(m)}
                    >
                      复制到…
                    </button>
                    {m.status === "active" ? (
                      <button
                        type="button"
                        className="btn min-h-[36px] text-[11.5px] px-2.5"
                        onClick={() => void setStatusOf(m, "archived")}
                      >
                        停用
                      </button>
                    ) : null}
                    {m.status === "archived" ? (
                      <button
                        type="button"
                        className="btn min-h-[36px] text-[11.5px] px-2.5"
                        onClick={() => void setStatusOf(m, "active")}
                      >
                        启用
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="ml-auto min-h-[36px] rounded px-2 text-[11.5px] hover:bg-[var(--color-surface-2)]"
                      style={{ color: "var(--color-err)" }}
                      onClick={() => void remove(m)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              );
            })
        )}
      </RowList>

      <p className="mt-3 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
        相关设置在每个 Agent 的「记忆」面板里；长期没被用到的记忆会自动降低优先级。
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
