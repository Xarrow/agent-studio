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
import type {
  KnowledgeCategory,
  OrganizeDraft,
  OrganizeJob,
  KnowledgeDoc,
  KnowledgeStorage,
  KnowledgeTag,
} from "@/lib/types";
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
  const [tab, setTab] = useState<"docs" | "categories" | "organize" | "storage">("docs");
  const [urlOpen, setUrlOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState({ url: "", name: "" });
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
            <button className="btn" onClick={() => setUrlOpen((v) => !v)} type="button">
              加链接
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
        <Chip tone={tab === "categories" ? "accent" : "muted"} title="分类树与标签">
          <button type="button" onClick={() => setTab("categories")}>分类与标签</button>
        </Chip>
        <Chip tone={tab === "organize" ? "accent" : "muted"} title="让助手读文档、提分类标签摘要建议">
          <button type="button" onClick={() => setTab("organize")}>整理</button>
        </Chip>
        <Chip tone={tab === "storage" ? "accent" : "muted"} title="存储位置与容量">
          <button type="button" onClick={() => setTab("storage")}>存储设置</button>
        </Chip>
        <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
          关联图谱与来源溯源在后续阶段接入
        </span>
      </div>

      {urlOpen && (
        <div className="mb-3 rounded-lg p-3" style={{ background: "var(--color-surface-2)" }}>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input h-8 flex-1 text-[12px]"
              placeholder="https://…（公网地址；内网与元数据地址会被拒绝）"
              value={urlDraft.url}
              onChange={(e) => setUrlDraft((d) => ({ ...d, url: e.target.value }))}
            />
            <input
              className="input h-8 w-40 text-[12px]"
              placeholder="标题（可留空）"
              value={urlDraft.name}
              onChange={(e) => setUrlDraft((d) => ({ ...d, name: e.target.value }))}
            />
            <button
              className="btn btn-primary btn-sm"
              type="button"
              disabled={busy || !urlDraft.url.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  const got = await api.knowledgeFromUrl({
                    url: urlDraft.url.trim(),
                    name: urlDraft.name.trim() || undefined,
                  });
                  fb.success(`已抓取 ${got.text_length} 字，正在解析`);
                  setUrlDraft({ url: "", name: "" });
                  setUrlOpen(false);
                  await load();
                } catch (e) {
                  fb.error("抓取失败", e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              抓取入库
            </button>
            <button className="btn btn-sm" type="button" onClick={() => setUrlOpen(false)}>
              取消
            </button>
          </div>
          <div className="mt-1.5 text-[11px]" style={{ color: "var(--color-text-3)" }}>
            抓取会保存正文与一份 HTML 快照，原始网页改版也不影响这份知识
          </div>
        </div>
      )}

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
      ) : tab === "organize" ? (
        <OrganizePanel docs={rows ?? []} onApplied={() => void load()} />
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


function CategoriesPanel({ onChanged }: { onChanged: () => void }) {
  const fb = useFeedback();
  const [items, setItems] = useState<KnowledgeCategory[] | null>(null);
  const [tags, setTags] = useState<KnowledgeTag[] | null>(null);
  const [newName, setNewName] = useState("");
  const [newParent, setNewParent] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, t] = await Promise.all([api.knowledgeCategories(), api.knowledgeTags()]);
      setItems(c.items);
      setTags(t.items);
    } catch (e) {
      fb.error("读取分类失败", e instanceof Error ? e.message : String(e));
      setItems([]);
      setTags([]);
    }
  }, [fb]);

  useEffect(() => {
    void load();
  }, [load]);

  const tops = (items ?? []).filter((c) => !c.parent_id);

  const ordered = (() => {
    if (!items) return [];
    const out: KnowledgeCategory[] = [];
    const walk = (pid: string) => {
      for (const c of items.filter((x) => x.parent_id === pid)) {
        out.push(c);
        walk(c.id);
      }
    };
    walk("");
    return out;
  })();

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <input
            className="input h-8 w-48 text-[12px]"
            placeholder="新建分类名"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <select
            className="input h-8 w-40 text-[12px]"
            value={newParent}
            onChange={(e) => setNewParent(e.target.value)}
          >
            <option value="">顶级分类</option>
            {tops.map((c) => (
              <option key={c.id} value={c.id}>
                归到「{c.name}」下
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary btn-sm"
            type="button"
            disabled={busy || !newName.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await api.knowledgeCreateCategory({ name: newName.trim(), parent_id: newParent || undefined });
                setNewName("");
                setNewParent("");
                fb.success("已新建分类");
                await load();
                onChanged();
              } catch (e) {
                fb.error("新建失败", e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            新建
          </button>
          <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
            最多 3 层；文档不跟着分类删
          </span>
        </div>

        {items === null ? (
          <div className="h-20 animate-pulse rounded-md" style={{ background: "var(--color-surface-3)" }} />
        ) : ordered.length === 0 ? (
          <div className="rounded-lg px-3 py-6 text-center text-[12px]"
               style={{ background: "var(--color-surface-2)", color: "var(--color-text-3)" }}>
            还没有分类。先建一个「合同」「技术文档」这样的顶级分类。
          </div>
        ) : (
          <div className="rounded-lg" style={{ background: "var(--color-surface)" }}>
            {ordered.map((c) => (
              <div key={c.id} className="flex items-center gap-2 px-3 py-2" style={{ minHeight: 42 }}>
                <span style={{ paddingLeft: (c.depth - 1) * 16 }}>
                  <span className="text-[13px]">{c.name}</span>
                  <span className="ml-2 text-[11px]" style={{ color: "var(--color-text-3)" }}>
                    {c.doc_count} 份
                  </span>
                </span>
                <span className="ml-auto flex items-center gap-1.5">
                  {editing?.id === c.id ? (
                    <>
                      <input
                        className="input h-7 w-36 text-[12px]"
                        value={editing.name}
                        onChange={(e) => setEditing({ id: c.id, name: e.target.value })}
                      />
                      <button
                        className="btn btn-sm"
                        type="button"
                        onClick={async () => {
                          try {
                            await api.knowledgeRenameCategory(c.id, editing.name.trim());
                            setEditing(null);
                            await load();
                            onChanged();
                          } catch (e) {
                            fb.error("重命名失败", e instanceof Error ? e.message : String(e));
                          }
                        }}
                      >
                        保存
                      </button>
                      <button className="btn btn-sm" type="button" onClick={() => setEditing(null)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="btn btn-sm" type="button" onClick={() => setEditing({ id: c.id, name: c.name })}>
                        重命名
                      </button>
                      <button
                        className="btn btn-sm"
                        type="button"
                        style={{ color: "var(--color-err)" }}
                        onClick={async () => {
                          try {
                            await api.knowledgeDeleteCategory(c.id);
                            fb.success("已删除分类，文档回到未分类");
                            await load();
                            onChanged();
                          } catch (e) {
                            fb.error("删除失败", e instanceof Error ? e.message : String(e));
                          }
                        }}
                      >
                        删除
                      </button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <input
            className="input h-8 w-48 text-[12px]"
            placeholder="新建标签"
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
          />
          <button
            className="btn btn-sm"
            type="button"
            disabled={busy || !tagDraft.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await api.knowledgeCreateTag(tagDraft.trim());
                setTagDraft("");
                await load();
                onChanged();
              } catch (e) {
                fb.error("新建标签失败", e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            新增标签
          </button>
          <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
            标签是扁平的，一份文档可挂多个
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(tags ?? []).length === 0 ? (
            <span className="text-[12px]" style={{ color: "var(--color-text-3)" }}>
              还没有标签
            </span>
          ) : (
            (tags ?? []).map((t) => (
              <span
                key={t.id}
                className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px]"
                style={{ background: "var(--color-surface-2)" }}
              >
                {t.name}
                <button
                  type="button"
                  aria-label={`删除标签 ${t.name}`}
                  className="text-[11px]"
                  style={{ color: "var(--color-text-3)" }}
                  onClick={async () => {
                    try {
                      await api.knowledgeDeleteTag(t.id);
                      await load();
                      onChanged();
                    } catch (e) {
                      fb.error("删除失败", e instanceof Error ? e.message : String(e));
                    }
                  }}
                >
                  ×
                </button>
              </span>
            ))
          )}
        </div>
      </div>
    </div>
  );
}


function OrganizePanel({ docs, onApplied }: { docs: KnowledgeDoc[]; onApplied: () => void }) {
  const fb = useFeedback();
  const [agents, setAgents] = useState<{ id: string; name: string }[] | null>(null);
  const [agentId, setAgentId] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<OrganizeDraft[] | null>(null);
  const [jobs, setJobs] = useState<OrganizeJob[]>([]);
  const [busy, setBusy] = useState(false);

  const loadDrafts = useCallback(async () => {
    try {
      const [d, j] = await Promise.all([api.knowledgeDrafts({ status: "pending" }), api.knowledgeJobs()]);
      setDrafts(d.items);
      setJobs(j.items);
    } catch {
      setDrafts([]);
    }
  }, []);

  useEffect(() => {
    void loadDrafts();
    api
      .agents()
      .then((got) => {
        const raw = (Array.isArray(got) ? got : (got as { items?: unknown[] }).items) ?? [];
        const rows = (raw as {
          id: string;
          name: string;
          runtime?: string;
          definition?: { model?: { name?: string } };
        }[])
          // 影子助手（runtime=a2a）与没配模型的助手跑不了整理：它们没有自己的模型
          .filter((a) => a.runtime !== "a2a" && (a.definition?.model?.name ?? "").trim() !== "")
          .map((a) => ({ id: a.id, name: `${a.name} · ${a.definition?.model?.name ?? ""}` }));
        setAgents(rows);
        if (rows[0]) setAgentId(rows[0].id);
      })
      .catch(() => setAgents([]));
  }, [loadDrafts]);

  const readyDocs = docs.filter((d) => d.status === "ready");
  const chosen = Object.keys(picked).filter((k) => picked[k]);

  return (
    <div className="space-y-5">
      <div className="rounded-lg p-3" style={{ background: "var(--color-surface-2)" }}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px]" style={{ color: "var(--color-text-2)" }}>用</span>
          <select className="input h-8 w-52 text-[12px]" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {(agents ?? []).length === 0 && <option value="">（还没有助手）</option>}
            {(agents ?? []).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <span className="text-[12px]" style={{ color: "var(--color-text-2)" }}>读这些文档</span>
          <button
            className="btn btn-sm"
            type="button"
            onClick={() => {
              const all: Record<string, boolean> = {};
              for (const d of readyDocs) all[d.id] = true;
              setPicked(all);
            }}
          >
            全选（{readyDocs.length} 份已就绪）
          </button>
          <button className="btn btn-sm" type="button" onClick={() => setPicked({})}>清空</button>
          <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>已选 {chosen.length} 份</span>
          <button
            className="btn btn-primary btn-sm ml-auto"
            type="button"
            disabled={busy || !agentId || chosen.length === 0}
            onClick={async () => {
              setBusy(true);
              try {
                await api.knowledgeOrganize({ agent_id: agentId, doc_ids: chosen });
                fb.success("已开始整理，结果会以草稿形式出现在下面");
                setPicked({});
                // 整理是后台跑的：先等一会儿再拉草稿
                for (let i = 0; i < 20; i += 1) {
                  await new Promise((r) => setTimeout(r, 1500));
                  await loadDrafts();
                  break;
                }
              } catch (e) {
                fb.error("整理没能开始", e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            开始整理
          </button>
        </div>
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          {readyDocs.length === 0 ? (
            <span className="text-[12px]" style={{ color: "var(--color-text-3)" }}>还没有「已就绪」的文档可整理</span>
          ) : (
            readyDocs.slice(0, 30).map((d) => (
              <label key={d.id} className="flex items-center gap-2 text-[12px]" style={{ minHeight: 30 }}>
                <input
                  type="checkbox"
                  checked={!!picked[d.id]}
                  onChange={(e) => setPicked((p) => ({ ...p, [d.id]: e.target.checked }))}
                />
                <span className="truncate">{d.name}</span>
              </label>
            ))
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button className="btn btn-sm" type="button" onClick={() => void loadDrafts()}>刷新草稿</button>
          {jobs[0] && (
            <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
              最近一次：{jobs[0].status === "done" ? "完成" : jobs[0].status === "failed" ? "失败" : "进行中"} · 草稿 {jobs[0].made} 条
              {jobs[0].error?.message ? ` · ${jobs[0].error.message}` : ""}
            </span>
          )}
        </div>
      </div>

      <div>
        <div className="mb-2 text-[12px] font-medium">
          待确认的草稿 {drafts ? `(${drafts.length})` : ""}
          <span className="ml-2 font-normal text-[11px]" style={{ color: "var(--color-text-3)" }}>
            采纳才会写进文档；忽略就丢掉
          </span>
        </div>
        {drafts === null ? (
          <div className="h-16 animate-pulse rounded-md" style={{ background: "var(--color-surface-3)" }} />
        ) : drafts.length === 0 ? (
          <div className="rounded-lg px-3 py-6 text-center text-[12px]"
               style={{ background: "var(--color-surface-2)", color: "var(--color-text-3)" }}>
            没有待确认的草稿
          </div>
        ) : (
          <div className="space-y-1.5">
            {drafts.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-2 rounded-lg px-3 py-2"
                   style={{ background: "var(--color-surface-2)" }}>
                <span className="rounded-full px-2 py-0.5 text-[11px]" style={{ background: "var(--color-surface-3)" }}>
                  {d.kind === "category" ? "分类" : d.kind === "tags" ? "标签" : d.kind === "summary" ? "摘要" : d.kind}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px]">
                  <span style={{ color: "var(--color-text-3)" }}>{d.doc_name || d.doc_id} → </span>
                  {d.kind === "category" ? d.payload.name : d.kind === "tags" ? (d.payload.add ?? []).join("、") : d.payload.text}
                </span>
                {typeof d.payload.confidence === "number" && (
                  <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                    把握 {Math.round(d.payload.confidence * 100)}%
                  </span>
                )}
                <span className="flex gap-1.5">
                  <button
                    className="btn btn-sm"
                    type="button"
                    onClick={async () => {
                      try {
                        await api.knowledgeAcceptDraft(d.id);
                        await loadDrafts();
                        onApplied();
                      } catch (e) {
                        fb.error("采纳失败", e instanceof Error ? e.message : String(e));
                      }
                    }}
                  >
                    采纳
                  </button>
                  <button
                    className="btn btn-sm"
                    type="button"
                    style={{ color: "var(--color-text-3)" }}
                    onClick={async () => {
                      try {
                        await api.knowledgeRejectDraft(d.id);
                        await loadDrafts();
                      } catch (e) {
                        fb.error("忽略失败", e instanceof Error ? e.message : String(e));
                      }
                    }}
                  >
                    忽略
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
