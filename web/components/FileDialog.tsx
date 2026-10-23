"use client";

/**
 * 对话里的"文件"要能被**操作**，而不是把地址摆在正文里让人自己看。
 *
 * 用户原话：「对话页面如果是文件类显示，用户点击应该是弹出一个框中让用户操作，
 * 而不是这直接给出地址」。
 *
 * 所以：正文/工具里的路径 → 一个小卡片（FileChip）→ 点开是这个对话框：
 *   · 图片：直接显示
 *   · PDF：内嵌阅读（浏览器自带阅读器）
 *   · 音频/视频：原生播放器
 *   · Markdown：渲染成排版（可切源码）
 *   · CSV/TSV：出表格（可切原文）
 *   · 代码/纯文本/JSON/HTML 源码：等宽着色，可复制全文
 *   · Word/Excel/压缩包这类：老实说"页面里看不了"，给下载
 * 分类规则统一在 lib/files.ts 里（正文里能不能点、点开给什么，必须是同一套判定）。
 * 三件事永远在：**下载 / 复制路径 / 新窗口打开**。路径本身也照常显示（信息不藏）。
 *
 * 会话上下文（哪个会话、工作目录在哪）从 Provider 拿；没挂 Provider 的地方
 * （比如运行详情弹窗）FileChip 退化成普通行内代码，不会点出半截东西。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DLG_BACKDROP, DLG_CARD } from "@/components/ui/kit";
import { api, fmt } from "@/lib/api";
import type { WorkPreview } from "@/lib/types";
import { CodeBlock } from "@/components/CodeBlock";
import Markdown from "@/components/Markdown";
import { FileTypeIcon } from "@/components/ui/icons";
import {
  baseName,
  extOf,
  fileKind,
  fileTypeKey,
  fileUrlFor,
  isServerParsedKind,
  isTextishKind,
  looksLikeFilePath,
} from "@/lib/files";
import { copyText } from "@/lib/clipboard";
import {
  DocumentView,
  JsonView,
  OutlineView,
  SlidesView,
  SpreadsheetView,
  XmlFetch,
  type OutlineSheet,
  type SheetData,
} from "@/components/FilePreviews";

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
            onFileAdded={() => onFileChanged?.()}
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
/** Markdown/表格要渲染完整结构，多给一些（仍远小于把整个文件读进内存） */
const PREVIEW_BYTES_RICH = 200_000;
/** 表格最多铺多少行（再多就该下载用表格软件看了） */
const TABLE_MAX_ROWS = 300;

/** 弹层标题旁边那句"这是什么" —— 用中文，别让人去认 .tsv */
const KIND_LABEL: Record<string, string> = {
  image: "图片",
  pdf: "PDF",
  audio: "音频",
  video: "视频",
  markdown: "Markdown",
  table: "表格",
  html: "网页",
  text: "文本",
  json: "JSON",
  xml: "XML",
  spreadsheet: "表格",
  document: "文档",
  slides: "幻灯片",
  outline: "思维导图",
  other: "文件",
};

/**
 * 极简 CSV/TSV 解析：支持引号包裹、引号内逗号与换行、"" 转义。
 * 不引第三方库的理由：只为预览，300 行 × 几十列足够；引库要多 40KB 还得为它的 bug 兜底。
 */
