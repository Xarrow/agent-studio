/**
 * 结构化渲染的护栏（node --test，零依赖）。
 *
 * 这些解析器面对的是**模型产出的文本**，不是我们自己的数据 —— 所以要按
 * "最坏的输入"去守：列数不齐的 CSV、少一列的图、半截 JSON、贴错的 diff。
 * 原则与 mermaid / tex 一致：**认不出就退回源码**，绝不画错图、显示错的表。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  layoutChart,
  parseChartSpec,
  parseDelimited,
  parseDiff,
  parseJsonTree,
} from "./dataviz.ts";

/* ------------------------------- CSV/TSV ------------------------------- */
test("CSV：引号内的逗号不当分隔符", () => {
  const t = parseDelimited('名称,说明\n"甲, 乙",含逗号的字段\n丙,普通');
  assert.ok(t);
  assert.deepEqual(t!.header, ["名称", "说明"]);
  assert.deepEqual(t!.rows[0], ["甲, 乙", "含逗号的字段"]);
  assert.deepEqual(t!.rows[1], ["丙", "普通"]);
});

test("CSV：双引号转义与引号内换行", () => {
  const t = parseDelimited('a,b\n"他说""你好""","第一行\n第二行"');
  assert.deepEqual(t!.rows[0], ['他说"你好"', "第一行\n第二行"]);
});

test("CSV：列数不齐时补空列，不错位", () => {
  const t = parseDelimited("a,b,c\n1,2\n3,4,5,6");
  assert.deepEqual(t!.rows, [["1", "2", ""], ["3", "4", "5"]]);
});

test("TSV 用制表符分隔", () => {
  const t = parseDelimited("x\ty\n1\t2", "\t");
  assert.deepEqual(t!.header, ["x", "y"]);
  assert.deepEqual(t!.rows, [["1", "2"]]);
});

test("空内容返回 null（调用方退回源码）", () => {
  assert.equal(parseDelimited("   \n  "), null);
});

/* -------------------------------- chart -------------------------------- */
test("chart：标准形状（labels + series）", () => {
  const spec = parseChartSpec(JSON.stringify({
    type: "bar",
    labels: ["一月", "二月"],
    series: [{ name: "收入", values: [10, 20] }],
  }));
  assert.ok(spec);
  assert.equal(spec!.kind, "bar");
  assert.equal(spec!.series[0].values[1], 20);
});

test("chart：单序列简写 values:[] 也认；字符串数字要转", () => {
  const spec = parseChartSpec(JSON.stringify({ type: "line", labels: ["a", "b"], values: ["1,200", "3"] }));
  assert.ok(spec);
  assert.equal(spec!.kind, "line");
  assert.deepEqual(spec!.series[0].values, [1200, 3]);
});

test("chart：series 的值写在 data 里也认（Chart.js 那类写法）", () => {
  // 线上实测踩到：模型/用户很自然写 series:[{name,data:[...]}]，
  // 原来只认 values → 静默退回源码（看着像"不支持图表"）。
  const spec = parseChartSpec(
    JSON.stringify({ type: "bar", labels: ["一", "二", "三"], series: [{ name: "耗时", data: [3, 5, 2] }] }),
  );
  assert.ok(spec, "series[].data 是常见写法，不能悄悄退回源码");
  assert.deepEqual(spec!.series[0].values, [3, 5, 2]);
});

test("chart：序列长度与标签数不一致 → 认不出（不能错位画）", () => {
  const spec = parseChartSpec(JSON.stringify({ labels: ["a", "b", "c"], values: [1, 2] }));
  assert.equal(spec, null);
});

test("chart：JSON 坏 / 空数据 → null", () => {
  assert.equal(parseChartSpec("{不是 json"), null);
  assert.equal(parseChartSpec(JSON.stringify({ labels: [], values: [] })), null);
});

test("chart：饼图扇区累积完整 2π，柱状图矩形都在画布内", () => {
  const pie = parseChartSpec(JSON.stringify({ type: "pie", labels: ["甲", "乙", "丙"], values: [1, 1, 2] }))!;
  const pl = layoutChart(pie, 560, 220);
  const total = pl.slices.reduce((s, x) => s + (x.a1 - x.a0), 0);
  assert.ok(Math.abs(total - Math.PI * 2) < 1e-6, "扇区合起来必须正好一整圈");

  const bar = parseChartSpec(JSON.stringify({ type: "bar", labels: ["a", "b"], values: [5, 100] }))!;
  const bl = layoutChart(bar, 560, 200);
  assert.equal(bl.bars.length, 2);
  for (const b of bl.bars) {
    assert.ok(b.x >= bl.plot.x - 1 && b.x + b.w <= bl.plot.x + bl.plot.w + 1, "柱子不能越出绘图区");
    assert.ok(b.h >= 1, "值为 0 也要留 1px，否则那一项像不存在");
  }
  // 最大值贴顶、最小值贴底（比例正确）
  const top = bl.bars.find((b) => b.value === 100)!;
  assert.ok(Math.abs(top.y - (bl.plot.y + bl.plot.h)) < 0.001 || top.y >= bl.plot.y, "最大项应在顶部附近");
});

/* --------------------------------- JSON -------------------------------- */
test("json：解析失败返回 null（退回源码）", () => {
  assert.equal(parseJsonTree("{半截"), null);
});

test("json：类型与子节点数正确、空容器不可折叠", () => {
  const tree = parseJsonTree(JSON.stringify({ a: 1, b: "x", c: [1, 2], d: {}, e: null, f: true }));
  assert.ok(tree);
  const byKey = Object.fromEntries(tree!.children.map((c) => [c.key, c]));
  assert.equal(byKey.a.kind, "number");
  assert.equal(byKey.b.kind, "string");
  assert.equal(byKey.c.kind, "array");
  assert.equal(byKey.c.text, "[2]");
  assert.equal(byKey.c.collapsible, true);
  assert.equal(byKey.d.text, "{0}");
  assert.equal(byKey.d.collapsible, false, "空对象不该给折叠箭头（点了没反应最恼人）");
  assert.equal(byKey.e.kind, "null");
  assert.equal(byKey.f.kind, "boolean");
});

/* --------------------------------- diff -------------------------------- */
test("diff：+++ / --- 是文件头，不算增删行", () => {
  const lines = parseDiff("--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-旧\n+新\n 上下文");
  assert.deepEqual(lines.map((l) => l.type), ["meta", "meta", "hunk", "del", "add", "ctx"]);
});
