"use client";

/**
 * 关联图谱：文档 ↔ 分类 ↔ 技能 ↔ 助手。
 *
 * 为什么不用第三方图库：这个仓库对前端第三方依赖很克制（画布手写、图表也用 SVG）。
 * 这里的图是**小图**（几十个节点），用手写的分列布局 + 二次碰撞校正就够，
 * 换来的好处是：零依赖、可预测、手机上也一样清楚。
 *
 * 布局规则
 *   · 四列从左到右：助手 → 技能 → 文档 → 分类（引用方向即阅读方向）；
 *   · 每列内部纵向均分，列宽按最长标签算；
 *   · 画完做一次防重叠：同列节点间距不足就往下推。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { isImeEvent } from "@/lib/ime";

import { api } from "@/lib/api";
import { useFeedback } from "@/components/ui/feedback";

interface GNode {
  id: string;
  kind: "agent" | "skill" | "doc" | "tag";
  label: string;
}
interface GEdge {
  from: string;
  to: string;
  kind: string;
}

const COLUMNS: { kind: GNode["kind"]; title: string }[] = [
  { kind: "doc", title: "文档" },
  { kind: "tag", title: "标签" },
  { kind: "skill", title: "技能" },
  { kind: "agent", title: "助手" },
];

const NODE_W = 168;
const NODE_H = 34;
const GAP_Y = 14;
const COL_GAP = 96;
const PAD = 24;

/** 估算文字宽度：中文按 13px/字，英文按 7px/字（不精确但足够算列宽）。 */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u4e00-\u9fa5]/.test(ch) ? 13 : 7;
  return w;
}

const KIND_NAME: Record<string, string> = {
  doc: "文档",
  tag: "标签",
  skill: "技能",
  agent: "助手",
};

