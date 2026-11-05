/**
 * 分色测试：稳定、可区分、不抢功能色。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { AGENT_PALETTE, agentColorMap, colorFor } from "./agent-colors.ts";

test("按首次出现顺序发色，重复名字不变色", () => {
  const m = agentColorMap(["甲", "乙", "甲", "丙"]);
  assert.equal(m["甲"], AGENT_PALETTE[0]);
  assert.equal(m["乙"], AGENT_PALETTE[1]);
  assert.equal(m["丙"], AGENT_PALETTE[2]);
  assert.equal(Object.keys(m).length, 3);
});

test("空名字跳过，不会占掉一个颜色", () => {
  const m = agentColorMap(["", "  ", "甲"]);
  assert.equal(m["甲"], AGENT_PALETTE[0]);
  assert.equal(Object.keys(m).length, 1);
});

test("超过调色板长度就循环（认得出是另一个，不追求全局唯一）", () => {
  const names = Array.from({ length: AGENT_PALETTE.length + 2 }, (_, i) => `助手${i}`);
  const m = agentColorMap(names);
  assert.equal(m["助手" + AGENT_PALETTE.length], AGENT_PALETTE[0]);
  assert.equal(m["助手" + (AGENT_PALETTE.length + 1)], AGENT_PALETTE[1]);
});

test("没有登记的名字走 fallback（普通工具保持自己的颜色）", () => {
  const m = agentColorMap(["甲"]);
  assert.equal(colorFor(m, "甲", "#000"), AGENT_PALETTE[0]);
  assert.equal(colorFor(m, "fetch", "#000"), "#000");
  assert.equal(colorFor(m, null, "#000"), "#000");
  assert.equal(colorFor(m, "  甲 ", "#000"), AGENT_PALETTE[0]);
});
