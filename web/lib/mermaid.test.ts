/**
 * Mermaid 子集渲染护栏测试（node --test，零依赖）
 *
 * 图表最怕的是"画出来不能看"：节点叠在一起、图被裁掉一半、连线指向不存在的
 * 节点。这些不该靠人眼抽查，交给测试守：
 *   ① 认不出的语法必须**整块退回**（返回 null → 调用方展示源码），
 *      宁可显示代码，也不要画出错的图；
 *   ② 节点之间不重叠；
 *   ③ 所有节点与边标签都落在 viewBox 内（宁可画布放大，也不裁切）；
 *   ④ 边的两端必须是已声明的节点。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { layoutMermaid, parseMermaid } from "./mermaid.ts";

const SAMPLE = `flowchart TD
  A[开始] --> B{判断有缓存?}
  B -->|命中| C[返回缓存]
  B -->|没有| D[查数据库]
  D --> E[写入缓存]
  C --> F([结束])
  E --> F`;

test("解析：节点/形状/边/标签", () => {
  const p = parseMermaid(SAMPLE);
  assert.ok(p, "应该解析成功");
  assert.equal(p!.dir, "TD");
  assert.equal(p!.nodes.size, 6);
  assert.equal(p!.nodes.get("B")!.shape, "diamond");
  assert.equal(p!.nodes.get("F")!.shape, "stadium");
  assert.equal(p!.edges.length, 6);
  assert.equal(p!.edges.find((e) => e.label === "命中")!.from, "B");
});

test("解析：认不出的语法返回 null（退回源码展示，不画错图）", () => {
  assert.equal(parseMermaid("这不是图\n随便写点什么"), null);
  // 链式写法（一次写三跳）不支持 —— 必须整块退回，不能画成"只连了前两跳"
  assert.equal(parseMermaid("flowchart TD\n A[开始]\n A --> B --> C"), null);
  assert.equal(parseMermaid("sequenceDiagram\n A->>B: 你好"), null);
  assert.equal(parseMermaid(""), null);
});

test("解析：LR / graph TB 都认；--- 视为无向边", () => {
  const lr = parseMermaid("flowchart LR\n A-->B");
  assert.equal(lr!.dir, "LR");
  const graph = parseMermaid("graph TB\n A-->B");
  assert.equal(graph!.dir, "TD");
  const undirected = parseMermaid("flowchart TD\n A --- B");
  assert.equal(undirected!.edges[0].arrow, false);
});

test("布局：节点互不重叠", () => {
  const layout = layoutMermaid(parseMermaid(SAMPLE)!);
  const ns = layout.nodes;
  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) {
      const a = ns[i];
      const b = ns[j];
      const overlap = !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
      assert.equal(overlap, false, `${a.id} 与 ${b.id} 重叠了`);
    }
  }
});

test("布局：所有节点与边标签都在画布内（不裁切）", () => {
  for (const src of [SAMPLE, "flowchart LR\n A[很长很长的节点名字用来试宽度] --> B[短]", "flowchart TD\n A-->B\n A-->C\n A-->D"]) {
    const layout = layoutMermaid(parseMermaid(src)!);
    for (const n of layout.nodes) {
      assert.ok(n.x >= 0 && n.y >= 0, `${n.id} 坐标为负`);
      assert.ok(n.x + n.w <= layout.width + 1, `${n.id} 超出画布宽度`);
      assert.ok(n.y + n.h <= layout.height + 1, `${n.id} 超出画布高度`);
    }
    for (const e of layout.edges) {
      if (!e.labelAt) continue;
      assert.ok(e.labelAt.x >= 0 && e.labelAt.x <= layout.width + 1, "边标签横向越界");
      assert.ok(e.labelAt.y >= 0 && e.labelAt.y <= layout.height + 1, "边标签纵向越界");
    }
  }
});

test("布局：节点宽随文字自适应（中文比英文宽）", () => {
  const layout = layoutMermaid(parseMermaid("flowchart TD\n A[这是一个比较长的中文节点] --> B[x]")!);
  const a = layout.nodes.find((n) => n.id === "A")!;
  const b = layout.nodes.find((n) => n.id === "B")!;
  assert.ok(a.w > b.w, "长中文节点应该比单字符节点宽");
});

test("布局：边的两端都是已声明节点（LR 与反向方向也一样）", () => {
  for (const dir of ["TD", "LR", "RL", "BT"]) {
    const layout = layoutMermaid(parseMermaid(`flowchart ${dir}\n A-->B\n B-->C\n A-->C`)!);
    const ids = new Set(layout.nodes.map((n) => n.id));
    for (const e of layout.edges) {
      assert.ok(ids.has(e.from) && ids.has(e.to), `${dir}: 边指向了不存在的节点`);
    }
    assert.equal(layout.nodes.length, 3);
  }
});
