"use client";

/**
 * 记忆（长期记忆管理）
 * ====================
 *
 * 2026-09-28 以专业 UX 重写。改的是**结构**，不是样式：
 *
 * ① 一行数字代替卡带
 *    标题下就是一句概览（共 N 条 · 在用 / 待确认 / 已停用 · 累计被用 N 次），
 *    不再让统计各占一张卡。
 *
 * ② 一行一对象 + 点哪展开哪
 *    老版每一条记忆都把「完整正文 + 6 个动作按钮」全摊在页面上，看一眼是
 *    一堵按钮墙；候选记忆还要在「候选区」和主列表两个地方各渲染一次，
 *    同一条内容在「全部」里看得见、切一下就换位置 ✗。
 *    新版：一条记忆 = 一行（类型 + 正文两行 + 元信息），点行进**就地展开**
 *    看完整正文与全部明细；动作区常驻可见（用户否决过收进 ⋯），层级分明：
 *    主操作蓝 → 次级安静 → 删除红字靠最右。
 *
 * ③ 批量动作就地出现
 *    候选行左侧是勾选框，勾上之后**在这批行的正上方**出现一条选择条
 *    （已选 N 条 · 确认使用 · 丢弃 · 取消）—— 动作跟着它作用的对象走，
 *    不再占着工具条常年空转。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { Agent, Memory, MemoryStats } from "@/lib/types";
import { Chip, Empty, KV, PageHead, Row, RowDetail, RowList, Segmented, Toolbar } from "@/components/ui/kit";
import { useFeedback } from "@/components/ui/feedback";
import { MemoryCopyDialog } from "@/components/MemoryCopyDialog";
import { isImeEvent } from "@/lib/ime";
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

export default function MemoriesPage() {
  const fb = useFeedback();
  const [items, setItems] = useState<Memory[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);

  // 筛选
  /* 默认**不筛状态**：待确认的才是要用户动手的，默认藏起来等于把待办藏起来。 */
  const [status, setStatus] = useState<string>("");
  const [agentId, setAgentId] = useState("");
  const [kind, setKind] = useState("");
  const [query, setQuery] = useState("");

  /** 展开中那条（一行一对象：详情就在这一行下面展开） */
  const [openId, setOpenId] = useState<string>("");

  // 候选多选
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // 新建
  const [draft, setDraft] = useState("");
  const [draftKind, setDraftKind] = useState("fact");
  /** 新记忆归给谁："" = 所有助手共用，否则是某个 Agent 的 id */
  const [draftOwner, setDraftOwner] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 正在复制哪条记忆（null = 没在复制） */
  const [copying, setCopying] = useState<Memory | null>(null);
  /** 新增区默认收起：常态只留一个「+ 记一条」（信息默认可见 ≠ 表单必须常驻） */
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
    const isGlobal = draftOwner === "";
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
          : "丢弃后不再被使用（之后能在「已停用」里找回）。",
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

  /** 选择条上的「全选待确认」—— 把剩下的候选一次勾上（10 条候选不用点 10 次） */
  const pickAllCandidates = () =>
    setPicked((prev) =>
      prev.size === candidates.length ? new Set() : new Set(candidates.map((c) => c.id)),
    );

  return (
    <div className="max-w-[1000px] p-4 md:p-6 lg:p-7">
      <PageHead
        title="记忆"
        desc={
          <>
            跨会话的长期记忆 —— 对话前自动回忆起相关的内容。
            {stats ? (
              <>
                {" "}
                共 <Num n={stats.active + stats.candidate + stats.archived} /> 条（在用{" "}
                <Num n={stats.active} /> · 待确认 <Num n={stats.candidate} tone="warn" /> · 已停用{" "}
                <Num n={stats.archived} />）· 累计被用 <Num n={stats.total_hits} /> 次
              </>
            ) : null}
          </>
        }
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
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button className="btn btn-primary" disabled={busy || !draft.trim()} onClick={() => void create()}>
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
                  <option value="">所有助手共用</option>
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

      {/* 工具条：状态（点一下即筛、带计数）+ 归属 + 类型 + 搜索 + 刷新 */}
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
          className="input h-[36px] min-w-0"
          style={{ width: "auto" }}
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
          className="input h-[36px] min-w-0"
          style={{ width: "auto" }}
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
          className="input h-[36px] min-w-0 w-full sm:w-[200px]!"
          placeholder="搜索内容…（回车）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // 中文组字中的回车是选字 —— 别拿它触发搜索
            if (e.key === "Enter" && !isImeEvent(e)) void load();
          }}
        />
        <button className="btn ml-auto" onClick={() => void load()}>
          刷新
        </button>
      </Toolbar>

      {/* 选择条 —— 勾了候选行才出现，就落在这批行的上方（动作跟着对象走） */}
      {picked.size > 0 && (
        <div
          className="mb-2 flex flex-wrap items-center gap-2 rounded-[10px] px-3 py-2"
          style={{ background: "color-mix(in srgb, var(--color-accent) 8%, transparent)" }}
        >
          <span className="text-[12.5px]">已选 {picked.size} 条</span>
          <button className="btn btn-primary text-[12.5px]" onClick={() => void bulk("active")}>
            确认使用
          </button>
          <button
            className="btn text-[12.5px]"
            style={{ color: "var(--color-err)" }}
            onClick={() => void bulk("archived")}
          >
            丢弃
          </button>
          <button
            className="btn text-[12.5px]"
            style={{ color: "var(--color-muted)" }}
            onClick={() => setPicked(new Set())}
          >
            取消选择
          </button>
          {candidates.length > 1 && (
            <button
              className="btn text-[12.5px]"
              style={{ color: "var(--color-muted)" }}
              onClick={pickAllCandidates}
            >
              {picked.size === candidates.length ? "取消全选" : `全选待确认（${candidates.length}）`}
            </button>
          )}
        </div>
      )}

      {/* 一行一对象：一条记忆一行；点行就地展开全部明细 */}
      <RowList>
        {loading ? (
          <div className="px-4 py-6 text-[13px]" style={{ color: "var(--color-muted)" }}>
            加载中…
          </div>
        ) : items.length === 0 ? (
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
          items.map((m) => {
            const cand = m.status === "candidate";
            const arch = m.status === "archived";
            const open = openId === m.id;
            return (
              <div key={m.id} data-mem={m.id}>
                <Row
                  expanded={open}
                  onToggle={() => setOpenId(open ? "" : m.id)}
                  actions={
                    <>
                      {cand && (
                        <>
                          <button
                            type="button"
                            className="btn btn-primary min-h-[36px] px-2.5 text-[11.5px]"
                            onClick={() => void setStatusOf(m, "active")}
                          >
                            确认使用
                          </button>
                          <button
                            type="button"
                            className="btn min-h-[36px] px-2.5 text-[11.5px]"
                            onClick={() => void setStatusOf(m, "archived")}
                          >
                            丢弃
                          </button>
                        </>
                      )}
                      {m.status === "active" && (
                        <button
                          type="button"
                          className="btn min-h-[36px] px-2.5 text-[11.5px]"
                          title="暂时不用它 —— 之后能在「已停用」里找回"
                          onClick={() => void setStatusOf(m, "archived")}
                        >
                          停用
                        </button>
                      )}
                      {arch && (
                        <button
                          type="button"
                          className="btn min-h-[36px] px-2.5 text-[11.5px]"
                          onClick={() => void setStatusOf(m, "active")}
                        >
                          启用
                        </button>
                      )}
                      <button
                        type="button"
                        className="min-h-[36px] rounded px-2 text-[11.5px] hover:bg-[var(--color-surface-2)]"
                        style={{ color: "var(--color-err)" }}
                        onClick={() => void remove(m)}
                      >
                        删除
                      </button>
                    </>
                  }
                >
                  {/* 勾选框只给候选行：批量确认/丢弃是候选区唯一的批量语义 */}
                  {cand ? (
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
                  ) : null}

                  <span className="min-w-0 flex-1 basis-[260px]">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <KindTag kind={m.kind} />
                      {cand ? <Chip tone="warn">待确认</Chip> : null}
                      {arch ? <Chip tone="muted">已停用</Chip> : null}
                      <span
                        className="line-clamp-2 min-w-0 flex-1 text-[13.5px] leading-snug"
                        style={{ color: arch ? "var(--color-muted)" : undefined }}
                        title={m.content}
                      >
                        {m.content}
                      </span>
                    </span>
                    <span
                      className="mt-0.5 block text-[11.5px]"
                      style={{ color: "var(--color-muted)" }}
                    >
                      {m.scope === "global" ? "所有助手共用" : (m.agent_name ?? "（绑定助手已失效）")}
                      {" · "}
                      {m.source === "auto" ? "自动提炼" : "手动录入"}
                      {" · 用过 "}
                      {m.hits} 次
                      {" · "}
                      {fmt.relative(m.updated_at)}
                    </span>
                  </span>

                  <span className="shrink-0 text-[11px]" style={{ color: "var(--color-muted)" }}>
                    {open ? "▾" : "▸"}
                  </span>
                </Row>

                {open && (
                  <RowDetail>
                    <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
                      {m.content}
                    </div>

                    <div className="mt-3 grid gap-1.5 md:grid-cols-2">
                      <KV k="类型">{KIND_LABEL[m.kind] ?? m.kind}</KV>
                      <KV k="归谁">
                        {m.scope === "global" ? "所有助手共用" : (m.agent_name ?? "（绑定助手已失效）")}
                      </KV>
                      <KV k="来源">
                        {m.source === "auto" ? "自动提炼" : m.source === "import" ? "导入" : "手动录入"}
                        {m.source_run_id ? (
                          <>
                            {" "}
                            <span style={{ color: "var(--color-muted)" }}>来自</span>{" "}
                            <RunIdLink
                              runId={m.source_run_id}
                              label={`${m.source_run_id.slice(0, 16)}…`}
                              className="hover:underline"
                            />
                          </>
                        ) : null}
                      </KV>
                      <KV k="被使用">
                        {m.hits} 次
                        <span style={{ color: "var(--color-muted)" }}>
                          {m.last_hit_at ? ` · 最后 ${fmt.relative(m.last_hit_at)}` : " · 还没用过"}
                        </span>
                      </KV>
                      <KV k="重要度">{m.importance}</KV>
                      <KV k="有效期">
                        {m.ttl_s ? `${Math.round(m.ttl_s / 86400)} 天` : "长期有效"}
                      </KV>
                      <KV k="更新">
                        {fmt.time(m.updated_at)}
                        <span style={{ color: "var(--color-muted)" }}>
                          {" "}
                          · 创建 {fmt.relative(m.created_at)}
                        </span>
                      </KV>
                      <KV k="编号">
                        <span className="mono text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                          {m.id}
                        </span>
                      </KV>
                    </div>

                    {/* 次级动作放在展开区：常用动作（确认/停用/删除）留在行上常驻 */}
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        className="btn min-h-[36px] px-2.5 text-[11.5px]"
                        onClick={() => void edit(m)}
                      >
                        编辑内容
                      </button>
                      <button
                        type="button"
                        className="btn min-h-[36px] px-2.5 text-[11.5px]"
                        title="复制一份并绑定到别的助手（原件不动）"
                        onClick={() => setCopying(m)}
                      >
                        复制到别的助手…
                      </button>
                    </div>
                  </RowDetail>
                )}
              </div>
            );
          })
        )}
      </RowList>

      <p className="mt-3 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
        相关设置在每个 Agent 的「记忆」面板里；长期没被用到的记忆会自动降低优先级。
        <br />
        要让多个助手共用同一条内容，用「复制到别的助手…」—— 复制出的副本单独绑定，原件不受影响。
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

/** 概览里的数字（等宽、强调色，避免一长串灰字的计数看不清） */
function Num({ n, tone }: { n: number; tone?: "warn" }) {
  return (
    <span
      className="tabular-nums"
      style={{ color: tone === "warn" ? "var(--color-warn)" : "var(--color-text)", fontWeight: 500 }}
    >
      {fmt.int(n)}
    </span>
  );
}

function KindTag({ kind }: { kind: string }) {
  const color = KIND_COLOR[kind] ?? "var(--color-muted)";
  return (
    <span
      className="inline-block shrink-0 rounded px-1.5 py-0.5 text-[10.5px] whitespace-nowrap"
      style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
    >
      {KIND_LABEL[kind] ?? kind}
    </span>
  );
}
