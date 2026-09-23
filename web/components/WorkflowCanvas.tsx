"use client";

/**
 * 编排画布 —— Playground 的中心。
 *
 * 三条设计约定（都是"用户不该被为难"的直接后果）
 * ------------------------------------------------
 * ① **位置由拓扑算，用户不摆坐标。** 列 = 第几步，行 = 同一步的第几条。
 *    拖拽只承担"组合"：拖到空白 = 新开一条；拖到某个助手上 = 接在它后面。
 *    手机上摆坐标本来就不可能准，而摆积木的乐趣在结构、不在对齐像素。
 * ② **布局按实测高度算。** 节点高度随状态/确认条变化，用估算值会让连线跑偏。
 * ③ **非法落点直接不接收**（自连、重复、成环），不弹错误框 —— 拖拽时弹窗最烦人。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Agent, WorkflowEdge, WorkflowGraph, WorkflowNode } from "@/lib/types";

export type NodeState = "idle" | "wait" | "run" | "ok" | "err" | "ask" | "stale";

const STATE_LABEL: Record<NodeState, string> = {
  idle: "待运行",
  wait: "等待",
  run: "运行中",
  ok: "完成",
  err: "失败",
  ask: "需你确认",
  stale: "需重跑",
};

const META: Record<NodeState, { dot: string; text: string; border: string }> = {
  idle: { dot: "var(--color-border)", text: "var(--color-muted)", border: "var(--color-border)" },
  wait: { dot: "var(--color-border)", text: "var(--color-muted)", border: "var(--color-border)" },
  run: { dot: "var(--color-accent)", text: "var(--color-accent)", border: "var(--color-accent)" },
  ok: { dot: "var(--color-ok)", text: "var(--color-ok)", border: "color-mix(in srgb, var(--color-ok) 45%, var(--color-border))" },
  err: { dot: "var(--color-err)", text: "var(--color-err)", border: "color-mix(in srgb, var(--color-err) 50%, var(--color-border))" },
  ask: { dot: "var(--color-warn)", text: "var(--color-warn)", border: "var(--color-warn)" },
  stale: { dot: "var(--color-muted)", text: "var(--color-muted)", border: "var(--color-border)" },
};

/**
 * 这条连线算不算"依赖"？
 *
 * **并行线不算** —— 它画出来是为了表达"这两个同时跑"，不是"后一个等前一个"。
 * 分层算法据此忽略它，两者才会真的并发；否则界面上写着并行、实际却串着跑。
 */
export function isDep(e: WorkflowEdge): boolean {
  return (e.rel ?? "serial") !== "parallel";
}

export function depEdges(edges: WorkflowEdge[]): WorkflowEdge[] {
  return edges.filter(isDep);
}

/** 拓扑分层：与后端 orchestrator/graph.py 的 topo_layers 同一套判据（最长路径）。
 *  两边必须一致 —— 否则"界面显示的步骤"和"实际执行顺序"会对不上。 */
