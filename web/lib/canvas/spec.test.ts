/**
 * 护栏：spec（五种形状）→ 画布图。
 *
 * 这条最值得钉 —— 老代码只认 `spec.nodes`，于是 **single/serial/parallel/master_worker
 * 的历史执行回放时画布是空的**（用户原话：回放一片空白）。后来加了统一还原才修好，
 * 但一直没测试；现在五种形状各一条。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { specToGraph } from "./spec.ts";

test("dag：spec 本身就是图，原样还原", () => {
  const g = specToGraph({
    mode: "dag",
    nodes: [
      { nid: "n1", agent_id: "ag1" },
      { nid: "n2", agent_id: "ag2" },
    ],
    edges: [{ from: "n1", to: "n2" }],
  });
  assert.equal(g?.nodes.length, 2);
  assert.equal(g?.edges.length, 1);
  assert.equal(g?.edges[0].from, "n1");
});

test("single：一步、没有连线", () => {
  const g = specToGraph({ mode: "single", steps: [{ agent_id: "ag1" }] });
  assert.equal(g?.nodes.length, 1);
  assert.deepEqual(g?.edges, []);
  assert.equal(g?.nodes[0].agent_id, "ag1");
});

test("serial：一列，边标 serial（构成依赖）", () => {
  const g = specToGraph({
    mode: "serial",
    steps: [{ agent_id: "ag1" }, { agent_id: "ag2" }, { agent_id: "ag3" }],
  });
  assert.equal(g?.nodes.length, 3);
  assert.equal(g?.edges.length, 2);
  assert.ok(g?.edges.every((x) => x.order === "serial"));
});

test("parallel：一列但边标 parallel（**不构成依赖**）", () => {
  const g = specToGraph({ mode: "parallel", steps: [{ agent_id: "ag1" }, { agent_id: "ag2" }] });
  assert.equal(g?.nodes.length, 2);
  assert.ok(g?.edges.every((x) => x.order === "parallel"));
});

test("master_worker：主控在第一位、扇形发散，worker_mode 决定串/并行", () => {
  const par = specToGraph({
    mode: "master_worker",
    master_agent_id: "agm",
    worker_mode: "parallel",
    steps: [{ agent_id: "ag1" }, { agent_id: "ag2" }],
  });
  assert.equal(par?.nodes.length, 3);
  assert.equal(par?.nodes[0].agent_id, "agm");
  assert.equal(par?.master_nid, par?.nodes[0].nid, "主控节点要标出来（界面据此显示角色）");
  assert.ok(par?.edges.every((x) => x.from === par.nodes[0].nid && x.order === "parallel"));

  const ser = specToGraph({
    mode: "master_worker",
    master_agent_id: "agm",
    worker_mode: "serial",
    steps: [{ agent_id: "ag1" }, { agent_id: "ag2" }],
  });
  assert.ok(ser?.edges.every((x) => x.order === "serial"));
});

test("空 spec / 没有步骤 → 不硬造一张空图（返回 null，界面据此显示空态）", () => {
  assert.equal(specToGraph(null), null);
  assert.equal(specToGraph(undefined), null);
  assert.equal(specToGraph({ mode: "serial", steps: [] }), null);
});
