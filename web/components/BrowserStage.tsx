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
import type { BrowserControlState } from "@/lib/api";
import { onFrame, latestFrame } from "@/lib/browser-frame";
import { isImeEvent } from "@/lib/ime";

const VIEW_W = 800;

export type BrowserAction = { action: string; summary: string; target?: string; url?: string };
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
      className="flex items-center gap-2 px-2.5 py-1.5 border-b"
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
  // 「等你登录」是**状态**，不是一步动作。它留在最新一条时，交还后底部就会和
  // 「助手操作中」并存 —— 复测里那条残留就是这么来的。状态类动作不参与当前行。
  const real = actions.filter((a) => a.action !== "wait_login");
  const last = real[real.length - 1];
  const history = real.slice(-4, -1).reverse();
  // 当前行优先级：实时动作（只在助手真的在跑时）→ 后端给的状态行 → 动作兜底。
  // 后端的 action_line 在 agent_running 时是空串（让实时动作说话），其余状态一定有值。
  const current =
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
  onControl,
  onUserClick,
  onUserText,
  onUserScroll,
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
  onControl?: (action: "take" | "release") => void;
  onUserClick?: (x: number, y: number) => void | Promise<void>;
  onUserText?: (text: string) => void | Promise<void>;
  onUserScroll?: (dy: number) => void | Promise<void>;
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
  const [hasFrame, setHasFrame] = useState(false);
  const [thumb, setThumb] = useState("");
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const scrollAt = useRef(0);
  /* 就地反馈：非 user 态下的任何操作都要**当场**说清"现在谁在操作、要先点接管"。
     只在横幅里说一次不够 —— 用户点在画面上，眼睛就在那儿。 */
  const [feedback, setFeedback] = useState<{ text: string; x: number; y: number; w: number; h: number } | null>(null);
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
  const say = useCallback((msg: string, at?: { x: number; y: number } | null) => {
    if (!msg) return;
    setFeedback({ text: msg, x: at?.x ?? -1, y: at?.y ?? -1, ...stageBox.current });
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
  useEffect(() => {
    return () => {
      if (fbTimer.current) clearTimeout(fbTimer.current);
    };
  }, []);
  /* 回看某一步：画面切到那一步的截图，地址栏/字幕跟着变；点「回到最新」恢复直播 */
  const [viewStep, setViewStep] = useState<BrowserStep | null>(null);
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
      const img = imgRef.current;
      if (!img || !pending) return;
      img.src = `data:image/jpeg;base64,${pending}`;
      setHasFrame(true);
    };
    const sub = onFrame((f) => {
      pending = f.data;
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

  /**
   * 点画面。三种情况都要有反应：
   *  · 能操作（user/waiting/paused）→ 换算坐标发给后端；
   *  · 正在回看历史步骤 → 说清"这不是实时画面"，能操作就切回来；
   *  · 非 user 态 → 当场说"谁在操作 + 先点接管"，并把接管按钮闪一下。
   * 以前非 user 态直接 return，用户看到的是"点了没反应也不解释"。
   */
  const handleStageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    stageBox.current = { w: rect.width, h: rect.height };
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    // 反馈气泡留在画面里（贴底/贴边时也可见；渲染时再按容器尺寸夹一次）
    const at = { x: px, y: Math.min(py, Math.max(8, rect.height - 72)) };
    lastPoint.current = at;
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
    if (!hasFrame) {
      say("画面还没出来 —— 等它打开网页再操作", at);
      return;
    }
    // 图片按 object-contain 缩放（4:3）：把屏幕点换算成页面坐标，留白不算点击。
    const iw = VIEW_W;
    const ih = 600;
    const scale = Math.min(rect.width / iw, rect.height / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const ox = (rect.width - dw) / 2;
    const oy = 0; // object-top：竖向贴顶
    if (px < ox || px > ox + dw || py < oy || py > oy + dh) {
      say("点到画面外的留白（不是网页内容）", at);
      return;
    }
    if (control && control.status !== "none" && !canClick) {
      denied(undefined, at);
      return;
    }
    if (!onUserClick) return;
    void onUserClick((px - ox) / scale, (py - oy) / scale);
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!onUserScroll) return;
    const now = Date.now();
    if (now - scrollAt.current < 160) return;
    scrollAt.current = now;
    // 滚动的反馈也贴在**鼠标所在位置**（以前固定贴底，用户以为没反应）
    const rect = e.currentTarget.getBoundingClientRect();
    stageBox.current = { w: rect.width, h: rect.height };
    const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    lastPoint.current = at;
    if (shown) {
      say(
        canClick
          ? "正在回看历史步骤 · 点「回到最新」后滚动才作用于实时画面"
          : `正在回看历史步骤（不是实时画面）· 先点「接管」再看直播`,
        at,
      );
      return;
    }
    if (control && control.status !== "none" && !canClick) {
      denied(undefined, at);
      return;
    }
    void onUserScroll(Math.round(e.deltaY));
  };

  const requestControl = (a: "take" | "release") => {
    if (a === "take") setTaking(true);
    onControl?.(a);
  };

  // 状态类伪动作（wait_login）不参与"当前这一行" —— 见 ActionLine 里同一处理
  const realActions = actions.filter((a) => a.action !== "wait_login");
  const last = realActions[realActions.length - 1];
  /* 没有实时帧（刷新过 / 这轮结束清掉了）时，默认停在这一轮的最后一步 ——
     面板打开就该看见"它最后停在哪一页"，而不是一块空白。 */
  const shown = viewStep ?? (!hasFrame && !frame && steps && steps.length > 0 ? steps[steps.length - 1] : null);

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
      <ControlBar control={control} notice={notice} onControl={requestControl} live={live} pulse={pulse} taking={taking} />

      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        onWheel={handleWheel}
        onClick={handleStageClick}
        style={{ background: "var(--color-video-bg)" }}
      >
        {shown ? (
          <img
            src={withToken(shown.url_file)}
            alt={shown.summary}
            className="absolute inset-0 h-full w-full object-contain object-top select-none"
            draggable={false}
          />
        ) : (
          <>
            <img
              ref={imgRef}
              alt={frame?.title || "浏览器画面"}
              className="absolute inset-0 block h-full w-full cursor-crosshair object-contain object-top select-none"
              style={{ opacity: hasFrame ? 1 : 0 }}
              draggable={false}
            />
            {waiting && hasFrame ? (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-[2px]"
                style={{ boxShadow: "inset 0 0 0 2px var(--color-warn)" }}
              />
            ) : null}
            {hasFrame ? null : (
              <div className="flex h-full min-h-[160px] items-center justify-center text-[12px]" style={{ color: "var(--color-text-3)" }}>
                还未打开网页
              </div>
            )}
          </>
        )}
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
              color: "var(--color-err)",
              background: "var(--color-surface)",
              border: "1px solid color-mix(in srgb, var(--color-err) 35%, transparent)",
            }}
          >
            {feedback.text}
          </div>
        ) : null}
      </div>

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
              void onUserText(text);
              setText("");
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
