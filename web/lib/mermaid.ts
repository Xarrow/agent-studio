/**
 * Mermaid 子集渲染内核（零依赖）
 * ==============================
 *
 * 为什么要自己写：模型（和用户）随手就会产出 ```mermaid 流程图 —— 直接贴出来是
 * 一堆 `A[开始] --> B{判断}` 源码，等于没展示。引 mermaid.js 是整套依赖（能编译
 * 出 1MB 级产物），与本产品零依赖/自持的取向冲突。
 *
 * 实际会用到的语法就一小撮，只实现这些：
 *   flowchart TD | TB | LR | RL | BT 或 graph TD
 *   A[矩形] A(圆角) A{菱形} A([胶囊]) A((圆))     ← 节点 + 形状
 *   A --> B        A -->|文字| B       A --- B    ← 有向 / 无向边
 *   A -- 文字 --> B                               ← 老写法也认
 *   subgraph ... end  → **忽略分组框**（节点照样画，只在标题上体现）
 *
 * 布局：**自动分层**（不是手写死坐标）
 *   · 按边的方向算层级（TD/TB 自上而下、LR 自左而右、RL/BT 反向）；
 *   · 层内按出现顺序排，节点宽度按文字自适应（中文按 2 个字宽算）；
 *   · 同层节点在**交叉方向居中**，整体 viewBox 由内容算出（+ 内边距），
 *     保证不裁切（用户明确要求过：宁可把画布放大，也不能切掉内容）。
 *
 * 认不出的语法：整块退回源码展示（宁可显示代码，也不要画出错的图）。
 */

export type MNode = {
  id: string;
  text: string;
  shape: "rect" | "round" | "diamond" | "stadium" | "circle";
  layer: number;
  /** 布局结果（左上角坐标 + 尺寸），单位 px */
  x: number;
  y: number;
  w: number;
  h: number;
};

export type MEdge = {
  from: string;
  to: string;
  label: string;
  /** 有向 = 画箭头；--- 是无向线 */
  arrow: boolean;
  /** 算出来的折线（两点或三点：绕行时的中点） */
  path: { x: number; y: number }[];
  /** 标签落点（已做避让，可能为空字符串） */
  labelAt: { x: number; y: number } | null;
};

export type MermaidLayout = {
  nodes: MNode[];
  edges: MEdge[];
  width: number;
  height: number;
  /** 布局方向（TD/LR…），调用方画的时候用 */
  dir: "TD" | "LR" | "RL" | "BT";
};

/** 中文字符按两个宽度算 —— 用字符数当宽度会严重低估中文标签 */
function textWidth(s: string, fontSize = 12): number {
  let w = 0;
  for (const ch of s) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return w * (fontSize * 0.56);
}

const NODE_H = 34;
const PAD = 16;
/** 同层同向节点之间的间距 */
const GAP_MAIN = 34;
/** 层与层之间的间距（要留给边标签） */
const GAP_LAYER = 58;

type Parsed = {
  dir: "TD" | "LR" | "RL" | "BT";
  nodes: Map<string, { text: string; shape: MNode["shape"] }>;
  order: string[];
  edges: { from: string; to: string; label: string; arrow: boolean }[];
};