function kindName(kind: string): string {
  return KIND_NAME[kind] ?? kind;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function KnowledgeGraph({
  onSelect,
}: {
  /** 点节点时把「相关的文档 id」抛给外面，用来筛文档卡片 */
  onSelect?: (sel: { kind: string; label: string; docIds: string[] } | null) => void;
} = {}) {
  const fb = useFeedback();
  const [data, setData] = useState<{ nodes: GNode[]; edges: GEdge[] } | null>(null);
  /** 点中的节点：高亮它的邻接；再点一次取消 */
  const [selected, setSelected] = useState<string | null>(null);

  const neighbors = useMemo(() => {
    if (!data || !selected) return null;
    const set = new Set<string>([selected]);
    for (const e of data.edges) {
      if (e.from === selected) set.add(e.to);
      if (e.to === selected) set.add(e.from);
    }
    return set;
  }, [data, selected]);

  const load = useCallback(async () => {
    try {
      const got = await api.knowledgeGraph();
      setData({ nodes: got.nodes as GNode[], edges: got.edges as GEdge[] });
    } catch (e) {
      fb.error("读取图谱失败", e instanceof Error ? e.message : String(e));
      setData({ nodes: [], edges: [] });
    }
  }, [fb]);

  useEffect(() => {
    void load();
  }, [load]);

  const layout = useMemo(() => {
    if (!data) return null;
    const cols = COLUMNS.map((c) => ({
      ...c,
      nodes: data.nodes.filter((n) => n.kind === c.kind),
    }));
    // 列宽：按该列最长标签，夹在 [NODE_W, 260] 之间
    const widths = cols.map((c) =>
      Math.min(260, Math.max(NODE_W, ...c.nodes.map((n) => textWidth(truncate(n.label, 18)) + 28))),
    );
    const xs: number[] = [];
    let x = PAD;
    for (const w of widths) {
      xs.push(x);
      x += w + COL_GAP;
    }
    const tallest = Math.max(1, ...cols.map((c) => c.nodes.length));
    const height = PAD * 2 + tallest * (NODE_H + GAP_Y);
    const width = x - COL_GAP + PAD;

    const pos = new Map<string, { x: number; y: number; w: number }>();
    cols.forEach((c, ci) => {
      const colH = c.nodes.length * NODE_H + Math.max(0, c.nodes.length - 1) * GAP_Y;
      let y = Math.max(PAD, (height - colH) / 2);
      let lastBottom = -Infinity;
      for (const n of c.nodes) {
        // 防重叠：同列节点至少留 GAP_Y
        if (y < lastBottom + GAP_Y) y = lastBottom + GAP_Y;
        pos.set(n.id, { x: xs[ci], y, w: widths[ci] });
        lastBottom = y + NODE_H;
        y += NODE_H + GAP_Y;
      }
    });
    return { cols, width, height, pos };
  }, [data]);

  const kindColor: Record<GNode["kind"], string> = {
    agent: "var(--color-accent, #2563eb)",
    skill: "var(--color-ok, #16a34a)",
    doc: "var(--color-text-2)",
    tag: "var(--color-accent, #2563eb)",
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[12px]" style={{ color: "var(--color-text-3)" }}>
        <span>只画真实引用：文档的分分类、技能沉淀自哪份文档、助手挂了哪个技能</span>
        <button className="btn btn-sm ml-auto" type="button" onClick={() => void load()}>
          刷新
        </button>
      </div>

      {layout === null ? (
        <div className="h-40 animate-pulse rounded-lg" style={{ background: "var(--color-surface-2)" }} />
      ) : data!.nodes.length === 0 ? (
        <div
          className="rounded-lg px-4 py-10 text-center text-[12px]"
          style={{ background: "var(--color-surface-2)", color: "var(--color-text-3)" }}
        >
          还没有可画的引用关系。先把文档分个类，或者把文档提炼成 Skill。
        </div>
      ) : (
        <div className="overflow-auto rounded-lg p-1" style={{ background: "var(--color-surface-2)" }}>
          <svg
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            width="100%"
            style={{ minWidth: Math.min(layout.width, 900), maxHeight: 620 }}
            role="img"
            aria-label="知识关联图谱"
          >
            {layout.cols.map((c, i) => (
              <text
                key={c.kind}
                x={layout.pos.get(c.nodes[0]?.id ?? "")?.x ?? PAD}
                y={14}
                fontSize={11}
                fill="var(--color-text-3)"
              >
                {c.title}
                {c.nodes.length > 0 ? ` · ${c.nodes.length}` : ""}
              </text>
            ))}

            {data!.edges.map((e, i) => {
              const a = layout.pos.get(e.from);
              const b = layout.pos.get(e.to);
              if (!a || !b) return null;
              const x1 = a.x + a.w;
              const y1 = a.y + NODE_H / 2;
              const x2 = b.x;
              const y2 = b.y + NODE_H / 2;
              const mid = (x1 + x2) / 2;
              return (
                <path
                  key={`${e.from}-${e.to}-${i}`}
                  d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke={
                    neighbors && (e.from === selected || e.to === selected)
                      ? "var(--color-accent)"
                      : "var(--color-border-strong)"
                  }
                  strokeWidth={neighbors && (e.from === selected || e.to === selected) ? 2 : 1.2}
                  opacity={neighbors && !(e.from === selected || e.to === selected) ? 0.25 : 1}
                />
              );
            })}

            {data!.nodes.map((n) => {
              const p = layout.pos.get(n.id);
              if (!p) return null;
              const dim = neighbors ? !neighbors.has(n.id) : false;
              const isSel = selected === n.id;
              return (
                <g
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  style={{ cursor: "pointer", opacity: dim ? 0.3 : 1 }}
                  onClick={() => {
                    const next = isSel ? null : n.id;
                    setSelected(next);
                    if (!onSelect) return;
                    if (!next) {
                      onSelect(null);
                      return;
                    }
                    // 选中节点 → 收集一跳之内能到达的 doc 节点
                    const ids = new Set<string>();
                    const kind = next.split(":")[0];
                    if (kind === "doc") ids.add(next.slice(4));
                    for (const e of data?.edges ?? []) {
                      if (e.from === next && e.to.startsWith("doc:")) ids.add(e.to.slice(4));
                      if (e.to === next && e.from.startsWith("doc:")) ids.add(e.from.slice(4));
                    }
                    onSelect({ kind, label: n.label, docIds: Array.from(ids) });
                  }}
                  onKeyDown={(e) => {
                    if (isImeEvent(e)) return;
                    if (e.key === "Enter") setSelected(isSel ? null : n.id);
                  }}
                >
                  <title>{`${kindName(n.kind)}：${n.label}`}</title>
                  <rect
                    x={p.x}
                    y={p.y}
                    width={p.w}
                    height={NODE_H}
                    rx={8}
                    fill={isSel ? "color-mix(in srgb, var(--color-accent) 12%, var(--color-surface))" : "var(--color-surface)"}
                    stroke={isSel ? "var(--color-accent)" : "none"}
                  />
                  <rect x={p.x} y={p.y + 9} width={3} height={NODE_H - 18} rx={1.5} fill={kindColor[n.kind]} />
                  <text x={p.x + 12} y={p.y + NODE_H / 2 + 4} fontSize={12} fill="var(--color-text-1)">
                    {truncate(n.label, 18)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {selected ? (
        <div className="flex flex-wrap items-center gap-2 text-[12px]" style={{ color: "var(--color-text-2)" }}>
          <span>
            已选中：{kindName((selected.split(":")[0] as GNode["kind"]) || "doc")} ·{" "}
            {data?.nodes.find((n) => n.id === selected)?.label}
            {neighbors ? `（${neighbors.size - 1} 个直接关联）` : ""}
          </span>
          <button className="btn btn-sm" type="button" onClick={() => setSelected(null)}>
            取消选中
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3 text-[11px]" style={{ color: "var(--color-text-3)" }}>
        {COLUMNS.map((c) => (
          <span key={c.kind} className="flex items-center gap-1">
            <span style={{ display: "inline-block", width: 3, height: 11, borderRadius: 2, background: kindColor[c.kind] }} />
            {c.title}
          </span>
        ))}
      </div>
    </div>
  );
}
