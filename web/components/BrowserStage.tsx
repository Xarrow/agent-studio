"use client";

/**
 * 浏览器舞台 —— 助手在网页里干活时，把它做成**一个窗口**，不是一张会闪的图。
 *
 * 为什么重做（2026-10-20）：
 *   原来只有一张 <img>，帧一帧换一帧：看着闪、不知道它在干嘛、刷新就没了、
 *   手机上一张图顶掉半屏正文。用户原话是「怎么优雅地展示 browser_use 交互」。
 *
 * 三条设计原则：
 *   1. **像窗口**——顶部一条 chrome（地址栏 + 状态），一眼认得出这是浏览器，
 *      地址栏点一下就复制网址，不用去正文里翻。
 *   2. **一直说人话**——底部一行动作字幕（"打开 example.com" → "点击 #kw" →
 *      "读页面内容"），动作来自后端的 browser_action 事件；不知道它在干嘛时，
 *      画面再流畅也只是动画片。
 *   3. **不抢正文**——inline 变体只是一条 96×64 缩略条 + 当前动作，
 *      想看细节点开成面板（桌面居中 / 手机贴底抽屉）；关掉页面后
 *      最后一帧已经存成会话文件，回来还能看见它停在哪儿。
 *
 * 帧缓冲：双层 <img> 交叉淡入 —— 直接换 src 会在两张图之间闪白，很廉价。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserStep } from "@/lib/types";
import { withToken } from "@/lib/api";
import type { BrowserControlState, BrowserStreamState } from "@/lib/api";
import { onFrame, latestFrame } from "@/lib/browser-frame";
import { isImeEvent } from "@/lib/ime";
import { mapToPage, pageDims } from "@/lib/video-map";
import { BrowserRtc, markRtcBad, rtcKnownBad, type RtcStats } from "@/lib/webrtc";
import {
  FpsMeter,
  KEY_BUTTONS,
  keyBody,
  receiptTone,
  shouldStartRtc,
  streamStatusText,
  type KeySpec,
  type StreamFacts,
} from "@/lib/browser-live";

export type BrowserAction = { action: string; summary: string; target?: string; url?: string; at?: number };
export type BrowserFrameData = { data: string; url: string; title: string };

export function hostOf(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0];
  }
}

function prettyUrl(url: string, max = 46): string {
  if (!url) return "未打开";
  const s = url.replace(/^https?:\/\//, "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** 状态 → 颜色（**文字与动作都来自后端**，这里只管视觉） */
const TONE_COLOR: Record<string, string> = {
  live: "var(--color-accent)",
  mine: "var(--color-ok)",
  warn: "var(--color-warn)",
  muted: "var(--color-muted)",
};

function toneColor(control?: BrowserControlState | null): string {
  return TONE_COLOR[control?.tone ?? "muted"] || "var(--color-muted)";
}

/** 顶部 chrome 条：地址栏（点一下复制）+ 状态徽章。不要 macOS 那三个圆点 —— 这里不是窗口，是画面。 */
function ChromeBar({
  url,
  title,
  control,
  onCopy,
  right,
}: {
  url: string;
  title?: string;
  control?: BrowserControlState | null;
  onCopy?: () => void;
  right?: React.ReactNode;
}) {
  const waiting = control?.status === "waiting_user";
  return (
    <div
      className="flex items-center gap-2 rounded-[8px] bg-[var(--color-surface-2)] px-2.5 py-1.5"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
    >
      <button
        type="button"
        onClick={onCopy}
        title={url ? `复制网址：${url}` : "未打开"}
        className="mono min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left text-[11px] hover:bg-[var(--color-surface-3)]"
        style={{ color: "var(--color-muted)" }}
      >
        {waiting ? "需要你操作" : prettyUrl(url)}
        {title ? <span className="ml-1 opacity-60">· {title.slice(0, 24)}</span> : null}
      </button>
      {/* 状态芯片：文字来自后端（和徽章、按钮永远同一句话）—— 别再自己判 busy */}
      {control && control.badge ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px]"
          style={{ color: toneColor(control), background: `color-mix(in srgb, ${toneColor(control)} 12%, transparent)` }}
        >
          <span aria-hidden className="h-[6px] w-[6px] rounded-full" style={{ background: toneColor(control) }} />
          {control.badge}
        </span>
      ) : null}
      {right}
    </div>
  );
}

/**
 * 控制权工具栏 —— **所有尺寸都常驻**（桌面右栏、桌面窗口、手机贴底抽屉都是它）。
 *
 * 一个徽章 + 一个大按钮：agent 态「接管」，user 态「交还给 Agent」。
 * 文案全部来自后端 ``control``（单一状态源），前端不判断 ——
 * 上一版"已暂停但芯片写运行中"就是两处各判各的。
 */
