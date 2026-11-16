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

import { api } from "@/lib/api";
import { KnowledgeGraph } from "@/components/KnowledgeGraph";
import type {
  DocTagLink,
  DocVersion,
  KnowledgeCategory,
  KnowledgeDoc,
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
  const [catFilter, setCatFilter] = useState("");
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
      const catName = catFilter ? cats.find((c) => c.id === catFilter)?.name ?? "未分类" : "未分类";
      const got = await api.knowledgeUpload(list, catName);
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
      if (catFilter === "__none" ? d.category_id !== "" : catFilter && d.category_id !== catFilter) return false;
      if (!key) return true;
      if (d.name.toLowerCase().includes(key)) return true;
      return (bodyHits ?? []).includes(d.id);
    });
  }, [docs, q, catFilter, bodyHits]);

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
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { key: "docs", label: "文档", count: docs?.length },
            { key: "meta", label: "分类与标签", count: cats.length || undefined },
            { key: "settings", label: "设置" },
          ]}
        />
      </div>

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
                    category: catFilter ? catName(catFilter) : undefined,
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
          <div className="mt-1.5 text-[11px]" style={{ color: "var(--color-text-3)" }}>
            抓取会保存正文和一份 HTML 快照；原始网页以后改版也不影响这份知识
          </div>
        </div>
      ) : null}

      {tab === "docs" ? (
        <div className="space-y-3">
          <Toolbar>
            <input
              className="input h-9 min-w-0 flex-1 text-[12px] sm:max-w-xs"
              placeholder="搜文件名"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="搜文件名"
            />
            <select
              className="input h-9 w-40 text-[12px]"
              value={catFilter}
              onChange={(e) => setCatFilter(e.target.value)}
              aria-label="按分类筛选"
            >
              <option value="">全部分类</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}（{c.doc_count}）
                </option>
              ))}
              <option value="__none">未分类</option>
            </select>
            {catFilter && catFilter !== "__none" ? (
              <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                上传会直接进「{catName(catFilter)}」
              </span>
            ) : null}
            <span className="ml-auto hidden text-[11px] sm:inline" style={{ color: "var(--color-text-3)" }}>
              {shown.length} / {docs?.length ?? 0} 份
            </span>
          </Toolbar>

          {drafts.length > 0 ? (
            <Section
              title="待确认的草稿"
              count={drafts.length}
              defaultOpen={false}
              desc="助手建议的分类、标签、摘要与 Skill；采纳才写进文档，忽略就丢掉"
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                  采纳会直接改文档（分类 / 标签 / 摘要 / 新建 Skill）
                </span>
                <button
                    className="btn btn-sm ml-auto"
                    type="button"
                    disabled={busy === "accept-all"}
                    onClick={async () => {
                      setBusy("accept-all");
                      try {
                        for (const d of drafts) await api.knowledgeAcceptDraft(d.id);
                        fb.success(`已采纳 ${drafts.length} 条`);
                        await Promise.all([loadDocs(), loadMeta()]);
                      } catch (e) {
                        fb.error("批量采纳失败", e instanceof Error ? e.message : String(e));
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    全部采纳
                  </button>
                  <button
                    className="btn btn-sm"
                    type="button"
                    style={{ color: "var(--color-muted)" }}
                    disabled={busy === "reject-all"}
                    onClick={async () => {
                      setBusy("reject-all");
                      try {
                        for (const d of drafts) await api.knowledgeRejectDraft(d.id);
                        fb.success("已忽略全部草稿");
                        await loadMeta();
                      } catch (e) {
                        fb.error("批量忽略失败", e instanceof Error ? e.message : String(e));
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    全部忽略
                  </button>
              </div>
              <div className="-mx-3 -my-3">
                <RowList>
                  {drafts.map((d) => (
                    <Row
                      key={d.id}
                      actions={
                        <>
                          <button
                            className="btn btn-primary btn-sm"
                            type="button"
                            onClick={async () => {
                              try {
                                await api.knowledgeAcceptDraft(d.id);
                                fb.success("已采纳");
                                await Promise.all([loadDocs(), loadMeta()]);
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
                            style={{ color: "var(--color-muted)" }}
                            onClick={async () => {
                              try {
                                await api.knowledgeRejectDraft(d.id);
                                await loadMeta();
                              } catch (e) {
                                fb.error("忽略失败", e instanceof Error ? e.message : String(e));
                              }
                            }}
                          >
                            忽略
                          </button>
                        </>
                      }
                    >
                      <Chip tone="muted">{DRAFT_LABEL[d.kind] ?? d.kind}</Chip>
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">
                        <span style={{ color: "var(--color-text-3)" }}>{d.doc_name || d.doc_id} · </span>
                        {d.kind === "category" || d.kind === "skill"
                          ? d.payload.name
                          : d.kind === "tags"
                            ? (d.payload.add ?? []).join("、")
                            : d.payload.text}
                      </span>
                      {typeof d.payload.confidence === "number" ? (
                        <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                          把握 {Math.round(d.payload.confidence * 100)}%
                        </span>
                      ) : null}
                    </Row>
                  ))}
                </RowList>
              </div>
            </Section>
          ) : null}

          {chosen.length > 0 ? (
            <SelectionBar
              count={chosen.length}
              onClear={() => setPicked({})}
              onSelectAll={() => {
                const all: Record<string, boolean> = {};
                for (const d of readyDocs) all[d.id] = true;
                setPicked(all);
              }}
              allSelected={readyDocs.length > 0 && chosen.length >= readyDocs.length}
              selectAllLabel={`全选已就绪（${readyDocs.length}）`}
              actions={
                <>
                  <select
                    className="input h-8 w-48 text-[12px]"
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    aria-label="用哪个助手"
                    title="用哪个助手读这些文档"
                  >
                    {agents.length === 0 ? <option value="">（还没有可用助手）</option> : null}
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btn-sm"
                    type="button"
                    disabled={busy === "org" || !agentId || chosen.length === 0}
                    onClick={async () => {
                      setBusy("org");
                      try {
                        await api.knowledgeOrganize({ agent_id: agentId, doc_ids: chosen });
                        fb.success("已开始整理，草稿会出现在上方");
                        setPicked({});
                        await loadMeta();
                      } catch (e) {
                        fb.error("整理没能开始", e instanceof Error ? e.message : String(e));
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    让助手整理
                  </button>
                  <button
                    className="btn btn-sm"
                    type="button"
                    title="把选中的文档提炼成 SKILL.md 草稿（采纳后才写入 workspace）"
                    disabled={busy === "skill" || !agentId || chosen.length === 0}
                    onClick={async () => {
                      setBusy("skill");
                      try {
                        let n = 0;
                        for (const id of chosen) {
                          await api.knowledgeSkillDraft(id, agentId);
                          n += 1;
                        }
                        fb.success(`已提交 ${n} 份文档做 Skill 提炼，稍后刷新草稿`);
                        setPicked({});
                        await loadMeta();
                      } catch (e) {
                        fb.error("提炼没能开始", e instanceof Error ? e.message : String(e));
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    提炼为 Skill
                  </button>
                </>
              }
            />
          ) : null}

          {docs === null ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-11 animate-pulse rounded-[10px]" style={{ background: "var(--color-surface-2)" }} />
              ))}
            </div>
          ) : shown.length === 0 ? (
            <Empty
              title={docs.length === 0 ? "还没有文档" : "这个筛选下没有文档"}
              hint={
                docs.length === 0
                  ? "把文件拖到下面这块，或点右上「上传文档」。支持 PDF / DOCX / XLSX / PPTX / MD / TXT / HTML，单文件 100MB 内"
                  : "换个分类或清空搜索再看看"
              }
              action={
                docs.length === 0 ? (
                  <button className="btn btn-primary btn-sm" type="button" onClick={() => fileRef.current?.click()}>
                    上传第一份文档
                  </button>
                ) : (
                  <button
                    className="btn btn-sm"
                    type="button"
                    onClick={() => {
                      setQ("");
                      setCatFilter("");
                    }}
                  >
                    清空筛选
                  </button>
                )
              }
            />
          ) : (
            <RowList>
              {shown.map((r) => {
                const open = openId === r.id;
                return (
                  <div key={r.id}>
                    <Row
                      expanded={open}
                      onToggle={() => setOpenId(open ? null : r.id)}
                      actions={
                        <>
                          <SelectBox
                            checked={!!picked[r.id]}
                            disabled={r.status !== "ready"}
                            title={r.status === "ready" ? "选中这份文档" : "解析完成后才能整理"}
                            onChange={(v) => setPicked((p) => ({ ...p, [r.id]: v }))}
                          />
                        </>
                      }
                    >
                      <span className="min-w-0 flex-1 truncate text-[13px]">{r.name}</span>
                      {r.status !== "ready" ? <StatusDot status={r.status} /> : null}
                      <Chip tone="muted">{catName(r.category_id)}</Chip>
                      <span className="hidden text-[11px] sm:inline" style={{ color: "var(--color-text-3)" }}>
                        {r.parsed?.textLength ? `${r.parsed.textLength.toLocaleString()} 字` : sizeText(r.size)}
                      </span>
                      <span className="hidden w-16 text-right text-[11px] sm:inline" style={{ color: "var(--color-text-3)" }}>
                        {ago(r.updated_at)}
                      </span>
                    </Row>
                    {open ? <DocDetail doc={r} cats={cats} onPatch={patchDoc} onChanged={() => { void loadDocs(); void loadMeta(); }} onDeleted={() => {
                      setOpenId(null);
                      void loadDocs();
                      void loadMeta();
                    }} /> : null}
                  </div>
                );
              })}
            </RowList>
          )}

          <div
            className="rounded-[12px] px-3 py-3 text-[12px]"
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
            {dragOver ? "松手即上传" : "把文件拖到这里也能上传"}
          </div>
        </div>
      ) : tab === "meta" ? (
        <div className="space-y-3">
          <CategoriesSection
            cats={cats}
            firstLoad={!loaded}
            onChanged={async () => {
              await Promise.all([loadMeta(), loadDocs()]);
            }}
          />
          <TagsSection
            tags={tags}
            firstLoad={!loaded}
            onChanged={async () => {
              await Promise.all([loadMeta(), loadDocs()]);
            }}
          />
          <RecallSection />
          <Section title="知识关系" desc="文档 → 分类、技能 → 来源文档、助手 → 技能；只画真实引用">
            <KnowledgeGraph />
          </Section>
        </div>
      ) : (
        <div className="space-y-3">
          <StorageSection
            storages={storages}
            firstLoad={!loaded}
            onChanged={loadMeta}
          />
          <MigrateSection storages={storages} />
          <TrashSection onChanged={loadMeta} />
        </div>
      )}
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
          <KV k="分类">
            <select
              className="input h-8 w-44 text-[12px]"
              value={doc.category_id || ""}
              onChange={(e) => void onPatch(doc.id, { category: e.target.value })}
              aria-label="改分类"
            >
              <option value="">未分类</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </KV>
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

        {doc.error?.message ? (
          <div
            className="rounded-md px-2.5 py-2 text-[12px]"
            style={{ background: "color-mix(in srgb, var(--color-err,#dc2626) 8%, transparent)", color: "var(--color-err,#dc2626)" }}
          >
            {doc.error.message}
          </div>
        ) : null}

        <div>
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
      desc="「查得到吗」的四个数：文档自召回、标签召回、助手真实检索命中、页面搜索命中"
    >
      {!loaded && !stats ? (
        <div className="h-16 animate-pulse rounded-[10px]" style={{ background: "var(--color-surface-2)" }} />
      ) : !stats ? (
        <div className="text-[12px]" style={{ color: "var(--color-text-3)" }}>
          暂时读不到统计数据
        </div>
      ) : (
        <div className="space-y-2">
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
