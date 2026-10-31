/**
 * 执行过程的数据拼装 `eventsToSteps` —— 结构守护。
 *
 * 为什么用"读源码断言"而不是直接调函数：`run-timeline.tsx` 里有 JSX，
 * 站点用 `node --test --experimental-strip-types` 跑零依赖测试，strip-types
 * 不处理 TSX，所以 import 会 404（与 ui-structure.test.ts 同一套路）。
 *
 * 守的是 2026-10-31 那次标签页 Aw-Snap：`eventsToSteps` 里每个 tool 增量事件
 * 都做 `[...blocks].reverse().find(...)`（整表拷贝），6000 事件的 run 就是千万级
 * 对象拷贝；叠加"每条事件都 setState"→ 整棵 3000 行组件狂重渲染，渲染进程被
 * OOM 杀掉。修法是索引查表 + 事件缓冲限长 + 渲染节流。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const here = path.dirname(new URL(import.meta.url).pathname);
const read = (p: string) => readFileSync(path.join(here, p), "utf8");

const TIMELINE = read("../components/ui/run-timeline.tsx");
const CONSOLE = read("../components/ChatConsole.tsx");

test("eventsToSteps 用索引查块，不是整表反查", () => {
  const raw = TIMELINE.slice(TIMELINE.indexOf("export function eventsToSteps"));
  // 去掉注释行再断言：说明文字里会引用旧写法，不算代码
  const code = raw
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  assert.ok(code.includes("lastIdx"), "应该有 lastByTool 的索引表");
  assert.ok(!code.includes("[...blocks].reverse()"), "不能再整表拷贝 + 反转来找最后一块");
  assert.ok(
    !/const lastByTool[\s\S]{0,200}\.find\(/.test(code),
    "lastByTool 不该再走 find 线性扫描",
  );
});

test("流式事件进 state 前必须过缓冲与限长", () => {
  assert.ok(CONSOLE.includes("LIVE_EVENTS_MAX"), "事件数组要有上限");
  assert.ok(CONSOLE.includes("appendLiveEvent(ev)"), "SSE 每条事件走 appendLiveEvent");
  // 反面：不许回到「每条事件直接 setLiveEvents(prev => [...prev, ev])」
  assert.ok(
    !/setLiveEvents\(\(prev\)\s*=>\s*\[\s*\.\.\.prev/.test(CONSOLE),
    "禁止每条事件都整表复制进 state",
  );
  // 攒批：定时器里才吐给 React
  assert.ok(/setTimeout\([\s\S]{0,120}setLiveEvents\(/.test(CONSOLE), "要有攒批 flush");
});

test("过程条的数据源走 useMemo，不在渲染里重算", () => {
  assert.ok(
    /const liveSteps = useMemo\(\(\) => eventsToSteps\(liveEvents, liveInput\)/.test(CONSOLE),
    "liveSteps 应 memo 化",
  );
  assert.ok(
    !/steps=\{eventsToSteps\(liveEvents, liveInput\)\}/.test(CONSOLE),
    "JSX 里不该再直接调 eventsToSteps(...)",
  );
});
