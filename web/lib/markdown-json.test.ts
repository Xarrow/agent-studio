import assert from "node:assert/strict";
import test from "node:test";
import { unwrapJson } from "./unwrap-json.ts";

test("裸 JSON 回复：抽出 answer 给人看，原文留给折叠", () => {
  const raw = JSON.stringify({
    answer: "《合同.md》里写的是三年期",
    source: { doc_id: "d1", score: 0.82 },
  });
  const out = unwrapJson(raw);
  assert.ok(out, "应当识别为 JSON 回复");
  assert.equal(out!.body, "《合同.md》里写的是三年期");
  assert.equal(out!.raw, raw);
});

test("普通文本 / 数组 / 坏 JSON 不当成 JSON 回复", () => {
  assert.equal(unwrapJson("就是一句话"), null);
  assert.equal(unwrapJson("[1,2,3]"), null);
  assert.equal(unwrapJson('{"a":'), null);
  assert.equal(unwrapJson('{"source":{"x":1}}'), null, "没有可读字段就不抽");
});

test("带代码围栏的 json 不动（交给代码块渲染）", () => {
  assert.equal(unwrapJson('```json\n{"answer":"x"}\n```'), null);
});
