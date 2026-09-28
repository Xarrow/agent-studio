"use client";

/**
 * 备份与迁移 —— 「各个功能配置」都能单独导出/导入，也能一键全量。
 *
 * 产品判断
 * --------
 * · 助手 / 工具 / 技能 / 流程 / 记忆策略 / 单价 / 记忆 都是用户自己攒出来的资产。
 *   能不能**按功能挑着拿走**（只给同事一份助手、只备份流程），是从"能用"到"能交付"的门槛。
 * · 导出包**不含任何密钥**：LLM key、口令、工具请求头里的 token 都不进包 ——
 *   跟随数据文件到处飞的 key 是事故，不是方便。界面上必须写清楚，并且要告诉用户
 *   "这次包里有哪些配置需要你重新填"。
 * · 导入**只新增、不覆盖**：同名工具/技能不重复建，已有记忆策略的助手保留你自己的调参。
 *   所以导入不需要"确定吗"的吓人确认 —— 它本来就破坏不了东西；但结果要如实展示
 *   （哪些没接上、哪些跳过了、哪些要重填密钥）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import type { ExportSection } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";

type ImportResult = {
  ok: boolean;
  detail: string;
  agents: { id: string; name: string; name_collision?: boolean; credential_reset?: boolean }[];
  workflows: { id: string; name: string }[];
  memories: number;
  prices: number;
  tools: string[];
  skills: string[];
  policies: string[];
  skipped: string[];
  credentials_to_fill: string[];
  missing_tools: string[];
  missing_skills: string[];
  unfixed_nodes: string[];
};

export function BackupRestore() {
  const fb = useFeedback();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [sections, setSections] = useState<ExportSection[] | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const loadSections = useCallback(async () => {
    try {
      setSections((await api.exportSections()).sections);
    } catch {
      /* 读不到就不显示分区，不影响全量导出/导入 */
    }
  }, []);

  useEffect(() => {
    void loadSections();
  }, [loadSections]);

  const saveFile = (bundle: Record<string, unknown>, name: string) => {
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

  const doExport = async (keys?: string[]) => {
    setBusy(true);
    try {
      const bundle = (await api.exportBundle(keys)) as unknown as {
        agents?: unknown[];
        workflows?: unknown[];
        tools?: unknown[];
        skills?: unknown[];
        [k: string]: unknown;
      };
      const label = keys?.length ? keys.join("-") : "全部";
      saveFile(bundle as Record<string, unknown>, `agent-studio-${label}-${stamp()}.json`);
      const bits = [
        bundle.agents ? `${bundle.agents.length} 个助手` : "",
        bundle.workflows ? `${bundle.workflows.length} 份流程` : "",
        bundle.tools ? `${bundle.tools.length} 个自定义工具` : "",
        bundle.skills ? `${bundle.skills.length} 个技能` : "",
      ].filter(Boolean);
      fb.success(`已导出${keys?.length ? `（${label}）` : ""}：${bits.join("、") || "空包"}`, "文件里不含任何密钥");
    } catch (e) {
      fb.error("导出失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doImport = async (file: File) => {
    setBusy(true);
    setResult(null);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text) as Record<string, unknown>;
      const res = (await api.importBundle(bundle)) as unknown as ImportResult;
      setResult(res);
      if (!res.ok) {
        fb.error("这不是可导入的导出包", res.detail);
      } else {
        fb.success(
          `已导入 ${res.agents.length} 个助手、${res.workflows.length} 份流程`,
          res.agents.length ? "原有数据没有被改动（导入只新增）" : "",
        );
        await loadSections();
      }
    } catch (e) {
      fb.error("导入失败", e instanceof Error ? e.message : "文件不是有效的 JSON");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px]" style={{ color: "var(--color-muted)" }}>
          按功能挑着导，或者一键全量；导入只新增、不覆盖现有数据
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void doExport()}
            className="btn btn-primary"
            style={{ color: "var(--color-accent-fg)" }}
            title="导出一个 JSON 文件（不含密钥）"
          >
            全量导出
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="btn"
            title="选择之前导出的 JSON 文件导入"
          >
            导入
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void doImport(f);
            }}
          />
        </div>
      </div>

      {/* 一行一个功能：数量 + 说明 + 单独导出（导入走上面那个"导入"按钮，包里的分区自动识别） */}
      {sections?.length ? (
        <div
          className="divide-y rounded-[8px] border"
          style={{ borderColor: "var(--color-border)" }}
        >
          {sections.map((s) => (
            <div key={s.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <span className="text-[13px] font-medium">{s.label}</span>
              <span className="text-[12px] tabular-nums" style={{ color: "var(--color-muted)" }}>
                {s.count} 条
              </span>
              {!s.importable ? (
                <span
                  className="rounded px-1.5 py-0.5 text-[11px]"
                  style={{
                    background: "color-mix(in srgb, var(--color-warn) 14%, transparent)",
                    color: "var(--color-warn)",
                  }}
                >
                  只导出、不导入
                </span>
              ) : null}
              <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                {/* 备注是纯文本渲染：把 markdown 的加粗标记去掉，别让用户看到 ** 号 */}
                {s.note.replace(/\*\*/g, "")}
              </span>
              <button
                type="button"
                disabled={busy}
                className="btn ml-auto"
                title={`只导出「${s.label}」`}
                onClick={() => void doExport([s.key])}
              >
                导出
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <ul className="space-y-1 text-[12.5px] leading-relaxed" style={{ color: "var(--color-muted)" }}>
        <li>
          <b>不含密钥</b>：LLM key、访问口令、工具请求头里的 token 都不进包 ——
          它们属于"环境"，换机器后请在「LLM 配置」里重新填（导入结果会列出要重填哪些）。
        </li>
        <li>
          <b>导入只新增</b>：助手建成新的（流程节点自动指向新助手，工具/技能按名字接回来），
          同名工具/技能不重复建，已有的记忆策略保留你自己的设置。
        </li>
      </ul>

      {result ? (
        <div
          className="rounded-[8px] border px-3 py-2 text-[12.5px]"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
        >
          <div>
            导入结果：助手 <b>{result.agents.length}</b> · 流程 <b>{result.workflows.length}</b> ·
            自定义工具 <b>{result.tools?.length ?? 0}</b> · 技能 <b>{result.skills?.length ?? 0}</b> ·
            记忆策略 <b>{result.policies?.length ?? 0}</b> · 记忆 <b>{result.memories}</b> · 单价{" "}
            <b>{result.prices}</b>
          </div>
          {result.agents.length > 0 ? (
            <div className="mt-1" style={{ color: "var(--color-muted)" }}>
              {result.agents.map((a) => a.name).join("、")}
            </div>
          ) : null}
          {result.credentials_to_fill?.length ? (
            <div className="mt-1" style={{ color: "var(--color-warn)" }}>
              ⚠ 这些 LLM 配置要在本机重填密钥：{result.credentials_to_fill.join("、")}
            </div>
          ) : null}
          {result.skipped?.length ? (
            <div className="mt-1" style={{ color: "var(--color-muted)" }}>
              跳过（已存在，未改动）：{result.skipped.join("；")}
            </div>
          ) : null}
          {result.missing_tools?.length ? (
            <div className="mt-1" style={{ color: "var(--color-warn)" }}>
              ⚠ 这些工具本机没有，没接上：{result.missing_tools.join("、")}
            </div>
          ) : null}
          {result.missing_skills?.length ? (
            <div className="mt-1" style={{ color: "var(--color-warn)" }}>
              ⚠ 这些技能本机没有，没接上：{result.missing_skills.join("、")}
            </div>
          ) : null}
          {result.unfixed_nodes?.length ? (
            <div className="mt-1" style={{ color: "var(--color-warn)" }}>
              ⚠ 这些流程节点没找到对应助手（保留原样，请人工修）：{result.unfixed_nodes.join("、")}
            </div>
          ) : null}
          {result.detail ? (
            <div className="mt-1" style={{ color: "var(--color-muted)" }}>
              {result.detail}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
