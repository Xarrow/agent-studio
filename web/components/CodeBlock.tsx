"use client";

/**
 * 代码块：语言标签 + 语法着色 + 格式化/压缩 + 折叠 + 复制（+ HTML 沙箱预览）。
 *
 * 用户要求：「会话内容中 json，xml 支持格式化高亮，和小工具操作」。
 * 三件事：
 *   1. **看**得懂 —— JSON/XML 自动格式化（紧凑的一整行 → 2 空格缩进）并着色；
 *   2. **切**得动 —— 格式化 / 压缩 一键来回，超过 30 行默认折叠，可展开看全；
 *   3. **拿**得走 —— 复制复的是**当前看到的内容**（格式化的那份），不是原文。
 * 其它语言不硬凑着色（没有可靠的零依赖 tokenizer 就别硬上），仍旧原样显示。
 * ```html 块保留「预览」—— OpenGenerativeUI 的核心模式（agent 产出即界面），
 * 沙箱 iframe 渲染，零第三方依赖。
 */

import { useMemo, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { formatJson, formatXml, guessLang, looksMinifiedJson, tokenizerFor } from "@/lib/highlight";

const PREVIEW_LINES = 30;

export function CodeBlock({
  code,
  lang,
  bare = false,
}: {
  code: string;
  lang?: string;
  /** bare：只给高亮正文（嵌在别处的「原文」视图里复用，不重复外框与工具条） */
  bare?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const language = (lang || "").toLowerCase();
  const isHtml = language === "html" || /^\s*<!DOCTYPE html/i.test(code);

  /* 没写语言标签时按内容猜（模型经常只给 ``` 空标签）：一眼是 JSON / XML 的照样处理 */
  const effective = language || guessLang(code) || "";
  const kind = effective === "json" || effective === "jsonl" ? "json" : effective === "xml" ? "xml" : "";

  const formatted = useMemo(() => {
    if (kind === "json") return formatJson(code);
    if (kind === "xml") return formatXml(code);
    return { text: code, ok: false };
  }, [code, kind]);

  /* 默认显示形态：能格式化的就格式化（紧凑 JSON 尤其需要），已经好看的不动 */
  const [showFormatted, setShowFormatted] = useState(() => {
    if (kind === "json") return formatted.ok && looksMinifiedJson(code);
    if (kind === "xml") return formatted.ok && !/\n\s{2,}</.test(code);
    return false;
  });

  const shown = showFormatted && formatted.ok ? formatted.text : code;
  const lines = useMemo(() => shown.split("\n"), [shown]);
  const tooLong = lines.length > PREVIEW_LINES;
  const visible = tooLong && !expanded ? lines.slice(0, PREVIEW_LINES) : lines;

  const toks = useMemo(() => {
    const tk = tokenizerFor(kind || language);
    if (!tk) return null;
    return tk((bare ? lines : visible).join("\n"));
  }, [visible, lines, kind, language, bare]);

  const copy = async () => {
    if (await copyText(shown)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  const canFormat = kind === "json" && formatted.ok && !showFormatted;
  const canCompress = kind === "json" && showFormatted;
  const canIndent = kind === "xml" && formatted.ok && !showFormatted;

  if (bare) {
    return (
      <pre
        className="hl overflow-auto px-3 py-2 text-[12px] leading-[1.6] m-0"
        style={{ background: "var(--color-surface-2)" }}
      >
        <code>
          {toks
            ? toks.map((t, i) =>
                t.c ? (
                  <span key={i} className={`hl-${t.c}`}>
                    {t.t}
                  </span>
                ) : (
                  <span key={i}>{t.t}</span>
                ),
              )
            : lines.join("\n")}
        </code>
      </pre>
    );
  }

  return (
    <div className="my-2 rounded-[8px] border overflow-hidden" style={{ borderColor: "var(--color-border)" }}>
      {/* 工具条：语言名 + 行数 + 动作（常驻可见，不藏 hover） */}
      <div
        className="flex items-center gap-2 px-2.5 py-1 border-b text-[12px]"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
      >
        <span
          className="mono shrink-0 rounded px-1.5 py-[1px] text-[11px] uppercase tracking-wide"
          style={{ background: "var(--color-surface)", color: "var(--color-muted)" }}
        >
          {effective || "text"}
        </span>
        <span className="shrink-0 text-[11px]" style={{ color: "var(--color-muted)" }}>
          {lines.length} 行
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {canFormat && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 max-md:min-h-[32px] max-md:px-2 hover:bg-[var(--color-surface)]"
              style={{ color: "var(--color-accent)" }}
              onClick={() => setShowFormatted(true)}
              title="展开成缩进格式（更容易看清层级）"
            >
              格式化
            </button>
          )}
          {canCompress && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 max-md:min-h-[32px] max-md:px-2 hover:bg-[var(--color-surface)]"
              style={{ color: "var(--color-muted)" }}
              onClick={() => setShowFormatted(false)}
              title="压回一行（复制给程序用）"
            >
              压缩
            </button>
          )}
          {canIndent && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 max-md:min-h-[32px] max-md:px-2 hover:bg-[var(--color-surface)]"
              style={{ color: "var(--color-accent)" }}
              onClick={() => setShowFormatted(true)}
              title="按标签层级缩进"
            >
              缩进
            </button>
          )}
          {/* 展开交给底边那条（它还告诉你剩多少行）；工具条只负责「收起」，
              两个地方都写「展开全部」会让人以为要做两次 */}
          {tooLong && expanded && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 max-md:min-h-[32px] max-md:px-2 hover:bg-[var(--color-surface)]"
              style={{ color: "var(--color-muted)" }}
              onClick={() => setExpanded(false)}
            >
              收起
            </button>
          )}
          {isHtml && (
            <button
              type="button"
              data-tap
              className="rounded px-1.5 py-0.5 max-md:min-h-[32px] max-md:px-2 hover:bg-[var(--color-surface)]"
              style={{ color: preview ? "var(--color-accent)" : "var(--color-muted)" }}
              onClick={() => setPreview((v) => !v)}
            >
              {preview ? "看代码" : "预览"}
            </button>
          )}
          <button
            type="button"
            data-tap
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 max-md:min-h-[32px] max-md:px-2 hover:bg-[var(--color-surface)]"
            style={{ color: copied ? "var(--color-ok)" : "var(--color-muted)" }}
            onClick={() => void copy()}
          >
            {copied ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            ) : null}
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
        <>
          <div className="relative">
            <pre
              className="hl overflow-auto px-2.5 py-2 text-[12px] leading-[1.6] m-0"
              style={{ background: "var(--color-surface-2)" }}
            >
              <code>
                {toks
                  ? toks.map((t, i) =>
                      t.c ? (
                        <span key={i} className={`hl-${t.c}`}>
                          {t.t}
                        </span>
                      ) : (
                        <span key={i}>{t.t}</span>
                      ),
                    )
                  : visible.join("\n")}
              </code>
            </pre>
            {/* 被折叠时底部压一层渐隐：一眼看出"下面还有"，而不是读到一句"…"就断了 */}
            {tooLong && !expanded ? (
              <div
                className="pointer-events-none absolute inset-x-0 bottom-0 h-9"
                style={{ background: "linear-gradient(to bottom, rgba(255,255,255,0), var(--color-surface-2))" }}
              />
            ) : null}
          </div>
          {tooLong && !expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="flex w-full items-center justify-center gap-1 border-t py-1.5 text-[12px] max-md:min-h-[36px] hover:bg-[var(--color-surface)]"
              style={{ borderColor: "var(--color-border)", color: "var(--color-accent)" }}
            >
              还有 {lines.length - PREVIEW_LINES} 行
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
              展开全部
            </button>
          )}
        </>
      )}
    </div>
  );
}
