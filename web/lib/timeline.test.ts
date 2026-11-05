/**
 * 时间线排布纯函数测试。
 *
 * 钉住的是**几何正确**：条的左偏移和宽度必须能反推回真实时间，
 * 否则"这一步为什么慢"会被画歪——比不画更糟。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  depthOf,
  digest,
  fmtSeconds,
  fmtTokens,
  headline,
  labelOf,
  layout,
  type TimelineData,
  type TimelineItem,
} from "./timeline.ts";

const item = (over: Partial<TimelineItem>): TimelineItem => ({
  id: "t0",
  kind: "llm",
  name: "",
  started_at: 1000,
  ended_at: 2000,
  duration_ms: 1000,
  parent_id: null,
  attributes: {},
  ...over,
});

test("层级：轮次在 0，思考/工具/等待挂 1，认不出的父级不报错", () => {
  const items = [
    item({ id: "t0" }),
    item({ id: "t1", kind: "think", parent_id: "t0" }),
    item({ id: "t2", kind: "tool", parent_id: "t0" }),
    item({ id: "t3", kind: "tool", parent_id: "missing" }),
  ];
  const d = depthOf(items);
  assert.equal(d.get("t0"), 0);
  assert.equal(d.get("t1"), 1);
  assert.equal(d.get("t3"), 0);
});

test("排布：左偏移与宽度按总时长归一，短条有保底", () => {
  const data: TimelineData = {
    items: [item({ id: "t0", started_at: 1000, duration_ms: 10000, ended_at: 11000 })],
    started_at: 1000,
    ended_at: 21000,
    total_ms: 20000,
    slowest: null,
  };
  data.items.push(item({ id: "t1", kind: "tool", started_at: 15000, duration_ms: 100, ended_at: 15100, parent_id: "t0" }));
  const rows = layout(data);
  assert.equal(rows[0].left, 0);
  assert.equal(rows[0].width, 50);            // 10s / 20s
  assert.equal(rows[1].left, 70);             // 从 15s 起
  assert.ok(rows[1].width >= 0.5, "100ms 的条也要看得见");
});

test("摘要：每类都给一句能判断的话", () => {
  assert.match(
    digest(item({ kind: "llm", attributes: { model: "deepseek-flash", tokens_in: 1200, tokens_out: 90, ttft_ms: 800 } })),
    /deepseek-flash.*1\.2k → 90.*首字 800ms/,
  );
  assert.equal(digest(item({ kind: "think", attributes: { chars: 1200 } })), "1.2k 字");
  assert.equal(digest(item({ kind: "hid", attributes: {} })), "");
  assert.match(digest(item({ kind: "hitl", attributes: { decision: "允许", waited_ms: 3800 } })), /允许.*3\.8s/);
  assert.match(digest(item({ kind: "tool", attributes: { status: "error", args_preview: '{"url":"x"}' } })), /失败/);
});

test("时间格式：毫秒 / 秒 / 分钟", () => {
  assert.equal(fmtSeconds(120), "120ms");
  assert.equal(fmtSeconds(1240), "1.2s");
  assert.equal(fmtSeconds(12_400), "12s");
  assert.equal(fmtSeconds(83_000), "1:23");
  assert.equal(fmtTokens(0), "0");
  assert.equal(fmtTokens(1200), "1.2k");
  assert.equal(fmtTokens(1_500_000), "1.5M");
});

test("标题句：总耗时 + 最慢 + 等你点了多久", () => {
  const data: TimelineData = {
    items: [
      item({ id: "t0", started_at: 0, duration_ms: 1000, ended_at: 1000 }),
      item({ id: "t1", kind: "hitl", started_at: 1000, duration_ms: 38000, ended_at: 39000, attributes: { tool: "Write" } }),
    ],
    started_at: 0,
    ended_at: 39000,
    total_ms: 39000,
    slowest: item({ id: "t1", kind: "hitl", duration_ms: 38000, name: "等你确认 · Write" }),
  };
  const line = headline(data);
  assert.match(line, /总 39s/);
  assert.match(line, /最慢：等你确认 · Write 38s（97%）/);
  assert.match(line, /其中等你点 38s/);
});

test("轮次标题带模型名", () => {
  assert.equal(
    labelOf(item({ kind: "llm", attributes: { iteration: 3, model: "deepseek-v4-pro" } })),
    "第 3 轮 · deepseek-v4-pro",
  );
  assert.equal(labelOf(item({ kind: "tool", name: "fetch" })), "fetch");
});
