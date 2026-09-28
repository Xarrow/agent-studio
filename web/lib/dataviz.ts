/**
 * 结果渲染的解析与布局内核（零依赖，纯函数 —— 便于 node --test 直接守）。
 *
 * 为什么把"逻辑"从组件里抽出来
 * --------------------------
 * 渲染这件事最容易在**边界上**出错：CSV 里的引号与换行、图表数据少一列、
 * diff 的 `\ No newline` 行……这些都不是"画"的问题，是"读"的问题。
 * 抽成纯函数就能用测试把边界钉住，组件那边只管把结果摆出来。
 *
 * 覆盖：
 *   · parseDelimited —— CSV/TSV（带引号转义、引号内换行）
 *   · parseChartSpec —— ```chart 的数据（柱/折线/饼，labels + series）
 *   · layoutChart    —— 把数据算成几何（坐标/矩形/扇区），组件照着画 SVG
 *   · parseJsonTree  —— ```json 的可折叠树（深度/类型/子节点数）
 *   · parseDiff      —— ```diff 的逐行类型（增/删/上下文/元信息）
 */

/** 允许的图表类型（认不出的按折线处理前先退回源码，见 parseChartSpec） */
export type ChartKind = "bar" | "line" | "pie";

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartSpec {
  kind: ChartKind;
  labels: string[];
  series: ChartSeries[];
  /** 轴标题（可选） */
  xLabel?: string;
  yLabel?: string;
}

// --------------------------------------------------------------------------- //
// 分隔符文本 → 表格
// --------------------------------------------------------------------------- //
export interface ParsedTable {
  header: string[];
  rows: string[][];
}

/**
 * 解析 CSV/TSV。支持双引号包裹、`""` 转义、引号内换行 —— 这三条不处理的话，
 * 模型给的"带逗号的字段"会把表格列数搞乱（一眼就看出错行）。
 */
export function parseDelimited(text: string, delimiter = ","): ParsedTable | null {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const clean = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (clean.length === 0) return null;
  const header = clean[0].map((c) => c.trim());
  const body = clean.slice(1).map((r) => {
    // 列数不齐时补齐/截断到表头长度：宁可留空，也不要错列
    const out = r.slice(0, header.length);
    while (out.length < header.length) out.push("");
    return out;
  });
  return { header, rows: body };
}