function ControlBar({
  control,
  notice,
  onControl,
  live,
  pulse,
  taking,
  stream,
  onRetry,
}: {
  control?: BrowserControlState | null;
  notice?: string;
  onControl?: (action: "take" | "release") => void;
  /** 这一轮正在跑：即使状态还没同步到前端，也必须给出可点的「接管」 */
  live?: boolean;
  /** 用户被拒时 +1 —— 按钮闪一下，明确告诉他该点这里 */
  pulse?: number;
  /** 接管请求正在等当前原子动作做完（后端软停）—— 按钮必须说"正在停手" */
  taking?: boolean;
  /** 画面链路实测（模式 + fps）—— 用户一眼看出现在是不是流畅模式；**任何一档都带数字** */
  stream?: StreamFacts | null;
  /** 兼容模式下的「切回流畅模式」 */
  onRetry?: () => void;
}) {
  const known = !!control && control.status !== "none";
  const color = toneColor(control);
  // 兜底文案只用于「状态还没到」这一瞬；一旦有状态，全部用后端给的。
  const badge = known ? control!.badge : live ? "助手操作中" : "";
  const hint = known
    ? control!.hint
    : live
      ? "助手正在操作页面 · 点「接管」它做完当前这一步就停手"
      : "";
  const action: "take" | "release" | "" = known ? control!.button_action : live ? "take" : "";
  const label = known ? control!.button : live ? "接管" : "";
  const canTake = action === "take";
  return (
    <>
      {badge ? (
        <div
          data-surface="browser-control"
          className="flex items-center gap-2 px-2.5 py-1.5"
          style={{ background: "var(--color-surface-2)" }}
        >
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[11px]"
            style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
            title={control?.hint}
          >
            <span aria-hidden className="h-[6px] w-[6px] rounded-full" style={{ background: color }} />
            {badge}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: "var(--color-muted)" }}>
            {hint}
          </span>
          {/* 画面链路（实测）：流畅模式带 fps/延迟；回退后写「兼容模式」+ JPEG 实测 fps 并给一个手动切回 */}
          {stream ? (
            stream.mode === "jpeg" ? (
              <span className="flex shrink-0 items-center gap-1">
                <span
                  data-stream-stat
                  title={
                    stream.reason
                      ? `实时视频没连上（${stream.reason}），已自动切回兼容画面 · 数字是这一秒实际收到的 JPEG 帧数`
                      : "兼容画面 · 数字是这一秒实际收到的 JPEG 帧数"
                  }
                  className="rounded-[6px] px-1.5 py-0.5 text-[10.5px] tabular-nums"
                  style={{
                    color: "var(--color-warn)",
                    background: "color-mix(in srgb, var(--color-warn) 14%, transparent)",
                  }}
                >
                  {streamStatusText(stream)}
                </span>
                {onRetry ? (
                  <button
                    type="button"
                    data-tap
                    onClick={onRetry}
                    className="rounded-[6px] px-1.5 py-0.5 text-[10.5px] hover:underline"
                    style={{ color: "var(--color-accent)" }}
                    title="再试一次实时视频（不影响当前操作）"
                  >
                    切回流畅模式
                  </button>
                ) : null}
              </span>
            ) : (
              <span
                data-stream-stat
                title="实时视频（WebRTC）实测值：帧率来自 getStats 的 framesDecoded；延迟 = 抖动缓冲 + RTT/2（估算）"
                className="shrink-0 rounded-[6px] px-1.5 py-0.5 text-[10.5px] tabular-nums"
                style={{
                  color: stream.mode === "webrtc" ? "var(--color-ok)" : "var(--color-muted)",
                  background:
                    stream.mode === "webrtc"
                      ? "color-mix(in srgb, var(--color-ok) 12%, transparent)"
                      : "var(--color-surface-3)",
                }}
              >
                {streamStatusText(stream)}
              </span>
            )
          ) : null}
          {label ? (
            <button
              key={`take-${action}-${pulse ?? 0}`}
              type="button"
              data-tap
              data-browser-take={canTake ? "1" : undefined}
              disabled={canTake && taking}
              onClick={() => onControl?.(action === "take" ? "take" : "release")}
              className={`shrink-0 rounded-[8px] px-3.5 py-2 text-[13px] font-medium ${
                canTake && pulse ? "browser-take-pulse" : ""
              }`}
              style={{
                color: canTake ? "var(--color-accent)" : "var(--color-text)",
                background: canTake
                  ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
                  : "var(--color-surface-3)",
              }}
              title={
                canTake
                  ? "它做完当前这一步就停，画面归你"
                  : "把控制权交回给助手（它会看到你动过什么）"
              }
            >
              {canTake && taking ? "正在停手…" : label}
            </button>
          ) : null}
        </div>
      ) : null}
      {notice ? (
        canTake ? (
          // 横幅里写着「先点接管」—— 那这个词（整条横幅）本身就该能点，
          // 不能让用户读完一句话还得去找按钮。
          <button
            type="button"
            data-tap
            data-surface="browser-notice"
            onClick={() => onControl?.("take")}
            className="block w-full px-2.5 py-1.5 text-left text-[11.5px]"
            style={{
              color: "var(--color-err)",
              background: "color-mix(in srgb, var(--color-err) 10%, var(--color-surface))",
            }}
            title="点这里接管浏览器"
          >
            {notice}
            <span className="ml-1 underline">点这里接管</span>
          </button>
        ) : (
          <div
            data-surface="browser-notice"
            className="px-2.5 py-1.5 text-[11.5px]"
            style={{
              color: "var(--color-err)",
              background: "color-mix(in srgb, var(--color-err) 10%, var(--color-surface))",
            }}
          >
            {notice}
          </div>
        )
      ) : null}
    </>
  );
}

/** 动作字幕：当前动作（亮）+ 之前两条（灰）。一眼看出"它在干什么"。 */
function ActionLine({ actions, control }: { actions: BrowserAction[]; control?: BrowserControlState | null }) {
  const running = control?.status === "agent" && control?.running;
  /** 控制权在用户手上：这时候"最新一行"必须是他刚做的事 —— 点完就有回执。
   *  以前这里被后端状态行（"本轮已结束 · 浏览器还开着…"）压着，用户点了画面
   *  看不到任何新增记录，以为点击没生效（复测现场：全屏点两个元素"无任何回执"）。 */
  const userDriving =
    control?.status === "user" || control?.status === "waiting_user" || control?.status === "paused";
  // 「等你登录」是**状态**，不是一步动作。它留在最新一条时，交还后底部就会和
  // 「助手操作中」并存 —— 复测里那条残留就是这么来的。状态类动作不参与当前行。
  const real = actions.filter((a) => a.action !== "wait_login");
  const last = real[real.length - 1];
  const history = real.slice(-4, -1).reverse();
  const userLast = last && last.action === "user" ? last : null;
  // 当前行优先级：用户在操作 → 他自己刚做的那步；助手在跑 → 实时动作；
  // 其余 → 后端给的状态行（单一真相）→ 动作兜底。
  const current =
    (userDriving && userLast?.summary) ||
    (running && last?.summary) ||
    control?.action_line ||
    last?.summary ||
    (control?.can_click ? "你可以直接操作画面" : "启动中…");

  return (
    <div className="min-w-0 px-2.5 py-1.5" style={{ background: "var(--color-surface-2)" }}>
      <div className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--color-text)" }}>
        <span
          aria-hidden
          className="inline-block h-[6px] w-[6px] shrink-0 rounded-full"
          style={{ background: "var(--color-accent)" }}
        />
        <span className="truncate">{current}</span>
      </div>
      {history.length > 0 && (
        <div className="mt-0.5 truncate text-[10.5px]" style={{ color: "var(--color-muted)" }}>
          {history.map((a, i) => a.summary).join(" · ")}
        </div>
      )}
    </div>
  );
}

