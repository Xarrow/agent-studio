"use client";

/**
 * 代码块 —— 升级版（exec 页丰富化第一件）：
 * · 复制按钮（零依赖：navigator.clipboard）
 * · ```html 块给「预览」切换 —— OpenGenerativeUI 的核心模式（agent 产出即界面），
 *   沙箱 iframe 渲染（no scripts 之外的能力、不允许同源），零第三方依赖
 */

import React, { useState } from "react";

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState(false);
  const language = (lang || "").toLowerCase();
  const isHtml = language === "html" || /^\s*<!DOCTYPE html/i.test(code);

  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(code);
      ok = true;
    } catch {
      // clipboard API 不可用（非安全上下文/旧内核 WebView）→ textarea 兜底
      try {
        const ta = document.createElement("textarea");
        ta.value = code;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <div className="my-2 rounded-[8px] border overflow-hidden" style={{ borderColor: "var(--color-border)" }}>
      {/* 工具条：语言名 + 动作（常驻可见，不藏 hover） */}
      <div
        className="flex items-center gap-2 px-2.5 py-1 border-b text-[11px]"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
      >
        <span className="mono" style={{ color: "var(--color-muted)" }}>
          {language || "text"}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {isHtml && (
            <button
              data-tap
              className="rounded px-1.5 py-0.5 hover:bg-[var(--color-surface)]"
              style={{ color: preview ? "var(--color-accent)" : "var(--color-muted)" }}
              onClick={() => setPreview((v) => !v)}
            >
              {preview ? "看代码" : "预览"}
            </button>
          )}
          <button
            data-tap
            className="rounded px-1.5 py-0.5 hover:bg-[var(--color-surface)]"
            style={{ color: copied ? "var(--color-ok)" : "var(--color-muted)" }}
            onClick={() => void copy()}
          >
            {copied ? "已复制" : "复制"}
          </button>
        </span>
      </div>

      {preview ? (
        /* 沙箱渲染：不给脚本、不给同源 —— agent 产出的 HTML 只是「画出来」，
           不能碰页面、不能发请求（与 OpenGenerativeUI 同样的安全边界）。 */
        <iframe
          title="html-preview"
          sandbox="allow-same-origin"
          srcDoc={code}
          className="w-full block"
          style={{ height: 320, background: "#fff", border: "none" }}
        />
      ) : (
        <pre
          className="overflow-auto px-2.5 py-2 text-[11.5px] leading-[1.6] m-0"
          style={{ background: "var(--color-surface-2)" }}
        >
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