// --------------------------------------------------------------------------- //
// chart 数据
// --------------------------------------------------------------------------- //
function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[,%\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 读 ```chart 里的 JSON。认不出的形状返回 null（**整块退回源码**，
 * 宁可让用户看到数据，也不要画一张错的图）。
 *
 * 接受两种常见写法：
 *   { type: "bar", labels: [...], series: [{ name, values: [...] }] }
 *   { type: "bar", labels: [...], values: [...] }        // 单序列简写
 */
export function parseChartSpec(text: string): ChartSpec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const kindRaw = String(obj.type ?? obj.kind ?? "bar").toLowerCase();
  const kind: ChartKind =
    kindRaw === "pie" ? "pie" : kindRaw === "line" || kindRaw === "area" ? "line" : "bar";

  const labels = Array.isArray(obj.labels)
    ? (obj.labels as unknown[]).map((l) => String(l))
    : [];

  const series: ChartSeries[] = [];
  if (Array.isArray(obj.series)) {
    for (const s of obj.series as unknown[]) {
      if (!s || typeof s !== "object") continue;
      const so = s as Record<string, unknown>;
      const values = Array.isArray(so.values) ? (so.values as unknown[]).map(toNumber) : [];
      if (values.length === 0 || values.some((v) => v === null)) continue;
      series.push({
        name: String(so.name ?? `系列 ${series.length + 1}`),
        values: values as number[],
      });
    }
  } else if (Array.isArray(obj.values) || Array.isArray(obj.data)) {
    const src = (Array.isArray(obj.values) ? obj.values : obj.data) as unknown[];
    const values = src.map(toNumber);
    if (values.length && !values.some((v) => v === null)) {
      series.push({ name: String(obj.name ?? "数值"), values: values as number[] });
    }
  }
  if (series.length === 0 || labels.length === 0) return null;

  const n = labels.length;
  // 序列长度与标签数不一致 → 认不出（否则会错位，画出来是假的）
  if (series.some((s) => s.values.length !== n)) return null;

  return {
    kind,
    labels,
    series,
    xLabel: typeof obj.xLabel === "string" ? obj.xLabel : undefined,
    yLabel: typeof obj.yLabel === "string" ? obj.yLabel : undefined,
  };
}

// --------------------------------------------------------------------------- //
// 图表几何布局（纯计算，返回 SVG 要用的数字）
// --------------------------------------------------------------------------- //
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 取自哪条序列 / 哪一项，供 hover/无障碍用 */
  series: number;
  index: number;
  value: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface LinePath {
  series: number;
  points: Point[];
}

export interface Slice {
  series: number;
  index: number;
  value: number;
  /** 扇区路径的起点/终点角度（弧度） */
  a0: number;
  a1: number;
}

export interface ChartLayout {
  plot: Rect;
  /** Y 轴刻度（值 + 画布 y） */
  yTicks: { value: number; y: number }[];
  bars: Rect[];
  lines: LinePath[];
  slices: Slice[];
  /** 数值区间，图例/轴线文案用 */
  min: number;
  max: number;
}

/**
 * 把 spec 算成几何。**不引入任何图表库**：柱是矩形、折线是折点、饼是扇区，
 * 都是几十行三角函数的事，却省掉一个几百 KB 的依赖。
 */
export function layoutChart(
  spec: ChartSpec,
  width: number,
  height: number,
  padding = { top: 12, right: 12, bottom: 26, left: 40 },
): ChartLayout {
  const plot: Rect = {
    x: padding.left,
    y: padding.top,
    w: Math.max(10, width - padding.left - padding.right),
    h: Math.max(10, height - padding.top - padding.bottom),
    series: -1,
    index: -1,
    value: 0,
  };

  const all = spec.series.flatMap((s) => s.values);
  const min = Math.min(0, ...all);
  const max = Math.max(1, ...all);
  const span = max - min || 1;

  const yOf = (v: number) => plot.y + plot.h - ((v - min) / span) * plot.h;

  const ticks = 4;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => {
    const value = min + (span * i) / ticks;
    return { value, y: yOf(value) };
  });

  const bars: Rect[] = [];
  const lines: LinePath[] = [];
  const slices: Slice[] = [];

  if (spec.kind === "pie") {
    // 饼图：只画第一条序列（多序列饼图本身是坏设计，取其首条并如实只画它）
    const values = spec.series[0]?.values ?? [];
    const total = values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    let angle = -Math.PI / 2;
    values.forEach((v, index) => {
      const sweep = (Math.max(0, v) / total) * Math.PI * 2;
      slices.push({ series: 0, index, value: v, a0: angle, a1: angle + sweep });
      angle += sweep;
    });
    return { plot, yTicks: [], bars, lines, slices, min, max };
  }

  const n = spec.labels.length;
  const groupW = plot.w / Math.max(1, n);
  const seriesCount = spec.series.length;
  const barW = Math.max(2, (groupW * 0.7) / seriesCount);

  spec.series.forEach((s, si) => {
    const points: Point[] = [];
    s.values.forEach((v, i) => {
      const cx = plot.x + groupW * i + groupW / 2;
      if (spec.kind === "bar") {
        const y = yOf(v);
        const zero = yOf(Math.max(min, 0));
        bars.push({
          x: cx - (barW * seriesCount) / 2 + barW * si,
          y: Math.min(y, zero),
          w: barW,
          h: Math.max(1, Math.abs(zero - y)),
          series: si,
          index: i,
          value: v,
        });
      } else {
        points.push({ x: cx, y: yOf(v) });
      }
    });
    if (points.length) lines.push({ series: si, points });
  });

  return { plot, yTicks, bars, lines, slices, min, max };
}

// --------------------------------------------------------------------------- //
// JSON 树
// --------------------------------------------------------------------------- //
export interface JsonNode {
  key: string;
  /** 值的类型标签（object/array/string/number/boolean/null） */
  kind: string;
  /** 叶子的展示文本；容器为空 */
  text: string;
  children: JsonNode[];
  /** 容器是否可折叠（空对象/空数组不折叠） */
  collapsible: boolean;
}

function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function leafText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return String(v);
}

/**
 * 把 JSON 文本转成可折叠树。**解析失败返回 null**（调用方退回源码显示）——
 * 和 mermaid 一个口径：宁可显示原文，也不要显示半截或错的解析结果。
 */
export function parseJsonTree(text: string, maxNodes = 4000): JsonNode | null {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return null;
  }
  let count = 0;
  const build = (v: unknown, key: string): JsonNode => {
    count++;
    const kind = kindOf(v);
    if (kind === "object") {
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj);
      const children =
        count > maxNodes ? [] : keys.map((k) => build(obj[k], k));
      return { key, kind, text: `{${keys.length}}`, children, collapsible: keys.length > 0 };
    }
    if (kind === "array") {
      const arr = v as unknown[];
      const children = count > maxNodes ? [] : arr.map((item, i) => build(item, String(i)));
      return { key, kind, text: `[${arr.length}]`, children, collapsible: arr.length > 0 };
    }
    return { key, kind, text: leafText(v), children: [], collapsible: false };
  };
  return build(value, "$");
}

// --------------------------------------------------------------------------- //
// diff
// --------------------------------------------------------------------------- //
export type DiffLineType = "add" | "del" | "ctx" | "meta" | "hunk";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/** 逐行判类型。`+++`/`---` 是文件头（meta），`@@` 是 hunk 头 —— 都不能当增删行。 */
export function parseDiff(text: string): DiffLine[] {
  return text.split(/\r?\n/).map((line) => {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
      return { type: "meta" as DiffLineType, text: line };
    }
    if (line.startsWith("@@")) return { type: "hunk" as DiffLineType, text: line };
    if (line.startsWith("+")) return { type: "add" as DiffLineType, text: line };
    if (line.startsWith("-")) return { type: "del" as DiffLineType, text: line };
    return { type: "ctx" as DiffLineType, text: line };
  });
}