export function BrowserStage({
  variant,
  frame,
  actions,
  control,
  notice,
  live,
  sessionId,
  onControl,
  onUserClick,
  onUserText,
  onUserScroll,
  onUserInput,
  onOpen,
  onClose,
  steps,
  onLoadSteps,
}: {
  /** inline = 消息流里的缩略条；panel = 完整窗口 */
  variant: "inline" | "panel";
  frame: BrowserFrameData | null;
  actions: BrowserAction[];
  /** 控制权状态（后端给的唯一真相：徽章/按钮/底部文案都在里面） */
  control?: BrowserControlState | null;
  /** 被拒绝的原因（后端 409 的人话）—— 必须显示出来，不许静默吞掉 */
  notice?: string;
  /** 这一轮正在跑：状态还没同步过来时也要给出可点的「接管」 */
  live?: boolean;
  /** 会话号 —— WebRTC 建连与 DataChannel 输入都挂在会话上 */
  sessionId?: string;
  onControl?: (action: "take" | "release") => void;
  /** 返回值 = 后端那句回执（"已点击 …· 页面没有可见变化"）—— 就地显示 */
  onUserClick?: (x: number, y: number) => void | Promise<unknown>;
  onUserText?: (text: string) => void | Promise<unknown>;
  onUserScroll?: (dy: number) => void | Promise<unknown>;
  /** 任意输入（键盘/滚轮/移动）—— JPEG 兼容模式下也能走 HTTP */
  onUserInput?: (body: Record<string, unknown>) => void | Promise<unknown>;
  onOpen?: () => void;
  onClose?: () => void;
  /** 这次的执行过程（每步一张图）—— 有就出胶片条，能点回看 */
  steps?: BrowserStep[];
  /** 打开面板时拉一次过程 */
  onLoadSteps?: () => void;
}) {
  const busy = control?.status === "agent";
  const waiting = control?.status === "waiting_user";
  /** 只有 user/waiting/paused 三个态能直接操作画面（后端给的口径） */
  const canClick = !!control?.can_click;
  const denyReason =
    control?.denied_hint || "助手正在操作浏览器 —— 先点「接管」，它就停手把画面给你";
  const imgRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rtcRef = useRef<BrowserRtc | null>(null);
  /** 画面链路：off/connecting/live/fallback。fallback 后不自动回跳（用户手动切才重试） */
  const [rtcMode, setRtcMode] = useState<"off" | "connecting" | "live" | "fallback">("off");
  const [rtcReason, setRtcReason] = useState("");
  const [streamStats, setStreamStats] = useState<{ fps: number; latency: number; kbps: number; width: number; height: number } | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [videoReady, setVideoReady] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  /** JPEG 通道实测 fps（1 秒滑动窗口）—— 兼容/连接中都有数字可看，不能只有形容词 */
  const meterRef = useRef(new FpsMeter());
  const [jpegFps, setJpegFps] = useState(0);
  /** 视频轨可能比 <video> 挂载先到：先收在 ref 里，元素一挂上就接上 */
  const streamRef = useRef<MediaStream | null>(null);
  const [thumb, setThumb] = useState("");
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const scrollAt = useRef(0);
  /* 就地反馈：非 user 态下的任何操作都要**当场**说清"现在谁在操作、要先点接管"。
     只在横幅里说一次不够 —— 用户点在画面上，眼睛就在那儿。 */
  const [feedback, setFeedback] = useState<{ text: string; x: number; y: number; w: number; h: number; tone: "err" | "ok" } | null>(null);
  /** 被拒时 +1：按钮闪一下（key 变化让动画重放） */
  const [pulse, setPulse] = useState(0);
  /** 接管已点、后端还在等当前原子动作做完 —— 按钮上说清"正在停手"，不许看起来没反应 */
  const [taking, setTaking] = useState(false);
  useEffect(() => {
    if (!taking) return;
    if (control?.status === "user" || control?.status === "waiting_user" || control?.status === "closed") {
      setTaking(false);
    }
  }, [control?.status, taking]);
  useEffect(() => {
    if (!taking) return;
    const t = setTimeout(() => setTaking(false), 12000);
    return () => clearTimeout(t);
  }, [taking]);
  const fbTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  /** 画面区的实时尺寸（反馈气泡要留在可见范围内，不许被 overflow-hidden 裁掉） */
  const stageBox = useRef({ w: 320, h: 240 });
  const say = useCallback((msg: string, at?: { x: number; y: number } | null, tone: "err" | "ok" = "err") => {
    if (!msg) return;
    setFeedback({ text: msg, x: at?.x ?? -1, y: at?.y ?? -1, ...stageBox.current, tone });
    if (fbTimer.current) clearTimeout(fbTimer.current);
    fbTimer.current = setTimeout(() => setFeedback(null), 5200);
  }, []);
  const denied = useCallback(
    (msg?: string, at?: { x: number; y: number } | null) => {
      say(msg || denyReason, at ?? lastPoint.current);
      setPulse((n) => n + 1);
    },
    [say, denyReason],
  );
  // 后端的 409 人话也要显示在**操作发生的位置**（不只是顶上那条横幅）
  useEffect(() => {
    if (notice) denied(notice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice]);
  /**
   * HTTP 回退路径的回执 —— 兼容模式（JPEG）下点击/输入都走 HTTP，后端 200 里带的
   * `feedback` 就是"这一步到底成没成"。以前这条回执被丢掉，用户只能看画面猜；
   * 现在一律摆到操作发生的位置上（成功绿、失败红）。
   */
  const withFeedback = useCallback(
    (ret: unknown, at?: { x: number; y: number } | null) => {
      if (!ret || typeof (ret as Promise<unknown>).then !== "function") return;
      (ret as Promise<unknown>)
        .then((fb) => {
          const msg = typeof fb === "string" ? fb.trim() : "";
          if (!msg) return;
          say(msg, at ?? lastPoint.current, receiptTone(msg));
        })
        .catch(() => {
          /* 网络失败已在调用方 setNotice */
        });
    },
    [say],
  );
  useEffect(() => {
    return () => {
      if (fbTimer.current) clearTimeout(fbTimer.current);
    };
  }, []);
  /* 回看某一步：画面切到那一步的截图，地址栏/字幕跟着变；点「回到最新」恢复直播 */
  const [viewStep, setViewStep] = useState<BrowserStep | null>(null);
  /* 当前显示的是「历史步骤截图」还是实时画面。
     ⚠ 只在**还没有实时帧**时才回落到最后一步；而且这个值**不许再反过来当 WebRTC 的门** ——
     旧版 `if (!hasFrame && !frame) return` 与它构成环：显示历史 → 实时 <img> 不渲染 →
     imgRef 为 null → 帧回调提前 return → hasFrame 永假 → 永远显示历史、永不建连。 */
  const shown = viewStep ?? (!hasFrame && !frame && steps && steps.length > 0 ? steps[steps.length - 1] : null);
  useEffect(() => {
    if (variant === "panel" && onLoadSteps) onLoadSteps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant]);

  // 帧直达 <img>：走广播通道 + rAF 合并，全程不进 React state。
  // 之前每帧 setState 一次，屏幕一动整个对话树跟着重渲染，就是卡顿的根。
  useEffect(() => {
    let raf = 0;
    let pending = "";
    const apply = () => {
      raf = 0;
      if (!pending) return;
      const img = imgRef.current;
      if (img) img.src = `data:image/jpeg;base64,${pending}`;
      // 「收到过实时帧」由**事件**置位，不依赖这一帧有没有写进 DOM：
      // 写不进去（正在回看历史步骤、元素还没挂上）也不能把 WebRTC 的门锁死。
      setHasFrame(true);
    };
    const sub = onFrame((f) => {
      pending = f.data;
      meterRef.current.push(performance.now());
      if (raf) return;
      raf = requestAnimationFrame(apply);
    });
    const lf = latestFrame();
    if (lf) {
      pending = lf.data;
      apply();
    }
    return () => {
      sub();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  /* 面板状态区每秒刷一次「这一秒实际收到几帧 JPEG」——兼容模式/连接中都有数字可看 */
  useEffect(() => {
    if (variant !== "panel") return;
    const tick = () => setJpegFps(meterRef.current.fps(performance.now()));
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [variant]);

  /* ── WebRTC 主链路 ────────────────────────────────────────────────────
     面板打开、浏览器还活着就先试实时视频。失败只**报给 UI**（切兼容模式），
     绝不自动重试；用户点「切回流畅模式」才再来一次（retryToken）。 */
  const browserLive =
    !!control && control.status !== "none" && control.status !== "closed" && control.alive !== false;
  useEffect(() => {
    if (!sessionId) return;
    // 门只看三样：面板打开、会话有活浏览器、这个会话没被判定过连不上。
    // 画面状态（hasFrame / frame / 是否在回看历史）只作为诊断参数传进去，**不参与判定** ——
    // 旧版在这里判 hasFrame，于是"有历史步骤、暂无实时帧"的会话永远不发 webrtc/config。
    const decision = shouldStartRtc({
      variant,
      sessionId,
      browserLive,
      knownBad: rtcKnownBad(sessionId),
      retryToken,
      hasFrame,
      hasSnapshotFrame: !!frame,
      showingHistory: !!shown,
    });
    if (decision === "skip") return;
    if (decision === "fallback") {
      setRtcMode("fallback");
      return;
    }
    let dead = false;
    let rtc: BrowserRtc | null = null;
    setVideoReady(false);
    setRtcMode("connecting");
    setRtcReason("");
    void (async () => {
      try {
        rtc = await BrowserRtc.start(sessionId, {
          onTrack: (s) => {
            if (dead) return;
            // 视频轨可能比 <video> 挂载先到（连接中才渲染它）——先收进 ref，
            // 元素挂上后由下面的 effect 接上，不能让 track 在这一拍丢。
            streamRef.current = s;
            const v = videoRef.current;
            if (!v) return;
            v.srcObject = s;
            void v.play().catch(() => {});
          },
          onOpen: () => {
            if (!dead) setRtcMode("live");
          },
          onFatal: (reason) => {
            if (dead) return;
            setRtcMode("fallback");
            setRtcReason(reason);
            // 画面链路的失败要**当场**说一句人话：只改徽章的话，用户以为画面卡了
            say(`推流启动失败，已切回兼容画面${reason ? `（${reason}）` : ""}`, null);
            setStreamStats(null);
            streamRef.current = null;
            markRtcBad(sessionId, true);
          },
          onMessage: (m) => {
            if (dead) return;
            if (m.type === "denied") denied(m.reason);
            else {
              // ack 里的 feedback 可能是失败（"✗ 文字没进页面输入框…"）—— 语气按内容判，
              // 不能一律绿色，否则"没打进去"看着像成功
              const text = String(m.feedback || m.note || "已送达");
              say(text, lastPoint.current, receiptTone(text));
            }
          },
          onStats: (s) => {
            if (dead) return;
            setRtcMode("live");
            setStreamStats({ fps: s.fps, latency: s.latencyMs, kbps: s.kbps, width: s.width, height: s.height });
          },
        });
        if (dead) {
          rtc.dispose();
          return;
        }
        rtcRef.current = rtc;
      } catch (e) {
        if (dead) return;
        const reason = e instanceof Error ? e.message : String(e);
        setRtcMode("fallback");
        setRtcReason(reason);
        markRtcBad(sessionId, true);
      }
    })();
    return () => {
      dead = true;
      rtc?.dispose();
      if (rtcRef.current === rtc) rtcRef.current = null;
      streamRef.current = null;
    };
    // hasFrame / frame / shown 不在依赖里：它们只做诊断，变了也不该重建连接
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, sessionId, browserLive, retryToken]);

  /* <video> 挂上（rtcMode 变 connecting/live）时把已到手的视频轨接上去 */
  useEffect(() => {
    const v = videoRef.current;
    const s = streamRef.current;
    if (!v || !s || v.srcObject === s) return;
    v.srcObject = s;
    void v.play().catch(() => {});
  }, [rtcMode]);

  const retryRtc = useCallback(() => {
    if (!sessionId) return;
    markRtcBad(sessionId, false);
    setRtcMode("connecting");
    setRetryToken((n) => n + 1);
  }, [sessionId]);

  // 缩略条没必要跟满帧率：半秒一张足够看出它在干嘛
  useEffect(() => {
    if (variant !== "inline") return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const sub = onFrame((f) => {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        setThumb(f.data);
      }, 400);
    });
    const lf = latestFrame();
    if (lf) setThumb(lf.data);
    return () => {
      sub();
      if (t) clearTimeout(t);
    };
  }, [variant]);

  const copyUrl = async () => {
    if (!frame?.url) return;
    try {
      await navigator.clipboard.writeText(frame.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* 内网 http 下剪贴板不可用时静默（选中地址栏文本复制即可） */
    }
  };

  /** 当前画面的原始尺寸（视频轨优先；JPEG 用图片自身的 natural 尺寸） */
  const naturalSize = (): { w: number; h: number } => {
    const v = videoRef.current;
    if (rtcMode === "live" && v && v.videoWidth > 0) return pageDims(v.videoWidth, v.videoHeight, control?.viewport);
    const im = imgRef.current;
    if (im && im.naturalWidth > 0) return pageDims(im.naturalWidth, im.naturalHeight, control?.viewport);
    return control?.viewport ? { w: control.viewport.width, h: control.viewport.height } : { w: 1280, h: 800 };
  };

  /**
   * 点画面。三种情况都要有反应：
   *  · 能操作（user/waiting/paused）→ 按**实际内容区**换算坐标后发出去；
   *  · 正在回看历史步骤 → 说清"这不是实时画面"，能操作就切回来；
   *  · 非 user 态 → 当场说"谁在操作 + 先点接管"，并把接管按钮闪一下。
   */
  const handleStageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    stageBox.current = { w: rect.width, h: rect.height };
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    // 反馈气泡留在画面里（贴底/贴边时也可见；渲染时再按容器尺寸夹一次）
    const at = { x: px, y: Math.min(py, Math.max(8, rect.height - 72)) };
    lastPoint.current = at;
    // 点画面就把键盘焦点收过来（否则方向键/Tab 作用不到网页上）
    try {
      e.currentTarget.focus({ preventScroll: true });
    } catch {
      /* 老浏览器不支持 focus 选项 */
    }
    if (shown) {
      if (canClick) {
        setViewStep(null);
        say("已切回实时画面，再点一次就能直接操作");
      } else {
        denied(
          control && control.status !== "none"
            ? `正在回看第 ${shown.n} 步（不是实时画面）· ${denyReason}`
            : `正在回看第 ${shown.n} 步（不是实时画面）· 点「回到最新」看直播`,
          at,
        );
      }
      return;
    }
    if (!hasFrame && rtcMode !== "live") {
      say("画面还没出来 —— 等它打开网页再操作", at);
      return;
    }
    // object-contain：扣除留白，任何宽高比都零偏移（旧实现写死 800×600）
    const nat = naturalSize();
    const p = mapToPage(px, py, rect.width, rect.height, nat.w, nat.h);
    if (!p.inside) {
      say("点到画面外的留白（不是网页内容）", at);
      return;
    }
    if (control && control.status !== "none" && !canClick) {
      denied(undefined, at);
      return;
    }
    if (!onUserClick && !rtcRef.current?.isOpen) return;
    // DataChannel 优先；没建连（兼容模式）走 HTTP。
    // coords:"page" = 这是**页面坐标**（已按 viewport 折算），服务端别再按档位换算。
    if (
      rtcRef.current?.send({
        kind: "click",
        x: p.x,
        y: p.y,
        button: "left",
        clickCount: e.detail || 1,
        coords: "page",
      })
    ) {
      return;
    }
    // HTTP 那条路也要有回执：后端 200 里带 feedback（"已点击 …· 页面没有可见变化"）
    void withFeedback(onUserClick?.(p.x, p.y), at);
  };

  const moveAt = useRef(0);
  /** 鼠标移动只走 DataChannel（HTTP 每秒几十次会打爆服务端）—— 悬停/拖拽需要它 */
  const handleStageMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canClick || shown) return;
    const rtc = rtcRef.current;
    if (!rtc?.isOpen) return;
    const now = performance.now();
    if (now - moveAt.current < 45) return;
    moveAt.current = now;
    const rect = e.currentTarget.getBoundingClientRect();
    const nat = naturalSize();
    const p = mapToPage(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, nat.w, nat.h);
    if (!p.inside) return;
    rtc.send({ kind: "move", x: p.x, y: p.y, coords: "page" });
  };

  /** 键盘：给网页真实按键（Enter 提交、Tab 走焦点、Backspace 删字、Ctrl+A 全选…） */
  const handleStageKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeEvent(e)) return;
    if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
    if (shown) return;
    if (!canClick) {
      denied(undefined, lastPoint.current);
      e.preventDefault();
      return;
    }
    // 不让浏览器把这些键用去滚动/切焦点（Tab 不能把焦点带出画面）
    e.preventDefault();
    const body = {
      kind: "key",
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      repeat: e.repeat,
      location: e.location,
    };
    if (!rtcRef.current?.send(body)) void onUserInput?.(body);
  };

  /** 面板上的常用按键（触屏没有键盘）：与键盘事件走同一条 DataChannel / HTTP 通路 */
  const sendKey = (spec: KeySpec) => {
    if (shown) {
      say("正在回看历史步骤 · 点「回到最新」后按键才作用于实时画面", lastPoint.current);
      return;
    }
    if (control && control.status !== "none" && !canClick) {
      denied(undefined, lastPoint.current);
      return;
    }
    const body = keyBody(spec);
    if (!rtcRef.current?.send(body)) void onUserInput?.(body);
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (shown) {
      const rect = e.currentTarget.getBoundingClientRect();
      stageBox.current = { w: rect.width, h: rect.height };
      const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      lastPoint.current = at;
      say(
        canClick
          ? "正在回看历史步骤 · 点「回到最新」后滚动才作用于实时画面"
          : `正在回看历史步骤（不是实时画面）· 先点「接管」再看直播`,
        at,
      );
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    stageBox.current = { w: rect.width, h: rect.height };
    const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    lastPoint.current = at;
    if (control && control.status !== "none" && !canClick) {
      denied(undefined, at);
      return;
    }
    const now = Date.now();
    if (now - scrollAt.current < 60) return;
    scrollAt.current = now;
    const nat = naturalSize();
    const p = mapToPage(at.x, at.y, rect.width, rect.height, nat.w, nat.h);
    if (
      rtcRef.current?.send({
        kind: "wheel",
        x: p.inside ? p.x : nat.w / 2,
        y: p.inside ? p.y : nat.h / 2,
        dx: e.deltaX,
        dy: e.deltaY,
        coords: "page",
      })
    ) {
      return;
    }
    if (!onUserScroll) return;
    void withFeedback(onUserScroll(Math.round(e.deltaY)), at);
  };

  const requestControl = (a: "take" | "release") => {
    if (a === "take") setTaking(true);
    onControl?.(a);
  };

  // 状态类伪动作（wait_login）不参与"当前这一行" —— 见 ActionLine 里同一处理
  const realActions = actions.filter((a) => a.action !== "wait_login");
  const last = realActions[realActions.length - 1];

  /* ── 缩略条（消息流内） ───────────────────────────────────────────── */
  if (variant === "inline") {
    /* 刷新之后没有内存帧了 —— 用留档的最后一步当封面，别让入口消失 */
    const lastStep = steps && steps.length > 0 ? steps[steps.length - 1] : null;
    const thumbSrc = thumb
      ? `data:image/jpeg;base64,${thumb}`
      : lastStep?.url_file
        ? withToken(lastStep.url_file)
        : "";
    const count = control?.step_count ?? steps?.length ?? 0;
    const stepLabel = control?.step_label || (count > 0 ? `本轮 ${count} 步` : "");
    const running = control?.status === "agent" && control?.running;
    const line =
      running
        ? (last?.summary ?? lastStep?.summary ?? "准备中…")
        : (control?.action_line || last?.summary || lastStep?.summary || "准备中…");
    const takeLabel = control?.button || (live ? "接管" : "");
    const takeAction: "take" | "release" =
      control?.button_action === "release" ? "release" : "take";
    return (
      <div className="my-1.5 w-full">
        {/* 消息流里的这张卡也要显示被拒绝的原因：接管按钮点了没成，只留一句沉默
            等于又回到"点了没反应"。整条可点 = 直接再试一次接管。 */}
        {notice ? (
          <button
            type="button"
            data-tap
            data-surface="browser-notice"
            onClick={() => requestControl("take")}
            className="mb-1 block w-full rounded-[var(--radius-sm)] px-2 py-1 text-left text-[11px]"
            style={{
              color: "var(--color-err)",
              background: "color-mix(in srgb, var(--color-err) 10%, var(--color-surface))",
            }}
          >
            {notice}
            {takeAction === "take" ? <span className="ml-1 underline">点这里接管</span> : null}
          </button>
        ) : null}
        <div
          className="flex w-full items-center gap-2 rounded-[var(--radius-lg)] border px-2 py-1.5"
          style={{ borderColor: "var(--color-border-strong)", background: "var(--color-surface-3)" }}
        >
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          title="看画面与步骤"
        >
          <span
            className="relative h-[54px] w-[80px] shrink-0 overflow-hidden rounded-md border"
            style={{ borderColor: "var(--color-border-strong)", background: "var(--color-surface)" }}
          >
            {thumbSrc ? (
              <img
                src={thumbSrc}
                alt=""
                className="h-full w-full object-cover object-top"
                draggable={false}
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[10px]" style={{ color: "var(--color-muted)" }}>
                无画面
              </span>
            )}
            {busy && !waiting ? (
              <span
                aria-hidden
                className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full live-dot"
                style={{ background: "var(--color-accent)" }}
              />
            ) : null}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
                <circle cx="12" cy="12" r="9" />
                <path d="M3 9h18M9 3c-2 3-2 15 0 18M15 3c2 3 2 15 0 18" />
              </svg>
              <span className="truncate text-[12px]" style={{ color: "var(--color-text)" }}>
                {hostOf(frame?.url || lastStep?.url || "") || "浏览器"}
              </span>
              <span
                className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px]"
                style={{
                  color: control?.badge ? toneColor(control) : "var(--color-text-3)",
                  background: control?.badge
                    ? `color-mix(in srgb, ${toneColor(control)} 12%, transparent)`
                    : "var(--color-surface-2)",
                }}
              >
                {control?.badge || (live ? "助手操作中" : "浏览器")}
              </span>
              {stepLabel ? (
                <span className="shrink-0 text-[10.5px]" style={{ color: "var(--color-muted)" }}>
                  {stepLabel}
                </span>
              ) : null}
            </span>
            <span className="mt-0.5 block truncate text-[11px]" style={{ color: "var(--color-muted)" }}>
              {line}
            </span>
          </span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0" style={{ color: "var(--color-muted)" }}>
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
        {/* 缩略条上也要有可点的接管 —— 位置固定在右侧，文案与面板同一个来源 */}
        {takeLabel ? (
          <button
            key={`inline-take-${takeAction}-${pulse}`}
            type="button"
            data-tap
            data-browser-take={takeAction === "take" ? "1" : undefined}
            disabled={takeAction === "take" && taking}
            onClick={() => requestControl(takeAction)}
            className={`shrink-0 rounded-[8px] px-2.5 py-1.5 text-[12px] font-medium ${
              takeAction === "take" && pulse ? "browser-take-pulse" : ""
            }`}
            style={{
              color: takeAction === "take" ? "var(--color-accent)" : "var(--color-text)",
              background:
                takeAction === "take"
                  ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
                  : "var(--color-surface-2)",
            }}
          >
            {takeAction === "take" && taking ? "正在停手…" : takeLabel}
          </button>
        ) : null}
        </div>
      </div>
    );
  }

  /* ── 完整窗口（面板 / 抽屉） ──────────────────────────────────────── */
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <ChromeBar
        url={shown ? shown.url : frame?.url ?? ""}
        title={shown ? shown.title : frame?.title}
        control={control}
        onCopy={copyUrl}
        right={
          <span className="flex shrink-0 items-center gap-2">
            {copied ? <span className="text-[10.5px]" style={{ color: "var(--color-ok)" }}>已复制</span> : null}
            {onClose ? (
              <button
                type="button"
                onClick={onClose}
                className="rounded px-1 text-[11px] hover:underline"
                style={{ color: "var(--color-muted)" }}
              >
                收起
              </button>
            ) : null}
          </span>
        }
      />

      {/* 控制权：所有尺寸常驻（徽章 + 一个大按钮），文案全来自后端。
          状态还没到时（第一轮刚起来）也有兜底的「接管」—— 以前这一瞬什么都没有。 */}
      <ControlBar
        control={control}
        notice={notice}
        onControl={requestControl}
        live={live}
        pulse={pulse}
        taking={taking}
        stream={
          rtcMode === "fallback"
            ? { mode: "jpeg", fps: 0, jpegFps, reason: rtcReason }
            : rtcMode === "live" || rtcMode === "connecting" || streamStats
              ? {
                  mode: "webrtc",
                  fps: streamStats?.fps ?? 0,
                  latency: streamStats?.latency,
                  connecting: rtcMode === "connecting",
                  jpegFps,
                  reason: rtcReason,
                }
              : { mode: "idle", fps: 0, jpegFps }
        }
        onRetry={rtcMode === "fallback" && sessionId ? retryRtc : undefined}
      />

      <div
        className="relative min-h-0 flex-1 overflow-hidden outline-none"
        onWheel={handleWheel}
        onClick={handleStageClick}
        onMouseMove={handleStageMove}
        onKeyDown={handleStageKey}
        tabIndex={canClick ? 0 : -1}
        aria-label="浏览器画面（点一下可键盘操作）"
        style={{ background: "var(--color-video-bg)" }}
      >
        {/* 实时层**常驻挂载**：video 与 JPEG <img> 一直在 DOM 里，回看历史步骤时截图只是盖在上面。
            以前实时元素写在 !shown 分支里 —— 显示历史时 imgRef 为 null，帧回调提前 return，
            hasFrame 永假，于是画面永远停在历史截图、WebRTC 永远不启动。 */}
        <video
          ref={videoRef}
          className="pointer-events-none absolute inset-0 h-full w-full object-contain object-top select-none"
          style={{ opacity: rtcMode === "live" ? 1 : 0 }}
          autoPlay
          playsInline
          muted
          draggable={false}
          onLoadedData={() => setVideoReady(true)}
          onPlaying={() => setVideoReady(true)}
        />
        <img
          ref={imgRef}
          alt={frame?.title || "浏览器画面"}
          className="absolute inset-0 block h-full w-full cursor-crosshair object-contain object-top select-none"
          style={{ opacity: hasFrame && !(rtcMode === "live" && videoReady) && !shown ? 1 : 0 }}
          draggable={false}
        />
        {rtcMode === "connecting" ? (
          <div
            className="pointer-events-none absolute left-1/2 top-2 z-[2] -translate-x-1/2 rounded-full px-2.5 py-1 text-[11px]"
            style={{ background: "rgba(15,23,42,0.72)", color: "#fff" }}
          >
            正在连接流畅模式…
          </div>
        ) : null}
        {hasFrame || rtcMode === "live" || shown ? null : (
          <div className="flex h-full min-h-[160px] items-center justify-center text-[12px]" style={{ color: "var(--color-text-3)" }}>
            还未打开网页
          </div>
        )}
        {/* 回看某一步：截图盖在实时层上（这是显式选择，不代表实时画面不存在） */}
        {shown ? (
          <img
            src={withToken(shown.url_file)}
            alt={shown.summary}
            className="absolute inset-0 z-[1] h-full w-full object-contain object-top select-none"
            style={{ background: "var(--color-video-bg)" }}
            draggable={false}
          />
        ) : null}
        {waiting && (hasFrame || rtcMode === "live") ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 z-[2] rounded-[2px]"
            style={{ boxShadow: "inset 0 0 0 2px var(--color-warn)" }}
          />
        ) : null}
        {/* 就地反馈：点在哪儿就在哪儿说（滚动的反馈贴在底部中央） */}
        {feedback ? (
          <div
            role="status"
            aria-live="polite"
            data-surface="browser-inline-feedback"
            className="pointer-events-none absolute z-10 max-w-[88%] rounded-[8px] px-2.5 py-1.5 text-[12px] leading-snug shadow-lg"
            style={{
              left: feedback.x >= 0 ? Math.min(Math.max(feedback.x + 8, 8), Math.max(8, feedback.w - 248)) : 12,
              top: feedback.x >= 0 ? Math.min(Math.max(feedback.y + 8, 8), Math.max(8, feedback.h - 92)) : undefined,
              bottom: feedback.x >= 0 ? undefined : 12,
              color: feedback.tone === "ok" ? "var(--color-ok)" : "var(--color-err)",
              background: "var(--color-surface)",
              border: `1px solid color-mix(in srgb, ${feedback.tone === "ok" ? "var(--color-ok)" : "var(--color-err)"} 35%, transparent)`,
            }}
          >
            {feedback.text}
          </div>
        ) : null}
      </div>

      {/* 常用按键：触屏没有键盘，Enter/Tab/Esc 以前无处可点（点了搜索框也只能打字不能提交） */}
      {onUserInput ? (
        <div
          className="flex flex-wrap items-center gap-1.5 px-2.5 py-1.5"
          style={{ background: "var(--color-surface-2)" }}
        >
          <span className="shrink-0 text-[10.5px]" style={{ color: "var(--color-muted)" }}>
            按键
          </span>
          {KEY_BUTTONS.map((k) => (
            <button
              key={k.key}
              type="button"
              data-tap
              data-key-button={k.key}
              onClick={() => sendKey(k)}
              title={k.title}
              className="h-[30px] min-w-[44px] rounded-[7px] px-2 text-[11.5px] max-md:h-[44px]"
              style={{ color: "var(--color-text-2)", background: "var(--color-surface-3)" }}
            >
              {k.label}
            </button>
          ))}
        </div>
      ) : null}

      {shown ? (
        <div className="flex items-center gap-2 px-2.5 py-1.5" style={{ background: "var(--color-surface-2)" }}>
          <span className="text-[11.5px]" style={{ color: "var(--color-text)" }}>
            第 {shown.n} 步 · {shown.summary}
          </span>
          <span className="truncate text-[10.5px]" style={{ color: "var(--color-muted)" }}>
            {shown.url}
          </span>
          {hasFrame || frame ? (
            <button
              type="button"
              onClick={() => setViewStep(null)}
              className="ml-auto shrink-0 rounded px-1 text-[11px] hover:underline"
              style={{ color: "var(--color-accent)" }}
            >
              回到最新
            </button>
          ) : null}
        </div>
      ) : (
        <ActionLine actions={actions} control={control} />
      )}

      {/* 过程胶片：每步一张小图，点一下回看当时那一屏 —— 复盘"哪步走错了"靠它 */}
      {steps && steps.length > 0 ? (
        <div
          className="flex shrink-0 items-center gap-1.5 overflow-x-auto px-2 py-1.5"
          style={{ background: "var(--color-surface-3)", borderTop: "1px solid var(--color-border)" }}
        >
          <span className="shrink-0 text-[10.5px]" style={{ color: "var(--color-muted)" }}>
            {control?.step_label || `过程 ${steps.length} 步`}
          </span>
          {steps.map((st) => (
            <button
              key={st.n}
              type="button"
              onClick={() => setViewStep(st)}
              title={`第 ${st.n} 步 · ${st.summary}`}
              className="relative h-[34px] w-[56px] shrink-0 overflow-hidden rounded border"
              style={{
                borderColor: shown?.n === st.n ? "var(--color-accent)" : "var(--color-border-strong)",
                background: "var(--color-surface)",
                opacity: st.url_file ? 1 : 0.45,
              }}
            >
              {st.url_file ? (
                <img src={withToken(st.url_file)} alt="" className="h-full w-full object-cover object-top" draggable={false} />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-[10px]" style={{ color: "var(--color-muted)" }}>
                  {st.n}
                </span>
              )}
              <span
                className="absolute bottom-0 left-0 right-0 text-center text-[9px] leading-[10px]"
                style={{ background: "rgba(15,23,42,0.55)", color: "var(--color-accent-contrast)" }}
              >
                {st.n}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {/* 底部一行 = **真实状态**（来自后端）：本轮结束后写"浏览器还开着，你可以继续操作"，
          过期就写"已过期"。以前这里固定写"仅可查看"，可用户明明能看不能点、也没解释。 */}
      {control && control.status !== "none" && control.footer ? (
        <div
          className="px-2.5 py-2 text-[11.5px]"
          style={{
            background: "var(--color-surface)",
            color: control.status === "closed" ? "var(--color-muted)" : "var(--color-text-2)",
          }}
        >
          {control.footer}
        </div>
      ) : null}
      {/* 输入框常驻：非 user 态下也是"能看见、点了会解释"，而不是整条消失。
          以前只在能操作时渲染 —— 用户连"为什么不能打字"都看不到。 */}
      {onUserText ? (
        <div className="flex gap-1.5 px-2.5 py-2" style={{ background: "var(--color-surface)" }}>
          <input
            className="input flex-1 text-[13px]"
            data-surface="browser-input"
            placeholder={
              canClick
                ? "点页面里的输入框，在这里打字，回车送入"
                : "先点「接管」才能输入 —— 现在助手在操作"
            }
            value={text}
            onFocus={() => {
              if (control && control.status !== "none" && !canClick) denied();
            }}
            onChange={(e) => {
              setText(e.target.value);
              if (control && control.status !== "none" && !canClick && e.target.value) denied();
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || isImeEvent(e) || !text) return;
              if (control && control.status !== "none" && !canClick) {
                denied();
                return;
              }
              // 中文输入法整段上屏走 insertText（与键盘直打并存）；DataChannel 通就用它。
              // 后端会回读页面输入框的 value —— 没进去就回一句人话（"✗ 文字没进页面输入框…"），
              // 这里必须把它摆到画面上，不能让用户以为打进去了。
              if (!rtcRef.current?.send({ kind: "text", text })) {
                void withFeedback(onUserText(text), lastPoint.current);
              }
              setText("");
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
