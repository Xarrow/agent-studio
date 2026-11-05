"use client";

/**
 * 执行时间线 —— 一页看清「这次它想了什么、调了什么、等你多久、时间花在哪」
 * =====================================================================
 *
 * 为什么合成一条
 * --------------
 * 以前详情页有四块并列：步骤流（它想了什么）、耗时瀑布（时间）、模型请求
 * （内容）、工具调用（又是一遍内容）。同一件事的三种投影摊开摆，用户要在
 * 三块之间来回对：这一条工具在瀑布里是 4 秒，可它的参数和结果在下面另一块里。
 *
 * 现在只有一条：**一次交互 = 一行**（轮次 / 思考 / 工具 / 等你点），
 * 时间按真实横轴摆放，点哪一行，它的详情就展开在**那一行下面**。
 * 原来「模型请求」那块的内容（ttft、token、缓存、请求与响应原文）搬进
 * 「请求」这一行的展开里——能力没少，只是回到了它该在的位置。
 *
 * 交互口径
 * --------
 * · 点行 = 展开，再点收起；键盘回车同理（空格留给滚动，见空格那次修复）
 * · 详情一律就地展开，不弹层；正文按需拉（思考常常几千字，不展开不花带宽）
 * · 默认全部折叠：一次执行里思考往往占好几屏，默认铺开等于把时间线埋了
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { api, fmt } from "@/lib/api";
import { LlmCallPayloadView } from "@/components/LlmCallsPanel";
import { agentColorMap, colorFor } from "@/lib/agent-colors";
import {
  agentsIn,
  KIND_COLOR,
  KIND_LABEL,
  digest,
  fmtSeconds,
  headline,
  labelOf,
  layout,
  type TimelineData,
  type TimelineItem,
} from "@/lib/timeline";

type TextDetail = { kind: string; text: string; chars: number; truncated: boolean };

export function ExecutionTimeline({
  runId,
  title = "执行时间线",
  compact = false,
}: {
  runId: string;
  title?: string;
  compact?: boolean;
}) {
  const [data, setData] = useState<TimelineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<string, TextDetail>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.executionTimeline(runId);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => (data ? layout(data) : []), [data]);
  // 编排查派多个助手时，每条派活按"派给谁"上色；顺序取首次出现 → 刷新不变色
  const agents = useMemo(() => (data ? agentsIn(data.items) : []), [data]);
  const agentColors = useMemo(() => agentColorMap(agents), [agents]);

  const toggle = async (item: TimelineItem) => {
    const next = openId === item.id ? null : item.id;
    setOpenId(next);
    // 只有"正文型"的条目需要额外拉全文；请求/响应走已有原文接口
    if (!next || texts[item.id]) return;
    if (item.kind !== "think" && item.kind !== "tool") return;
    setBusy(item.id);
    try {
      const res = await api.runTimelineText(runId, item.id);
      setTexts((t) => ({ ...t, [item.id]: res }));
    } catch {
      /* 拉不到就只显示预览，不打断看时间线 */
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="text-[12px]" style={{ color: "var(--color-muted)" }}>
        读取执行过程…
      </div>
    );
  }
  if (error) {
    return (
      <div className="text-[12px]" style={{ color: "var(--color-err)" }}>
        执行过程读取失败：{error}
      </div>
    );
  }
  if (!data || data.items.length === 0) {
    return (
      <div className="text-[12px]" style={{ color: "var(--color-muted)" }}>
        这次执行没有留下过程记录（很可能是刚建就失败，或运行时没上报事件）。
      </div>
    );
  }

  return (
    <div>
      {!compact && (
        <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[12px] font-medium">{title}</span>
          <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
            {headline(data)}
          </span>
          <button
            type="button"
            className="ml-auto rounded-[6px] border px-2 py-0.5 text-[12px]"
            style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}
            onClick={() => void load()}
            title="重新读一遍（执行还在跑就刷新到最新）"
          >
            刷新
          </button>
        </div>
      )}

      {agents.length > 1 && (
        <div
          className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]"
          style={{ color: "var(--color-muted)" }}
        >
          <span>按助手分色</span>
          {agents.map((name) => (
            <span key={name} className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: agentColors[name] }} />
              <span className="max-w-[120px] truncate">{name}</span>
            </span>
          ))}
        </div>
      )}

      <div className="divide-y" style={{ borderColor: "var(--color-border)" }}>
        {rows.map(({ item, depth, left, width }) => {
          const expanded = openId === item.id;
          const agent = (item.attributes || {}).agent as string | undefined;
          const baseColor = KIND_COLOR[item.kind] ?? "var(--color-muted)";
          const color = colorFor(agentColors, agent, baseColor);
          const failed = (item.attributes || {}).status === "error";
          return (
            <div key={item.id} style={{ borderColor: "var(--color-border)" }}>
              <button
                type="button"
                onClick={() => void toggle(item)}
                aria-expanded={expanded}
                className="flex min-h-[44px] w-full items-center gap-2 py-1.5 text-left md:min-h-0"
                title={`${KIND_LABEL[item.kind] ?? item.kind} · ${item.name}`}
              >
                {/* 层级：缩进表达"挂在哪一轮下面"，不做树控件 */}
                <span
                  className={`flex min-w-0 items-center gap-1.5 text-[12px] ${
                    compact ? "w-[120px]" : "w-[124px] md:w-[190px]"
                  }`}
                  style={{ paddingLeft: depth * 12 }}
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: failed ? "var(--color-err)" : color }}
                  />
                  <span className="truncate" style={{ color: failed ? "var(--color-err)" : undefined }}>
                    {labelOf(item)}
                  </span>
                </span>

                {/* 真实时间轴：条的左偏移与宽度就是它在这段执行里的位置 */}
                <span className="relative h-[10px] flex-1 rounded-[3px]" style={{ background: "var(--color-surface-2)" }}>
                  <span
                    className="absolute top-0 h-full rounded-[3px]"
                    style={{
                      left: `${left}%`,
                      width: `${width}%`,
                      minWidth: 3,
                      background: failed ? "var(--color-err)" : color,
                      opacity: item.kind === "think" ? 0.55 : 0.9,
                    }}
                  />
                </span>

                <span
                  className="mono shrink-0 text-right text-[12px]"
                  style={{ width: 46, color: "var(--color-muted)" }}
                >
                  {fmtSeconds(item.duration_ms)}
                </span>
                <span
                  className="shrink-0 text-[12px]"
                  style={{ width: 14, color: "var(--color-muted)" }}
                  aria-hidden
                >
                  {expanded ? "▾" : "▸"}
                </span>
              </button>

              {/* 一句话摘要：不点也能判断"是不是这条"（信息默认可见） */}
              {!expanded && (
                <div
                  className="truncate pb-1 text-[12px]"
                  style={{ paddingLeft: depth * 12 + 16, color: "var(--color-muted)" }}
                >
                  {digest(item)}
                </div>
              )}

              {expanded && (
                <div
                  className="mb-2 rounded-[8px] p-2.5"
                  style={{ background: "var(--color-surface-2)", marginLeft: depth * 12 }}
                >
                  <ItemDetail runId={runId} item={item} text={texts[item.id]} busy={busy === item.id} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ItemDetail({
  runId,
  item,
  text,
  busy,
}: {
  runId: string;
  item: TimelineItem;
  text?: TextDetail;
  busy: boolean;
}) {
  const a = (item.attributes || {}) as Record<string, any>;

  if (item.kind === "llm") {
    const callId = a.llm_call_id as number | undefined;
    return (
      <div className="space-y-2">
        <Meta
          rows={[
            ["模型", a.model || "—"],
            ["耗时", fmtSeconds(item.duration_ms)],
            ["首字", a.ttft_ms ? fmtSeconds(a.ttft_ms) : "—"],
            ["输入", a.tokens_in ? `${fmt.int(a.tokens_in)} tokens` : "—"],
            ["输出", a.tokens_out ? `${fmt.int(a.tokens_out)} tokens` : "—"],
            ["命中缓存", a.cache_read ? `${fmt.int(a.cache_read)} tokens` : "—"],
            ...(a.status === "error" ? [["结果", "失败"] as [string, string]] : []),
          ]}
        />
        {callId ? (
          <div className="rounded-[6px] p-2" style={{ background: "var(--color-surface)" }}>
            <div className="mb-1 text-[12px]" style={{ color: "var(--color-muted)" }}>
              这次请求发了什么、回了什么
            </div>
            <LlmCallPayloadView runId={runId} callId={callId} />
          </div>
        ) : (
          <p className="text-[12px]" style={{ color: "var(--color-muted)" }}>
            这一次没有关联到请求原文明细（老记录或运行时未上报）。
          </p>
        )}
      </div>
    );
  }

  if (item.kind === "think") {
    return (
      <div className="space-y-1.5">
        <div className="text-[12px]" style={{ color: "var(--color-muted)" }}>
          思考 {a.chars ? `${fmt.int(a.chars)} 字` : ""} · {fmtSeconds(item.duration_ms)}
        </div>
        {busy ? (
          <div className="text-[12px]" style={{ color: "var(--color-muted)" }}>
            读取全文…
          </div>
        ) : text?.text ? (
          <pre className="mono max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-[6px] p-2 text-[12px]"
               style={{ background: "var(--color-surface)" }}>
            {text.text}
            {text.truncated && "\n…（已截断）"}
          </pre>
        ) : (
          <pre className="mono max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-[6px] p-2 text-[12px]"
               style={{ background: "var(--color-surface)" }}>
            {String(a.preview || "（没有留下思考内容）")}
          </pre>
        )}
      </div>
    );
  }

  if (item.kind === "tool") {
    return (
      <div className="space-y-2">
        <Meta
          rows={[
            ["工具", item.name],
            ...(a.agent ? [["派给", String(a.agent)] as [string, string]] : []),
            ["耗时", fmtSeconds(item.duration_ms)],
            ["结果", a.status === "error" ? "失败" : "成功"],
            ...(a.result_size ? [["体积", `${fmt.int(a.result_size)} 字节`] as [string, string]] : []),
          ]}
        />
        {a.args_preview ? (
          <Block label="参数" text={String(a.args_preview)} />
        ) : null}
        {a.error ? <Block label="报错" text={String(a.error)} error /> : null}
        <div>
          <div className="mb-1 text-[12px]" style={{ color: "var(--color-muted)" }}>
            结果
          </div>
          {busy ? (
            <div className="text-[12px]" style={{ color: "var(--color-muted)" }}>
              读取完整结果…
            </div>
          ) : (
            <pre className="mono max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-[6px] p-2 text-[12px]"
                 style={{ background: "var(--color-surface)" }}>
              {text?.text || String(a.result_preview || "（没有留下结果）")}
              {text?.truncated && "\n…（已截断）"}
            </pre>
          )}
        </div>
      </div>
    );
  }

  if (item.kind === "worker") {
    const childRun = a.run_id as string | undefined;
    return (
      <div className="space-y-2">
        <Meta
          rows={[
            ["助手", String(a.agent || item.name)],
            ["耗时", fmtSeconds(item.duration_ms)],
            ["结果", a.status === "ok" ? "完成" : String(a.status || "—")],
            ...(a.tokens_in || a.tokens_out
              ? [["tokens", `${fmt.int(a.tokens_in as number)} → ${fmt.int(a.tokens_out as number)}`] as [string, string]]
              : []),
          ]}
        />
        {childRun ? (
          // 这一路自己也有完整的请求/思考/工具 —— 就地展开，不用跳去另一条记录
          <ExecutionTimeline runId={childRun} compact title="这一路的执行" />
        ) : null}
      </div>
    );
  }

  if (item.kind === "hitl") {
    return (
      <Meta
        rows={[
          ["要确认的操作", String(a.tool || item.name)],
          ["你选的", a.decision ? String(a.decision) : "（没有记录）"],
          ["等了", a.waited_ms ? fmtSeconds(a.waited_ms) : fmtSeconds(item.duration_ms)],
        ]}
      />
    );
  }

  return (
    <pre className="mono whitespace-pre-wrap break-words text-[12px]" style={{ color: "var(--color-muted)" }}>
      {JSON.stringify(a, null, 2)}
    </pre>
  );
}

function Meta({ rows }: { rows: [string, string][] }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <span style={{ color: "var(--color-muted)" }}>{k}</span>
          <span className="break-all">{v}</span>
        </div>
      ))}
    </div>
  );
}

function Block({ label, text, error }: { label: string; text: string; error?: boolean }) {
  return (
    <div>
      <div className="mb-1 text-[12px]" style={{ color: "var(--color-muted)" }}>
        {label}
      </div>
      <pre
        className="mono max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[6px] p-2 text-[12px]"
        style={{ background: "var(--color-surface)", color: error ? "var(--color-err)" : undefined }}
      >
        {text}
      </pre>
    </div>
  );
}
