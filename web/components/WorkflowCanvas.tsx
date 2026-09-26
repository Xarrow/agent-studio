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
  configNid?: string | null;
  onConfigNid?: (nid: string | null) => void;
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

/** 两端卡片的"伪节点 id" —— 拖拽/调宽复用同一套机制（节点用 n1/n2…，两端卡用这两个） */
const CARD_IN = "__input__";
/** 卡片高度上下限（拖右下角调高时用）—— 太小看不清、太大一屏放不下 */
const H_MIN = 90;
const H_MAX = 900;
const CARD_OUT = "__output__";

/** 取"用户摆过的"数值：是有限数字才用，否则回退自动值 */
function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
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
  /** 助手设置浮层的受控值（Console 点"看这个助手的设置"时传进来；不传则用内部状态） */
  configNid: configNidProp,
  onConfigNid,
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
  /** 缩放菜单是否展开 —— 触屏没有 hover，只能点开（用户：playground 移动端不流畅） */
  const [zoomMenu, setZoomMenu] = useState(false);
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
    const W_NODE = 320;   // 用户："调整下 agent 尺寸"（240 时产出挤成 4~5 行）
    const W_CONC = 320;
    const GAP_X = 56;   // 层间距（Dify X_OFFSET 60 的量级）
    const GAP_Y = 39;   // 同层节点间距（Dify Y_OFFSET 39）
    /** 卡片宽度**可拖拉调整**（用户："可以在画布上通过拖拉调整卡片的尺寸"）：
     *  每张卡自己的宽度存在节点上（n.w），没调过就用默认 W_NODE；
     *  上下限保证"不会窄到看不清、也不会宽到把整列撑爆"。 */
    const W_MIN = 240;
    const W_MAX = 720;
    const wMap: Record<string, number> = {};
    graph.nodes.forEach((n) => {
      const raw = typeof n.w === "number" ? n.w : W_NODE;
      wMap[n.nid] = narrow ? colW : Math.max(W_MIN, Math.min(W_MAX, raw));
    });
    /** 列 x = 前面各层**最宽那张**累加 —— 拖宽某张卡时后面的列自动让位（不会压上去） */
    const colX: number[] = [];
    {
      let x = PAD + (narrow ? colW : Math.max(W_MIN, Math.min(W_MAX, numOr(graph.input_card?.w, W_TASK)))) + GAP_X;
      layers.forEach((ids, ci) => {
        colX[ci] = x;
        const maxW = Math.max(W_NODE, ...ids.map((id) => wMap[id] ?? W_NODE));
        x += maxW + GAP_X;
      });
    }
    /** 纵向（手机）三块统一用实测列宽 */
    const CW = colW;
    /** 这一格的高度：用户拖右下角调过就用它，否则用实测高度（内容驱动） */
    const hOf = (nid: string) => {
      const node = graph.nodes.find((x) => x.nid === nid);
      return numOr(node?.h, heights[nid] || 104);
    };
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
          pos[nid] = manualOf(nid) ?? { x: colX[ci] ?? PAD + W_TASK + GAP_X, y };
          y += hOf(nid) + GAP_Y;
          // maxX 要把"被拖到很右边的节点"也算进去，否则结论卡会叠上去
          maxX = Math.max(maxX, pos[nid].x + (wMap[nid] ?? W_NODE) + PAD);
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
    // 两端卡：用户拖过就用它的坐标（手机纵向不看坐标，硬塞会互相压 ✗）
    const taskAt = narrow
      ? { x: PAD, y: PAD }
      : graph.input_card && numOr(graph.input_card.x, NaN) === graph.input_card.x
        ? { x: numOr(graph.input_card.x, PAD), y: numOr(graph.input_card.y, firstY) }
        : { x: PAD, y: firstY };
    const concAt = narrow
      ? { x: PAD, y: addAt.y + 46 }
      : graph.output_card && numOr(graph.output_card.x, NaN) === graph.output_card.x
        ? { x: numOr(graph.output_card.x, maxX + GAP_X), y: numOr(graph.output_card.y, lastY) }
        : { x: maxX + GAP_X, y: lastY };   // 「＋ 加一步」移除后，结论卡直接跟在末列后面（不留空位）
    /** 三块的实际宽度（窄屏=列宽；宽屏=各自的固定宽）—— 渲染只读这三个值 */
    const CARD_W = narrow ? CW : Math.max(W_MIN, Math.min(W_MAX, numOr(graph.input_card?.w, W_TASK)));
    const NW = narrow ? CW : W_NODE;
    const CONC_W = narrow ? CW : Math.max(W_MIN, Math.min(W_MAX, numOr(graph.output_card?.w, W_CONC)));
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
    return { pos, w, h, layers, taskAt, concat: concAt, concAt, addAt, ADD_W, CARD_W, NW, CONC_W, CW, links, W: wMap, W_MIN, W_MAX };
  }, [graph.nodes, graph.edges, graph.input_card, graph.output_card, heights, colW, narrow, taskText, finalText, taskH]);

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
      const x1 = p.x + (layout.W[from] ?? layout.NW);
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
      suppressClickRef.current = Date.now() + SUPPRESS_MS;   // 拉过一次连线，落点节点别弹详情
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
      const x1 = a.x + (layout.W[e.from] ?? layout.NW);
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
          data-edge-trigger
          onMouseEnter={() => setHoverEdge(key)}
          onMouseLeave={() => setHoverEdge((x) => (x === key ? null : x))}
          onClick={(ev) => {
            ev.stopPropagation();
            // 点连线：先把**别的浮层**都关掉，再切换这条线的卡片（避免叠着好几张 ✗）
            onSelect(null);
            onDetail?.(null);
            setPicking(null);
            setPeek(null);
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
  /** 「配置这个助手」点开后**就地在画布上**弹出的助手设置浮层。
   *  之前这个动作只把节点选中、什么都不打开 —— 点了没反应等于空承诺
   *  （用户反馈"点击后弹出不会消失"，根子在"点了没有正经回应"）。
   *  现在：就地给一份**只读的助手设置摘要**，底部一个「打开完整设置 →」
   *  （要改再去 Agents 页，是全流程里唯一一次跳页，且是明确意图）。 */
  /** 卡片上「删除」的两步确认：第一次点只是"上膛"（按钮变红问"确认删除？"），
   *  4 秒内再点才真的删；超时自动复位。
   *  为什么这样做：破坏性动作不能一点就删 ✗（用户定过的规矩），
   *  但也不该让用户先点右上角 ⋯ 再在菜单里找 —— 所以把"确认"这一步**就地**做在按钮上。 */
  const [delArm, setDelArm] = useState<string | null>(null);

  /** 浮层"点外面就关"用的 ref —— 见下面 document 级监听的说明。 */
  const detailPanelRef = useRef<HTMLDivElement | null>(null);
  const pickPanelRef = useRef<HTMLDivElement | null>(null);


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

  /** **画布浮层的统一契约**（用户："卡片显示如果鼠标失焦后应该消失／
   *  多个 tab 点击会重复叠加，这是 bug／为什么线条点击显示串行时，卡片不会消失了？"）
   *
   *  之前每个浮层各关各的（详情 / 选助手 / 连线 / 悬停卡），于是：
   *    · 连续点几个节点 → 旧的没关、新的又开 = **叠加** ✗
   *    · 鼠标一停就走（比如停在连线上）→ 卡片却留着 ✗（用户说的"失焦不消失"）
   *  现在收口成一个"管家"，两条规则对所有浮层生效：
   *    ① **点浮层外面任何地方 → 全部关闭**（物理上不可能叠加）
   *    ② **鼠标离开（既不在触发节点上、也不在浮层里）→ 全部关闭** = "失焦就消失"
   *
   *  为什么不用 `fixed inset-0` 透明遮罩：画布缩放用了 CSS transform，
   *  而 transform 会给内部 fixed 元素重建包含块 → 遮罩盖不满视口 ✗（上一版的 bug 就是这个）。
   *  document 级监听不受 transform 影响，也不用往 DOM 塞全屏透明层。
   */
  /** 指针最后位置：失焦判定不能靠 :hover（会失真），要靠它 + elementFromPoint */
  const lastPt = useRef<{ x: number; y: number } | null>(null);

  const closeAllFloats = useCallback(() => {
    onDetail?.(null);
    setPicking(null);
    setPeek(null);
    // ⚠️ 这里原来漏了 **连线卡片**（edgeSel）✗ ——
    // 用户点一下连线会弹出一张"串行接力 / 并行 / 共享上下文…"的卡片，
    // 但它不在关闭名单里，于是点别处、鼠标移开都关不掉（用户连问三次"线条的卡片不消失"）。
    setEdgeSel(null);
    // ⚠️ 还有"连线中点那个 ＋"弹出的「插到这两步中间」卡片（insertAt）✗ 之前也没关过：
    //    点开之后除了再点一次那个 ＋，没有任何办法关掉 —— 就是用户说的"线条的卡片不消失"。
    setInsertAt(null);
    setDelArm(null);       // 卡片上"确认删除？"的上膛态，点别处也应该复位
  }, [onDetail]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      // 触发者自己 toggle（节点卡 / 操作条 / 连线热区都各自处理关闭+切换）
      if (t.closest("[data-nid], [data-nodetoolbar], [data-edge-trigger]")) return;
      if (t.closest("[data-float]")) return;                   // 点在浮层里，别关
      closeAllFloats();
    };

    /** 失焦检查：延迟 240ms 再看一眼（给"从节点移进浮层"留时间），
     *  届时鼠标既不在浮层里、也不在节点上 → 关。 */
    let timer: number | null = null;
    const schedule = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        // ⚠️ 原来这里用 `:hover` 判断 ✗ —— 这就是"线条的卡片失焦不消失"的真因：
        //    `:hover` 依赖浏览器悬停态，指针一移开/画布重排就失真，实测 mouseout 后永远不关；
        //    而且它无法被可靠验证（脚本派发的事件不产生 :hover）。
        //   elementFromPoint 直接回答"指针现在在哪、底下是什么" —— 确定、可测。
        // 指针位置优先取 mouseout/pointermove 记下的坐标；
        // **判不出来时按"已失焦"处理**（关），而不是像以前那样 return 不关 ✗
        const pt = lastPt.current;
        const el = pt ? (document.elementFromPoint(pt.x, pt.y) as HTMLElement | null) : null;
        if (el) {
          if (el.closest("[data-float]")) return;                    // 指针在浮层里 → 留
          if (el.closest("[data-nid], [data-nodetoolbar]")) return;  // 在节点卡/操作条上 → 留
          if (el.closest("[data-edge-trigger]")) return;             // 在连线热区上 → 留
        }
        closeAllFloats();
      }, 240);
    };
    /** **任何**鼠标移开都要重新判断一次 —— 之前只认 [data-nid]/[data-float]/[data-nodetoolbar]，
     *  于是"从连线上移开"根本不触发检查 → 连线中点弹出的选择器卡片一直留着 ✗
     *  （用户原话："为什么线条的卡片不会消失？？？？"）
     *  检查本身很轻（推迟 240ms 且只查 :hover），放宽触发条件是安全的。 */
    const onOut = (e: MouseEvent) => {
      // mouseout 自带指针坐标 —— 用它，不依赖"之前有没有 pointermove"（那正是上一版的致命前提 ✗）
      if (typeof e.clientX === "number" && typeof e.clientY === "number") {
        lastPt.current = { x: e.clientX, y: e.clientY };
      }
      // 如果移入的目标本身就在某个浮层/节点/操作条/连线里 → 不算失焦，留
      const to = e.relatedTarget as HTMLElement | null;
      if (to && typeof to.closest === "function" &&
          to.closest("[data-float], [data-nid], [data-nodetoolbar], [data-edge-trigger]")) return;
      schedule();
    };

    const onMove = (e: PointerEvent) => {
      lastPt.current = { x: e.clientX, y: e.clientY };
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("mouseout", onOut, true);
    document.addEventListener("pointermove", onMove, { passive: true } as AddEventListenerOptions);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("mouseout", onOut, true);
      document.removeEventListener("pointermove", onMove);
      if (timer) window.clearTimeout(timer);
    };
  }, [closeAllFloats]);

  /** 删除"上膛"4 秒后自动复位（不让按钮一直悬在红色待确认状态） */
  useEffect(() => {
    if (!delArm) return;
    const t = window.setTimeout(() => setDelArm(null), 4000);
    return () => window.clearTimeout(t);
  }, [delArm]);

  /** Esc：收起画布上"浮出来的东西"（助手设置浮层 / 详情浮层 / 节点菜单）。
      统一一个键收口，用户不用去猜"刚才弹出来的怎么关"。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      closeAllFloats();     // 详情 / 选助手 / 悬停卡 / 连线卡 / 插入卡 一起收
      setNodeMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeAllFloats]);
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
    const at = nid === CARD_IN ? layout.taskAt : nid === CARD_OUT ? layout.concAt : layout.pos[nid];
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
          suppressClickRef.current = Date.now() + SUPPRESS_MS;   // 拖过 = 不是点击，别弹详情
          const nx = Math.round(d.ox + d.dx);
          const ny = Math.round(d.oy + d.dy);
          if (d.nid === CARD_IN || d.nid === CARD_OUT) {
            // 两端卡：坐标存在图上的 input_card / output_card（和节点一样跨会话保留）
            const key = d.nid === CARD_IN ? "input_card" : "output_card";
            const prev = d.nid === CARD_IN ? graph.input_card : graph.output_card;
            onChange({ ...graph, [key]: { ...(prev ?? {}), x: nx, y: ny } });
          } else {
            onChange({
              ...graph,
              nodes: graph.nodes.map((x) => (x.nid === d.nid ? { ...x, x: nx, y: ny } : x)),
            });
          }
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

  /* ── 拖卡片右边缘调宽度 ──────────────────────────────────────────────
     用户："用户可以在画布上通过拖拉调整卡片的尺寸"
     宽度存在节点上（graph.nodes[].w）→ 跟着流程一起保存，跨会话保留。
     拖动过程用本地 state 实时跟手；松手才写回图，避免每移动 1px 就标脏存一次。 */
  /** 拖动结束后的"补 click"抑制（用户："注意拖拽不要触发弹框"）。
   *
   *  浏览器规则：pointerdown + 位移 + pointerup，只要按下与松开落在**同一个元素**上，
   *  后面还会补一个 click ✗ —— 于是"把卡片拖到别处"会被卡片当成"点了它"→ 弹出详情 ✗，
   *  "拖右缘调宽"同理。这里在拖/缩结束时记一个时间戳，卡片和连线的 click 在窗口期内直接忽略。 */
  const suppressClickRef = useRef(0);
  const SUPPRESS_MS = 400;
  const [resize, setResize] = useState<{ nid: string; sx: number; sy: number; sw: number; sh: number; w: number; h: number; corner: boolean } | null>(null);
  /** 开始拖尺寸。corner=true 表示抓的是**右下角**（宽高一起改），false 是右缘（只改宽） */
  const startResize = (e: React.PointerEvent, nid: string, corner = false) => {
    if (frozen || narrow) return;            // 只读回放 / 手机上不给拖（手机是一列铺满）
    e.preventDefault();
    e.stopPropagation();                     // 别触发"点卡片=选中"与节点拖动
    const start = nid === CARD_IN ? layout.CARD_W : nid === CARD_OUT ? layout.CONC_W : (layout.W[nid] ?? layout.NW);
    const cardEl = (e.currentTarget as HTMLElement).parentElement;
    const startH = cardEl?.offsetHeight ?? (heights[nid] || 104);
    setResize({ nid, sx: e.clientX, sy: e.clientY, sw: start, sh: startH, w: start, h: startH, corner });
  };
  useEffect(() => {
    if (!resize) return;
    const onMove = (ev: PointerEvent) => {
      const z = zoomRef.current || 1;        // 画布可缩放：屏幕位移 ÷ zoom 才是图内宽度
      const w = Math.round(Math.max(layout.W_MIN, Math.min(layout.W_MAX, resize.sw + (ev.clientX - resize.sx) / z)));
      // 抓右下角时高度也跟手（右缘那条只改宽，不动高 —— 高度默认由内容决定更自然）
      const h = resize.corner
        ? Math.round(Math.max(H_MIN, Math.min(H_MAX, resize.sh + (ev.clientY - resize.sy) / z)))
        : resize.h;
      setResize((r) => (r ? { ...r, w, h } : r));
    };
    const onUp = () => {
      setResize((r) => {
        if (!r) return null;
        const changedW = Math.abs(r.w - r.sw) >= 8;
        const changedH = r.corner && Math.abs(r.h - r.sh) >= 8;
        if (changedW || changedH) {
          suppressClickRef.current = Date.now() + SUPPRESS_MS;   // 拖过 = 不是点击，别弹详情
          const patch: { w?: number; h?: number } = {};
          if (changedW) patch.w = r.w;
          if (changedH) patch.h = r.h;
          if (r.nid === CARD_IN || r.nid === CARD_OUT) {
            const key = r.nid === CARD_IN ? "input_card" : "output_card";
            const prev = r.nid === CARD_IN ? graph.input_card : graph.output_card;
            onChange({ ...graph, [key]: { ...(prev ?? {}), ...patch } });
          } else {
            onChange({ ...graph, nodes: graph.nodes.map((n) => (n.nid === r.nid ? { ...n, ...patch } : n)) });
          }
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
  }, [resize, graph, onChange, layout.W, layout.NW, layout.CARD_W, layout.CONC_W, layout.W_MIN, layout.W_MAX]);
  /**
   * **双指缩放**（触屏）—— 用户："playground 在移动端操作还是不流畅"。
   *
   * 桌面靠 ctrl+滚轮，手机上既没有滚轮也没有 ctrl ✗，所以自己处理两个手指的距离比。
   * 单指**不接管**（留给原生滚动，手感最顺 ✓）；touch-action: pan-x pan-y 关掉
   * 浏览器的"整页缩放"，pinch 才落得到我们手里。
   */
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let d0 = 0;
    let z0 = 1;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        d0 = dist(e.touches);
        z0 = zoomRef.current || 1;
      }
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !d0) return;
      e.preventDefault();
      const z = z0 * (dist(e.touches) / d0);
      setZoom(Math.max(0.25, Math.min(2, Math.round(z * 100) / 100)));
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) d0 = 0;
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, []);


  /**
   * **再制**选中节点（Dify: Mod+D —— shortcuts/definitions.ts:68-73）。
   *
   * 只克隆自己、位置错开一点（+40/+40），**不动连线** —— 不能因为按一下 ⌘D
   * 就把拓扑悄悄改了 ✗（那属于"加一步"该做的事，是另一个动作）。
   */
  const duplicateNode = useCallback(
    (nid: string) => {
      const src = graph.nodes.find((x) => x.nid === nid);
      if (!src) return;
      const newNid = `n${Math.random().toString(36).slice(2, 6)}`;
      onChange({
        ...graph,
        nodes: [
          ...graph.nodes,
          { ...src, nid: newNid, x: (src.x ?? 0) + 40, y: (src.y ?? 0) + 40 },
        ],
      });
      onSelect(newNid);
    },
    [graph, onChange, onSelect],
  );

  /** 删掉一个节点（连带它的连线）—— 卡片上的「删除」和键盘 Delete 共用这一条路径 ✓ */
  const deleteNode = useCallback(
    (nid: string) => {
      onChange({
        ...graph,
        nodes: graph.nodes.filter((x) => x.nid !== nid),
        edges: graph.edges.filter((x) => x.from !== nid && x.to !== nid),
      });
      onSelect(null);
      setDelArm(null);
    },
    [graph, onChange, onSelect],
  );

  /**
   * **画布键位**（对齐 Dify：dify-ref/web/app/components/workflow/shortcuts/definitions.ts）。
   *
   * Dify 的键位表：Delete/Backspace 删选中、Mod+C/V 复制粘贴、Mod+D 复制、
   * Mod+Z/Mod+Shift+Z 撤销重做、Mod+0/1/2 缩放档位、Mod+=/- 放大缩小…
   * 我们这里先落**视图类**那几个（都在本组件里就能做，零风险 ✓）；删除/复制/撤销
   * 要接父组件的流程结构，等 Dify 对照分析出来后一起做 ✓
   *
   * 为什么不接管输入框里的按键：用户在任务卡/名字里打字时，Esc 和 Mod+Z 该归输入框 ✗
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = (t?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || t?.isContentEditable) return;
      if (e.key === "Escape") {
        onSelect(null);
        setZoomMenu(false);
        return;
      }
      // 删除（Dify 键位表：Delete / Backspace —— shortcuts/definitions.ts:49-55）
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        deleteNode(selected);
        return;
      }
      // 方向键移动选中节点（Dify：±5，Shift 时 ±20 —— utils/keyboard-movement.ts:7-16）
      const step = e.shiftKey ? 20 : 5;
      const deltas: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
      };
      const d = deltas[e.key];
      if (d && selected) {
        e.preventDefault();
        onChange({
          ...graph,
          nodes: graph.nodes.map((x) =>
            x.nid === selected ? { ...x, x: (x.x ?? 0) + d[0], y: (x.y ?? 0) + d[1] } : x,
          ),
        });
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      // 缩放/视图（**按 Dify 实际键位**改过：Mod+1=适应视图 · Shift+1=100% · Shift+5=50%
      //  —— shortcuts/definitions.ts:111-141。上一轮我写成 Mod+1=100% ✗，这次照源码改 ✓）
      // 注意：Shift+1 的 e.key 是 "!" ✗（键盘布局差异）→ 必须用 e.code（物理键）判数字 ✓
      const digit = e.code.startsWith("Digit") ? e.code.slice(5) : /^[0-9]$/.test(e.key) ? e.key : "";
      if (e.key.toLowerCase() === "d" && selected) { e.preventDefault(); duplicateNode(selected); }
      else if (digit === "1" && e.shiftKey) { e.preventDefault(); zoomTo(1); }
      else if (digit === "5" && e.shiftKey) { e.preventDefault(); zoomTo(0.5); }
      else if (digit === "1") { e.preventDefault(); fitView(); }
      else if (digit === "0") { e.preventDefault(); fitView(); }
      else if (e.key === "=" || e.key === "+") { e.preventDefault(); zoomStep(+0.1); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomStep(-0.1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSelect, fitView, zoomTo, zoomStep, selected, graph, onChange, deleteNode, duplicateNode]);


  const growTask = () => {
    const el = taskBoxRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };
  useEffect(() => {
    growTask();
  }, [taskValue]);

  /** ⚠️ **点节点不再自动滚动画布**（用户两次反馈"点了画面自己动，不自然"）。
   *
   *  原来这条是把"选中节点所在的那一列 + 结论卡"一起算成 rightEdge，然后 smooth 滚过去 ——
   *  实测后果：点一下节点，整个画布横向滚到最右，连最左边的发令区都被滚出视野，
   *  用户看到的是"我点了个节点，画面整个跑掉了"（截图已确认）。
   *  节点本来就在视野里才点得到，不需要帮用户滚；要横向看，用户自己拖/滚就行。
   *  （"跑完把结论带到眼前"是**另一条** effect，保留 —— 那是执行结束后主动报结果，意图不同。） */

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
      <div data-canvas-zoom-box="1" className="absolute bottom-3 right-3 z-30 flex items-center gap-0.5 rounded-[8px] border px-1 py-0.5 shadow-sm" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
        <button type="button" title="缩小" onClick={() => zoomStep(-0.1)} className="px-1.5 py-0.5 text-[13px] leading-none hover:bg-[var(--color-surface-2)]" style={{ color: "var(--color-muted)" }}>−</button>
        <div className="relative">
          <button type="button" onClick={() => setZoomMenu((v) => !v)} className="min-w-[46px] rounded-[5px] px-1 py-0.5 text-[11.5px] tabular-nums hover:bg-[var(--color-surface-2)]" title="选择缩放档位 / 适应画布">
            {Math.round(zoom * 100)}%
          </button>
          <div className={`absolute bottom-full left-0 mb-1 flex-col rounded-[8px] border bg-[var(--color-surface)] py-1 shadow-lg ${zoomMenu ? "flex" : "hidden"}`}>
            {[2, 1, 0.75, 0.5, 0.25].map((z) => (
              <button key={z} type="button" onClick={() => { zoomTo(z); setZoomMenu(false); }} className="px-3 py-1 text-left text-[12px] hover:bg-[var(--color-surface-2)]">
                {Math.round(z * 100)}%
              </button>
            ))}
            <div className="my-1 border-t" style={{ borderColor: "var(--color-border)" }} />
            <button type="button" onClick={() => { fitView(); setZoomMenu(false); }} className="px-3 py-1 text-left text-[12px] hover:bg-[var(--color-surface-2)]">适应画布</button>
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
          setZoomMenu(false);
        }
      }}
      onWheel={(e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        zoomStep(-Math.sign(e.deltaY) * 0.1);
      }}
      // 双击空白 = 放大一档（Dify: zoomOnDoubleClick=true —— index.tsx:810）。
      // 只有点在**画布自身**上才缩放；点在卡片/控件上不抢它们的行为 ✗
      onDoubleClick={(e) => {
        // "空白"= 不在卡片/控件/连线上的任何位置（画布里有居中容器包着，只认 currentTarget 太严 ✗）
        const el = e.target as HTMLElement;
        if (!el.closest("[data-nid],button,input,textarea,select,[data-canvas-zoom-box],a")) zoomStep(+0.1);
      }}
      data-canvas-stage="1"
      className="relative h-full min-w-0 flex-1 overflow-auto"
      style={{
        touchAction: "pan-x pan-y",   // 触屏：单指滚动交给原生（手感顺），双指缩放我们自己处理
        backgroundColor: hot ? "color-mix(in srgb, var(--color-accent) 5%, var(--color-surface-2))" : "var(--color-surface-2)",
        // 点阵对齐 Dify（nodes/loop/node.tsx: <Background gap={[14,14]} size={2} />）：
        // 点是 2px、间距 14px；我们原来是 1.2px / 20px，显得又稀又小。
        backgroundImage: "radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--color-border) 85%, transparent) 2px, transparent 0)",
        // 间距跟着缩放走（Dify 的 Background gap 也随 zoom 变）——让点阵始终对齐卡片网格；
        // 点本身大小不变（2px），这样缩小时不会糊成一片 ✓
        backgroundSize: `${14 * zoom}px ${14 * zoom}px`,
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
                data-float="edge"
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
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                    {nameOf(e.from)} → {nameOf(e.to)}：这两个怎么配合？
                  </div>
                  {/* 关闭（连线卡片）：此前这张卡**没有任何关闭键** ✗ */}
                  <button
                    type="button"
                    aria-label="关闭"
                    title="关闭"
                    onClick={() => setEdgeSel(null)}
                    className="-mr-1 -mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-[5px] text-[13px] leading-none hover:bg-[var(--color-surface-2)]"
                    style={{ color: "var(--color-muted)" }}
                  >
                    ✕
                  </button>
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
            // 拖宽时跟手；否则用图里存的（拖过就用拖过的宽）
            width: resize?.nid === CARD_IN ? resize.w : layout.CARD_W,
            height: resize?.nid === CARD_IN ? resize.h : (numOr(graph.input_card?.h, 0) || undefined),
            overflow: resize?.nid === CARD_IN || graph.input_card?.h ? "hidden" : undefined,
            // 与节点卡**视觉分层**：发令区是"起点"，给一点强调底色 + 左侧 3px 色条
            // （用 inset box-shadow 画色条，零额外 DOM）
            background: "color-mix(in srgb, var(--color-accent) 4%, var(--color-surface))",
            borderColor: "color-mix(in srgb, var(--color-accent) 26%, var(--color-border))",
            boxShadow: "inset 3px 0 0 color-mix(in srgb, var(--color-accent) 55%, transparent)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 拖宽把手（与节点卡同一套） */}
          {!frozen && !narrow && (
            <ResizeGrip id={CARD_IN} active={resize?.nid === CARD_IN} onDown={(e) => startResize(e, CARD_IN)} />
          )}
          {!frozen && !narrow && (
            <ResizeCorner id={CARD_IN} active={resize?.nid === CARD_IN && resize.corner} onDown={(e) => startResize(e, CARD_IN, true)} />
          )}
          {/* 发令区头部（方案 C）：左=这次要做什么、右=**运行键**。
              主操作放在第一眼的位置，不再像之前那样独占整行、把卡片撑得很笨重。
              头部也是**这一整张卡的拖动把手**（正文要能选字/滚动，不能被拖动抢走） */}
          <div
            data-draghead
            onPointerDown={(e) => startDrag(e, CARD_IN)}
            className={`flex items-center gap-2 ${drag?.nid === CARD_IN ? "cursor-grabbing" : "cursor-grab"}`}
          >
            <span
              className="shrink-0 rounded-full px-1.5 py-[1px] text-[11px] font-semibold"
              style={{ background: STEP_STYLE.input.bg, color: STEP_STYLE.input.color, border: `1px solid ${STEP_STYLE.input.border}` }}
            >
              {STEP_STYLE.input.icon} 输入
            </span>
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
                ? { x: insNode.x + (layout.W[insertAfter as string] ?? layout.NW) + 10, y: insNode.y }
                : picking.mode === "add"
                  ? { x: layout.addAt.x, y: layout.addAt.y + 50 }
                  : { x: (node?.x ?? 0) + ((picking.nid ? layout.W[picking.nid] : undefined) ?? layout.NW) + 10, y: node?.y ?? 0 };
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
                    <div
                  ref={pickPanelRef}
                data-float="pick"
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
        {/* 点浮层外面任何地方 → 关（和「选助手」气泡同一套约定）。
            用户反馈："鼠标都不在焦点上了，卡片还不消失？用户怎么关闭弹出的卡片？"
            —— 之前只有「选助手」有这层遮罩，详情浮层/助手设置/节点配置面板都没有 ✗ */}
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
            const toRight = at.x + (layout.W[n.nid] ?? layout.NW) + 14;
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
                ref={detailPanelRef}
                data-float="detail"
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

{/* ── 这一步的完整执行详情：**输入 / 思考 / 调用 / 回复 四段分色** ───────────────
                   用户："点击 agent 可以查看执行的详情，input，think，call，response 完整的详情通过不同颜色区分"
                   为什么分段分色：这四件事性质完全不同 —— "它收到的"不等于"它想的"，"它想的"不等于"它做的"，
                   混成一段文字根本读不出来；分色之后扫一眼就知道它卡在哪一步。
                   数据来自运行时无关的统一事件流（trace）→ 实时执行和历史回放**都能看到** ✓ */}
                {lv ? (
                  <div className="flex flex-col gap-1.5 overflow-auto px-2.5 py-2" style={{ maxHeight: 320 }}>
                    <DetailSection kind="input" label="输入">
                      {String(lv.input ?? "").trim() ? (
                        <span className="whitespace-pre-wrap break-words">{clip(lv.input, 700)}</span>
                      ) : (
                        <span style={{ color: "var(--color-muted)" }}>（这一步没有单独记录输入）</span>
                      )}
                    </DetailSection>
                    <DetailSection kind="think" label="思考">
                      {String(lv.thinking ?? "").trim() ? (
                        <span className="whitespace-pre-wrap break-words">{clip(lv.thinking, 900)}</span>
                      ) : (
                        <span style={{ color: "var(--color-muted)" }}>（没有思考内容）</span>
                      )}
                    </DetailSection>
                    <DetailSection kind="tool" label="调用">
                      {lv.tools.length ? (
                        lv.tools.map((t, i) => (
                          <div key={i} className={i ? "mt-1.5" : ""}>
                            <span className="font-medium">{t.name}</span>
                            {t.args.trim() && <span style={{ color: "var(--color-muted)" }}> {clip(t.args, 100)}</span>}
                            {t.result.trim() && (
                              <div className="mt-[2px] whitespace-pre-wrap break-words" style={{ color: STEP_STYLE.tool_response.color }}>
                                {STEP_STYLE.tool_response.icon} {clip(t.result, 260)}
                              </div>
                            )}
                          </div>
                        ))
                      ) : (
                        <span style={{ color: "var(--color-muted)" }}>（没有调用工具）</span>
                      )}
                    </DetailSection>
                    <DetailSection kind="output" label="回复">
                      {(out || String(lv.output ?? "")).trim() ? (
                        <Markdown text={out || String(lv.output ?? "")} />
                      ) : (
                        <span style={{ color: "var(--color-muted)" }}>{st === "run" ? "正在执行，产出会出现在这里…" : "还没有产出"}</span>
                      )}
                    </DetailSection>
                  </div>
                ) : out ? (
                  <div className="overflow-auto px-2.5 py-2">
                    <DetailSection kind="output" label="回复">
                      <Markdown text={out} />
                    </DetailSection>
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
          // **汇入**：这条线指向的节点还有别的依赖线进来 —— 它的含义不是"接力给下一个"，
          // 而是"等这几条都跑完，把产出一起交给它"（用户问："多个 agent 处理完交给
          // Orchestrator 验证、总结时，中间线条应该是串行还是并行？"）。
          // 引擎里只有**串行线**构成依赖、也只有它把产出交下去（并行线 = 互不等待、不传产出），
          // 所以这种汇入必须选串行 ✓ —— 但"串行接力"这个词在汇入处会让人以为要排队 ✗，
          // 于是在**多入边**时改叫「汇入」，一眼看懂是"等齐再交"。
          const fanIn =
            e.order !== "parallel" &&
            graph.edges.filter((x) => x.to === e.to && x.order !== "parallel").length > 1;
          const parts = [e.order === "parallel" ? "并行" : fanIn ? "汇入" : "串行"];
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

        {/* **每个节点右侧的小 ＋ 已移除**（用户："移除「加一步」"→"修改，测试，验证"）。
            加步骤属于**编辑动作**，不该常驻在画布上占地方。
            现在往流程里加步骤：卡片操作条的「⧉ 复制一步」+「换助手」，或空画布用三个模板起步。 */}

        {/* **「＋ 加一步」已移除**（用户要求："移除「加一步」"）。
            加一步不必是一个常驻在画布上的大方块 —— 它会一直占着画布最右端一块地方；
            要往后接一步，用**每个节点右侧那个小 ＋**（就地插在它后面，语义更准），
            或者在已有步骤上用「⧉ 复制一步」。 */}

        {finalText.trim() && (
          <div
            className="absolute flex flex-col rounded-[10px] border"
            style={{
              transform: `translate(${layout.concAt.x}px, ${layout.concAt.y}px)`,
              // 拖宽时跟手；否则用图里存的
              width: resize?.nid === CARD_OUT ? resize.w : layout.CONC_W,
              height: resize?.nid === CARD_OUT ? resize.h : (numOr(graph.output_card?.h, 0) || undefined),
              overflow: resize?.nid === CARD_OUT || graph.output_card?.h ? "hidden" : undefined,
              maxHeight: 460,
              background: "color-mix(in srgb, var(--color-accent) 5%, var(--color-surface))",
              borderColor: "color-mix(in srgb, var(--color-accent) 40%, var(--color-border))",
            }}
            title="这次执行合起来的结论"
          >
            {/* 拖宽把手（与节点卡同一套） */}
            {!frozen && !narrow && (
              <ResizeGrip id={CARD_OUT} active={resize?.nid === CARD_OUT} onDown={(e) => startResize(e, CARD_OUT)} />
            )}
            {!frozen && !narrow && (
              <ResizeCorner id={CARD_OUT} active={resize?.nid === CARD_OUT && resize.corner} onDown={(e) => startResize(e, CARD_OUT, true)} />
            )}
            <div
              data-draghead
              onPointerDown={(e) => startDrag(e, CARD_OUT)}
              className={`flex items-center gap-2 border-b px-2.5 py-1.5 ${drag?.nid === CARD_OUT ? "cursor-grabbing" : "cursor-grab"}`}
              style={{ borderColor: "color-mix(in srgb, var(--color-accent) 24%, var(--color-border))" }}>
              <span
                className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-[12px] text-white"
                style={{ background: "var(--color-accent)" }}
              >
                ✓
              </span>
              <span
                className="shrink-0 rounded-full px-1.5 py-[1px] text-[11px] font-semibold"
                style={{ background: STEP_STYLE.output.bg, color: STEP_STYLE.output.color, border: `1px solid ${STEP_STYLE.output.border}` }}
              >
                {STEP_STYLE.output.icon} 输出
              </span>
              <span className="text-[12px] font-semibold" style={{ color: "var(--color-accent)" }}>
                这次执行合起来的结论
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
            data-float="insert"
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
              const x1 = layout.pos[l].x + (layout.W[l] ?? layout.NW);
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
            // 编排者的位置引导：价值在"先分析 / 后归纳"，放中间通常不是本意 ——
            // 只在明显放错时给一句轻提示（不弹窗、不挡操作）
            const orcMisplaced =
              agentOf(n.agent_id)?.definition?.role === "orchestrator" &&
              !((layout.layers[0] ?? []).includes(n.nid) ||
                (layout.layers[layout.layers.length - 1] ?? []).includes(n.nid));
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
                // 刚拖过（移动卡片 / 拉连线 / 调宽度）→ 这次 click 是浏览器补的，不是"点它"
                if (Date.now() < suppressClickRef.current) return;
                // **点卡片 = 选中 + 打开这一步的详情**。
                // 用户："执行后 agent 点击没有显示详情" —— 卡片就是这一步的载体，
                // 点它就该看到这一步的输入/输出/过程（详情浮层贴在这张卡上）。
                // 再点一次 = 收起（切换）；别的浮层先关掉，避免叠着 ✗。
                onSelect?.(n.nid);
                onDetail?.(detailNid === n.nid ? null : n.nid);
                setEdgeSel(null);
                setPicking(null);
                setPeek(null);
              }}
              /* 悬停卡已停用（用户定过"画布上禁止悬停自动出现的东西"）：
                 鼠标扫过就冒出来的浮层既闪又难关；要看某一步，点它就有。 */
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
                // 宽度：正在拖这张卡时用实时值（跟手），否则用图里存的（拖过就用拖过的宽）
                width: resize?.nid === n.nid ? resize.w : layout.W[n.nid] ?? layout.NW,
                // 高度：拖过右下角就用调过的（不设 = 由内容决定，不会留白）
                height: resize?.nid === n.nid ? resize.h : (numOr(n.h, 0) || undefined),
                overflow: resize?.nid === n.nid || n.h ? "hidden" : undefined,
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
              {/* 拖右边缘调这张卡的宽度（触屏也能拖：命中区 14px） */}
              {/* 拖右缘调宽：命中区 20px（10px 落在卡内）+ **看得见**的把手 + touch-action:none。
                  触屏/触控板上没设 touch-action 时，浏览器会把拖拽当滚动并**取消 pointer 事件**，
                  表现就是"拖了没反应" —— 用户反馈：为什么手动拖拽修改不了尺寸。 */}
              {!frozen && !narrow && (
                <ResizeGrip id={n.nid} active={resize?.nid === n.nid} onDown={(e) => startResize(e, n.nid)} />
              )}
              {!frozen && !narrow && (
                <ResizeCorner id={n.nid} active={resize?.nid === n.nid && resize.corner} onDown={(e) => startResize(e, n.nid, true)} />
              )}
              {!frozen && (
                <div
                  /* **常驻显示**（用户要求："agent 上的操作直接在 agent 上方提示出来，不要再让用户点击"）。
                     演进过程值得记一笔：
                       ① 第一版 group-hover:flex → 鼠标扫过就冒出来又消失，像在闪 ✗
                       ② 第二版改成"选中才显示" → 不闪了，但用户得先点一下才看得到操作 ✗
                       ③ 现在：**一直挂在节点上方**（不用悬停、不用点击），选中时底色加重做反馈 ✓
                     三个动作都是非破坏性的（详情 / 换助手 / 配置），常驻不会误伤。 */
                  data-nodetoolbar
                  className={`absolute -top-8 left-0 z-20 flex max-w-[264px] flex-wrap items-center gap-0.5 rounded-[8px] border px-1 py-0.5 shadow-sm transition-colors ${
                    isSel || detailNid === n.nid ? "" : "opacity-80 hover:opacity-100"
                  }`}
                  style={{
                    borderColor: "var(--color-border)",
                    background: isSel || detailNid === n.nid
                      ? "var(--color-surface)"
                      : "color-mix(in srgb, var(--color-surface) 92%, var(--color-surface-2))",
                  }}
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
                  {/* **「配置」已移除**（用户质问："为什么在 playground 上还需要让用户配置 agent？"）
                      理由：Playground 的职责是**编排放什么助手、按什么顺序跑**；
                      助手**本体**（模型 / 提示词 / 工具 / 权限 / 记忆）归 Agents 页。
                      在画布上放开这个口子，会让用户以为"跑之前得先配助手"✗ ——
                      正确的路径是"选一个现成的助手 → 直接跑"✓。要改助手就去 Agents 页。 */}
                  {(() => {
                    const pred = graph.edges.find((e) => e.to === n.nid)?.from ?? null;
                    const succ = graph.edges.find((e) => e.from === n.nid)?.to ?? null;
                    return (
                      <>
                        {/* 上移 / 下移：**方向即语义**（在链上往前/往后挪一位）——
                            所以用箭头而不是"上移一位"三个字（字太占地方）。 */}
                        <button
                          type="button"
                          disabled={!pred || frozen}
                          title="在链上往前挪一位"
                          onClick={() => moveStep(n.nid, -1)}
                          className="rounded-[5px] px-1 py-0.5 text-[12px] hover:bg-[var(--color-surface-2)] disabled:opacity-30"
                          style={{ color: "var(--color-muted)" }}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={!succ || frozen}
                          title="在链上往后挪一位"
                          onClick={() => moveStep(n.nid, 1)}
                          className="rounded-[5px] px-1 py-0.5 text-[12px] hover:bg-[var(--color-surface-2)] disabled:opacity-30"
                          style={{ color: "var(--color-muted)" }}
                        >
                          ↓
                        </button>
                        {/* 在它后面复制一步（同一个助手）：省得再选一次 */}
                        <button
                          type="button"
                          disabled={frozen}
                          title="在它后面复制一步（同一个助手）"
                          onClick={() => {
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
                          className="rounded-[5px] px-1 py-0.5 text-[12px] hover:bg-[var(--color-surface-2)] disabled:opacity-30"
                          style={{ color: "var(--color-muted)" }}
                        >
                          ⧉
                        </button>
                      </>
                    );
                  })()}
                  {/* **删除**（用户要求：这类功能直接放卡片上，不用点右上角 ⋯）。
                      破坏性，所以做成"点两下"：第一下变红并问"确认删除？"（4 秒内有效），
                      第二下才真删 —— 符合"破坏性操作两步确认"的既定规矩。 */}
                  <button
                    type="button"
                    title={delArm === n.nid ? "再点一次就删掉这一步" : "把这一步从流程里去掉"}
                    onClick={() => {
                      if (delArm === n.nid) deleteNode(n.nid);
                      else setDelArm(n.nid);
                    }}
                    className="rounded-[5px] px-1.5 py-0.5 text-[11.5px] font-medium"
                    style={
                      delArm === n.nid
                        ? { background: "var(--color-err)", color: "#fff" }
                        : { color: "var(--color-err)" }
                    }
                  >
                    {delArm === n.nid ? "确认删除？" : "删除"}
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
                {agentOf(n.agent_id)?.definition?.role === "orchestrator" ? (
                  <span
                    className="shrink-0 rounded-full px-1.5 py-[1px] text-[10.5px] font-medium"
                    style={{
                      border: `1px solid ${STEP_STYLE.think.border}`,
                      color: STEP_STYLE.think.color,
                      background: STEP_STYLE.think.bg,
                    }}
                    title="编排者：分析任务 → 管理上下文 → 验证结果 → 归纳总结（适合放在流程首节点或末节点）"
                  >
                    ✦ 编排者
                    {orcMisplaced && (
                      <span
                        className="ml-1 rounded-full px-1 py-0 text-[10px] font-normal"
                        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
                        title="编排者通常放在流程的**最开始**（先分析任务、管好上下文再交下去）或**最后**（收齐产出做验证与归纳）"
                      >
                        建议放首/末
                      </span>
                    )}
                  </span>
                ) : (
                  <span
                    className="shrink-0 rounded-full px-1.5 py-[1px] text-[10.5px]"
                    style={{
                      border: "1px solid var(--color-border)",
                      color: "var(--color-muted)",
                      background: "var(--color-surface)",
                    }}
                    title="这一步用哪个助手（卡片类型：助手卡）"
                  >
                    助手
                  </span>
                )}
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
                {/* **⋯ 按钮已移除**（用户两次要求："不需要点击右上角三个点"）。
                    它原来挂在卡头右侧、还是"鼠标划过才出现"（opacity-0 group-hover:opacity-100），
                    用户划过去它就冒出来 ✗。现在节点动作全部在卡上方的操作条里。 */}
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

                            {/* ⋯ 菜单**整体移除**（用户两次要求）。它原来装着 配置这个助手 /
                  换成别的助手 / 上移一位 / 下移一位 / 在它后面复制一步 / 删除这一步 ——
                  现在这些动作**全部**在卡上方的操作条里，就地一点就有。 */}

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
                className="before:absolute before:-inset-4 before:content-[''] absolute top-1/2 right-[-7px] h-[13px] w-[13px] -translate-y-1/2 cursor-crosshair rounded-full border-2"
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
        {/* **「助手设置」浮层已移除** —— 用户质问："为什么在 playground 上还需要让用户配置 agent？"
            画布负责的是**编排流程**（用哪个助手、按什么顺序跑）；助手**本体**
            （模型 / 提示词 / 工具 / 权限 / 工作目录）是 Agents 页的职责。
            在画布上放开这个口子，会让用户以为"跑之前得先把助手配好"✗ ——
            正确路径是"**选一个现成的助手 → 直接跑**"。要改助手本体，去 Agents 页。 */}
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

/** 详情里的一片：**输入 / 思考 / 调用 / 回复** 各一段、各一色。
 *
 *  用户："点击 agent 可以查看执行的详情，input，think，call，response 完整的详情通过不同颜色区分"。
 *  配色复用全站 STEP_STYLE（输入蓝 / 思考紫 / 调用橙 / 工具输出青 / 回复绿 / 出错红），
 *  和 Runs 页、日志里的分色同一套 —— 同一个概念全站同色 ✓ */
/** 压成一行并截断（详情里的小块文字用；超长就截 + 省略号） */
function clip(v: unknown, n: number): string {
  const t = String(v ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 卡片右缘的拖宽把手 —— **节点卡 / 输入卡 / 输出卡共用一套**（行为必须一致）。
 *
 *  两个关键点（都是用户实测踩出来的）：
 *    · 命中区 20px（左右各 10px）+ 可见把手 4px×44px（原来 3px 细线 + 只 7px 在卡内 → 抓不住）
 *    · **touch-action: none** —— 触屏/触控板上不加它，浏览器会把拖拽当滚动并取消 pointer 事件，
 *      表现就是"拖了没反应"（用户反馈："为什么手动拖拽修改不了尺寸"） */
/** 卡片**右下角**的双手柄：宽和高一起调。
 *
 *  与右缘那条分工明确 —— 右缘只改宽（高度默认由内容决定更自然），角落才是"整张卡大小"。
 *  用户要求："卡片的高度也支持调整"。touch-action:none 同样必须有（触屏否则拖不动）。 */
function ResizeCorner({ id, active, onDown }: { id: string; active: boolean; onDown: (e: React.PointerEvent) => void }) {
  return (
    <div
      data-node-resize-corner={id}
      onPointerDown={onDown}
      onClick={(e) => e.stopPropagation()}
      title="拖动我，调整这张卡的宽和高"
      className="group/corner absolute z-30"
      style={{ right: -8, bottom: -8, width: 24, height: 24, cursor: "nwse-resize", touchAction: "none" }}
    >
      <span
        className="absolute transition-opacity group-hover/corner:opacity-100"
        style={{
          right: 10,
          bottom: 10,
          width: 9,
          height: 9,
          borderRight: `2px solid ${active ? "var(--color-accent)" : "var(--color-muted)"}`,
          borderBottom: `2px solid ${active ? "var(--color-accent)" : "var(--color-muted)"}`,
          borderBottomRightRadius: 3,
          opacity: active ? 1 : 0.55,
        }}
      />
    </div>
  );
}

function ResizeGrip({ id, active, onDown }: { id: string; active: boolean; onDown: (e: React.PointerEvent) => void }) {
  return (
    <div
      data-node-resize={id}
      onPointerDown={onDown}
      onClick={(e) => e.stopPropagation()}
      title="拖动我，调整这张卡的宽度"
      className="group/resize absolute top-0 z-30 flex h-full cursor-col-resize items-center justify-center"
      style={{ right: -10, width: 20, touchAction: "none" }}
    >
      <span
        className="rounded-full transition-opacity group-hover/resize:opacity-100"
        style={{
          width: 4,
          height: 44,
          opacity: active ? 1 : 0.55,
          background: active
            ? "var(--color-accent)"
            : "color-mix(in srgb, var(--color-border) 55%, var(--color-muted))",
        }}
      />
    </div>
  );
}

function DetailSection({ kind, label, children }: { kind: StepKind; label: string; children: React.ReactNode }) {
  const st = STEP_STYLE[kind];
  return (
    <div className="rounded-[8px] border" style={{ borderColor: st.border, background: st.bg }}>
      <div className="flex items-center gap-1.5 px-2 py-[3px] text-[11px] font-semibold" style={{ color: st.color }}>
        <span className="text-[10px] leading-none">{st.icon}</span>
        {label}
      </div>
      <div className="px-2 pb-[6px] text-[11.5px] leading-[1.65]" style={{ color: "var(--color-text)" }}>
        {children}
      </div>
    </div>
  );
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
