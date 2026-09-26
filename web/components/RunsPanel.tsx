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

/**
 * 状态的中文说法。
 *
 * 为什么必须翻：全站中文界面里蹦出一个 `ok`，用户第一反应是"这产品没做完"。
 * 值本身不变（接口、筛选都用英文原值），只在**显示**这一层翻译。
 */
const STATUS_LABEL: Record<string, string> = {
  ok: "完成",
  error: "失败",
  running: "运行中",
  pending: "排队中",
  aborted: "已中断",
  waiting_hitl: "等待确认",
};

/** 用量汇总（今日 / 近 7 天）—— 类型直接取自接口，不手抄一份 */
type Usage = Awaited<ReturnType<typeof api.usage>>;

/**
 * 「全部运行记录」面板 —— 就是原来 Runs 页那张表（类型筛选 / 搜索 / 批量删除 / 按时间清理 / 清空 + 详情弹框）。
 *
 * 为什么抽出来：用户要求「管理全部流程 和 runs 页面功能合并」——
 * 合并后「管理」面板左列有一项置顶的「全部运行记录」，右侧就是这块；
 * 选中某条流程时右侧换成那条流程的执行卡。同一份组件在**两个地方**用：
 *   ① /runs（整页）  ② Playground 顶栏「流程」浮层 —— 一处能力，两个入口，不写两遍。
 */
//: 一页多少条。50 是「看得见一屏内容」与「别一次读上千行」之间的取舍。
const PAGE = 50;

