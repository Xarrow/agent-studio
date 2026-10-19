"use client";

/**
 * 对话里的"文件"要能被**操作**，而不是把地址摆在正文里让人自己看。
 *
 * 用户原话：「对话页面如果是文件类显示，用户点击应该是弹出一个框中让用户操作，
 * 而不是这直接给出地址」。
 *
 * 所以：正文/工具里的路径 → 一个小卡片（FileChip）→ 点开是这个对话框：
 *   · 图片：直接显示
 *   · 文本/代码：显示前几 KB，可复制全文
 *   · 其它：说明"不能在页面里预览"，给下载
 * 三件事永远在：**下载 / 复制路径 / 新窗口打开**。路径本身也照常显示（信息不藏）。
 *
 * 会话上下文（哪个会话、工作目录在哪）从 Provider 拿；没挂 Provider 的地方
 * （比如运行详情弹窗）FileChip 退化成普通行内代码，不会点出半截东西。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DLG_BACKDROP, DLG_CARD } from "@/components/ui/kit";
import { api, fmt } from "@/lib/api";
import { CodeBlock } from "@/components/CodeBlock";
import { baseName, extOf, fileKind, fileUrlFor, looksLikeFilePath } from "@/lib/files";
import { copyText } from "@/lib/clipboard";

export type FileRef = { path: string; name?: string; url?: string | null; size?: number; mtime?: number };

type OpenerCtx = {
  /** 打开某个文件的操作框（没 Provider 时是 no-op） */
  open: (f: FileRef | string) => void;
};

const Ctx = createContext<OpenerCtx | null>(null);
const SessionCtx = createContext<{ sessionId?: string; workDir?: string }>({});

/** 放在对话页最外层：既提供会话上下文，也负责渲染那一个对话框。 */
export function FileOpenerProvider({
  sessionId,
  workDir,
  children,
  onFileChanged,
}: {
  sessionId?: string;
  workDir?: string;
  children: ReactNode;
  /** 文件被删掉后通知外面刷新（会话里那条文件清单要跟着变） */
  onFileChanged?: () => void;
}) {
  const [file, setFile] = useState<FileRef | null>(null);
  const open = useCallback((f: FileRef | string) => setFile(typeof f === "string" ? { path: f } : f), []);
  const api = useMemo<OpenerCtx>(() => ({ open }), [open]);
  return (
    <Ctx.Provider value={api}>
      <SessionCtx.Provider value={{ sessionId, workDir }}>
        {children}
        {file ? (
          <FileDialog
            file={file}
            onClose={() => setFile(null)}
            onDeleted={() => {
              onFileChanged?.();
              setFile(null);
            }}
          />
        ) : null}
      </SessionCtx.Provider>
    </Ctx.Provider>
  );
}

/** 打开一个文件。返回 null = 这里没有文件操作能力（退化成普通展示）。 */
export function useFileOpener(): ((f: FileRef | string) => void) | null {
  const ctx = useContext(Ctx);
  return ctx ? ctx.open : null;
}