function parseDelimited(text: string, sep: string, maxRows = TABLE_MAX_ROWS): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (rows.length > maxRows) return rows;
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** CSV/TSV 表格预览：首行当表头（大多数导出的都这样），行数封顶并明说 */
function TablePreview({ text, path }: { text: string; path: string }) {
  const sep = extOf(path) === "tsv" ? "\t" : ",";
  const rows = useMemo(() => parseDelimited(text, sep), [text, sep]);
  const head = rows[0] ?? [];
  const body = rows.slice(1);
  if (rows.length === 0) {
    return (
      <p className="rounded-[10px] border p-3 text-[12.5px]" style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}>
        这个表是空的。
      </p>
    );
  }
  return (
    <div className="max-h-[52dvh] overflow-auto rounded-[10px] border" style={{ borderColor: "var(--color-border)" }}>
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="sticky top-0" style={{ background: "var(--color-surface-2)" }}>
          <tr>
            {head.map((h, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <th key={i} className="whitespace-nowrap border-b px-2 py-1.5 text-left font-medium" style={{ borderColor: "var(--color-border)" }}>
                {h || "—"}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <tr key={i} className="hover:bg-[var(--color-surface-2)]">
              {head.map((_, j) => (
                // eslint-disable-next-line react/no-array-index-key
                <td key={j} className="max-w-[320px] truncate border-b px-2 py-1" style={{ borderColor: "var(--color-border)" }} title={r[j] ?? ""}>
                  {r[j] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length >= TABLE_MAX_ROWS ? (
        <p className="px-2 py-1.5 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
          只显示前 {TABLE_MAX_ROWS} 行，完整内容请下载。
        </p>
      ) : null}
    </div>
  );
}

export function FileDialog({
  file,
  onClose,
  onDeleted,
  onFileAdded,
}: {
  file: FileRef;
  onClose: () => void;
  /** 删成功之后：外面要刷新文件清单 */
  onDeleted?: () => void;
  /** 转码生成了新文件之后：外面要刷新文件清单 */
  onFileAdded?: () => void;
}) {
  const { sessionId, workDir } = useContext(SessionCtx);
  const url = file.url ?? fileUrlFor(file.path, sessionId, workDir);
  const kind = fileKind(file.path);
  const [text, setText] = useState<string | null>(null);
  const [bytes, setBytes] = useState<number | null>(file.size ?? null);
  const [state, setState] = useState<"idle" | "loading" | "done" | "fail">(url ? "loading" : "idle");
  const [copied, setCopied] = useState<"path" | "text" | null>(null);
  /* ---- 视频：能不能播、要不要转码 ----
     真实踩到：bilibili 下的 mp4 是 AV1，手机和微信内置浏览器根本解不了；
     直接丢一个 <video> 只会得到黑框。所以先问后端"这编码能不能播"，不能就明说原因并给一键转码。 */
  const [probe, setProbe] = useState<Awaited<ReturnType<typeof api.probeWorkFile>> | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);
  const [converting, setConverting] = useState(false);
  const [convErr, setConvErr] = useState<string | null>(null);
  /** Markdown / 表格的"看排版"与"看原文"切换（默认看排版） */
  const [rawView, setRawView] = useState(false);
  /* Office / 思维导图：内容由后端解析（前端解 xlsx/docx/pptx 要引三套库、+1.5MB） */
  const [parsed, setParsed] = useState<WorkPreview | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  /* 删除是不可撤销的：第一下只把按钮变成「确认删除」，4 秒内再点才算（不用原生 confirm —— 它阻塞 JS） */
  const [confirmDel, setConfirmDel] = useState(false);
  /** 确认态的倒计时（4 → 1），到点自己退回「删除」 */
  const [delCount, setDelCount] = useState(0);
  const delTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdown = (n: number) => {
    if (delTimer.current) clearInterval(delTimer.current);
    setDelCount(n);
    delTimer.current = setInterval(() => {
      setDelCount((v) => {
        if (v <= 1) {
          if (delTimer.current) clearInterval(delTimer.current);
          delTimer.current = null;
          setConfirmDel(false);
          return 0;
        }
        return v - 1;
      });
    }, 1000);
  };
  useEffect(
    () => () => {
      if (delTimer.current) clearInterval(delTimer.current);
    },
    [],
  );
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

  /* Esc 关闭：桌面看文件时手不用离开键盘；确认态下先退回「删除」再关，别一按就把框关了 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirmDel) {
        setConfirmDel(false);
        setDelCount(0);
        if (delTimer.current) clearInterval(delTimer.current);
        delTimer.current = null;
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, confirmDel]);

  /**
   * 相对 **data/work** 的路径 —— /api/work/probe、/api/work/transcode 都是这个口径。
   * 注意别跟上面的 relPath 混：relPath 是相对**会话目录**的（删除文件那个接口要的是它），
   * 拿它去 probe 会 404（实测就踩了这个，界面显示"探测失败"）。
   */
  const workRel = (() => {
    const marker = "/api/work/file/";
    const u = url ?? "";
    const i = u.indexOf(marker);
    if (i >= 0) {
      try {
        return decodeURIComponent(u.slice(i + marker.length));
      } catch {
        return u.slice(i + marker.length);
      }
    }
    return sessionId ? `sessions/${sessionId}/${relPath}` : relPath;
  })();

  /* 视频：先探编码（几毫秒，ffprobe 只读文件头），决定放播放器还是放转码入口 */
  useEffect(() => {
    let alive = true;
    setProbe(null);
    setVideoUrl(null);
    setVideoFailed(false);
    setConvErr(null);
    if (!url || kind !== "video" || !sessionId) return;
    void api
      .probeWorkFile(workRel)
      .then((p) => alive && setProbe(p))
      .catch(() => alive && setProbe({ ok: false, reason: "探测失败（后端没有 ffprobe？）" }));
    return () => {
      alive = false;
    };
  }, [url, kind, workRel, sessionId]);

  const convert = async () => {
    if (!sessionId || converting) return;
    setConverting(true);
    setConvErr(null);
    try {
      const r = await api.transcodeWorkFile(workRel);
      setVideoUrl(r.url);
      setProbe(r.probe);
      setVideoFailed(false);
      onFileAdded?.(); // 转出的新文件要出现在会话文件清单里
    } catch (e) {
      setConvErr(e instanceof Error ? e.message : "转换失败");
    } finally {
      setConverting(false);
    }
  };

  /* Office / 思维导图：让后端解析成结构。探针式的失败（老格式、损坏）不是错误页，
     而是"这里放一句人话 + 仍然给下载"。 */
  useEffect(() => {
    let alive = true;
    setParsed(null);
    setParseErr(null);
    if (!sessionId || !isServerParsedKind(kind)) return;
    setParsing(true);
    void api
      .previewWorkFile(workRel)
      .then((r) => {
        if (!alive) return;
        if (r.ok) {
          setParsed(r);
        } else {
          setParseErr(r.error || "解不了这个文件");
        }
      })
      .catch((e) => alive && setParseErr(e instanceof Error ? e.message : "解析请求失败"))
      .finally(() => alive && setParsing(false));
    return () => {
      alive = false;
    };
    // workRel 由 path/sessionId 派生，两者变了才需要重新解析
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workRel, kind, sessionId]);

  useEffect(() => {
    let alive = true;
    if (!url || !isTextishKind(kind)) return;
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
        /* Markdown/表格要完整结构（否则表格被切在半行上），代码保持小窗口 */
        setText(t.slice(0, isTextishKind(kind) && kind !== "text" ? PREVIEW_BYTES_RICH : PREVIEW_BYTES));
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
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 shrink-0" style={{ color: "var(--color-muted)" }}>
              <FileTypeIcon kind={fileTypeKey(file.path)} size={18} />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-medium mono">{file.name ?? baseName(file.path)}</h2>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px]" style={{ color: "var(--color-muted)" }}>
                {extOf(file.path) ? (
                  <span className="mono rounded px-1 py-[1px]" style={{ background: "var(--color-surface-2)" }}>
                    {extOf(file.path).toUpperCase()}
                  </span>
                ) : null}
                <span>{KIND_LABEL[kind]}</span>
                {file.size != null || bytes != null ? <span>· {fmt.bytes(bytes ?? file.size ?? 0)}</span> : null}
                {file.mtime ? <span>· {fmt.stamp(file.mtime * 1000)}</span> : null}
              </p>
            </div>
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
          ) : kind === "pdf" ? (
            /* PDF：直接用浏览器自带的阅读器（不引第三方 viewer，体积与安全都省） */
            <iframe
              src={url}
              title={file.name ?? baseName(file.path)}
              className="h-[62dvh] w-full rounded-[10px] border"
              style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
            />
          ) : kind === "audio" ? (
            <div
              className="rounded-[10px] border p-4"
              style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
            >
              <audio src={url} controls className="w-full" />
              <p className="mt-2 text-[12px]" style={{ color: "var(--color-muted)" }}>
                浏览器不支持这个音频编码时，用下面的「下载」本机播放。
              </p>
            </div>
          ) : kind === "video" ? (
            (() => {
              const playUrl = videoUrl ?? url;
              /* probe 失败（没有 ffprobe 之类）时不能假装"能播" —— 归到"试试转码"这一档 */
              const verdict = probe?.playable ?? (probe ? "maybe" : "yes");
              const warn = videoFailed
                ? "你的设备解不开这个编码"
                : verdict === "no"
                  ? probe?.reason || "浏览器解不了这个编码"
                  : verdict === "maybe"
                    ? probe?.reason || "部分设备放不出这个编码"
                    : "";
              return (
                <div>
                  <video
                    key={playUrl}
                    src={playUrl}
                    controls
                    autoPlay={Boolean(videoUrl)}
                    playsInline
                    preload="metadata"
                    onError={() => setVideoFailed(true)}
                    className="max-h-[62dvh] w-full rounded-[10px] border"
                    style={{ borderColor: "var(--color-border)", background: "#000" }}
                  />
                  {(warn || converting || convErr) && (
                    <div
                      className="mt-2 rounded-[10px] border p-2.5 text-[12.5px]"
                      style={{ borderColor: warn ? "var(--color-warn, #b45309)" : "var(--color-border)" }}
                    >
                      {warn ? (
                        <p className="leading-relaxed" style={{ color: "var(--color-warn, #b45309)" }}>
                          {warn}
                          {probe?.video ? `（当前编码 ${probe.video.toUpperCase()}）` : ""}
                        </p>
                      ) : null}
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className="btn btn-primary px-2.5 max-md:min-h-[36px]"
                          disabled={converting}
                          onClick={() => void convert()}
                        >
                          {converting ? "转换中…（大文件要等一会儿）" : videoUrl ? "重新转一份" : "转成能播的版本（H.264）"}
                        </button>
                        <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                          转完存到同一目录，再打开直接播
                        </span>
                      </div>
                      {convErr ? (
                        <p className="mt-1 text-[12px]" style={{ color: "var(--color-err)" }}>
                          转换失败：{convErr}
                        </p>
                      ) : null}
                    </div>
                  )}
                </div>
              );
            })()
          ) : isServerParsedKind(kind) ? (
            parsing ? (
              <div className="rounded-[10px] border p-3" style={{ borderColor: "var(--color-border)" }}>
                {[88, 70, 44].map((w) => (
                  <div
                    key={w}
                    className="mb-2 h-[9px] rounded-full last:mb-0"
                    style={{ width: `${w}%`, background: "var(--color-surface-2)", animation: "pulse 1.4s ease-in-out infinite" }}
                  />
                ))}
              </div>
            ) : parseErr ? (
              <p
                className="rounded-[10px] border p-3 text-[12.5px] leading-relaxed"
                style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}
              >
                {parseErr}
              </p>
            ) : !parsed?.kind ? (
              <p className="text-[12.5px]" style={{ color: "var(--color-muted)" }}>
                没有内容可显示
              </p>
            ) : parsed.kind === "spreadsheet" ? (
              <SpreadsheetView sheets={(parsed.payload?.sheets as SheetData[]) ?? []} />
            ) : parsed.kind === "document" ? (
              <DocumentView blocks={parsed.payload?.blocks ?? []} />
            ) : parsed.kind === "slides" ? (
              <SlidesView slides={parsed.payload?.slides ?? []} />
            ) : (
              <OutlineView sheets={(parsed.payload?.sheets as OutlineSheet[]) ?? []} />
            )
          ) : kind === "html" ? (
            /* HTML 用沙箱 iframe：不给脚本、不给同源 —— 别人的页面不能在我们的域里跑代码 */
            <iframe
              src={url}
              sandbox=""
              title={file.name ?? baseName(file.path)}
              className="h-[52dvh] w-full rounded-[10px] border"
              style={{ borderColor: "var(--color-border)", background: "#fff" }}
            />
          ) : kind === "xml" ? (
            <XmlFetch url={url} path={file.path} />
          ) : isTextishKind(kind) ? (
            state === "loading" ? (
              /* 骨架：三条灰条，比一句"读取中…"更像在加载（也避免文字跳一下） */
              <div className="rounded-[10px] border p-3" style={{ borderColor: "var(--color-border)" }}>
                {[92, 74, 48].map((w) => (
                  <div
                    key={w}
                    className="mb-2 h-[9px] rounded-full last:mb-0"
                    style={{ width: `${w}%`, background: "var(--color-surface-2)", animation: "pulse 1.4s ease-in-out infinite" }}
                  />
                ))}
              </div>
            ) : state === "fail" ? (
              <p className="rounded-[10px] border p-3 text-[12.5px]" style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}>
                读不出内容（文件可能已被删掉或移走），可以直接下载试试。
              </p>
            ) : (
              <div>
                {/* Markdown：默认渲染成排版（看文档就该像文档），可一键切源码 */}
                {kind === "markdown" && !rawView ? (
                  <div
                    className="max-h-[52dvh] overflow-auto rounded-[10px] border p-4"
                    style={{ borderColor: "var(--color-border)" }}
                  >
                    <Markdown text={text || ""} />
                  </div>
                ) : kind === "table" && !rawView ? (
                  <TablePreview text={text || ""} path={file.path} />
                ) : kind === "json" && !rawView ? (
                  /* JSON：折叠树。比一大段括号好读得多，而且能按 key 收起来找结构 */
                  <JsonView text={text || ""} />
                ) : (
                  /* 代码/纯文本：CodeBlock —— JSON/XML 自动格式化 + 着色 */
                  <div className="max-h-[46dvh] overflow-auto">
                    <CodeBlock code={text || ""} lang={extOf(file.path)} />
                  </div>
                )}
                <div
                  className="flex flex-wrap items-center gap-2 px-1 pt-1 text-[12px]"
                  style={{ color: "var(--color-muted)" }}
                >
                  {(kind === "markdown" || kind === "table" || kind === "json") && (
                    <button
                      type="button"
                      className="btn px-2 py-0.5 text-[12px] max-md:min-h-[32px]"
                      onClick={() => setRawView((v) => !v)}
                    >
                      {rawView
                        ? kind === "table"
                          ? "看表格"
                          : kind === "json"
                            ? "看结构"
                            : "看排版"
                        : "看源码"}
                    </button>
                  )}
                  只显示前{" "}
                  {kind === "text" ? Math.round(PREVIEW_BYTES / 1000) : Math.round(PREVIEW_BYTES_RICH / 1000)}KB
                  {truncated ? "（内容更长，下载看全文）" : ""}
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
              能直接看的有：图片、PDF、音频、视频、Word/Excel/PPT（含 xlsx/docx/pptx）、思维导图（xmind）、
              Markdown、CSV/TSV、JSON/XML、代码与纯文本。
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
                  countdown(4);
                  return;
                }
                void remove();
              }}
              title={confirmDel ? "再点一次就删掉了（不可撤销）" : "删掉这个文件（会再确认一次）"}
            >
              {deleting ? "删除中…" : confirmDel ? `确认删除${delCount > 0 ? ` ${delCount}` : ""}` : "删除"}
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
