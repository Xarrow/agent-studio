"use client";

/**
 * 结果里的"结构化内容"渲染块 —— ```json / ```csv / ```chart / ```diff。
 *
 * 设计口径（与既有渲染块一致）：
 *   ① **认不出就整块退回源码**（json 解析失败、chart 数据形状不对…）——
 *      宁可让人看到原始数据，也不要画一张错的图、或显示半截树；
 *   ② 一律浅色、零依赖：图是自研 SVG，表是原生 table，没有引入任何图表/表格库；
 *   ③ 手机可用：表格横向滚动、图表宽度自适应（viewBox + w-full）；
 *   ④ 复制按钮常驻（触屏没有 hover）。
 */

import React, { useMemo, useState } from "react";

import { CodeBlock } from "./CodeBlock";
import {
  layoutChart,
  parseChartSpec,
  parseDelimited,
  parseDiff,
  parseJsonTree,
  type JsonNode,
} from "@/lib/dataviz";

/* ------------------------------------------------------------------ */
/* 通用外壳：标题条 + 复制 + 可选"看源码"                              */
/* ------------------------------------------------------------------ */
function Shell({
  title,
  hint,
  raw,
  children,
}: {
  title: string;
  hint?: string;
  raw: string;
  children: React.ReactNode;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-slate-200">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-slate-200 bg-slate-50 px-2.5 py-1.5">
        <span className="text-[11.5px] font-medium text-slate-600">{title}</span>
        {hint ? <span className="text-[11px] text-slate-400">{hint}</span> : null}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            data-tap
            className="rounded px-1.5 py-1 text-[11px] text-slate-500 hover:bg-slate-200/70"
          >
            {showRaw ? "看渲染" : "看源码"}
          </button>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(raw);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
            data-tap
            className="rounded px-1.5 py-1 text-[11px] text-slate-500 hover:bg-slate-200/70"
          >
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
      {showRaw ? (
        <pre className="max-h-[420px] overflow-auto bg-white px-3 py-2 text-[12px] leading-[1.6] text-slate-800">
          {raw}
        </pre>
      ) : (
        children
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* JSON 树                                                             */
/* ------------------------------------------------------------------ */
const KIND_COLOR: Record<string, string> = {
  string: "text-slate-700",
  number: "text-blue-600",
  boolean: "text-violet-600",
  null: "text-slate-400",
  object: "text-slate-500",
  array: "text-slate-500",
};

function TreeNode({
  node,
  depth,
  defaultOpen,
}: {
  node: JsonNode;
  depth: number;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const pad = 8 + depth * 12;

  if (!node.collapsible) {
    return (
      <div className="flex items-start gap-1.5 py-[1px] font-mono text-[12px] leading-[1.55]" style={{ paddingLeft: pad }}>
        <span className="shrink-0 text-[11px] text-slate-400">
          {node.key === "$" ? "" : node.key}
        </span>
        {node.key !== "$" ? <span className="text-slate-400">:</span> : null}
        <span className={`break-all ${KIND_COLOR[node.kind] ?? "text-slate-700"}`}>
          {node.kind === "string" ? `"${node.text}"` : node.text}
        </span>
      </div>
    );
  }
  return (
    <div className="py-[1px] font-mono text-[12px] leading-[1.55]">
      <button
        type="button"
        data-jsonrow
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left"
        style={{ paddingLeft: pad }}
      >
        <span className="w-3 shrink-0 text-slate-400">{open ? "▾" : "▸"}</span>
        {node.key !== "$" ? (
          <>
            <span className="text-slate-600">{node.key}</span>
            <span className="text-slate-400">:</span>
          </>
        ) : null}
        <span className={KIND_COLOR[node.kind] ?? "text-slate-500"}>{node.text}</span>
      </button>
      {open
        ? node.children.map((child, i) => (
            <TreeNode key={`${child.key}-${i}`} node={child} depth={depth + 1} defaultOpen={depth + 1 < 2} />
          ))
        : null}
    </div>
  );
}

export function JsonBlock({ code }: { code: string }) {
  const tree = useMemo(() => parseJsonTree(code), [code]);
  if (!tree) return <CodeBlock code={code} lang="json" />;
  return (
    <Shell title="JSON" hint={tree.collapsible ? "点行首箭头折叠/展开" : undefined} raw={code}>
      <div className="max-h-[420px] overflow-auto bg-white px-2 py-1.5">
        <TreeNode node={tree} depth={0} defaultOpen />
      </div>
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* CSV / TSV 表格                                                      */
/* ------------------------------------------------------------------ */
export function CsvBlock({ code, delimiter }: { code: string; delimiter: string }) {
  const table = useMemo(() => parseDelimited(code, delimiter), [code, delimiter]);
  if (!table) return <CodeBlock code={code} lang="csv" />;
  return (
    <Shell title={delimiter === "\t" ? "TSV" : "CSV"} hint={`${table.rows.length} 行`} raw={code}>
      {table.header.length >= 3 ? (
        <p className="px-2.5 pt-1 text-[11px] text-slate-400 lg:hidden">← 左右滑动看更多列 →</p>
      ) : null}
      <div className="max-h-[420px] overflow-auto bg-white">
        <table className="w-full border-collapse text-[12px]">
          <thead className="sticky top-0 bg-slate-50">
            <tr>
              {table.header.map((h, i) => (
                <th
                  key={i}
                  className="whitespace-nowrap border-b border-slate-200 px-2.5 py-1.5 text-left font-medium text-slate-600"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, ri) => (
              <tr key={ri} className={ri % 2 ? "bg-slate-50/60" : ""}>
                {r.map((c, ci) => (
                  <td key={ci} className="border-b border-slate-100 px-2.5 py-1.5 align-top text-slate-700">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* 图表（自研 SVG：柱 / 折线 / 饼）                                    */
/* ------------------------------------------------------------------ */
const SERIES_COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2"];

export function ChartBlock({ code }: { code: string }) {
  const spec = useMemo(() => parseChartSpec(code), [code]);
  if (!spec) return <CodeBlock code={code} lang="json" />;

  const W = 560;
  const H = spec.kind === "pie" ? 220 : 200;
  const layout = layoutChart(spec, W, H);
  const color = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length];

  const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString() : String(Math.round(v * 100) / 100));

  return (
    <Shell title="图表" hint={spec.kind === "bar" ? "柱状图" : spec.kind === "line" ? "折线图" : "饼图"} raw={code}>
      <div className="bg-white px-2 py-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="图表">
          {spec.kind !== "pie" ? (
            <>
              {layout.yTicks.map((t, i) => (
                <g key={i}>
                  <line
                    x1={layout.plot.x}
                    x2={layout.plot.x + layout.plot.w}
                    y1={t.y}
                    y2={t.y}
                    stroke={i === 0 ? "#cbd5e1" : "#eef2f7"}
                    strokeWidth={1}
                  />
                  <text x={layout.plot.x - 6} y={t.y + 3.5} textAnchor="end" fontSize={9.5} fill="#94a3b8">
                    {fmt(t.value)}
                  </text>
                </g>
              ))}
              {layout.bars.map((b, i) => (
                <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill={color(b.series)} rx={1.5}>
                  <title>{`${spec.labels[b.index]}：${fmt(b.value)}`}</title>
                </rect>
              ))}
              {layout.lines.map((l) => (
                <g key={l.series}>
                  <polyline
                    fill="none"
                    stroke={color(l.series)}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    points={l.points.map((p) => `${p.x},${p.y}`).join(" ")}
                  />
                  {l.points.map((p, i) => (
                    <circle key={i} cx={p.x} cy={p.y} r={2.4} fill={color(l.series)}>
                      <title>{`${spec.labels[i]}：${fmt(spec.series[l.series].values[i])}`}</title>
                    </circle>
                  ))}
                </g>
              ))}
              {spec.labels.map((label, i) => {
                const n = spec.labels.length;
                const cx = layout.plot.x + (layout.plot.w / Math.max(1, n)) * i + layout.plot.w / Math.max(1, n) / 2;
                return (
                  <text key={i} x={cx} y={layout.plot.y + layout.plot.h + 14} textAnchor="middle" fontSize={9.5} fill="#64748b">
                    {label.length > 8 ? `${label.slice(0, 8)}…` : label}
                  </text>
                );
              })}
            </>
          ) : (
            <>
              {layout.slices.map((s) => {
                const R = 92;
                const cx = 110;
                const cy = H / 2;
                const a0 = s.a0;
                const a1 = s.a1;
                const x0 = cx + R * Math.cos(a0);
                const y0 = cy + R * Math.sin(a0);
                const x1 = cx + R * Math.cos(a1);
                const y1 = cy + R * Math.sin(a1);
                const large = a1 - a0 > Math.PI ? 1 : 0;
                const d =
                  layout.slices.length === 1
                    ? `M ${cx - R} ${cy} a ${R} ${R} 0 1 0 ${R * 2} 0 a ${R} ${R} 0 1 0 ${-R * 2} 0`
                    : `M ${cx} ${cy} L ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1} Z`;
                return (
                  <path key={s.index} d={d} fill={color(s.index)} stroke="#fff" strokeWidth={1}>
                    <title>{`${spec.labels[s.index]}：${fmt(s.value)}`}</title>
                  </path>
                );
              })}
              {spec.labels.map((label, i) => (
                <g key={i}>
                  <rect x={250} y={18 + i * 20} width={9} height={9} rx={2} fill={color(i)} />
                  <text x={265} y={26 + i * 20} fontSize={11} fill="#475569">
                    {label} · {fmt(spec.series[0]?.values[i] ?? 0)}
                  </text>
                </g>
              ))}
            </>
          )}
        </svg>
        {spec.series.length > 1 ? (
          <div className="mt-1 flex flex-wrap gap-3 px-1">
            {spec.series.map((s, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 text-[11px] text-slate-600">
                <span className="inline-block h-2 w-2 rounded-sm" style={{ background: color(i) }} />
                {s.name}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* diff                                                                */
/* ------------------------------------------------------------------ */
const DIFF_STYLE: Record<string, string> = {
  add: "bg-emerald-50 text-emerald-800",
  del: "bg-rose-50 text-rose-800",
  hunk: "bg-blue-50/70 text-blue-700",
  meta: "text-slate-400",
  ctx: "text-slate-700",
};

export function DiffBlock({ code }: { code: string }) {
  const lines = useMemo(() => parseDiff(code), [code]);
  return (
    <Shell title="改动" hint={`+${lines.filter((l) => l.type === "add").length} / -${lines.filter((l) => l.type === "del").length}`} raw={code}>
      <div className="max-h-[420px] overflow-auto bg-white py-1 font-mono text-[12px] leading-[1.55]">
        {lines.map((l, i) => (
          <div key={i} className={`whitespace-pre-wrap break-all px-2.5 ${DIFF_STYLE[l.type] ?? ""}`}>
            {l.text || " "}
          </div>
        ))}
      </div>
    </Shell>
  );
}
