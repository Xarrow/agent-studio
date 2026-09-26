"use client";

/**
 * 耗时瀑布 —— 「这一步为什么慢了三分钟」的答案。
 *
 * 为什么要有它
 * ------------
 * 模型调用表和工具调用表能告诉你"每次多久"，但看不出**它们之间的关系和时间占比**：
 * 一次执行里首字等了 12 秒、工具跑了 90 秒、还是"轮与轮之间空了 30 秒"，看数字要对半天。
 * 瀑布图（横条按真实时间轴摆放）一眼就能看出谁在吃时间。
 *
 * 实现上的两个刻意选择
 * ------------------
 * · 零第三方依赖：就是 div + 百分比定位，没有图表库
 * · **不折叠、不 hover 才显示**（用户明确要求信息默认可见）：每一层都直接摆出来，
 *   父条浅色、子条深色，缩进表示层级
 */

import type { Span } from "@/lib/types";
import { fmt } from "@/lib/api";

const KIND_LABEL: Record<string, string> = {
  run: "整次执行",
  iteration: "轮次",
  llm: "模型",
  tool: "工具",
  middleware: "中间件",
};

const KIND_COLOR: Record<string, string> = {
  run: "var(--color-accent)",
  iteration: "var(--color-warn)",
  llm: "var(--color-accent)",
  tool: "var(--color-ok)",
};

export function SpanWaterfall({ spans }: { spans: Span[] }) {
  if (!spans || spans.length === 0) {
    return (
      <div className="text-[12.5px]" style={{ color: "var(--color-muted)" }}>
        这次执行没有留下耗时明细（老记录可能只有汇总）。
      </div>
    );
  }

  const start = Math.min(...spans.map((s) => s.started_at));
  const end = Math.max(...spans.map((s) => s.ended_at ?? s.started_at + (s.duration_ms ?? 0)));
  const total = Math.max(end - start, 1);

  // 层级：run → iteration → llm/tool。父 span 的 id 链决定缩进（不额外传 depth）
  const byId = new Map(spans.map((s) => [s.id, s]));
  const depthOf = (s: Span): number => {
    let d = 0;
    let cur: Span | undefined = s;
    const guard = new Set<string>();
    while (cur?.parent_id && byId.has(cur.parent_id) && !guard.has(cur.parent_id)) {
      guard.add(cur.parent_id);
      cur = byId.get(cur.parent_id);
      d += 1;
      if (d > 8) break;
    }
    return d;
  };

  const ordered = [...spans].sort(
    (a, b) => a.started_at - b.started_at || (b.duration_ms ?? 0) - (a.duration_ms ?? 0),
  );

  const slowest = ordered
    .filter((s) => s.kind !== "run")
    .reduce<Span | null>((acc, s) => (!acc || (s.duration_ms ?? 0) > (acc.duration_ms ?? 0) ? s : acc), null);

  return (
    <div>
      <div className="mb-2 text-[12px]" style={{ color: "var(--color-muted)" }}>
        总耗时 {fmt.ms(total)}
        {slowest && slowest.duration_ms
          ? ` · 最慢：${slowest.name || KIND_LABEL[slowest.kind] || slowest.kind} ${fmt.ms(slowest.duration_ms)}（占 ${Math.round(
              ((slowest.duration_ms ?? 0) / total) * 100,
            )}%）`
          : ""}
      </div>
      <div className="space-y-1">
        {ordered.map((s) => {
          const d = depthOf(s);
          const left = ((s.started_at - start) / total) * 100;
          const width = Math.max(((s.duration_ms ?? 0) / total) * 100, 0.6);
          return (
            <div key={s.id} className="flex items-center gap-2">
              <div
                className="shrink-0 truncate text-[12px]"
                style={{ width: 150, paddingLeft: d * 10, color: "var(--color-muted)" }}
                title={`${KIND_LABEL[s.kind] ?? s.kind} · ${s.name}`}
              >
                {s.name || KIND_LABEL[s.kind] || s.kind}
              </div>
              <div
                className="relative h-[14px] flex-1 rounded-[4px]"
                style={{ background: "var(--color-surface-2)" }}
              >
                <div
                  className="absolute top-0 h-full rounded-[4px]"
                  style={{
                    left: `${left}%`,
                    width: `${width}%`,
                    background: KIND_COLOR[s.kind] ?? "var(--color-muted)",
                    opacity: s.kind === "run" ? 0.35 : 0.85,
                  }}
                  title={`${s.name} · ${fmt.ms(s.duration_ms ?? 0)}`}
                />
              </div>
              <div className="w-[70px] shrink-0 text-right text-[12px]" style={{ color: "var(--color-muted)" }}>
                {fmt.ms(s.duration_ms ?? 0)}
              </div>
              <div className="w-[52px] shrink-0 text-[11px]" style={{ color: "var(--color-muted)" }}>
                {KIND_LABEL[s.kind] ?? s.kind}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
