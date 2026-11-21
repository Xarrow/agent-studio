"use client";

/**
 * 知识中心。
 *
 * 口径（2026-11-16 重构）：
 *   · 三段就够：文档 / 分类与标签 / 设置。原来五个页签（文档·分类·整理·图谱·存储）
 *     让同一件常识拆到四处：想给一份文档分类，得先去「整理」让助手出草稿，
 *     再回来「分类」看树；想改存储，得离开文档。现在都收回到对象自己身上。
 *   · 一行一份文档，点行**就地展开**（元数据 / 解析文本 / 改分类 / 换标签 / 下载 / 删除），
 *     不再从右侧推抽屉——抽屉遮住列表，改完还得关掉。
 *   · 整理不再是独立页签：在文档列表里勾选，批量条就在这批行上方出现（助手 + 整理 / 提炼 Skill）。
 *   · 样式统一走 kit：PageHead / Segmented / Toolbar / RowList / Row / RowDetail /
 *     Section / SelectionBar / SelectBox / Empty / KV / Chip。分层靠底色差，不用 1px 装饰线。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isImeEvent } from "@/lib/ime";

import { api } from "@/lib/api";
import { KnowledgeGraph } from "@/components/KnowledgeGraph";
import type {
  DocTagLink,
  DocVersion,
  KnowledgeCategory,
  KnowledgeDoc,
  PipelineDoc,
  RecallStats,
  SkillDraft,
  KnowledgeMigration,
  KnowledgeStorage,
  KnowledgeTag,
  OrganizeDraft,
  OrganizeJob,
} from "@/lib/types";
import {
  Chip,
  Empty,
  KV,
  PageHead,
  Row,
  RowDetail,
  RowList,
  Section,
  Segmented,
  SelectionBar,
  SelectBox,
  Toolbar,
} from "@/components/ui/kit";
import { useFeedback } from "@/components/ui/feedback";
import { useFirstLoad } from "@/lib/useFirstLoad";

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

const STATUS: Record<string, { label: string; color: string }> = {
  ready: { label: "已就绪", color: "var(--color-ok,#16a34a)" },
  parsing: { label: "解析中", color: "var(--color-warn,#d97706)" },
  uploading: { label: "上传中", color: "var(--color-warn,#d97706)" },
  failed: { label: "失败", color: "var(--color-err,#dc2626)" },
};

function StatusDot({ status }: { status: string }) {
  const st = STATUS[status] ?? STATUS.uploading;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: "var(--color-text-2)" }}>
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: st.color }} />
      {st.label}
    </span>
  );
}

const DRAFT_LABEL: Record<string, string> = {
  category: "分类",
  tags: "标签",
  summary: "摘要",
  skill: "Skill",
};

export default function KnowledgePage() {
  const fb = useFeedback();
  const { loaded, markLoaded } = useFirstLoad();
  const [tab, setTab] = useState<"docs" | "meta" | "settings">("docs");
  const [q, setQ] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [docs, setDocs] = useState<KnowledgeDoc[] | null>(null);
  const [cats, setCats] = useState<KnowledgeCategory[]>([]);
  const [tags, setTags] = useState<KnowledgeTag[]>([]);
  const [storages, setStorages] = useState<KnowledgeStorage[]>([]);
  const [drafts, setDrafts] = useState<OrganizeDraft[]>([]);
  const [jobs, setJobs] = useState<OrganizeJob[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [agentId, setAgentId] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [graphSel, setGraphSel] = useState<{ kind: string; label: string; docIds: string[] } | null>(null);
  const [pasteDraft, setPasteDraft] = useState({ title: "", text: "", tags: "" });
  const [urlDraft, setUrlDraft] = useState({ url: "", name: "" });
  const fileRef = useRef<HTMLInputElement>(null);

  const loadDocs = useCallback(async () => {
    try {
      const got = await api.knowledgeDocs();
      setDocs(got.items);
      markLoaded();
    } catch (e) {
      fb.error("读取文档失败", e instanceof Error ? e.message : String(e));
      setDocs([]);
      markLoaded();
    }
  }, [fb, markLoaded]);

  const loadMeta = useCallback(async () => {
    const [c, t, s, d, j] = await Promise.all([
      api.knowledgeCategories().catch(() => ({ items: [] })),
      api.knowledgeTags().catch(() => ({ items: [] })),
      api.knowledgeStorages().catch(() => ({ items: [] })),
      api.knowledgeDrafts({ status: "pending" }).catch(() => ({ items: [] })),
      api.knowledgeJobs().catch(() => ({ items: [] })),
    ]);
    setCats(c.items ?? []);
    setTags(t.items ?? []);
    setStorages(s.items ?? []);
    setDrafts(d.items ?? []);
    setJobs(j.items ?? []);
  }, []);

  useEffect(() => {
    void loadDocs();
    void loadMeta();
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
          .filter((a) => a.runtime !== "a2a" && (a.definition?.model?.name ?? "").trim() !== "")
          .map((a) => ({ id: a.id, name: `${a.name} · ${a.definition?.model?.name ?? ""}` }));
        setAgents(rows);
        setAgentId((v) => v || rows[0]?.id || "");
      })
      .catch(() => setAgents([]));
  }, [loadDocs, loadMeta]);

  // 解析与整理都是后台跑的：有「解析中」或有进行中的整理任务时自动刷新
  useEffect(() => {
    const t = window.setInterval(() => {
      const parsing = (docs ?? []).some((r) => r.status === "parsing" || r.status === "uploading");
      const organizing = jobs.some((j) => j.status === "running" || j.status === "queued");
      if (parsing) void loadDocs();
      if (organizing || parsing) void loadMeta();
    }, 3000);
    return () => window.clearInterval(t);
  }, [docs, jobs, loadDocs, loadMeta]);

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setBusy("upload");
    try {
      // 只用标签组织（不再写分类）
      const got = await api.knowledgeUpload(list, "未分类");
      if (got.duplicates?.length) {
        fb.warn(`已存在相同内容：${got.duplicates.map((d) => d.name).join("、")}（已跳过）`);
      }
      if (got.documents?.length) fb.success(`已加入 ${got.documents.length} 份文档，正在解析`);
      await loadDocs();
    } catch (e) {
      fb.error("上传失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const patchDoc = async (id: string, body: Record<string, unknown>) => {
    try {
      await api.knowledgePatchDoc(id, body);
      await loadDocs();
      await loadMeta();
    } catch (e) {
      fb.error("保存失败", e instanceof Error ? e.message : String(e));
    }
  };

  // 搜索：文件名在本地筛（立刻响应），正文命中交给服务端（debounce 300ms）
  const [bodyHits, setBodyHits] = useState<string[] | null>(null);
  useEffect(() => {
    const key = q.trim();
    if (!key) {
      setBodyHits(null);
      return;
    }
    const t = window.setTimeout(() => {
      api
        .knowledgeSearch(key)
        .then((got) => setBodyHits((got.items as { id: string }[]).map((x) => x.id)))
        .catch(() => setBodyHits([]));
    }, 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const shown = useMemo(() => {
    const list = docs ?? [];
    const key = q.trim().toLowerCase();
    return list.filter((d) => {
      if (tagFilter && !(d.tags ?? []).includes(tagFilter)) return false;
      if (!key) return true;
      if (d.name.toLowerCase().includes(key)) return true;
      return (bodyHits ?? []).includes(d.id);
    });
  }, [docs, q, tagFilter, bodyHits]);

  const readyDocs = shown.filter((d) => d.status === "ready");
  const chosen = Object.keys(picked).filter((k) => picked[k]);
  const catName = (id: string) => cats.find((c) => c.id === id)?.name ?? "未分类";
  const parsingCount = (docs ?? []).filter((d) => d.status === "parsing" || d.status === "uploading").length;

  return (
    <div className="max-w-6xl p-4 md:p-6 lg:p-7">
      <PageHead
        title="知识中心"
        desc={
          docs === null
            ? "原始文档与解析结果；沉淀出的 Skill 会记录来源文档"
            : `${docs.length} 份文档${parsingCount ? ` · ${parsingCount} 份解析中` : ""}${
                drafts.length ? ` · ${drafts.length} 条草稿待确认` : ""
              }`
        }
        actions={
          <>
            <button className="btn" onClick={() => setPasteOpen((v) => !v)} type="button">
              粘贴文本
            </button>
            <button className="btn" onClick={() => setUrlOpen((v) => !v)} type="button">
              加链接
            </button>
            <button
              className="btn btn-primary"
              onClick={() => fileRef.current?.click()}
              disabled={busy === "upload"}
              type="button"
            >
              {busy === "upload" ? "上传中…" : "＋ 上传文档"}
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

      <div className="mb-3">
      </div>

      {pasteOpen ? (
        <div className="mb-3 rounded-[12px] p-3" style={{ background: "var(--color-surface-2)" }}>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input h-9 w-48 text-[12px]"
              placeholder="标题（留空自动命名）"
              value={pasteDraft.title}
              onChange={(e) => setPasteDraft((d) => ({ ...d, title: e.target.value }))}
            />
            <input
              className="input h-9 min-w-0 flex-1 text-[12px]"
              placeholder="标签，逗号分隔（可留空，向量化后会自动提关键词）"
              value={pasteDraft.tags}
              onChange={(e) => setPasteDraft((d) => ({ ...d, tags: e.target.value }))}
            />
          </div>
          <textarea
            className="input mt-2 w-full text-[12.5px]"
            rows={6}
            placeholder="把正文贴进来（支持 Markdown：标题、列表、表格都保留）"
            value={pasteDraft.text}
            onChange={(e) => setPasteDraft((d) => ({ ...d, text: e.target.value }))}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy === "paste" || pasteDraft.text.trim().length < 20}
              onClick={async () => {
                setBusy("paste");
                try {
                  const got = await api.knowledgePaste({
                    title: pasteDraft.title.trim() || undefined,
                    text: pasteDraft.text,

                    tags: pasteDraft.tags
                      .split(/[,，、\s]+/)
                      .map((x) => x.trim())
                      .filter(Boolean),
                  });
                  fb.success(`已入库「${got.document.name}」，正在解析`);
                  setPasteDraft({ title: "", text: "", tags: "" });
                  setPasteOpen(false);
                  await loadDocs();
                } catch (e) {
                  fb.error("粘贴入库失败", e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(null);
                }
              }}
            >
              入库
            </button>
            <button className="btn" type="button" onClick={() => setPasteOpen(false)}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {urlOpen ? (
        <div className="mb-3 rounded-[12px] p-3" style={{ background: "var(--color-surface-2)" }}>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input h-9 min-w-0 flex-1 text-[12px]"
              placeholder="https://…（公网地址；内网与元数据地址会被拒绝）"
              value={urlDraft.url}
              onChange={(e) => setUrlDraft((d) => ({ ...d, url: e.target.value }))}
            />
            <input
              className="input h-9 w-36 text-[12px]"
              placeholder="标题（可留空）"
              value={urlDraft.name}
              onChange={(e) => setUrlDraft((d) => ({ ...d, name: e.target.value }))}
            />
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy === "url" || !urlDraft.url.trim()}
              onClick={async () => {
                setBusy("url");
                try {
                  const got = await api.knowledgeFromUrl({
                    url: urlDraft.url.trim(),
                    name: urlDraft.name.trim() || undefined,
                  });
                  fb.success(`已抓取 ${got.text_length} 字，正在解析`);
                  setUrlDraft({ url: "", name: "" });
                  setUrlOpen(false);
                  await loadDocs();
                } catch (e) {
                  fb.error("抓取失败", e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(null);
                }
              }}
            >
              抓取入库
            </button>
            <button className="btn" type="button" onClick={() => setUrlOpen(false)}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {/* 卡片流：一份文档一张卡，投放 / 标签 / 技能 / 试打 / 版本 / 原文全在卡内 */}
      <DocumentFlow
        docs={shown}
        cats={cats}
        agents={agents}
        agentId={agentId}
        onUpload={(files) => void upload(files)}
        graphFilter={graphSel}
        onClearGraphFilter={() => setGraphSel(null)}
        q={q}
        onQuery={setQ}
        tagFilter={tagFilter}
        onTagFilter={setTagFilter}
        tags={tags.map((t) => t.name)}
        onChanged={() => {
          void loadDocs();
          void loadMeta();
        }}
      />

      <div className="mt-4 space-y-3">
        <RecallSection />
        <Section
          title="知识关系"
          defaultOpen={false}
        >
          <KnowledgeGraph onSelect={setGraphSel} />
        </Section>
        <Section title="库设置" desc="标签、存储、迁移、回收站" defaultOpen={false}>
          <div className="space-y-3">
            <TagsSection
              tags={tags}
              firstLoad={!loaded}
              onChanged={async () => {
                await Promise.all([loadMeta(), loadDocs()]);
              }}
            />
            <StorageSection storages={storages} firstLoad={!loaded} onChanged={loadMeta} />
            <MigrateSection storages={storages} />
            <TrashSection onChanged={loadMeta} />
          </div>
        </Section>
      </div>
    </div>
  );
}

