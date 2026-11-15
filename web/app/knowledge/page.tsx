"use client";

/**
 * 知识中心（阶段 2 范围：文档 / 存储设置）。
 *
 * 口径：
 *   · 一行一份文档，点行右侧抽屉看详情（元数据 / 解析文本 / 原件下载）；
 *   · 上传后立刻出现在列表，状态自己会从「解析中」变成「已就绪」；
 *   · 存储设置能看到落盘路径、能测连接——这是"原件到底在哪"的唯一答案。
 *
 * 分类树、标签、关联图谱、整理任务在后续阶段接进来（标签页先占位）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import type { KnowledgeDoc, KnowledgeStorage } from "@/lib/types";
import { DetailPanel } from "@/components/ui/DetailPanel";
import { Chip, KV, PageHead } from "@/components/ui/kit";
import { useFeedback } from "@/components/ui/feedback";

function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ago(ts?: number | null): string {
  if (!ts) return "—";
  const d = Math.max(0, Date.now() - ts);
  if (d < 60_000) return "刚刚";
  if (d < 3_600_000) return `${Math.round(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} 小时前`;
  return `${Math.round(d / 86_400_000)} 天前`;
}

const STATUS: Record<string, { label: string; tone: "ok" | "warn" | "err" | "muted" }> = {
  ready: { label: "已就绪", tone: "ok" },
  parsing: { label: "解析中", tone: "warn" },
  uploading: { label: "上传中", tone: "warn" },
  failed: { label: "失败", tone: "err" },
};

export default function KnowledgePage() {
  const fb = useFeedback();
  const [tab, setTab] = useState<"docs" | "storage">("docs");
  const [rows, setRows] = useState<KnowledgeDoc[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<KnowledgeDoc | null>(null);
  const [text, setText] = useState<{ ord: number; text: string; page?: number | null; sheet?: string }[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [storages, setStorages] = useState<KnowledgeStorage[] | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const load = useCallback(async () => {
    try {
      const got = await api.knowledgeDocs(q.trim() ? { q: q.trim() } : {});
      setRows(got.items);
    } catch (e) {
      fb.error("读取文档失败", e instanceof Error ? e.message : String(e));
    }
  }, [q, fb]);

  useEffect(() => {
    void load();
    // 解析是后台跑的：列表在时，每 3 秒看一次状态，直到没有「解析中」
    const t = window.setInterval(() => {
      if ((rows ?? []).some((r) => r.status === "parsing" || r.status === "uploading")) void load();
    }, 3000);
    return () => window.clearInterval(t);
  }, [load, rows]);

  const loadStorages = useCallback(async () => {
    try {
      const got = await api.knowledgeStorages();
      setStorages(got.items);
    } catch {
      setStorages([]);
    }
  }, []);

  useEffect(() => {
    void loadStorages();
  }, [loadStorages]);

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setBusy(true);
    try {
      const got = await api.knowledgeUpload(list);
      if (got.duplicates?.length) {
        fb.warn(`已存在相同内容：${got.duplicates.map((d) => d.name).join("、")}（已跳过）`);
      }
      if (got.documents?.length) fb.success(`已加入 ${got.documents.length} 份文档，正在解析`);
      await load();
    } catch (e) {
      fb.error("上传失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openDoc = async (row: KnowledgeDoc) => {
    setSel(row);
    setText(null);
    try {
      const got = await api.knowledgeText(row.id);
      setText(got.chunks);
    } catch {
      setText([]);
    }
  };

  return (
    <div className="p-4 md:p-6 lg:p-7 max-w-6xl">
      <PageHead
        title="知识中心"
        desc="原始文档与解析结果；沉淀出的 Skill 会记录来源文档"
        actions={
          <>
            <button className="btn" onClick={() => setTab("storage")} type="button">
              存储设置
            </button>
            <button className="btn btn-primary" onClick={() => fileRef.current?.click()} disabled={busy} type="button">
              {busy ? "上传中…" : "＋ 上传文档"}
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void upload(e.target.files);
                e.target.value = "";
              }}
            />
          </>
        }
      />

      <div className="mt-1 mb-4 flex flex-wrap items-center gap-2">
        <Chip tone={tab === "docs" ? "accent" : "muted"} title="文档库">
          <button type="button" onClick={() => setTab("docs")}>文档</button>
        </Chip>
        <Chip tone={tab === "storage" ? "accent" : "muted"} title="存储位置与容量">
          <button type="button" onClick={() => setTab("storage")}>存储设置</button>
        </Chip>
        <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
          分类与标签、关联图谱、整理任务在后续阶段接入
        </span>
      </div>

      {tab === "docs" ? (
        <>
          <div
            className="mb-3 rounded-lg px-3 py-3 text-[12px]"
            style={{ background: "var(--color-surface-2)", color: "var(--color-text-3)" }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files?.length) void upload(e.dataTransfer.files);
            }}
          >
            {dragOver ? "松手即上传" : "把文件拖到这里，或点右上「上传文档」。支持 PDF / DOCX / XLSX / PPTX / MD / TXT / HTML，单文件 100MB 内"}
          </div>

          <div className="mb-2 flex flex-wrap items-center gap-2">
            <input
              className="input h-8 flex-1 text-[12px] sm:max-w-xs"
              placeholder="搜文件名或正文"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button className="btn btn-sm" type="button" onClick={() => void load()}>
              刷新
            </button>
            <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
              共 {rows?.length ?? 0} 份
            </span>
          </div>

          {rows === null ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-11 animate-pulse rounded-md" style={{ background: "var(--color-line)" }} />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-lg px-4 py-10 text-center" style={{ background: "var(--color-surface-2)" }}>
              <div className="text-[13px]" style={{ color: "var(--color-text-2)" }}>还没有文档</div>
              <div className="mt-1 text-[12px]" style={{ color: "var(--color-text-3)" }}>
                上传一份 PDF 或表格，解析完就能被检索、被整理成 Skill
              </div>
              <button className="btn btn-primary btn-sm mt-3" type="button" onClick={() => fileRef.current?.click()}>
                上传第一份文档
              </button>
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg" style={{ background: "var(--color-surface)" }}>
              <div className="flex items-center gap-3 px-3 py-1.5 text-[11px]"
                   style={{ background: "var(--color-surface-2)", color: "var(--color-text-3)" }}>
                <span className="min-w-0 flex-[3]">名称</span>
                <span className="w-14">类型</span>
                <span className="w-16">大小</span>
                <span className="w-20">状态</span>
                <span className="w-20 text-right">更新时间</span>
              </div>
              {rows.map((r) => {
                const st = STATUS[r.status] ?? STATUS.uploading;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => void openDoc(r)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--bg-hover,rgba(0,0,0,0.03))]"
                    style={{ minHeight: 44 }}
                  >
                    <span className="min-w-0 flex-[3]">
                      <span className="block truncate text-[13px]">{r.name}</span>
                      <span className="block truncate text-[11px]" style={{ color: "var(--color-text-3)" }}>
                        {r.parsed?.textLength ? `${r.parsed.textLength} 字` : "—"} · {r.storage_path || ""}
                      </span>
                    </span>
                    <span className="w-14 text-[11px] uppercase" style={{ color: "var(--color-text-2)" }}>{r.kind}</span>
                    <span className="w-16 text-[11px]" style={{ color: "var(--color-text-2)" }}>{sizeText(r.size)}</span>
                    <span className="w-20">
                      <span className="flex items-center gap-1 text-[11px]">
                        <span
                          aria-hidden
                          className="inline-block h-1.5 w-1.5 rounded-full"
                          style={{
                            background:
                              st.tone === "ok" ? "var(--color-ok,#16a34a)"
                              : st.tone === "err" ? "var(--color-err)"
                              : "var(--color-warn,#d97706)",
                          }}
                        />
                        {st.label}
                      </span>
                    </span>
                    <span className="w-20 text-right text-[11px]" style={{ color: "var(--color-text-3)" }}>
                      {ago(r.updated_at)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <StoragePanel storages={storages} onRefresh={() => void loadStorages()} />
      )}

      {sel && (
        <DetailPanel
          title={sel.name}
          subtitle={
            <>
              <span>{sel.kind.toUpperCase()}</span>
              <span>·</span>
              <span>{sizeText(sel.size)}</span>
              <span>·</span>
              <span>{(STATUS[sel.status] ?? STATUS.uploading).label}</span>
            </>
          }
          icon={<span className="text-[13px] font-semibold">{sel.kind.slice(0, 3).toUpperCase() || "DOC"}</span>}
          actions={
            <>
              <a className="btn btn-sm" href={`/api/knowledge/documents/${sel.id}/original`} target="_blank" rel="noreferrer">
                下载原件
              </a>
              <button
                className="btn btn-sm"
                type="button"
                onClick={async () => {
                  try {
                    await api.knowledgeReparse(sel.id);
                    fb.success("已重新排队解析");
                    await load();
                  } catch (e) {
                    fb.error("重解析失败", e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                重新解析
              </button>
              <button
                className="btn btn-sm"
                type="button"
                style={{ color: "var(--color-err)" }}
                onClick={async () => {
                  if (!window.confirm(`删除「${sel.name}」？原件与解析文本都会删掉。`)) return;
                  try {
                    await api.knowledgeDelete(sel.id);
                    setSel(null);
                    fb.success("已删除");
                    await load();
                  } catch (e) {
                    fb.error("删除失败", e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                删除
              </button>
            </>
          }
          onClose={() => setSel(null)}
        >
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
              <KV k="存储路径">
                <code className="mono break-all text-[11px]">{sel.storage_path || "—"}</code>
              </KV>
              <KV k="sha256">
                <code className="mono break-all text-[11px]">{sel.sha256.slice(0, 16)}…</code>
              </KV>
              <KV k="解析器">{sel.parsed?.parserVersion ? `v${sel.parsed.parserVersion}` : "—"}</KV>
              <KV k="解析耗时">{sel.parsed?.ms != null ? `${sel.parsed.ms} ms` : "—"}</KV>
              <KV k="页数 / 工作表">
                {sel.parsed?.pages ?? (sel.parsed?.sheets?.length ? sel.parsed.sheets.join("、") : "—")}
              </KV>
              <KV k="版本">v{sel.version}</KV>
            </div>
            {sel.error?.message && (
              <div className="rounded-md px-2.5 py-2 text-[12px]"
                   style={{ background: "color-mix(in srgb, var(--color-err) 8%, transparent)", color: "var(--color-err)" }}>
                {sel.error.message}
              </div>
            )}
            <div>
              <div className="mb-1.5 text-[12px] font-medium">解析文本</div>
              {text === null ? (
                <div className="h-16 animate-pulse rounded-md" style={{ background: "var(--color-line)" }} />
              ) : text.length === 0 ? (
                <div className="text-[12px]" style={{ color: "var(--color-text-3)" }}>
                  {sel.status === "failed" ? "解析失败，没有文本" : "还没有解析文本"}
                </div>
              ) : (
                <div className="space-y-2">
                  {text.map((c) => (
                    <div key={c.ord} className="rounded-md p-2.5 text-[12.5px] leading-relaxed"
                         style={{ background: "var(--color-surface-2)", color: "var(--color-text-2)", whiteSpace: "pre-wrap" }}>
                      {c.page != null && (
                        <span className="mr-1 text-[11px]" style={{ color: "var(--color-text-3)" }}>第 {c.page} 页</span>
                      )}
                      {c.sheet && (
                        <span className="mr-1 text-[11px]" style={{ color: "var(--color-text-3)" }}>{c.sheet}</span>
                      )}
                      {c.text.slice(0, 900)}
                      {c.text.length > 900 ? "…" : ""}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </DetailPanel>
      )}
    </div>
  );
}

function StoragePanel({ storages, onRefresh }: { storages: KnowledgeStorage[] | null; onRefresh: () => void }) {
  const fb = useFeedback();
  const [busy, setBusy] = useState<string | null>(null);
  if (storages === null) {
    return <div className="h-24 animate-pulse rounded-md" style={{ background: "var(--color-line)" }} />;
  }
  return (
    <div className="space-y-2">
      {storages.map((s) => (
        <div key={s.id} className="rounded-lg p-3" style={{ background: "var(--color-surface-2)" }}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium">{s.name}</span>
            <Chip tone="muted">{s.type === "local" ? "本地磁盘" : "S3 兼容"}</Chip>
            {s.is_default && <Chip tone="accent">默认</Chip>}
            {s.last_test_ok === true && <Chip tone="ok">连接正常</Chip>}
            {s.last_test_ok === false && <Chip tone="err">连接失败</Chip>}
            <span className="ml-auto flex gap-1.5">
              <button
                className="btn btn-sm"
                type="button"
                disabled={busy === s.id}
                onClick={async () => {
                  setBusy(s.id);
                  try {
                    const got = await api.knowledgeTestStorage(s.id);
                    if (got.ok) fb.success(`连接正常（${got.latency_ms ?? "?"} ms）`);
                    else fb.error("连接失败", got.error || "");
                    onRefresh();
                  } catch (e) {
                    fb.error("测试失败", e instanceof Error ? e.message : String(e));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                测试连接
              </button>
              {!s.is_default && (
                <button
                  className="btn btn-sm"
                  type="button"
                  disabled={busy === s.id}
                  onClick={async () => {
                    setBusy(s.id);
                    try {
                      await api.knowledgeSetDefaultStorage(s.id);
                      fb.success("已设为默认（新文档写到这里）");
                      onRefresh();
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  设为默认
                </button>
              )}
            </span>
          </div>
          <div className="mt-1.5 space-y-1">
            <KV k="位置">
              <code className="mono break-all text-[11px]">
                {s.type === "local" ? String(s.params?.root ?? "") : `${s.params?.endpoint ?? ""}/${s.params?.bucket ?? ""}`}
              </code>
            </KV>
            <KV k="路径模板">
              <code className="mono text-[11px]">{s.path_template}</code>
            </KV>
            {s.last_test_error && (
              <div className="text-[11px]" style={{ color: "var(--color-err)" }}>{s.last_test_error}</div>
            )}
          </div>
        </div>
      ))}
      <div className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
        新增 S3 兼容存储（OSS / COS / MinIO）与迁移向导在阶段 2 收尾时接上；当前默认是本地磁盘。
      </div>
    </div>
  );
}
