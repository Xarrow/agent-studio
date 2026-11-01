import test from "node:test";
import assert from "node:assert/strict";

import { createLayerStack, type HistoryEnv } from "./history-layers.ts";

/** 假浏览器历史：记录 push/back，并能在「回退」时触发 popstate */
function fakeEnv() {
  const pushed: Record<string, unknown>[] = [];
  const calls = { push: 0, replace: 0, back: 0, pops: 0 };
  let listener: (() => void) | null = null;
  const env: HistoryEnv = {
    push: (s) => {
      calls.push += 1;
      pushed.push(s);
    },
    replace: (s) => {
      calls.replace += 1;
      pushed.push(s);
    },
    back: () => {
      calls.back += 1;
      // 真实浏览器里 popstate 是异步来的；这里同步触发，等价于「紧接着就到了」
      listener?.();
    },
    onChange: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };
  return {
    env,
    calls,
    pushed,
    /** 模拟用户左滑/按返回键（不是我们调 back 引起的那次） */
    userBack() {
      calls.pops += 1;
      listener?.();
    },
    /** 模拟一次「返回落地」但不经过 back()，用于测「同一时刻栈已空」的情况 */
    firePop() {
      listener?.();
    },
  };
}

test("打开浮层压一条历史，用户左滑把它关掉（不退出网页）", () => {
  const f = fakeEnv();
  const stack = createLayerStack(f.env);
  let closed = 0;

  stack.open({ id: "sheet", kind: "layer", onClose: () => (closed += 1) });
  assert.equal(f.calls.push, 1, "打开时要 pushState，站内才有「上一页」");
  assert.deepEqual(f.pushed[0], { __hl: "sheet" });

  f.userBack();
  assert.equal(closed, 1, "左滑应该关掉浮层");
  assert.equal(stack.depth(), 0);
  assert.equal(f.calls.back, 0, "用户自己退的，不该再补一次 back");
});

test("程序内关闭（点 ✕）要撤回自己那条历史，且不会多退一级", () => {
  const f = fakeEnv();
  const stack = createLayerStack(f.env);
  const id = stack.open({ id: "sheet", kind: "layer", onClose: () => assert.fail("不该被调用") });

  stack.close(id);
  assert.equal(f.calls.back, 1, "关浮层时要把历史里那条撤掉");
  assert.equal(stack.depth(), 0);
  // close 引起的 popstate 已经被吃掉，不能再触发一次 onClose
  assert.equal(f.calls.pops, 0);
});

test("重复关闭是幂等的（否则左滑一次退两页）", () => {
  const f = fakeEnv();
  const stack = createLayerStack(f.env);
  let closed = 0;
  const id = stack.open({ id: "sheet", kind: "layer", onClose: () => (closed += 1) });

  f.userBack(); // 用户先退掉（栈已空）
  assert.equal(closed, 1);

  stack.close(id); // 组件卸载/state 归位时又调一次
  assert.equal(closed, 1, "已被返回消费的记录，再 close 不能重复触发");
  assert.equal(f.calls.back, 0, "也不该补一次 back（那会退到上一页）");
});

test("两层叠加：一次返回只关最上面那层", () => {
  const f = fakeEnv();
  const stack = createLayerStack(f.env);
  const order: string[] = [];

  stack.open({ id: "drawer", kind: "layer", onClose: () => order.push("drawer") });
  stack.open({ id: "browser", kind: "layer", onClose: () => order.push("browser") });

  f.userBack();
  assert.deepEqual(order, ["browser"], "只关最外层");
  assert.deepEqual(stack.ids(), ["drawer"]);

  f.userBack();
  assert.deepEqual(order, ["browser", "drawer"]);
  assert.equal(stack.depth(), 0);
});

test("关闭非栈顶的层：只摘记录，不动别的层", () => {
  const f = fakeEnv();
  const stack = createLayerStack(f.env);
  stack.open({ id: "a", kind: "layer", onClose: () => assert.fail("a 不该被关") });
  stack.open({ id: "b", kind: "layer", onClose: () => assert.fail("b 不该被关") });

  stack.close("a");
  assert.deepEqual(stack.ids(), ["b"], "下层被摘掉，上层原样保留");
  assert.equal(f.calls.back, 0, "非栈顶关闭不回调 back，否则会把 b 一起退掉");
});

test("从抽屉里点会话：接管抽屉那条记录，避免一次「空退」", () => {
  const f = fakeEnv();
  const stack = createLayerStack(f.env);
  let current = "A";

  // 抽屉打开（一条记录）
  stack.open({ id: "drawer", kind: "layer", onClose: () => assert.fail("抽屉不该被返回关掉") });
  // 点会话：接管这条记录，不再多压一条
  const prev = current;
  current = "B";
  stack.open({ id: "sess-B", kind: "session", onClose: () => (current = prev) }, true);

  assert.equal(f.calls.push, 1, "只该有抽屉那一次 pushState");
  assert.equal(f.calls.replace, 1, "会话层用 replaceState 接管，历史里不留空条");
  assert.deepEqual(stack.ids(), ["sess-B"]);

  f.userBack();
  assert.equal(current, "A", "一次返回就回到上一个会话，不需要先空退一次");
  assert.equal(stack.depth(), 0);
});

test("没有可接管的层时 takeOver 退化成普通 push", () => {
  const f = fakeEnv();
  const stack = createLayerStack(f.env);
  stack.open({ id: "sess-B", kind: "session", onClose: () => {} }, true);
  assert.equal(f.calls.push, 1);
  assert.equal(f.calls.replace, 0);
  assert.deepEqual(stack.ids(), ["sess-B"]);
});

test("站内最底层返回：不拦截，让浏览器正常退出", () => {
  const f = fakeEnv();
  createLayerStack(f.env);
  f.userBack(); // 栈是空的
  assert.equal(f.calls.back, 0, "最底层不应该被吞掉/劫持");
});

test("会话切换也是一层：返回回到上一个会话", () => {
  const f = fakeEnv();
  const stack = createLayerStack(f.env);
  let current = "A";
  const prev = current;
  current = "B";
  stack.open({ id: "sess-B", kind: "session", onClose: () => (current = prev) });

  f.userBack();
  assert.equal(current, "A", "左滑应该回到上一个会话，而不是退出网页");

  // 再次前进（切到 C）后返回，应该回到 A
  let prev2 = current;
  current = "C";
  stack.open({ id: "sess-C", kind: "session", onClose: () => (current = prev2) });
  f.userBack();
  assert.equal(current, "A");
});
