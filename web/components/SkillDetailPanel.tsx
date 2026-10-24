"use client";

/**
 * Skill 详情面板 —— 点列表里的一行就打开。
 *
 * 为什么不用 Sheet：
 *   Sheet 是给"输入区旁边的小浮卡"用的（手机从底部升起、桌面右下角 360~620）。
 *   管理一个对象需要的是**一块完整的地方**：SKILL.md 是 Markdown 长文，
 *   塞进浮卡就变成一列窄栏 + 一堆滚动条，看起来像在侧边偷看。
 *   这里做成**桌面右侧全高抽屉（720）/ 手机全屏**，左边只留一道蒙层。
 *
 * 结构（从上到下 = 从"这是谁"到"它写了什么"）：
 *   身份区：大图标 + 名字 + 来源 · 状态 · 固定     ← 带一层很淡的渐变，和正文分开
 *   动作条：编辑（主）· 更新 · 固定 · 归档 · 删除（红，靠右）
 *   事实行：用过几次 / 最后读过 / 附件数           ← 带小图标，不靠「·」硬分
 *   正文：Markdown 渲染（不是 <pre> 裸文本）
 */

import { useEffect } from "react";
import { createPortal } from "react-dom";
import Markdown from "@/components/Markdown";
import { fmt } from "@/lib/api";
import {
  IconArchive,
  IconBox,
  IconChevronRight,
  IconClock,
  IconCopy,
  IconFile,
  IconLink,
  IconPencil,
  IconPin,
  IconRefresh,
  IconSkill,
  IconSpark,
  IconTrash,
} from "@/components/ui/icons";
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  const g = glyphFor(skill.source);
  const archived = (skill.state ?? "active") === "archived";
  const body = stripFrontmatter(skill.content ?? "");
  const lines = body ? body.split("\n").length : 0;

  return createPortal(
    <>
      <div
        className="panel-veil-in fixed inset-0 z-[69]"
        style={{ background: "rgba(15,23,42,.36)", backdropFilter: "blur(1.5px)" }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-label={skill.name}
        aria-modal="true"
        className="panel-slide-in fixed right-0 top-0 z-[70] flex h-[100dvh] w-full flex-col overflow-hidden md:w-[720px] md:rounded-l-[16px] md:shadow-[-24px_0_60px_-24px_rgba(15,23,42,.4)]"
        style={{ background: "var(--color-surface)", borderLeft: "1px solid var(--color-border)" }}
      >
        {/* ── 身份区：大图标当"头像"，一眼认出这是哪来的技能 ── */}
        <div
          className="shrink-0 px-4 pb-3 pt-[max(14px,env(safe-area-inset-top))] md:px-5"
          style={{
            background:
              "linear-gradient(180deg, color-mix(in srgb, var(--color-accent) 5%, transparent), transparent)",
          }}
        >
          <div className="flex items-start gap-3">
            <span
              className="grid h-11 w-11 shrink-0 place-items-center rounded-[12px]"
              style={{ background: g.bg, color: g.fg }}
            >
              <g.Ico size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h2 className="truncate text-[17px] font-semibold tracking-tight">{skill.name}</h2>
                {skill.pinned && (
                  <span title="已固定：自动整理不会动它" style={{ color: "var(--color-accent)" }}>
                    <IconPin size={14} />
                  </span>
                )}
              </div>
              <div
                className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]"
                style={{ color: "var(--color-muted)" }}
              >
                <span>{sourceText}</span>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1" style={{ color: stateColor }}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: stateColor }} />
                  {stateText}
                </span>
              </div>
            </div>
            <button
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
              title="关闭（Esc）"
              aria-label="关闭"
              onClick={onClose}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* ── 动作条：编辑是唯一主操作（管理场景里九成是来改内容的）── */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
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
            <button
              className="btn btn-sm ml-auto"
              style={{ color: "var(--color-err)" }}
              onClick={onRemove}
            >
              <IconTrash size={14} />
              删除
            </button>
          </div>
        </div>

        {/* ── 事实行：三个小图标 + 三个数，比三格 KV 省一半高度 ── */}
        <div
          className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-y px-4 py-2 text-[12px] md:px-5"
          style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}
        >
          <span className="inline-flex items-center gap-1.5" title="助手真读进上下文的次数">
            <IconChevronRight size={13} />
            用过 {skill.use_count ?? 0} 次
          </span>
          <span className="inline-flex items-center gap-1.5" title="最后一次被读进上下文">
            <IconClock size={13} />
            {skill.last_used_at ? fmt.relative(skill.last_used_at) : "还没人读过"}
          </span>
          {Object.keys(skill.files ?? {}).length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <IconFile size={13} />
              {Object.keys(skill.files).length} 个附件
            </span>
          )}
          {typeof skill.source?.url === "string" && (
            <a
              href={String(skill.source.url)}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex max-w-[45%] items-center gap-1.5 truncate hover:underline"
              style={{ color: "var(--color-accent)" }}
              title={String(skill.source.repo ?? skill.source.url)}
            >
              <IconLink size={13} />
              <span className="truncate">{String(skill.source.repo ?? "来源")}</span>
            </a>
          )}
        </div>

        {/* ── 正文区：自己滚，头不动 ── */}
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 md:px-5">
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}
