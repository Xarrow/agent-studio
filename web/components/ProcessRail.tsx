"use client";

/**
 * 右侧「Chrome 操作流」栏 —— Agent 浏览器画面直播 + 用户接管操作（桌面 xl 起常驻）。
 *
 * 2026-10-16 重做：原来这栏是执行过程（用量/思考/工具/产物），按用户拍板整个移除，
 * 换成 Chrome 流展示 ——「看它操作浏览器 + 我也能上手」是更高频的诉求；
 * 执行过程数据没有丢：消息内折叠条（Bubble 里）仍是同一份数据的另一个形态，
 * 「完整记录 →」浮层也还在。
 *
 * 形态纪律：桌面常驻右栏；手机/平板不出现（画面在消息流内的浏览器卡片里，
 * 同一帧数据的两个视口形态）。
 */

import React, { useRef, useState } from "react";
import { isImeEvent } from "@/lib/ime";

const VIEW_W = 800;
const VIEW_H = 600;

export function ProcessRail({
  frame,
  busy,
  onUserClick,
  onUserText,
}: {
  /** 浏览器直播帧（base64 JPEG + 页面 URL/标题）——null = 当前没有活的浏览器画面 */
  frame: { data: string; url: string; title: string } | null;
  busy: boolean;
  onUserClick: (x: number, y: number) => void | Promise<void>;
  onUserText: (text: string) => void | Promise<void>;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [text, setText] = useState("");

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onUserClick) return;
    const img = imgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    // 显示尺寸 → 视口坐标（等比换算）
    const scale = VIEW_W / rect.width;
    void onUserClick((e.clientX - rect.left) * scale, (e.clientY - rect.top) * scale);
  };

  return (
    <aside
      className="hidden xl:flex w-[420px] shrink-0 border-l flex-col min-h-0"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <div
        className="px-3 py-2.5 border-b flex items-center gap-2"
        style={{ borderColor: "var(--color-border)" }}
      >
        <span className="text-[12px] font-medium">Chrome</span>
        {busy && frame ? (
          <span className="text-[12px] live-dot" style={{ color: "var(--color-accent)" }}>
            ● 直播
          </span>
        ) : (
          <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
            {frame ? "" : "助手用浏览器干活时，这里实时显示画面"}
          </span>
        )}
        {frame?.title ? (
          <span
            className="text-[12px] truncate ml-auto"
            style={{ color: "var(--color-muted)" }}
            title={frame.title}
          >
            {frame.title.slice(0, 28)}
          </span>
        ) : null}
      </div>

      {/* 画面：直接点击 = 在浏览器里点（坐标等比换算后 POST → CDP） */}
      <div className="flex-1 overflow-auto p-2.5 min-h-0 flex flex-col gap-2">
        {frame ? (
          <>
            <div
              className="relative rounded-md border overflow-hidden cursor-pointer select-none"
              style={{ borderColor: "var(--color-border)" }}
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
            <div className="text-[11px] truncate" style={{ color: "var(--color-muted)" }}>
              {frame.url}
            </div>
            {/* 输入条：点画面里的输入框聚焦 → 在这里打字（原生 input 保输入法）→ 回车送进去 */}
            <div className="flex gap-1.5">
              <input
                className="input flex-1 text-[13px]"
                placeholder="点画面里的输入框后，在这里打字（回车送入）"
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
            <p className="text-[11px]" style={{ color: "var(--color-muted)" }}>
              画面可以直接点击 —— 用于登录、验证码这类需要你亲自操作的步骤。
            </p>
          </>
        ) : (
          <div className="px-1 py-6 text-center text-[12px]" style={{ color: "var(--color-muted)" }}>
            {busy ? "它还没打开浏览器…" : "没有正在直播的浏览器画面。"}
          </div>
        )}
      </div>
    </aside>
  );
}
