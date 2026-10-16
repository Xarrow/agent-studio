"use client";

/**
 * 浏览器直播画面 —— Agent 的 Chromium 实时 screencast 帧 + 用户接管输入。
 *
 * 三层：
 * 1. <img> 显示最新帧（base64 JPEG，SSE 推一帧换一帧 —— 直播）
 * 2. 透明点击层：onClick 把显示坐标等比换算成视口坐标（800×600），
 *    POST browser-input → CDP 鼠标事件 → 下一帧画面回来（闭环）
 * 3. 输入条：点画面聚焦后在这里打字（中文输入法兼容性靠原生 input），
 *    回车 POST insertText
 *
 * 触屏：click 走 onClick 天然支持；44px 触控目标不适用（整个画面都是点击区）。
 * 帧不落库 —— 刷新后画面消失是已知取舍（动作流时间线仍在）。
 */

import { useRef, useState } from "react";
import { isImeEvent } from "@/lib/ime";

const VIEW_W = 800;
const VIEW_H = 600;

export function BrowserLive({
  frame,
  onUserClick,
  onUserText,
}: {
  frame: { data: string; url: string; title: string };
  onUserClick: (x: number, y: number) => void | Promise<void>;
  onUserText: (text: string) => void | Promise<void>;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const img = imgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    // 显示尺寸 → 视口坐标（等比：object-contain 下宽度撑满，高度按比例）
    const scale = VIEW_W / rect.width;
    const x = (e.clientX - rect.left) * scale;
    const y = (e.clientY - rect.top) * scale;
    void onUserClick(x, y);
  };

  return (
    <div className="w-full max-w-2xl my-2">
      <div className="text-[12px] text-[var(--color-muted)] mb-1.5 flex items-center gap-1.5">
        <span className="live-dot">●</span> 浏览器 {frame.title ? `· ${frame.title.slice(0, 40)}` : ""}
        <span className="text-[var(--color-muted)]/70">（画面可直接点击）</span>
      </div>
      <div
        className="relative rounded-md border border-[var(--color-border)] overflow-hidden cursor-pointer select-none"
        onClick={handleClick}
      >
        <img
          ref={imgRef}
          src={`data:image/jpeg;base64,${frame.data}`}
          alt={frame.title || "浏览器画面"}
          className="w-full h-auto block pointer-events-none"
          draggable={false}
        />
      </div>
      {/* 输入条：点画面里的输入框聚焦 → 在这里打字（原生 input 保输入法）→ 回车送进去 */}
      <div className="flex gap-1.5 mt-1.5">
        <input
          className="input flex-1 text-[13px]"
          placeholder={typing ? "输入中…（回车送入浏览器）" : "点画面里的输入框后，在这里打字"}
          value={text}
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isImeEvent(e) && text) {
              void onUserText(text);
              setText("");
            }
          }}
        />
      </div>
      {frame.url && (
        <div className="text-[11px] text-[var(--color-muted)] mt-1 truncate">{frame.url}</div>
      )}
    </div>
  );
}
