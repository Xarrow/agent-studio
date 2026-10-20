"use client";

/**
 * 浏览器舞台 —— 助手在网页里干活时，把它做成**一个窗口**，不是一张会闪的图。
 *
 * 为什么重做（2026-10-20）：
 *   原来只有一张 <img>，帧一帧换一帧：看着闪、不知道它在干嘛、刷新就没了、
 *   手机上一张图顶掉半屏正文。用户原话是「怎么优雅地展示 browser_use 交互」。
 *
 * 三条设计原则：
 *   1. **像窗口**——顶部一条 chrome（三个点 + 地址栏），一眼认得出这是浏览器，
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

import { useEffect, useRef, useState } from "react";
import type { BrowserStep } from "@/lib/types";
import { withToken } from "@/lib/api";
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
  if (!url) return "还没打开页面";
  const s = url.replace(/^https?:\/\//, "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** 顶部 chrome 条：三个点 + 地址栏（点一下复制）+ 右侧状态 */
function ChromeBar({
  url,
  title,
  busy,
  waiting,
  onCopy,
  right,
}: {
  url: string;
  title?: string;
  busy?: boolean;
  waiting?: boolean;
  onCopy?: () => void;
  right?: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1.5 border-b"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
    >
      <span className="flex shrink-0 items-center gap-1" aria-hidden>
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
          <span key={c} className="h-[7px] w-[7px] rounded-full" style={{ background: c, opacity: 0.85 }} />
        ))}
      </span>
      <button
        type="button"
        onClick={onCopy}
        title={url ? `点击复制：${url}` : "还没打开页面"}
        className="mono min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left text-[11px] hover:bg-[var(--color-surface-3)]"
        style={{ color: "var(--color-muted)" }}
      >
        {waiting ? "需要你操作" : prettyUrl(url)}
        {title ? <span className="ml-1 opacity-60">· {title.slice(0, 24)}</span> : null}
      </button>
      <span className="shrink-0">
        {busy && !waiting ? (
          <span className="inline-flex items-center gap-1 text-[10.5px]" style={{ color: "var(--color-accent)" }}>
            <span className="live-dot">●</span> 运行中
          </span>
        ) : null}
      </span>
      {right}
    </div>
  );
}

