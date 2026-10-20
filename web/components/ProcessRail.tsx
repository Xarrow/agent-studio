"use client";

/**
 * 右侧「浏览器」栏 —— 桌面常驻（lg 起），内容是 BrowserStage 的面板形态。
 *
 * 2026-10-20 重做：原来这里是手写的一张 <img> + 输入条，和消息流里的卡片是
 * 两套代码、两种观感（一个闪、一个不闪；一个有动作字幕、一个没有）。
 * 现在两边共用 BrowserStage：窗口 chrome、动作字幕、双层缓冲全在组件里，
 * 这栏只负责"放哪儿、多宽"。
 *
 * 形态纪律：桌面常驻右栏；手机/平板不出现（画面在消息流内的缩略条里，
 * 点开是贴底抽屉，同一份数据两种视口形态）。
 */

import { BrowserStage, type BrowserAction, type BrowserFrameData } from "@/components/BrowserStage";

export function ProcessRail({
  frame,
  actions,
  busy,
  waiting,
  onCollapse,
  onUserClick,
  onUserText,
  onUserScroll,
}: {
  /** 浏览器直播帧（base64 JPEG + 页面 URL/标题）——null = 当前没有活的浏览器画面 */
  frame: BrowserFrameData | null;
  actions: BrowserAction[];
  busy: boolean;
  /** 等用户登录 / 点确认 */
  waiting?: boolean;
  /** 收起整个右栏（对话区变宽） */
  onCollapse?: () => void;
  onUserClick: (x: number, y: number) => void | Promise<void>;
  onUserText: (text: string) => void | Promise<void>;
  onUserScroll?: (dy: number) => void | Promise<void>;
}) {
  return (
    <aside
      className="hidden lg:flex w-[340px] xl:w-[440px] shrink-0 border-l flex-col min-h-0"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <div
        className="px-3 py-2 border-b flex items-center gap-2"
        style={{ borderColor: "var(--color-border)" }}
      >
        <span className="text-[12px] font-medium">浏览器</span>
        {onCollapse && (
          <button
            data-tap
            title="收起（对话区变宽）"
            onClick={onCollapse}
            className="w-7 h-7 -my-1 flex items-center justify-center rounded-md text-[12px] hover:bg-[var(--color-surface-2)]"
            style={{ color: "var(--color-muted)" }}
          >
            »
          </button>
        )}
        {busy && frame ? (
          <span className="ml-auto text-[11.5px] live-dot" style={{ color: "var(--color-accent)" }}>
            ● 直播
          </span>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {frame || actions.length > 0 ? (
          <BrowserStage
            variant="panel"
            frame={frame}
            actions={actions}
            busy={busy}
            waiting={waiting}
            onUserClick={onUserClick}
            onUserText={onUserText}
            onUserScroll={onUserScroll}
          />
        ) : (
          <div className="px-3 py-8 text-center text-[12px]" style={{ color: "var(--color-muted)" }}>
            {busy ? "它还没打开浏览器…" : "助手用浏览器干活时，这里实时显示画面 —— 你也可以直接点。"}
          </div>
        )}
      </div>
    </aside>
  );
}
