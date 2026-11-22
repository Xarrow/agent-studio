/**
 * 浏览器实时视频的护栏测试 —— node --test，零依赖
 * ================================================
 *
 * 守的是 2026-11-22 那个 P0 死锁（面板停在历史截图、连 webrtc/config 都不发）：
 *
 *   shown = viewStep ?? (!hasFrame && !frame && steps.length ? 最后一步 : null)
 *   而 hasFrame 只在帧回调里置位，帧回调写的 <img> 又只在「不显示历史」时渲染 ——
 *   打开一个「有历史步骤、当前没有实时帧」的会话（回看 / 刷新 / 这轮已结束）时：
 *   imgRef 为 null → 回调提前 return → hasFrame 永假 → 永远显示历史 + WebRTC 永不启动。
 *
 * 所以这里守两条：
 *   ① 门控不再看画面状态（历史步骤状态下也要 start）；
 *   ② 真跑一遍 BrowserRtc.start（假 RTCPeerConnection + 假 fetch），确认它真的发出了
 *      webrtc/config 与 webrtc/offer 并把连接开到 connected —— 只断言"函数返回 start"
 *      证明不了信令真的发了。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FpsMeter, KEY_BUTTONS, keyBody, receiptTone, shouldStartRtc, streamStatusText } from "./browser-live.ts";
import { BrowserRtc, markRtcBad } from "./webrtc.ts";

const WEB = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(WEB, p), "utf8");

/* ── ① 门控 ─────────────────────────────────────────────────────────── */

const base = {
  variant: "panel" as const,
  sessionId: "ses_test",
  browserLive: true,
  knownBad: false,
  retryToken: 0,
};

test("从历史步骤状态进入面板也要连：hasFrame=false + 正在显示历史也必须 start", () => {
  // 这就是那个死锁的现场：没有实时帧、画面停在第 7 步的过程截图
  assert.equal(
    shouldStartRtc({ ...base, hasFrame: false, hasSnapshotFrame: false, showingHistory: true }),
    "start",
    "历史步骤/无实时帧不能成为 WebRTC 的门 —— 这就是面板卡在历史截图的根因",
  );
  // 反过来也一样：有实时帧、没在回看，当然也要连
  assert.equal(shouldStartRtc({ ...base, hasFrame: true, showingHistory: false }), "start");
});

test("门控只由「面板 + 会话 + 活浏览器 + 是否被判过连不上」决定", () => {
  assert.equal(shouldStartRtc({ ...base, variant: "inline" }), "skip", "缩略条不建 WebRTC");
  assert.equal(shouldStartRtc({ ...base, sessionId: undefined }), "skip", "没有会话号没法发信令");
  assert.equal(shouldStartRtc({ ...base, browserLive: false }), "skip", "浏览器已过期/关闭");
  assert.equal(shouldStartRtc({ ...base, knownBad: true }), "fallback", "同会话连过一次失败就先走兼容模式");
  assert.equal(shouldStartRtc({ ...base, knownBad: true, retryToken: 1 }), "start", "用户点「切回流畅模式」必须真的重试");
});

/* ── ② 真发信令、真连上（假 PC + 假 fetch） ─────────────────────────── */

type Sent = { url: string; body: string };

class FakeDataChannel {
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = "closed";
  }

  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }
}

class FakePeerConnection {
  static last: FakePeerConnection | null = null;
  static built = 0;

  cfg: { iceServers?: unknown[] };
  listeners: Record<string, Array<() => void>> = {};
  connectionState = "new";
  iceGatheringState = "complete";
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  dc = new FakeDataChannel();
  ontrack: ((ev: { streams: unknown[]; track?: unknown }) => void) | null = null;

