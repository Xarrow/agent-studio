/**
 * 一边编排一边读：这一轮"派了几件、几件在干、收口没有"必须算对。
 *
 * 界面上这四个数字决定用户对整轮的判断（是不是卡住了、是不是做完了），
 * 算错的代价比样式错大得多 —— 所以放在纯函数里真跑测试。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { liveHint, secs, statusText, turnStats } from "./turn.ts";
import type { Delegation } from "./types.ts";

function d(patch: Partial<Delegation>): Delegation {
  return {
    run_id: "r1",
    agent_id: "ag_1",
    agent_name: "通用助手",
    agent_domain: "通用执行",
    task: "做事",
    status: "ok",
    started_at: 1000,
    ended_at: 2000,
    output_excerpt: "",
    error: null,
    ...patch,
  } as Delegation;
}

test("三件里两件干完一件在跑：读数说 1 件在干，还没收口", () => {
  const st = turnStats(
    [d({ status: "ok" }), d({ run_id: "r2", status: "ok" }), d({ run_id: "r3", status: "running", ended_at: null })],
    "running",
  );
  assert.equal(st.total, 3);
  assert.equal(st.ok, 2);
  assert.equal(st.running, 1);
  assert.equal(st.failed, 0);
  assert.equal(st.active, true);
  assert.equal(st.phrase, "1 件在干");
  assert.equal(st.closing, "等它收口");
});

test("都回来了 + 父 run 完成：算已收口，且不再算 active", () => {
  const st = turnStats([d({}), d({ run_id: "r2" })], "ok");
  assert.equal(st.running, 0);
  assert.equal(st.active, false);
  assert.equal(st.phrase, "都回来了");
  assert.equal(st.closing, "已收口");
});

test("有失败的：失败数不能并进完成里（否则进度条骗人）", () => {
  const st = turnStats([d({}), d({ run_id: "r2", status: "error" })], "ok");
  assert.equal(st.ok, 1);
  assert.equal(st.failed, 1);
  assert.equal(st.running, 0);
});

test("父 run 出错：即使都回来了也是收口出错", () => {
  assert.equal(turnStats([d({})], "error").closing, "收口时出错");
});

test("一件都没派：说清楚，别显示已收口", () => {
  const st = turnStats([], "ok");
  assert.equal(st.total, 0);
  assert.equal(st.phrase, "还没派活");
});

test("当前在干嘛：跳过回答段，取最后一个思考/工具/结果", () => {
  const hint = liveHint([
    { kind: "think", label: "思考", body: "先查一下" },
    { kind: "tool", label: "调用工具", body: "web_search" },
    { kind: "output", label: "回答", body: "最终答案" },
  ]);
  assert.match(hint, /调用工具/);
  assert.ok(!hint.includes("最终答案"));
});

test("状态与耗时：秒/分档都要能读", () => {
  assert.equal(statusText("ok"), "做完了");
  assert.equal(statusText("running"), "在干");
  assert.equal(statusText("error"), "失败了");
  assert.equal(secs(0, 3000), "3s");
  assert.equal(secs(0, 65_000), "1m5s");
});

test("同一个助手永远同一个颜色，不同助手要分得开", async () => {
  const { agentColor } = await import("./turn.ts");
  assert.equal(agentColor("ag_abc"), agentColor("ag_abc"));
  assert.match(agentColor("ag_abc"), /^#[0-9a-f]{6}$/);
  // 调色板真的被用上：一批 id 至少能分出两种颜色
  const set = new Set(["ag_1", "ag_2", "ag_3", "ag_4", "ag_5", "ag_6", "ag_7"].map((x) => agentColor(x)));
  assert.ok(set.size >= 2, `只有一种颜色：${[...set]}`);
  assert.equal(agentColor(null), "#64748b");
});

test("按票归组：同票的几件归一起，顺序不乱", async () => {
  const { groupByTicket, needsTree } = await import("./turn.ts");
  const gs = groupByTicket([
    d({ run_id: "r1", ticket_id: "tk_1", ticket_title: "查天气" }),
    d({ run_id: "r2", ticket_id: "tk_1", ticket_title: "查天气" }),
    d({ run_id: "r3", ticket_id: "tk_2", ticket_title: "写周报" }),
  ]);
  assert.equal(gs.length, 2);
  assert.equal(gs[0].ticketId, "tk_1");
  assert.equal(gs[0].runs.length, 2);
  assert.equal(gs[1].title, "写周报");
  assert.equal(needsTree(gs), true);
  // 一票一件：不画树
  assert.equal(needsTree(groupByTicket([d({ ticket_id: "tk_9" })])), false);
});