export function topoLayers(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[][] {
  const layer: Record<string, number> = {};
  nodes.forEach((n) => (layer[n.nid] = 0));
  const deps = depEdges(edges);
  for (let i = 0; i < nodes.length + 2; i++) {
    let changed = false;
    for (const e of deps) {
      const cand = (layer[e.from] ?? 0) + 1;
      if ((layer[e.to] ?? 0) < cand) {
        layer[e.to] = cand;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const buckets: Record<number, string[]> = {};
  for (const [nid, lv] of Object.entries(layer)) (buckets[lv] ||= []).push(nid);
  return Object.keys(buckets)
    .map(Number)
    .sort((a, b) => a - b)
    .map((k) => buckets[k]);
}

/** 展平整层顺序 —— 用来把"第 i 个子 run"映射回节点（与后端 order_index 对齐） */
export function flattenLayers(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] {
  return topoLayers(nodes, edges).flat();
}

/** 主从里的"主"：扇出的源头；没有明显扇出就取唯一源头 */
export function detectMaster(nodes: WorkflowNode[], edges: WorkflowEdge[]): string | null {
  if (!nodes.length) return null;
  const out: Record<string, number> = {};
  const ind: Record<string, number> = {};
  nodes.forEach((n) => ((out[n.nid] = 0), (ind[n.nid] = 0)));
  depEdges(edges).forEach((e) => {
    out[e.from] = (out[e.from] ?? 0) + 1;
    ind[e.to] = (ind[e.to] ?? 0) + 1;
  });
  const fan = nodes.filter((n) => out[n.nid] > 1).map((n) => n.nid);
  if (fan.length) return nodes.find((n) => ind[n.nid] === 0 && fan.includes(n.nid))?.nid ?? fan[0];
  return nodes.find((n) => ind[n.nid] === 0)?.nid ?? nodes[0].nid;
}

type Props = {
  agents: Agent[];
  graph: WorkflowGraph;
  onChange: (next: WorkflowGraph) => void;
  selected: string | null;
  onSelect: (nid: string | null) => void;
  /** 这次执行的节点状态（nid → 状态）；空对象 = 还没跑过 */
  runStates: Record<string, NodeState>;
  /** 各节点本轮产出，直接显示在卡片上 */
  outputs: Record<string, string>;
  /** 正在等确认的节点 + 待确认内容 */
  hitl?: { nid: string; payload: Record<string, unknown> | null } | null;
  onHitl?: (action: "allow" | "allow_all" | "deny") => void;
  /** 从助手栏拖过来的助手 id（由上层维护，本组件只负责接收落点） */
  draggingAgentId: string | null;
  onDropped: (agentId: string, targetNid: string | null) => void;
  /** 指针拖拽时**悬停到的节点**：用来预览"松手会插到它后面" */
  hoverNid?: string | null;
  /** 运行中：冻结结构编辑，避免"改了图但对不上记录" */
  frozen?: boolean;
  /** 空态里给的三种起步方式 */
  onPreset?: (kind: "single" | "serial" | "fan") => void;
};

const NODE_W = 232;

/**
 * 连线上的四种关系 —— **这是"两个助手之间"的语义，不是全局设置**。
 *
 * 用户的心智是"这两个怎么配合"，而不是"整个流程用哪个模式"。所以选择放在连线上：
 * 点一下那条线，选它们之间的关系。文案与后端 orchestrator/graph.py 保持一致。
 */
const REL_OPTIONS = [
  { rel: "serial", label: "串行接力", hint: "等它跑完，把结论交给下一个" },
  { rel: "parallel", label: "并行", hint: "两个同时开始，互不等待" },
  { rel: "context", label: "上下文共享", hint: "把它看到的和说过的，一起交给下一个" },
  { rel: "memory", label: "记忆", hint: "产出存成下游的记忆，以后能想起来" },
] as const;

/** 每种关系怎么画：颜色 + 虚实。**靠形状区分**，不只靠颜色（色弱也能分辨） */
const REL_META: Record<string, { short: string; stroke: string; dash?: string }> = {
  serial: { short: "串行", stroke: "var(--color-border)" },
  parallel: {
    short: "并行",
    stroke: "color-mix(in srgb, var(--color-muted) 50%, var(--color-border))",
    dash: "2 5",
  },
  context: { short: "上下文", stroke: "color-mix(in srgb, var(--color-info) 60%, var(--color-border))" },
  memory: {
    short: "记忆",
    stroke: "color-mix(in srgb, var(--color-warn) 55%, var(--color-border))",
    dash: "8 4 2 4",
  },
};

export function WorkflowCanvas({
  agents,
  graph,
  onChange,
  selected,
  onSelect,
  runStates,
  outputs,
  hitl,
  onHitl,
  draggingAgentId,
  onDropped,
  frozen = false,
  hoverNid = null,
  onPreset,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [heights, setHeights] = useState<Record<string, number>>({});
  /** 画布"可以放东西"的高亮：有人正拿着助手 */
  const hot = !!draggingAgentId || hoverNid != null;
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [ghost, setGhost] = useState<string | null>(null);
  /** 窄屏：层改纵向排列（手机上横向滚动看不全一张图） */
  const [narrow, setNarrow] = useState(false);
  /** 选中的连线（点一下那条线 → 就地选它们之间的关系） */
  const [edgeSel, setEdgeSel] = useState<{ from: string; to: string } | null>(null);

  const agentOf = useCallback(
    (id: string) => agents.find((a) => a.id === id),
    [agents],
  );

  /* ── 响应式：窄屏换纵向布局 ─────────────────────────────────────────── */
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  /* ── 布局：先量高度，再按层排版（位置全是算出来的，没有一处硬编码） ── */
  const layout = useMemo(() => {
    const layers = topoLayers(graph.nodes, graph.edges);
    const GAP_X = 76;
    const GAP_Y = 20;
    const PAD = 24;
    const hOf = (nid: string) => heights[nid] || 104;
    const pos: Record<string, { x: number; y: number }> = {};
    let maxX = 0;
    let maxY = 0;
    if (narrow) {
      let y = PAD;
      layers.forEach((ids) => {
        const rowH = Math.max(...ids.map(hOf));
        ids.forEach((nid, i) => {
          pos[nid] = { x: PAD + i * (NODE_W + 16), y };
          maxX = Math.max(maxX, pos[nid].x + NODE_W + PAD);
        });
        y += rowH + 30;
        maxY = Math.max(maxY, y);
      });
    } else {
      layers.forEach((ids, ci) => {
        let y = PAD;
        ids.forEach((nid) => {
          pos[nid] = { x: PAD + ci * (NODE_W + GAP_X), y };
          y += hOf(nid) + GAP_Y;
          maxX = Math.max(maxX, pos[nid].x + NODE_W + PAD);
        });
        maxY = Math.max(maxY, y);
      });
    }
    return { pos, w: Math.max(maxX, 320), h: Math.max(maxY, 260), layers };
  }, [graph.nodes, graph.edges, heights, narrow]);

  /* 高度变化要在**绘制前**同步进布局，否则连线会先画在旧位置上再跳一下 */
  useLayoutEffect(() => {
    const next: Record<string, number> = {};
    let dirty = false;
    for (const n of graph.nodes) {
      const el = nodeRefs.current[n.nid];
      if (!el) continue;
      const h = el.offsetHeight;
      next[n.nid] = h;
      if (heights[n.nid] !== h) dirty = true;
    }
    if (dirty) setHeights(next);
  });

  /* ── 从助手栏拿助手：走**指针事件**（见 PlaygroundConsole.startAgentDrag）──
     不用 HTML5 拖放，是因为它在触屏上根本不触发 —— 手机上会完全拖不动。
     这一侧只负责提供"这里是画布，可以放"的锚点，落点由 elementFromPoint 判定。 */

  /* ── 连线：从出口拖到另一个节点（用于分叉 / 汇合） ─────────────────── */
  const canLink = (from: string, to: string) => {
    if (from === to) return false;
    if (graph.edges.some((x) => x.from === from && x.to === to)) return false;
    // 从 to 出发能回到 from = 成环，不许连
    const seen = new Set<string>();
    const stack = [to];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === from) return false;
      if (seen.has(cur)) continue;
      seen.add(cur);
      graph.edges.filter((x) => x.from === cur).forEach((x) => stack.push(x.to));
    }
    return true;
  };

  const startLink = (e: React.PointerEvent, from: string) => {
    if (frozen) return;
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const rect = stageRef.current?.getBoundingClientRect();
      const p = layout.pos[from];
      if (!rect || !p) return;
      const x1 = p.x + NODE_W;
      const y1 = p.y + (heights[from] || 104) / 2;
      const mx = ev.clientX - rect.left + (stageRef.current?.scrollLeft ?? 0);
      const my = ev.clientY - rect.top + (stageRef.current?.scrollTop ?? 0);
      const dx = Math.max(30, (mx - x1) * 0.5);
      setGhost(`M${x1},${y1} C${x1 + dx},${y1} ${mx - dx},${my} ${mx},${my}`);
      const el = (ev.target as HTMLElement)?.closest?.("[data-nid]") as HTMLElement | null;
      const to = el?.dataset.nid ?? null;
      setDropTarget(to && canLink(from, to) ? to : null);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setGhost(null);
      const el = (ev.target as HTMLElement)?.closest?.("[data-nid]") as HTMLElement | null;
      const to = el?.dataset.nid ?? null;
      if (to && canLink(from, to)) {
        onChange({ ...graph, edges: [...graph.edges, { from, to }] });
      }
      setDropTarget(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const master = useMemo(() => detectMaster(graph.nodes, graph.edges), [graph.nodes, graph.edges]);

  /* 边：端点取自同一份布局 + 实测高度 → 必然落在节点中心的水平线上 */
  /** 连线中点（关系标签 + 弹层都挂在这里，位置由布局算，没有硬编码坐标） */
  const edgeMids: Record<string, { x: number; y: number }> = {};

  const edgesSvg = graph.edges.map((e, i) => {
    const a = layout.pos[e.from];
    const b = layout.pos[e.to];
    if (!a || !b) return null;
    const st = runStates[e.to];
    const live = st === "run";
    const done = runStates[e.from] === "ok" && (st === "run" || st === "ok");
    const rel = e.rel ?? "serial";
    const meta = REL_META[rel] ?? REL_META.serial;
    // 运行中的颜色优先（正在流动比"什么关系"更重要）；空闲时才用关系色
    const stroke = live
      ? "var(--color-accent)"
      : done
        ? "color-mix(in srgb, var(--color-ok) 55%, var(--color-border))"
        : meta.stroke;
    const key = `${e.from}->${e.to}`;
    let d: string;
    if (narrow) {
      const x1 = a.x + NODE_W / 2;
      const y1 = a.y + (heights[e.from] || 104);
      const x2 = b.x + NODE_W / 2;
      const y2 = b.y;
      const dy = Math.max(24, (y2 - y1) * 0.5);
      d = `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;
      edgeMids[key] = { x: x1, y: (y1 + y2) / 2 };
    } else {
      const x1 = a.x + NODE_W;
      const y1 = a.y + (heights[e.from] || 104) / 2;
      const x2 = b.x;
      const y2 = b.y + (heights[e.to] || 104) / 2;
      const dx = Math.max(30, (x2 - x1) * 0.5);
      d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
      edgeMids[key] = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
    }
    const active = edgeSel?.from === e.from && edgeSel?.to === e.to;
    const mid = edgeMids[key];
    return (
      <g key={`${e.from}-${e.to}-${i}`}>
        <path
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth={active ? 2.4 : 1.6}
          strokeDasharray={live ? "6 5" : meta.dash}
          className={live ? "wf-edge-live" : undefined}
        />
        {/* 细线太难点中 —— 铺一条透明的粗线专门接点击 */}
        <path
          d={d}
          fill="none"
          stroke="transparent"
          strokeWidth={18}
          style={{ pointerEvents: "stroke", cursor: "pointer" }}
          onClick={(ev) => {
            ev.stopPropagation();
            onSelect(null);
            setEdgeSel(active ? null : { from: e.from, to: e.to });
          }}
        />
        {/* 关系标签：一眼看出这条线是什么关系，不必点开 */}
        <g transform={`translate(${mid.x},${mid.y})`} style={{ pointerEvents: "none" }}>
          <rect
            x={-23}
            y={-9.5}
            width={46}
            height={19}
            rx={9.5}
            fill="var(--color-surface)"
            stroke={active ? "var(--color-accent)" : stroke}
          />
          <text
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={10.5}
            fill={active ? "var(--color-accent)" : "var(--color-muted)"}
          >
            {meta.short}
          </text>
        </g>
      </g>
    );
  });

  const empty = graph.nodes.length === 0;

  return (
    <div
      ref={stageRef}
      data-canvas-drop="1"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onSelect(null);
          setEdgeSel(null);
        }
      }}
      className="relative h-full w-full overflow-auto"
      style={{
        backgroundColor: hot ? "color-mix(in srgb, var(--color-accent) 5%, var(--color-surface-2))" : "var(--color-surface-2)",
        backgroundImage: "radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--color-border) 85%, transparent) 1.2px, transparent 0)",
        backgroundSize: "20px 20px",
      }}
    >
      <div className="relative" style={{ width: layout.w, height: layout.h, minWidth: "100%" }}>
        <svg className="pointer-events-none absolute inset-0" width={layout.w} height={layout.h}>
          {ghost && (
            <path d={ghost} fill="none" stroke="var(--color-accent)" strokeWidth={1.6} strokeDasharray="5 4" />
          )}
          {edgesSvg}
        </svg>

        {/* 点中一条连线 → 就地选「这两个助手怎么配合」。不跳页、不弹原生弹窗 */}
        {edgeSel &&
          (() => {
            const e = graph.edges.find((x) => x.from === edgeSel.from && x.to === edgeSel.to);
            if (!e) return null;
            const mid = edgeMids[`${e.from}->${e.to}`];
            if (!mid) return null;
            const cur = e.rel ?? "serial";
            const nameOf = (nid: string) =>
              agentOf(graph.nodes.find((n) => n.nid === nid)?.agent_id ?? "")?.name ?? "?";
            return (
              <div
                className="absolute z-20 w-[252px] rounded-[10px] border p-2.5"
                style={{
                  left: Math.max(8, mid.x - 126),
                  top: mid.y + 16,
                  background: "var(--color-surface)",
                  borderColor: "var(--color-border)",
                  boxShadow: "0 10px 24px rgba(20,24,31,.13)",
                }}
                onClick={(ev) => ev.stopPropagation()}
              >
                <div className="mb-2 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                  {nameOf(e.from)} → {nameOf(e.to)}：这两个怎么配合？
                </div>
                <div className="flex flex-col gap-1">
                  {REL_OPTIONS.map((o) => (
                    <button
                      key={o.rel}
                      type="button"
                      disabled={frozen}
                      onClick={() => {
                        onChange({
                          ...graph,
                          edges: graph.edges.map((x) =>
                            x.from === e.from && x.to === e.to ? { ...x, rel: o.rel } : x,
                          ),
                        });
                        setEdgeSel(null);
                      }}
                      className="rounded-[8px] border px-2.5 py-1.5 text-left text-[12.5px] disabled:opacity-50"
                      style={
                        cur === o.rel
                          ? {
                              borderColor: "var(--color-accent)",
                              background: "color-mix(in srgb, var(--color-accent) 7%, transparent)",
                            }
                          : { borderColor: "var(--color-border)" }
                      }
                    >
                      <span className="font-semibold">{o.label}</span>
                      <span className="ml-1.5 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                        {o.hint}
                      </span>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={frozen}
                  onClick={() => {
                    onChange({
                      ...graph,
                      edges: graph.edges.filter((x) => !(x.from === e.from && x.to === e.to)),
                    });
                    setEdgeSel(null);
                  }}
                  className="mt-2 w-full rounded-[8px] border px-2 py-1 text-[12px] disabled:opacity-50"
                  style={{
                    borderColor: "color-mix(in srgb, var(--color-err) 30%, var(--color-border))",
                    color: "var(--color-err)",
                  }}
                >
                  删掉这条连线
                </button>
              </div>
            );
          })()}

        {empty && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="max-w-[430px]">
              <h2 className="text-[15px] font-semibold">这里有三种开始方式</h2>
              <p className="mt-1 text-[13px]" style={{ color: "var(--color-muted)" }}>
                一路摆下去就是一条流水线；摆两个谁也不连，就是并行两条线。
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {(
                  [
                    ["single", "只跟一个助手聊"],
                    ["serial", "串行：三个接力"],
                    ["fan", "并行：一个任务分几路"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => onPreset?.(k)}
                    className="rounded-[8px] border border-dashed px-3 py-2 text-[12.5px] transition-colors hover:border-solid"
                    style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {graph.nodes.map((n) => {
          const a = agentOf(n.agent_id);
          const p = layout.pos[n.nid] ?? { x: 0, y: 0 };
          const st = (runStates[n.nid] ?? "idle") as NodeState;
          const meta = META[st] ?? META.idle;
          const isSel = selected === n.nid;
          const isTarget = (hoverNid ?? dropTarget) === n.nid;
          const stepNo = layout.layers.findIndex((ids) => ids.includes(n.nid)) + 1;
          const out = outputs[n.nid];
          return (
            <div
              key={n.nid}
              data-nid={n.nid}
              ref={(el) => {
                nodeRefs.current[n.nid] = el;
              }}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(n.nid);
              }}
              className="absolute rounded-[10px] border transition-shadow"
              style={{
                transform: `translate(${p.x}px, ${p.y}px)`,
                width: NODE_W,
                background: "var(--color-surface)",
                borderColor: isTarget ? "var(--color-accent)" : isSel ? "var(--color-accent)" : meta.border,
                borderStyle: isTarget ? "dashed" : st === "stale" ? "dashed" : "solid",
                boxShadow: isSel
                  ? "0 0 0 3px color-mix(in srgb, var(--color-accent) 14%, transparent), 0 6px 18px rgba(20,24,31,.10)"
                  : "0 1px 2px rgba(20,24,31,.06), 0 2px 6px rgba(20,24,31,.05)",
                cursor: frozen ? "default" : "grab",
              }}
            >
              <div
                className="flex items-center gap-2 border-b px-2.5 py-2"
                style={{ borderColor: "var(--color-border)" }}
              >
                <span
                  className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[6px] border text-[11px] font-semibold"
                  style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)", color: "var(--color-muted)" }}
                >
                  {(a?.name ?? "?").slice(0, 1)}
                </span>
                <span className="truncate text-[13px] font-semibold">{a?.name ?? "助手已删除"}</span>
                {master === n.nid && (
                  <span
                    className="shrink-0 rounded-full border px-1.5 py-px text-[10px]"
                    style={{ borderColor: "var(--color-accent)", color: "var(--color-accent)" }}
                    title="主控（按连线自动判断，可在右侧改）"
                  >
                    主控
                  </span>
                )}
                <span
                  className="ml-auto shrink-0 rounded-full border px-1.5 py-px text-[10.5px]"
                  style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}
                >
                  第 {stepNo} 步
                </span>
                {!frozen && (
                  <button
                    type="button"
                    title="删掉这个节点"
                    onClick={(e) => {
                      e.stopPropagation();
                      onChange({
                        ...graph,
                        nodes: graph.nodes.filter((x) => x.nid !== n.nid),
                        edges: graph.edges.filter((x) => x.from !== n.nid && x.to !== n.nid),
                      });
                    }}
                    className="shrink-0 rounded px-1 text-[12px] opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-100"
                    style={{ color: "var(--color-muted)" }}
                  >
                    ✕
                  </button>
                )}
              </div>

              <div className="min-h-[40px] px-2.5 py-2 text-[12px]">
                {out ? (
                  <div
                    className="line-clamp-3 whitespace-pre-wrap break-words"
                    style={{ color: "var(--color-text)" }}
                  >
                    {out}
                  </div>
                ) : (
                  <span style={{ color: "var(--color-muted)" }}>
                    {a?.definition?.system_prompt?.slice(0, 60) || "（没有说明）"}
                  </span>
                )}
              </div>

              {hitl?.nid === n.nid && (
                <div
                  className="mx-2.5 mb-2 rounded-[8px] border p-2"
                  style={{
                    borderColor: "color-mix(in srgb, var(--color-warn) 40%, var(--color-border))",
                    background: "color-mix(in srgb, var(--color-warn) 6%, var(--color-surface))",
                  }}
                >
                  <div className="text-[12px] font-semibold" style={{ color: "var(--color-warn)" }}>
                    需要你点头才能继续
                  </div>
                  <div
                    className="my-1.5 break-all rounded-[6px] border px-2 py-1 font-mono text-[11px]"
                    style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
                  >
                    {hitlText(hitl.payload)}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" className="rounded-[6px] px-2 py-1 text-[12px] text-white" style={{ background: "var(--color-ok)" }} onClick={() => onHitl?.("allow")}>
                      允许一次
                    </button>
                    <button type="button" className="rounded-[6px] border px-2 py-1 text-[12px]" style={{ borderColor: "var(--color-border)" }} onClick={() => onHitl?.("allow_all")}>
                      允许并记住
                    </button>
                    <button type="button" className="rounded-[6px] border px-2 py-1 text-[12px]" style={{ borderColor: "color-mix(in srgb, var(--color-err) 35%, var(--color-border))", color: "var(--color-err)" }} onClick={() => onHitl?.("deny")}>
                      拒绝
                    </button>
                  </div>
                  <div className="mt-1.5 text-[11px]" style={{ color: "var(--color-muted)" }}>
                    不想每次都问？去「{a?.name}」的配置里调权限范围。
                  </div>
                </div>
              )}

              <div
                className="flex items-center gap-2 border-t px-2.5 py-1.5 text-[11.5px]"
                style={{ borderColor: "var(--color-border)" }}
              >
                <span className="inline-flex items-center gap-1.5 font-medium" style={{ color: meta.text }}>
                  <i className="h-[7px] w-[7px] rounded-full" style={{ background: meta.dot }} />
                  {STATE_LABEL[st]}
                </span>
                <span className="ml-auto truncate font-mono text-[10.5px]" style={{ color: "var(--color-muted)" }}>
                  {a?.definition?.model?.name ?? ""}
                </span>
              </div>

              {/* 连接点：入口 / 出口（拖出口到另一个节点 = 连一条线） */}
              <span
                className="absolute top-1/2 left-[-7px] h-[13px] w-[13px] -translate-y-1/2 rounded-full border-2"
                style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
                title="入口"
              />
              <span
                className="absolute top-1/2 right-[-7px] h-[13px] w-[13px] -translate-y-1/2 cursor-crosshair rounded-full border-2"
                style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
                title="从这里拖到另一个助手 = 接在它后面"
                onPointerDown={(e) => startLink(e, n.nid)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 把待确认的调用说人话：input 可能是对象，也可能是 JSON 字符串（AgentScope 两种都给） */
export function hitlText(payload: Record<string, unknown> | null | undefined): string {
  const calls = (payload?.tool_calls as { name?: string; input?: unknown }[] | undefined) ?? [];
  if (!calls.length) return "（等待确认）";
  const c = calls[0];
  let input: Record<string, unknown> | null = null;
  if (c.input && typeof c.input === "object") input = c.input as Record<string, unknown>;
  else if (typeof c.input === "string") {
    try {
      const parsed = JSON.parse(c.input) as unknown;
      if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
    } catch {
      /* 不是 JSON 就原样显示 */
    }
  }
  if (!input) return `${c.name ?? "工具"} ${String(c.input ?? "").slice(0, 120)}`;
  const key = ["command", "file_path", "path", "url", "query"].find((k) => typeof input![k] === "string");
  return key ? `${c.name} · ${key}: ${String(input[key])}` : `${c.name} ${JSON.stringify(input).slice(0, 120)}`;
}
