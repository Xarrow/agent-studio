"use client";

/**
 * 输入法（IME）守卫 —— 中文/日文组字期间不要把 Enter 当提交
 * ==========================================================
 *
 * 问题现场：在「Agent 执行」的输入框里打中文，拼音还没上屏（候选框还开着），
 * 一按 Enter 消息就发出去了 —— 发出去的是半截拼音，或者干脆是上一句话。
 *
 * 为什么：中文输入法里 Enter 的第一个职责是「**选字/上屏**」，不是提交。
 * 但浏览器在组字期间仍然会把这次 keydown 派发给页面（Chrome 带
 * `isComposing: true`，部分浏览器/输入法只给 `keyCode === 229`）。
 * 我们的 `onKeyDown` 只看 `e.key === "Enter"`，于是把选字当成了发送 ✗。
 *
 * 三道防线一起用（缺一道就会在某个浏览器上漏）：
 *   ① `event.isComposing` / `keyCode === 229` —— 组字中的标准信号；
 *   ② 自己记 `compositionstart/end` 状态 —— 个别输入法不发 isComposing；
 *   ③ 刚结束组字的一小段时间内也不认 —— Safari 是先 `compositionend`
 *      再派发 keydown（isComposing 已经是 false），只靠 ① 会漏。
 *
 * 用法：
 *   const ime = useImeGuard();
 *   <textarea {...ime.props} onKeyDown={(e) => {
 *     if (e.key === "Enter" && !e.shiftKey && !ime.blocked(e)) { ...发送... }
 *   }} />
 *
 * 纯 DOM 监听（window/document 上的）用 `isImeEvent(event)` 即可。
 */

import { useRef } from "react";

/** 组字刚结束的静默窗口：这段时间内来的 Enter 仍算「在选字」 */
const SETTLE_MS = 120;

type AnyKeyEvent = {
  nativeEvent?: { isComposing?: boolean; keyCode?: number } | null;
  isComposing?: boolean;
  keyCode?: number;
  which?: number;
};

/** 事件本身是否就是「组字中」的信号（React 合成事件与原生事件都吃） */
export function isImeEvent(e: AnyKeyEvent | null | undefined): boolean {
  if (!e) return false;
  const native = e.nativeEvent ?? undefined;
  if (native?.isComposing || e.isComposing) return true;
  // 229 = IME 正在处理这次按键（老浏览器 / 部分输入法只给这个）
  return native?.keyCode === 229 || e.keyCode === 229 || e.which === 229;
}

/**
 * 给输入框用的守卫：把 `props` 摊到输入元素上，提交前问一次 `blocked(e)`。
 * 状态放在 ref 里 —— 输入框重渲染不该把组字状态重置掉。
 */
export function useImeGuard() {
  const state = useRef({ composing: false, endedAt: 0 });

  return {
    props: {
      onCompositionStart: () => {
        state.current.composing = true;
      },
      onCompositionEnd: () => {
        state.current.composing = false;
        state.current.endedAt = Date.now();
      },
    },
    /** true = 这次按键属于输入法选字，**不要**触发提交 */
    blocked: (e: AnyKeyEvent | null | undefined): boolean =>
      isImeEvent(e) ||
      state.current.composing ||
      Date.now() - state.current.endedAt < SETTLE_MS,
  };
}
