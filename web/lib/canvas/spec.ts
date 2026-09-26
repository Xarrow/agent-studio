/**
 * spec（五种形状）→ 画布图的还原。
 *
 * 为什么必须统一：后端的执行 spec 有五种形状（single / serial / parallel /
 * dag / master_worker），但**只有 dag 那种带 nodes** —— 老代码只认 `spec.nodes`，
 * 于是 single/serial/parallel/master_worker 的历史执行回放时**画布是空的**
 * （从 Runs 进来是一片空白；从流程管理进来还会把状态贴到别的节点上）。
 * 现在两条入口都从这里还原，效果一致。
 *
 * 从 PlaygroundConsole.tsx 搬出来，配 spec.test.ts 钉住五种形状。
 */

import type { EdgeOrder, WorkflowEdge, WorkflowGraph, WorkflowNode } from "@/lib/types";

/**
 * 把编排里**冻结的 spec** 还原成画布上的图 —— 历史回放要用它。
 *
 * 为什么必须还原（用户反馈："流程管理 和 runs 里 workflow 在 playground 回放效果不一致"）
 * ------------------------------------------------------------------
 * spec 由后端 `graph_to_spec` 生成，有 **5 种形状**：
 *   single / serial / parallel  → {"mode":…, "steps":[{agent_id, carry_prev}], "task":…}
 *   dag                         → {"mode":"dag", "nodes":[…], "edges":[…], "task":…}
 *   master_worker               → {"mode":"master_worker", "master_agent_id":…, "steps":[…]}
 * 但这里以前只认 `spec.nodes` ✗ —— 也就是**只有 dag 那种才带 nodes**，
 * 于是 single/serial/parallel/master_worker 的历史执行回放时**画布是空的** ✗：
 *   · 从 Runs 进来（整页跳转）→ 画布空 = 什么都看不到
 *   · 从流程管理进来（就地）→ 画布上还留着**用户正在编的那张图**，
 *     于是那次执行的状态被按 agent_id 贴到了别的节点上 —— 两边看起来完全不同 ✗
 * 现在两条入口都从同一份 spec 还原，效果就完全一致了。
 */
export function specToGraph(spec: {
  mode?: string;
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
  steps?: { agent_id: string; carry_prev?: boolean }[];
  master_agent_id?: string;
  worker_mode?: string;
} | null | undefined): WorkflowGraph | null {
  if (!spec) return null;

  // ① dag：spec 本身就是一张图，直接用
  if (spec.nodes?.length) {
    return { nodes: spec.nodes, edges: spec.edges ?? [], master_nid: null };
  }

  const steps = spec.steps ?? [];
  if (!steps.length) return null;
  const node = (i: number, agent_id: string): WorkflowNode => ({ nid: `n${i + 1}`, agent_id });

  // ② 主从：第 1 个节点是主控，其余是干活的（连线从主控发散）
  if (spec.mode === "master_worker" && spec.master_agent_id) {
    const nodes = [node(0, spec.master_agent_id), ...steps.map((s, i) => node(i + 1, s.agent_id))];
    const order: EdgeOrder = (spec.worker_mode ?? "parallel") === "parallel" ? "parallel" : "serial";
    const edges: WorkflowEdge[] = nodes.slice(1).map((w) => ({ from: nodes[0].nid, to: w.nid, order }));
    return { nodes, edges, master_nid: nodes[0].nid };
  }

  // ③ 单/串/并行：按 steps 的顺序排一列；串行是接力，并行标注成 parallel（不算依赖）
  const nodes = steps.map((s, i) => node(i, s.agent_id));
  if (nodes.length < 2) return { nodes, edges: [], master_nid: null };
  const order: EdgeOrder = spec.mode === "parallel" ? "parallel" : "serial";
  const edges: WorkflowEdge[] = nodes.slice(1).map((n, i) => ({ from: nodes[i].nid, to: n.nid, order }));
  return { nodes, edges, master_nid: null };
}
