/**
 * Markdown 块级解析的**推进不变量**：每一轮主循环都必须吃掉当前行。
 *
 * 2026-10-31 现场：回答里出现 markdown 表格，流式输出时第一行是 `| 命令 | 结果`、
 * 下一行还没吐出 `|---|` 分隔行 → 表格分支不成立，落到「普通段落」分支；而那段
 * while 的条件又排除以 `|` 开头的行 → 一次都不进 → buf 空、i 不动、再 continue。
 * 同一条 line 被无限重解析，每轮生成一个 React 元素：堆每秒涨 ~100MB，
 * 十几秒后 Chrome 渲染进程被 OOM 杀掉（用户看到 Aw, Snap，即「浏览器崩溃了」）。
 *
 * 修复是「什么都没吃到就自己吃掉这一行」+ 每行访问次数护栏。
 * 这里用源码结构性断言守两道：MarkdownBody 里有兜底消费，也有 __mdStuck 护栏
 * （Markdown.tsx 是 TSX，node --experimental-strip-types 不能 import）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const here = path.dirname(new URL(import.meta.url).pathname);
const MD = readFileSync(path.join(here, "../components/Markdown.tsx"), "utf8");

const body = MD.slice(MD.indexOf("function MarkdownBody"), MD.indexOf("export default memo"));

test("段落分支吞不掉任何行时必须自己吃掉这一行", () => {
  assert.ok(
    body.includes("if (!buf.length) buf.push(lines[i++]);"),
    "普通段落的 while 一次都没进时要强制消费当前行，否则永远卡在这一行",
  );
});

test("主循环有每行访问次数护栏，防止任何分支忘记推进", () => {
  assert.ok(body.includes("__mdStuck"), "要有卡住的现场记录（便于下次定位）");
  assert.ok(/const guard = new Map<number, number>\(\)/.test(body), "要有按行计数的护栏表");
  assert.ok(/if \(tooMany\(i\)\) \{[\s\S]{0,80}i\+\+/.test(body), "超限时必须强制跳过这一行");
});

