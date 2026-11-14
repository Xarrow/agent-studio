"use client";

/**
 * 「只在第一次加载时显示骨架」。
 *
 * 为什么需要：管理页普遍是 `setLoading(true) → 拉数据 → setLoading(false)`，
 * 而渲染写成 `{loading ? 骨架 : 内容}`。于是**任何一个操作**（停用、切换筛选、
 * 保存）都会把整块内容替换成"加载中…"再换回来 —— 用户看到的就是页面闪一下。
 *
 * 正确语义是：骨架只服务于"第一次进来时还没有数据"，之后的刷新应该**原地更新**，
 * 旧数据留在屏幕上，直到新数据到达。
 *
 * 用法：
 *   const { loaded, markLoaded } = useFirstLoad();
 *   const load = async () => { setLoading(true); try { ...; markLoaded(); } finally { setLoading(false); } };
 *   return !loaded ? <Skeleton/> : <Content/>;
 */

import { useCallback, useState } from "react";

export function useFirstLoad(): { loaded: boolean; markLoaded: () => void } {
  const [loaded, setLoaded] = useState(false);
  const markLoaded = useCallback(() => setLoaded(true), []);
  return { loaded, markLoaded };
}
