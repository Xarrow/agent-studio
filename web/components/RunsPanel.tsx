"use client";

/**
 * 运行记录 —— 三类调用合成一条时间线（重写版）。
 *
 * 为什么要合并（产品视角）
 * ----------------------
 * 平台上会产生三类"调用":
 *   · LLM 测试   在「LLM 配置」里直接跟模型聊两句（验证 key/模型本身）
 *   · 助手试跑   在助手详情页「试跑与观测」里跑一次（验证配置）
 *   · 正式使用   在「Agent 执行」里对话、或多 Agent 编排干活
 * 对用户来说这些是同一件事的不同场合：**我发起过一次调用，结果如何**。
 *
 * 重写要点（2026-09-27，「管理」页范式样板）
 * -----------------------------------------
 * 老版把「统计卡带 + 类型筛选 + 三个下拉 + 三颗按钮 + 表格 + 手机卡片流」
 * 垂直堆成一大坨，看详情还要再弹一个 RunDetailDialog。三处都撞在设计总纲
 * 「操作更少、看到更多」上：
 *
 *   ① 四张大统计卡 → 收成工具条右侧**一行数字**（今日次数 / 成功率 / token / 花费），
 *      数字一个不少，纵向省下 90px；
 *   ② 筛选与批量操作拆成两行 → 合进**一条工具条**，清理类动作收进「⋯」菜单
 *      （自研菜单，不用原生 confirm/alert）；
 *   ③ 桌面表格 + 手机卡片两套实现 → 合并成**一套行列表**（响应式自动换行），
 *      点行**就地展开**：摘要/错误全文、分派每一路、执行过程时间线全在原地，
 *      **不再弹窗**（不跳页、不跳窗，滚动位置与筛选状态都不丢）。
 *
 * 两个入口共用这份组件：① /runs（「管理」整页）② Playground 顶栏「流程」浮层。
 */

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { ActivityItem, Agent, LlmCall, RunDeleteResult } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { KIND_LABEL } from "@/components/RunDetailDialog";
import { SpanWaterfall } from "@/components/SpanWaterfall";
import type { Span } from "@/lib/types";
import { RunTimeline, eventsToSteps, type Step } from "@/components/ui/run-timeline";
import { Mermaid } from "@/components/Mermaid";
import { LlmCallsPanel } from "@/components/LlmCallsPanel";

/**
 * 把一次分派画成调用链（Mermaid 源码）。
 *
 * 为什么画图而不只是列表：fork 出来的每一路可能是**另一个助手**在干活，
 * 列表只有一行行 label，看不出"谁派给谁"；一张链图把"父助手 → N 个子助手"
 * 的血缘一次说清（节点名 = 助手名 + 第几路 + 结果）。图由 Mermaid 组件自动布局。
 */
function dispatchChain(it: ActivityItem, nameOf: (id: string | null) => string): string | null {
  const f = it.fanout;
  if (!f || f.items.length === 0) return null;
  if (it.kind === "chat") return null; // 会话轮次不是分派（同一个助手接着聊）
  const mark = (s: string) => (s === "ok" ? " ✓" : s === "error" || s === "aborted" ? " ✕" : " …");
  const safe = (s: string) => s.replace(/[[\]{}()|>]/g, " ").trim() || "助手";
  const parent = safe(nameOf(it.agent_id) || "发起方");
  const lines = ["flowchart TD", `  P[${parent}]`];
  f.items.forEach((x, i) => {
    const who = safe(x.agent_name || parent);
    const tag = x.label ? `·${x.label.slice(0, 8)}` : "";
    lines.push(`  P --> N${i}[${who}${tag}${mark(x.status)}]`);
  });
  return lines.join("\n");
}

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
  // 「对话」→「Agent」：这些记录本来就是"某个 Agent 被跑了一次"，
  // 「编排」筛选去掉（编排已从产品里退役，旧记录仍在「全部」里可见）
  { key: "chat", label: "Agent" },
  // 远端执行单独一档：跨平台的调用要看得出"这不是本地跑的"
  { key: "a2a", label: "A2A 远端" },
];

/** 运行中的记录不给删（删了状态就永远悬着） */
const LIVE = ["running", "pending", "waiting_hitl"];