/** 动作字幕：当前动作（亮）+ 之前两条（灰）。一眼看出"它在干什么"。 */
function ActionLine({ actions }: { actions: BrowserAction[] }) {
  const last = actions[actions.length - 1];
  const history = actions.slice(-4, -1).reverse();
  return (
    <div className="min-w-0 px-2.5 py-1.5" style={{ background: "var(--color-surface-2)" }}>
      <div className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--color-text)" }}>
        <span
          aria-hidden
          className="inline-block h-[6px] w-[6px] shrink-0 rounded-full"
          style={{ background: "var(--color-accent)" }}
        />
        <span className="truncate">{last ? last.summary : "启动浏览器…"}</span>
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
  busy,
  waiting,
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
  busy?: boolean;
  /** 等用户登录 / 点确认 */
  waiting?: boolean;
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
  const imgRef = useRef<HTMLImageElement>(null);
  const [cur, setCur] = useState<string>("");
  const [prev, setPrev] = useState<string>("");
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const scrollAt = useRef(0);
  /* 回看某一步：画面切到那一步的截图，地址栏/字幕跟着变；点「回到最新」恢复直播 */
  const [viewStep, setViewStep] = useState<BrowserStep | null>(null);
  useEffect(() => {
    if (variant === "panel" && onLoadSteps) onLoadSteps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant]);

  // 双层缓冲：新帧先在隐藏层加载完，再淡入，避免两张图之间闪白
  useEffect(() => {
    const next = frame?.data ?? "";
    if (!next || next === cur) return;
    setPrev(cur);
    setCur(next);
  }, [frame?.data, cur]);

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

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const img = imgRef.current;
    if (!img || !onUserClick || !cur) return;
    const rect = img.getBoundingClientRect();
    const scale = VIEW_W / rect.width;
    void onUserClick((e.clientX - rect.left) * scale, (e.clientY - rect.top) * scale);
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!onUserScroll) return;
    const now = Date.now();
    if (now - scrollAt.current < 120) return;
    scrollAt.current = now;
    void onUserScroll(Math.round(e.deltaY));
  };

  const last = actions[actions.length - 1];
  /* 没有实时帧（刷新过 / 这轮结束清掉了）时，默认停在这一轮的最后一步 ——
     面板打开就该看见"它最后停在哪一页"，而不是一块空白。 */
  const shown = viewStep ?? (!cur && steps && steps.length > 0 ? steps[steps.length - 1] : null);

  /* ── 缩略条（消息流内） ───────────────────────────────────────────── */
  if (variant === "inline") {
    /* 刷新之后没有内存帧了 —— 用留档的最后一步当封面，别让入口消失 */
    const lastStep = steps && steps.length > 0 ? steps[steps.length - 1] : null;
    const thumbSrc = cur
      ? `data:image/jpeg;base64,${cur}`
      : lastStep?.url_file
        ? withToken(lastStep.url_file)
        : "";
    const count = actions.length || (steps?.length ?? 0);
    return (
      <button
        type="button"
        onClick={onOpen}
        className="my-1.5 flex w-full max-w-[88%] items-center gap-2.5 rounded-[12px] border px-2 py-1.5 text-left max-md:max-w-[92%]"
        style={{ borderColor: "var(--color-border-strong)", background: "var(--color-surface-3)" }}
        title="点开看浏览器画面和它每一步在干什么"
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
              等待画面
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
              {waiting ? "需要你在画面里操作" : hostOf(frame?.url || lastStep?.url || "") || "浏览器"}
            </span>
            {count > 0 ? (
              <span className="shrink-0 text-[10.5px]" style={{ color: "var(--color-muted)" }}>
                {count} 步
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block truncate text-[11px]" style={{ color: "var(--color-muted)" }}>
            {waiting
              ? "登录要你自己来，账号密码不进模型"
              : last?.summary ?? lastStep?.summary ?? "准备中…"}
          </span>
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0" style={{ color: "var(--color-muted)" }}>
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>
    );
  }

  /* ── 完整窗口（面板 / 抽屉） ──────────────────────────────────────── */
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <ChromeBar
        url={shown ? shown.url : frame?.url ?? ""}
        title={shown ? shown.title : frame?.title}
        busy={busy}
        waiting={waiting}
        onCopy={copyUrl}
        right={
          <span className="flex shrink-0 items-center gap-2">
            {copied ? <span className="text-[10.5px]" style={{ color: "var(--color-ok, #047857)" }}>已复制</span> : null}
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

      {waiting ? (
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 text-[11px]"
          style={{ background: "color-mix(in srgb, #b45309 10%, var(--color-surface))", color: "#b45309" }}
        >
          <span className="live-dot">●</span> 需要你在这里登录 / 确认 —— 助手暂停等你，完成后会自动继续
        </div>
      ) : null}

      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        onWheel={shown ? undefined : handleWheel}
        style={{ background: "#0b1220" }}
      >
        {shown ? (
          <img
            src={withToken(shown.url_file)}
            alt={shown.summary}
            className="absolute inset-0 h-full w-full object-contain"
            draggable={false}
          />
        ) : cur ? (
          <>
            {prev ? (
              <img
                src={`data:image/jpeg;base64,${prev}`}
                alt=""
                aria-hidden
                className="absolute inset-0 h-full w-full object-contain opacity-0"
                draggable={false}
              />
            ) : null}
            <img
              ref={imgRef}
              src={`data:image/jpeg;base64,${cur}`}
              alt={frame?.title || "浏览器画面"}
              onClick={handleClick}
              className="absolute inset-0 block h-full w-full cursor-crosshair object-contain select-none"
              draggable={false}
            />
            {waiting ? (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-[2px]"
                style={{ boxShadow: "inset 0 0 0 2px #f59e0b" }}
              />
            ) : null}
          </>
        ) : (
          <div className="flex h-full min-h-[160px] items-center justify-center text-[12px]" style={{ color: "#94a3b8" }}>
            助手还没打开网页
          </div>
        )}
      </div>

      {shown ? (
        <div className="flex items-center gap-2 px-2.5 py-1.5" style={{ background: "var(--color-surface-2)" }}>
          <span className="text-[11.5px]" style={{ color: "var(--color-text)" }}>
            第 {shown.n} 步 · {shown.summary}
          </span>
          <span className="truncate text-[10.5px]" style={{ color: "var(--color-muted)" }}>
            {shown.url}
          </span>
          {cur ? (
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
        <ActionLine actions={actions} />
      )}

      {/* 过程胶片：每步一张小图，点一下回看当时那一屏 —— 复盘"哪步走错了"靠它 */}
      {steps && steps.length > 0 ? (
        <div
          className="flex shrink-0 items-center gap-1.5 overflow-x-auto px-2 py-1.5"
          style={{ background: "var(--color-surface-3)", borderTop: "1px solid var(--color-border)" }}
        >
          <span className="shrink-0 text-[10.5px]" style={{ color: "var(--color-muted)" }}>
            过程 {steps.length} 步
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
                style={{ background: "rgba(15,23,42,0.55)", color: "#fff" }}
              >
                {st.n}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {onUserText && !busy ? (
        <div className="px-2.5 py-2 text-[11px]" style={{ background: "var(--color-surface)", color: "var(--color-muted)" }}>
          这轮已经结束，画面只可查看 —— 每一步的截图都留在会话文件的 browser/ 下。
        </div>
      ) : null}
      {onUserText && busy ? (
        <div className="flex gap-1.5 px-2.5 py-2" style={{ background: "var(--color-surface)" }}>
          <input
            className="input flex-1 text-[13px]"
            placeholder="点画面里的输入框，然后在这里打字（回车送入浏览器）"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeEvent(e) && text) {
                void onUserText(text);
                setText("");
              }
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
