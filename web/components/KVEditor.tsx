"use client";

/**
 * KV 行编辑器 —— headers / cookies / query 这类「键值对清单」的统一编辑件。
 *
 * 为什么独立一个：HTTP 工具弹窗和 MCP 编辑都要编辑键值对，各自手写
 * textarea 解析（`k: v` 每行一条）体验差——删一行要选中整行、键重复不提示、
 * 值里有冒号会被切错。这里改成**一行一对**的真表单行：加/删/清空都直接点，
 * 键重复即时标红，空行不进结果。
 */

import { useState } from "react";

export type KVPair = { k: string; v: string };

export function kvToPairs(obj: Record<string, string> | undefined | null): KVPair[] {
  const out = Object.entries(obj ?? {}).map(([k, v]) => ({ k, v: String(v) }));
  return out.length ? out : [];
}

export function pairsToKV(pairs: KVPair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const k = p.k.trim();
    if (k) out[k] = p.v;
  }
  return out;
}

export function KVEditor({
  pairs,
  onChange,
  keyPlaceholder = "名称",
  valuePlaceholder = "值",
  secret = false,
  addLabel = "+ 添加一项",
}: {
  pairs: KVPair[];
  onChange: (next: KVPair[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** 值打码显示（Cookie/Authorization）——新建时用 password 输入，防旁边人瞄 */
  secret?: boolean;
  addLabel?: string;
}) {
  const dupKeys = new Set<string>();
  const seen = new Set<string>();
  for (const p of pairs) {
    const k = p.k.trim().toLowerCase();
    if (k && seen.has(k)) dupKeys.add(k);
    if (k) seen.add(k);
  }
  const [reveal, setReveal] = useState(false);
  const type = secret && !reveal ? "password" : "text";

  return (
    <div className="flex flex-col gap-1.5">
      {pairs.length === 0 && (
        <p className="text-[12px] text-[var(--color-muted)]">还没有配置项</p>
      )}
      {pairs.map((p, i) => {
        const dup = dupKeys.has(p.k.trim().toLowerCase());
        return (
          <div key={i} className="flex items-center gap-1.5">
            <input
              className={`input mono !w-[38%] min-w-0 ${dup ? "!border-[var(--color-err)]" : ""}`}
              value={p.k}
              placeholder={keyPlaceholder}
              title={dup ? "键重复了" : undefined}
              onChange={(e) => {
                const next = [...pairs];
                next[i] = { ...p, k: e.target.value };
                onChange(next);
              }}
            />
            <input
              className="input mono flex-1 min-w-0"
              type={type}
              value={p.v}
              placeholder={valuePlaceholder}
              onChange={(e) => {
                const next = [...pairs];
                next[i] = { ...p, v: e.target.value };
                onChange(next);
              }}
            />
            <button
              type="button"
              data-tap
              className="btn !min-h-0 !px-2 !py-1 text-[12px] text-[var(--color-err)] shrink-0"
              title="删除这一项"
              onClick={() => onChange(pairs.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-tap
          className="btn !min-h-0 !px-2.5 !py-1 text-[12px] shrink-0"
          onClick={() => onChange([...pairs, { k: "", v: "" }])}
        >
          {addLabel}
        </button>
        {secret && pairs.length > 0 && (
          <button
            type="button"
            data-tap
            className="text-[12px] text-[var(--color-muted)] underline"
            onClick={() => setReveal(!reveal)}
          >
            {reveal ? "隐藏值" : "显示值"}
          </button>
        )}
      </div>
    </div>
  );
}
