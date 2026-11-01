"use client";

/**
 * React 侧的「浮层 ⇄ 历史」桥接（纯逻辑在 lib/history-layers.ts）。
 *
 * 用法：
 *   useHistoryLayer(open, () => setOpen(false))
 *   → 打开时压一条历史记录，左滑/返回键把它关掉；点 ✕ 关掉时自动撤回那条记录。
 *
 * 为什么要这个：手机上左缘滑动 = 浏览器返回。站内一滑就退出网页，是因为
 * 切换会话、开抽屉、开面板全是 React state，历史栈里没有「上一页」。
 */

import { useEffect, useRef } from "react";

import { createLayerStack, type LayerStack } from "./history-layers";

let singleton: LayerStack | null = null;
let seq = 0;

/** 模块级单例：所有浮层共用一条栈，返回键才知道该关哪一层 */
export function layerStack(): LayerStack {
  if (!singleton) {
    singleton = createLayerStack({
      push: (state) => window.history.pushState(state, ""),
      replace: (state) => window.history.replaceState(state, ""),
      back: () => window.history.back(),
      onChange: (handler) => {
        window.addEventListener("popstate", handler);
        return () => window.removeEventListener("popstate", handler);
      },
    });
  }
  return singleton;
}

/** 把一个「打开着的浮层」映射成一条历史记录 */
export function useHistoryLayer(open: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const id = layerStack().open({
      id: `layer-${++seq}`,
      kind: "layer",
      onClose: () => closeRef.current(),
    });
    return () => layerStack().close(id);
  }, [open]);
}

/** 会话切换同理：返回时回到切换前的那个会话，而不是退出网页 */
export function pushSessionLayer(onBack: () => void, takeOver = false): string {
  return layerStack().open(
    {
      id: `sess-${++seq}`,
      kind: "session",
      onClose: onBack,
    },
    takeOver,
  );
}
