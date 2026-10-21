/**
 * 浏览器帧广播通道的护栏测试 —— node --test，零依赖
 * ==================================================
 *
 * 守的是这一轮修掉的那个卡顿：
 *
 *   browser_frame 每秒来几十条，原来每条都 setBrowserFrame。整页卡不是因为
 *   图画得慢，是因为**每帧都把上百条消息的对话树重渲染一遍**。
 *   现在位图走这里的广播通道，直接写 <img>，React 只在地址/标题变化时更新。
 *
 * 靠自觉守不住：只要有人图省事把 pushFrame 改回 setState，页面就重新卡，
 * 而且要跑起真浏览器、真助手才看得见。这些都是**进程内可判定的不变量**。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pushFrame, latestFrame, clearFrame, onFrame } from "./browser-frame.ts";

const WEB = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(WEB, p), "utf8");

const frame = (data: string, url = "https://example.com", title = "Example") => ({ data, url, title });

test("pushFrame 广播给所有订阅者，并记住最新一帧", () => {
  clearFrame();
  const a: string[] = [];
  const b: string[] = [];
  const offA = onFrame((f) => a.push(f.data));
  const offB = onFrame((f) => b.push(f.data));

  pushFrame(frame("one"));
  pushFrame(frame("two"));

  assert.deepEqual(a, ["one", "two"]);
  assert.deepEqual(b, ["one", "two"]);
  assert.equal(latestFrame()?.data, "two");
  offA();
  offB();
});

test("退订后不再收帧，且不影响其他订阅者", () => {
  clearFrame();
  const got: string[] = [];
  const off = onFrame((f) => got.push(f.data));
  const keep = onFrame((f) => got.push("keep:" + f.data));
  pushFrame(frame("x"));
  off();
  pushFrame(frame("y"));
  assert.deepEqual(got, ["x", "keep:x", "keep:y"]);
  keep();
});

test("clearFrame 清掉缓存 —— 切会话不能让上一个会话的画面留下来", () => {
  pushFrame(frame("stale"));
  assert.equal(latestFrame()?.data, "stale");
  clearFrame();
  assert.equal(latestFrame(), null);
});

test("单个订阅者抛异常不打断其他订阅者", () => {
  clearFrame();
  const got: string[] = [];
  const bad = onFrame(() => {
    throw new Error("boom");
  });
  const good = onFrame((f) => got.push(f.data));
  assert.doesNotThrow(() => pushFrame(frame("safe")));
  assert.deepEqual(got, ["safe"]);
  bad();
  good();
});

test("帧数据不进 React state：对话页只在地址/标题变化时才 setBrowserFrame", () => {
  const src = read("components/ChatConsole.tsx");
  // 帧必须走广播通道
  assert.match(src, /pushFrame\(\{ data: p\.frame as string/, "browser_frame 必须 pushFrame 到广播通道");
  // setState 必须是「值没变就返回原对象」的形态，否则每帧都会重渲染整个对话树
  assert.match(
    src,
    /setBrowserFrame\(\(prev\) =>\s*prev && prev\.url === nu && prev\.title === nt \? prev : \{ data: "", url: nu, title: nt \}/,
    "setBrowserFrame 必须在 url/title 未变时返回 prev（同一引用），杜绝每帧重渲染"
  );
  // 位图只走广播：setBrowserFrame 的入参必须是空 data
  assert.match(src, /\{ data: "", url: nu, title: nt \}/, "setState 里只留地址/标题，位图必须为空");
});

test("浏览器窗口直接写 img.src，不经过 setState", () => {
  const src = read("components/BrowserStage.tsx");
  assert.match(src, /onFrame\(\(f\) => \{/, "面板要订阅广播通道");
  assert.match(src, /img\.src = `data:image\/jpeg;base64,\$\{pending\}`/, "帧要直接写进 img.src");
  assert.match(src, /requestAnimationFrame\(apply\)/, "帧要用 rAF 合并，别一个事件一次重排");
  // 老的「每帧 setState 两连击」必须消失
  assert.doesNotMatch(src, /setPrev\(cur\)/, "双层交叉淡入的 setPrev 不该再出现（限帧后只剩闪）");
  // 缩略条要降频
  assert.match(src, /\}, 400\);/, "缩略条应 400ms 才换一张，别跟满帧率");
});

test("后端给 Chromium 限帧：everyNthFrame + quality 都传下去", () => {
  const py = readFileSync(join(WEB, "..", "src/agent_studio/browser_session.py"), "utf8");
  assert.match(py, /"everyNthFrame": FRAME_EVERY_NTH/, "startScreencast 必须带 everyNthFrame");
  assert.match(py, /"quality": FRAME_QUALITY/, "startScreencast 必须带 quality");
  assert.match(py, /FRAME_MIN_INTERVAL_MS = \d+/, "后端要有最小间隔，不能只靠 Chromium");
  assert.match(py, /if now_ms - self\._last_frame_at < FRAME_MIN_INTERVAL_MS:\s*\n\s*return/, "帧到达要按间隔丢帧");
});