  constructor(cfg: { iceServers?: unknown[] }) {
    this.cfg = cfg;
    FakePeerConnection.last = this;
    FakePeerConnection.built += 1;
  }

  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ||= []).push(fn);
  }

  removeEventListener(type: string, fn: () => void): void {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }

  protected emit(type: string): void {
    for (const fn of this.listeners[type] || []) fn();
  }

  addTransceiver(): void {}

  createDataChannel(): FakeDataChannel {
    return this.dc;
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n" };
  }

  async setLocalDescription(d: { type: string; sdp: string }): Promise<void> {
    this.localDescription = d;
  }

  async setRemoteDescription(d: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = d;
    // 真实现里 ICE/DTLS 连上后：connectionState=connected 且 DataChannel 打开
    this.connectionState = "connected";
    this.dc.open();
    this.emit("connectionstatechange");
    this.emit("iceconnectionstatechange");
  }

  async getStats(): Promise<Map<string, unknown>> {
    return new Map();
  }

  close(): void {
    this.connectionState = "closed";
  }
}

function fakeFetch(seen: Sent[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    const body = url.endsWith("/webrtc/config")
      ? { iceServers: [{ urls: "turn:turn.example.com:3478?transport=tcp", username: "u", credential: "c" }] }
      : url.endsWith("/webrtc/offer")
        ? { type: "answer", sdp: "v=0\r\na=recvonly\r\n" }
        : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

function installFakes(seen: Sent[], pcClass: unknown = FakePeerConnection) {
  const real = {
    fetch: globalThis.fetch,
    pc: (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection,
    window: (globalThis as { window?: unknown }).window,
    document: (globalThis as { document?: unknown }).document,
  };
  globalThis.fetch = fakeFetch(seen);
  (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = pcClass;
  // BrowserRtc 开头会判 typeof window —— node 里没有，先摆一个最小壳（它只用 window.setTimeout；
  // api.ts 取口令时会读 localStorage / document.cookie）
  (globalThis as { window?: unknown }).window = {
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  (globalThis as { document?: unknown }).document = { cookie: "" };
  return () => {
    globalThis.fetch = real.fetch;
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = real.pc;
    (globalThis as { window?: unknown }).window = real.window;
    (globalThis as { document?: unknown }).document = real.document;
  };
}

test("历史步骤状态下真发 webrtc/config + offer 并连上（回归缺陷 1 的后半句）", async () => {
  const seen: Sent[] = [];
  const restore = installFakes(seen);
  markRtcBad("ses_test_hist", false);

  const tracks: unknown[] = [];
  let opened = 0;
  let stats = 0;
  try {
    const rtc = await BrowserRtc.start("ses_test_hist", {
      onTrack: (s) => tracks.push(s),
      onOpen: () => {
        opened += 1;
      },
      onFatal: (r) => assert.fail(`不该失败：${r}`),
      onMessage: () => {},
      onStats: () => {
        stats += 1;
      },
    });

    const urls = seen.map((s) => s.url);
    assert.ok(
      urls.some((u) => u.endsWith("/api/sessions/ses_test_hist/browser-ctl/webrtc/config")),
      `必须真的发出 webrtc/config（实际请求：${urls.join(", ")}）`,
    );
    assert.ok(
      urls.some((u) => u.endsWith("/api/sessions/ses_test_hist/browser-ctl/webrtc/offer")),
      "必须真的把 offer 发给服务端",
    );
    assert.ok(seen.some((s) => s.body.includes("m=video")), "offer 里要带视频段");
    const pc = FakePeerConnection.last;
    assert.ok(pc, "要真的 new 出一个 RTCPeerConnection");
    assert.equal((pc.cfg.iceServers || []).length, 1, "iceServers 必须原样交给 RTCPeerConnection（TURN 靠它）");
    assert.equal(pc?.dc.sent.length >= 0, true);
    assert.equal(opened, 1, "DataChannel 打开后必须告诉 UI（这一拍才把 rtcMode 切成 live）");
    assert.equal(rtc.isOpen, true, "通道开着才算连上");

    pc!.ontrack?.({ streams: [{ kind: "video-track-stream" }] });
    assert.equal(tracks.length, 1, "视频轨要交给 <video>");
    assert.equal(stats, 0);
    rtc.dispose();
    // 收摊必须通知服务端关流：以前走 dispose(false)，服务端那条流永久停在 connecting
    assert.ok(
      seen.some((s) => s.url.endsWith("/api/sessions/ses_test_hist/browser-ctl/webrtc/close")),
      `dispose 必须调 webrtc/close（实际请求：${seen.map((s) => s.url).join(", ")}）`,
    );
  } finally {
    restore();
  }
});

/** ICE 打不通的假 PC：信令走完之后才异步报 failed（真实现就是这样）。 */
class FailingPeerConnection extends FakePeerConnection {
  async setRemoteDescription(): Promise<void> {
    // 同步报 failed 会落在 connect 的建连等待之外（那里 rejectConnect 还没挂上），
    // 所以推到下一拍：模拟"answer 收到了，候选却谁也到不了"。
    setTimeout(() => {
      this.connectionState = "failed";
      this.emit("connectionstatechange");
      this.emit("iceconnectionstatechange");
    }, 0);
  }
}

test("连不上/超时也必须通知服务端关流（僵尸流的两头：这头是客户端）", async () => {
  const seen: Sent[] = [];
  const restore = installFakes(seen, FailingPeerConnection);
  let fatal = "";
  try {
    await assert.rejects(
      BrowserRtc.start("ses_dead", {
        onTrack: () => {},
        onOpen: () => {},
        onFatal: (r) => {
          fatal = r;
        },
        onMessage: () => {},
        onStats: () => {},
      }),
      /ICE|超时|连不上/,
      "ICE 失败必须把 rejection 交给调用方（UI 才知道切兼容档）",
    );
    const urls = seen.map((s) => s.url);
    assert.ok(
      urls.some((u) => u.endsWith("/api/sessions/ses_dead/browser-ctl/webrtc/close")),
      `失败路径也必须调 webrtc/close —— 否则服务端流永久 connecting（实际请求：${urls.join(", ")}）`,
    );
    assert.ok(seen.some((s) => s.body.includes("\"client\"")), "close 要带 client，服务端只关自己那条");
    assert.equal(fatal, "", "建连阶段失败由 rejection 表达，不该重复报 onFatal");
  } finally {
    restore();
  }
});

/* ── ③ 状态区必须给实测数字 ─────────────────────────────────────────── */

test("JPEG 实测 fps = 1 秒窗口里数到的帧数", () => {
  const m = new FpsMeter(1000);
  for (let i = 0; i < 25; i += 1) m.push(i * 40); // 40ms 一帧 = 25fps
  assert.equal(m.fps(1000), 25);
  // 停 1.2 秒没有帧 = 0，不许把上一秒的数留着当"还在推流"
  assert.equal(m.fps(2200), 0);
  m.push(2300);
  assert.equal(m.fps(2300), 1);
});

test("状态文案：三种模式都带数字，兼容模式不许只有形容词", () => {
  const live = streamStatusText({ mode: "webrtc", fps: 23.6, latency: 41.4, jpegFps: 6 });
  assert.match(live, /24fps/, `流畅模式要显示视频实测 fps（实际：${live}）`);
  assert.match(live, /41ms/, "流畅模式要显示延迟估算");
  const connecting = streamStatusText({ mode: "webrtc", fps: 0, connecting: true, jpegFps: 7.2 });
  assert.match(connecting, /连接中/, "连接中要如实说");
  assert.match(connecting, /7fps/, "连接中也要给当前 JPEG 的实测 fps");
  const jpeg = streamStatusText({ mode: "jpeg", fps: 0, jpegFps: 4.4, reason: "ICE 失败" });
  assert.match(jpeg, /兼容模式/, "回退后要写清是兼容模式");
  assert.match(jpeg, /4fps/, "兼容模式必须显示 JPEG 实测 fps（不是「流畅度较低」）");
  assert.doesNotMatch(jpeg, /流畅度较低/, "形容词文案已经不合格");
  for (const s of [live, connecting, jpeg]) assert.match(s, /\d/, "任何一档都要有数字");
});

/* ── ④ 按键可发现 ───────────────────────────────────────────────────── */

test("面板常驻四个常用键，发出去的是真按键事件", () => {
  const keys = KEY_BUTTONS.map((k) => k.key);
  for (const k of ["Enter", "Tab", "Escape", "Backspace"]) {
    assert.ok(keys.includes(k), `面板上要有 ${k}（触屏没有键盘）`);
  }
  const body = keyBody(KEY_BUTTONS[0]);
  assert.equal(body.kind, "key");
  assert.equal(body.key, "Enter");
  assert.equal(body.keyCode, 13, "真 Enter 要带 keyCode 13，有些站点只认它");
  assert.equal(KEY_BUTTONS.find((k) => k.key === "Tab")?.keyCode, 9);
});

/* ── ⑤ 源码护栏：别再把这几个坑写回去 ───────────────────────────────── */

test("BrowserStage 不再拿实时帧状态当 WebRTC 的门，实时元素常驻挂载", () => {
  const stage = read("components/BrowserStage.tsx");
  assert.doesNotMatch(stage, /if \(!hasFrame && !frame\) return;/, "被删掉的死锁门又回来了");
  assert.match(stage, /shouldStartRtc\(/, "门控要走进 browser-live.shouldStartRtc（可单测）");
  assert.match(stage, /ref=\{imgRef\}/, "实时 <img> 必须一直挂载（历史截图只是盖在上面）");
  assert.match(stage, /data-key-button/, "常用按键那一排要常驻可见");
  assert.match(stage, /data-stream-stat/, "状态区要有实测数字（fps/延迟）的常驻位置");
  assert.match(stage, /jpegFps/, "兼容模式要数 JPEG 帧，不能用写死的文案");
  assert.match(stage, /pageDims\(/, "点击换算必须用页面坐标（视频降档/JPEG 800 宽都不等于页面尺寸）");
});

/* ── ⑥ 回执：全屏点击/打字都得有可见回执（2026-11-22 三缺陷之③） ────── */

test("后端回执按内容分语气：成了绿、没成红", () => {
  // 点击有回执：成功/没变化都是"送到了"，绿色（用户看的是"这一下有没有被收到"）
  assert.equal(receiptTone("已点击 搜索框 · 页面有变化"), "ok");
  assert.equal(receiptTone("已点击 这里 · 页面没有可见变化"), "ok");
  assert.equal(receiptTone("已按 回车"), "ok");
  assert.equal(receiptTone("已进页面输入框（5 个字符）"), "ok");
  assert.equal(receiptTone("已用键盘事件输入 12 个字符（回读一致）"), "ok");
  // 失败必须是红的，不能被当成成功糊过去
  assert.equal(receiptTone("✗ 文字没进页面输入框：先点页面里的输入框（看到光标）再在面板里打字"), "err");
  assert.equal(receiptTone("这里没有可点的元素（点到空白处了）"), "err");
  assert.equal(receiptTone("浏览器正在被助手使用"), "err");
});

test("兼容模式（HTTP）那条路的回执不许被丢掉", () => {
  const console_ = read("components/ChatConsole.tsx");
  // sendBrowser 必须把后端 feedback 交回去，否则 BrowserStage 的 withFeedback 拿到 undefined
  assert.match(
    console_,
    /return r\?\.feedback \|\| ""/,
    "sendBrowser 不返回 feedback → 兼容模式点击/打字没有任何回执（旧实现就是这样）",
  );
  const stage = read("components/BrowserStage.tsx");
  assert.match(stage, /withFeedback\(onUserClick/, "HTTP 点击必须带回调执");
  assert.match(stage, /withFeedback\(onUserText/, "HTTP 打字必须带回调执");
  assert.match(stage, /withFeedback\(onUserScroll/, "HTTP 滚动必须带回调执");
  assert.match(stage, /coords: "page"/, "DataChannel 输入要标页面坐标口径");
});
