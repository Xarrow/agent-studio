import assert from "node:assert/strict";
import test from "node:test";
import { unwrapJson } from "./unwrap-json.ts";

test("裸 JSON 回复：抽出 answer 给人看，来源单独抽出来", () => {
  const raw = JSON.stringify({
    answer: "《合同.md》里写的是三年期",
    source: { doc_id: "d1", score: 0.82 },
  });
  const out = unwrapJson(raw);
  assert.ok(out, "应当识别为 JSON 回复");
  assert.equal(out!.body, "《合同.md》里写的是三年期");
  assert.equal(out!.raw, raw);
  assert.equal(out!.partial, false);
  assert.ok(out!.source, "来源要单独抽出来，界面才有来源卡片");
  assert.equal(out!.source!.doc_id, "d1");
});

test("来源是数组 / 换名字的字段也能认出来", () => {
  const out = unwrapJson(
    JSON.stringify({ result: "答案", sources: [{ title: "合同.md", quote: "30 天" }] }),
  );
  assert.ok(out);
  assert.equal(out!.body, "答案");
  assert.equal(out!.source!.title, "合同.md");
  assert.equal(unwrapJson(JSON.stringify({ answer: "x", citations: [] }))!.source, null);
});

test("流式半截 JSON：大括号还没闭合也要先出正文", () => {
  const partial = '{"answer":"知识库《合同.md》记载：付款期限为**验收合格后 30 天内**支付';
  const out = unwrapJson(partial);
  assert.ok(out, "半截 JSON 不能裸露大括号");
  assert.equal(out!.partial, true);
  assert.equal(out!.body, "知识库《合同.md》记载：付款期限为**验收合格后 30 天内**支付");

  assert.equal(unwrapJson('{"answer":"开')!.body, "开");
  // 转义还没流完：先给已经确定的正文，不能崩也不能把反斜杠漏出来
  const esc = unwrapJson('{"answer":"a\\u4e2');
  assert.equal(esc!.body, "a");
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

test("嵌套一层 JSON 字符串也能抽（工具把结果再包一层）", () => {
  const inner = JSON.stringify({ answer: "内层答案", source: { doc_name: "a.md" } });
  const out = unwrapJson(JSON.stringify({ result: inner }));
  assert.ok(out);
  assert.equal(out!.body, "内层答案");
  assert.equal(out!.source!.doc_name, "a.md");
});
