/**
 * 版本差异可读化 —— 纯函数测试（node --test）
 *
 * 钉三件事：
 *  ① 字段路径翻成人话（用户看到的不是 `definition.model.name`）
 *  ② 各种值形态都能显示（空 / 布尔 / 列表 / 对象）
 *  ③ 长文本先截断，别把一屏撑爆
 */

import test from "node:test";
import assert from "node:assert/strict";

import { clip, diffRows, fieldLabel, formatValue } from "./revision-diff.ts";

test("字段路径 → 人话", () => {
  assert.equal(fieldLabel("name"), "名字");
  assert.equal(fieldLabel("definition.system_prompt"), "系统提示词");
  assert.equal(fieldLabel("definition.model.name"), "模型");
  assert.equal(fieldLabel("definition.model.provider"), "服务商");
  assert.equal(fieldLabel("definition.limits.max_iters"), "上限");
  assert.equal(fieldLabel("tool_names"), "工具");
  assert.equal(fieldLabel("skill_names"), "Skill");
  assert.equal(fieldLabel("graph.nodes"), "步骤");
  // 认不出的退回叶子键名，至少能定位
  assert.equal(fieldLabel("definition.weird_field"), "weird_field");
});

test("值 → 文本：空 / 布尔 / 列表 / 对象", () => {
  assert.equal(formatValue(undefined), "（空）");
  assert.equal(formatValue(""), "（空）");
  assert.equal(formatValue(null), "（空）");
  assert.equal(formatValue(true), "开");
  assert.equal(formatValue(0), "0");
  assert.equal(formatValue(["fetch", "Bash"]), "fetch、Bash");
  assert.equal(formatValue([]), "（无）");
  // 工具引用只显示 ref，不糊一坨 JSON
  assert.equal(formatValue([{ ref: "t_fetch" }]), "t_fetch");
  // 普通对象给紧凑 JSON
  assert.equal(formatValue({ a: 1, b: 2, c: 3 }), '{"a":1,"b":2,"c":3}');
});

test("差异行：字段名 + 旧 + 新 + 增删", () => {
  const rows = diffRows([
    { path: "definition.system_prompt", before: "旧", after: "新" },
    { path: "tool_names", before: ["a"], after: ["a", "b"], added: ["b"], removed: [] },
  ]);
  assert.deepEqual(rows[0], { label: "系统提示词", before: "旧", after: "新", added: undefined, removed: undefined });
  assert.equal(rows[1].label, "工具");
  assert.deepEqual(rows[1].added, ["b"]);
});

test("长文本截断：短的不动，长的带字数提示", () => {
  assert.equal(clip("你好"), "你好");
  const long = "字".repeat(500);
  const out = clip(long, 100);
  assert.ok(out.startsWith("字".repeat(100)));
  assert.ok(out.includes("共 500 字"));
});
