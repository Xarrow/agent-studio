"use client";

/**
 * 「复制到…」—— 把一条记忆复制一份，绑定到别的助手（或复制成全局记忆）。
 *
 * 为什么是「复制」而不是「共享」
 * -----------------------------
 * 平台刻意保持「一条记忆只属于一个 Agent」。需要多个助手用到同一条内容时，
 * 复制一份再换绑，而不是让它同时属于多个 Agent。这样：
 *   · 任何一方后续修改都不会牵动另一方（不会出现"改了一处、好几个助手行为变了"）
 *   · 记忆的来龙去脉清楚 —— 谁的就是谁的
 * 代价是需要手动同步两份内容，对"设定类"记忆（风格、称呼、口径）完全可接受。
 */

import { useState } from "react";
import { api } from "@/lib/api";
import type { Agent, Memory } from "@/lib/types";
import { useFeedback } from "./ui/feedback";

const KIND_LABEL: Record<string, string> = {
  fact: "事实",
  preference: "偏好",
  summary: "结论",
  instruction: "要求",
};

export function MemoryCopyDialog({
  memory,
  agents,
  onClose,
  onCopied,
}: {
  memory: Memory;
  agents: Agent[];
  onClose: () => void;
  onCopied: () => void;
}) {
  const fb = useFeedback();
  // 默认选"全局"，因为那是最常见的诉求（让所有助手都知道）
  const [target, setTarget] = useState<string>("__global__");
  const [content, setContent] = useState(memory.content);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (!content.trim()) {
      setErr("内容不能为空");
      return;
    }
    setBusy(true);
    try {
      const isGlobal = target === "__global__";
      const r = await api.duplicateMemory(memory.id, {
        agent_id: isGlobal ? null : target,
        scope: isGlobal ? "global" : "agent",
        content: content.trim() === memory.content ? undefined : content.trim(),
      });
      const where = isGlobal
        ? "所有助手共用"
        : (agents.find((a) => a.id === target)?.name ?? "目标助手");
      fb.success("已复制", `副本已绑定到「${where}」，原件保持不动。`);
      void r;
      onCopied();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const ownerLabel = memory.agent_name
    ? `「${memory.agent_name}」的记忆`
    : "所有助手共用的记忆";

  return (
    <div className="fixed inset-0 bg-[var(--color-overlay)] flex items-center justify-center p-4 z-50 overflow-y-auto">
      <div className="card w-full max-w-lg p-5 my-8">
        <h2 className="text-[16px] font-medium mb-1">复制这条记忆</h2>
        <p className="text-[12px] text-[var(--color-muted)] mb-4">
          原件（{ownerLabel}）保持不动，复制出的新记忆单独绑定到你选的去处。
        </p>

        <div className="space-y-3.5">
          <div>
            <label className="label">
              内容
              <span className="text-[11px] text-[var(--color-muted)] font-normal ml-2">
                {KIND_LABEL[memory.kind] ?? memory.kind} · 可以直接改
              </span>
            </label>
            <textarea
              className="input"
              rows={3}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </div>

          <div>
            <label className="label">复制到</label>
            <div className="space-y-1.5 max-h-56 overflow-y-auto">
              <button
                onClick={() => setTarget("__global__")}
                className="w-full text-left rounded-md p-2.5 transition-colors"
                style={{
                  background:
                    target === "__global__"
                      ? "color-mix(in srgb, var(--color-accent) 10%, transparent)"
                      : "var(--color-surface-2)",
                  border: `1px solid ${target === "__global__" ? "var(--color-accent)" : "var(--color-border)"}`,
                }}
              >
                <div
                  className="text-[13px]"
                  style={{
                    color: target === "__global__" ? "var(--color-accent)" : "var(--color-text)",
                  }}
                >
                  所有助手共用
                </div>
                <div className="text-[11.5px] text-[var(--color-muted)]">
                  每个助手都会带上这条（改一处对所有人生效）
                </div>
              </button>

              {agents.map((a) => {
                const on = target === a.id;
                const isOwner = a.id === memory.agent_id;
                return (
                  <button
                    key={a.id}
                    onClick={() => setTarget(a.id)}
                    className="w-full text-left rounded-md p-2.5 transition-colors"
                    style={{
                      background: on
                        ? "color-mix(in srgb, var(--color-accent) 10%, transparent)"
                        : "var(--color-surface-2)",
                      border: `1px solid ${on ? "var(--color-accent)" : "var(--color-border)"}`,
                    }}
                  >
                    <div
                      className="text-[13px] flex items-center gap-2"
                      style={{ color: on ? "var(--color-accent)" : "var(--color-text)" }}
                    >
                      {a.name}
                      {isOwner && (
                        <span className="text-[10.5px] text-[var(--color-muted)]">
                          （原件所属）
                        </span>
                      )}
                    </div>
                    {a.description && (
                      <div className="text-[11.5px] text-[var(--color-muted)] truncate">
                        {a.description}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {err && <div className="text-[12.5px] text-[var(--color-err)]">{err}</div>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? "复制中…" : "复制"}
          </button>
        </div>
      </div>
    </div>
  );
}
