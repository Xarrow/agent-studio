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
import type { Agent, UploadItem, WorkflowEdge, WorkflowGraph, WorkflowNode } from "@/lib/types";

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

/* ── 选助手的三个小工具（都是纯函数，零依赖）─────────────────────────────
   为什么要有"一句话职责"：选助手时用户真正要判断的是"它擅长什么"，
   而 description 现在普遍是空的 —— 但 system_prompt 其实写着各自干嘛。
   所以：description 优先，空了就取 system_prompt 的第一句（并去掉"你是一个…"这种套话）。 */
function blurbOf(a: Agent): string {
  const d = (a.description ?? "").trim();
  if (d) return d;
  const raw = (a.definition?.system_prompt ?? "").trim().replace(/\s+/g, " ");
  if (!raw) return "";
  // 去掉开头的套话（"你是一个 xxx agent，" / "你是助手。"），留下实质那句
  const stripped = raw.replace(/^(你是一个|你是一位|你是)[^，,。.;；]{0,24}[，,。.;；]\s*/, "");
  const first = (stripped || raw).split(/[。\n!?；;]/)[0] || stripped || raw;
  const t = first.trim().replace(/^[，,、]\s*/, "");
  return t.length > 52 ? t.slice(0, 52) + "…" : t;
}

/** 能力信号：给**名字**，不给"8 个"——名字才能让人判断，数字只让人感觉多 */
function skillsOf(a: Agent, toolNames: Record<string, string>): string[] {
  const out: string[] = [];
  for (const t of a.definition?.tools ?? []) {
    if (t.enabled === false) continue;
    const n = toolNames[t.ref];
    if (n) out.push(n);
  }
  return out.slice(0, 4);
}

/** 推荐打分：任务文本 vs 助手的名字/职责/提示词/工具名。
 *  中文没有空格，用**二元组**做近似（零依赖下够用）；英文按下划线词整词匹配（权重更高）。 */
function recScore(a: Agent, task: string, toolNames: Record<string, string>): number {
  const t = (task || "").trim();
  if (t.length < 2) return 0;
  const hay = (
    a.name +
    " " +
    (a.description ?? "") +
    " " +
    (a.definition?.system_prompt ?? "") +
    " " +
    (a.definition?.tools ?? []).map((x) => toolNames[x.ref] ?? "").join(" ")
  ).toLowerCase();
  let score = 0;
  for (const w of t.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? []) if (hay.includes(w)) score += 3;
  for (let i = 0; i < t.length - 1; i++) {
    const bg = t.slice(i, i + 2);
    if (/^[\u4e00-\u9fa5]{2}$/.test(bg) && hay.includes(bg)) score += 1;
  }
  return score;
}

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
  /** 任务卡上的附件（图片/文件）—— 上传在 PlaygroundConsole 里做，这里只管展示与交互 */
  attachments?: UploadItem[];
  onAttach?: (files: File[]) => void;
  onDetach?: (id: string) => void;
  /** 工具 id → 名字（能力信号要显示名字，后端存的是 id 引用） */
  toolNames?: Record<string, string>;
  /** 选好助手：mode="add" 加到流程末尾；mode="swap" 换掉某个节点 */
  onAddStep?: (agentId: string) => void;
  onSwapAgent?: (nid: string, agentId: string) => void;
  onRun?: () => void;
  running?: boolean;
  /** 当前会跑什么模式（显示在运行键上） */
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

/** 流水线列宽上限。之前是 232（横向拼装时代的节点宽），
 *  现在改成 660 —— 一列到底，产出全文放得下（"看到内容更多"）。
 *  实际宽度取 min(660, 容器宽-20)，由 stage 的 ResizeObserver 实测（见 colW）。 */
const NODE_W_MAX = 660;
/** 实测列宽的兜底值（首帧还没量到时用），与 NODE_W_MAX 一致即可 */
const NODE_W = 660;

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

/** 运行中状态行的**人话**短语：不再直接贴原始事件文本（长句在窄卡里会被截得看不懂）。
 *  按阶段给动词，尽量把工具名带出来 —— 一眼知道"现在到底在干嘛"。 */