/** 解析源码；返回 null = 认不出来（调用方退回源码展示） */
export function parseMermaid(src: string): Parsed | null {
  const lines = (src || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("%%")); // %% 是注释

  if (lines.length === 0) return null;

  const head = /^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/i.exec(lines[0]);
  if (!head) return null;
  const raw = head[1].toUpperCase();
  const dir: Parsed["dir"] = raw === "TB" ? "TD" : (raw as Parsed["dir"]);

  const nodes = new Map<string, { text: string; shape: MNode["shape"] }>();
  const order: string[] = [];
  const edges: Parsed["edges"] = [];

  const SHAPES: { re: RegExp; shape: MNode["shape"] }[] = [
    { re: /^\(\(([\s\S]*)\)\)$/, shape: "circle" },
    { re: /^\(\[([\s\S]*)\]\)$/, shape: "stadium" },
    { re: /^\[([\s\S]*)\]$/, shape: "rect" },
    { re: /^\(([\s\S]*)\)$/, shape: "round" },
    { re: /^\{([\s\S]*)\}$/, shape: "diamond" },
  ];

  /** 认一个节点片段：id 或 id[文字] 或 id{文字} … */
  const takeNode = (tok: string): string | null => {
    const m = /^([A-Za-z0-9_\u4e00-\u9fff]+)([\s\S]*)$/.exec(tok.trim());
    if (!m) return null;
    const id = m[1];
    const rest = m[2].trim();
    if (!nodes.has(id)) {
      let text = id;
      let shape: MNode["shape"] = "rect";
      let matched = rest === "";
      for (const s of SHAPES) {
        const mm = s.re.exec(rest);
        if (mm) {
          text = mm[1].replace(/^["']|["']$/g, "").trim() || id;
          shape = s.shape;
          matched = true;
          break;
        }
      }
      // 认不出的尾巴（例如 `A --> B --> C` 里被吞掉的 `--> C`）**不能装作没看见**：
      // 静默丢掉半截会画出一张"看着对、其实少了一步"的图，比退回源码更危险。
      if (!matched) return null;
      nodes.set(id, { text, shape });
      order.push(id);
    }
    return id;
  };

  for (const line of lines.slice(1)) {
    if (/^(subgraph|end|style|classDef|class|linkStyle|click)\b/i.test(line)) continue; // 只关注结构与连线

    // A -->|文字| B   /   A -- 文字 --> B   /   A --> B   /   A --- B
    const em = /^(.+?)\s*(-->|---|-.->|==>)\s*(?:\|([^|]*)\|\s*)?(.+)$/.exec(line);
    if (em) {
      const left = takeNode(em[1]);
      const right = takeNode(em[4]);
      if (!left || !right) return null;
      let label = (em[3] ?? "").trim();
      if (!label) {
        // 老写法：A -- 文字 --> B
        const lm = /--\s*([^-]+?)\s*--/.exec(em[1]);
        if (lm) label = lm[1].trim();
      }
      edges.push({ from: left, to: right, label, arrow: em[2] !== "---" });
      continue;
    }
    // 单独一行的节点声明（A[开始]）
    if (/^[A-Za-z0-9_\u4e00-\u9fff]+\s*[\[\(\{]/.test(line)) {
      if (takeNode(line) === null) return null;
      continue;
    }
    return null; // 有认不出的语句 → 整块退回源码
  }

  if (nodes.size === 0) return null;
  return { dir, nodes, order, edges };
}

/** 分层 + 排布 */
export function layoutMermaid(parsed: Parsed): MermaidLayout {
  const { dir, nodes, order, edges } = parsed;
  const ids = order;
  const idx = new Map(ids.map((id, i) => [id, i]));

  // ── 分层：迭代松弛（最长路径），有环也能收敛（最多跑 N 轮） ────────────
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  const back = new Set(edges.map((e) => `${e.from}->${e.to}`));
  for (let pass = 0; pass < ids.length + 2; pass++) {
    let changed = false;
    for (const e of edges) {
      const want = (layer.get(e.from) ?? 0) + 1;
      if ((layer.get(e.to) ?? 0) < want && want <= ids.length) {
        layer.set(e.to, want);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const byLayer = new Map<number, string[]>();
  for (const id of ids) {
    const L = layer.get(id) ?? 0;
    if (!byLayer.has(L)) byLayer.set(L, []);
    byLayer.get(L)!.push(id);
  }
  const layerKeys = [...byLayer.keys()].sort((a, b) => a - b);

  const vertical = dir === "TD" || dir === "BT"; // 层沿 y 或沿 x 排列
  const reverse = dir === "RL" || dir === "BT";

  // ── 尺寸：文字自适应宽度 ─────────────────────────────────────────────
  const size = new Map<string, { w: number; h: number }>();
  for (const id of ids) {
    const n = nodes.get(id)!;
    const tw = textWidth(n.text, 12) + 26;
    const w = n.shape === "circle" ? Math.max(tw, 44) : Math.max(64, Math.ceil(tw));
    size.set(id, { w, h: n.shape === "diamond" ? NODE_H + 8 : NODE_H });
  }

  // ── 主方向铺层，交叉方向先行排（之后再整体居中） ─────────────────────
  const crossPos = new Map<string, number>(); // 交叉方向上的起点
  const mainPos = new Map<number, number>(); // 主方向上的起点（键=层号）
  let mainCursor = PAD;
  const layerMainSpan = new Map<number, number>();

  for (const L of layerKeys) {
    const members = byLayer.get(L)!;
    let span = 0;
    for (const id of members) {
      const s = size.get(id)!;
      crossPos.set(id, span);
      span += (vertical ? s.w : s.h) + GAP_MAIN;
    }
    span = Math.max(0, span - GAP_MAIN);
    layerMainSpan.set(L, span);
    // 这一层的厚度 = 层内最高/最宽的那个
    let thick = 0;
    for (const id of members) thick = Math.max(thick, vertical ? size.get(id)!.h : size.get(id)!.w);
    mainPos.set(L, mainCursor);
    mainCursor += thick + GAP_LAYER;
  }
  const totalMain = Math.max(PAD, mainCursor - GAP_LAYER + PAD);
  const maxSpan = Math.max(...layerKeys.map((L) => layerMainSpan.get(L) ?? 0), 0);
  const totalCross = maxSpan + PAD * 2;

  // ── 居中 + 反向翻转 ─────────────────────────────────────────────────
  const out: MNode[] = [];
  for (const id of ids) {
    const n = nodes.get(id)!;
    const s = size.get(id)!;
    const L = layer.get(id) ?? 0;
    const span = layerMainSpan.get(L) ?? 0;
    const cross = crossPos.get(id)! + (maxSpan - span) / 2 + PAD;
    const main = mainPos.get(L)!;
    let x: number;
    let y: number;
    if (vertical) {
      x = cross;
      y = main;
    } else {
      x = main;
      y = cross;
    }
    if (reverse) {
      if (vertical) y = totalMain - y - s.h;
      else x = totalMain - x - s.w;
    }
    out.push({ id, text: n.text, shape: n.shape, layer: L, x, y, w: s.w, h: s.h });
  }

  // ── 连边：主轴起终点 + 边标签避让 ────────────────────────────────────
  const byId = new Map(out.map((n) => [n.id, n]));
  const edgeOut: MEdge[] = [];
  const labelBoxes: { x1: number; y1: number; x2: number; y2: number }[] = [];

  for (const e of edges) {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    let path: { x: number; y: number }[];
    if (vertical) {
      const sameLayer = a.layer === b.layer;
      const x1 = a.x + a.w / 2;
      const y1 = (reverse ? a.y : a.y + a.h);
      const x2 = b.x + b.w / 2;
      const y2 = (reverse ? b.y + b.h : b.y);
      if (sameLayer || Math.abs(x1 - x2) > 1) {
        // 斜线：折一下（先竖走一半，再横，再竖），看起来比直线整齐
        const midY = (y1 + y2) / 2;
        path = [
          { x: x1, y: y1 },
          { x: x1, y: midY },
          { x: x2, y: midY },
          { x: x2, y: y2 },
        ];
      } else {
        path = [
          { x: x1, y: y1 },
          { x: x2, y: y2 },
        ];
      }
    } else {
      const sameLayer = a.layer === b.layer;
      const y1 = a.y + a.h / 2;
      const x1 = (reverse ? a.x : a.x + a.w);
      const y2 = b.y + b.h / 2;
      const x2 = (reverse ? b.x + b.w : b.x);
      if (sameLayer || Math.abs(y1 - y2) > 1) {
        const midX = (x1 + x2) / 2;
        path = [
          { x: x1, y: y1 },
          { x: midX, y: y1 },
          { x: midX, y: y2 },
          { x: x2, y: y2 },
        ];
      } else {
        path = [
          { x: x1, y: y1 },
          { x: x2, y: y2 },
        ];
      }
    }

    // 标签：放在折线中点，并做碰撞避让（避开其他标签 + 节点）
    let labelAt: { x: number; y: number } | null = null;
    if (e.label) {
      const mid = path[Math.floor(path.length / 2)];
      const w = textWidth(e.label, 11) + 10;
      const h = 16;
      const cands = [
        { x: mid.x, y: mid.y - h / 2 - 2 },
        { x: mid.x + 12, y: mid.y - h / 2 - 2 },
        { x: mid.x - 12, y: mid.y - h / 2 - 2 },
        { x: mid.x, y: mid.y + h / 2 + 4 },
      ];
      for (const c of cands) {
        const box = { x1: c.x - w / 2, y1: c.y, x2: c.x + w / 2, y2: c.y + h };
        const hitLabel = labelBoxes.some(
          (b) => !(box.x2 < b.x1 || box.x1 > b.x2 || box.y2 < b.y1 || box.y1 > b.y2),
        );
        const hitNode = out.some(
          (n) => !(box.x2 < n.x || box.x1 > n.x + n.w || box.y2 < n.y || box.y1 > n.y + n.h),
        );
        if (!hitLabel && !hitNode) {
          labelBoxes.push(box);
          labelAt = { x: c.x, y: c.y + h / 2 };
          break;
        }
      }
      if (!labelAt) {
        labelAt = { x: mid.x, y: mid.y };
        const w2 = textWidth(e.label, 11) + 10;
        labelBoxes.push({ x1: mid.x - w2 / 2, y1: mid.y - 8, x2: mid.x + w2 / 2, y2: mid.y + 8 });
      }
    }
    edgeOut.push({ from: e.from, to: e.to, label: e.label, arrow: e.arrow, path, labelAt });
  }

  // ── 最终画布：包住所有节点与标签（宁可放大，不裁切） ──────────────────
  let w = totalCross;
  let h = totalMain;
  for (const n of out) {
    w = Math.max(w, n.x + n.w + PAD);
    h = Math.max(h, n.y + n.h + PAD);
  }
  for (const b of labelBoxes) {
    w = Math.max(w, b.x2 + PAD);
    h = Math.max(h, b.y2 + PAD);
  }

  return { nodes: out, edges: edgeOut, width: Math.ceil(w), height: Math.ceil(h), dir };
}
