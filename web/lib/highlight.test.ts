/**
 * JSON / XML 格式化与着色的护栏 —— 纯函数，node --test 零依赖。
 *
 * 守的是"别把人家的内容改坏"：
 *   · 解析失败的 JSON / 标签不配对的 XML 必须**原样返回**（ok=false），
 *     不能吐出半截格式化结果 —— 那比不格式化更糟；
 *   · 着色只切 token，拼回去必须与原文一字不差（丢字符 = 复制出去就错）；
 *   · 键 / 字符串 / 数字 / 标签 / 属性 要分得开，否则等于没高亮。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  formatJson,
  formatXml,
  guessLang,
  isJsonText,
  looksMinifiedJson,
  minifyJson,
  tokenizeJson,
  tokenizeXml,
} from "./highlight.ts";

const join = (toks: { t: string }[]) => toks.map((t) => t.t).join("");

test("JSON 格式化：紧凑 → 缩进；坏 JSON 原样返回", () => {
  const mini = '{"a":1,"b":[true,null],"c":{"d":"x"}}';
  const out = formatJson(mini);
  assert.equal(out.ok, true);
  assert.equal(out.text, JSON.stringify(JSON.parse(mini), null, 2));
  assert.equal(out.text.split("\n").length > 4, true);

  const bad = '{"a":1,}';
  const out2 = formatJson(bad);
  assert.equal(out2.ok, false);
  assert.equal(out2.text, bad, "解析失败必须原样返回");
});

test("JSON 压缩与'是不是已经压缩'判定", () => {
  const pretty = '{\n  "a": 1\n}';
  assert.equal(minifyJson(pretty).text, '{"a":1}');
  assert.equal(looksMinifiedJson('{"a":1,"b":2}'), true);
  assert.equal(looksMinifiedJson(pretty), false);
  assert.equal(isJsonText('{"a":1}'), true);
  assert.equal(isJsonText("hello"), false);
});

test("JSON token：键、字符串值、数字、关键字分得开", () => {
  const toks = tokenizeJson('{"name":"张三","age":30,"ok":true}');
  assert.equal(join(toks), '{"name":"张三","age":30,"ok":true}', "拼回去必须与原文一致");
  const cls = (s: string) => toks.filter((t) => t.t === s).map((t) => t.c);
  assert.deepEqual(cls('"name"'), ["key"]);
  assert.deepEqual(cls('"张三"'), ["str"]);
  assert.deepEqual(cls("30"), ["num"]);
  assert.deepEqual(cls("true"), ["kw"]);
});

test("XML 缩进：嵌套进层，自闭合与注释不参与层级", () => {
  const src = '<?xml version="1.0"?><root><a x="1"/><b><c>文字</c></b><!-- 注释 --></root>';
  const out = formatXml(src);
  assert.equal(out.ok, true);
  const lines = out.text.split("\n");
  assert.equal(lines[0], '<?xml version="1.0"?>');
  assert.equal(lines[1], "<root>");
  assert.equal(lines[2], '  <a x="1"/>');
  assert.equal(lines[3], "  <b>");
  assert.equal(lines[4], "    <c>文字</c>");
  assert.equal(lines[5], "  </b>");
  assert.equal(lines[6], "  <!-- 注释 -->");
  assert.equal(lines[7], "</root>");
});

test("XML 标签不配对时原样返回（别乱动）", () => {
  const bad = "<root><a></root>";
  const out = formatXml(bad);
  assert.equal(out.ok, false);
  assert.equal(out.text, bad);
});

test("XML token：标签名、属性名、属性值、注释分得开且可还原", () => {
  const src = '<a href="/x" id=\'q\'>t</a><!--c-->';
  const toks = tokenizeXml(src);
  assert.equal(join(toks), src);
  assert.equal(toks.some((t) => t.t === "a" && t.c === "tag"), true);
  assert.equal(toks.some((t) => t.t === "href" && t.c === "attr"), true);
  assert.equal(toks.some((t) => t.t === '"/x"' && t.c === "val"), true);
  assert.equal(toks.some((t) => t.t === "<!--c-->" && t.c === "com"), true);
});

test("按内容猜语言：裸 JSON / XML 也认；普通文字不猜", () => {
  assert.equal(guessLang('{"a":1}'), "json");
  assert.equal(guessLang('<?xml version="1.0"?><a/>'), "xml");
  assert.equal(guessLang("<div class='x'>hi</div>"), "xml");
  assert.equal(guessLang("npm run build"), null);
  assert.equal(guessLang(""), null);
});

test("怪输入不抛异常（着色不该把页面搞白屏）", () => {
  for (const s of ["", "{", "<", "<<<>>>", '"unterminated', "\u0000\u0001", "{\"a\":\"\\u4f60\"}"]) {
    assert.doesNotThrow(() => tokenizeJson(s));
    assert.doesNotThrow(() => tokenizeXml(s));
    assert.doesNotThrow(() => formatXml(s));
  }
});
