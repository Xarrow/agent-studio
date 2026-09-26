/**
 * 护栏：编排语义（哪些线算依赖、怎么分层、谁是主控）。
 *
 * 为什么值得钉：这几条规则**同时决定**后端怎么跑和画布怎么画。写错了不会报错，
 * 只会"界面上写着并行、实际串着跑"或者"最后一层的步骤被排到第一层" ——
 * 这类问题用户一眼看出来，但不写测试就得靠人肉回忆。
 *
 * 与后端编排的语义必须一致：**只有串行线构成依赖**。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  depEdges,
  detectMaster,
  edgeOrder,
  flattenLayers,
  isDep,
  sharesContext,
  sharesMemory,
  topoLayers,
} from "./graph.ts";

import type { WorkflowEdge, WorkflowNode } from "@/lib/types";

const n = (nid: string): WorkflowNode => ({ nid, agent_id: `ag_${nid}` });
const e = (from: string, to: string, extra: Partial<WorkflowEdge> = {}): WorkflowEdge => ({
  from,
  to,
  ...extra,
});

test("只有串行线构成依赖（并行线不算 —— 否则界面上并行、实际串着跑）", () => {
  assert.equal(isDep(e("a", "b")), true, "默认（没写 order）按串行算");
  assert.equal(isDep(e("a", "b", { order: "serial" })), true);
  assert.equal(isDep(e("a", "b", { order: "parallel" })), false);
  assert.equal(isDep(e("a", "b", { rel: "parallel" })), false, "旧数据的 rel 字段也要认");
  assert.equal(edgeOrder(e("a", "b", { order: "parallel" })), "parallel");
  assert.equal(edgeOrder(e("a", "b")), "serial");
});

test("并行与共享上下文/记忆是**正交**的（可任意组合，不是互斥枚举）", () => {
  // 用户明确纠正过：这是两个独立的维度
  const parallelShared = e("a", "b", { order: "parallel", share_context: true });
  assert.equal(edgeOrder(parallelShared), "parallel");
  assert.equal(sharesContext(parallelShared), true);
  assert.equal(isDep(parallelShared), false, "共享上下文不会让并行线变成依赖");

  const serialNotShared = e("a", "b", { order: "serial", share_memory: false });
  assert.equal(isDep(serialNotShared), true);
  assert.equal(sharesMemory(serialNotShared), false);
});

test("串行三步 → 三层；并行两步 → 同一层（同时开始）", () => {
  const serial = [n("a"), n("b"), n("c")];
  const layers = topoLayers(serial, [e("a", "b"), e("b", "c")]);
  assert.deepEqual(layers, [["a"], ["b"], ["c"]]);

  const par = topoLayers([n("a"), n("b"), n("c")], [e("a", "b", { order: "parallel" }), e("a", "c", { order: "parallel" })]);
  assert.deepEqual(par, [["a", "b", "c"]], "并行线不产生层级 —— 它们同时开始");
  assert.deepEqual(flattenLayers(serial, [e("a", "b"), e("b", "c")]), ["a", "b", "c"]);
});

test("多入边汇入：两条串行线汇到一个节点 → 它在下一层", () => {
  const nodes = [n("a"), n("b"), n("c")];
  const layers = topoLayers(nodes, [e("a", "c"), e("b", "c")]);
  assert.deepEqual(layers, [["a", "b"], ["c"]]);
});

test("只把串行边喂给分层算法（depEdges）", () => {
  const edges = [e("a", "b", { order: "parallel" }), e("b", "c")];
  assert.deepEqual(
    depEdges(edges).map((x) => `${x.from}->${x.to}`),
    ["b->c"],
  );
});

test("主控识别：扇出的源头是主；没扇出就取唯一源头", () => {
  const master = [n("m"), n("w1"), n("w2")];
  assert.equal(detectMaster(master, [e("m", "w1", { order: "parallel" }), e("m", "w2", { order: "parallel" })]), "m");
  assert.equal(detectMaster([n("a"), n("b")], [e("a", "b")]), "a", "无扇出 → 唯一源头");
  assert.equal(detectMaster([], []), null);
});

test("有环也不会死循环（分层必须收敛）", () => {
  const layers = topoLayers([n("a"), n("b")], [e("a", "b"), e("b", "a")]);
  assert.equal(layers.flat().length, 2, "环里的节点也要各出现一次");
});
