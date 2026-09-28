/**
 * TeX 子集解析护栏（node --test，零依赖）
 *
 * 公式是这个产品的"要读的内容"：解析错了比不渲染更糟（用户看不懂还以为是模型答错）。
 * 所以守这几条：
 *   ① 常见结构要认出来（分数 / 上下标 / 根号 / 希腊字母 / 求和积分）；
 *   ② 认不出的命令**原样保留**（宁可显示 \foo，也不要白掉或渲染错）；
 *   ③ 不会因为畸形输入炸掉（未闭合的 {}、孤立的 ^）—— 模型产出经常是半截的。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { splitInlineDisplayMath, texParse, type MNode } from "./tex.ts";

/** 把节点树拍成"可读结构串"，便于断言 */
function shape(nodes: MNode[]): string {
  return nodes
    .map((n) => {
      switch (n.k) {
        case "t":
          return n.v;
        case "grp":
          return `(${shape(n.a)})`;
        case "frac":
          return `frac[${shape(n.a)}/${shape(n.b)}]`;
        case "sqrt":
          return `sqrt[${shape(n.a)}]`;
        case "sup":
          return `${shape(n.base)}^${shape(n.sup)}`;
        case "sub":
          return `${shape(n.base)}_${shape(n.sub)}`;
        case "supsub":
          return `${shape(n.base)}^${shape(n.sup)}_${shape(n.sub)}`;
      }
    })
    .join("");
}

test("行内基本量：字母、数字、运算符原样", () => {
  assert.equal(shape(texParse("E=mc")), "E=mc");
});

test("上标 / 下标 / 同时有：^{}、_、_{} 都要认", () => {
  assert.equal(shape(texParse("x^2")), "x^2");
  assert.equal(shape(texParse("a_1")), "a_1");
  // 花括号里的内容作为整体进入上标（渲染时整段都在 <sup> 里），节点层是展开的
  assert.equal(shape(texParse("x^{n+1}")), "x^n+1");
  assert.equal(shape(texParse("a_{i}^{2}")), "a^2_i");
});

test("分数：\\frac{a}{b} 两个参数都取到", () => {
  assert.equal(shape(texParse("\\frac{a}{b}")), "frac[a/b]");
  assert.equal(shape(texParse("\\frac{n(n+1)}{2}")), "frac[n(n+1)/2]");
});

test("根号：\\sqrt{x} 与 \\sqrt[n]{x}", () => {
  assert.equal(shape(texParse("\\sqrt{x}")), "sqrt[x]");
  // 方根指数必须被认出来：曾经 \sqrt[3]{x} 会把 "[3]" 当正文画出来
  assert.equal(shape(texParse("\\sqrt[3]{x}")), "sqrt[x]");
  assert.deepEqual(texParse("\\sqrt[3]{x}").find((n) => n.k === "sqrt"), {
    k: "sqrt",
    a: [{ k: "t", v: "x" }],
    idx: [{ k: "t", v: "3" }],
  });
});

test("希腊字母与算符符号表", () => {
  assert.equal(shape(texParse("\\alpha+\\beta")), "α+β");
  assert.equal(shape(texParse("\\sum_{i=1}^{n} i")), "∑^n_i=1 i");
  assert.equal(shape(texParse("a \\le b \\ge c \\ne d")), "a ≤ b ≥ c ≠ d");
  assert.equal(shape(texParse("\\infty")), "∞");
});

test("认不出的命令原样保留（不白掉、不猜）", () => {
  const out = shape(texParse("\\foobar{x}"));
  assert.ok(out.includes("foobar"), `应当保留原文，实际得到：${out}`);
  assert.ok(out.includes("x"));
});

test("畸形输入不炸：未闭合的 {}、孤立的下标、空串", () => {
  for (const bad of ["\\frac{a", "x^", "a_{", "{{{{", "", "\\"]) {
    const out = texParse(bad);
    assert.ok(Array.isArray(out), `${bad} 应当返回节点数组`);
  }
});

test("转义字符：\\% 与 \\{ 不该被当成命令", () => {
  assert.equal(shape(texParse("50\\%")), "50%");
  assert.equal(shape(texParse("\\{a\\}")), "{a}");
});

test("同行混排的块级公式：说明：$$公式$$ 三段拆开", () => {
  const r = splitInlineDisplayMath("块级：$$\\frac{n(n+1)}{2}$$ 结束");
  assert.ok(r);
  assert.equal(r!.head, "块级：");
  assert.equal(r!.math, "\\frac{n(n+1)}{2}");
  assert.equal(r!.tail, " 结束");
});

test("整行就是一个块级公式时也认（head/tail 为空）", () => {
  const r = splitInlineDisplayMath("$$E=mc^2$$");
  assert.ok(r);
  assert.equal(r!.head, "");
  assert.equal(r!.math, "E=mc^2");
  assert.equal(r!.tail, "");
});

test("没有 $$ 的行返回 null（不要乱拆普通文本）", () => {
  assert.equal(splitInlineDisplayMath("就是一句话，里面有个 $ 符号"), null);
  assert.equal(splitInlineDisplayMath("价格 100$ 起"), null);
});
