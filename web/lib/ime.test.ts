/**
 * 输入法（IME）护栏测试 —— node --test，零依赖
 * ============================================
 *
 * 两件事：
 * ① `isImeEvent` 的判定（各浏览器给不同信号：isComposing / keyCode 229）
 * ② **全站源码扫描**：任何「Enter 就提交」的键盘处理都必须带 IME 守卫。
 *    这条是真出过线上问题的：中文拼音没上屏时按 Enter（输入法用它选字）
 *    被当成发送，半截拼音就发出去了。靠自觉会再犯，交给测试守。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { isImeEvent } from "./ime.ts";

test("isImeEvent：React 合成事件的 nativeEvent.isComposing", () => {
  assert.equal(isImeEvent({ nativeEvent: { isComposing: true } }), true);
  assert.equal(isImeEvent({ nativeEvent: { isComposing: false } }), false);
});

test("isImeEvent：只有 keyCode 229 的老浏览器/输入法也算", () => {
  assert.equal(isImeEvent({ nativeEvent: { keyCode: 229 } }), true);
  assert.equal(isImeEvent({ keyCode: 229 }), true);
  assert.equal(isImeEvent({ which: 229 }), true);
  assert.equal(isImeEvent({ nativeEvent: { keyCode: 13 } }), false);
});

test("isImeEvent：空输入不炸", () => {
  assert.equal(isImeEvent(null), false);
  assert.equal(isImeEvent(undefined), false);
  assert.equal(isImeEvent({}), false);
});

/* ─────────────── 源码扫描：Enter 提交必须带 IME 守卫 ─────────────── */

const WEB = join(import.meta.dirname, "..");
const SCAN_DIRS = ["app", "components"];
/** 命中 keydown 里的 Enter 分支 */
const ENTER_KEYS = [/key\s*===\s*"Enter"/, /key\s*===\s*'Enter'/];
/** 允许的例外：不是「输入框提交」而是行/节点展开（键盘可达性用），与输入法无关 */
const ALLOW = new Set([
  "components/ui/kit.tsx", // Row：Enter/空格 = 展开行
  "components/RunsPanel.tsx", // 运行记录行：Enter/空格 = 展开
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** 粗略切出每个 onKeyDown / addEventListener("keydown") 的代码块 */
function keyBlocks(src: string): string[] {
  const blocks: string[] = [];
  const re = /onKeyDown=\{\(e\)\s*=>\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    blocks.push(src.slice(m.index, i));
  }
  return blocks;
}

test("全站扫描：Enter 提交的地方都有 IME 守卫（中文组字中回车=选字）", () => {
  const offenders: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(WEB, dir))) {
      const rel = file.slice(WEB.length + 1);
      if (ALLOW.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      for (const block of keyBlocks(src)) {
        const enter = ENTER_KEYS.some((r) => r.test(block));
        if (!enter) continue;
        const guarded = block.includes("isImeEvent(") || block.includes("ime.blocked(");
        if (!guarded) offenders.push(`${rel} :: ${block.split("\n")[0].trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这些 Enter 处理没有输入法守卫（中文没打完就回车会被当提交）：\n${offenders.join("\n")}`,
  );
});
