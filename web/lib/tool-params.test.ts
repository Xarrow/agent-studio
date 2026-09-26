/** tool-params 纯函数护栏测试（node --test，零依赖；与 canvas 测试同款直接 import .ts） */

import test from "node:test";
import assert from "node:assert/strict";

import { argsToFields, fieldToValue, schemaToFields, urlParams, valueToField } from "./tool-params.ts";

test("URL 占位符解析：多个、去重、容忍空格", () => {
  assert.deepEqual(urlParams("https://x.com/w?city={{city}}&d={{ date }}&q={{city}}"), ["city", "date"]);
  assert.deepEqual(urlParams("https://x.com/w"), []);
  assert.deepEqual(urlParams("{{a}}{{b}}{{a}}"), ["a", "b"]);
});

test("schema → 字段：类型/必填/enum/描述", () => {
  const f = schemaToFields({
    type: "object",
    required: ["q"],
    properties: {
      q: { type: "string", description: "关键词" },
      n: { type: "integer" },
      on: { type: "boolean" },
      kind: { type: "string", enum: ["a", "b"] },
    },
  });
  assert.equal(f.length, 4);
  assert.equal(f[0].name, "q");
  assert.equal(f[0].required, true);
  assert.equal(f[0].description, "关键词");
  assert.equal(f[1].type, "number");
  assert.equal(f[2].type, "boolean");
  assert.deepEqual(f[3].enumValues, ["a", "b"]);
});

test("schema → 字段：空/坏输入不炸", () => {
  assert.deepEqual(schemaToFields(null), []);
  assert.deepEqual(schemaToFields(undefined), []);
  assert.deepEqual(schemaToFields({}), []);
  assert.deepEqual(schemaToFields("nope"), []);
});

test("探测 args → 字段：Python 注解串（str | None / int | None / bool / Any）也能认", () => {
  const f = argsToFields([
    { name: "file_path", required: true, type: "str" },
    { name: "limit", required: false, type: "int | None" },
    { name: "on", required: false, type: "bool" },
    { name: "mode", required: false, type: "Literal" },
    { name: "extra", required: false, type: "Any" },
  ]);
  assert.equal(f.length, 5);
  assert.equal(f[0].required, true);
  assert.equal(f[1].type, "number");
  assert.equal(f[2].type, "boolean");
  assert.equal(f[3].type, "string");
  assert.equal(f[4].type, "string");
  assert.deepEqual(argsToFields(null), []);
  assert.deepEqual(argsToFields(undefined), []);
});

test("表单值类型转换：number/boolean 不做字符串提交", () => {
  assert.equal(fieldToValue({ name: "n", type: "number", required: false, description: "" }, "42"), 42);
  assert.equal(fieldToValue({ name: "n", type: "number", required: false, description: "" }, ""), undefined);
  assert.equal(fieldToValue({ name: "b", type: "boolean", required: false, description: "" }, "true"), true);
  assert.equal(fieldToValue({ name: "b", type: "boolean", required: false, description: "" }, "false"), false);
  assert.equal(fieldToValue({ name: "s", type: "string", required: false, description: "" }, "hi"), "hi");
});

test("回填：任意值 → 表单字符串", () => {
  assert.equal(valueToField(42), "42");
  assert.equal(valueToField(true), "true");
  assert.equal(valueToField(null), "");
  assert.equal(valueToField(undefined), "");
  assert.equal(valueToField({ a: 1 }), '{"a":1}');
});
