"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmt } from "@/lib/api";
import { isImeEvent } from "@/lib/ime";
import type { Skill, SkillRepoScan } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { Hint, HINTS } from "@/components/ui/hint";
import { DLG_BACKDROP, DLG_CARD, KV, Row, RowList, Segmented } from "@/components/ui/kit";
import Markdown from "@/components/Markdown";
import { SkillDetailPanel, glyphFor, stripFrontmatter } from "@/components/SkillDetailPanel";
import {
  IconArchive,
  IconBox,
  IconChevronRight,
  IconCopy,
  IconFile,
  IconFileText,
  IconFolder,
  IconPlus,
  IconWand,
  IconLink,
  IconPencil,
  IconPin,
  IconRefresh,
  IconSearch,
  IconSkill,
  IconSpark,
  IconTrash,
} from "@/components/ui/icons";

type Source = "git" | "url" | "local" | "inline";

/**
 * Skills 管理面板 —— 现在**嵌在「工具」页里**，不再单独占一个菜单。
 *
 * 为什么不单开一页：Skills 和工具对用户是同一件事（"这个助手能干什么"），
 * 分成两个菜单等于让人先猜"我要找的东西归哪类"。工具页里用页签并排，
 * 一眼看到全部能力，底部/上方的切换也少一次。
 *
 * ``embedded``：嵌进工具页时把页级标题收起来（页签已经写了 Skills，别重复）。
 */
/** 来源用人话说：`agent` 这种类型名对用户没意义，他只关心「谁弄进来的」。 */
function sourceLabel(source: unknown): string {
  const src = (source ?? {}) as Record<string, unknown>;
  const type = String(src.type ?? "").toLowerCase();
  if (type === "agent") {
    const who = String(src.agent_name ?? "").trim();
    return who ? `助手沉淀 · ${who}` : "助手沉淀";
  }
  if (type === "repo" || type === "git") return "仓库安装";
  if (type === "url") return "网址导入";
  if (type === "import" || type === "zip") return "压缩包导入";
  if (type === "manual" || type === "local" || type === "inline") return "手写";
  return type || "—";
}

/** 状态用人话说：stale = 很久没人读了（照样能用），archived = 已从助手那边撤下 */
const STATE_LABEL: Record<string, { text: string; color: string }> = {
  active: { text: "在用", color: "var(--color-ok)" },
  stale: { text: "闲置", color: "var(--color-warn, #b45309)" },
  archived: { text: "已归档", color: "var(--color-muted)" },
};