export function RunsPanel() {
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
  /** 记录页里展开了"分派明细"的那些行（容器 id）—— 默认收起，点一下就地展开 */
  const [fanoutOpen, setFanoutOpen] = useState<Set<string>>(new Set());
  /** 哪一路的「重跑」已经被点了一下（等第二下确认 —— 重跑要花钱，不做误触） */
  const [retryArm, setRetryArm] = useState<string | null>(null);

  /** **只重跑分派的这一路**（其它路不动）。重跑记录原地更新，归属不变。 */
  const retryFanoutItem = async (runId: string) => {
    try {
      await api.rerunRun(runId);
      fb.success("已重跑这一路", "只有这一路重来，其它路不动");
      // 稍等一下再刷，让这条记录先变成 running（否则用户会以为没动）
      setTimeout(() => void load(), 800);
    } catch (e) {
      fb.error("重跑失败", e instanceof Error ? e.message : String(e));
    }
  };
  /** 用了多少 / 花了多少（今日 + 近 7 天）—— 与列表同一个请求里取，不额外等一轮 */
  const [usage, setUsage] = useState<Usage | null>(null);
  /** 分页：一页 50 条，「加载更多」往后翻（游标式 —— 翻页时新记录插进来也不会错位） */
  const [hasMore, setHasMore] = useState(false);
  const [serverTotal, setServerTotal] = useState(0);
  const [moreBusy, setMoreBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [u, tl, a] = await Promise.all([
        api.usage(7),
        api.runTimeline({
          kind: kind === "all" ? undefined : kind,
          status: status || undefined,
          agent_id: agentId || undefined,
          q: q.trim() || undefined,
          limit: PAGE,
        }),
        api.agents(),
      ]);
      setUsage(u);
      setItems(tl.items);
      setCounts(tl.counts);
      setHasMore(Boolean(tl.has_more));
      setServerTotal(tl.total ?? tl.items.length);
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

  /** 往后翻一页：拿最后一条做游标（按 id 去重，宁可少显示也不重复） */
  const loadMore = async () => {
    const last = items[items.length - 1];
    if (!last || moreBusy) return;
    setMoreBusy(true);
    try {
      const tl = await api.runTimeline({
        kind: kind === "all" ? undefined : kind,
        status: status || undefined,
        agent_id: agentId || undefined,
        q: q.trim() || undefined,
        limit: PAGE,
        before: last.at,
        before_id: last.id,
      });
      setItems((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...tl.items.filter((x) => !seen.has(x.id))];
      });
      setHasMore(Boolean(tl.has_more));
      setServerTotal(tl.total ?? 0);
    } catch (e) {
      fb.error("加载更多失败", e instanceof Error ? e.message : String(e));
    } finally {
      setMoreBusy(false);
    }
  };

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
    <>
        {/* ── 统计卡带：**放最上面**。用户的第一个问题就是它 ────────────
            「今天跑了多少次、成功率多少、用了多少 token、花了多少钱」——
            四张卡、数字大、一眼读，不用自己数列表。
            没填单价的模型在花费卡里点名提示 —— 不提示的话，合计就是在骗人。 */}
        {usage && (
          <div className="mb-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
            {(() => {
              const cards: { label: string; value: string; sub?: string; subColor?: string }[] = [
                {
                  label: "今日执行",
                  value: String(usage.today.calls),
                  sub: `近 ${usage.days} 天 ${usage.period.calls} 次`,
                },
                {
                  label: "成功率",
                  value: usage.stats?.success_rate != null ? `${usage.stats.success_rate}%` : "—",
                  sub:
                    usage.stats && usage.stats.runs > 0
                      ? `${usage.stats.ok} 成功 · ${usage.stats.failed} 失败`
                      : "暂无执行",
                  subColor: usage.stats && usage.stats.failed > 0 ? "var(--color-err)" : undefined,
                },
                {
                  label: "Token 用量",
                  value: fmt.num(usage.today.tokens_in + usage.today.tokens_out),
                  sub: `今日 · 近 ${usage.days} 天 ${fmt.num(usage.period.tokens_in + usage.period.tokens_out)}`,
                },
                {
                  label: "花费",
                  value: usage.today.cost != null ? fmt.money(usage.today.cost, usage.currency) : "—",
                  sub:
                    usage.period.cost != null
                      ? `近 ${usage.days} 天 ${fmt.money(usage.period.cost, usage.currency)}`
                      : undefined,
                },
              ];
              return cards.map((c) => (
                <div
                  key={c.label}
                  className="rounded-[10px] border px-3.5 py-2.5"
                  style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
                >
                  <div className="text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                    {c.label}
                  </div>
                  <div className="mt-0.5 text-[20px] font-semibold leading-tight tabular-nums">{c.value}</div>
                  {c.sub && (
                    <div className="mt-0.5 truncate text-[11px]" style={{ color: c.subColor ?? "var(--color-muted)" }}>
                      {c.sub}
                    </div>
                  )}
                </div>
              ));
            })()}
            {usage.unpriced.length > 0 && (
              <Link
                href="/credentials#prices"
                className="col-span-2 whitespace-nowrap self-center underline decoration-dotted lg:col-span-4"
                style={{ color: "var(--color-accent)" }}
                title={`这些模型还没填单价：${usage.unpriced.join("、")} —— 填了才算得准`}
              >
                {usage.unpriced.length} 个模型没填单价 · 去填
              </Link>
            )}
          </div>
        )}

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
            <>
            {/* ── 手机（<lg）：卡片流 ──────────────────────────────────
                8 列表格在 390px 上必然横向滚动（min-w-[880px]），来回拖是在惩罚手指。
                手机上信息按「一眼要什么」重排：第一行 = 状态 + 类型 + 时间，
                第二行 = 主体（标题 + 模型），第三行 = 摘要/错误，右下 = token/金额。
                点卡片开详情 —— 与桌面表格同一动作。 */}
            <div className="lg:hidden p-2 flex flex-col gap-2">
              {items.map((it) => {
                const live = LIVE.includes(it.status);
                return (
                  <div
                    key={it.id}
                    className="rounded-[10px] border p-2.5"
                    style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
                    onClick={() => setOpen(it)}
                    role="button"
                  >
                    <div className="flex items-center gap-2 text-[11.5px]">
                      <span className="font-medium whitespace-nowrap" style={{ color: STATUS_STYLE[it.status] ?? "" }}>
                        {live && "● "}{STATUS_LABEL[it.status] ?? it.status}
                      </span>
                      <span
                        className="rounded px-1.5 py-px"
                        style={{ background: "color-mix(in srgb, var(--color-accent) 10%, transparent)", color: "var(--color-accent)" }}
                      >
                        {KIND_LABEL[it.kind]}
                      </span>
                      {it.trigger && (
                        <span className="rounded px-1.5 py-px" style={{ background: "color-mix(in srgb, var(--color-warn) 14%, transparent)", color: "var(--color-warn)" }}>
                          {it.trigger === "schedule" ? "定时" : "外部"}
                        </span>
                      )}
                      <span className="ml-auto tabular-nums" style={{ color: "var(--color-muted)" }}>
                        {new Date(it.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}
                      </span>
                    </div>
                    <div className="mt-1.5 text-[13px] font-medium truncate">{it.title}</div>
                    {(it.model || it.duration_ms != null) && it.kind !== "llm_test" && (
                      <div className="mt-0.5 text-[11px] truncate" style={{ color: "var(--color-muted)" }}>
                        {it.model && <span className="mono">{it.model}</span>}
                        {it.model && it.duration_ms != null ? " · " : ""}
                        {it.duration_ms != null ? fmt.ms(it.duration_ms) : ""}
                      </div>
                    )}
                    {(it.summary || it.error) && (
                      <div className="mt-1 text-[12px] line-clamp-2" style={{ color: it.error ? "var(--color-err)" : "var(--color-muted)" }}>
                        {it.error ? `✗ ${it.error}` : it.summary}
                      </div>
                    )}
                    <div className="mt-1.5 flex items-center gap-2 text-[11.5px] tabular-nums" style={{ color: "var(--color-muted)" }}>
                      {(it.tokens_in || it.tokens_out) && <span>{fmt.num(it.tokens_in)} / {fmt.num(it.tokens_out)}</span>}
                      <span className="ml-auto" style={{ color: it.cost == null ? "var(--color-muted)" : "var(--color-text)" }}>
                        {fmt.money(it.cost, it.currency ?? "¥")}
                      </span>
                    </div>
                    {it.fanout && (
                      <button
                        type="button"
                        className="mt-1.5 rounded-full px-1.5 py-[1px] text-[11px]"
                        style={{
                          border: `1px solid color-mix(in srgb, ${it.fanout.failed ? "var(--color-err)" : "var(--color-accent)"} 34%, transparent)`,
                          color: it.fanout.failed ? "var(--color-err)" : "var(--color-accent)",
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setFanoutOpen((s) => {
                            const next = new Set(s);
                            if (next.has(it.id)) next.delete(it.id);
                            else next.add(it.id);
                            return next;
                          });
                        }}
                      >
                        分派 {it.fanout.total} 路 · {it.fanout.ok} 成功{it.fanout.failed ? ` · ${it.fanout.failed} 失败` : ""}
                      </button>
                    )}
                    {!live && (
                      <input
                        type="checkbox"
                        checked={selected.has(it.id)}
                        onChange={() => toggle(it.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="absolute mt-0.5 accent-[var(--color-accent)]"
                        style={{ marginLeft: "calc(100% - 18px)", marginTop: "-2px" }}
                      />
                    )}
                    {it.fanout && fanoutOpen.has(it.id) && (
                      <div className="mt-2 flex flex-col gap-1 border-t pt-2" style={{ borderColor: "var(--color-border)" }}>
                        {it.fanout.items.map((f) => (
                          <div key={f.index} className="flex items-center gap-2 text-[12px]">
                            <span className="shrink-0" style={{ color: f.status === "ok" ? "var(--color-ok)" : f.status === "error" || f.status === "aborted" ? "var(--color-err)" : "var(--color-accent)" }}>
                              {f.status === "ok" ? "✓" : f.status === "error" || f.status === "aborted" ? "✕" : "◌"}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{f.label || `第 ${f.index + 1} 项`}</span>
                            {f.duration_ms ? <span className="shrink-0 tabular-nums" style={{ color: "var(--color-muted)" }}>{(f.duration_ms / 1000).toFixed(1)}s</span> : null}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* ── 桌面（≥lg）：表格 ─────────────────────────────────── */}
            <table className="hidden lg:table w-full min-w-[880px] text-[12.5px]">
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
                  <th className="text-right px-3 py-2.5 font-medium w-28">Tokens</th>
                  <th className="text-right px-3 py-2.5 font-medium w-24">金额</th>
                  <th className="text-left px-3 py-2.5 font-medium">摘要</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const live = LIVE.includes(it.status);
                  // 一个 item 可能渲染**两行**（主行 + 分派的各路展开行）→ 用 Fragment 包起来
                  return (
                    <>
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
                        {/* 固定 zh-CN + 24 小时制：之前不传 locale，中文界面里
                            会冒出 "06:34:55 AM" —— 数字格式也是产品的一部分（用户会看出来）。 */}
                        {new Date(it.at).toLocaleString("zh-CN", {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                          hour12: false,
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
                        {/* 自动运行的记录要标出来 —— 用户看记录时最想分清
                            "哪些是我点的、哪些是它自己跑的 / 别的系统调起来的" */}
                        {it.trigger && (
                          <span
                            className="ml-1.5 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px]"
                            style={{
                              background: "color-mix(in srgb, var(--color-warn) 14%, transparent)",
                              color: "var(--color-warn)",
                            }}
                            title={
                              it.trigger === "schedule"
                                ? "定时自动发起的执行（不是人点的）"
                                : "外部系统调用触发地址发起的执行"
                            }
                          >
                            {it.trigger === "schedule" ? "定时" : "外部"}
                          </span>
                        )}
                        {/* 编排执行额外给个「以流程查看」：直接进 Playground 的历史回放，
                            用画布看那次的图 —— 而不是在这里弹一个五页签的日志框 */}
                        {it.kind === "playground" && it.orchestration_id && (
                          <Link
                            href={`/playground?history=${it.orchestration_id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="ml-1.5 whitespace-nowrap text-[11px] underline decoration-dotted"
                            style={{ color: "var(--color-accent)" }}
                            title="用画布看这次执行（哪一步在跑、跑成什么样）"
                          >
                            以流程查看
                          </Link>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="truncate max-w-[240px]">{it.title}</div>
                        {/* 耗时**不再单占一列**（用户："耗时不需要单独输出，
                            应该在输入、输出的每项中提示，不用太割裂显示"）。
                            它属于这条记录本身，就跟名字 / 模型同处一格，小灰字。 */}
                        <div className="text-[11px] text-[var(--color-muted)] truncate">
                          {it.model && it.kind !== "llm_test" ? <span className="mono">{it.model}</span> : null}
                          {it.model && it.kind !== "llm_test" && it.duration_ms != null ? " · " : null}
                          {it.duration_ms != null ? fmt.ms(it.duration_ms) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className="whitespace-nowrap"
                          title={`状态值：${it.status}`}
                          style={{ color: STATUS_STYLE[it.status] ?? "" }}
                        >
                          {live && "● "}
                          {STATUS_LABEL[it.status] ?? it.status}
                        </span>
                      </td>
                      <td
                        className="px-3 py-2.5 text-right whitespace-nowrap"
                        style={{ color: "var(--color-muted)" }}
                        title={`输入 ${it.tokens_in} · 输出 ${it.tokens_out}`}
                      >
                        {it.tokens_in || it.tokens_out ? (
                          <>
                            <span style={{ color: "var(--color-text)" }}>{fmt.num(it.tokens_in)}</span>
                            <span> / {fmt.num(it.tokens_out)}</span>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <span
                          title={
                            it.cost == null
                              ? it.model
                                ? `${it.model} 还没填单价 —— 去「LLM 配置 → 单价」填两个数就会显示金额`
                                : "这条没有模型信息，算不出金额"
                              : "按「LLM 配置 → 单价」里的价格折算"
                          }
                          style={{ color: it.cost == null ? "var(--color-muted)" : "var(--color-text)" }}
                        >
                          {fmt.money(it.cost, it.currency ?? "¥")}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-[var(--color-muted)]">
                        <div className="flex items-center gap-2">
                          <div className="min-w-0 flex-1 truncate max-w-[320px]">
                            {it.error ? (
                              <span className="text-[var(--color-err)]">✗ {it.error}</span>
                            ) : (
                              it.summary ?? "—"
                            )}
                          </div>
                          {/* **分派**：这一步分了几路。记录页一条 = 一件事，
                              分出去的每一路不单独占一行（否则同一批把列表刷满），
                              点这里就地展开 —— 与画布上的叠卡同一套语义。 */}
                          {it.fanout && (
                            <button
                              type="button"
                              className="shrink-0 rounded-full px-1.5 py-[1px] text-[11px] whitespace-nowrap"
                              style={{
                                border: `1px solid color-mix(in srgb, ${it.fanout.failed ? "var(--color-err)" : "var(--color-accent)"} 34%, transparent)`,
                                color: it.fanout.failed ? "var(--color-err)" : "var(--color-accent)",
                                background: `color-mix(in srgb, ${it.fanout.failed ? "var(--color-err)" : "var(--color-accent)"} 10%, transparent)`,
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setFanoutOpen((s) => {
                                  const next = new Set(s);
                                  if (next.has(it.id)) next.delete(it.id);
                                  else next.add(it.id);
                                  return next;
                                });
                              }}
                            >
                              分派 {it.fanout.total} 路 · {it.fanout.ok} 成功
                              {it.fanout.failed ? ` · ${it.fanout.failed} 失败` : ""}
                              {(() => {
                                const w = it.fanout.items.filter((x) => x.status === "waiting_hitl").length;
                                return w ? ` · ${w} 等你确认` : "";
                              })()}
                              {fanoutOpen.has(it.id) ? " ▾" : " ▸"}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {it.fanout && fanoutOpen.has(it.id) && (
                      <tr className="bg-[var(--color-surface-2)]">
                        <td colSpan={8} className="px-3 pb-3 pt-1">
                          <div className="mb-1 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                            这一步分派出去的 {it.fanout.total} 路
                            {it.fanout.tokens_in + it.fanout.tokens_out > 0 &&
                              ` · 合计 ${fmt.num(it.fanout.tokens_in + it.fanout.tokens_out)} token`}
                            （每一路都是独立执行，可单独重跑）
                          </div>
                          <div className="flex flex-col gap-1">
                            {it.fanout.items.map((f) => (
                              <div
                                key={f.index}
                                className="flex items-center gap-2 rounded-[6px] border px-2 py-1 text-[12px]"
                                style={{
                                  borderColor: "var(--color-border)",
                                  background: "var(--color-surface)",
                                }}
                              >
                                <span
                                  className="shrink-0"
                                  style={{
                                    color:
                                      f.status === "ok"
                                        ? "var(--color-ok)"
                                        : f.status === "error" || f.status === "aborted"
                                          ? "var(--color-err)"
                                          : "var(--color-accent)",
                                  }}
                                >
                                  {f.status === "ok" ? "✓" : f.status === "error" || f.status === "aborted" ? "✕" : "◌"}
                                </span>
                                <span className="min-w-0 flex-1 truncate">{f.label || `第 ${f.index + 1} 项`}</span>
                                {f.status === "waiting_hitl" && (
                                  <span className="shrink-0" style={{ color: "var(--color-warn)" }}>
                                    等你确认
                                  </span>
                                )}
                                {f.tokens_in + f.tokens_out > 0 && (
                                  <span className="shrink-0 tabular-nums" style={{ color: "var(--color-muted)" }}>
                                    {fmt.num(f.tokens_in + f.tokens_out)} token
                                  </span>
                                )}
                                {f.duration_ms ? (
                                  <span className="shrink-0 tabular-nums" style={{ color: "var(--color-muted)" }}>
                                    {(f.duration_ms / 1000).toFixed(1)}s
                                  </span>
                                ) : null}
                                {f.status !== "ok" && (
                                  <button
                                    type="button"
                                    className="shrink-0 rounded-[5px] px-1.5 py-[1px] text-[11px]"
                                    style={{
                                      color: retryArm === f.index + ":" + it.id ? "var(--color-err)" : "var(--color-accent)",
                                      border: `1px solid color-mix(in srgb, ${retryArm === f.index + ":" + it.id ? "var(--color-err)" : "var(--color-accent)"} 34%, transparent)`,
                                    }}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const key = f.index + ":" + it.id;
                                      if (retryArm === key) {
                                        setRetryArm(null);
                                        void retryFanoutItem(f.run_id);
                                      } else {
                                        setRetryArm(key);
                                      }
                                    }}
                                  >
                                    {retryArm === f.index + ":" + it.id ? "确认重跑？" : "重跑"}
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                    </>
                  );
                })}
              </tbody>
            </table>
            </>
          )}

          {/* 分页：一页 50 条。不摆页码 —— 记录一直在新增，页码会错位，
              用户要的其实是"还有没有、还有多少"（见后端 timeline 的注释）。 */}
          {!loading && items.length > 0 && (
            <div className="mt-3 flex items-center justify-center gap-3 text-[12.5px]">
              {hasMore ? (
                <>
                  <button
                    type="button"
                    onClick={() => void loadMore()}
                    disabled={moreBusy}
                    className="rounded-[8px] border px-3 py-1.5 disabled:opacity-50"
                    style={{ borderColor: "var(--color-border)" }}
                  >
                    {moreBusy ? "加载中…" : `加载更多（还有 ${Math.max(serverTotal - items.length, 0)} 条）`}
                  </button>
                  <span style={{ color: "var(--color-muted)" }}>
                    已显示 {items.length} / {serverTotal}
                  </span>
                </>
              ) : (
                <span style={{ color: "var(--color-muted)" }}>
                  共 {serverTotal} 条，已到底
                </span>
              )}
            </div>
          )}
        </div>

        {open && (
          <RunDetailDialog item={open} onClose={() => setOpen(null)} onDeleted={() => void load()} />
        )}
    </>
  );
}
