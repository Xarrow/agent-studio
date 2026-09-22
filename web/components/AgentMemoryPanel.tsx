"use client";

/**
 * Agent 的「记忆」面板
 *
 * 设计原则：**UI 只暴露用户概念，实现细节全部折叠。**
 *
 * 之前的问题：把数据库控制台（scope 三档 / 召回策略 / 注入预算 / 中间表绑定）
 * 直接端到端暴露给用户，结果用户问"怎么和 Agent 绑定" —— 那是设计失败的信号。
 *
 * 现在的映射：
 *   召回开关 + 自动沉淀开关  →  一个「记忆」总开关
 *   scope: agent | global    →  「交给谁用」两个自然语言选项（在记忆页里）
 *   中间表绑定               →  已移除（跨 Agent 借用属于进阶能力，界面上不再暴露）
 *   top_k/注入预算/压缩阈值   →  「高级设置」（默认收起，全部换成人话）
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Memory, MemoryPolicy } from "@/lib/types";
import { useFeedback } from "./ui/feedback";

const KIND_LABEL: Record<string, string> = {
  fact: "事实",
  preference: "偏好",
  summary: "结论",
  instruction: "要求",
};

export function AgentMemoryPanel({ agentId }: { agentId: string }) {
  const fb = useFeedback();
  const [policy, setPolicy] = useState<MemoryPolicy | null>(null);
  const [usable, setUsable] = useState<Memory[]>([]);
  const [bindings, setBindings] = useState<Set<string>>(new Set());
  const [pool, setPool] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, u, b, all] = await Promise.all([
        api.agentMemoryPolicy(agentId),
        api.agentMemories(agentId),
        api.agentMemoryBindings(agentId),
        api.memories({ status: "active" }),
      ]);
      setPolicy(p);
      setUsable(u);
      setBindings(new Set(b.memory_ids));
      setPool(all);
    } catch (e) {
      fb.error("加载记忆配置失败", e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [agentId, fb]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (p: Partial<MemoryPolicy>) => {
    setBusy(true);
    try {
      setPolicy(await api.updateAgentMemoryPolicy(agentId, p));
      fb.success("已保存");
    } catch (e) {
      fb.error("保存失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading || !policy) {
    return <div className="card p-6 text-[13px] text-[var(--color-muted)]">加载中…</div>;
  }

  const memoryOn = policy.recall_enabled;
  return (
    <div className="space-y-4 max-w-3xl">
      {/* ── 总开关 ─────────────────────────────────────────────── */}
      <section className="card p-4">
        <div className="flex items-start gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-medium">记忆</h2>
            <p className="text-[12px] text-[var(--color-muted)] mt-1">
              打开后，这个 Agent 会在每次对话前自动回忆起相关的历史信息，
              并在对话结束后自动总结值得记住的内容。
            </p>
          </div>
          <button
            role="switch"
            aria-checked={memoryOn}
            aria-label="记忆开关"
            disabled={busy}
            onClick={() =>
              void patch({
                recall_enabled: !memoryOn,
                // 一起开关自动沉淀：只召回不沉淀会变成"只读旧记录"，不符合直觉
                auto_extract: !memoryOn,
              })
            }
            className={`shrink-0 relative w-12 h-6 rounded-full transition-colors ${
              memoryOn ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"
            }`}
          >
            <span
              className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                memoryOn ? "translate-x-6" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>

        <div className="mt-3 pt-3 border-t border-[var(--color-border)] flex items-center gap-3 flex-wrap">
          <span className="text-[12.5px]">
            它当前记得 <strong>{usable.length}</strong> 条
          </span>
          <Link
            className="text-[12px] hover:underline"
            style={{ color: "var(--color-accent)" }}
            href={`/memories?agent=${agentId}`}
          >
            查看 / 编辑 →
          </Link>
          {!memoryOn && (
            <span className="text-[11.5px] text-[var(--color-muted)]">
              已关闭 —— 对话不带记忆，也不会新增
            </span>
          )}
        </div>
      </section>

      {/* ── 它记住了什么 ───────────────────────────────────────── */}
      <section className="card p-4">
        <h3 className="text-[13px] font-medium mb-3">它记住的内容（{usable.length}）</h3>
        {usable.length === 0 ? (
          <p className="text-[12.5px] text-[var(--color-muted)]">
            还没有。和它聊几次，或到「记忆」页手动添加一条。
          </p>
        ) : (
          <div className="space-y-1.5">
            {usable.map((m) => {
              return (
                <div key={m.id} className="p-2.5 rounded-md bg-[var(--color-surface-2)]">
                  <div className="text-[12.5px] break-words">{m.content}</div>
                  <div className="flex gap-2 mt-1 text-[10.5px] text-[var(--color-muted)] flex-wrap items-center">
                    <span>{KIND_LABEL[m.kind] ?? m.kind}</span>
                    <span>·</span>
                    <span>被用过 {m.hits} 次</span>
                    {m.scope === "global" && (
                      <>
                        <span>·</span>
                        <span>所有 Agent 共用</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

      </section>

      {/* ── 高级设置（默认收起，术语全部翻译成人话） ───────────── */}
      <section className="card p-4">
        <button
          className="flex items-center gap-2 text-[13px] font-medium w-full text-left"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          <span className="text-[var(--color-muted)]">{showAdvanced ? "▾" : "▸"}</span>
          高级设置
          <span className="text-[11.5px] font-normal text-[var(--color-muted)]">一般不用改</span>
        </button>

        {showAdvanced && (
          <div className="mt-4 space-y-4">
            <div>
              <label className="label">挑选方式</label>
              <select
                className="input"
                value={policy.recall_strategy}
                disabled={busy}
                onChange={(e) =>
                  void patch({
                    recall_strategy: e.target.value as MemoryPolicy["recall_strategy"],
                  })
                }
              >
                <option value="hybrid">按相关度 + 最近使用 · 推荐</option>
                <option value="keyword">只按相关度</option>
                <option value="recent">只按最近使用</option>
              </select>
            </div>

            <div>
              <label className="label">每次最多回忆 {policy.recall_top_k} 条</label>
              <input
                type="range"
                min={1}
                max={20}
                value={policy.recall_top_k}
                disabled={busy}
                className="w-full accent-[var(--color-accent)]"
                onChange={(e) => void patch({ recall_top_k: Number(e.target.value) })}
              />
            </div>

            <div>
              <label className="label">
                记忆最多占上下文约 {Math.round(policy.max_inject_chars / 3)} 个字
              </label>
              <input
                type="range"
                min={200}
                max={8000}
                step={100}
                value={policy.max_inject_chars}
                disabled={busy}
                className="w-full accent-[var(--color-accent)]"
                onChange={(e) => void patch({ max_inject_chars: Number(e.target.value) })}
              />
              <p className="text-[11px] text-[var(--color-muted)] mt-1">
                超出时优先丢掉最不相关的，避免占用太多对话空间
              </p>
            </div>

            <div>
              <label className="label">
                对话超过 {policy.compress_after_turns} 轮后开始精简
              </label>
              <input
                type="number"
                min={0}
                max={200}
                className="input"
                value={policy.compress_after_turns}
                disabled={busy}
                onChange={(e) => void patch({ compress_after_turns: Number(e.target.value) })}
              />
              <p className="text-[11px] text-[var(--color-muted)] mt-1">
                更早的对话会被总结成一段话继续带着（0 = 不精简）
              </p>
            </div>

            <div>
              <label className="label">总结用的模型</label>
              <input
                className="input mono text-[12px]"
                placeholder="跟随 Agent 的模型"
                defaultValue={policy.extract_model ?? ""}
                disabled={busy}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (policy.extract_model ?? "")) void patch({ extract_model: v || null });
                }}
              />
              <p className="text-[11px] text-[var(--color-muted)] mt-1">
                建议用便宜快速的模型（总结是一次短调用）
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
