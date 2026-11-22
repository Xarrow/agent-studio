/**
 * 浏览器画面的 WebRTC 客户端（主链路）。
 *
 * 角色分工（出问题时先看这一行）：
 *   服务端 Chromium --CDP--> H.264 (aiortc) --SRTP--> 这里 <video>
 *   DataChannel 双向：输入（点击/键盘/滚动）下去，回执/拒绝原因/实测指标上来。
 *
 * 三条硬约定：
 *   1. **失败就交给调用方**（onFatal）—— 本文件绝不自己重试/自己回跳，
 *      兼容模式的判定和「切回流畅模式」按钮由 UI 决定。
 *   2. **非 trickle**：offer 等 ICE 收集完再发（服务端 answer 也一样），
 *      少一条信令通道，也少一类"候选先到、描述后到"的竞态。
 *   3. **指标只报实测**：fps = framesDecoded 的增量，延迟 = 抖动缓冲 + RTT/2
 *      （估算，界面上也写"估算"）。没有帧就说 0，不编。
 */

// 显式 .ts 后缀：这条 import 链要能被 node --test（strip-types）直接加载，
// 才能用假 RTCPeerConnection 验「真的发了 webrtc/config 并连上」（见 browser-live.test.ts）。
// tsconfig 里已开 allowImportingTsExtensions（noEmit:true 下合法）。
import { api, type BrowserStreamState } from "./api.ts";

export type RtcStats = {
  fps: number;
  kbps: number;
  rttMs: number;
  latencyMs: number;
  width: number;
  height: number;
};

export type RtcMessage = {
  type: "ack" | "denied";
  kind?: string;
  note?: string;
  feedback?: string;
  reason?: string;
  changed?: boolean;
  state?: unknown;
};

export type RtcHandlers = {
  onTrack: (stream: MediaStream) => void;
  onOpen: () => void;
  onFatal: (reason: string) => void;
  onMessage: (msg: RtcMessage) => void;
  onStats: (stats: RtcStats) => void;
};

/** 建连阶段的上限：ICE + DTLS 在跨国链路上通常 2~6s；超过 15s 就当不可用 */
const CONNECT_TIMEOUT_MS = 15000;
const GATHER_TIMEOUT_MS = 6000;

export class BrowserRtc {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private opened = false;

  private readonly sessionId: string;

  private constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  static async start(sessionId: string, handlers: RtcHandlers): Promise<BrowserRtc> {
    if (typeof window === "undefined" || typeof RTCPeerConnection === "undefined") {
      throw new Error("这个浏览器不支持 WebRTC");
    }
    const rtc = new BrowserRtc(sessionId);
    try {
      await rtc.connect(handlers);
    } catch (e) {
      rtc.dispose(false);
      throw e;
    }
    return rtc;
  }

  get isOpen(): boolean {
    return this.opened && this.dc?.readyState === "open";
  }

  /** 发送输入/心跳；通道没开就返回 false（调用方走 HTTP 回退） */
  send(obj: Record<string, unknown>): boolean {
    try {
      if (this.dc && this.dc.readyState === "open") {
        this.dc.send(JSON.stringify(obj));
        return true;
      }
    } catch {
      /* 通道刚断：交给连接状态处理 */
    }
    return false;
  }

