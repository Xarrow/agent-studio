"use client";

/**
 * Skill 详情 —— 只是把 DetailPanel 组装起来。
 *
 * 全站管理页（记忆 / 密钥 / 助手 / 远程 Agent / Skill）共用同一个抽屉：
 * 桌面右侧全高 720、手机全屏。差别只在"身份区怎么摆、有哪些动作"，
 * 容器本身不该各写一遍 —— 这里原来有 200 行和 DetailPanel 几乎一样的结构。
 */

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
import { fmt } from "@/lib/api";
import type { Skill } from "@/lib/types";

/** 来源 → 图标 + 两个色（底 / 线） */
export function glyphFor(source: unknown) {
  const type = String((source as Record<string, unknown> | undefined)?.type ?? "").toLowerCase();
  if (type === "agent")
    return { Ico: IconSpark, bg: "color-mix(in srgb, #8b5cf6 14%, transparent)", fg: "#7c3aed" };
  if (type === "repo" || type === "git")
    return { Ico: IconBox, bg: "color-mix(in srgb, #2563eb 12%, transparent)", fg: "#2563eb" };
  if (type === "url")
    return { Ico: IconLink, bg: "color-mix(in srgb, #0891b2 12%, transparent)", fg: "#0891b2" };
  if (type === "import" || type === "zip")
    return { Ico: IconArchive, bg: "color-mix(in srgb, #b45309 12%, transparent)", fg: "#b45309" };
  return { Ico: IconSkill, bg: "color-mix(in srgb, #64748b 12%, transparent)", fg: "#64748b" };
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
      {children}
    </DetailPanel>
  );
}
