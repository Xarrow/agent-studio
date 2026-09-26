"use client";

/**
 * 试运行的**参数表单** —— 从工具签名（探测到的 args / input_schema）自动生成，
 * 每个参数一行：名字 + 类型输入框 + 必填标 + 描述。
 *
 * 为什么替代原来的 fb.prompt 手写 JSON：
 * 签名明明已经探测到了，还让用户照着提示手打 `{"file_path": "demo.txt"}` ✗
 * —— 打错一个引号就 JSON 不合法；类型是数字时还得记得别加引号。
 * AgentScope Toolkit 的思想：签名即 schema，绝不让用户手抄第二份。
 *
 * 高级用户仍然可以切到 JSON 模式（一次切换，不是删除能力）。
 */

import { useEffect, useState } from "react";
import type { Tool } from "@/lib/types";
import { argsToFields, fieldToValue, schemaToFields, valueToField, type FieldSpec } from "@/lib/tool-params";
import { useFeedback } from "@/components/ui/feedback";
import { api, fmt } from "@/lib/api";

/** 这个工具的表单字段：优先探测签名（builtin），退回 input_schema（http/code） */
export function fieldsOfTool(t: Tool): FieldSpec[] {
  const fromArgs = argsToFields(
    t.impl?.args as { name: string; required?: boolean; type?: string }[] | null | undefined,
  );
  return fromArgs.length > 0 ? fromArgs : schemaToFields(t.input_schema);
}

export function ToolTestForm({ tool, onDone }: { tool: Tool; onDone: (out: string) => void }) {
  const fb = useFeedback();
  const fields = fieldsOfTool(tool);
  const [values, setValues] = useState<Record<string, string>>({});
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("{}");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setValues({});
    setJsonText("{}");
    setJsonMode(false);
  }, [tool.id]);

  const submit = async () => {
    let args: Record<string, unknown>;
    if (jsonMode) {
      try {
        args = JSON.parse(jsonText || "{}");
      } catch (e) {
        fb.error("JSON 不合法", e instanceof Error ? e.message : String(e));
        return;
      }
    } else {
      args = {};
      for (const f of fields) {
        const raw = values[f.name] ?? "";
        if (f.required && !raw.trim()) {
          fb.warn(`「${f.name}」是必填的`, f.description || "填上再试");
          return;
        }
        const v = fieldToValue(f, raw);
        if (v !== undefined) args[f.name] = v;
      }
    }
    setBusy(true);
    onDone("测试中…");
    try {
      const r = await api.testTool(tool.id, args);
      if (r.skipped) onDone(`⏸ 已跳过\n${r.reason ?? ""}`);
      else if (r.ok)
        onDone(`✓ ${r.note ?? "正常"} · ${fmt.ms(r.duration_ms)} · ${fmt.bytes(r.result_size)}\n${r.result_preview ?? ""}`);
      else onDone(`✗ ${r.error ?? "失败"}${r.hint ? `\n${r.hint}` : ""}`);
    } catch (e) {
      onDone(`✗ ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  if (fields.length === 0) {
    // 没有参数签名（如无参工具）：直接跑，不弹任何表单
    return (
      <div className="flex items-center gap-2 pt-2">
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void submit()}>
          {busy ? "测试中…" : "试运行（无参数）"}
        </button>
        <span className="text-[11.5px]" style={{ color: "var(--color-muted)" }}>
          这个工具不需要参数
        </span>
      </div>
    );
  }

  return (
    <div className="mt-2.5 border-t pt-2.5" style={{ borderColor: "var(--color-border)" }}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12px] font-medium">试运行参数</span>
        <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>
          按签名自动生成 —— 不用写 JSON
        </span>
        <button
          type="button"
          className="ml-auto text-[11.5px] underline"
          style={{ color: "var(--color-muted)" }}
          onClick={() => setJsonMode((v) => !v)}
        >
          {jsonMode ? "用表单填" : "JSON 模式"}
        </button>
      </div>

      {jsonMode ? (
        <textarea
          className="input mono w-full"
          rows={4}
          value={jsonText}
          spellCheck={false}
          onChange={(e) => setJsonText(e.target.value)}
          placeholder='{ "file_path": "demo.txt" }'
        />
      ) : (
        <div className="flex flex-col gap-1.5">
          {fields.map((f) => (
            <label key={f.name} className="flex flex-wrap items-center gap-2">
              <span className="w-[130px] shrink-0 text-[12px] mono truncate" title={f.description}>
                {f.name}
                {f.required && <span style={{ color: "var(--color-err)" }}> *</span>}
                <span className="ml-1 text-[10.5px]" style={{ color: "var(--color-muted)" }}>
                  {f.type}
                </span>
              </span>
              {f.enumValues ? (
                <select
                  className="input flex-1 min-w-0 text-[12.5px]"
                  value={values[f.name] ?? ""}
                  onChange={(e) => setValues((p) => ({ ...p, [f.name]: e.target.value }))}
                >
                  <option value="">— 选 {f.name} —</option>
                  {f.enumValues.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : f.type === "boolean" ? (
                <select
                  className="input flex-1 min-w-0 text-[12.5px]"
                  value={values[f.name] ?? ""}
                  onChange={(e) => setValues((p) => ({ ...p, [f.name]: e.target.value }))}
                >
                  <option value="">— 未设置 —</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input
                  className="input mono flex-1 min-w-0 text-[12.5px]"
                  type={f.type === "number" ? "number" : "text"}
                  value={values[f.name] ?? ""}
                  placeholder={f.description || (f.required ? "必填" : "可空")}
                  onChange={(e) => setValues((p) => ({ ...p, [f.name]: e.target.value }))}
                />
              )}
            </label>
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void submit()}>
          {busy ? "测试中…" : "试运行"}
        </button>
        <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>
          只读工具会真实执行（限制在工作目录内）；写/执行类工具会被跳过。
        </span>
      </div>
    </div>
  );
}
