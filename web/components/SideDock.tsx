"use client";

/**
 * 右侧工具坞：浏览器画面 / 会话文件。
 *
 * 为什么要有它：画面要被看清，就得有一块地方一直给它；对话要能被读，就不能被遮。
 * 靠"就地长高"解决不了这个矛盾，只有分栏能解决 —— 但栏里只能放**一样**东西，
 * 否则它很快会变成第二个日志栏（用户开始盯它、不再读结论）。
 *
 * 形态：
 *   · 展开 = 44px 图标轨 + 面板（默认 400，可拖到 320~560）
 *   · 收起 = 只剩图标轨，点图标直接展开到那一个
 *   · 只在 ≥1280 出现：更窄的屏切两半，两边都不能用（手机走原来的抽屉/浮层）
 *
 * 切换不做 tab 文字行（tab 会让人以为里面是并列的几块），靠左侧那一条图标；
 * 图标本身就是收起态，一举两得。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { BrowserStage, type BrowserAction, type BrowserFrameData } from "@/components/BrowserStage";
import { FileRowButton } from "@/components/FileDialog";
import { FileTypeIcon } from "@/components/ui/icons";
import { ExecutionTimeline } from "@/components/ExecutionTimeline";
import { api, fmt } from "@/lib/api";
import { fileTypeKey, shortFilePath } from "@/lib/files";
import type { BrowserStep } from "@/lib/types";

export type DockPanel = "outline" | "browser" | "files" | "steps";

const MIN_W = 320;
const MAX_W = 560;
const DEFAULT_W = 400;

export function SideDock({
  panel,
  onPanel,
  open,
  onOpenChange,
  width,
  onWidth,
  /* 浏览器 */
  frame,
  actions,
  steps,
  browserBusy,
  browserWaiting,
  onBrowserOpenFull,
  onUserClick,
  onUserText,
  onUserScroll,
  browserPaused,
  onBrowserPause,
  /* 文件 */
  sessionId,
  files,
  workDir,
  filesBusy,
  onFilesRefresh,
  hasNewFiles,
  deliverable,
  onPublishDeliverable,
  deliverableZipUrl,
  /* 目录 */
  outline,
  outlineLoading,
  activeTurn,
  onJumpTurn,
  /* 步骤 */
  stepRunId,
  currentRunId,
}: {
  panel: DockPanel | null;
  onPanel: (p: DockPanel) => void;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  width: number;
  onWidth: (w: number) => void;
  frame: BrowserFrameData | null;
  actions: BrowserAction[];
  steps: BrowserStep[];
  browserBusy?: boolean;
  browserWaiting?: boolean;
  onBrowserOpenFull?: () => void;
  onUserClick?: (x: number, y: number) => void | Promise<void>;
  onUserText?: (t: string) => void | Promise<void>;
  onUserScroll?: (dy: number) => void | Promise<void>;
  browserPaused?: boolean;
  onBrowserPause?: (paused: boolean) => void;
  sessionId?: string;
  files: {
    path: string;
    size: number;
    mtime?: number;
    url?: string;
    run_id?: string | null;
    turn_index?: number | null;
  }[];
  workDir?: string;
  filesBusy?: boolean;
  onFilesRefresh?: () => void;
  hasNewFiles?: boolean;
  /** 会话产物（product/）：面板顶部一行，跟"文件 · 产物"菜单同源 */
  deliverable?: { exists: boolean; file_count: number; size: number } | null;
  onPublishDeliverable?: () => void;
  deliverableZipUrl?: string;
  /** 会话目录：一轮一条 */
  outline?: {
    turn_id: string;
    seq: number;
    digest: string;
    status: "done" | "running" | "waiting" | "error";
    created_at: number;
    step_count: number;
    artifact_count: number;
  }[];
  /** 目录还在加载（出骨架，不阻塞对话） */
  outlineLoading?: boolean;
  /** 当前所在那一轮（滚动同步） */
  activeTurn?: number | null;
  onJumpTurn?: (seq: number) => void;
  /** 「步骤」面板看哪一次执行 */
  stepRunId?: string | null;
  /** 产物分组用：当前这一轮的 run id */
  currentRunId?: string | null;
}) {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; w: number } | null>(null);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<string[]>([]);
  const [confirmDel, setConfirmDel] = useState(false);
  const [busyDel, setBusyDel] = useState(false);
  const [uploading, setUploading] = useState(false);
  /** 批量下载失败的行内提示（不用 alert：原生弹窗会卡住 SSE） */
  const [zipErr, setZipErr] = useState<string | null>(null);
  /** 目录过滤词（本地过滤，150ms 防抖） */
  const [outlineQ, setOutlineQ] = useState("");
  const [outlineQDeb, setOutlineQDeb] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setOutlineQDeb(outlineQ.trim().toLowerCase()), 150);
    return () => window.clearTimeout(t);
  }, [outlineQ]);
  const shownOutline = (outline || []).filter(
    (it) => !outlineQDeb || (it.digest || "").toLowerCase().includes(outlineQDeb),
  );
  const fileRef = useRef<HTMLInputElement>(null);

  /* 拖动改宽：只在拖动期间挂 document 监听，松手就摘 */
  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const next = Math.min(MAX_W, Math.max(MIN_W, d.w - (e.clientX - d.x)));
      onWidth(next);
    };
    const up = () => {
      setDragging(false);
      dragRef.current = null;
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
  }, [dragging, onWidth]);

  /* 切面板时清掉选择态：换到文件面不该带着上一次的勾选 */
  useEffect(() => {
    setPick([]);
    setConfirmDel(false);
  }, [panel]);

  const shown = files.filter((f) => {
    const kw = q.trim().toLowerCase();
    return !kw || f.path.toLowerCase().includes(kw);
  });

  /** 产物分组：本回合 / 更早（没有当前 run 时就只有一个「全部」） */
  const rows: ({ kind: "head"; label: string; n: number } | { kind: "file"; f: (typeof shown)[number] })[] =
    (() => {
      const mine = currentRunId ? shown.filter((f) => f.run_id === currentRunId) : [];
      const rest = shown.filter((f) => !mine.includes(f));
      const out: typeof rows = [];
      if (mine.length > 0) {
        out.push({ kind: "head", label: "本回合", n: mine.length });
        for (const f of mine) out.push({ kind: "file", f });
        if (rest.length > 0) out.push({ kind: "head", label: "更早", n: rest.length });
      } else if (rest.length > 0) {
        out.push({ kind: "head", label: "全部", n: rest.length });
      }
      for (const f of rest) out.push({ kind: "file", f });
      return out;
    })();

  const doDelete = useCallback(async () => {
    if (!sessionId || pick.length === 0 || busyDel) return;
    setBusyDel(true);
    try {
      await api.deleteSessionFiles(sessionId, pick);
      setPick([]);
      setConfirmDel(false);
      onFilesRefresh?.();
    } finally {
      setBusyDel(false);
    }
  }, [sessionId, pick, busyDel, onFilesRefresh]);

  const doUpload = useCallback(
    async (list: FileList | null) => {
      if (!list || list.length === 0) return;
      setUploading(true);
      try {
        await api.uploadSessionFile(sessionId!, Array.from(list));
        onFilesRefresh?.();
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [onFilesRefresh],
  );

  const rail = (p: DockPanel, label: string, badge: number | undefined, icon: React.ReactNode) => {
    const active = open && panel === p;
    const n = badge ?? 0;
    const tip = open && panel === p ? `收起${label}` : n > 0 ? `${label} · ${n}` : label;
    return (
      <button
        key={p}
        type="button"
        data-tap
        data-tip={tip}
        aria-label={tip}
        aria-pressed={active}
        onClick={() => {
          if (open && panel === p) {
            onOpenChange(false);
          } else {
            onPanel(p);
            onOpenChange(true);
          }
        }}
        className="relative grid h-10 w-10 place-items-center rounded-[10px] transition-colors"
        style={{
          color: active ? "var(--color-accent)" : "var(--color-muted)",
          background: active ? "color-mix(in srgb, var(--color-accent) 10%, transparent)" : "transparent",
        }}
      >
        {icon}
        {n > 0 ? (
          <span aria-hidden className="count-badge">
            {n > 99 ? "99+" : n}
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <aside
      data-sidedock
      data-open={open ? "1" : "0"}
      className="relative hidden shrink-0 flex-row xl:flex"
      style={{ background: "var(--color-surface)" }}
    >
      {/* 拖宽手柄：贴在面板左缘，宽 6px，命中区比线宽大 */}
      {open ? (
        <span
          role="separator"
          aria-orientation="vertical"
          aria-label="调整右栏宽度"
          onMouseDown={(e) => {
            dragRef.current = { x: e.clientX, w: width };
            setDragging(true);
          }}
          className="absolute -left-[3px] top-0 bottom-0 z-10 w-[6px] cursor-col-resize"
          style={{ background: dragging ? "var(--color-accent)" : "transparent" }}
        />
      ) : null}

      {/* 图标轨：收起态就是它 */}
      <div
        className="flex w-[52px] shrink-0 flex-col items-center gap-1 py-2"
        style={{ background: "var(--color-surface-2)" }}
      >
        {rail(
          "outline",
          "目录",
          outline?.length,
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 6h12M4 12h12M4 18h12" />
            <circle cx="20" cy="6" r="1.4" />
            <circle cx="20" cy="12" r="1.4" />
            <circle cx="20" cy="18" r="1.4" />
          </svg>,
        )}
        {rail(
          "browser",
          "浏览器",
          steps.length,
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M3 9h18M9 3c-2 3-2 15 0 18M15 3c2 3 2 15 0 18" />
          </svg>,
        )}
        {rail(
          "steps",
          "步骤",
          undefined,
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 6h10M4 12h16M4 18h7" />
            <circle cx="19" cy="6" r="1.6" />
            <circle cx="14" cy="18" r="1.6" />
          </svg>,
        )}
        {rail(
          "files",
          "产物",
          files.length,
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
          </svg>,
        )}
      </div>

      {/* 面板 */}
      {open && panel ? (
        <div className="flex min-h-0 flex-col" style={{ width }}>
          <div
            className="flex h-9 shrink-0 items-center gap-2 px-2.5"
            style={{ borderBottom: "1px solid var(--color-border)" }}
          >
            <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--color-text)" }}>
              {panel === "browser"
                ? "浏览器画面"
                : panel === "steps"
                  ? "步骤详情"
                  : panel === "outline"
                    ? "目录"
                    : "产物"}
            </span>
            {panel === "browser" && onBrowserOpenFull ? (
              <button
                type="button"
                data-tap
                onClick={onBrowserOpenFull}
                className="rounded px-1 text-[11px] hover:underline"
                style={{ color: "var(--color-muted)" }}
                title="全屏看（Esc 退出）"
              >
                全屏
              </button>
            ) : null}
            <button
              type="button"
              data-tap
              onClick={() => onOpenChange(false)}
              className="grid h-6 w-6 place-items-center rounded hover:bg-[var(--color-surface-2)]"
              aria-label="收起右栏"
              title="收起"
              style={{ color: "var(--color-muted)" }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m9 6 6 6-6 6" />
              </svg>
            </button>
          </div>

          {panel === "outline" ? (
            <div className="flex min-h-0 flex-1 flex-col" role="navigation" aria-label="会话目录">
              {(outline?.length ?? 0) > 10 && (
                <div className="shrink-0 px-2 pb-1 pt-2">
                  <input
                    className="input h-8 w-full text-[12px]"
                    placeholder="过滤这一会话的问题"
                    value={outlineQ}
                    onChange={(e) => setOutlineQ(e.target.value)}
                    aria-label="过滤目录"
                  />
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {outlineLoading ? (
                <div className="space-y-1.5 px-1 py-2" aria-busy="true" aria-label="目录加载中">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i} className="flex items-center gap-2 px-1">
                      <span className="h-2.5 w-4 rounded" style={{ background: "var(--color-surface-3)" }} />
                      <span
                        className="h-2.5 flex-1 rounded"
                        style={{ background: "var(--color-surface-3)", opacity: 0.75 - i * 0.12 }}
                      />
                    </div>
                  ))}
                </div>
              ) : !outline || outline.length === 0 ? (
                <p className="px-2 py-3 text-[12px] leading-relaxed" style={{ color: "var(--color-muted)" }}>
                  发送第一个问题后，这里会出现目录。
                </p>
              ) : shownOutline.length === 0 ? (
                <p className="px-2 py-3 text-[12px]" style={{ color: "var(--color-muted)" }}>
                  没有匹配的问题
                </p>
              ) : (
                shownOutline.map((it) => {
                  const active = activeTurn === it.seq;
                  const time = new Date(it.created_at).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  });
                  const bits = [time];
                  if (it.step_count > 0) bits.push(`${it.step_count} 步`);
                  if (it.artifact_count > 0) bits.push(`${it.artifact_count} 个文件`);
                  return (
                    <button
                      key={it.turn_id}
                      type="button"
                      data-tap
                      aria-current={active ? "location" : undefined}
                      aria-label={`第 ${it.seq} 个问题：${it.digest}`}
                      onClick={() => onJumpTurn?.(it.seq)}
                      className="mb-[2px] flex min-h-[48px] w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-selected)]"
                      style={{ background: active ? "var(--bg-selected)" : "transparent" }}
                    >
                      <span className="w-6 shrink-0 text-right text-[11px] tabular-nums" style={{ color: "var(--color-text-3)" }}>
                        {it.seq}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px]" style={{ color: active ? "var(--color-text)" : "var(--color-text-2)" }}>
                          {it.digest || "（无摘要）"}
                        </span>
                        <span className="mt-0.5 block text-[11px]" style={{ color: "var(--color-text-3)" }}>
                          {bits.join(" · ")}
                        </span>
                      </span>
                      {it.status === "running" ? (
                        <span className="live-dot shrink-0" aria-label="运行中">●</span>
                      ) : it.status === "error" ? (
                        <span className="shrink-0 text-[10px]" style={{ color: "var(--color-err)" }} aria-label="失败">●</span>
                      ) : null}
                    </button>
                  );
                })
              )}
              </div>
            </div>
          ) : panel === "browser" ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <BrowserStage
                variant="panel"
                frame={frame}
                actions={actions}
                steps={steps}
                busy={browserBusy}
                waiting={browserWaiting}
                onUserClick={onUserClick}
                onUserText={onUserText}
                onUserScroll={onUserScroll}
                paused={browserPaused}
                onPauseChange={onBrowserPause}
              />
            </div>
          ) : panel === "steps" ? (
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {stepRunId ? (
                <ExecutionTimeline runId={stepRunId} title="步骤详情" compact />
              ) : (
                <p className="p-2 text-[12.5px] leading-relaxed" style={{ color: "var(--color-muted)" }}>
                  点对话里那一轮的执行过程条 → 「在右栏看」，这里会展开每一步的细节。
                </p>
              )}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              {deliverable?.exists ? (
                <div
                  className="mx-2 mt-2 flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5"
                  style={{ background: "var(--color-surface-2)" }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                  </svg>
                  <span className="min-w-0 flex-1 truncate text-[length:var(--fs-sm)]" style={{ color: "var(--color-text)" }}>
                    产物 · {deliverable.file_count}
                  </span>
                  {deliverableZipUrl ? (
                    <a
                      href={deliverableZipUrl}
                      data-tap
                      className="shrink-0 rounded px-1.5 py-0.5 text-[length:var(--fs-xs)] hover:bg-[var(--color-surface)]"
                      style={{ color: "var(--color-text-2)" }}
                    >
                      下载
                    </a>
                  ) : null}
                  {onPublishDeliverable ? (
                    <button
                      type="button"
                      data-tap
                      onClick={onPublishDeliverable}
                      className="shrink-0 rounded px-1.5 py-0.5 text-[length:var(--fs-xs)] hover:bg-[var(--color-surface)]"
                      style={{ color: "var(--color-accent)" }}
                    >
                      发布
                    </button>
                  ) : null}
                </div>
              ) : null}

              <div className="flex items-center gap-1.5 px-2 py-2">
                <input
                  className="input h-8 flex-1 text-[12px]"
                  placeholder="筛文件名"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
                <button
                  type="button"
                  data-tap
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading || !sessionId}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg hover:bg-[var(--color-surface-2)] disabled:opacity-50"
                  title="上传文件到会话目录"
                  aria-label="上传文件"
                  style={{ color: "var(--color-muted)" }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M12 16V4m0 0L7 9m5-5 5 5" />
                    <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
                  </svg>
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => void doUpload(e.target.files)}
                />
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
                {shown.length === 0 ? (
                  <div className="px-2 py-3 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                    {files.length === 0
                      ? "这个会话还没有文件 —— 助手生成的东西都会落在会话目录里"
                      : "没有匹配的文件"}
                  </div>
                ) : (
                  rows.map((r) => {
                    if (r.kind === "head") {
                      return (
                        <p
                          key={`h-${r.label}`}
                          className="mt-1.5 px-2 pb-0.5 text-[10.5px] tracking-wide"
                          style={{ color: "var(--color-text-3)" }}
                        >
                          {r.label} · {r.n}
                        </p>
                      );
                    }
                    const f = r.f;
                    const picked = pick.includes(f.path);
                    return (
                      <div key={f.path} className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-pressed={picked}
                          aria-label={picked ? "取消选择" : "选择"}
                          onClick={() =>
                            setPick((cur) =>
                              cur.includes(f.path) ? cur.filter((x) => x !== f.path) : [...cur, f.path],
                            )
                          }
                          className="grid h-7 w-6 shrink-0 place-items-center rounded text-[10px]"
                          style={{ color: picked ? "var(--color-accent)" : "var(--color-muted)" }}
                          title={picked ? "取消选择" : "选择这个文件"}
                        >
                          {picked ? "✓" : "○"}
                        </button>
                        <FileRowButton
                          file={{
                            path: workDir ? `${workDir}/${f.path}` : f.path,
                            url: f.url,
                            size: f.size,
                            mtime: f.mtime,
                          }}
                          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-[var(--color-surface-2)]"
                          style={{ color: "var(--color-text)" }}
                        >
                          <FileTypeIcon kind={fileTypeKey(f.path)} size={14} className="shrink-0 opacity-60" />
                          <span className="mono min-w-0 flex-1 truncate text-[12px]" title={f.path}>
                            {shortFilePath(f.path, 20, 10)}
                          </span>
                          <span className="shrink-0 tabular-nums text-[10.5px]" style={{ color: "var(--color-muted)" }}>
                            {fmt.bytes(f.size)}
                          </span>
                        </FileRowButton>
                      </div>
                    );
                  })
                )}
              </div>

              {/* 批量动作：有勾选才出现（就地出现比常驻一排禁用按钮干净） */}
              {pick.length > 0 ? (
                <div
                  className="flex shrink-0 items-center gap-2 px-2 py-2 text-[11.5px]"
                  style={{ borderTop: "1px solid var(--color-border)", background: "var(--color-surface-2)" }}
                >
                  <span style={{ color: "var(--color-muted)" }}>
                    已选 {pick.length} / {files.length}
                  </span>
                  {zipErr && (
                    <span style={{ color: "var(--color-err)" }} title={zipErr}>
                      打包失败
                    </span>
                  )}
                  <button
                    type="button"
                    data-tap
                    className="ml-auto rounded px-1"
                    style={{ color: "var(--color-muted)" }}
                    onClick={() => {
                      setPick([]);
                      setConfirmDel(false);
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    data-tap
                    className="rounded px-1"
                    style={{ color: "var(--color-accent)" }}
                    title="把这些文件打成一个 zip 下载"
                    onClick={() => {
                      if (!sessionId) return;
                      void api
                        .zipSessionFiles(sessionId, pick)
                        .then(() => setPick([]))
                        .catch((e) => setZipErr(String(e).slice(0, 120)));
                    }}
                  >
                    下载所选
                  </button>
                  <button
                    type="button"
                    data-tap
                    disabled={busyDel}
                    onClick={() => {
                      if (!confirmDel) {
                        setConfirmDel(true);
                        window.setTimeout(() => setConfirmDel(false), 4000);
                        return;
                      }
                      void doDelete();
                    }}
                    className="rounded px-1 font-medium"
                    style={{ color: "var(--color-err)" }}
                  >
                    {busyDel ? "删除中…" : confirmDel ? `确认删除 ${pick.length} 个` : "删除"}
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </aside>
  );
}
