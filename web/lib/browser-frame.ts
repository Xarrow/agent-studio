/**
 * 浏览器实时帧的广播通道。
 *
 * 为什么要有它（2026-10-22）：
 *   帧原来走 React state —— 每来一帧就 setState，整个对话组件（几十上百条消息）
 *   跟着 diff 一遍，浏览器屏幕一有动画就整页卡。帧是 30 帧/秒的位图流，
 *   它只该直接写进那一个 <img>，不该惊动 React 树。
 *
 * 用法：
 *   生产端（对话页收到 SSE 的 browser_frame）→ pushFrame()
 *   消费端（浏览器窗口 / 缩略条）→ onFrame() 拿帧，自己决定怎么画
 */

export type LiveFrame = { data: string; url: string; title: string };

let latest: LiveFrame | null = null;
const subs = new Set<(f: LiveFrame) => void>();

export function pushFrame(f: LiveFrame): void {
  latest = f;
  for (const fn of subs) {
    try {
      fn(f);
    } catch {
      /* 单个订阅者出错不影响别人 */
    }
  }
}

export function latestFrame(): LiveFrame | null {
  return latest;
}

/** 切会话 / 这一轮结束时清掉，别让上一个会话的画面留在内存里 */
export function clearFrame(): void {
  latest = null;
}

export function onFrame(cb: (f: LiveFrame) => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}
