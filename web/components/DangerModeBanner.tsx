"use client";

/**
 * 危险模式的常驻提示条
 * ====================
 *
 * 用户第 4 条：开关打开后「界面上有常驻醒目提示（不要只藏在设置页），
 * 用户能随时一键关回」。所以它挂在根布局里 —— 每个页面顶部都有，直到关掉。
 *
 * 三个细节：
 * 1. **状态以服务端为准**：换设备/换浏览器打开，条子照样在（本地缓存只用来
 *    避免首帧闪一下，不当作真相）。
 * 2. **一键关回**：点「关掉」就写回设置并立刻收条，不用跑回设置页。
 * 3. 设置页里开关状态变化会广播 `studio:dangermode`，这边即时响应 ——
 *    否则用户开了以后要刷新才看得到红条（那就等于"藏在设置页"）。
 */

import { useCallback, useEffect, useState } from "react";

import { api } from "@/lib/api";
import { broadcastDangerMode, cachedDangerMode, DANGER_MODE_KEY } from "@/lib/danger-mode";

export function DangerModeBanner() {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // 首帧先用本地缓存（上一次已知状态），避免"明明开着却闪一下没有"
    if (cachedDangerMode()) setOn(true);
    void api
      .appSetting(DANGER_MODE_KEY)
      .then((r) => {
        const v = Boolean(r.value);
        setOn(v);
        try {
          window.localStorage.setItem("studio.dangermode", v ? "1" : "0");
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        /* 读不到就按关处理：宁可少提示，不能误报"跳过确认" */
      });
  }, []);

  useEffect(() => {
    const h = (e: Event) => setOn(Boolean((e as CustomEvent).detail));
    window.addEventListener("studio:dangermode", h);
    return () => window.removeEventListener("studio:dangermode", h);
  }, []);

  const off = useCallback(async () => {
    setBusy(true);
    try {
      await api.setAppSetting(DANGER_MODE_KEY, false);
      setOn(false);
      broadcastDangerMode(false);
    } finally {
      setBusy(false);
    }
  }, []);

  if (!on) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 text-[12.5px]"
      style={{ background: "var(--color-err)", color: "var(--color-accent-contrast)" }}
      role="status"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      </svg>
      <b>危险模式已开启</b>
      <span style={{ color: "color-mix(in srgb, var(--color-accent-contrast) 82%, transparent)" }}>
        助手写会话目录外的文件不再询问，直接执行（禁区仍拦）
      </span>
      <button
        type="button"
        data-tap
        disabled={busy}
        onClick={() => void off()}
        className="ml-auto rounded-full px-2.5 py-[3px] text-[12px] font-medium disabled:opacity-60"
        style={{ background: "var(--color-accent-contrast)", color: "var(--color-err)" }}
      >
        {busy ? "关闭中…" : "关掉"}
      </button>
    </div>
  );
}
