/**
 * UI 结构护栏测试 —— node --test，零依赖
 * ============================================
 *
 * 守的是**这一轮重做里真出过的两类问题**，靠自觉会再犯：
 *
 * ① `[data-tap]{display:inline-flex}`（触屏可点区，≤1023px）与常见的
 *    `hidden lg:flex`（窄屏藏、宽屏显示）同权重且更靠后 → 盖掉 `.hidden`，
 *    于是「只在宽屏出现」的控件在手机上照样占位。实测：对话页右栏把手在
 *    390px 视口硬占 44px，把对话区从 390 挤到 346。
 *
 * ② 空间分配退化：本该「空状态占位归零」的区域又变回常驻（右栏 420px /
 *    手机会话列表在流内吃 40% 屏高），以及配置页又长出对话页的第二道门
 *    （内嵌会话列表 + 三视图）。
 *
 * 这些都是**源码里可判定的结构不变量**，不需要跑浏览器就能守。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(WEB, p), "utf8");

/** 去掉 CSS 注释 —— 注释里也会出现 `[data-tap]` 这类字样，不剥掉会误报 */
const stripCssComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 取出所有**会设 display** 的 `[data-tap...]{...}` 规则（含媒体查询里的）。
 * 只看设 display 的：`[data-tap]{min-height:44px}` 这类只放大点按区，
 * 不会盖掉 .hidden，不该被判为违规（判宽了会误报）。
 */
function dataTapDisplayRules(css: string): string[] {
  const rules: string[] = [];
  for (const m of css.matchAll(/\[data-tap(?![-\w])[^\]]*\][^{]*\{([^}]*)\}/g)) {
    if (/display\s*:/.test(m[1])) rules.push(m[0].replace(/\s+/g, " ").slice(0, 100));
  }
  return rules;
}

test("触屏 data-tap 规则不得盖掉 .hidden（窄屏藏/宽屏显的控件）", () => {
  const css = stripCssComments(read("app/globals.css"));
  const rules = dataTapDisplayRules(css);
  assert.ok(rules.length > 0, "应当仍然存在设 display 的 data-tap 触屏规则（否则本测试失去意义）");
  const evil = rules.filter((r) => !r.includes(":not(.hidden)"));
  assert.deepEqual(
    evil,
    [],
    `这些 data-tap 规则设了 display 却没有 :not(.hidden)，会在 ≤1023px 把 .hidden 盖掉：\n${evil.join("\n")}`,
  );
});

test("所有 data-tap 规则都带 :not(.hidden)（否则会因特异性把 44px 那条压掉）", () => {
  const css = stripCssComments(read("app/globals.css"));
  // 只看选择器本身：`[data-tap...]` 后面跟任意非 `{` 字符再 `{`
  const sels = [...css.matchAll(/\[data-tap(?![-\w])[^\]]*\][^{,]*\{/g)].map((m) => m[0].replace(/\s+/g, " "));
  assert.ok(sels.length >= 2, "应当有两条（≤1023 的 36px / ≤767 的 44px）");
  const missing = sels.filter((s) => !s.includes(":not(.hidden)"));
  assert.deepEqual(
    missing,
    [],
    `这些 data-tap 规则缺 :not(.hidden) —— 特异性和另一条不一致，会被压掉：\n${missing.join("\n")}`,
  );
});

test("对话页：会话栏窄屏不得在流内（必须 hidden + 抽屉）", () => {
  const src = read("components/ChatConsole.tsx");
  // 桌面会话栏：in-flow aside 必须带 hidden lg:flex
  assert.match(
    src,
    /<aside className="hidden lg:flex w-\[\d+px\][^"]*"/,
    "会话栏 <aside> 应当是 `hidden lg:flex`（窄屏不出现在流内）",
  );
  // 窄屏必须有覆盖式抽屉
  assert.match(src, /fixed inset-0 z-40/, "缺手机会话抽屉（覆盖式，不能占对话高度）");
  // 抽屉默认关闭
  assert.match(src, /const \[mobileNav, setMobileNav\] = useState\(false\)/, "手机会话抽屉默认应当是关的");
});

test("对话页：Chrome 直播栏默认收起，只在有画面时自动展开", () => {
  const src = read("components/ChatConsole.tsx");
  assert.match(src, /const \[railOpen, setRailOpen\] = useState\(false\)/, "直播栏默认应当收起");
  assert.match(
    src,
    /if \(browserFrame && !railTouched\.current\) setRailOpen\(true\)/,
    "缺「有直播画面时自动展开」的效果（否则画面来了要手动点）",
  );
  // 收起态的把手必须只在宽屏出现
  assert.match(
    src,
    /className="hidden lg:flex w-11 shrink-0 flex-col items-center gap-2 py-3 border-l/,
    "直播栏把手应当是 `hidden lg:flex`",
  );
});

test("对话页：消息流阅读列封顶（一行横扫整屏是阅读负担）", () => {
  const src = read("components/ChatConsole.tsx");
  assert.match(src, /max-w-3xl mx-auto px-4 sm:px-5 py-5/, "消息流缺 max-w-3xl 阅读列");
});

test("对话页：不能有「同一件事的第二道门」（顶栏本轮详情 vs 消息自带记录）", () => {
  const src = read("components/ChatConsole.tsx");
  // 只看 JSX 按钮文本，不看注释里提到的历史（注释里出现是正常的）
  assert.doesNotMatch(src, />\s*本轮详情\s*</, "顶栏又放了「本轮详情」——每条助手消息已自带完整记录");
});

test("配置页：不得内嵌对话页的会话列表 / 三视图（第二道门 + tabs）", () => {
  const src = read("components/AgentDetail.tsx");
  assert.doesNotMatch(src, /<RunPanel/, "配置页又引回了 RunPanel（内嵌会话列表 + 三视图）");
  assert.doesNotMatch(src, /"原始 JSON"/, "配置页又出现了原始 JSON 视图");
  assert.match(src, /AgentQuickRun/, "配置页应当用 AgentQuickRun（单轮试跑）");
});

test("配置页：主操作（试跑）不得埋在后面 —— 常驻卡片 + 窄屏提前", () => {
  const src = read("components/AgentDetail.tsx");
  assert.match(src, /快速试跑/, "缺快速试跑卡");
  assert.match(src, /max-xl:order-first/, "试跑卡缺窄屏提前（否则手机上排在三屏之后）");
  assert.match(src, /max-xl:contents/, "右列包裹层缺窄屏 contents（contents + order-first 是一对）");
  assert.match(src, /xl:grid xl:grid-cols-\[minmax\(0,1fr\)_400px\]/, "缺桌面双列网格");
});

test("配置页：概览数字不得再占一张四格卡（下面每节已有完整信息）", () => {
  const src = read("components/AgentDetail.tsx");
  assert.doesNotMatch(src, /最近一次执行：/, "四格概览卡又回来了（与下面各节重复）");
});

test("快速试跑：Enter 必须有输入法守卫（走 isImeEvent）", () => {
  const src = read("components/AgentQuickRun.tsx");
  assert.match(src, /isImeEvent/, "缺 IME 守卫");
  assert.match(src, /origin: "preview"/, "试跑应当归类为 preview（与对话页的执行区分）");
  assert.doesNotMatch(src, /session_id/, "试跑是单轮 —— 不该带 session_id（那是对话页的事）");
});
