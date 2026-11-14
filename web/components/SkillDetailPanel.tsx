"use client";

/**
 * Skill 详情 —— 只是把 DetailPanel 组装起来。
 *
 * 全站管理页（记忆 / 密钥 / 助手 / 远程 Agent / Skill）共用同一个抽屉：
 * 桌面右侧全高 720、手机全屏。差别只在"身份区怎么摆、有哪些动作"，
 * 容器本身不该各写一遍 —— 这里原来有 200 行和 DetailPanel 几乎一样的结构。
 */

import { useState } from "react";

import {
  IconArchive,
  IconBox,
  IconChevronRight,
  IconClock,
  IconFile,
  IconLink,
  IconPencil,
  IconPin,
  IconRefresh,
  IconSkill,
  IconSpark,
  IconTrash,
} from "@/components/ui/icons";
import { DetailPanel } from "@/components/ui/DetailPanel";
import { api, fmt } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import type { Skill } from "@/lib/types";

/** 来源 → 图标 + 两个色（底 / 线） */
export function glyphFor(source: unknown) {
  const type = String((source as Record<string, unknown> | undefined)?.type ?? "").toLowerCase();
  if (type === "agent")
    return { Ico: IconSpark, bg: "color-mix(in srgb, var(--chart-5) 14%, transparent)", fg: "var(--chart-5)" };
  if (type === "repo" || type === "git")
    return { Ico: IconBox, bg: "color-mix(in srgb, var(--color-accent) 12%, transparent)", fg: "var(--color-accent)" };
  if (type === "url")
    return { Ico: IconLink, bg: "color-mix(in srgb, var(--color-info) 12%, transparent)", fg: "var(--color-info)" };
  if (type === "import" || type === "zip")
    return { Ico: IconArchive, bg: "color-mix(in srgb, var(--color-warn) 12%, transparent)", fg: "var(--color-warn)" };
  return { Ico: IconSkill, bg: "color-mix(in srgb, var(--color-muted) 12%, transparent)", fg: "var(--color-muted)" };
}

/** 正文去掉 frontmatter（它已经渲染在头上了，正文里再来一遍很吵） */
export function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trim();
}

export function SkillDetailPanel({
  skill,
  sourceText,
  stateText,
  stateColor,
  updating,
  children,
  onClose,
  onUpdate,
  onPin,
  onArchive,
  onRestore,
  onEdit,
  onRemove,
  agents,
}: {
  skill: Skill;
  sourceText: string;
  stateText: string;
  stateColor: string;
  updating: boolean;
  /** 编辑态/只读态都塞在这里（编辑时换成编辑器） */
  children: React.ReactNode;
  onClose: () => void;
  onUpdate?: () => void;
  onPin: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onEdit: () => void;
  onRemove: () => void;
  /** 挂了哪些助手 —— 空数组就是"还没有助手用" */
  agents?: { id: string; name: string; enabled: boolean }[];
}) {
  const g = glyphFor(skill.source);
  const archived = (skill.state ?? "active") === "archived";
  const files = Object.keys(skill.files ?? {});

  return (
    <DetailPanel
      title={skill.name}
      icon={<g.Ico size={22} />}
      iconBg={g.bg}
      iconFg={g.fg}
      subtitle={
        <>
          <span>{sourceText}</span>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1" style={{ color: stateColor }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: stateColor }} />
            {stateText}
          </span>
          {skill.pinned && (
            <span className="inline-flex items-center gap-1" style={{ color: "var(--color-accent)" }}>
              <IconPin size={12} />
              固定
            </span>
          )}
        </>
      }
      facts={[
        {
          icon: <IconChevronRight size={13} />,
          text: `用过 ${skill.use_count ?? 0} 次`,
          title: "助手真读进上下文的次数",
        },
        {
          icon: <IconClock size={13} />,
          text: skill.last_used_at ? fmt.relative(skill.last_used_at) : "还没人读过",
          title: "最后一次被读进上下文",
        },
        ...(files.length > 0
          ? [{ icon: <IconFile size={13} />, text: `${files.length} 个附件`, title: "附件" }]
          : []),
        ...(typeof skill.source?.repo === "string" && skill.source.repo
          ? [
              {
                icon: <IconBox size={13} />,
                text: String(skill.source.repo),
                title: "所属仓库",
              },
            ]
          : []),
        ...(typeof skill.source?.ref === "string" && String(skill.source.ref) !== "HEAD"
          ? [{ icon: <IconChevronRight size={13} />, text: String(skill.source.ref), title: "分支 / 版本" }]
          : []),
        ...(skill.location
          ? [
              {
                icon: <IconFile size={13} />,
                text: "文件位置",
                title: String(skill.location),
              },
            ]
          : []),
        ...(typeof skill.source?.url === "string"
          ? [
              {
                icon: <IconLink size={13} />,
                text: String(skill.source.repo ?? "来源"),
                title: String(skill.source.url),
                href: String(skill.source.url),
              },
            ]
          : []),
      ]}
      actions={
        <>
          <button className="btn btn-primary btn-sm" onClick={onEdit}>
            <IconPencil size={14} />
            编辑内容
          </button>
          {onUpdate && (
            <button className="btn btn-sm" disabled={updating} onClick={onUpdate}>
              <IconRefresh size={14} />
              {updating ? "更新中…" : "更新"}
            </button>
          )}
          <button
            className="btn btn-sm"
            title={skill.pinned ? "取消固定，允许自动整理" : "固定：自动整理不碰它"}
            onClick={onPin}
          >
            <IconPin size={14} />
            {skill.pinned ? "取消固定" : "固定"}
          </button>
          {archived ? (
            <button className="btn btn-sm" onClick={onRestore}>
              <IconRefresh size={14} />
              恢复
            </button>
          ) : (
            <button className="btn btn-sm" title="从助手撤下，库里还有" onClick={onArchive}>
              <IconArchive size={14} />
              归档
            </button>
          )}
          <button className="btn btn-sm ml-auto" style={{ color: "var(--color-err)" }} onClick={onRemove}>
            <IconTrash size={14} />
            删除
          </button>
        </>
      }
      onClose={onClose}
    >
      {/* 文件位置：以前只写在 title 里，触屏根本看不到；这里直接显示路径 + 一键复制 */}
      {skill.location && (
        <div className="mb-3 rounded-[var(--radius-md)] px-2.5 py-2" style={{ background: "var(--surface-2)" }}>
          <div className="mb-1 text-[11px]" style={{ color: "var(--color-text-3)" }}>文件位置</div>
          <div className="flex items-center gap-2">
            <span className="mono min-w-0 flex-1 truncate text-[11.5px]" style={{ color: "var(--color-text-2)" }} title={skill.location}>
              {skill.location}
            </span>
            <button
              type="button"
              className="btn btn-sm shrink-0"
              onClick={() => void copyText(String(skill.location))}
            >
              复制
            </button>
          </div>
        </div>
      )}

      {/* 附件清单：光写"288 个附件"等于没说 —— 要能看到有哪些文件、多大，
          点一下就地预览（正文按需拉，不整包背下来） */}
      <SkillFiles skillId={skill.id} files={skill.files ?? {}} sizes={(skill as unknown as { file_sizes?: Record<string, number> }).file_sizes ?? {}} />

      {/* 谁在用：技能"装了但没人挂"和"正在被三个助手用"是两种状态，
          页面上必须一眼能分出来，不用去助手页一个个翻 */}
      <div className="mb-3">
        <div className="mb-1 text-[11.5px]" style={{ color: "var(--color-text-3)" }}>
          {agents === undefined
            ? "读取使用情况…"
            : agents.length === 0
              ? "还没有助手挂这个技能"
              : `被 ${agents.length} 个助手使用`}
        </div>
        {agents && agents.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {agents.map((a) => (
              <a
                key={a.id}
                href={`/agents/detail?id=${a.id}`}
                className="inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[11.5px] transition-colors hover:bg-[var(--bg-selected)]"
                style={{
                  background: "var(--bg-hover)",
                  color: a.enabled ? "var(--color-text-2)" : "var(--color-text-3)",
                }}
                title={a.enabled ? `打开「${a.name}」的配置` : "这个助手已停用"}
              >
                {a.name}
                {!a.enabled && <span style={{ opacity: 0.75 }}>· 已停用</span>}
              </a>
            ))}
          </div>
        )}
      </div>
      {children}
    </DetailPanel>
  );
}