export function SkillsPanel({ embedded = false }: { embedded?: boolean }) {
  const fb = useFeedback();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [showImport, setShowImport] = useState(false);
  const [detail, setDetail] = useState<Skill | null>(null);
  /** 就地编辑的 skill（null = 只读视图） */
  const [editing, setEditing] = useState<Skill | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSkills(await api.skills());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 按安装时记下的来源重新装一遍（公司/社区仓库更新了就能一键拉新版） */
  const [updating, setUpdating] = useState(false);
  const update = async (s: Skill) => {
    setUpdating(true);
    try {
      const r = await api.reinstallSkill(s.id);
      const fresh = await api.skill(s.id);
      setDetail(fresh);
      await load();
      fb.success(`「${s.name}」已更新`, `${r.ref}${r.sha ? " · " + r.sha.slice(0, 7) : ""}`);
    } catch (e) {
      fb.error("更新失败", e instanceof Error ? e.message : String(e));
    } finally {
      setUpdating(false);
    }
  };

  /** 固定 / 取消固定：钉住的技能任何自动整理都不碰 */
  const togglePin = async (s: Skill) => {
    try {
      const r = await api.pinSkill(s.id, !s.pinned);
      await load();
      const fresh = await api.skill(s.id);
      setDetail(fresh);
      fb.success(r.pinned ? `已固定「${s.name}」` : `已取消固定「${s.name}」`);
    } catch (e) {
      fb.error("操作失败", e instanceof Error ? e.message : String(e));
    }
  };

  /** 归档：从助手那边撤下，内容留在库里 —— 所以不用确认两次，随时能恢复 */
  const archive = async (s: Skill) => {
    try {
      await api.archiveSkill(s.id);
      await load();
      setDetail(await api.skill(s.id));
      fb.success(`已归档「${s.name}」`, "助手那边撤下，内容还在库里");
    } catch (e) {
      fb.error("归档失败", e instanceof Error ? e.message : String(e));
    }
  };

  const restore = async (s: Skill) => {
    try {
      await api.restoreSkill(s.id);
      await load();
      setDetail(await api.skill(s.id));
      fb.success(`已恢复「${s.name}」`);
    } catch (e) {
      fb.error("恢复失败", e instanceof Error ? e.message : String(e));
    }
  };

  /** 整理一次：闲置降级 + 长期不用归档（只动助手自己攒的，绝不出删除） */
  const [curating, setCurating] = useState(false);
  const curate = async () => {
    setCurating(true);
    try {
      const r = await api.runSkillCurator();
      await load();
      const parts: string[] = [];
      if (r.stale?.length) parts.push(`${r.stale.length} 个标记闲置`);
      if (r.archived?.length) parts.push(`${r.archived.length} 个已归档`);
      fb.success(parts.length ? `整理完成：${parts.join("，")}` : "没有需要整理的技能");
    } catch (e) {
      fb.error("整理失败", e instanceof Error ? e.message : String(e));
    } finally {
      setCurating(false);
    }
  };

  const remove = async (s: Skill) => {
    const ok = await fb.confirm({
      title: `删除 Skill「${s.name}」？`,
      description: "已挂载它的 Agent 会失去这段能力说明。",
      danger: true,
      confirmText: "删除",
    });
    if (!ok) return;
    try {
      await api.deleteSkill(s.id);
      setDetail(null);
      fb.success(`已删除 Skill「${s.name}」`);
      await load();
    } catch (e) {
      fb.error("删除 Skill 失败", e instanceof Error ? e.message : String(e));
    }
  };

  /** 列表里的筛选（在用/闲置/已归档）—— 归档的不该和常用技能混在一屏抢注意力 */
  const [filter, setFilter] = useState<"all" | "active" | "stale" | "archived">("all");
  const [q, setQ] = useState("");

  const shown = skills.filter((s) => {
    const st = s.state ?? "active";
    if (filter === "active" && st !== "active") return false;
    if (filter === "stale" && st !== "stale") return false;
    if (filter === "archived" && st !== "archived") return false;
    if (q.trim()) {
      const hay = `${s.name} ${s.description ?? ""}`.toLowerCase();
      if (!hay.includes(q.trim().toLowerCase())) return false;
    }
    return true;
  });

  const countOf = (k: "active" | "stale" | "archived") =>
    skills.filter((x) => (x.state ?? "active") === k).length;

  return (
    <div className={embedded ? "" : "p-4 md:p-6 lg:p-7 max-w-5xl"}>
      {/* 新建/导入入口：嵌入工具页时也要可见（否则用户没有任何创建自定义 skill 的地方） */}
      <div className={`flex flex-wrap items-center justify-between gap-2 ${embedded ? "mb-3" : "mb-4"}`}>
        {!embedded && (
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight flex items-center gap-1.5">
              <Hint text={HINTS.skill}>Skills</Hint>
            </h1>
            <p className="text-[13px] text-[var(--color-muted)] mt-1">
              预先写好的「做事套路」。装上之后，助手遇到这类任务就知道该按什么步骤做。
            </p>
            <p className="text-[12px] text-[var(--color-muted)] mt-1">
              标准 <span className="mono">SKILL.md</span> 格式，与 Claude Code / Hermes / AgentScope 通用
            </p>
          </div>
        )}
        <div className={`flex items-center gap-2 ${embedded ? "ml-auto" : ""}`}>
          <button
            className="btn"
            disabled={curating}
            title="把长期没人读的标成闲置、更久的归档（只动助手自己攒的，不会删任何东西）"
            onClick={() => void curate()}
          >
            <IconWand size={14} />
            {curating ? "整理中…" : "整理"}
          </button>
          <button className="btn btn-primary" onClick={() => setShowImport(true)}>
            <IconPlus size={14} />
            新建 / 导入
          </button>
        </div>
      </div>

      {showImport && (
        <ImportDialog
          onClose={() => setShowImport(false)}
          onDone={async () => {
            setShowImport(false);
            await load();
          }}
        />
      )}

      {/* 搜索 + 状态筛选：技能一多，先给"缩小范围"再给"看内容" */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[160px] flex-1">
          <IconSearch
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-muted)]"
          />
          <input
            className="input"
            /* .input 的 padding 是 CSS 类给的，Tailwind 的 pl-8 压不住（同页已有先例）
               → 内联，保证图标和文字不重叠 */
            style={{ paddingLeft: 30 }}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜名字或说明"
            aria-label="搜索 Skill"
          />
        </div>
        <Segmented
          value={filter}
          onChange={(k) => setFilter(k as "all" | "active" | "stale" | "archived")}
          options={[
            { key: "all", label: "全部", count: skills.length },
            { key: "active", label: "在用", count: countOf("active") },
            { key: "stale", label: "闲置", count: countOf("stale") },
            { key: "archived", label: "已归档", count: countOf("archived") },
          ]}
        />
      </div>

      {loading ? (
        <div className="card p-6 text-[13px] text-[var(--color-muted)]">加载中…</div>
      ) : shown.length === 0 ? (
        <div className="card p-8 text-center">
          <IconSkill size={22} className="mx-auto mb-2 text-[var(--color-muted)]" />
          <div className="text-[13px]" style={{ color: "var(--color-muted)" }}>
            {skills.length === 0
              ? "还没有 Skill。可以从 Git 仓库、URL、服务器本地目录导入，或直接写一份。"
              : "这个筛选下没有技能"}
          </div>
          {skills.length === 0 && (
            <button className="btn btn-primary mt-3" onClick={() => setShowImport(true)}>
              + 新建 / 导入 Skill
            </button>
          )}
        </div>
      ) : (
        <RowList>
          {shown.map((s) => {
            const g = glyphFor(s.source);
            const st = s.state ?? "active";
            const meta = STATE_LABEL[st] ?? STATE_LABEL.active;
            return (
              <Row
                key={s.id}
                wrapActions={false}
                onToggle={() => {
                  // 列表里只有摘要，正文要单独拉 —— 先给个壳让弹层立刻出现，
                  // 全文回来再替换（不用等一次往返才看到名字）
                  setDetail(s);
                  void api.skill(s.id).then(setDetail).catch(() => {});
                }}
                actions={<IconChevronRight size={16} className="text-[var(--color-muted)]" />}
              >
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px]"
                  style={{ background: g.bg, color: g.fg }}
                >
                  <g.Ico size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13.5px] font-medium">{s.name}</span>
                    {s.pinned && (
                      <span title="已固定：自动整理不会动它" style={{ color: "var(--color-accent)" }}>
                        <IconPin size={12} />
                      </span>
                    )}
                    <span
                      className="ml-0.5 inline-flex shrink-0 items-center gap-1 text-[11px]"
                      style={{ color: meta.color }}
                    >
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: meta.color }}
                        aria-hidden="true"
                      />
                      {meta.text}
                    </span>
                  </span>
                  {s.description && (
                    <span className="mt-0.5 block truncate text-[12px]" style={{ color: "var(--color-muted)" }}>
                      {s.description}
                    </span>
                  )}
                  <span
                    className="mt-1 flex items-center gap-1.5 text-[11.5px]"
                    style={{ color: "var(--color-muted)" }}
                  >
                    <span className="tag">{sourceLabel(s.source)}</span>
                    <span>·</span>
                    <span>{Object.keys(s.files ?? {}).length} 个附件</span>
                    <span>·</span>
                    <span>用了 {s.use_count ?? 0} 次</span>
                    <span>·</span>
                    <span>{s.last_used_at ? `最后 ${fmt.relative(s.last_used_at)}` : "还没人读过"}</span>
                  </span>
                </span>
              </Row>
            );
          })}
        </RowList>
      )}

      {/* 详情：右侧全高抽屉（手机全屏）。管理一个对象该有整块地方，
          不是右下角一张小抄 —— SKILL.md 是长文，塞浮卡就只剩一条缝。 */}
      {detail && (
        <SkillDetailPanel
          skill={detail}
          sourceText={sourceLabel(detail.source)}
          stateText={(STATE_LABEL[detail.state ?? "active"] ?? STATE_LABEL.active).text}
          stateColor={(STATE_LABEL[detail.state ?? "active"] ?? STATE_LABEL.active).color}
          updating={updating}
          onClose={() => {
            setDetail(null);
            setEditing(null);
          }}
          onUpdate={
            String(detail.source?.repo ?? "") !== "" ? () => void update(detail) : undefined
          }
          onPin={() => void togglePin(detail)}
          onArchive={() => void archive(detail)}
          onRestore={() => void restore(detail)}
          onEdit={() => setEditing(detail)}
          onRemove={() => void remove(detail)}
        >
          {editing?.id === detail.id ? (
            <SkillEditor
              skill={detail}
              onCancel={() => setEditing(null)}
              onSaved={async (s) => {
                setEditing(null);
                await load();
                setDetail(s);
              }}
            />
          ) : (
            <article>
              {/* 正文头：像读一份文档，不是看一段日志 */}
              <div className="mb-2 flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                  <IconFileText size={13} />
                  <span className="mono">SKILL.md</span>
                  <span>·</span>
                  <span>{(detail.content ?? "").length} 字符</span>
                  <span>·</span>
                  <span>{stripFrontmatter(detail.content ?? "").split("\n").length} 行</span>
                </span>
                <button
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] hover:bg-[var(--color-surface-2)]"
                  style={{ color: "var(--color-accent)" }}
                  onClick={() => {
                    void navigator.clipboard?.writeText(detail.content ?? "");
                    fb.success("已复制正文");
                  }}
                >
                  <IconCopy size={12} />
                  复制
                </button>
              </div>

              {/* 真正的 Markdown 渲染 —— 之前是 <pre> 裸文本，最丑的一点 */}
              <div
                className="rounded-[10px] border p-4"
                style={{ borderColor: "var(--color-border)", background: "var(--color-bg)" }}
              >
                <Markdown text={stripFrontmatter(detail.content ?? "")} />
              </div>

              {/* 附件单独一段（正文看得见之后，附件不该插在中间打断阅读） */}
              {Object.keys(detail.files ?? {}).length > 0 && (
                <div className="mt-3">
                  <div className="mb-1.5 inline-flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                    <IconFile size={13} />
                    附件 {Object.keys(detail.files).length} 个
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.keys(detail.files).map((f) => (
                      <span key={f} className="tag mono">
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </article>
          )}
        </SkillDetailPanel>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- //
function ImportDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [source, setSource] = useState<Source>("git");
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [subpath, setSubpath] = useState("");
  const fb = useFeedback();
  const [path, setPath] = useState("");
  const [content, setContent] = useState(
    "---\nname: my-skill\ndescription: 一句话说明这个 Skill 做什么\n---\n\n# 使用说明\n\n在这里写给 Agent 的指令…\n",
  );
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ── 仓库安装：一条引用 → 预览 → 勾选装（对应 npx skills add owner/repo）──
  /** 引用：owner/repo、owner/repo/skills/名字、owner/repo@v1.2、GitHub 链接都认 */
  const [repoRef, setRepoRef] = useState("");
  const [repoPin, setRepoPin] = useState("");
  const [scan, setScan] = useState<SkillRepoScan | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  /** 不是 GitHub 的老路（任意 git 主机）：默认收起，需要时才露出来 */
  const [legacyGit, setLegacyGit] = useState(false);
  /** 影子命令（本机没有 Node 时用） */
  const [cliBusy, setCliBusy] = useState(false);
  const [cliMsg, setCliMsg] = useState<string | null>(null);

  const installCli = async () => {
    setCliBusy(true);
    setCliMsg(null);
    try {
      const r = await api.installSkillsCli();
      const lines = [`已写入 ${r.written.join("、") || "（无）"}`, r.on_path ? r.hint : "还需要一步：" + r.hint];
      if (r.skipped.length) lines.push("没覆盖（本机已有同名命令）：" + r.skipped.join("、"));
      setCliMsg(lines.join("\n"));
      fb.success("影子命令装好了", r.on_path ? "现在就能用 npx skills add …" : "按提示加进 PATH 后可用");
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setCliMsg(`没装上：${m}`);
      fb.error("安装影子命令失败", m);
    } finally {
      setCliBusy(false);
    }
  };

  const doScan = async () => {
    setBusy(true);
    setErr(null);
    setScan(null);
    try {
      const r = await api.scanSkillRepo(skillInput(repoRef, repoPin));
      setScan(r);
      // 只有一个技能就直接勾上（大多数技能仓库就是这个形状）
      setPicked(r.skills.length === 1 ? [r.skills[0].path] : []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doInstall = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.installSkillRepo({ ...skillInput(repoRef, repoPin), paths: picked });
      fb.success(
        r.count > 1 ? `装好 ${r.count} 个 Skill` : `装好 Skill：${r.items[0]?.name ?? ""}`,
        `${r.repo} @ ${r.ref}`,
      );
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 输入框里放的可能是引用（owner/repo）也可能是**整条命令**
   * （npx skills add owner/repo --skill x）—— 两种都直接发给后端，
   * 用户从 README 抄哪一行都行。
   */
  function skillInput(text: string, pin: string) {
    const t = text.trim();
    const isCmd = /^(npx|pnpx|bunx|pnpm|yarn|skills)\b/.test(t);
    return isCmd ? { command: t } : { ref: t, ref_pin: pin || undefined };
  }

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.importSkill({
        source,
        url: url || undefined,
        ref: ref || undefined,
        subpath: subpath || undefined,
        path: path || undefined,
        content: source === "inline" ? content : undefined,
        name: name || undefined,
      });
      fb.success(`导入成功：${r.count} 个 Skill`);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={DLG_BACKDROP}>
      <div className={`${DLG_CARD} max-w-2xl p-5`}>
        <h2 className="text-[16px] font-medium mb-1">装 Skill</h2>
        <p className="text-[12px] text-[var(--color-muted)] mb-4">
          抄一条 GitHub 引用就行（跟 <span className="mono">npx skills add</span> 一样），
          也可以给单个 SKILL.md 链接、服务器上的目录，或直接手写一份。
        </p>

        {/* 四种来源：图标先给眼睛一个锚点，再读文字确认 —— 纯文字四个按钮要靠读完才知道选哪个 */}
        <div className="mb-4 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {(
            [
              ["git", "GitHub 仓库", IconBox],
              ["url", "单个 URL", IconLink],
              ["local", "服务器本地", IconFolder],
              ["inline", "手写", IconPencil],
            ] as [Source, string, React.ComponentType<{ size?: number }>][]
          ).map(([k, label, Ico]) => {
            const on = source === k;
            return (
              <button
                key={k}
                className="flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-[12.5px] transition-colors"
                style={{
                  borderColor: on ? "var(--color-accent)" : "var(--color-border)",
                  background: on ? "color-mix(in srgb, var(--color-accent) 8%, transparent)" : "var(--color-surface)",
                  color: on ? "var(--color-accent)" : "var(--color-text)",
                }}
                onClick={() => setSource(k)}
              >
                <Ico size={15} />
                {label}
              </button>
            );
          })}
        </div>

        <div className="space-y-3.5">
          {source === "git" && (
            <>
              {!legacyGit ? (
                <>
                  <div>
                    <label className="label">仓库引用</label>
                    <div className="flex gap-2">
                      <input
                        className="input mono flex-1"
                        value={repoRef}
                        onChange={(e) => setRepoRef(e.target.value)}
                        placeholder="tt-a1i/archify"
                        onKeyDown={(e) => {
                          // 组字中的 Enter 是输入法选字，不是「预览」
                          if (e.key === "Enter" && !isImeEvent(e)) {
                            if (repoRef.trim() && !busy) void doScan();
                          }
                        }}
                      />
                      <button
                        className="btn shrink-0"
                        disabled={busy || !repoRef.trim()}
                        onClick={() => void doScan()}
                      >
                        {busy ? "取回中…" : "预览"}
                      </button>
                    </div>
                    <p className="text-[11.5px] text-[var(--color-muted)] mt-1">
                      owner/repo，也可以带仓库内目录（owner/repo/skills/web-design）或版本（@v2.16.0）；
                      从 README 抄整条命令（npx skills add …）也行
                    </p>
                  </div>

                  {/* 没有 Node 的机器：把 npx 换成影子命令，README 那一行就能照抄 */}
                  <div className="flex items-center gap-2 flex-wrap text-[11.5px] text-[var(--color-muted)]">
                    <span>这台机器没有 Node？</span>
                    <button
                      type="button"
                      data-tap
                      className="hover:underline"
                      style={{ color: "var(--color-accent)" }}
                      disabled={cliBusy}
                      onClick={() => void installCli()}
                    >
                      {cliBusy ? "安装中…" : "装上 npx 影子命令"}
                    </button>
                    <span>
                      装完就能直接跑 <span className="mono">npx skills add …</span>（只认 skills 命令，不碰别的包）
                    </span>
                  </div>
                  {cliMsg && (
                    <div
                      className="rounded-lg px-2.5 py-2 text-[11.5px] mono break-all"
                      style={{ background: "var(--color-surface-2)" }}
                    >
                      {cliMsg}
                    </div>
                  )}

                  {scan && (
                    <div className="rounded-xl border p-3" style={{ borderColor: "var(--color-border)" }}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <a
                          href={scan.web_url}
                          target="_blank"
                          rel="noreferrer"
                          className="mono text-[12.5px] hover:underline"
                          style={{ color: "var(--color-accent)" }}
                        >
                          {scan.repo}
                        </a>
                        <span className="tag">{scan.ref}</span>
                        {scan.sha && <span className="mono text-[11px] text-[var(--color-muted)]">{scan.sha.slice(0, 7)}</span>}
                        {typeof scan.stars === "number" && (
                          <span className="text-[11.5px] text-[var(--color-muted)]">★ {scan.stars}</span>
                        )}
                        {scan.license && <span className="text-[11.5px] text-[var(--color-muted)]">{scan.license}</span>}
                      </div>
                      {scan.description && (
                        <p className="text-[12px] text-[var(--color-muted)] mt-1">{scan.description}</p>
                      )}
                      <div className="mt-2 space-y-1">
                        {scan.skills.map((it) => {
                          const on = picked.includes(it.path);
                          return (
                            <button
                              key={it.path || it.name}
                              type="button"
                              className="w-full text-left rounded-lg px-2 py-1.5 flex items-start gap-2 hover:bg-[var(--color-surface-2)]"
                              style={{ background: on ? "color-mix(in srgb, var(--color-accent) 8%, transparent)" : undefined }}
                              onClick={() =>
                                setPicked((p) => (on ? p.filter((x) => x !== it.path) : [...p, it.path]))
                              }
                            >
                              <span
                                className="mt-[3px] w-3.5 h-3.5 rounded-[4px] border shrink-0 flex items-center justify-center"
                                style={{
                                  borderColor: on ? "var(--color-accent)" : "var(--color-border)",
                                  background: on ? "var(--color-accent)" : "transparent",
                                }}
                              >
                                {on && (
                                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M20 6L9 17l-5-5" />
                                  </svg>
                                )}
                              </span>
                              <span className="min-w-0">
                                <span className="text-[13px] font-medium">{it.name}</span>
                                {it.path && (
                                  <span className="mono text-[11px] text-[var(--color-muted)] ml-1.5">{it.path}</span>
                                )}
                                {it.description && (
                                  <span className="block text-[12px] text-[var(--color-muted)] line-clamp-2">
                                    {it.description}
                                  </span>
                                )}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      <div className="flex items-center gap-2 mt-2.5">
                        <span className="text-[11.5px] text-[var(--color-muted)]">
                          {picked.length === 0
                            ? "勾一个再装"
                            : `已选 ${picked.length} 个 · 附件一起搬`}
                        </span>
                        <button
                          className="btn btn-primary btn-sm ml-auto"
                          disabled={busy || picked.length === 0}
                          onClick={() => void doInstall()}
                        >
                          {busy ? "装着呢…" : "装进来"}
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-2 flex-wrap">
                    <div>
                      <label className="label">版本（可空）</label>
                      <input
                        className="input mono"
                        value={repoPin}
                        onChange={(e) => setRepoPin(e.target.value)}
                        placeholder="v2.16.0 / main / commit"
                      />
                    </div>
                    <button
                      type="button"
                      className="text-[11.5px] text-[var(--color-muted)] hover:underline self-end pb-2"
                      onClick={() => setLegacyGit(true)}
                    >
                      不是 GitHub？用克隆地址
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-[var(--color-muted)]">任意 Git 主机</span>
                    <button
                      type="button"
                      className="text-[11.5px] hover:underline"
                      style={{ color: "var(--color-accent)" }}
                      onClick={() => setLegacyGit(false)}
                    >
                      回到 GitHub 引用
                    </button>
                  </div>
                  <div>
                    <label className="label">仓库地址</label>
                    <input
                      className="input mono"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="https://gitlab.com/user/awesome-skills"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="label">分支 / Tag（可空）</label>
                      <input className="input mono" value={ref} onChange={(e) => setRef(e.target.value)} />
                    </div>
                    <div>
                      <label className="label">子目录（可空）</label>
                      <input
                        className="input mono"
                        value={subpath}
                        onChange={(e) => setSubpath(e.target.value)}
                        placeholder="skills/"
                      />
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {source === "url" && (
            <div>
              <label className="label">SKILL.md 的直链</label>
              <input
                className="input mono"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://raw.githubusercontent.com/…/SKILL.md"
              />
            </div>
          )}

          {source === "local" && (
            <>
              <div>
                <label className="label">服务器上的目录路径</label>
                <input
                  className="input mono"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/srv/skills"
                />
              </div>
              <div>
                <label className="label">子目录（可空）</label>
                <input
                  className="input mono"
                  value={subpath}
                  onChange={(e) => setSubpath(e.target.value)}
                />
              </div>
            </>
          )}

          {source === "inline" && (
            <>
              <div>
                <label className="label">名称（可空，优先用 frontmatter 里的）</label>
                <input
                  className="input mono"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div>
                <label className="label">SKILL.md 内容</label>
                <textarea
                  className="input mono"
                  rows={12}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
              </div>
            </>
          )}

          {err && <div className="text-[12px] text-[var(--color-err)]">{err}</div>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button className="btn" onClick={onClose}>
            {source === "git" && !legacyGit ? "关闭" : "取消"}
          </button>
          {/* GitHub 引用这条路是「预览 → 勾选 → 装进来」，动作在预览卡里，
              底部不再放一个语义重复的「导入」（它会走另一条老接口） */}
          {(source !== "git" || legacyGit) && (
            <button className="btn btn-primary" disabled={busy} onClick={submit}>
              {busy ? "导入中…" : "导入"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
function SkillEditor({
  skill,
  onCancel,
  onSaved,
}: {
  skill: Skill;
  onCancel: () => void;
  onSaved: (s: Skill) => void | Promise<void>;
}) {
  /**
   * 页面自定义 Skill 编辑器 —— 语法规范就是 SKILL.md 本身：
   * description（常驻在助手提示里，一行写清"什么时候用我"）+ Markdown 正文（懒加载，按需才读）。
   * 参照 Claude Code 的机制：description 是路由索引、正文是数据。
   */
  const fb = useFeedback();
  const [content, setContent] = useState(skill.content ?? "");
  const [busy, setBusy] = useState(false);

  // 从 frontmatter 实时解析 name/description（与后端 parse_skill_md 同规则）
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  let fmName = skill.name;
  let fmDesc = skill.description;
  if (m) {
    const nm = m[1].match(/^name:\s*(.+)$/m);
    const dm = m[1].match(/^description:\s*(.+)$/m);
    if (nm) fmName = nm[1].trim();
    if (dm) fmDesc = dm[1].trim();
  }
  const hasFrontmatter = Boolean(m);
  // 常驻成本提示：description 约 1 token/2 字符（中英混合估）
  const residentTokens = Math.ceil((fmDesc?.length ?? 0) / 2);

  const save = async () => {
    if (!hasFrontmatter) {
      fb.error("缺 frontmatter", "开头用 --- 包住 name 和 description");
      return;
    }
    setBusy(true);
    try {
      const s = await api.updateSkill(skill.id, { content });
      fb.success(`已保存「${s.name}」`);
      await onSaved(s);
    } catch (e) {
      fb.error("保存失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
        <span className="mono">{fmName}</span>
        <span>·</span>
        <span>
          常驻成本 ≈ {residentTokens} tokens（只有 description 进提示，正文用到才读）
        </span>
      </div>
      <textarea
        className="input mono text-[12px] w-full"
        rows={16}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
      />
      <div className="text-[12px] text-[var(--color-muted)]">
        格式：开头的 <span className="mono">---</span> 里写 name 和 description；正文写给
        Agent 的步骤、命令、坑。description 写"什么时候用我"，别写目录。
      </div>
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={busy} onClick={save}>
          {busy ? "保存中…" : "保存"}
        </button>
        <button className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