  private async connect(handlers: RtcHandlers): Promise<void> {
    const cfg = await api.browserRtcConfig(this.sessionId);
    const pc = new RTCPeerConnection({ iceServers: cfg.iceServers || [] });
    this.pc = pc;

    pc.ontrack = (ev: RTCTrackEvent) => {
      if (this.stopped) return;
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      handlers.onTrack(stream);
    };

    // 先建数据通道再 offer：这样 SDP 里一定带 application 段（服务端只答不建）
    const dc = pc.createDataChannel("input", { ordered: true });
    this.dc = dc;
    dc.onmessage = (ev: MessageEvent) => {
      if (this.stopped) return;
      try {
        const msg = JSON.parse(String(ev.data)) as RtcMessage;
        if (msg && (msg.type === "ack" || msg.type === "denied")) handlers.onMessage(msg);
      } catch {
        /* 忽略非 JSON */
      }
    };
    dc.onopen = () => {
      this.opened = true;
      handlers.onOpen();
      this.startStats(handlers);
    };

    // 只要视频（不采集本地任何东西）
    pc.addTransceiver("video", { direction: "recvonly" });

    let settled = false;
    let rejectConnect: ((e: Error) => void) | null = null;
    const onState = () => {
      if (this.stopped) return;
      const st = pc.connectionState;
      if (st === "connected" || this.opened) settled = true;
      if (st === "failed") {
        if (!settled && rejectConnect) {
          settled = true;
          rejectConnect(new Error("ICE 失败（网络不通或端口被挡）"));
        } else {
          this.fail(handlers, "WebRTC 连接失败（网络不通或端口被挡）");
        }
      } else if (st === "disconnected") {
        // 给 ICE 一点自愈时间；6 秒还回不来才算断
        window.setTimeout(() => {
          if (!this.stopped && this.pc?.connectionState === "disconnected") {
            this.fail(handlers, "WebRTC 连接中断");
          }
        }, 6000);
      }
    };
    pc.onconnectionstatechange = onState;
    pc.addEventListener("iceconnectionstatechange", onState);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitGathering(pc);
    const answer = await api.browserRtcOffer(this.sessionId, {
      sdp: pc.localDescription?.sdp || offer.sdp || "",
      type: "offer",
    });
    await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });

    await new Promise<void>((resolve, reject) => {
      if (settled || pc.connectionState === "connected" || this.opened) {
        resolve();
        return;
      }
      rejectConnect = reject;
      this.connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("15 秒内没连上（ICE 不通）"));
      }, CONNECT_TIMEOUT_MS);
      const check = () => {
        if (pc.connectionState === "connected" || this.opened) {
          if (settled && rejectConnect === null) return;
          settled = true;
          rejectConnect = null;
          if (this.connectTimer) clearTimeout(this.connectTimer);
          this.connectTimer = null;
          resolve();
        }
      };
      pc.addEventListener("iceconnectionstatechange", check);
      pc.addEventListener("connectionstatechange", check);
      check();
    });
  }

  private waitGathering(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      };
      const onChange = () => {
        if (pc.iceGatheringState === "complete") done();
      };
      pc.addEventListener("icegatheringstatechange", onChange);
      // 个别网络下 relay 候选很慢：6 秒就带着已有的候选走（连不上会回退）
      setTimeout(done, GATHER_TIMEOUT_MS);
    });
  }

  private startStats(handlers: RtcHandlers): void {
    if (this.statsTimer) return;
    let lastAt = Date.now();
    let lastFrames = 0;
    let lastBytes = 0;
    this.statsTimer = setInterval(async () => {
      const pc = this.pc;
      if (!pc || this.stopped || pc.connectionState !== "connected") return;
      try {
        const report = await pc.getStats();
        let inbound: Record<string, unknown> = {};
        let rttSec = 0;
        report.forEach((raw) => {
          const r = raw as unknown as Record<string, unknown>;
          if (r.type === "inbound-rtp" && r.kind === "video") inbound = r;
          if (r.type === "candidate-pair") {
            const state = String(r.state || "");
            if (state === "succeeded" && (r.nominated === true || r.selected === true)) {
              rttSec = Number(r.currentRoundTripTime || 0);
            }
          }
        });
        const now = Date.now();
        const dt = Math.max(0.2, (now - lastAt) / 1000);
        const frames = Number(inbound.framesDecoded || 0);
        const bytes = Number(inbound.bytesReceived || 0);
        const fps = Math.max(0, (frames - lastFrames) / dt);
        const kbps = Math.max(0, ((bytes - lastBytes) * 8) / dt / 1000);
        lastAt = now;
        lastFrames = frames;
        lastBytes = bytes;
        const emitted = Number(inbound.jitterBufferEmittedCount || 0);
        const jitterMs = emitted > 0 ? (Number(inbound.jitterBufferDelay || 0) / emitted) * 1000 : 0;
        const rttMs = Math.round(rttSec * 1000);
        const stats: RtcStats = {
          fps: Math.round(fps * 10) / 10,
          kbps: Math.round(kbps),
          rttMs,
          latencyMs: Math.round(jitterMs + rttSec * 500),
          width: Number(inbound.frameWidth || 0),
          height: Number(inbound.frameHeight || 0),
        };
        handlers.onStats(stats);
        this.send({ kind: "stats", ...stats });
      } catch {
        /* 统计失败不影响画面 */
      }
    }, 2000);
  }

  private fail(handlers: RtcHandlers, reason: string): void {
    if (this.stopped) return;
    handlers.onFatal(reason);
    this.dispose(true);
  }

  /** 收摊。notify=true 时告诉服务端恢复 JPEG 推流（关浏览器不归这里管）。 */
  dispose(notify = true): void {
    if (this.stopped) return;
    this.stopped = true;
    this.opened = false;
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.statsTimer = null;
    this.connectTimer = null;
    try {
      this.dc?.close();
    } catch {
      /* noop */
    }
    try {
      this.pc?.close();
    } catch {
      /* noop */
    }
    this.dc = null;
    this.pc = null;
    if (notify) void api.browserRtcClose(this.sessionId).catch(() => {});
  }
}

/** 会话级"已经失败过"的记忆：同一个会话不要每次开面板都重连一遍 */
const failed = new Set<string>();

export function rtcKnownBad(sessionId: string): boolean {
  return failed.has(sessionId);
}

export function markRtcBad(sessionId: string, bad: boolean): void {
  if (bad) failed.add(sessionId);
  else failed.delete(sessionId);
}

export function streamLabel(s: BrowserStreamState | null | undefined): string {
  if (!s || s.mode !== "webrtc") return "兼容模式 · 流畅度较低";
  return `流畅模式 · ${Math.round(s.fps || 0)}fps`;
}
