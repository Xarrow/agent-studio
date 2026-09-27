"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { Skill } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { Hint, HINTS } from "@/components/ui/hint";
import { DLG_BACKDROP, DLG_CARD } from "@/components/ui/kit";

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

  return (
    <div className={embedded ? "" : "p-4 md:p-6 lg:p-7 max-w-5xl"}>
      {/* 新建/导入入口：嵌入工具页时也要可见（否则用户没有任何创建自定义 skill 的地方） */}
      <div className={`flex items-center justify-between ${embedded ? "mb-4" : ""}`}>
        {!embedded && (
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight flex items-center gap-1.5">
              <Hint text={HINTS.skill}>Skills</Hint>
            </h1>
            <p className="text-[13px] text-[var(--color-muted)] mt-1">
              预先写好的「做事套路」。装上之后，助手遇到这类任务就知道该按什么步骤做。
            </p>
            <p className="text-[11.5px] text-[var(--color-muted)] mt-1">
              {skills.length} 个 · 标准 <span className="mono">SKILL.md</span> 格式，与 Claude Code /
              Hermes / AgentScope 通用
            </p>
          </div>
        )}
        <button className={`btn btn-primary ${embedded ? "ml-auto" : ""}`} onClick={() => setShowImport(true)}>
          + 新建 / 导入 Skill
        </button>
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

      <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
        <div>
          {loading ? (
            <div className="card p-6 text-[13px] text-[var(--color-muted)]">加载中…</div>
          ) : skills.length === 0 ? (
            <div className="card p-6 text-center text-[13px] text-[var(--color-muted)]">
              还没有 Skill。可以从 Git 仓库、URL、服务器本地目录导入，或直接写一份。
            </div>
          ) : (
            <div className="space-y-2">
              {skills.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setDetail(s)}
                  className={`card p-3.5 w-full text-left transition-colors hover:border-[var(--color-accent-dim)] ${
                    detail?.id === s.id ? "border-[var(--color-accent)]" : ""
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-[13.5px] truncate">{s.name}</span>
                    <span className="tag shrink-0">{String(s.source?.type ?? "—")}</span>
                  </div>
                  {s.description && (
                    <p className="text-[11.5px] text-[var(--color-muted)] mt-1 line-clamp-2">
                      {s.description}
                    </p>
                  )}
                  <div className="text-[11px] text-[var(--color-muted)] mt-1.5">
                    {Object.keys(s.files ?? {}).length} 个附件 · {fmt.relative(s.updated_at)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="card p-4 min-h-[300px]">
          {detail ? (
            <>
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h2 className="text-[15px] font-medium">{detail.name}</h2>
                  {typeof detail.source?.url === "string" && (
                    <div className="text-[11px] text-[var(--color-muted)] mono mt-0.5 truncate">
                      {detail.source.url}
                      {typeof detail.source?.sha === "string" &&
                        ` @ ${detail.source.sha.slice(0, 8)}`}
                    </div>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button className="btn" onClick={() => setEditing(detail)}>
                    编辑
                  </button>
                  <button className="btn text-[var(--color-err)]" onClick={() => remove(detail)}>
                    删除
                  </button>
                </div>
              </div>

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
                <>
              {Object.keys(detail.files ?? {}).length > 0 && (
                <div className="mb-3">
                  <div className="text-[11.5px] text-[var(--color-muted)] mb-1">附件</div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.keys(detail.files).map((f) => (
                      <span key={f} className="tag mono">
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <pre className="text-[11.5px] whitespace-pre-wrap break-all bg-[var(--color-bg)] p-3 rounded-md max-h-[420px] overflow-auto">
                {detail.content}
              </pre>
                </>
              )}
            </>
          ) : (
            <div className="h-full flex items-center justify-center text-[12.5px] text-[var(--color-muted)]">
              选择左侧 Skill 查看内容
            </div>
          )}
        </div>
      </div>
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
        <h2 className="text-[16px] font-medium mb-4">导入 Skill</h2>

        <div className="flex gap-1.5 mb-4">
          {(
            [
              ["git", "Git 仓库"],
              ["url", "单个 URL"],
              ["local", "服务器本地"],
              ["inline", "手写"],
            ] as [Source, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              className={`btn ${source === k ? "border-[var(--color-accent)] text-[var(--color-accent)]" : ""}`}
              onClick={() => setSource(k)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="space-y-3.5">
          {source === "git" && (
            <>
              <div>
                <label className="label">仓库地址</label>
                <input
                  className="input mono"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://github.com/user/awesome-skills"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">分支 / Tag（可空）</label>
                  <input
                    className="input mono"
                    value={ref}
                    onChange={(e) => setRef(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label">子目录（可空，自动扫描 SKILL.md）</label>
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

          {err && <div className="text-[12.5px] text-[var(--color-err)]">{err}</div>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? "导入中…" : "导入"}
          </button>
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
      fb.error("缺 frontmatter", "开头要有 --- 包住的 name 和 description（照模板改）");
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
      <div className="flex items-center gap-2 text-[11.5px] text-[var(--color-muted)]">
        <span className="mono">{fmName}</span>
        <span>·</span>
        <span>
          常驻成本 ≈ {residentTokens} tokens（只有 description 进提示，正文用到才读）
        </span>
      </div>
      <textarea
        className="input mono text-[11.5px] w-full"
        rows={16}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
      />
      <div className="text-[11px] text-[var(--color-muted)]">
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
