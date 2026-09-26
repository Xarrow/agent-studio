"use client";

/**
 * 备份与迁移 —— 把你攒出来的东西装进一个文件带走。
 *
 * 产品判断
 * --------
 * · 助手 / 流程 / 单价 / 记忆都是用户自己的资产。能不能**一键拿走**，
 *   是"自用玩具"和"能给别人用"之间的一道门（换机器、给同事一份、出事恢复，全靠它）。
 * · 导出包**不含任何密钥**：密钥属于"环境"，换台机器该重新填 ——
 *   跟着数据文件到处飞的 key 是安全事故，不是方便。界面上必须写清楚。
 * · 导入**只新增、不覆盖**：别人的包导进来，不该动到你现有的任何东西。
 *   所以导入不需要"确定吗"的吓人确认 —— 它本来就破坏不了东西；
 *   但结果要**如实**展示（哪些工具没接上、哪个节点找不到助手）。
 */

import { useRef, useState } from "react";

import { api } from "@/lib/api";
import { useFeedback } from "@/components/ui/feedback";

type ImportResult = {
  ok: boolean;
  detail: string;
  agents: { id: string; name: string; name_collision?: boolean; credential_reset?: boolean }[];
  workflows: { id: string; name: string }[];
  memories: number;
  prices: number;
  missing_tools: string[];
  missing_skills: string[];
  unfixed_nodes: string[];
};

export function BackupRestore() {
  const fb = useFeedback();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const doExport = async () => {
    setBusy(true);
    try {
      const bundle = await api.exportBundle();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      a.href = url;
      a.download = `agent-studio-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      fb.success(
        `已导出 ${bundle.agents.length} 个助手、${bundle.workflows.length} 份流程`,
        "文件里不含密钥 —— 换机器后请在「LLM 配置」重新选凭据",
      );
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
      const res = (await api.importBundle(bundle)) as ImportResult;
      setResult(res);
      if (!res.ok) {
        fb.error("这不是可导入的导出包", res.detail);
      } else {
        fb.success(
          `已导入 ${res.agents.length} 个助手、${res.workflows.length} 份流程`,
          res.agents.length ? "原有数据没有被改动（导入只新增）" : "",
        );
      }
    } catch (e) {
      fb.error("导入失败", e instanceof Error ? e.message : "文件不是有效的 JSON");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <section className="card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-[14px] font-medium">备份与迁移</h2>
        <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
          把助手、流程、单价、记忆装进一个 JSON 文件；导入只新增、不覆盖现有数据
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void doExport()}
            className="rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-50"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-fg)" }}
            title="导出一个 JSON 文件（不含密钥）"
          >
            导出
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="rounded-[8px] border px-3 py-1.5 text-[12.5px] disabled:opacity-50"
            style={{ borderColor: "var(--color-border)" }}
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

      <ul className="space-y-1 text-[12.5px] leading-relaxed" style={{ color: "var(--color-muted)" }}>
        <li>
          <b>不含密钥</b>：导出包里没有 LLM key / 访问口令 —— 那些属于"环境"，
          换机器后请在「LLM 配置」里重新选一次凭据。
        </li>
        <li>
          <b>导入只新增</b>：助手会建成新的（流程节点自动指向新助手，工具/Skill 按名字接回来），
          你现有的东西一个都不会被改。
        </li>
      </ul>

      {result && (
        <div
          className="mt-3 rounded-[8px] border px-3 py-2 text-[12.5px]"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
        >
          <div>
            导入结果：助手 <b>{result.agents.length}</b> · 流程 <b>{result.workflows.length}</b> ·
            记忆 <b>{result.memories}</b> · 单价 <b>{result.prices}</b>
          </div>
          {result.agents.length > 0 && (
            <div className="mt-1" style={{ color: "var(--color-muted)" }}>
              {result.agents.map((a) => a.name).join("、")}
            </div>
          )}
          {result.missing_tools.length > 0 && (
            <div className="mt-1" style={{ color: "var(--color-warn)" }}>
              ⚠ 这些工具本机没有，没接上：{result.missing_tools.join("、")}
            </div>
          )}
          {result.missing_skills.length > 0 && (
            <div className="mt-1" style={{ color: "var(--color-warn)" }}>
              ⚠ 这些 Skill 本机没有，没接上：{result.missing_skills.join("、")}
            </div>
          )}
          {result.unfixed_nodes.length > 0 && (
            <div className="mt-1" style={{ color: "var(--color-warn)" }}>
              ⚠ 这些流程节点没找到对应助手（保留原样，请人工修）：{result.unfixed_nodes.join("、")}
            </div>
          )}
          {result.detail && (
            <div className="mt-1" style={{ color: "var(--color-muted)" }}>
              {result.detail}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