/**
 * 状态的中文说法。值本身不变（接口、筛选都用英文原值），只在**显示**这一层翻译 ——
 * 全站中文界面里蹦出一个 `ok`，用户第一反应是"这产品没做完"。
 */
const STATUS_LABEL: Record<string, string> = {
  ok: "完成",
  error: "失败",
  running: "运行中",
  pending: "排队中",
  aborted: "已中断",
  waiting_hitl: "等待确认",
};

/** 用量汇总（今日 / 近 N 天）—— 类型直接取自接口，不手抄一份 */
type Usage = Awaited<ReturnType<typeof api.usage>>;
type Evts = Awaited<ReturnType<typeof api.runEvents>>;

/** 就地展开的执行过程 + 耗时瀑布（懒加载：点了才拉，不点不请求） */
type Detail = {
  loading: boolean;
  steps?: Step[];
  spans?: Span[];
  /** 每次模型调用的元数据（原文按需拉，见 LlmCallsPanel） */
  llmCalls?: LlmCall[];
  note?: string;
};

//: 一页多少条。50 是「看得见一屏内容」与「别一次读上千行」之间的取舍。
const PAGE = 50;

export function RunsPanel() {
  const fb = useFeedback();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [agents, setAgents] = useState<Agent[]>([]);
  /** id → 助手名：调用链图上要显示名字而不是 id（用已加载的列表，不额外请求） */
  const agentNameOf = useCallback(
    (id: string | null) => (id ? (agents.find((a) => a.id === id)?.name ?? "") : ""),
    [agents],
  );
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("");
  const [agentId, setAgentId] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  /** 就地展开的那些行（运行 id）—— 默认收起，点一下展开，不必离开列表 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** 展开行拉到的执行过程（按 run id 缓存，收起再展开不重复请求） */
  const [details, setDetails] = useState<Record<string, Detail>>({});
  /** 「⋯」清理菜单 */
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** 哪一路的「重跑」已经被点了一下（等第二下确认 —— 重跑要花钱，不做误触） */
  const [retryArm, setRetryArm] = useState<string | null>(null);
  /** 用了多少 / 花了多少（今日 + 近 7 天）—— 与列表同一个请求里取，不额外等一轮 */
  const [usage, setUsage] = useState<Usage | null>(null);
  /** 分页：一页 50 条，「加载更多」往后翻（游标式 —— 翻页时新记录插进来也不会错位） */
  const [hasMore, setHasMore] = useState(false);
  const [serverTotal, setServerTotal] = useState(0);
  const [moreBusy, setMoreBusy] = useState(false);

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
      setExpanded(new Set());
      setDetails({});
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

  /** 点「⋯」以外的地方收起菜单 */
  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [menu]);

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

  /**
   * 点一行 = 就地展开/收起。展开时**才**去拉这条的执行过程（懒加载），
   * 并缓存住 —— 反复开合不会重复请求。
   */
  const toggleRow = (it: ActivityItem) => {
    const willOpen = !expanded.has(it.id);
    setExpanded((s) => {
      const next = new Set(s);
      if (willOpen) next.add(it.id);
      else next.delete(it.id);
      return next;
    });
    if (!willOpen || details[it.id]) return;
    if (it.kind === "llm_test") {
      setDetails((d) => ({
        ...d,
        [it.id]: { loading: false, note: "LLM 测试只验证「key 能不能用」，没有执行过程可看。" },
      }));
      return;
    }
    setDetails((d) => ({ ...d, [it.id]: { loading: true } }));
    void (async () => {
      try {
        // 两个请求一起发：事件流（分色过程）+ trace（耗时瀑布）。瀑布在旧详情
        // 弹窗里有、重写成就地展开时被落下了 —— 「这条为什么慢 3 分钟」没有它答不了。
        const [evts, trace] = await Promise.all([
          api.runEvents(it.id) as unknown as Promise<Evts>,
          api.runTrace(it.id).catch(() => null),
        ]);
        setDetails((d) => ({
          ...d,
          [it.id]: {
            loading: false,
            steps: eventsToSteps(evts, it.title),
            spans: (trace as { spans?: Span[] } | null)?.spans,
            llmCalls: (trace as { llm_calls?: LlmCall[] } | null)?.llm_calls,
          },
        }));
      } catch (e) {
        setDetails((d) => ({
          ...d,
          [it.id]: { loading: false, note: e instanceof Error ? e.message : String(e) },
        }));
      }
    })();
  };

  const report = (label: string, r: RunDeleteResult) => {
    const skipped = r.skipped.filter((s) => s.reason !== "dry_run（未删除）").length;
    fb.success(`${label}：已删除 ${r.deleted} 条` + (skipped ? `，跳过 ${skipped} 条` : ""));
  };

  const deleteSelected = async () => {
    setMenu(false);
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
    setMenu(false);
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
    setMenu(false);
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
    <div className="flex flex-col gap-2.5">
      {/* ── 工具条（一行）：类型段控 · 搜索 · 状态 · 助手 · 用量 · ⋯ ──────
          老版这里是「四张统计卡 + 类型筛选 + 三个下拉 + 三颗按钮」四行；
          收成一行之后，纵向空间全还给列表（操作更少、看到更多）。 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div
          className="flex items-center gap-0.5 rounded-[10px] border p-0.5"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
        >
          {KIND_TABS.map((t) => {
            const n = t.key === "all" ? total : (counts[t.key] ?? 0);
            const on = kind === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setKind(t.key)}
                className="min-h-[36px] whitespace-nowrap rounded-[7px] px-2.5 text-[12.5px] transition-colors"
                style={{
                  background: on ? "var(--color-accent)" : undefined,
                  color: on ? "#fff" : "var(--color-muted)",
                  fontWeight: on ? 500 : undefined,
                }}
              >
                {t.label}
                <span className="ml-1 tabular-nums" style={{ opacity: on ? 0.85 : 0.6 }}>{n}</span>
              </button>
            );
          })}
        </div>

        <input
          className="input h-[36px] w-full min-w-0 sm:w-[220px]"
          placeholder="搜索：主体 / 模型 / 摘要 / 错误"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="input h-[36px] w-auto min-w-0"
          title="只看某种状态"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">全部状态</option>
          <option value="ok">完成</option>
          <option value="error">失败</option>
          <option value="running">运行中</option>
          <option value="aborted">已中断</option>
        </select>
        <select
          className="input h-[36px] w-auto max-w-[150px] min-w-0"
          title="只看某个助手的记录"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
        >
          <option value="">全部助手</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>

        <div className="ml-auto flex items-center gap-2">
          {/* 用量一行 —— 老版四张卡的位置。数字一个不少，只是不再各占一张卡。 */}
          {usage && (
            <div
              className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11.5px] tabular-nums"
              style={{ color: "var(--color-muted)" }}
            >
              <span title={`今日 ${usage.today.calls} 次 · 近 ${usage.days} 天 ${usage.period.calls} 次`}>
                今日 <b style={{ color: "var(--color-text)" }}>{usage.today.calls}</b> 次
              </span>
              <span
                title={
                  usage.stats && usage.stats.runs > 0
                    ? `${usage.stats.ok} 成功 · ${usage.stats.failed} 失败`
                    : "暂无执行"
                }
              >
                成功{" "}
                <b style={{ color: usage.stats && usage.stats.failed > 0 ? "var(--color-err)" : "var(--color-text)" }}>
                  {usage.stats?.success_rate != null ? `${usage.stats.success_rate}%` : "—"}
                </b>
              </span>
              <span title={`今日 · 近 ${usage.days} 天 ${fmt.num(usage.period.tokens_in + usage.period.tokens_out)}`}>
                token <b style={{ color: "var(--color-text)" }}>{fmt.num(usage.today.tokens_in + usage.today.tokens_out)}</b>
              </span>
              <span title={usage.period.cost != null ? `近 ${usage.days} 天 ${fmt.money(usage.period.cost, usage.currency)}` : "还没填单价，算不出钱"}>
                花费{" "}
                <b style={{ color: "var(--color-text)" }}>
                  {usage.today.cost != null ? fmt.money(usage.today.cost, usage.currency) : "—"}
                </b>
              </span>
              {usage.unpriced.length > 0 && (
                <Link
                  href="/credentials#prices"
                  className="underline decoration-dotted"
                  data-tap
                  style={{ color: "var(--color-accent)" }}
                  title={`这些模型还没填单价：${usage.unpriced.join("、")} —— 填了才算得准`}
                >
                  {usage.unpriced.length} 个没单价
                </Link>
              )}
            </div>
          )}

          {/* 选择总数 + 清理菜单（自研下拉，禁用原生 confirm/alert） */}
          {selected.size > 0 && (
            <span className="text-[11.5px] tabular-nums" style={{ color: "var(--color-accent)" }}>
              已选 {selected.size}
            </span>
          )}
          {/* 删除选中常驻可见 —— 用户口径：动作收进 ⋯ = 藏起来了（曾被打回过一次）。
              其余低频清理（按时间/清空）留在 ⋯ 里。 */}
          <button
            type="button"
            className="btn btn-sm"
            style={{ color: "var(--color-err)" }}
            disabled={busy || selected.size === 0}
            onClick={() => void deleteSelected()}
          >
            删除选中{selected.size > 0 ? `（${selected.size}）` : ""}
          </button>
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={menu}
              title="按时间清理 / 清空"
              onClick={() => setMenu((v) => !v)}
              className="min-h-[36px] rounded-[8px] border px-2.5 text-[13px] hover:bg-[var(--color-surface-2)]"
              style={{ borderColor: "var(--color-border)" }}
            >
              ⋯
            </button>
            {menu && (
              <div
                role="menu"
                className="absolute right-0 z-30 mt-1 w-[190px] overflow-hidden rounded-[10px] border shadow-lg"
                style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => void pruneOld()}
                  className="flex min-h-[38px] w-full items-center gap-2 px-3 text-left text-[12.5px] hover:bg-[var(--color-surface-2)] disabled:opacity-40"
                >
                  按时间清理
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy || items.length === 0}
                  onClick={() => void clearAll()}
                  className="flex min-h-[38px] w-full items-center gap-2 px-3 text-left text-[12.5px] hover:bg-[var(--color-surface-2)] disabled:opacity-40"
                  style={{ color: "var(--color-err)" }}
                >
                  清空执行记录
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── 列表：一段行列表，桌面手机同一套（响应式换行） ─────────────── */}
      <div
        className="overflow-hidden rounded-[12px] border"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      >
        {loading ? (
          <div className="px-4 py-6 text-[13px]" style={{ color: "var(--color-muted)" }}>加载中…</div>
        ) : items.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13px]" style={{ color: "var(--color-muted)" }}>
            {q || status || agentId || kind !== "all" ? (
              <>
                没有符合条件的记录。
                <button
                  type="button"
                  className="ml-1 text-[var(--color-accent)]"
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
                <Link href="/exec" className="ml-1 text-[var(--color-accent)]">
                  去执行一个任务试试 →
                </Link>
              </>
            )}
          </div>
        ) : (
          <>
            {/* 表头：只在桌面出现（窄屏靠每行自身的小字标签） */}
            <div
              className="hidden items-center gap-2.5 border-b px-3 py-2 text-[11.5px] lg:flex"
              style={{ borderColor: "var(--color-border)", color: "var(--color-muted)", background: "var(--color-surface-2)" }}
            >
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="h-4 w-4 accent-[var(--color-accent)]"
                title="全选（不含运行中的记录）"
              />
              <span className="w-[68px] shrink-0">状态</span>
              <span className="w-[104px] shrink-0">类型</span>
              <span className="min-w-0 flex-1">主体</span>
              <span className="w-[104px] shrink-0 text-right">时间</span>
              <span className="w-[104px] shrink-0 text-right">Tokens</span>
              <span className="w-[72px] shrink-0 text-right">金额</span>
              <span className="w-[14px] shrink-0" />
            </div>

            {items.map((it) => {
              const live = LIVE.includes(it.status);
              const isOpen = expanded.has(it.id);
              const d = details[it.id];
              return (
                <Fragment key={it.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleRow(it)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleRow(it);
                      }
                    }}
                    className="flex min-h-[52px] cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1 border-b px-3 py-2.5 hover:bg-[var(--color-surface-2)]"
                    style={{
                      borderColor: "var(--color-border)",
                      background: isOpen ? "color-mix(in srgb, var(--color-accent) 5%, transparent)" : undefined,
                    }}
                  >
                    {/* 用 label 包住勾选框：点框旁边 36px 的空白也算勾选（手指点不准 16px 的小方框），
                        并且点击不再冒泡到行上（勾选 ≠ 展开行） */}
                    {!live ? (
                      <label
                        className="flex h-9 w-6 shrink-0 cursor-pointer items-center justify-center"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(it.id)}
                          onChange={() => toggle(it.id)}
                          className="h-[17px] w-[17px] accent-[var(--color-accent)]"
                          title="勾选后可批量删除"
                        />
                      </label>
                    ) : (
                      <span className="w-6 shrink-0" />
                    )}

                    <span
                      className="w-[68px] shrink-0 whitespace-nowrap text-[11.5px] font-medium"
                      style={{ color: STATUS_STYLE[it.status] ?? "" }}
                      title={`状态值：${it.status}`}
                    >
                      {live && "● "}
                      {STATUS_LABEL[it.status] ?? it.status}
                    </span>

                    <span className="flex w-[104px] shrink-0 items-center gap-1 overflow-hidden">
                      <span
                        className="whitespace-nowrap rounded px-1.5 py-0.5 text-[11px]"
                        style={{
                          background: "color-mix(in srgb, var(--color-accent) 10%, transparent)",
                          color: "var(--color-accent)",
                        }}
                      >
                        {KIND_LABEL[it.kind]}
                      </span>
                      {it.trigger && (
                        <span
                          className="whitespace-nowrap rounded px-1.5 py-0.5 text-[11px]"
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
                    </span>

                    {/* 主体：标题 + 一格小灰字（模型 · 耗时 · 分派/轮次计数） */}
                    <span className="min-w-0 flex-1 basis-[calc(100%-260px)]">
                      <span className="block truncate text-[13px]">{it.title}</span>
                      <span
                        className="mt-0.5 block truncate text-[11px]"
                        style={{ color: it.error ? "var(--color-err)" : "var(--color-muted)" }}
                      >
                        {it.error ? (
                          <>✗ {it.error}</>
                        ) : (
                          <>
                            {it.model && it.kind !== "llm_test" ? <span className="mono">{it.model}</span> : null}
                            {it.model && it.kind !== "llm_test" && it.duration_ms != null ? " · " : null}
                            {it.duration_ms != null ? fmt.ms(it.duration_ms) : null}
                            {it.model && it.kind !== "llm_test" && it.summary ? " · " : null}
                            {it.summary ?? ""}
                          </>
                        )}
                      </span>
                    </span>

                    <span
                      className="w-[104px] shrink-0 text-right text-[11.5px] tabular-nums"
                      style={{ color: "var(--color-muted)" }}
                    >
                      {new Date(it.at).toLocaleString("zh-CN", {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })}
                    </span>
                    <span
                      className="w-[104px] shrink-0 whitespace-nowrap text-right text-[11.5px] tabular-nums"
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
                    </span>
                    <span
                      className="w-[72px] shrink-0 text-right text-[11.5px] tabular-nums"
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
                    <span className="w-[14px] shrink-0 text-[11px]" style={{ color: "var(--color-muted)" }}>
                      {isOpen ? "▾" : "▸"}
                    </span>
                  </div>

                  {/* ── 就地展开：这一条的全貌，全在列表里，不弹窗 ────────── */}
                  {isOpen && (
                    <div
                      className="border-b px-3 pb-3 pt-2.5"
                      style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
                    >
                      {it.summary && (
                        <div className="mb-2 text-[12.5px] leading-[1.65]" style={{ color: "var(--color-muted)" }}>
                          {it.summary}
                        </div>
                      )}
                      {it.error && (
                        <div className="mb-2 whitespace-pre-wrap break-words text-[12.5px] leading-[1.65]" style={{ color: "var(--color-err)" }}>
                          ✗ {it.error}
                        </div>
                      )}

                      {/* 分派出去的每一路 / 这个会话的每一轮 —— 就地列出，可单独重跑 */}
                      {it.fanout && (
                        <div className="mb-2">
                          <div className="mb-1 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                            {it.kind === "chat"
                              ? `这个对话的 ${it.fanout.total} 轮`
                              : `这一步分派出去的 ${it.fanout.total} 路`}
                            {it.fanout.tokens_in + it.fanout.tokens_out > 0 &&
                              ` · 合计 ${fmt.num(it.fanout.tokens_in + it.fanout.tokens_out)} token`}
                            {it.kind === "chat" ? "" : "（每一路都是独立执行，可单独重跑）"}
                          </div>

                          {/* 调用链：父助手 → 各路（fork 出的子助手在这里第一次"看得见"）。
                              只有真分派（不是会话轮次）才画，图是自动布局出来的。 */}
                          {dispatchChain(it, agentNameOf) && (
                            <div className="mb-1.5">
                              <div className="mb-1 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                                调用链（谁派给谁）
                              </div>
                              <Mermaid code={dispatchChain(it, agentNameOf)!} />
                            </div>
                          )}
                          <div className="flex flex-col gap-1">
                            {it.fanout.items.map((f) => (
                              <div
                                key={f.index}
                                className="flex items-center gap-2 rounded-[6px] border px-2 py-1 text-[12px]"
                                style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
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
                                {f.agent_name && (
                                  <span
                                    className="shrink-0 rounded px-1.5 py-px text-[10.5px]"
                                    title={`这一路由「${f.agent_name}」执行`}
                                    style={{
                                      background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
                                      color: "var(--color-accent)",
                                    }}
                                  >
                                    {f.agent_name}
                                  </span>
                                )}
                                {f.status === "waiting_hitl" && (
                                  <span className="shrink-0" style={{ color: "var(--color-warn)" }}>等你确认</span>
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
                        </div>
                      )}

                      {/* 执行过程：点开这一行时才去拉事件（懒加载） */}
                      <div className="rounded-[8px] border" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
                        <div
                          className="flex items-center gap-2 border-b px-2.5 py-1.5"
                          style={{ borderColor: "var(--color-border)" }}
                        >
                          <span className="text-[11.5px] font-medium" style={{ color: "var(--color-muted)" }}>
                            执行过程
                          </span>
                          {it.id && it.kind !== "llm_test" && (
                            <span className="mono text-[11px]" style={{ color: "var(--color-muted)" }}>
                              {it.id}
                            </span>
                          )}
                        </div>
                        <div className="px-2.5 py-2">
                          {d?.loading ? (
                            <div className="text-[12px]" style={{ color: "var(--color-muted)" }}>读取中…</div>
                          ) : d?.note ? (
                            <div className="text-[12px]" style={{ color: "var(--color-muted)" }}>{d.note}</div>
                          ) : d?.steps && d.steps.length > 0 ? (
                            <RunTimeline steps={d.steps} />
                          ) : (
                            <div className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                              这一步没有留下事件。
                            </div>
                          )}
                        </div>
                      </div>

                      {/* 耗时瀑布（谁在吃时间）—— 与执行过程并列，懒加载、有 span 才显示 */}
                      {d?.spans && d.spans.length > 0 && (
                        <div className="rounded-[8px] border" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
                          <div className="border-b px-2.5 py-1.5" style={{ borderColor: "var(--color-border)" }}>
                            <span className="text-[11.5px] font-medium" style={{ color: "var(--color-muted)" }}>
                              耗时瀑布（谁在吃时间）
                            </span>
                          </div>
                          <div className="px-2.5 py-2">
                            <SpanWaterfall spans={d.spans} />
                          </div>
                        </div>
                      )}

                      {/* 模型请求：每次调用发了什么、回了什么（原文按需展开） */}
                      <div className="mt-2">
                        <LlmCallsPanel runId={it.id} calls={d.llmCalls} />
                      </div>
                    </div>
                  )}
                </Fragment>
              );
            })}
          </>
        )}

        {/* 分页：一页 50 条。不摆页码 —— 记录一直在新增，页码会错位，
            用户要的其实是"还有没有、还有多少"。 */}
        {!loading && items.length > 0 && (
          <div className="flex items-center justify-center gap-3 py-3 text-[12.5px]">
            {hasMore ? (
              <>
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={moreBusy}
                  className="min-h-[36px] rounded-[8px] border px-3 disabled:opacity-50"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  {moreBusy ? "加载中…" : `加载更多（还有 ${Math.max(serverTotal - items.length, 0)} 条）`}
                </button>
                <span style={{ color: "var(--color-muted)" }}>
                  已显示 {items.length} / {serverTotal}
                </span>
              </>
            ) : (
              <span style={{ color: "var(--color-muted)" }}>共 {serverTotal} 条，已到底</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
