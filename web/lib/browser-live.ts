/**
 * 浏览器画面的「要不要连实时视频」与「状态区读数」—— 纯函数，node --test 可测。
 *
 * 为什么单独抽出来（2026-11-22 实证）：
 *   门控原来写在组件里，条件是 `if (!hasFrame && !frame) return;`。而 hasFrame 只在
 *   帧回调里置位，帧回调写的 <img> 又只在「不显示历史步骤」时才渲染 —— 打开一个
 *   **有历史步骤、当前没有实时帧** 的会话时（回看、刷新、这轮已结束），img 根本不在
 *   DOM 里，回调提前 return，hasFrame 永远 false，WebRTC 永不启动：面板停在最后一张
 *   过程截图，Network 里连 webrtc/config 都没有。
 *
 * 结论写死在这里：**只要面板打开、会话里有活浏览器，就尝试建 WebRTC**。
 * 画面状态（有没有实时帧、是不是在看历史步骤）不参与判定，只留在入参里做诊断。
 * 回归测试见 browser-live.test.ts。
 */

export type RtcGateInput = {
  variant: "inline" | "panel";
  sessionId?: string;
  /** 会话里的浏览器还活着（control.status 不是 none/closed 且 alive !== false） */
  browserLive: boolean;
  /** 这个会话之前连过实时视频且失败了 */
  knownBad: boolean;
  /** 用户点过「切回流畅模式」的次数：> 0 时无视 knownBad */
  retryToken: number;
  /** ↓ 以下三项只做诊断，**不参与判定**（历史步骤/无实时帧时照样要连） */
  hasFrame?: boolean;
  hasSnapshotFrame?: boolean;
  showingHistory?: boolean;
};

export type RtcGateDecision = "start" | "fallback" | "skip";

export function shouldStartRtc(g: RtcGateInput): RtcGateDecision {
  if (g.variant !== "panel") return "skip";
  if (!g.sessionId || !g.browserLive) return "skip";
  if (g.knownBad && g.retryToken === 0) return "fallback";
  return "start";
}

/**
 * JPEG 兼容模式的实测 fps：1 秒滑动窗口里数到了几帧。
 * 服务端报的 fps 是编码节奏（静止页面只有 2fps 保活帧），用户看到的值必须数接收端。
 */
export class FpsMeter {
  private times: number[] = [];
  private readonly windowMs: number;

  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
  }

  push(now: number): void {
    this.times.push(now);
    this.prune(now);
  }

  /** 最近一个窗口内的实测帧率（一位小数）；没有帧就是 0，不编 */
  fps(now: number): number {
    this.prune(now);
    return Math.round((this.times.length * 1000) / this.windowMs * 10) / 10;
  }

  reset(): void {
    this.times = [];
  }

  private prune(now: number): void {
    const from = now - this.windowMs;
    while (this.times.length && this.times[0] < from) this.times.shift();
  }
}

export type StreamMode = "webrtc" | "jpeg" | "idle";

export type StreamFacts = {
  mode: StreamMode;
  /** WebRTC 接收端 getStats 的 fps（framesDecoded 增量） */
  fps: number;
  /** 端到端延迟估算：抖动缓冲 + RTT/2 */
  latency?: number;
  connecting?: boolean;
  /** 同一时刻 JPEG 通道的实测帧数（连接中/回退时用户看到的数） */
  jpegFps: number;
  reason?: string;
};

/**
 * 状态区那一枚芯片的文案 —— **任何一档都必须带数字**。
 * 「兼容模式 · 流畅度较低」这种只有形容词的写法已经被判过不合格：用户看不出差多少。
 */
export function streamStatusText(s: StreamFacts): string {
  const jpeg = `${Math.round(s.jpegFps)}fps`;
  if (s.mode === "jpeg") return `兼容模式 · ${jpeg}`;
  if (s.mode === "idle") return `画面 ${jpeg}`;
  if (s.connecting) return `连接中 · 画面 ${jpeg}`;
  const fps = Math.round(s.fps);
  if (fps <= 0) return `流畅模式 · 等统计 · 画面 ${jpeg}`;
  return s.latency && s.latency > 0 ? `流畅 · ${fps}fps · ${Math.round(s.latency)}ms` : `流畅 · ${fps}fps`;
}

export type KeySpec = {
  key: string;
  code: string;
  keyCode: number;
  label: string;
  title: string;
};

/** 面板上常驻的常用按键 —— 触屏没有键盘，Tab/Enter/Esc 以前无处可点 */
export const KEY_BUTTONS: KeySpec[] = [
  { key: "Enter", code: "Enter", keyCode: 13, label: "Enter", title: "Enter · 提交表单（搜索框就是它）" },
  { key: "Tab", code: "Tab", keyCode: 9, label: "Tab", title: "Tab · 跳到下一个可聚焦元素" },
  { key: "Escape", code: "Escape", keyCode: 27, label: "Esc", title: "Esc · 关闭弹层 / 取消" },
  { key: "Backspace", code: "Backspace", keyCode: 8, label: "⌫", title: "Backspace · 删掉前一个字符" },
];

export function keyBody(k: KeySpec): Record<string, unknown> {
  return {
    kind: "key",
    key: k.key,
    code: k.code,
    keyCode: k.keyCode,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    location: 0,
  };
}
