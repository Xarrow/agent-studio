"use client";

/**
 * 引用标识：这条回答读过哪些网页。
 *
 * 判据只有一个 —— 工具真的返回过的 URL（后端 sources.collect 从 tool_call 解析）。
 * 模型自己在正文里写的链接不算，编的更不算；所以这块只做「参考」，不做断言。
 *
 * 默认只占一行（来源是附属信息，不该抢走回答的位置）；点开就地展开，
 * 不弹窗、不跳页。没有来源时整块不渲染。
 */

import { useState } from "react";

import { api } from "@/lib/api";

export function SourceBadge({ runId, count }: { runId: string; count: number }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<
    { url: string; title: string; site: string; kind: string; snippet: string }[] | null
  >(null);
  const [busy, setBusy] = useState(false);

  if (!count) return null;

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (items || busy) return;
    setBusy(true);
    try {
      const d = await api.runSources(runId);
      setItems(d.items || []);
    } catch {
      setItems([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1.5 max-w-[88%] max-md:max-w-[90%]" data-sources>
      <button
        type="button"
        data-tap
        onClick={() => void toggle()}
        aria-expanded={open}
        className="flex min-h-[28px] items-center gap-1.5 rounded-[8px] px-1.5 text-[11.5px] max-md:h-[44px]"
        style={{ color: "var(--color-muted)" }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M10 13a5 5 0 0 0 7.1 0l2.4-2.4a5 5 0 0 0-7.1-7.1L11 4.9M14 11a5 5 0 0 0-7.1 0L4.5 13.4a5 5 0 0 0 7.1 7.1l1.4-1.4"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>
          引用 {count} 个来源
        </span>
        <span style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>
      </button>

      {open && (
        <div
          className="mt-1 overflow-y-auto rounded-[10px] border"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface)",
            // 一次搜索七八条、两次就十几条：不封顶会把回答顶到屏幕外
            maxHeight: 320,
          }}
        >
          {busy && (
            <div className="px-3 py-2 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
              正在取来源…
            </div>
          )}
          {!busy && (items?.length ?? 0) === 0 && (
            <div className="px-3 py-2 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
              这一轮没有可列的来源
            </div>
          )}
          {(items || []).map((it, i) => (
            <a
              key={it.url + i}
              href={it.url}
              target="_blank"
              rel="noreferrer noopener"
              data-tap
              className="flex min-h-[36px] items-baseline gap-2 border-b px-3 py-1.5 last:border-b-0 max-md:min-h-[44px]"
              style={{ borderColor: "var(--color-border)" }}
              title={it.snippet || it.url}
            >
              <span className="w-4 shrink-0 text-[11px]" style={{ color: "var(--color-muted)" }}>
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px]" style={{ color: "var(--color-text)" }}>
                  {it.title || it.url}
                </span>
                <span className="block truncate text-[11px]" style={{ color: "var(--color-muted)" }}>
                  {it.site} · {it.kind === "search" ? "搜索结果" : it.kind === "fetch" ? "已抓取" : "浏览器访问"}
                </span>
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
