"use client";

/**
 * 产物条：Agent 这一轮到底交付了什么。
 *
 * 只有一个来源：会话工作目录下的 `product/`（后端 deliverables.scan）。
 * 存在就常驻一行 —— 一行一对象，不点开也知道产出了什么；点开就地预览，
 * 不跳页、不弹窗、不留第二个入口。没有产物时**整块不渲染**（常驻一个空
 * 「暂无产物」会被当成功能坏了）。
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
    <div
      className="mb-2 rounded-[14px] border"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      data-deliverable
    >
      <div className="flex min-h-[48px] items-center gap-2 px-3 py-1.5 max-md:flex-wrap">
        <span
          className="shrink-0 rounded-[6px] px-1.5 py-0.5 text-[11px]"
          style={{
            color: "var(--color-accent)",
            background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
          }}
        >
          产物
        </span>
        <button
          type="button"
          data-tap
          onClick={() => setOpen((v) => !v)}
          className="min-w-0 flex-1 text-left"
          title={entry}
        >
          <span className="text-[13px]">{name}</span>
          <span className="ml-2 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
            {KIND_LABEL[info.kind] || "文件"} · {info.file_count} 个文件 · {fmtSize(info.size)}
          </span>
        </button>
        {previewable && (
          <button
            type="button"
            data-tap
            className="btn h-[32px] px-3 text-[12.5px] max-md:h-[44px]"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "收起" : "预览"}
          </button>
        )}
        <a
          href={api.deliverableZipUrl(sessionId)}
          data-tap
          className="flex h-[32px] items-center px-2 text-[12.5px] max-md:h-[44px] max-md:min-w-[44px] max-md:justify-center"
          style={{ color: "var(--color-muted)" }}
        >
          下载
        </a>
        <button
          type="button"
          data-tap
          onClick={() => void publish()}
          disabled={busy}
          className="h-[32px] px-2 text-[12.5px] max-md:h-[44px] max-md:min-w-[44px]"
          style={{ color: "var(--color-accent)", opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "发布中…" : "发布"}
        </button>
      </div>

      {link && (
        <div className="flex items-center gap-2 border-t px-3 py-1.5" style={{ borderColor: "var(--color-border)" }}>
          <span className="text-[11.5px]" style={{ color: "var(--color-muted)" }}>
            已发布
          </span>
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 flex-1 truncate text-[12px] underline"
            style={{ color: "var(--color-accent)" }}
          >
            {link}
          </a>
          <button
            type="button"
            data-tap
            className="h-[28px] px-2 text-[12px] max-md:h-[44px]"
            style={{ color: "var(--color-muted)" }}
            onClick={() => void copy()}
          >
            复制
          </button>
        </div>
      )}

      {err && (
        <div className="border-t px-3 py-1.5 text-[11.5px]" style={{ borderColor: "var(--color-border)", color: "var(--color-danger, #dc2626)" }}>
          {err}
        </div>
      )}

      {open && previewable && (
        <div className="border-t" style={{ borderColor: "var(--color-border)" }}>
          <iframe
            src={info.entry_url || ""}
            title={name}
            className="block w-full rounded-b-[13px]"
            style={{ height: "min(62vh, 560px)", border: 0, background: "#fff" }}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
          />
        </div>
      )}
    </div>
  );
}
