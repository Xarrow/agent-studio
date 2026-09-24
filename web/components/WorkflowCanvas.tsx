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
import Markdown from "./Markdown";

import type { NodeLiveInfo } from "@/components/StepExecPanel";
import { STEP_STYLE, type StepKind } from "@/components/ui/run-timeline";
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
  // Dify 的状态边框是**纯实线色**（border-state-success-solid / destructive-solid），
  // 不是掺了边框色的淡版 —— 之前掺淡是"看着柔和"，但跟 Dify 不一致，改回纯色。
  ok: { dot: "var(--color-ok)", text: "var(--color-ok)", border: "var(--color-ok)" },
  err: { dot: "var(--color-err)", text: "var(--color-err)", border: "var(--color-err)" },
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
  /** 右栏页签：过程（这次跑了什么）/ 配置（这个助手怎么配）。
   *  两者是**同一个节点**的两面 —— 之前各开一栏（并排两列 + 画布被压到 244px，实测），
   *  这里合并成一栏切换。 */
  panelTab?: "process" | "config";
  onPanelTab?: (t: "process" | "config") => void;
  /** 配置页签的内容由 Console 传进来（配置状态属于 Console，不搬进画布） */
  configSlot?: React.ReactNode;
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
  panelTab = "process",
  onPanelTab,
  configSlot = null,
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
  /** 任务卡的实测高度 —— 窄屏排布要按它让位。
   *  为什么不能写死：任务卡现在是"输入框常驻"，高度随内容变（原来 96 够，现在不够，
   *  写死会让节点压在任务卡上）。用 ResizeObserver 跟着量。 */
  const taskCardRef = useRef<HTMLDivElement>(null);
  const [taskH, setTaskH] = useState(0);
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

  /* 任务卡高度实测：内容/换行/字号变化都会影响它，所以用 ResizeObserver */
  useEffect(() => {
    const el = taskCardRef.current;
    if (!el) return;
    const measure = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      setTaskH((prev) => (Math.abs(prev - h) > 1 ? h : prev));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ── 布局：先量高度，再按层排版（位置全是算出来的，没有一处硬编码） ── */
  const layout = useMemo(() => {
    const layers = topoLayers(graph.nodes, graph.edges);
    // 间距/尺寸对齐 Dify 的 workflow 常量（NODE_WIDTH 240 / X_OFFSET 60 / Y_OFFSET 39）——
    // 直接读它源码拿的数，不是凭观感调的
    // 间距/宽度要满足"任务卡 + 节点 + 结论卡"在 864px 画布内一次放下
    //（200 + 44 + 232 + 44 + 300 = 820，加左右 padding 24 = 844 ✓）
    // —— 之前 60 + 各卡更宽，总量 1000+，结论卡会被右边缘切掉
    const GAP_X = 40;
    const GAP_Y = 39;
    const PAD = 10;
    /** 两端的卡宽度（任务卡 / 结论卡）—— 它们排在助手节点这一列的左边和右边 */
    // 卡片宽度：要能让「任务卡 + 一层节点 + 结论卡」在 864px 画布内同屏放下
    // （280+76+232+76+280 = 944 放不下，会切掉一头；224 刚好）
    const CARD_W = 200;
    /** 结论区宽度：任务是"要写"的（窄点无妨），结论是"要读"的 —— 给它更宽的台面 */
    const CONC_W = 288;
    const LEAD = CARD_W + GAP_X;
    const hOf = (nid: string) => heights[nid] || 104;
    const pos: Record<string, { x: number; y: number }> = {};
    let maxX = 0;
    let maxY = 0;
    if (narrow) {
      // 窄屏：任务卡在最上，中间节点**纵向逐个排**，结论最下。
      // 1) 让位高度改成**实测**（taskH）：任务卡现在是"输入框常驻"，比原来高得多，
      //    写死 96 会让节点压在任务卡上（实测就是这么坏掉的）。
      // 2) 同层节点不再横排 —— 手机宽 390，两个节点横排就是 490，必然横向溢出。
      // 兜底 240：实测任务卡高 211（输入框常驻后），给足余量 ——
      // 宁可多留 30px 空白，也不要因为"没量到"就让节点压在卡上。
      let y = PAD + (taskH || 240) + 14;
      layers.forEach((ids) => {
        ids.forEach((nid) => {
          pos[nid] = { x: PAD, y };
          maxX = Math.max(maxX, pos[nid].x + NODE_W + PAD);
          y += hOf(nid) + 30;
        });
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
    if (!narrow) w = Math.max(w, concAt.x + CONC_W + PAD);
    else {
      // 窄屏：三张卡都从 PAD 竖排，宽度只需容下**最宽的一张**，
      // 不能用 maxX（它累计了 NODE_W + PAD），否则手机会横向滚动。
      w = Math.max(CARD_W, NODE_W, CONC_W) + PAD * 2;
      h = Math.max(h, concAt.y + 150);
    }
    return { pos, w, h, layers, taskAt, concAt, CARD_W, CONC_W };
  }, [graph.nodes, graph.edges, heights, narrow, taskText, finalText, taskH]);

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
    const ek = `${e.from}->${e.to}`;   // 这条边的身份（插一步 + 选择器定位都用它）
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
          : "#D0D5DD";   // Dify 的连线基线灰（custom-connection-line.tsx 实测）
    const key = `${e.from}->${e.to}`;
    let d: string;
    /** 终点坐标（给 Dify 那个 2×8 的箭头方条用）—— 两个分支各自算完再带出来 */
    let tx = 0;
    let ty = 0;
    if (narrow) {
      const x1 = a.x + NODE_W / 2;
      const y1 = a.y + (heights[e.from] || 104);
      const x2 = b.x + NODE_W / 2;
      const y2 = b.y;
      tx = x2;
      ty = y2;
      const dy = Math.max(24, (y2 - y1) * 0.5);
      d = `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;
      edgeMids[key] = { x: x1, y: (y1 + y2) / 2 };
    } else {
      const x1 = a.x + NODE_W;
      const y1 = a.y + (heights[e.from] || 104) / 2;
      const x2 = b.x;
      const y2 = b.y + (heights[e.to] || 104) / 2;
      tx = x2;
      ty = y2;
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
          stroke={active ? "var(--color-accent)" : stroke}
          strokeWidth={active || hoverEdge === key ? 2.6 : 2}
          strokeDasharray={live ? "6 5" : ordMeta.dash}
          className={live ? "wf-edge-live" : done ? "edge-flow" : undefined}
        />
        {/* 终点小方块（Dify 的箭头就是这个 2×8 的方条，fill #2970FF，不是三角） */}
        <rect x={tx - 2} y={ty - 4} width={2} height={8} fill="#2970FF" />

        {/* 细线太难点中 —— 铺一条透明的粗线专门接点击 */}
        <path
          d={d}
          fill="none"
          stroke="transparent"
          strokeWidth={18}
          style={{ pointerEvents: "stroke", cursor: "pointer" }}
          onMouseEnter={() => setHoverEdge(key)}
          onMouseLeave={() => setHoverEdge((x) => (x === key ? null : x))}
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
          {/* ＋：在这一段流程里插一个助手 */}
          <g
            transform="translate(0,27)"
            style={{ cursor: "pointer" }}
            onPointerDown={(ev) => ev.stopPropagation()}
            onClick={(ev) => {
              ev.stopPropagation();
              setInsertAt(insertAt === ek ? null : ek);
            }}
          >
            <circle
              r={10.5}
              fill={insertAt === ek ? "var(--color-accent)" : "var(--color-surface)"}
              stroke="var(--color-accent)"
              strokeWidth={1.4}
            />
            <text
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={14}
              fill={insertAt === ek ? "#fff" : "var(--color-accent)"}
              style={{ userSelect: "none" }}
            >
              ＋
            </text>
          </g>
        </g>
      </g>
    );
  });

  const empty = graph.nodes.length === 0;

  /** 被选中的那个节点 → 它的**上游/下游链路**（选中时点亮，看清这条链怎么串的）
   *  现在只高亮自己，看不出依赖关系；Dify 选中节点会把整条依赖链着色。 */
  const chainRoot = detailNid ?? null;
  const chain = (() => {
    if (!chainRoot) return null;
    const up = new Set<string>();
    const down = new Set<string>();
    let q = [chainRoot];
    while (q.length) {
      const x = q.pop()!;
      for (const e of graph.edges)
        if (e.from === x && !down.has(e.to)) {
          down.add(e.to);
          q.push(e.to);
        }
    }
    q = [chainRoot];
    while (q.length) {
      const x = q.pop()!;
      for (const e of graph.edges)
        if (e.to === x && !up.has(e.from)) {
          up.add(e.from);
          q.push(e.from);
        }
    }
    return { up, down };
  })();
  /** 节点右上角 ⋯ 菜单当前开着的是哪一个 */
  const [nodeMenu, setNodeMenu] = useState<string | null>(null);
  /** 鼠标悬在哪条连线上（悬停时加粗，告诉用户"这条线是可点的"） */
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);

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

  /** 「＋」插一步：悬停/点击连线中点时打开选择器（开源 workflow 的标准交互 ——
   *  操作发生在你要改的那个位置，而不是"先记住拖到某个助手上是接在后面"这种暗规则） */
  const [insertAt, setInsertAt] = useState<string | null>(null);

  /** 把某个助手插到 from → to 中间：拆掉原边，接成 from → 新 → to */
  const insertBetween = (from: string, to: string, agentId: string) => {
    const used = new Set(graph.nodes.map((n) => n.nid));
    let k = graph.nodes.length + 1;
    while (used.has(`n${k}`)) k++;
    const nid = `n${k}`;
    const dead = graph.edges.find((e) => e.from === from && e.to === to);
    const kept = graph.edges.filter((e) => !(e.from === from && e.to === to));
    // 原边的设置（时序 + 共享上下文/记忆）跟着继承到新接出来的两段上，不然一插就丢设置
    const inherit = dead
      ? {
          order: dead.order,
          share_context: dead.share_context,
          share_memory: dead.share_memory,
        }
      : {};
    const legs: WorkflowGraph["edges"] = [
      { from, to: nid, ...inherit },
      { from: nid, to, ...inherit },   // 第二段：新节点 → 原来的下游（别写成 nid 当键）
    ];
    onChange({
      ...graph,
      nodes: [...graph.nodes, { nid, agent_id: agentId }],
      edges: [...kept, ...legs],
    });
    setInsertAt(null);
  };

  /** 富文本（Markdown）插入工具 —— 参考开源 workflow 的输入框：
   *  B/I 包裹选区，列表/引用/代码给整行加前缀。不引第三方编辑器，自己包一层就够用。 */
  const wrapSel = (pre: string, post = pre) => {
    const el = taskBoxRef.current;
    if (!el) return;
    const a = el.selectionStart ?? 0;
    const b = el.selectionEnd ?? 0;
    const sel = taskValue.slice(a, b) || "文字";
    const next = taskValue.slice(0, a) + pre + sel + post + taskValue.slice(b);
    onTaskValue?.(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + pre.length, a + pre.length + sel.length);
    });
  };
  const prefixLine = (mark: string) => {
    const el = taskBoxRef.current;
    if (!el) return;
    const a = el.selectionStart ?? 0;
    const lineStart = taskValue.lastIndexOf("\n", Math.max(0, a - 1)) + 1;
    const next = taskValue.slice(0, lineStart) + mark + taskValue.slice(lineStart);
    onTaskValue?.(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = a + mark.length;
      el.setSelectionRange(pos, pos);
    });
  };

  /** 任务卡的输入框（方案 C：不再有页面底部的发令区）。
   *  它是**默认就在**的输入框 —— 不再"点一下才展开"，所以自动长高要在
   *  内容变化时一直生效，而不是只在某个"编辑态"里。 */
  const taskBoxRef = useRef<HTMLTextAreaElement>(null);
  const growTask = () => {
    const el = taskBoxRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };
  useEffect(() => {
    growTask();
  }, [taskValue]);

  /** 点开某个节点时把它滚进视野。
   *  现在没有右侧抽屉了（内容默认显示在卡上），但如果节点多了、画布横向溢出，
   *  选中的节点仍可能落在视口外 —— 点了没反应最劝退，所以这条留着。
   *  没有溢出时它是空操作（need 不会大于 scrollLeft）。 */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !detailNid || narrow) return;
    const at = layout.pos[detailNid];
    if (!at) return;
    // 按**最右边的内容**算（结论卡常常比节点更靠右）—— 差一点就会少露 60px
    const rightEdge = Math.max(at.x + NODE_W, layout.concAt.x + layout.CONC_W) + 4;
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
    const need = layout.concAt.x + layout.CONC_W + 6 - stage.clientWidth;
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
        // 点阵对齐 Dify（nodes/loop/node.tsx: <Background gap={[14,14]} size={2} />）：
        // 点是 2px、间距 14px；我们原来是 1.2px / 20px，显得又稀又小。
        backgroundImage: "radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--color-border) 85%, transparent) 2px, transparent 0)",
        backgroundSize: "14px 14px",
      }}
    >
              {/* 居中：内容比视口小时整体居中（不然挤在左上角像没做完）；比视口大时照旧滚动 */}
        <div className="flex min-h-full min-w-full p-1">
        {/* 用 auto margin 居中，而不是 justify-center ——
            内容比画布宽时（任务卡+节点+结论约 1000px > 864px），justify-center 会**两头都裁**，
            实测把任务卡和结论卡同时切掉了。auto margin 有空间时居中、超出时从左边开始，不裁。 */}
        <div className="relative m-auto shrink-0" style={{ width: layout.w, height: layout.h }}>
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
                <div className="mb-2 text-[12px]" style={{ color: "var(--color-muted)" }}>
                  {nameOf(e.from)} → {nameOf(e.to)}：这两个怎么配合？
                </div>

                {/* ① 顺序：二选一 */}
                <div className="mb-1 text-[12px] font-medium" style={{ color: "var(--color-muted)" }}>
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
                <div className="mb-1 text-[12px] font-medium" style={{ color: "var(--color-muted)" }}>
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
                          className="grid h-[15px] w-[15px] shrink-0 place-items-center rounded-[4px] border text-[12px]"
                          style={{
                            borderColor: on ? "var(--color-info)" : "var(--color-border)",
                            color: on ? "var(--color-info)" : "transparent",
                          }}
                        >
                          ✓
                        </span>
                        <span className="font-semibold">{o.label}</span>
                        <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
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
          ref={taskCardRef}
          className="task-card df-card absolute border px-3 py-2"
          style={{
            transform: `translate(${layout.taskAt.x}px, ${layout.taskAt.y}px)`,
            width: layout.CARD_W,
            background: "var(--color-surface)",
            borderColor: "var(--color-border)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold" style={{ color: "var(--color-muted)" }}>
              任务
            </span>
          </div>

          {/* 输入框**默认就在卡上** —— 不"点一下才展开"、不弹窗、不跳页。
              之前是「点击 → 就地放大成 480 的编辑态」，用户明确要求改掉：
              默认显示即输入，进来就能打字（少一次点击，也少一层状态）。 */}
          <textarea
            ref={taskBoxRef}
            value={taskValue}
            rows={2}
            onChange={(e) => onTaskValue?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.currentTarget.blur();
                return;
              }
              // ⌘/Ctrl+B、⌘/Ctrl+I 与工具栏等效
              if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "i")) {
                e.preventDefault();
                wrapSel(e.key === "b" ? "**" : "*");
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onRun?.();
              }
            }}
            placeholder="写一句任务 —— 比如：调研三家云厂商的 GPU 报价并汇总成表"
            className="df-input mt-1 w-full resize-none border outline-none"
            style={{
              borderColor: "var(--color-border)",
              background: "var(--color-surface-2)",
              minHeight: 72,
              maxHeight: 220,
            }}
          />

          {/* 工具栏常驻（写的是 Markdown，回车运行前随手加格式） */}
          <div className="mt-1 flex flex-wrap items-center gap-0.5">
            {(
              [
                ["B", "加粗", () => wrapSel("**")],
                ["I", "斜体", () => wrapSel("*")],
                ["≔", "列表", () => prefixLine("- ")],
                ["❝", "引用", () => prefixLine("> ")],
                ["{}", "代码", () => wrapSel("`")],
              ] as const
            ).map(([label, tip, act]) => (
              <button
                key={label}
                type="button"
                title={tip}
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={(ev) => {
                  ev.stopPropagation();
                  act();
                }}
                className="df-ctl-sm justify-center hover:bg-[var(--color-surface-2)]"
                style={{ color: "var(--color-muted)" }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* 运行键**独占一行、撑满宽度**。
              原因（实测踩到）：原来它和上面 5 个工具栏键挤在同一行（ml-auto 顶右），
              那行内容 ~240px，而卡片内宽只有 ~174px（200 卡宽 - px-3×2 - 边框）——
              溢出 66px，运行键撑出卡片右边缘压到右边的节点卡上，就是用户看到的
              "组件叠加一起了"。主操作单独一行既修了溢出，也更像个启动键。 */}
          <button
            type="button"
            disabled={running}
            onClick={(e) => {
              e.stopPropagation();
              onRun?.();
            }}
            className="df-ctl mt-1.5 w-full justify-center font-medium text-white disabled:opacity-45"
            style={{ background: "var(--color-accent)" }}
            title={`按 ${derived || "自动"} 方式执行（Enter）`}
          >
            {running ? "运行中…" : `▸ 运行 · ${derived || "自动"}`}
          </button>
          <div className="mt-1 text-[12px]" style={{ color: "var(--color-muted)" }}>
            Enter 运行 · Shift+Enter 换行
          </div>
        </div>

        {finalText.trim() && (
          <div
            className="absolute flex flex-col rounded-[10px] border"
            style={{
              transform: `translate(${layout.concAt.x}px, ${layout.concAt.y}px)`,
              width: layout.CONC_W,
              maxHeight: 460,
              background: "color-mix(in srgb, var(--color-accent) 5%, var(--color-surface))",
              borderColor: "color-mix(in srgb, var(--color-accent) 40%, var(--color-border))",
            }}
            title="这次执行合起来的结论"
          >
            <div className="flex items-center gap-2 border-b px-2.5 py-1.5" style={{ borderColor: "color-mix(in srgb, var(--color-accent) 24%, var(--color-border))" }}>
              <span
                className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-[12px] text-white"
                style={{ background: "var(--color-accent)" }}
              >
                ✓
              </span>
              <span className="text-[12px] font-semibold" style={{ color: "var(--color-accent)" }}>
                结论
              </span>
              {lastNid && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDetail?.(lastNid);
                  }}
                  className="ml-auto text-[12px]"
                  style={{ color: "var(--color-accent)" }}
                  title="看最后一步的完整过程"
                >
                  看最后一步 →
                </button>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void navigator.clipboard?.writeText(finalText);
                }}
                className={`${lastNid ? "" : "ml-auto "}text-[12px]`}
                style={{ color: "var(--color-muted)" }}
                title="复制结论全文"
              >
                复制
              </button>
            </div>
            {/* 用 Markdown 渲染 —— 模型产出天然是 Markdown，之前是当纯文本贴出来的
                （`## 🔥` `**加粗**` `---` 全部原样显示） */}
            <div className="min-h-0 flex-1 overflow-auto px-2.5 py-2">
              <Markdown text={finalText} />
            </div>
          </div>
        )}

        {/* 插一步的选择器：点了连线上那个 ＋ 才出现 —— 列出助手，选中就插到这两步中间 */}
        {insertAt && edgeMids[insertAt] && (
          <div
            className="absolute z-40 w-[196px] rounded-[10px] border p-1"
            style={{
              left: Math.min(edgeMids[insertAt].x - 98, layout.w - 210),
              top: edgeMids[insertAt].y + 44,
              background: "var(--color-surface)",
              borderColor: "var(--color-border)",
              boxShadow: "0 10px 28px rgba(20,24,31,.16)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-2 py-1 text-[12px]" style={{ color: "var(--color-muted)" }}>
              插到这两步中间
            </div>
            <div className="max-h-[220px] overflow-auto">
              {agents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    const [from, to] = insertAt.split("->");
                    insertBetween(from, to, a.id);
                  }}
                  className="flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--color-surface-2)]"
                >
                  <span
                    className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] border text-[12px]"
                    style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}
                  >
                    {a.name.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setInsertAt(null)}
              className="mt-0.5 w-full rounded-[6px] px-2 py-1 text-left text-[12px]"
              style={{ color: "var(--color-muted)" }}
            >
              取消
            </button>
          </div>
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
                // 点节点 = 选中它（点亮上下游链路 + 让它的产出/过程显示在卡上）。
                // 信息默认就在卡上，不再开右侧抽屉 —— 用户明确要求过。
                onDetail?.(detailNid === n.nid ? null : n.nid);
              }}
              onMouseEnter={() => peekIn(n.nid)}
              onMouseLeave={() => peekOut()}
              className={`wf-node group absolute rounded-[15px] border shadow-xs hover:shadow-lg ${
                lv && st === "run" ? "node-run" : st === "ask" ? "node-ask" : ""
              }`}
              style={{
                transform: `translate(${p.x}px, ${p.y}px)`,
                width: NODE_W,
                background: "var(--color-surface)",
                borderColor: isTarget ? "var(--color-accent)" : isSel ? "var(--color-accent)" : meta.border,
                borderStyle: isTarget ? "dashed" : st === "stale" ? "dashed" : "solid",
                // 选中某节点时，它的上游/下游给一层淡底 —— 一眼看清这条链怎么串
                //（不动边框：边框已被"状态/拖放目标/失效"占用）
                ...(chain && (chain.up.has(n.nid) || chain.down.has(n.nid))
                  ? {
                      background: `color-mix(in srgb, var(--color-accent) ${chain.down.has(n.nid) ? "8%" : "5%"}, var(--color-surface))`,
                    }
                  : {}),
                // 常态阴影交给 Tailwind 的 shadow-xs / hover:shadow-lg（与 Dify 一致）；
                // 只有"选中"时才用内联覆盖（加一圈强调色描边环）
                boxShadow: isSel
                  ? "0 0 0 3px color-mix(in srgb, var(--color-accent) 14%, transparent), 0 6px 18px rgba(20,24,31,.10)"
                  : undefined,
                cursor: frozen ? "default" : "grab",
              }}
            >
              <div
                className="flex items-center gap-2 border-b px-3 pt-3 pb-2"
                style={{ borderColor: "var(--color-border)" }}
              >
                {/* 节点上只留三样：**序号、名字、一行摘要**。
                    原来这里有 10 个元素：[主控] 徽标、[第N步] 徽标、⚙、✕、模型名…
                    · [第N步] → 就是序号（不需要两个都在）
                    · [主控] → 名字前一个星标
                    · ⚙ / ✕ → 悬停或选中才出现（平时不占位）
                    · 模型名 → 进右侧抽屉（助手栏已经写着了） */}
                {/* 图标方块：参考 Dify 的 block —— 用**状态色**染底（跑=蓝、成=绿、败=红），
                    一眼从颜色就知道这一步处在什么状态，比小圆点醒目得多 */}
                <span
                  className="grid h-[28px] w-[28px] shrink-0 place-items-center rounded-[8px] text-[12.5px] font-semibold"
                  style={{
                    background: `color-mix(in srgb, ${meta.dot} 14%, var(--color-surface))`,
                    color: meta.text,
                    border: `1px solid color-mix(in srgb, ${meta.dot} 32%, transparent)`,
                  }}
                  title={`第 ${stepNo} 步`}
                >
                  {stepNo}
                </span>
                {master === n.nid && (
                  <span
                    className="shrink-0 text-[12px] leading-none"
                    style={{ color: "var(--color-accent)" }}
                    title="主控（按连线自动判断）"
                  >
                    ★
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-[12px] font-semibold uppercase leading-[1.35] tracking-wide">
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
                  {/* 节点操作收进一个 ⋯ 菜单 —— 原来 ⚙ 和 ✕ 并排常驻：
                      ① 两个小按钮挤在卡头，且 ✕ 太容易误点；
                      ② 手机上没有悬停，常驻按钮反而占位。
                      ⋯ 是个通用约定（触屏也能点），点开才列出动作。 */}
                  <button
                    type="button"
                    title="这一步的操作"
                    aria-label="这一步的操作"
                    onClick={(e) => {
                      e.stopPropagation();
                      setNodeMenu(nodeMenu === n.nid ? null : n.nid);
                    }}
                    className="pg-more df-ctl-icon shrink-0 border hover:opacity-100"
                    style={{ color: "var(--color-muted)" }}
                  >
                    ⋯
                  </button>
                </div>
              </div>

              {/* 实时尾巴：正在跑的时候给 2~3 行（最近一次工具调用 + 当前思考/输出），
                  跑完就折叠回那行摘要 —— 用户反馈"执行中看不到具体过程"就是这里。 */}
              {st === "run" && lv && (
                <>
                  {/* 正在执行：给一条**抢眼**的横幅（之前只有一行灰字，用户说"没看到"） */}
                  <div
                    className="mt-1 flex items-center gap-1.5 rounded-[6px] px-2 py-1"
                    style={{
                      background: "color-mix(in srgb, var(--color-accent) 10%, transparent)",
                      borderTop: "1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)",
                      borderBottom: "1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)",
                    }}
                  >
                    <span className="live-dot shrink-0 text-[12px]" style={{ color: "var(--color-accent)" }}>
                      ●
                    </span>
                    <span className="text-[12px] font-semibold" style={{ color: "var(--color-accent)" }}>
                      正在执行
                    </span>
                    <span className="ml-auto text-[12px] font-medium" style={{ color: "var(--color-accent)" }}>
                      {lv.elapsedMs == null
                        ? ""
                        : lv.elapsedMs < 1000
                          ? `${Math.round(lv.elapsedMs)}ms`
                          : `${(lv.elapsedMs / 1000).toFixed(1)}s`}
                    </span>
                  </div>
                  {/* 尾巴：不同动作不同颜色（思考紫 / 工具橙 / 工具输出青 / 输出绿）——
                      配色直接复用全站那套 STEP_STYLE，保证"同一动作到处一个颜色" */}
                  <div className="flex flex-col gap-[3px] px-2.5 pb-2 pt-1.5">
                    {tailOf(lv.events).map((l, i) => {
                      const sty = STEP_STYLE[l.kind];
                      return (
                        <div
                          key={i}
                          className="flex items-start gap-1.5 rounded-[5px] px-1.5 py-[3px] text-[12px] leading-[1.45]"
                          style={{ background: sty.bg, border: `1px solid ${sty.border}` }}
                        >
                          <span className="shrink-0" style={{ color: sty.color }}>
                            {sty.icon}
                          </span>
                          <span className="min-w-0 break-words font-medium" style={{ color: sty.color }}>
                            {l.text}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {/* 连接点：按 Dify 做成**隐形**热区（它源码里是 size-4 的
                  rounded-none/border-none/bg-transparent 元素），不再画可见圆点 —— 
                  可见圆点是上一轮我自己加的，跟 Dify 不一致，这里改回。
                  点击范围仍在（左右各一块 16px 热区，见下方 · 悬停显示提示） */}

              {/* ⋯ 菜单：配置 / 复制 / 删除 —— 点开才出现，触屏可用 */}
              {nodeMenu === n.nid && (
                <div
                  className="df-menu absolute right-1 top-[34px] z-40 w-[152px] overflow-hidden border"
                  style={{
                    background: "var(--color-surface)",
                    borderColor: "var(--color-border)",
                    boxShadow: "0 10px 28px rgba(20,24,31,.16)",
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setNodeMenu(null);
                      onSelect(n.nid);
                    }}
                    className="df-menu-item hover:bg-[var(--color-surface-2)]"
                  >
                    配置这个助手
                  </button>
                  {!frozen && (
                    <button
                      type="button"
                      onClick={() => {
                        // 复制这一步：在它后面接一个同名助手（不用再拖一次）
                        setNodeMenu(null);
                        const used = new Set(graph.nodes.map((x) => x.nid));
                        let k = graph.nodes.length + 1;
                        while (used.has(`n${k}`)) k++;
                        const nid = `n${k}`;
                        onChange({
                          ...graph,
                          nodes: [...graph.nodes, { nid, agent_id: n.agent_id }],
                          edges: [...graph.edges, { from: n.nid, to: nid }],
                        });
                      }}
                      className="df-menu-item hover:bg-[var(--color-surface-2)]"
                    >
                      在它后面复制一步
                    </button>
                  )}
                  {!frozen && (
                    <button
                      type="button"
                      onClick={() => {
                        setNodeMenu(null);
                        onChange({
                          ...graph,
                          nodes: graph.nodes.filter((x) => x.nid !== n.nid),
                          edges: graph.edges.filter((x) => x.from !== n.nid && x.to !== n.nid),
                        });
                      }}
                      className="df-menu-item hover:bg-[var(--color-surface-2)]"
                      style={{ color: "var(--color-err)" }}
                    >
                      删除这一步
                    </button>
                  )}
                </div>
              )}

              {/* ── 卡体：参考 Dify 的 block body ──────────────────────────
                  运行中 → 分色动作行（思考紫/工具橙/工具输出青/输出绿）
                  跑完   → 产出（markdown 渲染，最多 4 行；点节点看全部）
                  没跑过 → 这个助手是干什么的一句话（不再是空卡） */}
              {st === "ok" && lv?.output?.trim() && (
                <div className="node-body max-h-[104px] overflow-hidden px-3 pb-2">
                  <Markdown text={lv.output} />
                </div>
              )}
              {!lv && !out && (
                /* 没跑过：显示"模型 · 这助手干什么" —— 不是一句灰字，而是让人一眼
                   知道这张卡的用途（Dify 的 block 也有这么一行副标题） */
                <div className="px-3 pb-2">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    {a?.definition?.model?.name && (
                      <span
                        className="rounded-[5px] px-1.5 py-px text-[12px] font-medium"
                        style={{ background: "var(--color-surface-2)", color: "var(--color-muted)" }}
                      >
                        {a.definition.model.name}
                      </span>
                    )}
                    <span className="text-[12px] leading-[1.55]" style={{ color: "var(--color-muted)" }}>
                      {a?.definition?.system_prompt
                        ? `${a.definition.system_prompt.replace(/\s+/g, " ").slice(0, 52)}…`
                        : "还没跑过"}
                    </span>
                  </div>
                </div>
              )}

              {/* 实时摘要：一眼看出"它在干什么" —— 不用点、不用往下看 */}
              {lv && (st === "run" || st === "ok" || st === "err" || st === "ask") && (
                <div
                  className="mx-3 mb-2.5 mt-1 flex items-center gap-2 rounded-[7px] px-2 py-1 text-[12px]"
                  style={{
                    color: meta.text,
                    background: `color-mix(in srgb, ${meta.dot} 10%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${meta.dot} 26%, transparent)`,
                  }}
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
                    className="my-1.5 break-all rounded-[6px] border px-2 py-1 font-mono text-[12px]"
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
                  <div className="mt-1.5 text-[12px]" style={{ color: "var(--color-muted)" }}>
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
              <span className="ml-auto shrink-0 text-[12px]" style={{ color: peekMeta.text }}>
                {STATE_LABEL[peekState]}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-auto px-2.5 py-2">
              <div className="mb-1 text-[12px] font-semibold" style={{ color: "var(--color-muted)" }}>
                思考
              </div>
              <div className="mb-2 whitespace-pre-wrap break-words text-[12px] leading-[1.6]">
                {peekLive.thinking ? (
                  peekLive.thinking.length > 700 ? peekLive.thinking.slice(-700) : peekLive.thinking
                ) : (
                  <span style={{ color: "var(--color-muted)" }}>
                    {peekState === "run" ? "还在想…" : "这一步没有思考内容"}
                  </span>
                )}
              </div>

              <div className="mb-1 text-[12px] font-semibold" style={{ color: "var(--color-muted)" }}>
                工具（{peekLive.tools.length}）
              </div>
              <div className="mb-2 flex flex-col gap-1">
                {peekLive.tools.length === 0 ? (
                  <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                    还没调用工具
                  </span>
                ) : (
                  peekLive.tools.slice(-3).map((t, i) => (
                    <div key={i} className="flex items-baseline gap-1.5 text-[12px]">
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

              <div className="mb-1 text-[12px] font-semibold" style={{ color: "var(--color-muted)" }}>
                输出
              </div>
              <div className="whitespace-pre-wrap break-words text-[12px] leading-[1.6]">
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
              className="flex items-center gap-2 border-t px-2.5 py-1.5 text-[12px]"
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
      </div>
    </div>
  );
}

/** 节点上的「实时尾巴」：从最近的事件里挑 2~3 行，说清"它此刻正在干什么"。
 *
 *  为什么需要它：老版节点把整段产出贴在卡上（太吵，被砍掉了）；砍完只剩一行摘要
 *  （`⟳ 2.3s 思考中…`）—— 于是执行中**看不见过程**（用户原话）。
 *  这里取中间：**跑的时候给尾巴（最近一次工具调用 + 当前思考/输出），跑完只留一行摘要**。
 *  事件是流式的 delta（每次几个字），所以按"末尾连续同类型"回卷累积，才拼得出完整一句。 */
function tailOf(evts: NodeLiveInfo["events"], max = 3): { kind: StepKind; text: string }[] {
  type Ev = { type?: string; payload?: Record<string, unknown> };
  const list = evts as unknown as Ev[];
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  /** 单行化 + 截断（保留**尾部**：正在发生的东西在末尾） */
  const one = (t: string, n = 52) => {
    const x = t.replace(/\s+/g, " ").trim();
    return x.length > n ? `…${x.slice(-n)}` : x;
  };

  const lines: { kind: StepKind; text: string }[] = [];

  // ① 最近一次工具调用（入参 + 返回）—— 分两类颜色：发出是"工具"，回来是"工具输出"
  let lastToolAt = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].type === "tool_call_start" || list[i].type === "tool_exec_start") {
      lastToolAt = i;
      break;
    }
  }
  if (lastToolAt >= 0) {
    const name = str(list[lastToolAt].payload?.tool_call_name);
    let args = "";
    let result = "";
    for (let i = lastToolAt; i < list.length; i++) {
      if (list[i].type === "tool_call_args") args += str(list[i].payload?.delta);
      else if (list[i].type === "tool_result_delta") result += str(list[i].payload?.delta);
    }
    if (name) lines.push({ kind: "tool", text: `${name} ${one(args, 32)}` });
    if (result.trim()) {
      const firstLine = result.split("\n").find((x) => x.trim()) ?? result;
      lines.push({ kind: "tool_response", text: one(firstLine) });
    }
  }

  // ② 当前正在说的：输出优先，没有就显示思考（两类颜色不同）
  const runOf = (type: string) => {
    let acc = "";
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].type === type) acc = str(list[i].payload?.delta) + acc;
      else if (acc) break;
    }
    return acc;
  };
  const out = runOf("text_delta");
  const think = runOf("thinking_delta");
  if (out.trim()) lines.push({ kind: "output", text: one(out) });
  else if (think.trim()) lines.push({ kind: "think", text: one(think) });

  return lines.slice(-max);
}

/** 抽屉里的小节标题 */
function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div
        className="mb-1 text-[12px] font-semibold"
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