/** 附件清单 + 单文件预览；正文按需拉（详情接口只给名单和体积）。 */
function SkillFiles({
  skillId,
  files,
  sizes,
}: {
  skillId: string;
  files: Record<string, string>;
  sizes: Record<string, number>;
}) {
  const names = Object.keys(files).sort();
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [body, setBody] = useState<{ path: string; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (names.length === 0) {
    return (
      <p className="mb-3 text-[11.5px]" style={{ color: "var(--color-text-3)" }}>
        这个技能只有 SKILL.md，没有额外附件。
      </p>
    );
  }
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  const shown = all ? names : names.slice(0, 8);

  const preview = async (path: string) => {
    if (open === path) {
      setOpen(null);
      setBody(null);
      return;
    }
    setOpen(path);
    setBody(null);
    setErr(null);
    try {
      const r = await api.skillFile(skillId, path);
      setBody({ path, text: r.content });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center gap-2 text-[11.5px]" style={{ color: "var(--color-text-3)" }}>
        <span>
          附件 {names.length} 个{total > 0 ? ` · ${(total / 1024).toFixed(0)}KB` : ""}
        </span>
        {names.length > 8 && (
          <button className="underline underline-offset-2" onClick={() => setAll((v) => !v)}>
            {all ? "收起" : `展开全部`}
          </button>
        )}
      </div>
      <div className="space-y-0.5">
        {shown.map((n) => (
          <div key={n}>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-[var(--radius-xs)] px-1.5 py-1 text-left transition-colors hover:bg-[var(--bg-selected)]"
              onClick={() => void preview(n)}
              title={n}
            >
              <span className="mono min-w-0 flex-1 truncate text-[11.5px]" style={{ color: "var(--color-text-2)" }}>
                {n}
              </span>
              {sizes[n] ? (
                <span className="shrink-0 text-[10.5px] tabular-nums" style={{ color: "var(--color-text-3)" }}>
                  {sizes[n] > 1024 ? `${(sizes[n] / 1024).toFixed(1)}KB` : `${sizes[n]}B`}
                </span>
              ) : null}
              <span className="shrink-0 text-[10.5px]" style={{ color: "var(--color-text-3)" }}>
                {open === n ? "收起" : "预览"}
              </span>
            </button>
            {open === n && (
              <pre
                className="mono mt-1 max-h-64 overflow-auto rounded-[var(--radius-sm)] p-2 text-[11px] leading-relaxed"
                style={{ background: "var(--surface-2)", color: "var(--color-text-2)" }}
              >
                {err ? `读取失败：${err}` : body?.path === n ? body.text || "（空文件）" : "读取中…"}
              </pre>
            )}
          </div>
        ))}
      </div>
      {!all && names.length > 8 && (
        <button className="mt-1 text-[11px]" style={{ color: "var(--color-text-3)" }} onClick={() => setAll(true)}>
          还有 {names.length - 8} 个…
        </button>
      )}
    </div>
  );
}
