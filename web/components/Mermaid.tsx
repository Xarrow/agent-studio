"use client";

/**
 * Mermaid 子集渲染（零依赖 SVG）
 * ==============================
 *
 * 把 ```mermaid 代码块画成真正的流程图 —— 布局全部由 lib/mermaid.ts 自动
 * 算出来（不是手写死坐标）：分层、节点宽随文字自适应、边标签做避让、
 * viewBox 按内容算（宁可把画布放大也不裁切）。
 *
 * 画法遵循本项目的图表规范：
 *   · 连线/边框用**内联属性**（stroke/fill）而不是 CSS class —— 换主题、
 *     嵌进别的容器时颜色不会丢；
 *   · 文字宽度自适应 + 居中，不截断、不省略号；
 *   · 认不出的语法**整块退回代码展示**（宁可显示源码，也不要画错）。
 */

import React, { useMemo } from "react";
import { layoutMermaid, parseMermaid } from "@/lib/mermaid";
import { CodeBlock } from "@/components/CodeBlock";

const ACCENT = "#2563eb";
const BORDER = "#cbd5e1";
const TEXT = "#0f172a";
const MUTED = "#64748b";
const SURFACE = "#f8fafc";

export function Mermaid({ code }: { code: string }) {
  const uid = React.useId().replace(/[^A-Za-z0-9]/g, "");
  const layout = useMemo(() => {
    const p = parseMermaid(code);
    return p ? layoutMermaid(p) : null;
  }, [code]);

  if (!layout) return <CodeBlock code={code} lang="mermaid" />;

  const { nodes, edges, width, height } = layout;
  const markerId = `m-arrow-${uid}`;

  return (
    <div className="my-2 overflow-x-auto rounded-[10px] border p-2" style={{ borderColor: "var(--color-border)" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="img"
        aria-label="流程图"
        style={{ maxWidth: Math.max(320, width), height: "auto", display: "block" }}
      >
        <defs>
          <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={ACCENT} />
          </marker>
        </defs>

        {/* 先画线，后画节点 —— 线压在节点下面，连接处不会有毛刺 */}
        {edges.map((e, i) => {
          const d =
            e.path.length === 2
              ? `M ${e.path[0].x} ${e.path[0].y} L ${e.path[1].x} ${e.path[1].y}`
              : `M ${e.path[0].x} ${e.path[0].y} ` +
                e.path
                  .slice(1)
                  .map((pt) => `L ${pt.x} ${pt.y}`)
                  .join(" ");
          return (
            <path
              key={`e${i}`}
              d={d}
              fill="none"
              stroke={e.arrow ? ACCENT : BORDER}
              strokeWidth={e.arrow ? 1.6 : 1.4}
              strokeLinejoin="round"
              markerEnd={e.arrow ? `url(#${markerId})` : undefined}
            />
          );
        })}

        {edges.map((e, i) =>
          e.label && e.labelAt ? (
            <g key={`el${i}`}>
              <rect
                x={e.labelAt.x - (e.label.length * 3.4 + 5)}
                y={e.labelAt.y - 8}
                width={e.label.length * 6.8 + 10}
                height={16}
                rx={4}
                fill="#ffffff"
                stroke={BORDER}
                strokeWidth={0.8}
              />
              <text x={e.labelAt.x} y={e.labelAt.y + 3.5} textAnchor="middle" fontSize={11} fill={MUTED}>
                {e.label}
              </text>
            </g>
          ) : null,
        )}

        {nodes.map((n) => {
          const cy = n.y + n.h / 2;
          const cx = n.x + n.w / 2;
          return (
            <g key={n.id}>
              {n.shape === "diamond" ? (
                <polygon
                  points={`${cx},${n.y} ${n.x + n.w},${cy} ${cx},${n.y + n.h} ${n.x},${cy}`}
                  fill="#fff7ed"
                  stroke="#f59e0b"
                  strokeWidth={1.4}
                />
              ) : n.shape === "circle" ? (
                <circle cx={cx} cy={cy} r={Math.min(n.w, n.h) / 2} fill={SURFACE} stroke={BORDER} strokeWidth={1.4} />
              ) : (
                <rect
                  x={n.x}
                  y={n.y}
                  width={n.w}
                  height={n.h}
                  rx={n.shape === "rect" ? 4 : n.h / 2}
                  fill={SURFACE}
                  stroke={BORDER}
                  strokeWidth={1.4}
                />
              )}
              <text x={cx} y={cy + 4} textAnchor="middle" fontSize={12} fill={TEXT}>
                {n.text}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
