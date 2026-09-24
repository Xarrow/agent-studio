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

import type { NodeLiveInfo } from "@/components/StepExecPanel";
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
export function edgeOrder(e: WorkflowEdge): "serial" | "parallel" {
  if (e.order === "parallel") return "parallel";
  if (e.rel === "parallel") return "parallel"; // 旧数据
  return "serial";
}

export function sharesContext(e: WorkflowEdge): boolean {
  return !!e.share_context || e.rel === "context";
}

export function sharesMemory(e: WorkflowEdge): boolean {
  return !!e.share_memory || e.rel === "memory";
}

/** 只有"串行"才构成依赖；并行线表达的是"同时跑"，不参与排序 */
export function isDep(e: WorkflowEdge): boolean {
  return edgeOrder(e) !== "parallel";
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
  /** 各节点**实时摘要**（正在干什么/耗时/思考/工具/输出）—— 悬停卡、节点角标、右侧抽屉共用 */
  live?: Record<string, NodeLiveInfo>;
  /** 右侧抽屉正在看哪个节点（null = 收起）。抽屉在画布内，不跳页、不挡画布 */
  detailNid?: string | null;
  onDetail?: (nid: string | null) => void;
  /** 画布两端的"卡"：左边是你这次交给它们的任务，右边是合起来的结论 ——
   *  画布因此自己讲完一次执行：我让你做什么 → 谁做了什么 → 合起来是什么。 */
  taskText?: string;
  finalText?: string;
  /** 任务卡就是输入口：文本、改文本、跑（运行键长在流程起点上） */
  taskValue?: string;
  onTaskValue?: (v: string) => void;
  onRun?: () => void;
  running?: boolean;
  /** 当前会跑什么模式（显示在运行键上） */
  derived?: string;
  /** 结论卡点开时定位到哪一步（最后一步） */
  lastNid?: string | null;
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
 * 连线上的**两个维度** —— 它们**正交**，可以任意组合。
 *
 * 原来我做成"四选一"（串行/并行/上下文/记忆），这是**建模错误**：
 * 并行的时候一样可以共享记忆、共享上下文，串行也可以。
 * 用户的心智是"这两个怎么配合" —— 时序一件事，共享另外两件事。
 */
const ORDER_OPTIONS = [
  { order: "serial", label: "串行接力", hint: "等它跑完，把结论交给下一个" },
  { order: "parallel", label: "并行", hint: "两个同时开始，互不等待" },
] as const;

const SHARE_OPTIONS = [
  { key: "share_context", label: "共享上下文", hint: "跑的时候能看见对方说过的话" },
  { key: "share_memory", label: "共享记忆", hint: "结论沉淀成记忆，双方都记得" },
] as const;

/** 时序怎么画：靠**虚实**区分，不只靠颜色（色弱也能分辨） */
const ORDER_META: Record<string, { short: string; dash?: string }> = {
  serial: { short: "串行" },
  parallel: { short: "并行", dash: "2 5" },
};
export function WorkflowCanvas({
  agents,
  graph,
  onChange,
  selected,
  onSelect,
  runStates,
  outputs,
  live,
  detailNid = null,
  onDetail,
  taskText = "",
  finalText = "",
  lastNid = null,
  taskValue = "",
  onTaskValue,
  onRun,
  running = false,
  derived = "",
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
  /**
   * 鼠标悬停在哪个节点上（= 就地看它在干什么）。
   * 延迟 350ms 才弹，避免"鼠标划过就闪"；移出后延迟 250ms 才收，
   * 这样鼠标能移进卡片里滚动阅读（否则一离开节点卡片就没了，滚不了）。
   */
  const [peek, setPeek] = useState<{ nid: string; left: number; top: number; maxH: number } | null>(
    null,
  );
  const peekTimer = useRef<number | null>(null);
  const peekIn = (nid: string, delay = 350) => {
    if (peekTimer.current) window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => {
      // 位置在**真要显示时**才量 —— 期间画布可能滚过/重排过
      const el = nodeRefs.current[nid];
      if (!el) return;
      const r = el.getBoundingClientRect();
      const W = 320;
      const H = 380;
      const below = r.bottom + 12;
      const flip = below + H > window.innerHeight - 8;   // 下方不够 → 翻到上方
      setPeek({
        nid,
        left: Math.min(Math.max(8, r.left), window.innerWidth - W - 8),
        top: flip ? Math.max(8, r.top - H - 12) : below,
        maxH: flip ? r.top - 20 : window.innerHeight - below - 12,
      });
    }, delay);
  };
  const peekOut = (delay = 250) => {
    if (peekTimer.current) window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => setPeek(null), delay);
  };
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
    /** 两端的卡宽度（任务卡 / 结论卡）—— 它们排在助手节点这一列的左边和右边 */
    // 卡片宽度：要能让「任务卡 + 一层节点 + 结论卡」在 864px 画布内同屏放下
    // （280+76+232+76+280 = 944 放不下，会切掉一头；224 刚好）
    const CARD_W = 224;
    const LEAD = CARD_W + GAP_X;
    const hOf = (nid: string) => heights[nid] || 104;
    const pos: Record<string, { x: number; y: number }> = {};
    let maxX = 0;
    let maxY = 0;
    if (narrow) {
      let y = PAD + 96;                 // 窄屏：给顶部的任务卡让一行
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
          pos[nid] = { x: PAD + LEAD + ci * (NODE_W + GAP_X), y };
          y += hOf(nid) + GAP_Y;
          maxX = Math.max(maxX, pos[nid].x + NODE_W + PAD);
        });
        maxY = Math.max(maxY, y);
      });
    }
    // 两端的卡：宽屏放在首/末层同一行；窄屏放最上/最下
    const firstIds = layers[0] ?? [];
    const lastIds = layers[layers.length - 1] ?? [];
    const firstY = firstIds.length ? (pos[firstIds[0]]?.y ?? PAD) : PAD;
    const lastY = lastIds.length ? (pos[lastIds[0]]?.y ?? PAD) : PAD;
    const taskAt = narrow ? { x: PAD, y: PAD } : { x: PAD, y: firstY };
    const concAt = narrow ? { x: PAD, y: maxY + 10 } : { x: maxX + GAP_X, y: lastY };
    let w = Math.max(maxX, 320);
    let h = Math.max(maxY, 260);
    if (!narrow) w = Math.max(w, concAt.x + CARD_W + PAD);
    else h = Math.max(h, concAt.y + 150);
    return { pos, w, h, layers, taskAt, concAt, CARD_W };
  }, [graph.nodes, graph.edges, heights, narrow, taskText, finalText]);

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
    const ord = edgeOrder(e);
    const ordMeta = ORDER_META[ord] ?? ORDER_META.serial;
    const shared = sharesContext(e) || sharesMemory(e);
    // 运行中的颜色优先（正在流动比"什么关系"更重要）；空闲时"共享"用青色系，
    // 一眼看出这一组在互相共享（虚实区分时序，颜色区分共享）
    const stroke = live
      ? "var(--color-accent)"
      : done
        ? "color-mix(in srgb, var(--color-ok) 55%, var(--color-border))"
        : shared
          ? "color-mix(in srgb, var(--color-info) 55%, var(--color-border))"
          : "var(--color-border)";
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
          strokeDasharray={live ? "6 5" : ordMeta.dash}
          className={live ? "wf-edge-live" : done ? "edge-flow" : undefined}
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
        {/* 连线标签：时序 + 有没有共享，一眼看出这两个怎么配合，不必点开 */}
        <g transform={`translate(${mid.x},${mid.y})`} style={{ pointerEvents: "none" }}>
          {(() => {
            const label = shared ? `${ordMeta.short}·共享` : ordMeta.short;
            const w = label.length * 10.5 + 12;
            return (
              <>
                <rect
                  x={-w / 2}
                  y={-9.5}
                  width={w}
                  height={19}
                  rx={9.5}
                  fill="var(--color-surface)"
                  stroke={active ? "var(--color-accent)" : stroke}
                />
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={10.5}
                  fill={
                    active
                      ? "var(--color-accent)"
                      : shared
                        ? "color-mix(in srgb, var(--color-info) 80%, var(--color-muted))"
                        : "var(--color-muted)"
                  }
                >
                  {label}
                </text>
              </>
            );
          })()}
        </g>
      </g>
    );
  });

  const empty = graph.nodes.length === 0;

  /** 右侧抽屉要用的：哪个节点 / 它的助手 / 这一步的完整数据 / 状态 / 序号 */
  const drawerStep = detailNid ? live?.[detailNid] : undefined;
  const drawerNode = detailNid ? graph.nodes.find((x) => x.nid === detailNid) : undefined;
  const drawerAgent = drawerNode ? agentOf(drawerNode.agent_id) : undefined;
  const drawerState = (detailNid ? (runStates[detailNid] ?? "idle") : "idle") as NodeState;
  const drawerMeta = META[drawerState] ?? META.idle;
  const drawerIdx = detailNid
    ? graph.nodes.findIndex((x) => x.nid === detailNid)
    : -1;
  const [drawerLog, setDrawerLog] = useState(false);

  /** 任务卡：点一下就地变输入框（这是方案 C —— 不再有页面底部的发令区） */
  const [editTask, setEditTask] = useState(false);
  const taskBoxRef = useRef<HTMLTextAreaElement>(null);
  const growTask = () => {
    const el = taskBoxRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };
  useEffect(() => {
    if (editTask) growTask();
  }, [editTask, taskValue]);

  /** 抽屉打开时把选中的节点滚进视野 —— 抽屉占掉右侧一截，
   *  不滚的话点开的节点可能正好被挤到视口外（点了没反应，最劝退）。 */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !detailNid || narrow) return;
    const at = layout.pos[detailNid];
    if (!at) return;
    // 按**最右边的内容**算（结论卡常常比节点更靠右）—— 差一点就会少露 60px
    const rightEdge = Math.max(at.x + NODE_W, layout.concAt.x + layout.CARD_W) + 4;
    const need = rightEdge - stage.clientWidth;
    if (need > stage.scrollLeft) stage.scrollTo({ left: need, behavior: "smooth" });
  }, [detailNid, layout]);

  /** 把结论卡滚进视野 —— 结论是这次执行最该看到的东西，不该藏在右边要人手动拖过去。
   *  写成**幂等**（"没滚到位就滚"），不用"只滚一次"的守卫：
   *  第一版用了守卫，结果它第一次触发时节点高度还没量完、布局还是旧的，
   *  算出不需要滚 → 守卫记下"滚过了" → 之后布局就算好也不会再滚（结论卡真的被切在屏幕外）。 */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || narrow || !finalText.trim()) return;
    const need = layout.concAt.x + layout.CARD_W + 6 - stage.clientWidth;
    if (need > stage.scrollLeft + 4) {
      const t = window.setTimeout(() => stage.scrollTo({ left: need, behavior: "smooth" }), 300);
      return () => window.clearTimeout(t);
    }
  }, [finalText, layout, narrow]);

  /** 悬停浮层要用到的：那个节点 / 它的助手 / 实时摘要 / 状态 */
  const peekNode = peek ? graph.nodes.find((x) => x.nid === peek.nid) : undefined;
  const peekAgent = peekNode ? agentOf(peekNode.agent_id) : undefined;
  const peekLive = peek ? live?.[peek.nid] : undefined;
  const peekState = (peek ? (runStates[peek.nid] ?? "idle") : "idle") as NodeState;
  const peekMeta = META[peekState] ?? META.idle;

  return (
    /* 外层 flex：画布 + 右侧抽屉左右并排。
       抽屉**在画布这一层**，不是页面下方、也不是弹窗 —— 点节点内容就在旁边出现，
       视线不用离开对象；收起后画布自动恢复全宽。 */
    <div className="relative flex h-full min-h-0 w-full">
    <div
      ref={stageRef}
      data-canvas-drop="1"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onSelect(null);
          setEdgeSel(null);
        }
      }}
      className="relative h-full min-w-0 flex-1 overflow-auto"
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
            const ord = edgeOrder(e);
            const nameOf = (nid: string) =>
              agentOf(graph.nodes.find((n) => n.nid === nid)?.agent_id ?? "")?.name ?? "?";
            // 改任何一项都顺手清掉旧的 rel（否则老字段会继续盖着新字段）
            const patch = (next: Partial<WorkflowEdge>) =>
              onChange({
                ...graph,
                edges: graph.edges.map((x) =>
                  x.from === e.from && x.to === e.to ? { ...x, ...next, rel: undefined } : x,
                ),
              });
            return (
              <div
                className="absolute z-20 w-[264px] rounded-[10px] border p-2.5"
                style={{
                  left: Math.max(8, mid.x - 132),
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

                {/* ① 顺序：二选一 */}
                <div className="mb-1 text-[11px] font-medium" style={{ color: "var(--color-muted)" }}>
                  顺序
                </div>
                <div className="mb-2.5 flex gap-1">
                  {ORDER_OPTIONS.map((o) => (
                    <button
                      key={o.order}
                      type="button"
                      disabled={frozen}
                      title={o.hint}
                      onClick={() => patch({ order: o.order })}
                      className="flex-1 rounded-[8px] border px-2 py-1.5 text-[12.5px] disabled:opacity-50"
                      style={
                        ord === o.order
                          ? {
                              borderColor: "var(--color-accent)",
                              background: "color-mix(in srgb, var(--color-accent) 7%, transparent)",
                              fontWeight: 600,
                            }
                          : { borderColor: "var(--color-border)" }
                      }
                    >
                      {o.label}
                    </button>
                  ))}
                </div>

                {/* ② 共享：可多选（和顺序正交，怎么组都行） */}
                <div className="mb-1 text-[11px] font-medium" style={{ color: "var(--color-muted)" }}>
                  共享（可以不选、可以都选）
                </div>
                <div className="flex flex-col gap-1">
                  {SHARE_OPTIONS.map((o) => {
                    const on =
                      o.key === "share_context" ? sharesContext(e) : sharesMemory(e);
                    return (
                      <button
                        key={o.key}
                        type="button"
                        disabled={frozen}
                        onClick={() =>
                          patch(
                            o.key === "share_context"
                              ? { share_context: !on }
                              : { share_memory: !on },
                          )
                        }
                        className="flex items-center gap-2 rounded-[8px] border px-2.5 py-1.5 text-left text-[12.5px] disabled:opacity-50"
                        style={
                          on
                            ? {
                                borderColor: "color-mix(in srgb, var(--color-info) 55%, var(--color-border))",
                                background: "color-mix(in srgb, var(--color-info) 7%, transparent)",
                              }
                            : { borderColor: "var(--color-border)" }
                        }
                      >
                        <span
                          className="grid h-[15px] w-[15px] shrink-0 place-items-center rounded-[4px] border text-[10px]"
                          style={{
                            borderColor: on ? "var(--color-info)" : "var(--color-border)",
                            color: on ? "var(--color-info)" : "transparent",
                          }}
                        >
                          ✓
                        </span>
                        <span className="font-semibold">{o.label}</span>
                        <span className="text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                          {o.hint}
                        </span>
                      </button>
                    );
                  })}
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
                  className="mt-2.5 w-full rounded-[8px] border px-2 py-1 text-[12px] disabled:opacity-50"
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

        {/* ── 画布两端的两张卡 ──────────────────────────────────────────────
            左：任务（你这次交给了它们什么）  右：结论（合起来是什么）
            为什么要画进画布里，而不是放页面底部：一次编排本来就是"从任务流向结论"的
            一条线 —— 结论是流程的**终点**，不是页面的脚注。放在画布上，它自己就把
            故事讲完了；页面下方也就不用再占一块地方。 */}
        {/* ── 任务卡：流程的起点，同时就是**输入口**（方案 C，2026-09-24 定案）──
            为什么把页面底部那个输入框去掉：任务本来就是画布上这张卡的一张脸，
            写任务 = 给流程填入口。分成"画布上的卡 + 页面底部的框"两处，
            是同一件事抄两份，眼睛还得上下跑。现在：点一下就地在卡里写，
            运行键（也就是流程的启动键）就长在起点上 —— 符合"一条线从这头流到那头"的直觉。
            Enter 运行 · Shift+Enter 换行 · Esc 收起（与原来全站一致）。 */}
        <div
          className="absolute rounded-[10px] border border-dashed px-2.5 py-2"
          style={{
            transform: `translate(${layout.taskAt.x}px, ${layout.taskAt.y}px)`,
            width: layout.CARD_W,
            background: "var(--color-surface-2)",
            borderColor: editTask ? "var(--color-accent)" : "var(--color-border)",
            cursor: editTask ? "text" : "pointer",
          }}
          onClick={(e) => {
            e.stopPropagation();
            setEditTask(true);
          }}
          title={editTask ? undefined : "点一下写任务"}
        >
          <div className="flex items-center gap-2">
            <span className="text-[10.5px] font-semibold" style={{ color: "var(--color-muted)" }}>
              任务
            </span>
            {!editTask && taskText.trim() && (
              <span className="ml-auto text-[10.5px]" style={{ color: "var(--color-accent)" }}>
                点击修改
              </span>
            )}
          </div>

          {editTask ? (
            <>
              <textarea
                ref={taskBoxRef}
                autoFocus
                value={taskValue}
                rows={2}
                onChange={(e) => onTaskValue?.(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setEditTask(false);
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    setEditTask(false);
                    onRun?.();
                  }
                }}
                onBlur={() => window.setTimeout(() => setEditTask(false), 160)}
                placeholder="写一句任务 —— 比如：调研三家云厂商的 GPU 报价并汇总成表"
                className="mt-1 w-full resize-none rounded-[6px] border px-2 py-1.5 text-[12px] leading-[1.65] outline-none"
                style={{
                  borderColor: "var(--color-border)",
                  background: "var(--color-surface)",
                  maxHeight: 200,
                }}
              />
              <div className="mt-1 text-[10px]" style={{ color: "var(--color-muted)" }}>
                Enter 运行 · Shift+Enter 换行
              </div>
            </>
          ) : (
            <div
              className="mt-0.5 line-clamp-4 whitespace-pre-wrap break-words text-[12px] leading-[1.6]"
              style={taskText.trim() ? undefined : { color: "var(--color-muted)" }}
            >
              {taskText.trim() || "点一下写任务 —— 写完按 Enter 就跑"}
            </div>
          )}

          {/* 运行键就在起点上：流程从这里开跑 */}
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={running}
              onClick={(e) => {
                e.stopPropagation();
                setEditTask(false);
                onRun?.();
              }}
              className="rounded-[8px] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-45"
              style={{ background: "var(--color-accent)" }}
              title={`按 ${derived || "自动"} 方式执行（Enter）`}
            >
              {running ? "运行中…" : `▸ 运行 · ${derived || "自动"}`}
            </button>
          </div>
        </div>

        {finalText.trim() && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (lastNid) onDetail?.(lastNid);
            }}
            className="absolute rounded-[10px] border px-2.5 py-2 text-left transition-shadow hover:shadow-md"
            style={{
              transform: `translate(${layout.concAt.x}px, ${layout.concAt.y}px)`,
              width: layout.CARD_W,
              background: "color-mix(in srgb, var(--color-accent) 6%, var(--color-surface))",
              borderColor: "color-mix(in srgb, var(--color-accent) 45%, var(--color-border))",
            }}
            title="这次执行合起来的结论（点开看全文）"
          >
            <div className="text-[10.5px] font-semibold" style={{ color: "var(--color-accent)" }}>
              结论
            </div>
            <div className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-[12px] leading-[1.6]">
              {finalText}
            </div>
            <div className="mt-1 text-[10.5px]" style={{ color: "var(--color-accent)" }}>
              点开看全文 →
            </div>
          </button>
        )}

        {/* 卡与节点之间的两条虚线：把"任务 → … → 结论"串起来 */}
        <svg className="pointer-events-none absolute inset-0" width={layout.w} height={layout.h}>
          {(() => {
            const lines: React.ReactNode[] = [];
            const first = layout.layers[0] ?? [];
            const last = layout.layers[layout.layers.length - 1] ?? [];
            const yOf = (nid: string) => (layout.pos[nid]?.y ?? 24) + (heights[nid] || 104) / 2;
            const f = first[0];
            if (f && taskText.trim()) {
              const x1 = layout.taskAt.x + layout.CARD_W;
              const y1 = yOf(f);
              lines.push(
                <path
                  key="t"
                  d={`M${x1},${y1} L${layout.pos[f].x - 10},${y1}`}
                  stroke="var(--color-border)"
                  strokeWidth={1.6}
                  strokeDasharray="5 5"
                  fill="none"
                />,
              );
            }
            const l = last[0];
            if (l && finalText.trim()) {
              const x1 = layout.pos[l].x + NODE_W;
              const y1 = yOf(l);
              lines.push(
                <path
                  key="c"
                  d={`M${x1},${y1} L${layout.concAt.x - 10},${y1}`}
                  stroke="var(--color-border)"
                  strokeWidth={1.6}
                  strokeDasharray="5 5"
                  fill="none"
                />,
              );
            }
            return lines;
          })()}
        </svg>

        {graph.nodes.map((n) => {
          const a = agentOf(n.agent_id);
          const p = layout.pos[n.nid] ?? { x: 0, y: 0 };
          const st = (runStates[n.nid] ?? "idle") as NodeState;
          const meta = META[st] ?? META.idle;
          const lv = live?.[n.nid];
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
                // 点节点 = 看它**这次跑了什么**（右侧抽屉）。配置是"改设置"，
                // 频率低得多，挪到 ⚙ —— 两种意图分开，不用猜。
                onDetail?.(detailNid === n.nid ? null : n.nid);
              }}
              onMouseEnter={() => peekIn(n.nid)}
              onMouseLeave={() => peekOut()}
              className={`group absolute rounded-[10px] border transition-shadow ${
                lv && st === "run" ? "node-run" : st === "ask" ? "node-ask" : ""
              }`}
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
                {/* 节点上只留三样：**序号、名字、一行摘要**。
                    原来这里有 10 个元素：[主控] 徽标、[第N步] 徽标、⚙、✕、模型名…
                    · [第N步] → 就是序号（不需要两个都在）
                    · [主控] → 名字前一个星标
                    · ⚙ / ✕ → 悬停或选中才出现（平时不占位）
                    · 模型名 → 进右侧抽屉（助手栏已经写着了） */}
                <span
                  className="grid h-[20px] w-[20px] shrink-0 place-items-center rounded-full border text-[10.5px] font-semibold"
                  style={{ borderColor: meta.border, background: "var(--color-surface-2)", color: meta.text }}
                  title={`第 ${stepNo} 步`}
                >
                  {stepNo}
                </span>
                {master === n.nid && (
                  <span
                    className="shrink-0 text-[11px] leading-none"
                    style={{ color: "var(--color-accent)" }}
                    title="主控（按连线自动判断）"
                  >
                    ★
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                  {a?.name ?? "助手已删除"}
                </span>
                <i
                  className="h-[7px] w-[7px] shrink-0 rounded-full"
                  style={{ background: meta.dot }}
                  title={STATE_LABEL[st]}
                />
                <div
                  className={`flex shrink-0 items-center gap-1 transition-opacity ${
                    isSel || detailNid === n.nid ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  }`}
                >
                  <button
                    type="button"
                    title="配置这个助手"
                    aria-label="配置这个助手"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(n.nid);
                    }}
                    className="shrink-0 rounded border px-1.5 text-[12px] hover:opacity-100"
                    style={{ color: "var(--color-muted)" }}
                  >
                    ⚙
                  </button>
                  {!frozen && (
                    <button
                      type="button"
                      title="把这一步从编排里移掉"
                      aria-label="把这一步从编排里移掉"
                      onClick={(e) => {
                        e.stopPropagation();
                        onChange({
                          ...graph,
                          nodes: graph.nodes.filter((x) => x.nid !== n.nid),
                          edges: graph.edges.filter((x) => x.from !== n.nid && x.to !== n.nid),
                        });
                      }}
                      className="shrink-0 rounded border px-1.5 text-[12px] hover:opacity-100"
                      style={{ color: "var(--color-muted)" }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>

              {/* 实时摘要：一眼看出"它在干什么" —— 不用点、不用往下看 */}
              {lv && (st === "run" || st === "ok" || st === "err" || st === "ask") && (
                <div
                  className="flex items-center gap-2 px-2.5 pt-1.5 text-[11px]"
                  style={{ color: meta.text }}
                >
                  <span className="shrink-0 font-medium">
                    {st === "run" ? "⟳" : st === "ok" ? "✓" : st === "err" ? "✕" : "⏸"}{" "}
                    {lv.elapsedMs == null ? "—" : lv.elapsedMs < 1000
                      ? `${Math.round(lv.elapsedMs)}ms`
                      : `${(lv.elapsedMs / 1000).toFixed(1)}s`}
                  </span>
                  {lv.iters > 0 && <span className="shrink-0">↻{lv.iters}</span>}
                  {lv.tools.length > 0 && <span className="shrink-0">🛠{lv.tools.length}</span>}
                  {lv.action && (
                    <span className="truncate" style={{ color: "var(--color-muted)" }}>
                      {lv.action}
                    </span>
                  )}
                </div>
              )}
              {st === "run" && <div className="indeterminate mx-2.5 mt-1.5" />}

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

        {/* 悬停卡（浮层）—— 鼠标停在节点上就地看它在干什么。
            为什么用 fixed：画布容器有固定高度，卡片挂在节点里会被下边缘裁掉
            （只露出第一行）。浮层不受裁剪，下方不够会自动翻到节点上方。 */}
        {peek && peekLive && (
          <div
            onMouseEnter={() => peekIn(peek.nid, 0)}
            onMouseLeave={() => peekOut(120)}
            className="fixed z-[70] flex flex-col overflow-hidden rounded-[10px] border"
            style={{
              left: peek.left,
              top: peek.top,
              width: 320,
              maxHeight: Math.max(160, peek.maxH),
              background: "var(--color-surface)",
              borderColor: "var(--color-border)",
              boxShadow: "0 12px 34px rgba(20,24,31,.20)",
            }}
          >
            <div
              className="flex items-center gap-2 border-b px-2.5 py-2"
              style={{ borderColor: "var(--color-border)" }}
            >
              <span className="truncate text-[12.5px] font-semibold">{peekAgent?.name ?? "助手"}</span>
              <span className="ml-auto shrink-0 text-[11px]" style={{ color: peekMeta.text }}>
                {STATE_LABEL[peekState]}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-auto px-2.5 py-2">
              <div className="mb-1 text-[10.5px] font-semibold" style={{ color: "var(--color-muted)" }}>
                思考
              </div>
              <div className="mb-2 whitespace-pre-wrap break-words text-[11.5px] leading-[1.6]">
                {peekLive.thinking ? (
                  peekLive.thinking.length > 700 ? peekLive.thinking.slice(-700) : peekLive.thinking
                ) : (
                  <span style={{ color: "var(--color-muted)" }}>
                    {peekState === "run" ? "还在想…" : "这一步没有思考内容"}
                  </span>
                )}
              </div>

              <div className="mb-1 text-[10.5px] font-semibold" style={{ color: "var(--color-muted)" }}>
                工具（{peekLive.tools.length}）
              </div>
              <div className="mb-2 flex flex-col gap-1">
                {peekLive.tools.length === 0 ? (
                  <span className="text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                    还没调用工具
                  </span>
                ) : (
                  peekLive.tools.slice(-3).map((t, i) => (
                    <div key={i} className="flex items-baseline gap-1.5 text-[11px]">
                      <code className="mono shrink-0 font-semibold">{t.name}</code>
                      <span
                        className="shrink-0"
                        style={{
                          color:
                            t.state === "成功"
                              ? "var(--color-ok)"
                              : t.state === "调用中"
                                ? "var(--color-accent)"
                                : "var(--color-err)",
                        }}
                      >
                        {t.state}
                      </span>
                      <span className="truncate" style={{ color: "var(--color-muted)" }}>
                        {t.args.replace(/\s+/g, " ").slice(0, 60)}
                      </span>
                    </div>
                  ))
                )}
              </div>

              <div className="mb-1 text-[10.5px] font-semibold" style={{ color: "var(--color-muted)" }}>
                输出
              </div>
              <div className="whitespace-pre-wrap break-words text-[11.5px] leading-[1.6]">
                {peekLive.output ? (
                  peekLive.output.length > 600 ? `${peekLive.output.slice(0, 600)}…` : peekLive.output
                ) : (
                  <span style={{ color: "var(--color-muted)" }}>
                    {peekState === "run" ? "还没输出" : "没有输出"}
                  </span>
                )}
              </div>
            </div>

            <div
              className="flex items-center gap-2 border-t px-2.5 py-1.5 text-[10.5px]"
              style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}
            >
              <span>日志 {peekLive.eventCount} 条</span>
              <span>↻{peekLive.iters} 轮</span>
              <span className="ml-auto" style={{ color: "var(--color-accent)" }}>
                按一下看全部 →
              </span>
            </div>
          </div>
        )}
      </div>
    </div>

      {/* ── 右侧抽屉：这一次跑了什么（思考/工具/输出/日志全文）────────────── */}
      {detailNid && (
        <aside
          className={`flex shrink-0 flex-col border-l ${
            narrow ? "absolute inset-y-0 right-0 z-50 w-full" : "w-[320px]"
          }`}
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
        >
          <div
            className="flex items-center gap-2 border-b px-3 py-2.5"
            style={{ borderColor: "var(--color-border)" }}
          >
            <span
              className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full border text-[11px] font-semibold"
              style={{
                borderColor: "var(--color-border)",
                background: "var(--color-surface-2)",
                color: "var(--color-muted)",
              }}
            >
              {drawerIdx + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
              {drawerAgent?.name ?? "助手"}
            </span>
            <span className="shrink-0 text-[11.5px]" style={{ color: drawerMeta.text }}>
              {STATE_LABEL[drawerState]}
            </span>
            {drawerStep?.elapsedMs != null && drawerStep.elapsedMs > 0 && (
              <span className="shrink-0 text-[11px]" style={{ color: "var(--color-muted)" }}>
                {drawerStep.elapsedMs < 1000
                  ? `${Math.round(drawerStep.elapsedMs)}ms`
                  : `${(drawerStep.elapsedMs / 1000).toFixed(1)}s`}
              </span>
            )}
            <button
              type="button"
              title="收起"
              aria-label="收起"
              onClick={() => onDetail?.(null)}
              className="shrink-0 rounded border px-1.5 text-[12px] opacity-60 transition-opacity hover:opacity-100"
              style={{ color: "var(--color-muted)" }}
            >
              ✕
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-3 py-2.5">
            {!drawerStep && (
              <p className="text-[12.5px] leading-[1.7]" style={{ color: "var(--color-muted)" }}>
                这个助手还没跑过。写下任务点「运行」，这里会显示它的思考、工具调用与输出。
              </p>
            )}

            {drawerStep?.input && (
              <Block title="这一步收到">
                <div className="whitespace-pre-wrap text-[12px] leading-[1.7]">
                  {drawerStep.input}
                </div>
              </Block>
            )}

            {drawerStep && (
              <Block title="思考">
                <div className="whitespace-pre-wrap text-[12px] leading-[1.7]">
                  {drawerStep.thinking || (
                    <span style={{ color: "var(--color-muted)" }}>
                      {drawerState === "run" ? "还在想…" : "这一步没有思考内容"}
                    </span>
                  )}
                </div>
              </Block>
            )}

            {drawerStep && (
              <Block title={`工具（${drawerStep.tools.length}）`}>
                {drawerStep.tools.length === 0 ? (
                  <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                    没调用工具
                  </span>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {drawerStep.tools.map((t, i) => (
                      <div
                        key={i}
                        className="rounded-[6px] border px-2 py-1.5"
                        style={{ borderColor: "var(--color-border)" }}
                      >
                        <div className="flex flex-wrap items-baseline gap-2 text-[12px]">
                          <code className="mono font-semibold">{t.name}</code>
                          <span
                            className="text-[11px]"
                            style={{
                              color:
                                t.state === "成功"
                                  ? "var(--color-ok)"
                                  : t.state === "调用中"
                                    ? "var(--color-accent)"
                                    : "var(--color-err)",
                            }}
                          >
                            {t.state}
                          </span>
                        </div>
                        {t.args.trim() && (
                          <div
                            className="mono mt-0.5 break-all text-[11.5px]"
                            style={{ color: "var(--color-muted)" }}
                          >
                            {t.args}
                          </div>
                        )}
                        {t.result.trim() && (
                          <div
                            className="mono mt-1 max-h-[160px] overflow-auto whitespace-pre-wrap break-all rounded-[4px] px-1.5 py-1 text-[11.5px]"
                            style={{ background: "var(--color-surface-2)" }}
                          >
                            {t.result}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Block>
            )}

            {drawerStep && (
              <Block title="输出">
                <div className="whitespace-pre-wrap text-[12.5px] leading-[1.7]">
                  {drawerStep.output || (
                    <span style={{ color: "var(--color-muted)" }}>
                      {drawerState === "run" ? "还没输出" : "没有输出"}
                    </span>
                  )}
                </div>
              </Block>
            )}

            {drawerStep && drawerStep.events.length > 0 && (
              <div className="mt-2 border-t pt-2" style={{ borderColor: "var(--color-border)" }}>
                <button
                  type="button"
                  onClick={() => setDrawerLog((v) => !v)}
                  className="text-[11.5px]"
                  style={{ color: "var(--color-muted)" }}
                >
                  {drawerLog ? "收起日志" : `日志（${drawerStep.events.length} 条事件）`}
                </button>
                {drawerLog && (
                  <div className="mono mt-1.5 max-h-[220px] overflow-auto text-[11px] leading-[1.8]">
                    {drawerStep.events.map((ev) => (
                      <div key={ev.seq} className="flex gap-2">
                        <span className="shrink-0" style={{ color: "var(--color-muted)" }}>
                          {new Date(ev.ts).toLocaleTimeString("zh-CN", { hour12: false })}
                        </span>
                        <span style={{ color: "var(--color-accent)" }}>{ev.type}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {drawerStep?.runId && (
            <div
              className="border-t px-3 py-2 text-right text-[11.5px]"
              style={{ borderColor: "var(--color-border)" }}
            >
              <a
                href={`/runs?run=${drawerStep.runId}`}
                style={{ color: "var(--color-accent)" }}
              >
                在运行记录里打开这一步 →
              </a>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

/** 抽屉里的小节标题 */
function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div
        className="mb-1 text-[11px] font-semibold"
        style={{ color: "var(--color-muted)" }}
      >
        {title}
      </div>
      {children}
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
