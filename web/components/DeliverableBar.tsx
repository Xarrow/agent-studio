"use client";

/**
 * 产物入口：Agent 这一轮到底交付了什么。
 *
 * 只有一个来源：会话工作目录下的 `product/`（后端 deliverables.scan）。
 * 形态（阶段 5 起）：输入卡片上方一枚 28px 胶囊「产物 · N」，点开是浮层面板
 * （预览 / 下载 / 发布）。原来它是一条常驻 48px 的横条，和输入区抢空间；
 * 没有产物时整块不渲染（常驻一个空「暂无产物」会被当成功能坏了）。
 */

import { useEffect, useState } from "react";

import { api } from "@/lib/api";

function fmtSize(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const KIND_LABEL: Record<string, string> = { web: "网页", doc: "文档", file: "文件" };

export function DeliverableBar({ sessionId }: { sessionId?: string }) {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.sessionDeliverable>> | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    setInfo(null);
    setOpen(false);
    setLink("");
    setErr("");
    if (!sessionId) return;
    let alive = true;
    const tick = () => {
      api
        .sessionDeliverable(sessionId)
        .then((d) => {
          if (alive) setInfo(d);
        })
        .catch(() => {
          /* 会话刚建/刚删，静默 */
        });
    };
    tick();
    // 产物是助手边跑边写的：轮询比"跑完再问"更早让人看到东西
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sessionId]);

  if (!sessionId || !info?.exists) return null;

  const entry = info.entry || "";
  const previewable = info.kind === "web" && !!info.entry_url;
  const name = entry.replace(/^.*\//, "") || "产物";

  const publish = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.publishSessionDeliverable(sessionId);
      setLink(r.url || "");
      if (!r.url) setErr(`已发到 ${r.dir}/${r.slug}/（这个位置没有对外地址）`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "发布失败");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setErr("");
    } catch {
      setErr("复制不了，长按选中链接吧");
    }
  };

  return (
    <div className="relative" data-deliverable>
      {/* 紧凑入口：一行小胶囊「产物 · N」，点开才展开面板 */}
      <button
        type="button"
        data-tap
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={entry}
        className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-pill)] border px-2.5 text-[var(--fs-sm)] transition-colors hover:bg-[var(--bg-selected)]"
        style={{
          borderColor: open
            ? "var(--color-accent)"
            : "color-mix(in srgb, var(--color-accent) 40%, transparent)",
          color: "var(--color-accent)",
          background: open
            ? "color-mix(in srgb, var(--color-accent) 8%, transparent)"
            : "transparent",
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
        </svg>
        产物 · {info.file_count}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform var(--dur-1)" }}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute bottom-[calc(100%+8px)] left-0 z-40 w-[min(560px,calc(100vw-32px))] overflow-hidden rounded-[var(--radius-lg)]"
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            boxShadow: "var(--shadow-3)",
          }}
        >
          <div className="flex min-h-[44px] items-center gap-2 px-3 py-1.5 max-md:flex-wrap">
            <span
              className="shrink-0 rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[var(--fs-xs)]"
              style={{
                color: "var(--color-accent)",
                background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
              }}
            >
              产物
            </span>
            <span className="min-w-0 flex-1 truncate text-[var(--fs-base)]" title={entry}>
              {name}
              <span className="ml-2 text-[var(--fs-xs)]" style={{ color: "var(--color-text-3)" }}>
                {KIND_LABEL[info.kind] || "文件"} · {info.file_count} 个文件 · {fmtSize(info.size)}
              </span>
            </span>
            <a
              href={api.deliverableZipUrl(sessionId)}
              data-tap
              className="flex h-[32px] items-center rounded-[var(--radius-xs)] px-2 text-[var(--fs-sm)] hover:bg-[var(--bg-selected)]"
              style={{ color: "var(--color-text-2)" }}
            >
              下载
            </a>
            <button
              type="button"
              data-tap
              onClick={() => void publish()}
              disabled={busy}
              className="h-[32px] rounded-[var(--radius-xs)] px-2 text-[var(--fs-sm)] hover:bg-[var(--bg-selected)]"
              style={{ color: "var(--color-accent)", opacity: busy ? 0.6 : 1 }}
            >
              {busy ? "发布中…" : "发布"}
            </button>
          </div>

          {previewable && (
            <div className="border-t" style={{ borderColor: "var(--color-border)" }}>
              <iframe
                src={info.entry_url || ""}
                title={name}
                className="block w-full"
                style={{ height: "min(52vh, 460px)", border: 0, background: "#fff" }}
                sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
              />
            </div>
          )}

          {link && (
            <div className="flex items-center gap-2 border-t px-3 py-1.5" style={{ borderColor: "var(--color-border)" }}>
              <span className="text-[var(--fs-xs)]" style={{ color: "var(--color-text-3)" }}>已发布</span>
              <a
                href={link}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate text-[var(--fs-sm)] underline"
                style={{ color: "var(--color-accent)" }}
              >
                {link}
              </a>
              <button
                type="button"
                data-tap
                className="h-[28px] px-2 text-[var(--fs-sm)]"
                style={{ color: "var(--color-text-2)" }}
                onClick={() => void copy()}
              >
                复制
              </button>
            </div>
          )}

          {err && (
            <div
              className="border-t px-3 py-1.5 text-[var(--fs-xs)]"
              style={{ borderColor: "var(--color-border)", color: "var(--color-err)" }}
            >
              {err}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
