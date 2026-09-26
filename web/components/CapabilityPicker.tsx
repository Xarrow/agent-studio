"use client";

/**
 * CapabilityPicker —— 助手能力的统一选择器：工具（内置/HTTP/代码/分派）+ MCP + Skills。
 *
 * 为什么合一（商业产品视角）：
 * 原来是三个 Fold、三套列表交互，但用户的心智是**一件事**：
 * 「这个助手会什么」。AgentScope 的 Toolkit 也是同一只手管 tool/MCP/Skill。
 *
 * 交互（守「操作更少、看到更多」）：
 * · 一行搜索框过滤（平台工具/Skill 多了以后靠它，不靠翻页）；
 * · 每项一行：勾选 + 名字 + 分类标签 + 一句描述 —— 描述常驻可见（不 hover）；
 * · 已选的排最前（打开就看到这个助手现在有什么，不用找）；
 * · 「只看已选 / 显示全部」一键切换；无 JS 弹窗、无跳页；
 * · 触屏一等公民：整行可点、无 hover-only 控件。
 */

import { useMemo, useState } from "react";
import type { McpServer, Skill, Tool } from "@/lib/types";

export interface CapabilityItem {
  key: string;
  /** 勾选状态由哪一份数据决定 */
  group: "tool" | "mcp" | "skill";
  name: string;
  tag: string;
  description: string;
  /** 平台不可用（如 Linux 上的 PowerShell）→ 置灰禁选 */
  disabled?: boolean;
  disabledNote?: string;
  /** 危险能力（写/执行）标黄，用户知情 */
  warn?: string;
  on: boolean;
  toggle: () => void;
}

export function CapabilityPicker({
  tools,
  skills,
  mcpServers,
  selectedToolIds,
  selectedSkillIds,
  selectedMcpIds,
  onToggleTool,
  onToggleSkill,
  onToggleMcp,
}: {
  tools: Tool[];
  skills: Skill[];
  mcpServers: McpServer[];
  selectedToolIds: string[];
  selectedSkillIds: string[];
  selectedMcpIds: string[];
  onToggleTool: (id: string) => void;
  onToggleSkill: (id: string) => void;
  onToggleMcp: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);

  const items: CapabilityItem[] = useMemo(() => {
    const t: CapabilityItem[] = tools.map((x) => ({
      key: `t:${x.id}`,
      group: "tool",
      name: x.name,
      tag: x.kind,
      description: x.description ?? "",
      disabled: x.flags?.platform_ok === false,
      disabledNote: typeof x.flags?.platform_note === "string" ? x.flags.platform_note : undefined,
      warn: x.flags?.dangerous ? "写/执行" : undefined,
      on: selectedToolIds.includes(x.id),
      toggle: () => onToggleTool(x.id),
    }));
    const m: CapabilityItem[] = mcpServers.map((x) => ({
      key: `m:${x.id}`,
      group: "mcp",
      name: x.name,
      tag: "MCP",
      description: !x.enabled
        ? "已停用（挂上也不会加载）"
        : x.last_probe_ok
          ? `外部工具服务 · ${x.tools.length} 个工具`
          : "还没探测成功，去工具页点「重新探测」",
      disabled: !x.enabled,
      on: selectedMcpIds.includes(x.id),
      toggle: () => onToggleMcp(x.id),
    }));
    const s: CapabilityItem[] = skills.map((x) => ({
      key: `s:${x.id}`,
      group: "skill",
      name: x.name,
      tag: "Skill",
      description: x.description ?? "",
      on: selectedSkillIds.includes(x.id),
      toggle: () => onToggleSkill(x.id),
    }));
    return [...t, ...m, ...s];
  }, [tools, skills, mcpServers, selectedToolIds, selectedSkillIds, selectedMcpIds, onToggleTool, onToggleSkill, onToggleMcp]);

  const kw = q.trim().toLowerCase();
  const filtered = items.filter((i) => {
    if (kw && !i.name.toLowerCase().includes(kw) && !i.description.toLowerCase().includes(kw)) return false;
    if (!showAll && !kw) return i.on;
    return true;
  });

  const selectedCount = items.filter((i) => i.on).length;

  return (
    <div>
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <input
          className="input flex-1 min-w-[180px] text-[12.5px]"
          value={q}
          placeholder="搜工具 / MCP / Skill 的名字或说明…"
          onChange={(e) => setQ(e.target.value)}
        />
        <button
          type="button"
          className="btn text-[12px]"
          onClick={() => {
            setShowAll((v) => !v);
            setQ("");
          }}
        >
          {showAll || kw ? `只看已选（${selectedCount}）` : `显示全部 ${items.length} 项`}
        </button>
      </div>

      {filtered.length === 0 ? (
        <p className="px-1 py-2 text-[12.5px]" style={{ color: "var(--color-muted)" }}>
          {kw ? `没有匹配「${q}」的能力` : "还没勾选任何能力 —— 点右上「显示全部」挑几个。"}
        </p>
      ) : (
        <div className="flex flex-col gap-1 max-h-[340px] overflow-auto">
          {filtered.map((i) => (
            <label
              key={i.key}
              title={i.disabled ? i.disabledNote ?? undefined : undefined}
              className={`flex items-start gap-2.5 p-2 rounded-md ${
                i.disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:bg-[var(--color-surface-2)]"
              }`}
              style={i.on ? { background: "color-mix(in srgb, var(--color-accent) 5%, transparent)" } : undefined}
            >
              <input
                type="checkbox"
                checked={i.on}
                disabled={i.disabled}
                onChange={i.toggle}
                className="mt-0.5 accent-[var(--color-accent)]"
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className={`text-[13px] mono ${i.disabled ? "line-through" : ""}`}>{i.name}</span>
                  <span className="tag">{i.tag}</span>
                  {i.warn && (
                    <span className="tag" style={{ color: "var(--color-warn)" }}>
                      {i.warn}
                    </span>
                  )}
                  {i.disabled && (
                    <span className="tag" style={{ color: "var(--color-err)" }}>
                      当前平台不可用
                    </span>
                  )}
                </span>
                {i.description && (
                  <span className="block text-[11.5px] mt-0.5" style={{ color: "var(--color-muted)" }}>
                    {i.description}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