/** 正文里的路径：像文件才变成可点的卡片，否则原样渲染。 */
export function FileChip({
  path,
  label,
  className = "",
}: {
  path: string;
  label?: string;
  className?: string;
}) {
  const openHere = useFileOpener();
  const { sessionId, workDir } = useContext(SessionCtx);
  if (!openHere || !looksLikeFilePath(path)) return null;
  const url = fileUrlFor(path, sessionId, workDir);
  return (
    <button
      type="button"
      onClick={() => openHere({ path, url })}
      title={url ? `打开 ${path}（可预览 / 下载）` : path}
      className={`inline-flex max-w-full min-h-[32px] items-center gap-1 rounded border px-1.5 text-left align-middle mono text-[12px] hover:bg-[var(--color-surface-2)] ${className}`}
      style={{ color: "var(--color-accent)", borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
      </svg>
      <span className="min-w-0 truncate">{label || baseName(path)}</span>
    </button>
  );
}

/** 会话文件清单/附件卡这类"整行可点"的地方用它 —— 里面才拍得到 Provider 的上下文。 */
export function FileRowButton({
  file,
  children,
  className = "",
  style,
}: {
  file: FileRef;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const open = useFileOpener();
  if (!open) return <span className={className} style={style}>{children}</span>;
  return (
    <button type="button" onClick={() => open(file)} className={`min-w-0 text-left ${className}`} style={style}>
      {children}
    </button>
  );
}

const PREVIEW_BYTES = 6000;

export function FileDialog({
  file,
  onClose,
  onDeleted,
}: {
  file: FileRef;
  onClose: () => void;
  /** 删成功之后：外面要刷新文件清单 */
  onDeleted?: () => void;
}) {
  const { sessionId, workDir } = useContext(SessionCtx);
  const url = file.url ?? fileUrlFor(file.path, sessionId, workDir);
  const kind = fileKind(file.path);
  const [text, setText] = useState<string | null>(null);
  const [bytes, setBytes] = useState<number | null>(file.size ?? null);
  const [state, setState] = useState<"idle" | "loading" | "done" | "fail">(url ? "loading" : "idle");
  const [copied, setCopied] = useState<"path" | "text" | null>(null);
  /* 删除是不可撤销的：第一下只把按钮变成「确认删除」，4 秒内再点才算（不用原生 confirm —— 它阻塞 JS） */
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);

  /* 后端只认"相对会话目录"的路径；这里把绝对路径折回相对 */
  const relPath = (() => {
    const root = (workDir ?? "").replace(/\/+$/, "");
    if (root && file.path.startsWith(root + "/")) return file.path.slice(root.length + 1);
    return file.path.replace(/^\/+/, "");
  })();

  const remove = async () => {
    if (!sessionId || deleting) return;
    setDeleting(true);
    setDelErr(null);
    try {
      await api.deleteSessionFile(sessionId, relPath);
      onDeleted?.();
    } catch (e) {
      setDelErr(e instanceof Error ? e.message : "删除失败");
      setDeleting(false);
      setConfirmDel(false);
    }
  };

  useEffect(() => {
    let alive = true;
    if (!url || kind !== "text") return;
    setState("loading");
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        /* 大小未知时（正文里只有路径）就从响应头上补一个，别写"大小未知"糊过去 */
        const len = Number(r.headers.get("content-length") || 0);
        if (alive && len > 0) setBytes((b) => b ?? len);
        return r.text();
      })
      .then((t) => {
        if (!alive) return;
        setText(t.slice(0, PREVIEW_BYTES));
        setState("done");
      })
      .catch(() => alive && setState("fail"));
    return () => {
      alive = false;
    };
  }, [url, kind]);

  const copy = (what: "path" | "text") => {
    const v = what === "path" ? file.path : text ?? "";
    /* 内网 http 下 navigator.clipboard 不存在，走 lib/clipboard 的兜底 */
    void copyText(v).then((ok) => {
      if (!ok) return;
      setCopied(what);
      setTimeout(() => setCopied(null), 1400);
    });
  };

  const truncated = state === "done" && text !== null && text.length >= PREVIEW_BYTES;

  return (
    <div className={DLG_BACKDROP} onClick={onClose}>
      <div
        className={`${DLG_CARD} max-w-3xl p-4 pt-3 sm:p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题：文件名 + 类型/大小/时间 */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-medium mono">{file.name ?? baseName(file.path)}</h2>
            <p className="mt-0.5 text-[12px]" style={{ color: "var(--color-muted)" }}>
              {extOf(file.path) ? `${extOf(file.path).toUpperCase()} · ` : ""}
              {kind === "image" ? "图片 · " : kind === "text" ? "文本 · " : "文件 · "}
              {file.size != null || bytes != null ? fmt.bytes(bytes ?? file.size ?? 0) : ""}
              {file.mtime ? ` · ${new Date(file.mtime * 1000).toLocaleString()}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="btn shrink-0 px-2.5 max-md:min-h-[36px]"
          >
            ✕
          </button>
        </div>

        {/* 预览 */}
        <div className="mt-3">
          {!url ? (
            <p className="rounded-[10px] border p-3 text-[12.5px]" style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}>
              这个文件不在本会话的工作目录里，页面里不能预览或下载 —— 可以复制路径去别处用。
            </p>
          ) : kind === "image" ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={url}
              alt={file.name ?? baseName(file.path)}
              className="max-h-[52dvh] w-full rounded-[10px] border object-contain"
              style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
            />
          ) : kind === "text" ? (
            state === "loading" ? (
              <p className="p-3 text-[12.5px]" style={{ color: "var(--color-muted)" }}>读取中…</p>
            ) : state === "fail" ? (
              <p className="rounded-[10px] border p-3 text-[12.5px]" style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}>
                读不出内容（文件可能已被删掉或移走），可以直接下载试试。
              </p>
            ) : (
              <div>
                {/* 文本/代码：直接上 CodeBlock —— JSON/XML 自动格式化 + 着色，
                    还能一键格式化/压缩/复制（与对话正文里那块是同一个组件） */}
                <div className="max-h-[46dvh] overflow-auto">
                  <CodeBlock code={text || ""} lang={extOf(file.path)} />
                </div>
                <div
                  className="flex flex-wrap items-center gap-2 px-1 pt-1 text-[12px]"
                  style={{ color: "var(--color-muted)" }}
                >
                  只显示前 {Math.round(PREVIEW_BYTES / 1000)}KB{truncated ? "（内容更长，下载看全文）" : ""}
                  <button
                    type="button"
                    className="btn ml-auto px-2.5 max-md:min-h-[36px]"
                    onClick={() => copy("text")}
                    disabled={!text}
                  >
                    {copied === "text" ? "已复制" : "复制全文"}
                  </button>
                </div>
              </div>
            )
          ) : (
            <p className="rounded-[10px] border p-3 text-[12.5px]" style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}>
              这类文件（{extOf(file.path) || "无扩展名"}）不能在页面里预览 —— 下载后用本机程序打开。
            </p>
          )}
        </div>

        {/* 路径（照常显示，可复制） */}
        <div className="mt-3">
          <div className="label">{file.path.startsWith("/api/") ? "链接" : "路径"}</div>
          <div className="flex items-center gap-2">
            <input className="input mono text-[12px]" readOnly value={file.path} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn shrink-0 px-2.5 max-md:min-h-[36px]" onClick={() => copy("path")}>
              {copied === "path" ? "已复制" : "复制"}
            </button>
          </div>
        </div>

        {/* 动作：主操作蓝色（下载）· 次级安静（新窗口）· 危险红（删除，最右隔开）· 关闭 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {url ? (
            <a className="btn btn-primary" href={url} download={file.name ?? baseName(file.path)}>
              下载
            </a>
          ) : null}
          {url ? (
            <a className="btn" href={url} target="_blank" rel="noreferrer">
              新窗口打开
            </a>
          ) : null}
          <button type="button" className="btn ml-auto max-md:min-h-[36px]" onClick={onClose}>
            关闭
          </button>
          {sessionId ? (
            <button
              type="button"
              className="btn max-md:min-h-[36px]"
              style={{
                color: confirmDel ? "#fff" : "var(--color-err)",
                background: confirmDel ? "var(--color-err)" : "transparent",
                borderColor: "var(--color-err)",
              }}
              disabled={deleting}
              onClick={() => {
                if (!confirmDel) {
                  setConfirmDel(true);
                  setTimeout(() => setConfirmDel(false), 4000);
                  return;
                }
                void remove();
              }}
              title={confirmDel ? "再点一次就删掉了（不可撤销）" : "删掉这个文件（会再确认一次）"}
            >
              {deleting ? "删除中…" : confirmDel ? "确认删除" : "删除"}
            </button>
          ) : null}
        </div>
        {delErr ? (
          <p className="mt-2 text-[12px]" style={{ color: "var(--color-err)" }}>
            删除失败：{delErr}
          </p>
        ) : null}
      </div>
    </div>
  );
}