function liveLabel(kind: string, text: string): string {
  const tool = (text.match(/[a-z][a-z0-9]*_[a-z0-9_]+/i) ?? [])[0];
  switch (kind) {
    case "input":
      return "收到任务…";
    case "think":
      return "正在思考…";
    case "tool":
      return tool ? `正在调用 ${tool}` : "正在调用工具…";
    case "tool_out":
      return tool ? `${tool} 已返回，正在整理…` : "已拿到结果，正在整理…";
    case "answer":
    case "out":
      return "正在回答…";
    default:
      return text.length > 26 ? `${text.slice(0, 26)}…` : text;
  }
}

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
  attachments = [],
  onAttach,
  onDetach,
  onAddStep,
  onSwapAgent,
  toolNames = {},
  onTaskValue,
  onRun,
  running = false,
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
  /** 缩放：对齐 Dify 的 postionControls —— 25%~200%，加"适应画布"。
   *  实现用 CSS transform（零依赖）：内容层整体 scale，外面再包一层按缩放后尺寸占位的容器，
   *  这样滚动条范围也跟着缩放走。 */
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 2;
  /** 用**函数式更新**：连续点 ＋/－ 时每次读到的都是最新值。
   *  （原来写 setZoom(计算好的值)，快速点击会都读同一个旧 zoom，三下只生效一下 —— 实测。
   *   顺带支持传增量函数，调用处直接 zoomStep(+/-0.1)。） */
  const zoomTo = (z: number | ((prev: number) => number)) =>
    setZoom((prev) => {
      const next = typeof z === "function" ? z(prev) : z;
      return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100));
    });
  const zoomStep = (d: number) => zoomTo((prev) => prev + d);
  /** 适应画布：让整张图（含留白）刚好放进视口 */
  const fitView = () => {
    const stage = stageRef.current;
    if (!stage || !layout.w || !layout.h) return;
    const z = Math.min((stage.clientWidth - 24) / layout.w, (stage.clientHeight - 24) / layout.h, 1);
    zoomTo(z);
    requestAnimationFrame(() => {
      stage.scrollLeft = (layout.w * z - stage.clientWidth) / 2;
      stage.scrollTop = (layout.h * z - stage.clientHeight) / 2;
    });
  };
  /** 任务卡的实测高度 —— 窄屏排布要按它让位。
   *  为什么不能写死：任务卡现在是"输入框常驻"，高度随内容变（原来 96 够，现在不够，
   *  写死会让节点压在任务卡上）。用 ResizeObserver 跟着量。 */
  const taskCardRef = useRef<HTMLDivElement>(null);
  const [taskH, setTaskH] = useState(0);
  /** 选中的连线（点一下那条线 → 就地选它们之间的关系） */
  const [edgeSel, setEdgeSel] = useState<{ from: string; to: string } | null>(null);

  /* ⚠️ hoverEdge / insertAt 必须声明在 edgesSvg（graph.edges.map）**之前**：
     那个 map 在渲染时就地执行，会读这两个 state。声明在后面 = 读到未初始化的 const
     → **多节点（有连线）页面直接崩**（ReferenceError: Cannot access 'X' before initialization）。
     单节点时 map 空转所以不崩 —— 这就是"选多个 agent 编排就报错"的根因。 */
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [insertAt, setInsertAt] = useState<string | null>(null);

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
      // 用 offsetHeight 而不是 getBoundingClientRect：画布有缩放时后者会返回缩放后的值，
    // 布局就会按错误的尺寸排（offsetHeight 不受 transform 影响）。
    const h = Math.round(el.offsetHeight);
      setTaskH((prev) => (Math.abs(prev - h) > 1 ? h : prev));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ── 实测列宽（手机纵向时三块共用的宽度）───────────────────────────────
     纵向流水线是"一列到底"，列宽跟着容器走（桌面最多 660，手机就是屏宽-20）。
     宽度必须实测、不能写死：写死 660 在 390 手机上就是横向滚动条。 */
  const [colW, setColW] = useState(NODE_W_MAX);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const apply = () => setColW(Math.max(260, Math.min(NODE_W_MAX, el.clientWidth - 20)));
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ── 布局：**横向为主**（Dify 式），手机上自动降级为纵向流水线 ──────────────
     横向 = 列（第几步）× 行（同层第几个），位置全由拓扑算出来，用户不用摆坐标。
     关键改变：画布**允许横向滚动**，所以不再有"把三张卡塞进 864px"的凑数逻辑 ——
     那正是过去三个溢出/重叠 bug 的根（每加一个元素就要重算宽度、算错就压上）。
     手机（≤900px）自动换成纵向流水线：同一份图，两套排版，窄屏不横向溢出。 */
  const layout = useMemo(() => {
    const layers = topoLayers(graph.nodes, graph.edges);
    const PAD = 10;
    /** 横向卡宽：节点对齐 Dify 的 NODE_WIDTH 240；任务是"要写"的、结论是"要读"的 */
    const W_TASK = 320;   // 方案 C：发令区加宽到与结论卡同级（节点卡 240）
    const W_NODE = 240;
    const W_CONC = 320;
    const GAP_X = 56;   // 层间距（Dify X_OFFSET 60 的量级）
    const GAP_Y = 39;   // 同层节点间距（Dify Y_OFFSET 39）
    /** 纵向（手机）三块统一用实测列宽 */
    const CW = colW;
    const hOf = (nid: string) => heights[nid] || 104;
    const pos: Record<string, { x: number; y: number }> = {};
    let maxX = 0;
    let maxY = 0;
    /** 用户拖过的节点用它自己的坐标（存在图里）；没拖过的按拓扑排。
        手机（纵向）不看坐标 —— 窄屏是一列到底，硬塞自由坐标只会互相压。 */
    const manualOf = (nid: string) => {
      const n = graph.nodes.find((x) => x.nid === nid);
      return !narrow && n && typeof n.x === "number" && typeof n.y === "number"
        ? { x: n.x, y: n.y }
        : null;
    };
    if (narrow) {
      // ── 纵向流水线（手机）：任务 → 各步 → 结论，一列到底
      // 兜底 240：实测任务卡高 211，宁可多留白，也不要节点压在卡上
      let y = PAD + (taskH || 240) + 14;
      layers.forEach((ids) => {
        ids.forEach((nid) => {
          pos[nid] = { x: PAD, y };
          y += hOf(nid) + 30;
        });
        maxY = Math.max(maxY, y);
      });
    } else {
      // ── 横向（桌面）：列 = 第几步，行 = 同层第几个
      layers.forEach((ids, ci) => {
        let y = PAD;
        ids.forEach((nid) => {
          // 拖过就用它自己的位置；没拖过按列排（第几层 × 层宽）
          pos[nid] = manualOf(nid) ?? { x: PAD + W_TASK + GAP_X + ci * (W_NODE + GAP_X), y };
          y += hOf(nid) + GAP_Y;
          // maxX 要把"被拖到很右边的节点"也算进去，否则结论卡会叠上去
          maxX = Math.max(maxX, pos[nid].x + W_NODE + PAD);
        });
        maxY = Math.max(maxY, y);
      });
    }
    // 两端的卡：宽屏与首/末层同一行；窄屏放最上/最下
    const firstIds = layers[0] ?? [];
    const lastIds = layers[layers.length - 1] ?? [];
    const firstY = firstIds.length ? (pos[firstIds[0]]?.y ?? PAD) : PAD;
    const lastY = lastIds.length ? (pos[lastIds[0]]?.y ?? PAD) : PAD;
    /** 「＋ 加一步」的位置 —— 它属于**流程本身**（接在最后一步后面），
     *  所以画在画布上、紧挨着最后一步，而不是塞进顶栏或侧栏。
     *  横向：末列右侧、结论卡之前；纵向：最后一个节点下方、结论之前。 */
    const ADD_W = 132;
    const addAt = narrow
      ? { x: PAD, y: maxY + 2 }
      : { x: maxX + GAP_X, y: lastY + 8 };
    const taskAt = narrow ? { x: PAD, y: PAD } : { x: PAD, y: firstY };
    const concAt = narrow
      ? { x: PAD, y: addAt.y + 46 }
      : { x: addAt.x + ADD_W + GAP_X, y: lastY };
    /** 三块的实际宽度（窄屏=列宽；宽屏=各自的固定宽）—— 渲染只读这三个值 */
    const CARD_W = narrow ? CW : W_TASK;
    const NW = narrow ? CW : W_NODE;
    const CONC_W = narrow ? CW : W_CONC;
    let w = Math.max(maxX, 320);
    let h = Math.max(maxY, 260);
    if (narrow) {
      // 纵向：宽度只需容下**最宽的一张**（不能用 maxX，否则手机横向滚动）
      w = CW + PAD * 2;
      h = Math.max(h, concAt.y + 150);
    } else {
      // 横向：宽度 = 结论卡右边缘（超出容器就横向滚动 —— 这是 Dify 的画布行为）
      w = Math.max(w, concAt.x + CONC_W + PAD);
      h = Math.max(h, concAt.y + 200);
    }
    // 流水线"筋"（块与块之间的竖线）：只有纵向模式需要；横向模式由图的连线负责
    const links: { x: number; y1: number; y2: number }[] = [];
    if (narrow) {
      const seq = [
        { y: PAD, h: taskH || 240 },
        ...layers.flat().map((nid) => ({ y: pos[nid]?.y ?? PAD, h: hOf(nid) })),
        { y: concAt.y, h: 0 },
      ].sort((a, b) => a.y - b.y);
      for (let i = 0; i < seq.length - 1; i++) {
        const y1 = seq[i].y + seq[i].h;
        const y2 = seq[i + 1].y;
        if (y2 - y1 > 6) links.push({ x: PAD + CW / 2, y1: y1 + 3, y2: y2 - 3 });
      }
    }
    return { pos, w, h, layers, taskAt, concat: concAt, concAt, addAt, ADD_W, CARD_W, NW, CONC_W, CW, links };
  }, [graph.nodes, graph.edges, heights, colW, narrow, taskText, finalText, taskH]);

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
      const x1 = p.x + layout.NW;
      const y1 = p.y + (heights[from] || 104) / 2;
      // 画布可能被缩放：屏幕上量的位移要除以 zoom 才是图内坐标
      const z = zoomRef.current || 1;
      const mx = (ev.clientX - rect.left) / z + (stageRef.current?.scrollLeft ?? 0) / z;
      const my = (ev.clientY - rect.top) / z + (stageRef.current?.scrollTop ?? 0) / z;
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
      // 纵向（手机）：从 A 底部中间 → B 顶部中间，贝塞尔往下走
      const x1 = a.x + layout.CW / 2;
      const y1 = a.y + (heights[e.from] || 104);
      const x2 = b.x + layout.CW / 2;
      const y2 = b.y;
      tx = x2;
      ty = y2;
      const dy = Math.max(24, (y2 - y1) * 0.5);
      d = `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;
      edgeMids[key] = { x: x1, y: (y1 + y2) / 2 };
    } else {
      // 横向（桌面）：从 A 右侧中间 → B 左侧中间，贝塞尔往右走
      const x1 = a.x + layout.NW;
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
  /** 上移 / 下移一位 —— 手机上拖拽不可靠，顺序编辑改用菜单点选（操作更少、必成功）。
   *
   *  只对**链式**成立（该助手进出各 ≤1 条边）；分叉/汇合处不动，否则会把拓扑改坏。
   *  实现要点：**不重建边对象，只重新指向** —— 边上的设置（串行/并行、带上下文、
   *  带记忆）描述的是"这两步之间的关系"，换位置后依然成立，不能因为搬个顺序就丢掉。
   */
  const moveStep = (nid: string, dir: -1 | 1) => {
    const ins = graph.edges.filter((e) => e.to === nid);
    const outs = graph.edges.filter((e) => e.from === nid);
    const pred = ins[0]?.from ?? null;
    const succ = outs[0]?.to ?? null;
    const other = dir === -1 ? pred : succ;
    if (!other) return;
    const chainOk = (x: string) =>
      graph.edges.filter((e) => e.to === x).length <= 1 &&
      graph.edges.filter((e) => e.from === x).length <= 1;
    if (ins.length > 1 || outs.length > 1 || !chainOk(other)) return;

    if (dir === -1) {
      // 上移： gp → pred → nid → succ   ⇒   gp → nid → pred → succ
      const gp = graph.edges.find((e) => e.to === pred && e.from !== nid) ?? null;
      const mid = graph.edges.find((e) => e.from === pred && e.to === nid) ?? null;
      const tail = graph.edges.find((e) => e.from === nid && e.to === succ) ?? null;
      onChange({
        ...graph,
        edges: graph.edges.map((e) => {
          if (gp && e === gp) return { ...e, to: nid };
          if (mid && e === mid) return { ...e, from: nid, to: pred };
          if (tail && e === tail) return { ...e, from: pred, to: succ };
          return e;
        }),
      });
      return;
    }
    // 下移： pred → nid → succ → next   ⇒   pred → succ → nid → next
    const head = graph.edges.find((e) => e.from === pred && e.to === nid) ?? null;
    const mid = graph.edges.find((e) => e.from === nid && e.to === succ) ?? null;
    const next = graph.edges.find((e) => e.from === succ && e.to !== nid) ?? null;
    onChange({
      ...graph,
      edges: graph.edges.map((e) => {
        if (head && e === head) return { ...e, to: succ };
        if (mid && e === mid) return { ...e, from: succ, to: nid };
        if (next && e === next) return { ...e, from: nid };
        return e;
      }),
    });
  };

  /** 节点右上角 ⋯ 菜单当前开着的是哪一个 */
  const [nodeMenu, setNodeMenu] = useState<string | null>(null);
  /** 鼠标悬在哪条连线上（悬停时加粗，告诉用户"这条线是可点的"） */

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

  /** 任务卡的输入框（方案 C：不再有页面底部的发令区）。
   *  它是**默认就在**的输入框 —— 不再"点一下才展开"，所以自动长高要在
   *  内容变化时一直生效，而不是只在某个"编辑态"里。 */
  const taskBoxRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 选助手气泡：null=关；mode=add（加在末尾）| swap（换掉某一步）。
      气泡**贴着触发点**出现，不居中、不盖画布（用户明确要求"不遮画布"）。 */
  const [picking, setPicking] = useState<{ mode: "add" | "swap"; nid?: string } | null>(null);
  /** 跑完把结论**带到眼前** —— 而不是给一个"看最后一步 →"的跳转键。
      结论在流程最右端（横向布局下常常在视口外），跑完正是用户最想看它的时刻，
      所以自动滑过去。只在"运行中 → 结束"那一次触发，不打扰正在看别处的人。 */
  const wasRunning = useRef(false);
  useEffect(() => {
    if (!(wasRunning.current && !running)) {
      wasRunning.current = running;
      return;
    }
    wasRunning.current = running;
    // 跑完把结论**带到眼前**（而不是给一个"看最后一步 →"的跳转键）。
    // 为什么重申三次：结论卡是跑完才出现的，它落位会把内容撑宽 ——
    // 单次 smooth 滚动会被随后的重排打断（实测停在 227，结论仍在视口外；
    // 手动重申目标才能到 634）。所以按 0 / 450 / 1000ms 重申，最后收敛到右端。
    const go = () => {
      const el = stageRef.current;
      if (!el) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max > 0 && el.scrollLeft < max - 4) el.scrollTo({ left: max, behavior: "smooth" });
    };
    go();
    const t1 = setTimeout(go, 450);
    const t2 = setTimeout(go, 1000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [running]);

  /** 拖动节点：按下记起点与原始坐标 → 移动只改**临时**位置（不写图，拖动才连续）
      → 抬手**才**写进图（onChange）。位移 < 4px 视为"点"，交给 onClick 选中它。 */
  const [drag, setDrag] = useState<{
    nid: string;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    dx: number;
    dy: number;
    moved: boolean;
  } | null>(null);

  /** 「在这一步后面加」的目标 —— 点某个节点右侧的 ＋ 时记下来；
      不设时「＋ 加一步」= 接在流程末尾（原行为）。 */
  const [insertAfter, setInsertAfter] = useState<string | null>(null);

  /** 就地插入一步：新节点插在指定节点**之后**，原后继接到新节点后面
      （像在文本里插入一个字那样顺，而不是只能往末尾接）。 */
  const insertAfterStep = (nid: string, agentId: string) => {
    const newNid = `n${Math.random().toString(36).slice(2, 6)}`;
    const outs = graph.edges.filter((e) => e.from === nid);
    onChange({
      ...graph,
      nodes: [...graph.nodes, { nid: newNid, agent_id: agentId }],
      edges: [
        ...graph.edges.filter((e) => e.from !== nid),
        { from: nid, to: newNid, order: "serial" as const },
        ...outs.map((e) => ({ ...e, from: newNid })),
      ],
    });
  };

  const startDrag = (e: React.PointerEvent, nid: string) => {
    if (frozen) return;
    if ((e.target as HTMLElement).closest("button")) return; // 卡头上有按钮（⋯），别抢它的点击
    const at = layout.pos[nid];
    if (!at) return;
    e.preventDefault();
    setDrag({ nid, sx: e.clientX, sy: e.clientY, ox: at.x, oy: at.y, dx: 0, dy: 0, moved: false });
  };

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return; // 还在"点"的范围里
      setDrag((d) => (d ? { ...d, dx, dy, moved: true } : d));
    };
    const onUp = () => {
      setDrag((d) => {
        if (d?.moved) {
          const nx = Math.round(d.ox + d.dx);
          const ny = Math.round(d.oy + d.dy);
          onChange({
            ...graph,
            nodes: graph.nodes.map((x) => (x.nid === d.nid ? { ...x, x: nx, y: ny } : x)),
          });
        }
        return null;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, graph, onChange]);
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
    const rightEdge = Math.max(at.x + layout.NW, layout.concAt.x + layout.CONC_W) + 4;
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
    {/* 缩放控件（对齐 Dify postionControls：左下角「－ 百分比 ＋」，点百分比出档位 + 适应画布）。
        放在 stage **外面** —— stage 是 overflow-auto，放里面会跟着内容滚走。 */}
    {!frozen && (
      <div className="absolute bottom-3 left-3 z-30 flex items-center gap-0.5 rounded-[8px] border px-1 py-0.5 shadow-sm" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
        <button type="button" title="缩小" onClick={() => zoomStep(-0.1)} className="px-1.5 py-0.5 text-[13px] leading-none hover:bg-[var(--color-surface-2)]" style={{ color: "var(--color-muted)" }}>−</button>
        <div className="group relative">
          <button type="button" className="min-w-[46px] rounded-[5px] px-1 py-0.5 text-[11.5px] tabular-nums hover:bg-[var(--color-surface-2)]" title="选择缩放档位 / 适应画布">
            {Math.round(zoom * 100)}%
          </button>
          <div className="pointer-events-none absolute bottom-full left-0 mb-1 hidden flex-col rounded-[8px] border py-1 shadow-lg group-hover:pointer-events-auto group-hover:flex" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)", minWidth: 96 }}>
            {[2, 1, 0.75, 0.5, 0.25].map((z) => (
              <button key={z} type="button" onClick={() => zoomTo(z)} className="px-3 py-1 text-left text-[12px] hover:bg-[var(--color-surface-2)]">
                {Math.round(z * 100)}%
              </button>
            ))}
            <div className="my-1 border-t" style={{ borderColor: "var(--color-border)" }} />
            <button type="button" onClick={fitView} className="px-3 py-1 text-left text-[12px] hover:bg-[var(--color-surface-2)]">适应画布</button>
          </div>
        </div>
        <button type="button" title="放大" onClick={() => zoomStep(+0.1)} className="px-1.5 py-0.5 text-[13px] leading-none hover:bg-[var(--color-surface-2)]" style={{ color: "var(--color-muted)" }}>＋</button>
      </div>
    )}
    <div
      ref={stageRef}
      data-canvas-drop="1"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onSelect(null);
          setEdgeSel(null);
        }
      }}
      onWheel={(e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        zoomStep(-Math.sign(e.deltaY) * 0.1);
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
        {/* 外层按**缩放后**的尺寸占位（滚动条范围对），内层整体 scale（内容对） */}
        <div
          className="relative m-auto shrink-0"
          style={{ width: layout.w * zoom, height: layout.h * zoom }}
        >
        <div
          className="relative"
          style={{ width: layout.w, height: layout.h, transform: `scale(${zoom})`, transformOrigin: "0 0" }}
        >
          {/* 流水线连接线：纵向流的筋。必须挂在这个 position:relative 的居中框里 ——
              挂外层会以整个舞台为基准，线就画到空白处去了（上一版就是这么错的）。 */}
          {layout.links.map((l, i) => (
            <div
              key={`pl-lnk-${i}`}
              aria-hidden
              className="pl-connector"
              style={{ left: l.x - 1, top: l.y1, height: Math.max(2, l.y2 - l.y1) }}
            />
          ))}
        <svg className="pointer-events-none absolute inset-0" width={layout.w} height={layout.h}>
          {ghost && (
            <path d={ghost} fill="none" stroke="var(--color-accent)" strokeWidth={1.6} strokeDasharray="5 4" />
          )}
          {/* **任务卡 → 第一个节点**这一根线：对着 Dify 截图比对时发现我们缺了它
              （Dify 的 Start 与第一个节点之间是连着的 —— 流程从"要做什么"就开始，
              而不是断在任务卡那里）。画法/线宽/终点方条与其它连线同源，颜色随首个节点状态。 */}
          {!frozen &&
            graph.nodes.length > 0 &&
            (() => {
              const firstIds = layout.layers[0] ?? [];
              if (!firstIds.length) return null;
              const f = layout.pos[firstIds[0]];
              if (!f) return null;
              const st0 = runStates[firstIds[0]];
              const live0 = st0 === "run";
              const done0 = st0 === "ok";
              const y0 = layout.taskAt.y + (taskH || 240) / 2;
              const y1 = f.y + (heights[firstIds[0]] ?? 120) / 2;
              const x0 = layout.taskAt.x + layout.CARD_W;
              const x1 = f.x - 3;
              const midX = (x0 + x1) / 2;
              const stroke0 = live0
                ? "var(--color-accent)"
                : done0
                  ? "color-mix(in srgb, var(--color-ok) 55%, #D0D5DD)"
                  : "#D0D5DD";
              return (
                <>
                  <path
                    d={`M ${x0} ${y0} C ${midX} ${y0}, ${midX} ${y1}, ${x1} ${y1}`}
                    fill="none"
                    stroke={stroke0}
                    strokeWidth={2}
                  />
                  <rect x={x1 - 2} y={y1 - 4} width={2} height={8} fill={live0 ? "var(--color-accent)" : "#2970FF"} />
                </>
              );
            })()}
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
              {/* 不再说"三种开始方式"—— 只有一种东西：一条流程。
                  1 个助手是流程，5 个助手也是流程；怎么跑由连线决定，用户不用先选类型。 */}
              <h2 className="text-[15px] font-semibold">加一个助手，就开始</h2>
              <p className="mt-1 text-[13px]" style={{ color: "var(--color-muted)" }}>
                上面选一个起步，或者直接加一个助手 —— 想接几步就接几步。
                一路连下去是接力，谁也不连是各跑各的，都一样，都是一条流程。
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {(
                  [
                    ["single", "一个助手，先试试"],
                    ["serial", "三个助手接力"],
                    ["fan", "一个任务分几路跑"],
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
            onDragOver={(e) => {
              // 只认"文件"，不干扰从助手栏拖助手进来那条路径
              if (Array.from(e.dataTransfer.types).includes("Files")) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }
            }}
            onDrop={(e) => {
              const files = Array.from(e.dataTransfer.files ?? []);
              if (!files.length) return;      // 没有文件 → 交给画布处理（拖助手）
              e.preventDefault();
              e.stopPropagation();
              onAttach?.(files);
            }}
          style={{
            // 空画布时**不显示**任务卡：此时还没有流程可跑，它只会和空状态引导叠在一起
            // （实测空状态下两者重叠、标题被压掉一半）。加进第一个助手后它自然出现。
            display: empty ? "none" : undefined,
            transform: `translate(${layout.taskAt.x}px, ${layout.taskAt.y}px)`,
            width: layout.CARD_W,
            // 与节点卡**视觉分层**：发令区是"起点"，给一点强调底色 + 左侧 3px 色条
            // （用 inset box-shadow 画色条，零额外 DOM）
            background: "color-mix(in srgb, var(--color-accent) 4%, var(--color-surface))",
            borderColor: "color-mix(in srgb, var(--color-accent) 26%, var(--color-border))",
            boxShadow: "inset 3px 0 0 color-mix(in srgb, var(--color-accent) 55%, transparent)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 发令区头部（方案 C）：左=这次要做什么、右=**运行键**。
              主操作放在第一眼的位置，不再像之前那样独占整行、把卡片撑得很笨重。 */}
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] font-semibold" style={{ color: "var(--color-muted)" }}>
              这次要做什么
            </span>
            <button
              type="button"
              disabled={running}
              onClick={(e) => {
                e.stopPropagation();
                onRun?.();
              }}
              className="df-ctl-sm ml-auto shrink-0 justify-center px-3 font-medium text-white disabled:opacity-45"
              style={{ background: "var(--color-accent)" }}
              title={`开始执行这条流程（Enter）· 共 ${layout.layers.flat().length} 步，怎么跑由连线决定`}
            >
              {running ? "运行中…" : `▸ 运行${layout.layers.flat().length > 1 ? ` · ${layout.layers.flat().length} 步` : ""}`}
            </button>
          </div>

          {/* 输入框**默认就在卡上** —— 不"点一下才展开"、不弹窗、不跳页。
              之前是「点击 → 就地放大成 480 的编辑态」，用户明确要求改掉：
              默认显示即输入，进来就能打字（少一次点击，也少一层状态）。 */}
          <textarea
            ref={taskBoxRef}
            value={taskValue}
            rows={3}
            onChange={(e) => onTaskValue?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.currentTarget.blur();
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
              minHeight: 84,
              maxHeight: 260,
            }}
          />

          {/* 附件行（工具栏已按要求去掉 —— 任务不需要富文本，只需要能带料进来）：
              文本之外可以塞 **图片** 和 **文件**：点「＋」或直接把文件拖到这张卡上。
              缩略图/文件名做成可删的小条，删除不弹窗（点 ✕ 即走，要恢复再拖一次就行）。 */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              title="加图片或文件（也可以直接把文件拖到这张卡上）"
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={(ev) => {
                ev.stopPropagation();
                fileInputRef.current?.click();
              }}
              className="df-ctl-sm justify-center hover:bg-[var(--color-surface-2)]"
              style={{ color: "var(--color-accent)", border: "1px dashed var(--color-border)" }}
            >
              ＋ 图片 / 文件
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.pdf,.txt,.md,.csv,.json,.xlsx,.xls,.docx,.doc,.zip,.log"
              className="hidden"
              onChange={(ev) => {
                const files = Array.from(ev.target.files ?? []);
                if (files.length) onAttach?.(files);
                ev.target.value = "";   // 同一个文件再选一次也要触发
              }}
            />
            {attachments.map((f) => (
              <span
                key={f.id}
                className="flex items-center gap-1.5 rounded-[6px] border px-1.5 py-1 text-[12px]"
                style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
              >
                {f.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.url} alt={f.name} className="h-[22px] w-[22px] rounded-[4px] object-cover" />
                ) : (
                  <span
                    className="grid h-[22px] w-[22px] place-items-center rounded-[4px] text-[11px]"
                    style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
                  >
                    ▤
                  </span>
                )}
                <span className="max-w-[130px] truncate" title={`${f.name} · ${Math.max(1, Math.round(f.size / 1024))} KB`}>
                  {f.name}
                </span>
                <button
                  type="button"
                  title="移除这个附件"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onDetach?.(f.id);
                  }}
                  className="px-1 text-[var(--color-muted)] hover:text-[var(--color-err)]"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>

          {/* 运行键已移到卡头右上角（方案 C）；这里只留一句键盘提示 */}
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
            Enter 运行 · Shift+Enter 换行
          </div>
        </div>

        {/* 选助手气泡：**贴着触发点**冒出（大布局不遮画布 —— 用户明确要求）。
            内容按"先摆依据再让人选"排：一句话职责 + 能力名字 + 模型，
            有任务文本时先给「★ 推荐」（中文二元组近似匹配，零依赖）。 */}
        {picking &&
          (() => {
            const ranked = agents
              .map((a) => ({ a, s: recScore(a, taskValue, toolNames) }))
              .sort((x, y) => y.s - x.s);
            const rec = ranked.filter((r) => r.s > 0).slice(0, 3);
            const rest = ranked.filter((r) => !rec.includes(r));
            const node = picking.nid ? layout.pos[picking.nid] : null;
            const insNode = insertAfter ? layout.pos[insertAfter] : null;
            const at =
              insNode
                ? { x: insNode.x + layout.NW + 10, y: insNode.y }
                : picking.mode === "add"
                  ? { x: layout.addAt.x, y: layout.addAt.y + 50 }
                  : { x: (node?.x ?? 0) + layout.NW + 10, y: node?.y ?? 0 };
            const row = ({ a, s: sc }: { a: Agent; s: number }) => (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  const mode = picking.mode;
                  const nid = picking.nid;
                  setPicking(null);
                  if (mode === "add") {
                    if (insertAfter) insertAfterStep(insertAfter, a.id);
                    else onAddStep?.(a.id);
                    setInsertAfter(null);
                  } else if (nid) onSwapAgent?.(nid, a.id);
                }}
                className="flex w-full items-start gap-2 rounded-[6px] px-2 py-1.5 text-left hover:bg-[var(--color-surface-2)]"
              >
                <span
                  className="mt-0.5 grid h-[24px] w-[24px] shrink-0 place-items-center rounded-[6px] border text-[12px] font-semibold"
                  style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
                >
                  {a.name.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="truncate text-[12.5px] font-medium">{a.name}</span>
                    {sc > 0 && (
                      <span className="shrink-0 text-[11px]" style={{ color: "var(--color-accent)" }}>
                        ★
                      </span>
                    )}
                  </span>
                  {blurbOf(a) && (
                    <span className="mt-0.5 block text-[11.5px] leading-snug" style={{ color: "var(--color-muted)" }}>
                      {blurbOf(a)}
                    </span>
                  )}
                  <span className="mt-0.5 block truncate text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                    {[a.definition?.model?.name, ...skillsOf(a, toolNames)].filter(Boolean).join(" · ") || "（未配模型）"}
                  </span>
                </span>
              </button>
            );
            return (
              <>
                {/* 点空白处收起（全站一致，不用原生弹窗） */}
                <div className="fixed inset-0 z-30" onClick={() => setPicking(null)} />
                <div
                  className="absolute z-40 flex w-[300px] flex-col rounded-[10px] border p-1"
                  style={{
                    left: at.x,
                    top: at.y,
                    maxHeight: 400,
                    background: "var(--color-surface)",
                    borderColor: "var(--color-border)",
                    boxShadow: "0 12px 32px rgba(16,24,40,.16)",
                  }}
                >
                  <div className="px-2 pb-1 pt-1.5 text-[12px]" style={{ color: "var(--color-muted)" }}>
                    {picking.mode === "add" ? "下一步由谁做？" : "这一步换成谁？"}
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto">
                    {rec.length > 0 && (
                      <>
                        <div className="px-2 pb-1 text-[11.5px]" style={{ color: "var(--color-accent)" }}>
                          ★ 推荐（按当前任务匹配）
                        </div>
                        {rec.map(row)}
                        <div className="my-1 border-t" style={{ borderColor: "var(--color-border)" }} />
                        <div className="px-2 pb-1 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                          全部助手
                        </div>
                      </>
                    )}
                    {rest.map(row)}
                    {!agents.length && (
                      <div className="px-2 py-2 text-[12px]" style={{ color: "var(--color-muted)" }}>
                        还没有助手，先去「Agents」建一个。
                      </div>
                    )}
                  </div>
                  <div
                    className="border-t px-2 py-1.5 text-[11.5px]"
                    style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}
                  >
                    想新建助手？去「Agents」页
                  </div>
                </div>
              </>
            );
          })()}

        {/* 点某个节点 → **就地展开这一步的详情**（贴着节点，不跳页、不盖住整块画布）。
            内容按"先看结论再看过程"排：
              谁在做（名字 + 一句话职责）：用了什么模型 · 现在的状态
              完整过程（分阶段分色：思考/工具/工具输出/…，与卡片上一致）
              产出（完整 Markdown，自带滚动）
            为什么贴在节点旁而不是开右侧栏：控件（信息）归属其对象 ——
            你点的是这一步，答案就该出现在这一步旁边。 */}
        {detailNid &&
          (() => {
            const n = graph.nodes.find((x) => x.nid === detailNid);
            const at = n ? layout.pos[n.nid] : null;
            if (!n || !at) return null;
            const agent = agents.find((a) => a.id === n.agent_id);
            const st = runStates[n.nid] ?? "idle";
            const out = outputs[n.nid] ?? "";
            const lv = live?.[n.nid];
            const stepNo = layout.layers.findIndex((ids) => ids.includes(n.nid)) + 1;
            // 宽度按可用空间收敛：桌面 384；窄屏（手机）取列宽 - 8，永不超出屏幕。
            // 位置：桌面贴节点右侧（贴右边界就翻到左侧）；窄屏**放到节点下方**并左对齐
            // —— 手机只有 ~375px 宽，横着放必然溢出屏幕（这是我在窄屏上要确认的那条）。
            const BW = narrow ? Math.max(240, colW - 8) : 384;
            const toRight = at.x + layout.NW + 14;
            const flip = toRight + BW > layout.w - 6;
            const left = narrow ? Math.max(4, at.x) : flip ? Math.max(6, at.x - BW - 14) : toRight;
            const top = narrow ? at.y + (heights[n.nid] ?? 220) + 10 : at.y;
            const statusText =
              st === "run" ? "执行中" : st === "ask" ? "等你确认" : st === "ok" ? "完成" : st === "err" ? "出错" : st === "stale" ? "已失效" : "还没跑";
            const statusColor =
              st === "run" ? "var(--color-accent)" : st === "ask" ? "var(--color-warn)" : st === "ok" ? "var(--color-ok)" : st === "err" ? "var(--color-err)" : "var(--color-muted)";
            const blurb = agent ? blurbOf(agent) : "";
            return (
              <div
                className="absolute z-30 flex flex-col overflow-hidden rounded-[12px] border shadow-lg"
                style={{
                  transform: `translate(${left}px, ${top}px)`,
                  width: BW,
                  maxHeight: narrow ? "62vh" : 470,
                  background: "var(--color-surface)",
                  borderColor: "var(--color-border)",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: "var(--color-border)" }}>
                  <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-[10.5px] tabular-nums" style={{ background: "var(--color-surface-2)", color: "var(--color-muted)" }}>
                    {stepNo}
                  </span>
                  <span className="truncate text-[13px] font-medium">{agent?.name ?? "助手"}</span>
                  <span className="shrink-0 rounded-full px-1.5 py-[1px] text-[10.5px]" style={{ color: statusColor, background: `color-mix(in srgb, ${statusColor} 12%, transparent)` }}>
                    {statusText}
                  </span>
                  <button
                    type="button"
                    title="收起详情"
                    className="ml-auto shrink-0 rounded-[6px] px-1.5 py-[1px] text-[13px] leading-none hover:bg-[var(--color-surface-2)]"
                    style={{ color: "var(--color-muted)" }}
                    onClick={(e) => { e.stopPropagation(); onDetail?.(null); }}
                  >
                    ✕
                  </button>
                </div>

                <div className="border-b px-3 py-2" style={{ borderColor: "var(--color-border)" }}>
                  <div className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                    {blurb || "（这个助手还没写一句话职责）"}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]" style={{ color: "var(--color-muted)" }}>
                    {agent?.definition?.model?.name && (
                      <span className="rounded-full border px-1.5 py-[1px]" style={{ borderColor: "var(--color-border)" }}>
                        {agent.definition.model.name}
                      </span>
                    )}
                    {(agent ? skillsOf(agent, toolNames) : []).slice(0, 4).map((t) => (
                      <span key={t} className="rounded-full border px-1.5 py-[1px]" style={{ borderColor: "var(--color-border)" }}>
                        {t}
                      </span>
                    ))}
                  </div>
                </div>

                {lv && lv.events.length > 0 && (
                  <div className="flex max-h-[210px] flex-col gap-[3px] overflow-auto border-b px-2.5 py-2" style={{ borderColor: "var(--color-border)" }}>
                    {tailOf(lv.events, 60).map((l, i) => {
                      const sty = STEP_STYLE[l.kind];   // 与卡片上的分色同源
                      return (
                        <div key={`d${i}`} className="flex items-start gap-1.5 rounded-[6px] px-1.5 py-[3px]" style={{ background: sty.bg, border: `1px solid ${sty.border}` }}>
                          <span className="shrink-0 text-[10px]" style={{ color: sty.color }}>
                            {sty.icon}
                          </span>
                          <span className="whitespace-pre-wrap break-words text-[11.5px] leading-[1.6]">{l.text}</span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {out ? (
                  <div className="overflow-auto px-3 py-2 text-[12px] leading-[1.7]">
                    <Markdown text={out} />
                  </div>
                ) : (
                  <div className="px-3 py-3 text-[12px]" style={{ color: "var(--color-muted)" }}>
                    {st === "run" ? "正在执行，产出会出现在这里…" : "这一步还没有产出。"}
                  </div>
                )}
              </div>
            );
          })()}

        {/* 「＋ 加一步」—— 属于**流程本身**，所以画在流程末尾，而不是塞进顶栏或侧栏
            （控件归属其对象：你加的是"这一步"，不是"顶栏的一个功能"）。
            它替代了原来的左侧助手栏：那个栏占了 208px 宽，只为放"可拖的助手列表"，
            横向布局下这 208px 正是最值钱的地方。 */}
        {/* 连线上的**关系词**：串行 / 并行 · +上下文 · +记忆。
            这些东西原来只活在"点开那条线"的面板里 —— 全页最值钱的信息最不可见，
            读一条已有流程要一根根去摸。现在常显在线上（小、灰、不抢视线）。 */}
        {graph.edges.map((e) => {
          const mid = edgeMids[`${e.from}->${e.to}`];
          if (!mid) return null;
          const parts = [e.order === "parallel" ? "并行" : "串行"];
          if (e.share_context) parts.push("+上下文");
          if (e.share_memory) parts.push("+记忆");
          const plain = !e.share_context && !e.share_memory;
          return (
            <span
              key={`el-${e.from}-${e.to}`}
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border px-1.5 py-[1px] text-[10.5px] leading-[1.5]"
              style={{
                left: mid.x,
                top: mid.y,
                background: "var(--color-surface)",
                borderColor: plain ? "var(--color-border)" : "color-mix(in srgb, var(--color-accent) 45%, transparent)",
                color: plain ? "var(--color-muted)" : "var(--color-accent)",
              }}
            >
              {parts.join(" · ")}
            </span>
          );
        })}

        {/* 每个节点右侧一个小 ＋：**就地往后接一步**。
            原来只有流程末尾一个「＋ 加一步」—— 步骤一多它就滑出视口
            （实测 4 步后 x=1396 > 视口右缘 1280），最常用的"再加一个"反而够不到。
            控件跟着它作用的对象走：想接在谁后面，就点谁右边的 ＋。 */}
        {!frozen &&
          graph.nodes.map((n) => {
            const at = layout.pos[n.nid];
            if (!at) return null;
            return (
              <button
                key={`plus-${n.nid}`}
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  setInsertAfter(n.nid);
                  setPicking({ mode: "add" });
                }}
                title="在这一步后面加一个助手"
                className="absolute grid place-items-center rounded-full border text-[13px] leading-none transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                style={{
                  left: at.x + layout.NW + 7,
                  top: at.y + 12,
                  width: 22,
                  height: 22,
                  background: "var(--color-surface)",
                  borderColor: "var(--color-border)",
                  color: "var(--color-muted)",
                }}
              >
                ＋
              </button>
            );
          })}

        {!frozen && !empty && (
          <button
            type="button"
            onClick={() => setPicking({ mode: "add" })}
            title="在流程末尾再加一个助手"
            className="absolute flex items-center justify-center gap-1.5 rounded-[10px] border border-dashed text-[12px] hover:bg-[var(--color-surface-2)]"
            style={{
              transform: `translate(${layout.addAt.x}px, ${layout.addAt.y}px)`,
              width: layout.ADD_W,
              height: 44,
              borderColor: "var(--color-border)",
              color: "var(--color-accent)",
              background: "var(--color-surface)",
            }}
          >
            ＋ 加一步
          </button>
        )}

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
            <div className="overflow-visible">
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
              const x1 = layout.pos[l].x + layout.NW;
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
          // 拖动中的节点用**实时**位置（预览），其余用布局算出来的位置
          const p =
            drag?.nid === n.nid ? { x: drag.ox + drag.dx, y: drag.oy + drag.dy } : (layout.pos[n.nid] ?? { x: 0, y: 0 });
          const st = (runStates[n.nid] ?? "idle") as NodeState;
          const meta = META[st] ?? META.idle;
          /** 本轮有没有任何一步在"跑/等你确认" —— 用来给未轮到的步骤压暗（进度一眼可见） */
          const anyActive = graph.nodes.some((x) => {
            const st2 = runStates[x.nid] ?? "idle";
            return st2 === "run" || st2 === "ask";
          });
          const lv = live?.[n.nid];
          const isSel = selected === n.nid;
          // 手柄颜色随节点状态（对齐 Dify：常态灰 / 运行蓝 / 成功绿 / 失败红）
          const handleTint =
            st === "run"
              ? "var(--color-accent)"
              : st === "ok"
                ? "var(--color-ok)"
                : st === "err"
                  ? "var(--color-err)"
                  : st === "ask"
                    ? "var(--color-warn)"
                    : "color-mix(in srgb, var(--color-border) 92%, var(--color-muted))";
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
              /* 拖动只从**卡头**开始（正文要能选字、能滚动） */
              onPointerDown={(e) => {
                const head = (e.target as HTMLElement).closest("[data-draghead]");
                if (head) startDrag(e, n.nid);
              }}
              className={`wf-node group absolute rounded-[15px] border shadow-xs hover:shadow-lg ${
                lv && st === "run" ? "node-run" : st === "ask" ? "node-ask" : ""
              } ${
                // 进度可视化（零操作）：只要有任何一步在跑/等待确认，还没轮到的步骤就压暗。
                // 扫一眼就知道"跑到哪了"，不用点、不用悬停（触屏同样成立）。
                anyActive && (st === "idle" || st === "wait") ? "node-dim" : ""
              }`}
              style={{
                transform: `translate(${p.x}px, ${p.y}px)`,
                width: layout.NW,
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
              {/* 连接点（手柄）：对齐 Dify 的 node-handle —— 节点两侧的小竖条。
                  这是 Dify 图里最显眼的识别特征之一：常态灰、运行中蓝、成功绿、失败红。
                  我们的流程是**横向**的，所以把 Dify 的"上下两点"转成"左右两点"：
                  左=入（谁交给我），右=出（我交给谁）。pointer-events-none，纯样式，
                  不抢正文的点击选中（连线仍由画布自动生成）。 */}
              {!frozen && (
                <>
                  <span
                    aria-hidden
                    className="pointer-events-none absolute z-10"
                    style={{ left: -7, top: "50%", transform: "translateY(-50%)", width: 3, height: 14, borderRadius: 2, background: handleTint }}
                  />
                  <span
                    aria-hidden
                    className="pointer-events-none absolute z-10"
                    style={{ right: -7, top: "50%", transform: "translateY(-50%)", width: 3, height: 14, borderRadius: 2, background: handleTint }}
                  />
                </>
              )}
              {/* **悬停工具条**（对齐 Dify 的节点悬浮操作条）：
                  鼠标移到节点上（或它被选中时）从卡片顶部浮出一条小工具条，
                  放**最常用的三个、且都非破坏性**的动作 —— 看详情 / 换助手 / 配置。
                  破坏性的（移除这一步、清空下游）仍然留在 ⋯ 菜单里：
                  用户定过"破坏性操作要两步确认"，不放悬停条上误点。
                  触屏没有悬停，这条只是加分项，功能一个都没少（⋯ 里都有）。 */}
              {!frozen && (
                <div
                  /* ⚠️ **不跟鼠标**：只在选中这个节点 / 打开它的详情时显示。
                     第一版写成 group-hover:flex —— 鼠标扫过节点它就冒出来、移开又消失，
                     看起来一直在闪（用户反馈"操作还是不流畅自然"）。
                     悬停自动弹 = 视觉噪音；选中是明确意图，也不多花动作。 */
                  className={`absolute -top-8 left-0 z-20 items-center gap-0.5 rounded-[8px] border px-1 py-0.5 shadow-md ${
                    isSel || detailNid === n.nid ? "flex" : "hidden"
                  }`}
                  style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    title="看这一步的详情"
                    onClick={() => onDetail?.(detailNid === n.nid ? null : n.nid)}
                    className="rounded-[5px] px-1.5 py-0.5 text-[11.5px] hover:bg-[var(--color-surface-2)]"
                    style={{ color: "var(--color-muted)" }}
                  >
                    详情
                  </button>
                  <button
                    type="button"
                    title="换掉这一步用的助手（这一步和它后面的产出会重置）"
                    onClick={() => setPicking({ mode: "swap", nid: n.nid })}
                    className="rounded-[5px] px-1.5 py-0.5 text-[11.5px] hover:bg-[var(--color-surface-2)]"
                    style={{ color: "var(--color-muted)" }}
                  >
                    换助手
                  </button>
                  <button
                    type="button"
                    title="配置这个助手"
                    onClick={() => onSelect(n.nid)}
                    className="rounded-[5px] px-1.5 py-0.5 text-[11.5px] hover:bg-[var(--color-surface-2)]"
                    style={{ color: "var(--color-muted)" }}
                  >
                    配置
                  </button>
                </div>
              )}
              <div
                /* data-draghead：拖动的把手只在这里 —— 正文要能选字、能滚动，不能被拖动抢走 */
                data-draghead
                className={`flex items-center gap-2 border-b px-3 pt-3 pb-2 ${
                  drag?.nid === n.nid ? "cursor-grabbing" : "cursor-grab"
                }`}
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
                    {/* 直接说**在做什么** —— 不再是泛泛的"正在执行"。
                        取最新一条动作行：思考→"…思考"，工具→"…调用 X"。
                        颜色跟着那条的**阶段色**走，与下面的过程行同源（同一动作一个颜色）。 */}
                    <span
                      className="min-w-0 flex-1 truncate text-[12px] font-semibold"
                      style={{ color: tailOf(lv.events, 1)[0] ? STEP_STYLE[tailOf(lv.events, 1)[0].kind].color : "var(--color-accent)" }}
                      title={tailOf(lv.events, 1)[0]?.text ?? ""}
                    >
                      {tailOf(lv.events, 1)[0]
                        ? liveLabel(tailOf(lv.events, 1)[0].kind, tailOf(lv.events, 1)[0].text)
                        : "正在准备…"}
                    </span>
                    <span className="ml-auto text-[12px] font-medium" style={{ color: "var(--color-accent)" }}>
                      {lv.elapsedMs == null
                        ? ""
                        : lv.elapsedMs < 1000
                          ? `${Math.round(lv.elapsedMs)}ms`
                          : `${(lv.elapsedMs / 1000).toFixed(1)}s`}
                    </span>
                  </div>
                  {/* 执行详情**自动展开**：不再只留 3 条尾巴，而是把这一轮的动作都给出来。
                      配色复用全站 STEP_STYLE（思考紫 / 工具橙 / 工具输出青 / 输出绿），
                      保证"同一动作到处一个颜色"。
                      容器用 flex-col-reverse + max-h：**最新的那条永远在视野里**（不用写一行滚动 JS），
                      旧的重力往下堆，超出就滚动查看 —— 看过程不需要任何操作。 */}
                  <details open className="group">
                    <summary
                      className="flex cursor-pointer list-none items-center gap-1 px-2.5 py-1 text-[11.5px] select-none"
                      style={{ color: "var(--color-muted)" }}
                    >
                      <span className="inline-block transition-transform group-open:rotate-90">▸</span>
                      过程 · {lv.events.length} 步
                    </summary>
                  <div className="flex max-h-[150px] flex-col-reverse gap-[3px] overflow-auto px-2.5 pb-2 pt-0.5">
                    {tailOf(lv.events, 12).map((l, i) => {
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
                  </details>
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
                                  setNodeMenu(null);
                                  setPicking({ mode: "swap", nid: n.nid });
                                }}
                                className="df-menu-item hover:bg-[var(--color-surface-2)]"
                                title="换掉这一步用的助手（这一步和它后面的产出会重置）"
                              >
                                换成别的助手…
                              </button>
                            )}
{!frozen && (
                    <>
                      {(() => {
                        const pred = graph.edges.find((e) => e.to === n.nid)?.from ?? null;
                        const succ = graph.edges.find((e) => e.from === n.nid)?.to ?? null;
                        return (
                          <>
                            <button
                              type="button"
                              disabled={!pred}
                              onClick={() => {
                                setNodeMenu(null);
                                moveStep(n.nid, -1);
                              }}
                              className="df-menu-item hover:bg-[var(--color-surface-2)] disabled:opacity-35"
                            >
                              上移一位
                            </button>
                            <button
                              type="button"
                              disabled={!succ}
                              onClick={() => {
                                setNodeMenu(null);
                                moveStep(n.nid, 1);
                              }}
                              className="df-menu-item hover:bg-[var(--color-surface-2)] disabled:opacity-35"
                            >
                              下移一位
                            </button>
                          </>
                        );
                      })()}
                    </>
                  )}
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
                  跑完   → 产出（markdown 全文，默认展开）
                  没跑过 → 这个助手是干什么的一句话（不再是空卡） */}
              {st === "ok" && lv?.output?.trim() && (
                /* 产出区**限高 + 自带滚动** —— 卡片的尺寸必须稳定。
                   模型产出动辄几千字（报告/表格/清单），原来全展开会把这一张卡撑成整屏，
                   同一流程里几张卡尺寸天差地别（用户明确要求"注意 agent 的样式和尺寸"）。
                   完整产出点这张卡看（详情浮层里是全文）。 */
                <div className="node-body px-3 pb-2">
                  <div className="max-h-[170px] overflow-auto rounded-[8px] pr-1">
                    <Markdown text={lv.output} />
                  </div>
                  <div className="mt-1.5 text-[11px]" style={{ color: "var(--color-muted)" }}>
                    点这张卡看完整产出 →
                  </div>
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
        {/* 悬停卡：**已经点开详情时不弹**（用户反馈"点击 agent 会弹出两个页面"）。
    成因：节点卡上 onClick（出详情浮层）与 onMouseEnter（350ms 后出这个悬停卡）是两个
    独立事件；点节点时鼠标必然在它上面，于是详情浮层刚出来、悬停卡又叠一个。
    两者信息本来就重叠（都是"这一步在干什么"），所以约定：
    **同一时刻只留一个面板** —— 要看别的节点就点它（详情跟着切换），逻辑一致、也好解释。 */}
        {peek && peekLive && !(detailNid && peek.nid === detailNid) && !detailNid && (
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