/* ────────────────────────── 文档详情（就地展开） ────────────────────────── */

function DocDetail({
  doc,
  cats,
  onPatch,
  onDeleted,
  onChanged,
}: {
  doc: KnowledgeDoc;
  cats: KnowledgeCategory[];
  onPatch: (id: string, body: Record<string, unknown>) => Promise<void>;
  onDeleted: () => void;
  onChanged: () => void;
}) {
  const fb = useFeedback();
  const [text, setText] = useState<{ ord: number; text: string; page?: number | null; sheet?: string }[] | null>(null);
  const [allText, setAllText] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [tagLinks, setTagLinks] = useState<DocTagLink[] | null>(null);
  const [versions, setVersions] = useState<DocVersion[]>([]);
  const [samples, setSamples] = useState<string[]>([]);
  const [probeQ, setProbeQ] = useState("");
  const [probing, setProbing] = useState(false);
  const [probeRes, setProbeRes] = useState<
    { items: { id: string; name: string; snippet: string; matched_path: string }[]; latency_ms: number } | null
  >(null);

  const runProbe = async (query: string) => {
    setProbing(true);
    try {
      const got = await api.knowledgeRecallProbe(query, 3);
      setProbeRes({ items: got.items, latency_ms: got.latency_ms });
    } catch {
      setProbeRes({ items: [], latency_ms: 0 });
    } finally {
      setProbing(false);
    }
  };

  const loadTags = useCallback(async () => {
    try {
      const got = await api.knowledgeDocTags(doc.id);
      setTagLinks(got.items ?? []);
    } catch {
      setTagLinks([]);
    }
  }, [doc.id]);

  useEffect(() => {
    void loadTags();
    api
      .knowledgeSampleQueries(doc.id)
      .then((got) => setSamples(got.items ?? []))
      .catch(() => setSamples([]));
    api
      .knowledgeVersions(doc.id)
      .then((got) => setVersions(got.items ?? []))
      .catch(() => setVersions([]));
  }, [doc.id, loadTags, doc.version]);

  useEffect(() => {
    let alive = true;
    api
      .knowledgeText(doc.id)
      .then((got) => {
        if (alive) setText(got.chunks);
      })
      .catch(() => {
        if (alive) setText([]);
      });
    return () => {
      alive = false;
    };
  }, [doc.id]);

  const chunks = text ?? [];
  const shown = allText ? chunks : chunks.slice(0, 2);

  return (
    <RowDetail>
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
          <KV k="标签">
            <span className="flex flex-wrap items-center gap-1">
              {tagLinks === null ? (
                <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                  读取中…
                </span>
              ) : (
                <>
                  {tagLinks.filter((t) => t.status === "accepted").map((t) => (
                    <span
                      key={t.tag_id}
                      className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                      style={{ background: "var(--color-surface-3)" }}
                      title={t.source === "model" ? "模型提炼" : "自己加的"}
                    >
                      {t.name}
                      <button
                        type="button"
                        aria-label={`去掉标签 ${t.name}`}
                        style={{ color: "var(--color-muted)" }}
                        onClick={async () => {
                          await api.knowledgeRemoveDocTag(doc.id, t.tag_id);
                          await loadTags();
                          onChanged();
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {tagLinks.filter((t) => t.status === "candidate").length > 0 ? (
                    <span className="flex flex-wrap items-center gap-1">
                      <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                        模型建议：
                      </span>
                      {tagLinks
                        .filter((t) => t.status === "candidate")
                        .map((t) => (
                          <span
                            key={t.tag_id}
                            className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                            style={{ background: "color-mix(in srgb, var(--color-accent) 10%, transparent)" }}
                          >
                            {t.name}
                            <span style={{ color: "var(--color-text-3)" }}>
                              {Math.round((t.confidence ?? 0) * 100)}%
                            </span>
                            <button
                              type="button"
                              className="underline"
                              onClick={async () => {
                                await api.knowledgeAcceptDocTag(doc.id, t.tag_id);
                                await loadTags();
                                onChanged();
                              }}
                            >
                              采纳
                            </button>
                            <button
                              type="button"
                              aria-label={`忽略 ${t.name}`}
                              style={{ color: "var(--color-muted)" }}
                              onClick={async () => {
                                await api.knowledgeRemoveDocTag(doc.id, t.tag_id);
                                await loadTags();
                              }}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                    </span>
                  ) : null}
                </>
              )}
              <input
                className="input h-7 w-24 text-[11px]"
                placeholder="加标签"
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={async (e) => {
                  if (isImeEvent(e)) return;
                  if (e.key === "Enter" && tagDraft.trim()) {
                    await api.knowledgeAddDocTag(doc.id, { name: tagDraft.trim(), source: "user" });
                    setTagDraft("");
                    await loadTags();
                    onChanged();
                  }
                }}
              />
            </span>
          </KV>
          <KV k="版本">
            <span className="flex flex-wrap items-center gap-1">
              <span className="text-[12px]">v{doc.version}</span>
              {versions.slice(0, 4).map((v) => (
                <button
                  key={`${v.version}-${v.id}`}
                  type="button"
                  className="text-[11px] underline"
                  style={{ color: v.current ? "var(--color-text-3)" : "var(--color-accent)" }}
                  disabled={v.current}
                  onClick={async () => {
                    if (!window.confirm(`回滚到 v${v.version}？当前内容会被替换（旧版本仍可再回滚回来）。`)) return;
                    await api.knowledgeRollback(doc.id, v.version);
                    fb.success(`已回滚到 v${v.version}`);
                    onChanged();
                  }}
                  title={v.note || ""}
                >
                  v{v.version}
                </button>
              ))}
              <label className="btn btn-sm cursor-pointer">
                上传新版本
                <input
                  type="file"
                  hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (!f) return;
                    try {
                      const got = await api.knowledgeAddVersion(doc.id, f);
                      fb.success(`已提交 v${got.version}，正在解析`);
                      onChanged();
                    } catch (err) {
                      fb.error("上传新版本失败", err instanceof Error ? err.message : String(err));
                    }
                  }}
                />
              </label>
            </span>
          </KV>
          <KV k="存储路径">
            <code className="mono break-all text-[11px]">{doc.storage_path || "—"}</code>
          </KV>
          <KV k="sha256">
            <code className="mono break-all text-[11px]">{doc.sha256.slice(0, 16)}…</code>
          </KV>
          <KV k="解析">
            {doc.parsed?.parserVersion ? `v${doc.parsed.parserVersion}` : "—"}
            {doc.parsed?.ms != null ? ` · ${doc.parsed.ms} ms` : ""}
            {doc.parsed?.pages ? ` · ${doc.parsed.pages} 页` : ""}
            {doc.parsed?.sheets?.length ? ` · ${doc.parsed.sheets.join("、")}` : ""}
          </KV>
          <KV k="来源">{doc.source === "url" ? doc.source_url || "链接" : "本地上传"}</KV>
        </div>

        {/* 试打：用文档自己的话试，不让用户造词 */}
        <div className="rounded-[10px] px-2.5 py-2" style={{ background: "var(--color-surface-2)" }}>
          <div className="mb-1 text-[11px]" style={{ color: "var(--color-text-3)" }}>
            试打检索 · 用文档里的原话（点一条即查）
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {(samples ?? []).map((q) => (
              <button
                key={q}
                type="button"
                className="rounded-full px-2 py-0.5 text-[11px]"
                style={{ background: "var(--color-surface-3)", color: "var(--color-text-2)" }}
                onClick={() => {
                  setProbeQ(q);
                  void runProbe(q);
                }}
              >
                {q}
              </button>
            ))}
            <input
              className="input h-7 w-40 text-[11px]"
              placeholder="或输入文档里出现过的词…"
              value={probeQ}
              onChange={(e) => setProbeQ(e.target.value)}
              onKeyDown={(e) => {
                if (isImeEvent(e)) return;
                if (e.key === "Enter" && probeQ.trim()) void runProbe(probeQ.trim());
              }}
              aria-label="试打查询"
            />
            <button
              className="btn btn-sm"
              type="button"
              disabled={probing || !probeQ.trim()}
              onClick={() => void runProbe(probeQ.trim())}
            >
              {probing ? "查…" : "查"}
            </button>
            {probeRes ? (
              <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                {probeRes.items.length} 条 · {probeRes.latency_ms}ms
              </span>
            ) : null}
          </div>
          {probeRes ? (
            <div className="mt-1 space-y-1">
              {probeRes.items.length === 0 ? (
                <div className="text-[11.5px]" style={{ color: "var(--color-err,#dc2626)" }}>
                  没查到：这段文字可能还没进索引，或换文档里出现过的词再试
                </div>
              ) : (
                probeRes.items.slice(0, 3).map((h) => (
                  <div key={h.id} className="rounded-[8px] px-2 py-1 text-[11.5px]" style={{ background: "var(--color-surface-3)" }}>
                    <span className="mr-1">{h.name}</span>
                    <span style={{ color: "var(--color-text-3)" }}>
                      {h.matched_path === "both" ? "词+义" : h.matched_path === "vector" ? "语义" : "关键词"}
                    </span>
                    <div className="truncate" style={{ color: "var(--color-text-2)" }}>
                      {h.snippet}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>

        {doc.error?.message ? (
          <div
            className="rounded-md px-2.5 py-2 text-[12px]"
            style={{ background: "color-mix(in srgb, var(--color-err,#dc2626) 8%, transparent)", color: "var(--color-err,#dc2626)" }}
          >
            {doc.error.message}
          </div>
        ) : null}

        <div id={`raw-${doc.id}`}>
          <div className="mb-1.5 flex items-center gap-2 text-[12px]">
            <span style={{ color: "var(--color-text-2)" }}>解析文本</span>
            {chunks.length > 2 ? (
              <button
                className="btn btn-sm"
                type="button"
                style={{ color: "var(--color-muted)" }}
                onClick={() => setAllText((v) => !v)}
              >
                {allText ? "收起" : `看全部 ${chunks.length} 段`}
              </button>
            ) : null}
          </div>
          {text === null ? (
            <div className="h-16 animate-pulse rounded-md" style={{ background: "var(--color-surface-3)" }} />
          ) : chunks.length === 0 ? (
            <div className="text-[12px]" style={{ color: "var(--color-text-3)" }}>
              {doc.status === "failed" ? "解析失败，没有文本" : "还没有解析文本（扫描件需要 OCR）"}
            </div>
          ) : (
            <div className="space-y-2">
              {shown.map((c) => (
                <div
                  key={c.ord}
                  className="rounded-md p-2.5 text-[12.5px] leading-relaxed"
                  style={{ background: "var(--color-surface-3)", color: "var(--color-text-2)", whiteSpace: "pre-wrap" }}
                >
                  {c.page != null ? (
                    <span className="mr-1 text-[11px]" style={{ color: "var(--color-text-3)" }}>
                      第 {c.page} 页
                    </span>
                  ) : null}
                  {c.sheet ? (
                    <span className="mr-1 text-[11px]" style={{ color: "var(--color-text-3)" }}>
                      {c.sheet}
                    </span>
                  ) : null}
                  {c.text.slice(0, 900)}
                  {c.text.length > 900 ? "…" : ""}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <a
            className="btn btn-sm"
            href={`/api/knowledge/documents/${doc.id}/original`}
            target="_blank"
            rel="noreferrer"
          >
            下载原件
          </a>
          <button
            className="btn btn-sm"
            type="button"
            disabled={doc.status !== "ready"}
            title={doc.status === "ready" ? "用这份文档和它的标签生成一条检索型技能草稿" : "等解析完成"}
            onClick={async () => {
              try {
                const got = await api.knowledgeSkillFromDoc(doc.id);
                fb.success(`已生成技能草稿「${got.draft.name || "生成中"}」`);
                onChanged();
              } catch (e) {
                fb.error("生成技能失败", e instanceof Error ? e.message : String(e));
              }
            }}
          >
            生成技能
          </button>
          <button
            className="btn btn-sm"
            type="button"
            onClick={async () => {
              try {
                await api.knowledgeReparse(doc.id);
                fb.success("已重新排队解析");
                onDeleted();
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
            style={{ color: "var(--color-err,#dc2626)" }}
            onClick={async () => {
              if (!window.confirm(`把「${doc.name}」移到回收站？30 天内可以恢复。`)) return;
              try {
                await api.knowledgeDelete(doc.id);
                fb.success("已移到回收站");
                onDeleted();
              } catch (e) {
                fb.error("删除失败", e instanceof Error ? e.message : String(e));
              }
            }}
          >
            移到回收站
          </button>
        </div>
      </div>
    </RowDetail>
  );
}

/* ────────────────────────── 分类 ────────────────────────── */

function CategoriesSection({
  cats,
  firstLoad,
  onChanged,
}: {
  cats: KnowledgeCategory[];
  firstLoad: boolean;
  onChanged: () => Promise<void>;
}) {
  const fb = useFeedback();
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const tops = cats.filter((c) => !c.parent_id);
  const ordered: KnowledgeCategory[] = [];
  const walk = (pid: string) => {
    for (const c of cats.filter((x) => x.parent_id === pid)) {
      ordered.push(c);
      walk(c.id);
    }
  };
  walk("");

  return (
    <Section title="分类" count={cats.length} desc="最多 3 层；删分类不删文档，文档回到未分类">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input h-8 w-44 text-[12px]"
            placeholder="新建分类名"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="新建分类名"
          />
          <select
            className="input h-8 w-40 text-[12px]"
            value={parent}
            onChange={(e) => setParent(e.target.value)}
            aria-label="放到哪个分类下"
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
            disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await api.knowledgeCreateCategory({ name: name.trim(), parent_id: parent || undefined });
                setName("");
                setParent("");
                fb.success("已新建分类");
                await onChanged();
              } catch (e) {
                fb.error("新建失败", e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            新建
          </button>
        </div>

        {firstLoad && ordered.length === 0 ? (
          <div className="h-14 animate-pulse rounded-[10px]" style={{ background: "var(--color-surface-2)" }} />
        ) : ordered.length === 0 ? (
          <Empty title="还没有分类" hint="先建一个「合同」「技术文档」这样的顶级分类，上传时就能直接归进去" />
        ) : (
          <div className="-mx-3 -mb-3">
            <RowList>
              {ordered.map((c) => (
                <Row
                  key={c.id}
                  actions={
                    editing?.id === c.id ? (
                      <>
                        <button
                          className="btn btn-sm"
                          type="button"
                          onClick={async () => {
                            try {
                              await api.knowledgeRenameCategory(c.id, editing.name.trim());
                              setEditing(null);
                              await onChanged();
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
                          style={{ color: "var(--color-err,#dc2626)" }}
                          onClick={async () => {
                            if (!window.confirm(`删除分类「${c.name}」？文档不会被删，会回到未分类。`)) return;
                            try {
                              await api.knowledgeDeleteCategory(c.id);
                              fb.success("已删除分类");
                              await onChanged();
                            } catch (e) {
                              fb.error("删除失败", e instanceof Error ? e.message : String(e));
                            }
                          }}
                        >
                          删除
                        </button>
                      </>
                    )
                  }
                >
                  <span style={{ paddingLeft: Math.max(0, (c.depth - 1) * 18) }} className="min-w-0 flex-1 truncate text-[13px]">
                    {c.name}
                  </span>
                  {editing?.id === c.id ? (
                    <input
                      className="input h-7 w-36 text-[12px]"
                      value={editing.name}
                      onChange={(e) => setEditing({ id: c.id, name: e.target.value })}
                      aria-label="分类新名字"
                    />
                  ) : null}
                  <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                    {c.doc_count} 份
                  </span>
                </Row>
              ))}
            </RowList>
          </div>
        )}
      </div>
    </Section>
  );
}

/* ────────────────────────── 标签 ────────────────────────── */

function TagsSection({
  tags,
  firstLoad,
  onChanged,
}: {
  tags: KnowledgeTag[];
  firstLoad: boolean;
  onChanged: () => Promise<void>;
}) {
  const fb = useFeedback();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ id: string; name: string; origin: string; doc_count: number }[]>([]);
  const [merging, setMerging] = useState<{ id: string; into: string } | null>(null);

  const loadUsage = useCallback(async () => {
    try {
      const got = await api.knowledgeTagUsage();
      setUsage(got.items ?? []);
    } catch {
      setUsage([]);
    }
  }, []);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage, tags.length]);

  return (
    <Section
      title="标签"
      count={usage.length || tags.length}
      desc="模型从文档里提炼、或你自己加；一个标签下可以有多个文档，能直接生成 Skill"
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input h-8 w-44 text-[12px]"
            placeholder="新建标签"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="新建标签"
          />
          <button
            className="btn btn-sm"
            type="button"
            disabled={!!busy || !draft.trim()}
            onClick={async () => {
              setBusy("new");
              try {
                await api.knowledgeCreateTag(draft.trim());
                setDraft("");
                await onChanged();
                await loadUsage();
              } catch (e) {
                fb.error("新建标签失败", e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(null);
              }
            }}
          >
            新增标签
          </button>
        </div>

        {firstLoad && usage.length === 0 ? (
          <div className="h-14 animate-pulse rounded-[10px]" style={{ background: "var(--color-surface-2)" }} />
        ) : usage.length === 0 ? (
          <Empty
            title="还没有标签"
            hint="打开一份文档，在详情里给它打标签；也可以让助手整理时自动提出候选标签"
          />
        ) : (
          <div className="-mx-3">
            <RowList>
              {usage.map((t) => (
                <Row
                  key={t.id}
                  actions={
                    <>
                      <button
                        className="btn btn-sm"
                        type="button"
                        disabled={!!busy || t.doc_count === 0}
                        title={
                          t.doc_count === 0
                            ? "这个标签下还没有文档"
                            : "把该标签下全部文档提炼成一份 SKILL.md 草稿"
                        }
                        onClick={async () => {
                          setBusy(t.id);
                          try {
                            await api.knowledgeCreateSkillDraft({ tag_id: t.id });
                            fb.success(`已开始为「${t.name}」生成 Skill 草稿`);
                          } catch (e) {
                            fb.error("生成失败", e instanceof Error ? e.message : String(e));
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        生成 Skill
                      </button>
                      {merging?.id === t.id ? (
                        <>
                          <select
                            className="input h-7 w-32 text-[11px]"
                            value={merging.into}
                            onChange={(e) => setMerging({ id: t.id, into: e.target.value })}
                            aria-label="合并到哪个标签"
                          >
                            <option value="">合并到…</option>
                            {usage
                              .filter((x) => x.id !== t.id)
                              .map((x) => (
                                <option key={x.id} value={x.id}>
                                  {x.name}
                                </option>
                              ))}
                          </select>
                          <button
                            className="btn btn-sm"
                            type="button"
                            disabled={!merging.into}
                            onClick={async () => {
                              try {
                                const got = await api.knowledgeMergeTag(t.id, merging.into);
                                fb.success(`已合并到「${got.into}」（移动 ${got.moved} 份文档）`);
                                setMerging(null);
                                await onChanged();
                                await loadUsage();
                              } catch (e) {
                                fb.error("合并失败", e instanceof Error ? e.message : String(e));
                              }
                            }}
                          >
                            确认
                          </button>
                          <button className="btn btn-sm" type="button" onClick={() => setMerging(null)}>
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          className="btn btn-sm"
                          type="button"
                          title="把同义标签并成一个（文档关系会一起搬过去）"
                          onClick={() => setMerging({ id: t.id, into: "" })}
                        >
                          合并
                        </button>
                      )}
                      <button
                        className="btn btn-sm"
                        type="button"
                        style={{ color: "var(--color-err,#dc2626)" }}
                        onClick={async () => {
                          if (!window.confirm(`删除标签「${t.name}」？文档不会被删。`)) return;
                          try {
                            await api.knowledgeDeleteTag(t.id);
                            await onChanged();
                            await loadUsage();
                          } catch (e) {
                            fb.error("删除失败", e instanceof Error ? e.message : String(e));
                          }
                        }}
                      >
                        删除
                      </button>
                    </>
                  }
                >
                  <span className="min-w-0 flex-1 truncate text-[13px]">{t.name}</span>
                  <Chip tone="muted">{t.origin === "agent" ? "模型提炼" : "自己加的"}</Chip>
                  <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                    {t.doc_count} 份
                  </span>
                </Row>
              ))}
            </RowList>
          </div>
        )}
      </div>
    </Section>
  );
}


/* ────────────────────────── 存储 ────────────────────────── */

function StorageSection({
  storages,
  firstLoad,
  onChanged,
}: {
  storages: KnowledgeStorage[];
  firstLoad: boolean;
  onChanged: () => Promise<void>;
}) {
  const fb = useFeedback();
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    name: "",
    type: "s3" as "local" | "s3",
    endpoint: "",
    bucket: "",
    region: "",
    access_key_id: "",
    secret_access_key: "",
    prefix: "",
    root: "",
    path_template: "{category}/{year}/{name}",
    is_default: false,
  });

  return (
    <Section
      title="存储"
      count={storages.length}
      desc="原件放在哪、能不能连上；新文档写到默认存储"
      right={
        !adding ? (
          <button className="btn btn-sm" type="button" onClick={() => setAdding(true)}>
            ＋ 新增存储
          </button>
        ) : null
      }
    >
      <div className="space-y-2">
        {firstLoad && storages.length === 0 ? (
          <div className="h-14 animate-pulse rounded-[10px]" style={{ background: "var(--color-surface-2)" }} />
        ) : (
          <div className="-mx-3">
            <RowList>
              {storages.map((s) => (
                <Row
                  key={s.id}
                  actions={
                    <>
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
                            await onChanged();
                          } catch (e) {
                            fb.error("测试失败", e instanceof Error ? e.message : String(e));
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        测试连接
                      </button>
                      {!s.is_default ? (
                        <button
                          className="btn btn-sm"
                          type="button"
                          disabled={busy === s.id}
                          onClick={async () => {
                            setBusy(s.id);
                            try {
                              await api.knowledgeSetDefaultStorage(s.id);
                              fb.success("已设为默认（新文档写到这里）");
                              await onChanged();
                            } catch (e) {
                              fb.error("设置失败", e instanceof Error ? e.message : String(e));
                            } finally {
                              setBusy(null);
                            }
                          }}
                        >
                          设为默认
                        </button>
                      ) : null}
                    </>
                  }
                >
                  <span className="min-w-0 flex-1 truncate text-[13px]">{s.name}</span>
                  <Chip tone="muted">{s.type === "local" ? "本地磁盘" : "S3 兼容"}</Chip>
                  {s.is_default ? <Chip tone="accent">默认</Chip> : null}
                  {s.last_test_ok === true ? <Chip tone="ok">连接正常</Chip> : null}
                  {s.last_test_ok === false ? <Chip tone="err">连接失败</Chip> : null}
                  <span className="min-w-0 truncate text-[11px]" style={{ color: "var(--color-text-3)", maxWidth: 260 }}>
                    {s.type === "local"
                      ? String(s.params?.root ?? "")
                      : `${s.params?.endpoint ?? ""}/${s.params?.bucket ?? ""}`}
                  </span>
                  {s.last_test_error ? (
                    <span className="w-full truncate text-[11px]" style={{ color: "var(--color-err,#dc2626)" }}>
                      {s.last_test_error}
                    </span>
                  ) : null}
                </Row>
              ))}
            </RowList>
          </div>
        )}

        {adding ? (
          <div className="rounded-[10px] p-3" style={{ background: "var(--color-surface-2)" }}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <select
                className="input h-8 w-32 text-[12px]"
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as "local" | "s3" }))}
                aria-label="存储类型"
              >
                <option value="s3">S3 兼容</option>
                <option value="local">本地磁盘</option>
              </select>
              <input
                className="input h-8 w-40 text-[12px]"
                placeholder="名字（如 公司 OSS）"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                aria-label="存储名字"
              />
              <label className="flex items-center gap-1.5 text-[12px]">
                <input
                  type="checkbox"
                  checked={form.is_default}
                  onChange={(e) => setForm((f) => ({ ...f, is_default: e.target.checked }))}
                />
                设为默认
              </label>
            </div>

            {form.type === "s3" ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {([
                  ["endpoint", "Endpoint（如 https://oss-cn-hangzhou.aliyuncs.com）"],
                  ["bucket", "Bucket"],
                  ["region", "Region（可留空）"],
                  ["prefix", "对象前缀（如 docs/）"],
                  ["access_key_id", "Access Key ID"],
                  ["secret_access_key", "Secret Access Key"],
                ] as const).map(([key, label]) => (
                  <input
                    key={key}
                    className="input h-8 text-[12px]"
                    placeholder={label}
                    type={key === "secret_access_key" ? "password" : "text"}
                    value={form[key]}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  />
                ))}
              </div>
            ) : (
              <input
                className="input h-8 w-full text-[12px]"
                placeholder="本地根目录（如 /data/knowledge）"
                value={form.root}
                onChange={(e) => setForm((f) => ({ ...f, root: e.target.value }))}
              />
            )}

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                className="input h-8 w-56 text-[12px]"
                placeholder="路径模板"
                value={form.path_template}
                onChange={(e) => setForm((f) => ({ ...f, path_template: e.target.value }))}
                aria-label="路径模板"
              />
              <button
                className="btn btn-primary btn-sm"
                type="button"
                disabled={busy === "new" || !form.name.trim()}
                onClick={async () => {
                  setBusy("new");
                  try {
                    const params: Record<string, string> =
                      form.type === "s3"
                        ? {
                            endpoint: form.endpoint.trim(),
                            bucket: form.bucket.trim(),
                            region: form.region.trim(),
                            prefix: form.prefix.trim(),
                          }
                        : { root: form.root.trim() };
                    const secrets: Record<string, string> =
                      form.type === "s3"
                        ? { access_key_id: form.access_key_id.trim(), secret_access_key: form.secret_access_key }
                        : {};
                    await api.knowledgeCreateStorage({
                      name: form.name.trim(),
                      type: form.type,
                      params,
                      secrets,
                      path_template: form.path_template.trim() || "{category}/{year}/{name}",
                      is_default: form.is_default,
                    });
                    fb.success("已新增存储，建议先点「测试连接」");
                    setAdding(false);
                    setForm((f) => ({
                      ...f,
                      name: "",
                      endpoint: "",
                      bucket: "",
                      access_key_id: "",
                      secret_access_key: "",
                    }));
                    await onChanged();
                  } catch (e) {
                    fb.error("新增失败", e instanceof Error ? e.message : String(e));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                保存
              </button>
              <button className="btn btn-sm" type="button" onClick={() => setAdding(false)}>
                取消
              </button>
              <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                密钥加密入库，页面上不再回显
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/* ────────────────────────── 迁移 ────────────────────────── */

function MigrateSection({ storages }: { storages: KnowledgeStorage[] }) {
  const fb = useFeedback();
  const [migs, setMigs] = useState<KnowledgeMigration[]>([]);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const got = await api.knowledgeMigrations();
      setMigs(got.items ?? []);
    } catch {
      /* 历史读不到不影响主功能 */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(t);
  }, [load]);

  const running = migs.find((m) => m.status === "running" || m.status === "queued");
  const last = migs.find((m) => m.status !== "running" && m.status !== "queued");

  return (
    <Section
      title="迁移文档"
      desc="把一个存储里的原件搬到另一个；只搬原件、不动解析结果，源文件默认保留"
      defaultOpen={false}
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input h-8 w-40 text-[12px]"
            value={fromId}
            onChange={(e) => setFromId(e.target.value)}
            aria-label="从哪个存储搬"
          >
            <option value="">全部已入库文档</option>
            {storages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <span className="text-[12px]" style={{ color: "var(--color-text-3)" }}>
            →
          </span>
          <select
            className="input h-8 w-40 text-[12px]"
            value={toId}
            onChange={(e) => setToId(e.target.value)}
            aria-label="搬到哪个存储"
          >
            <option value="">选目标存储</option>
            {storages
              .filter((s) => s.id !== fromId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
          <button
            className="btn btn-sm"
            type="button"
            disabled={!toId || !!running || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.knowledgeMigrate({ from_id: fromId || undefined, to_id: toId, keep_source: true });
                fb.success("迁移已开始，进度在下面");
                setToId("");
                await load();
              } catch (e) {
                fb.error("没能开始迁移", e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            开始迁移
          </button>
        </div>

        {running ? (
          <div>
            <div className="mb-1 flex items-center justify-between text-[11px]" style={{ color: "var(--color-text-2)" }}>
              <span>
                正在搬到「{running.to_name}」：{running.moved}/{running.total}
                {running.failed > 0 ? ` · 失败 ${running.failed}` : ""}
              </span>
              <span>{running.total > 0 ? Math.round((running.moved / running.total) * 100) : 0}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--color-surface-3)" }}>
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${running.total > 0 ? Math.min(100, (running.moved / running.total) * 100) : 0}%`,
                  background: "var(--color-accent, #2563eb)",
                }}
              />
            </div>
          </div>
        ) : null}

        {last ? (
          <div
            className="text-[11px]"
            style={{ color: last.status === "failed" ? "var(--color-err,#dc2626)" : "var(--color-text-3)" }}
          >
            上次：{last.status === "done" ? "已完成" : "有失败"} · {last.from_name} → {last.to_name} · 搬了 {last.moved}/
            {last.total}
            {last.failed > 0 ? ` · 失败 ${last.failed}` : ""}
            {last.error ? ` · ${last.error.message.slice(0, 80)}` : ""}
          </div>
        ) : null}
      </div>
    </Section>
  );
}


/* ────────────────────────── 召回率面板 ────────────────────────── */

function RecallSection() {
  const { loaded, markLoaded } = useFirstLoad();
  const [stats, setStats] = useState<RecallStats | null>(null);
  const [open, setOpen] = useState<"" | "docs" | "tags">("");
  const [probe, setProbe] = useState("");
  const [probing, setProbing] = useState(false);
  const [cov, setCov] = useState<{ id: string; name: string; has_search: boolean; skills: string[] }[] | null>(null);
  const [idx, setIdx] = useState<{ ready: boolean; docs: number; chunks: number; available: boolean; reason?: string } | null>(null);
  const [probeResult, setProbeResult] = useState<
    { items: { id: string; name: string; snippet: string; matched_path: string }[]; latency_ms: number } | null
  >(null);

  useEffect(() => {
    api
      .knowledgeAgentsCoverage()
      .then((got) => setCov(got.items ?? []))
      .catch(() => setCov([]));
    api
      .knowledgeIndexStatus()
      .then((got) => setIdx(got))
      .catch(() => setIdx(null));
  }, []);

  const runProbe = async () => {
    setProbing(true);
    try {
      const got = await api.knowledgeRecallProbe(probe.trim());
      setProbeResult({ items: got.items, latency_ms: got.latency_ms });
    } catch {
      setProbeResult({ items: [], latency_ms: 0 });
    } finally {
      setProbing(false);
    }
  };

  useEffect(() => {
    api
      .knowledgeRecall()
      .then((got) => setStats(got))
      .catch(() => setStats(null))
      .finally(markLoaded);
  }, [markLoaded]);

  const card = (label: string, rate: number, detail: string, onClick?: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 rounded-[10px] px-3 py-2 text-left"
      style={{ background: "var(--color-surface-2)", minWidth: 132 }}
    >
      <div className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
        {label}
      </div>
      <div className="text-[18px] font-medium">{Math.round(rate * 100)}%</div>
      <div className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
        {detail}
      </div>
    </button>
  );

  return (
    <Section
      title="召回情况"
    >
      {!loaded && !stats ? (
        <div className="h-16 animate-pulse rounded-[10px]" style={{ background: "var(--color-surface-2)" }} />
      ) : !stats ? (
        <div className="text-[12px]" style={{ color: "var(--color-text-3)" }}>
          暂时读不到统计数据
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input h-9 min-w-0 flex-1 text-[12px] sm:max-w-md"
              placeholder="输入文档里出现过的词或句子…"
              value={probe}
              onChange={(e) => setProbe(e.target.value)}
              onKeyDown={(e) => {
                if (isImeEvent(e)) return;
                if (e.key === "Enter" && probe.trim()) void runProbe();
              }}
              aria-label="试打检索"
            />
            <button className="btn btn-sm" type="button" disabled={probing || !probe.trim()} onClick={() => void runProbe()}>
              {probing ? "查…" : "试一下"}
            </button>
            {idx ? (
              <span className="text-[11px]" style={{ color: idx.available ? "var(--color-text-3)" : "var(--color-warn, #d97706)" }}>
                {idx.available ? `BM25 索引：${idx.chunks} 块 / ${idx.docs} 份` : "索引不可用（关键词走 SQL LIKE）"}
              </span>
            ) : null}
            {probeResult ? (
              <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                {probeResult.items.length} 条 · {probeResult.latency_ms}ms
              </span>
            ) : null}
          </div>
          {probeResult ? (
            <div className="space-y-1">
              {probeResult.items.length === 0 ? (
                <div className="text-[12px]" style={{ color: "var(--color-err,#dc2626)" }}>
                  没查到——试试换个说法，或给文档补标签/补关键词
                </div>
              ) : (
                probeResult.items.map((h) => (
                  <div key={h.id} className="rounded-[8px] px-2 py-1.5" style={{ background: "var(--color-surface-2)" }}>
                    <div className="flex items-center gap-1.5 text-[12px]">
                      <span className="truncate">{h.name}</span>
                      <span
                        className="shrink-0 rounded px-1 text-[10px]"
                        style={{ background: "var(--color-surface-3)", color: "var(--color-text-3)" }}
                      >
                        {h.matched_path === "both" ? "词+义" : h.matched_path === "vector" ? "语义" : "关键词"}
                      </span>
                    </div>
                    <div className="truncate text-[11px]" style={{ color: "var(--color-text-3)" }}>
                      {h.snippet}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {card(
              "文档自召回",
              stats.docs.rate,
              `${stats.docs.hit}/${stats.docs.total} 份查得到自己`,
              stats.docs.misses.length ? () => setOpen(open === "docs" ? "" : "docs") : undefined,
            )}
            {card(
              "标签召回",
              stats.tags.rate,
              `${stats.tags.hit}/${stats.tags.total} 个标签查得全`,
              stats.tags.misses.length ? () => setOpen(open === "tags" ? "" : "tags") : undefined,
            )}
            {card(
              "助手检索命中",
              stats.agent.rate,
              stats.agent.queries ? `${stats.agent.hit}/${stats.agent.queries} 次 · 均值 ${stats.agent.avg_latency_ms}ms` : "还没被助手查过",
            )}
            {card("页面搜索命中", stats.search.rate, stats.search.queries ? `${stats.search.hit}/${stats.search.queries} 次` : "还没有搜索记录")}
          </div>

          {cov && cov.length > 0 ? (
            <div className="rounded-[10px] px-2.5 py-2" style={{ background: "var(--color-surface-2)" }}>
              <div className="mb-1 text-[11px]" style={{ color: "var(--color-text-3)" }}>
                哪些助手能查到知识库
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {cov.slice(0, 8).map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="rounded-full px-2 py-0.5 text-[11px]"
                    title={a.has_search ? "已挂 knowledge_search，点一下摘掉" : "点一下挂上 knowledge_search"}
                    style={{
                      background: a.has_search
                        ? "color-mix(in srgb, var(--color-accent) 14%, transparent)"
                        : "var(--color-surface-3)",
                      color: a.has_search ? "var(--color-accent)" : "var(--color-text-3)",
                    }}
                    onClick={async () => {
                      try {
                        const got = await api.knowledgeToggleAgentSearch(a.id, !a.has_search);
                        setCov((prev) =>
                          (prev ?? []).map((x) => (x.id === a.id ? { ...x, has_search: got.has_search } : x)),
                        );
                      } catch {
                        /* 切换失败保持原样 */
                      }
                    }}
                  >
                    {a.has_search ? "✓ " : ""}
                    {a.name}
                  </button>
                ))}
                {cov.length > 8 ? (
                  <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                    还有 {cov.length - 8} 个
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          {open === "docs" ? (
            <div className="space-y-1">
              <div className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                这些文档用自己标题+首段也查不到（多半是正文太短或标题太泛）
              </div>
              {stats.docs.misses.map((m) => (
                <div key={m.id} className="truncate text-[12px]" style={{ color: "var(--color-text-2)" }}>
                  {m.name}
                </div>
              ))}
            </div>
          ) : null}
          {open === "tags" ? (
            <div className="space-y-1">
              <div className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                这些标签名查不全它下面的文档（术语和正文不一致时最常见）
              </div>
              {stats.tags.misses.map((m) => (
                <div key={m.id} className="truncate text-[12px]" style={{ color: "var(--color-text-2)" }}>
                  {m.name} · 命中 {m.hit}/{m.expected}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </Section>
  );
}

/* ────────────────────────── 回收站 ────────────────────────── */

function TrashSection({ onChanged }: { onChanged: () => Promise<void> | void }) {
  const fb = useFeedback();
  const [items, setItems] = useState<KnowledgeDoc[] | null>(null);

  const load = useCallback(async () => {
    try {
      const got = await api.knowledgeTrash();
      setItems(got.items ?? []);
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Section
      title="回收站"
      count={items?.length ?? undefined}
      desc="删掉的文档先放这里，可以恢复；彻底删除会连原件一起清掉"
      defaultOpen={false}
    >
      {items === null ? (
        <div className="h-14 animate-pulse rounded-[10px]" style={{ background: "var(--color-surface-2)" }} />
      ) : items.length === 0 ? (
        <div className="text-[12px]" style={{ color: "var(--color-text-3)" }}>
          回收站是空的
        </div>
      ) : (
        <div className="-mx-3">
          <RowList>
            {items.map((d) => (
              <Row
                key={d.id}
                actions={
                  <>
                    <button
                      className="btn btn-sm"
                      type="button"
                      onClick={async () => {
                        await api.knowledgeRestore(d.id);
                        fb.success("已恢复");
                        await load();
                        await onChanged();
                      }}
                    >
                      恢复
                    </button>
                    <button
                      className="btn btn-sm"
                      type="button"
                      style={{ color: "var(--color-err,#dc2626)" }}
                      onClick={async () => {
                        if (!window.confirm(`彻底删除「${d.name}」？原件与解析文本都会没了，不能恢复。`)) return;
                        await api.knowledgePurge(d.id);
                        fb.success("已彻底删除");
                        await load();
                      }}
                    >
                      彻底删除
                    </button>
                  </>
                }
              >
                <span className="min-w-0 flex-1 truncate text-[13px]">{d.name}</span>
                <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                  {ago(d.updated_at)}
                </span>
              </Row>
            ))}
          </RowList>
        </div>
      )}
    </Section>
  );
}


/* ────────────────────────── 入库流水线（上传→向量化→标签→技能） ────────────────────────── */

const STEP_LABEL: { key: "uploaded" | "parsed" | "embedded" | "tagged" | "skilled"; text: string }[] = [
  { key: "uploaded", text: "上传" },
  { key: "parsed", text: "解析" },
  { key: "embedded", text: "向量化" },
  { key: "tagged", text: "标签" },
  { key: "skilled", text: "技能" },
];

function PipelineSection({
  onOpenDoc,
  onChanged,
}: {
  onOpenDoc: (id: string) => void;
  onChanged: () => void;
}) {
  const fb = useFeedback();
  const [rows, setRows] = useState<PipelineDoc[] | null>(null);
  const [embedOk, setEmbedOk] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const got = await api.knowledgePipeline();
      setRows(got.items ?? []);
      setEmbedOk(got.embed_configured);
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(t);
  }, [load]);

  if (rows === null) {
    return <div className="h-16 animate-pulse rounded-[12px]" style={{ background: "var(--color-surface-2)" }} />;
  }
  if (rows.length === 0) return null;

  return (
    <Section
      title="入库流水线"
      count={rows.length}
      desc="每份文档走四步：解析 → 向量化 → 打标签 → 生成检索技能。哪一步没做，这里直接给按钮"
      right={
        embedOk ? null : (
          <span className="text-[11px]" style={{ color: "var(--color-warn, #d97706)" }}>
            向量化端点未配置
          </span>
        )
      }
    >
      <div className="-mx-3 -my-3">
        <RowList>
          {rows.map((d) => (
            <Row
              key={d.id}
              actions={
                d.next === "wait_parse" ? (
                  <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                    解析中…
                  </span>
                ) : d.next === "done" ? (
                  <span className="text-[11px]" style={{ color: "var(--color-ok,#16a34a)" }}>
                    已完成
                  </span>
                ) : (
                  <button
                    className="btn btn-sm"
                    type="button"
                    disabled={busy === d.id || (d.next === "embed" && !embedOk)}
                    title={
                      d.next === "embed" && !embedOk
                        ? "先在「能力 → 工具检索」里配置向量化端点（base_url / 模型 / key）"
                        : ""
                    }
                    onClick={async () => {
                      if (d.next === "tag" || d.next === "skill") {
                        onOpenDoc(d.id);
                        return;
                      }
                      if (d.next !== "embed") return;
                      setBusy(d.id);
                      try {
                        const got = await api.knowledgeEmbed(d.id);
                        fb.success(`已向量化 ${got.chunks} 块（${got.dim} 维 · ${got.model}），正在提关键词`);
                        // 向量化完成立刻出候选关键词（用户点一次就把两件事做完）
                        try {
                          const kw = await api.knowledgeKeywords(d.id);
                          if (kw.items?.length) {
                            fb.success(`已提取 ${kw.items.length} 个关键词：${kw.items.map((x) => x.name).join("、")}`);
                          }
                        } catch {
                          /* 关键词失败不影响向量化结果 */
                        }
                        await load();
                        onChanged();
                      } catch (e) {
                        fb.error("向量化失败", e instanceof Error ? e.message : String(e));
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {busy === d.id
                      ? "处理中…"
                      : d.next === "embed"
                        ? "向量化"
                        : d.next === "tag"
                          ? "去打分标签"
                          : "生成 Skill"}
                  </button>
                )
              }
            >
              <span className="min-w-0 flex-1 truncate text-[13px]">{d.name}</span>
              <span className="flex items-center gap-1">
                {STEP_LABEL.map((st) => {
                  const ok = d.steps[st.key];
                  return (
                    <span
                      key={st.key}
                      className="rounded px-1 py-[1px] text-[10.5px]"
                      title={ok ? `${st.text}已完成` : `${st.text}还没做`}
                      style={{
                        background: ok
                          ? "color-mix(in srgb, var(--color-accent) 12%, transparent)"
                          : "var(--color-surface-3)",
                        color: ok ? "var(--color-accent)" : "var(--color-text-3)",
                      }}
                    >
                      {ok ? "✓" : "·"} {st.text}
                    </span>
                  );
                })}
              </span>
            </Row>
          ))}
        </RowList>
      </div>
    </Section>
  );
}

/* ────────────────────────── 卡片流（一份文档一张卡） ────────────────────────── */

type FlowStep = { uploaded: boolean; parsed: boolean; embedded: boolean; tagged: boolean; skilled: boolean };

function DocumentFlow({
  docs,
  cats,
  agents,
  agentId,
  onUpload,
  graphFilter,
  onClearGraphFilter,
  q,
  onQuery,
  tagFilter,
  onTagFilter,
  tags,
  onChanged,
}: {
  docs: KnowledgeDoc[];
  cats: KnowledgeCategory[];
  agents: { id: string; name: string }[];
  agentId: string;
  onUpload: (files: FileList | File[]) => void;
  graphFilter: { kind: string; label: string; docIds: string[] } | null;
  onClearGraphFilter: () => void;
  q: string;
  onQuery: (v: string) => void;
  tagFilter: string;
  onTagFilter: (v: string) => void;
  tags: string[];
  onChanged: () => void;
}) {
  const fb = useFeedback();
  const [flow, setFlow] = useState<Record<string, { steps: FlowStep; next: string }>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadFlow = useCallback(async () => {
    try {
      const got = await api.knowledgePipeline();
      const map: Record<string, { steps: FlowStep; next: string }> = {};
      for (const it of got.items ?? []) map[it.id] = { steps: it.steps, next: it.next };
      setFlow(map);
    } catch {
      setFlow({});
    }
  }, []);

  useEffect(() => {
    void loadFlow();
    const t = window.setInterval(() => void loadFlow(), 5000);
    return () => window.clearInterval(t);
  }, [loadFlow]);

  const stepsOf = (d: KnowledgeDoc): FlowStep =>
    flow[d.id]?.steps ?? {
      uploaded: true,
      parsed: d.status === "ready",
      embedded: d.embed_status === "ready",
      tagged: (d.tags?.length ?? 0) > 0,
      skilled: false,
    };
  const nextOf = (d: KnowledgeDoc): string => flow[d.id]?.next ?? (d.status === "ready" ? "embed" : "wait_parse");

  const primary = async (d: KnowledgeDoc) => {
    const next = nextOf(d);
    if (next === "embed") {
      setBusy(d.id);
      try {
        const got = await api.knowledgeEmbed(d.id);
        fb.success(`已向量化 ${got.chunks} 块，正在提关键词`);
        try {
          const kw = await api.knowledgeKeywords(d.id);
          if (kw.items?.length) fb.success(`关键词 ${kw.items.length} 个：${kw.items.map((x) => x.name).join("、")}`);
        } catch {
          /* 关键词失败不影响向量化 */
        }
        await loadFlow();
        onChanged();
      } catch (e) {
        fb.error("向量化失败", e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
      return;
    }
    if (next === "tag") {
      setBusy(d.id);
      try {
        const kw = await api.knowledgeKeywords(d.id);
        fb.success(kw.items?.length ? `已提 ${kw.items.length} 个候选标签` : "正文太短，抽不出关键词，手动加更靠谱");
        setOpenId(d.id);
        await loadFlow();
        onChanged();
      } catch (e) {
        fb.error("出关键词失败", e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
      return;
    }
    if (next === "skill") {
      setBusy(d.id);
      try {
        const got = await api.knowledgeSkillFromDoc(d.id, agentId || undefined);
        fb.success(`已生成技能草稿「${got.draft.name || "生成中"}」`);
        await loadFlow();
        onChanged();
      } catch (e) {
        fb.error("生成技能失败", e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    }
  };

  const actionLabel = (next: string) =>
    next === "wait_parse" ? "解析中…" : next === "embed" ? "向量化" : next === "tag" ? "出关键词" : next === "skill" ? "生成技能" : "已完成";

  const [drag, setDrag] = useState(false);
  const shownDocs = graphFilter ? docs.filter((d) => graphFilter.docIds.includes(d.id)) : docs;
  const fileRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="space-y-2">
      {/* 投放卡：与文档卡同一形态，流程第一格就是"把它拖进来" */}
      <div
        className="flex flex-wrap items-center gap-3 rounded-[12px] px-3 py-3"
        style={{ background: drag ? "color-mix(in srgb, var(--color-accent) 12%, var(--color-surface-2))" : "var(--color-surface-2)" }}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (e.dataTransfer.files?.length) onUpload(e.dataTransfer.files);
        }}
      >
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] text-[16px]"
          style={{ background: "var(--color-surface)", color: "var(--color-accent)" }}
          aria-hidden
        >
          ＋
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px]">{drag ? "松手即入库" : "拖文件进来，或选择文件"}</span>
          <span className="block text-[11px]" style={{ color: "var(--color-text-3)" }}>
            PDF · DOCX · XLSX · PPTX · MD · TXT · HTML · ≤100MB
          </span>
        </span>
        <button className="btn btn-sm" type="button" onClick={() => fileRef.current?.click()}>
          选择文件
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) onUpload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      <Toolbar>
        <input
          className="input h-9 min-w-0 flex-1 text-[12px] sm:max-w-xs"
          placeholder="搜文档名（正文命中会一起出现在结果里）"
          value={q}
          onChange={(e) => onQuery(e.target.value)}
          aria-label="搜文档"
        />
        <select
          className="input h-9 w-36 text-[12px]"
          value={tagFilter}
          onChange={(e) => onTagFilter(e.target.value)}
          aria-label="按标签筛选"
        >
          <option value="">全部标签</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <span className="ml-auto text-[11px]" style={{ color: "var(--color-text-3)" }}>
          {shownDocs.length} 份
        </span>
      </Toolbar>

      {graphFilter ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-[11.5px]"
             style={{ background: "color-mix(in srgb, var(--color-accent) 10%, transparent)" }}>
          <span>图谱筛选：{graphFilter.kind === "doc" ? "文档" : graphFilter.kind === "tag" ? "标签" : graphFilter.kind === "skill" ? "技能" : graphFilter.kind === "category" ? "分类" : "助手"} · {graphFilter.label}</span>
          <span style={{ color: "var(--color-text-3)" }}>{shownDocs.length} 份</span>
          <button className="btn btn-sm ml-auto" type="button" onClick={onClearGraphFilter}>
            取消筛选
          </button>
        </div>
      ) : null}

      {shownDocs.length === 0 ? (
        <Empty
          title="还没有文档"
          hint="把文件拖到右上「上传文档」，或点「粘贴文本」直接入库；上传后这一行就是它的流程卡"
        />
      ) : null}

      {shownDocs.map((d) => {
        const st = stepsOf(d);
        const next = nextOf(d);
        const open = openId === d.id;
        return (
          <div
            key={d.id}
            className="overflow-hidden rounded-[12px]"
            style={{ background: "var(--color-surface)" }}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2.5">
              <button
                type="button"
                className="flex min-h-[32px] min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => setOpenId(open ? null : d.id)}
                aria-expanded={open}
              >
                <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>
                  {open ? "▾" : "▸"}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{d.name}</span>
              </button>
              <span className="flex items-center gap-1">
                {([
                  ["解析", st.parsed],
                  ["向量", st.embedded],
                  ["标签", st.tagged],
                  ["技能", st.skilled],
                ] as [string, boolean][]).map(([label, ok]) => (
                  <span
                    key={label}
                    className="rounded-full px-1.5 py-[1px] text-[10.5px]"
                    style={{
                      background: ok ? "color-mix(in srgb, var(--color-accent) 12%, transparent)" : "var(--color-surface-3)",
                      color: ok ? "var(--color-accent)" : "var(--color-text-3)",
                    }}
                    title={`${label}${ok ? "已完成" : "还没做"}`}
                  >
                    {ok ? "✓" : "·"} {label}
                  </span>
                ))}
              </span>
              <button
                className="btn btn-sm"
                type="button"
                style={{ color: "var(--color-text-2)" }}
                onClick={() => {
                  setOpenId(d.id);
                  window.setTimeout(() => {
                    document.getElementById(`raw-${d.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }, 120);
                }}
                title="看解析后的正文与原文"
              >
                原文
              </button>
              <button
                className="btn btn-sm"
                type="button"
                disabled={next === "wait_parse" || next === "done" || busy === d.id}
                style={next === "done" ? { color: "var(--color-ok,#16a34a)" } : undefined}
                onClick={() => void primary(d)}
              >
                {busy === d.id ? "处理中…" : actionLabel(next)}
              </button>
            </div>
            {open ? (
              <DocDetail
                doc={d}
                cats={cats}
                onPatch={async (id, body) => {
                  try {
                    await api.knowledgePatchDoc(id, body);
                    onChanged();
                  } catch (e) {
                    fb.error("保存失败", e instanceof Error ? e.message : String(e));
                  }
                }}
                onChanged={onChanged}
                onDeleted={() => {
                  setOpenId(null);
                  onChanged();
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
