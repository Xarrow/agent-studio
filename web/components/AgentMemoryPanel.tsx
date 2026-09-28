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
 *   一条记忆归属一个 Agent    →  面板只分两栏：「它自己的」和「所有助手共用的」
 *   需要共用同一条内容        →  「复制到它」（复制一份再绑定，原件不动）
 *   top_k/注入预算/压缩阈值   →  「高级设置」（默认收起，全部换成人话）
 *
 * 绑定模型（用户拍板）：**一条记忆同时只属于一个 Agent**。共享靠复制实现，
 * 而不是让一条记忆同时挂多个 Agent —— 那样一方改动会牵动另一方，
 * 行为难以预期，也没法追责。
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Memory, MemoryPolicy } from "@/lib/types";
import { useFeedback } from "./ui/feedback";
import { Switch } from "@/components/ui/kit";

/** 精简阈值的可选档位：0 = 不精简 */
const COMPRESS_CHOICES = [0, 10, 20, 30, 50, 100];

const KIND_LABEL: Record<string, string> = {
  fact: "事实",
  preference: "偏好",
  summary: "结论",
  instruction: "要求",
};

export function AgentMemoryPanel({ agentId }: { agentId: string }) {
  const fb = useFeedback();
  const [policy, setPolicy] = useState<MemoryPolicy | null>(null);
  /** 归属它自己的记忆 */
  const [own, setOwn] = useState<Memory[]>([]);
  /** 所有助手共用的记忆（它也能用到） */
  const [shared, setShared] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, mine, shared] = await Promise.all([
        api.agentMemoryPolicy(agentId),
        // 归属它自己的（scope=agent 会把全局的排除掉）
        api.memories({ agentId, scope: "agent", status: "active" }),
        // 所有助手共用的
        api.memories({ scope: "global", status: "active" }),
      ]);
      setPolicy(p);
      setOwn(mine);
      setShared(shared);
    } catch (e) {
      fb.error("加载记忆配置失败", e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [agentId, fb]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 把一条共用记忆复制一份，绑定给当前助手（原件保持共用，不动） */
  const copyToThisAgent = async (m: Memory) => {
    setBusy(true);
    try {
      await api.duplicateMemory(m.id, { agent_id: agentId, scope: "agent" });
      fb.success("已复制给它", "副本归它专有，之后单独改不会影响共用的那条。");
      await load();
    } catch (e) {
      fb.error("复制失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 页内直接改一条记忆。
   *
   * 为什么不让用户跳到「记忆」页去改：改一条内容是很小的动作，跳页的代价却是
   * **整个助手配置页的状态全丢**（改到一半的表单、正在看的试跑结果）。所以
   * 这里就地弹一个输入框 —— 用的是记忆页同一套 fb.prompt，行为一致。
   */
  const editMemory = async (m: Memory) => {
    const next = await fb.prompt({
      title: "编辑记忆内容",
      description: "这段内容会作为「已知信息」注入到 System Prompt。",
      label: "内容",
      multiline: true,
      defaultValue: m.content,
      validate: (v) => (v.trim() ? null : "内容不能为空"),
      confirmText: "保存",
    });
    if (next === null || next.trim() === m.content) return;
    try {
      await api.updateMemory(m.id, { content: next.trim() });
      fb.success("已更新");
      await load();
    } catch (e) {
      fb.error("更新失败", e instanceof Error ? e.message : String(e));
    }
  };

  const removeMemory = async (m: Memory) => {
    const ok = await fb.confirm({
      title: "删除这条记忆？",
      description: "删掉后它不会再被想起。此操作不可撤销。",
      details: [m.content],
      danger: true,
      confirmText: "删除",
    });
    if (!ok) return;
    try {
      await api.deleteMemory(m.id);
      fb.success("已删除");
      await load();
    } catch (e) {
      fb.error("删除失败", e instanceof Error ? e.message : String(e));
    }
  };

  /** 直接给这个助手加一条记忆（不用再跳去「记忆」页选归属） */
  const addMemory = async () => {
    const text = await fb.prompt({
      title: "记一条新的事",
      description: "写给这个助手看的「已知信息」，比如它的工作习惯、你的偏好。",
      label: "内容",
      multiline: true,
      placeholder: "例如：回复尽量简短，先给结论。",
      validate: (v) => (v.trim() ? null : "内容不能为空"),
      confirmText: "保存",
    });
    if (text === null || !text.trim()) return;
    try {
      await api.createMemory({ content: text.trim(), agent_id: agentId });
      fb.success("已记住");
      await load();
    } catch (e) {
      fb.error("保存失败", e instanceof Error ? e.message : String(e));
    }
  };

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
          {/* 开关用 kit.Switch：圆点定位与触屏命中区都在零件里收口，
              原来手写的那份圆点会跑出轨道（绝对定位没写 left） */}
          <Switch
            checked={memoryOn}
            disabled={busy}
            ariaLabel="记忆开关"
            title={memoryOn ? "关掉记忆" : "打开记忆"}
            onChange={(next) =>
              void patch({
                // 一起开关自动沉淀：只召回不沉淀会变成"只读旧记录"，不符合直觉
                recall_enabled: next,
                auto_extract: next,
              })
            }
          />
        </div>

        <div className="mt-3 pt-3 border-t border-[var(--color-border)] flex items-center gap-3 flex-wrap">
          <span className="text-[12.5px]">
            它当前记得 <strong>{own.length + shared.length}</strong> 条
            {shared.length > 0 && (
              <span className="text-[var(--color-muted)]">
                （自己的 {own.length} + 共用的 {shared.length}）
              </span>
            )}
          </span>
          {/* 上面已能就地增删改；这个链接只留给"跨助手批量管理"这种确实是另一件事的场景 */}
          <Link
            className="text-[12px] text-[var(--color-muted)] hover:underline"
            href={`/memories?agent=${agentId}`}
          >
            管理全部记忆 →
          </Link>
          {!memoryOn && (
            <span className="text-[11.5px] text-[var(--color-muted)]">
              已关闭 —— 对话不带记忆，也不会新增
            </span>
          )}
        </div>
      </section>

      {/* ── 它自己的记忆 ───────────────────────────────────────── */}
      <section className="card p-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h3 className="text-[13px] font-medium">它自己的记忆（{own.length}）</h3>
          {/* 就地加一条 —— 不必跳去「记忆」页再选归属 */}
          <button className="btn btn-sm" disabled={busy} onClick={() => void addMemory()}>
            + 记一条
          </button>
        </div>
        {own.length === 0 ? (
          <p className="text-[12.5px] text-[var(--color-muted)]">
            还没有。和它聊几次会自动沉淀，或到「记忆」页添加一条并归给它。
          </p>
        ) : (
          <div className="space-y-1.5">
            {own.map((m) => (
              <div key={m.id} className="p-2.5 rounded-md bg-[var(--color-surface-2)]">
                <div className="text-[12.5px] break-words">{m.content}</div>
                <div className="flex gap-2 mt-1 text-[10.5px] text-[var(--color-muted)] flex-wrap items-center">
                  <span>{KIND_LABEL[m.kind] ?? m.kind}</span>
                  <span>·</span>
                  <span>被用过 {m.hits} 次</span>
                  {/* 就地改 / 删 —— 不跳页，助手配置页的状态不丢 */}
                  <button
                    className="ml-auto hover:underline"
                    style={{ color: "var(--color-accent)" }}
                    disabled={busy}
                    onClick={() => void editMemory(m)}
                  >
                    编辑
                  </button>
                  <button
                    className="hover:underline"
                    style={{ color: "var(--color-err)" }}
                    disabled={busy}
                    onClick={() => void removeMemory(m)}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── 所有助手共用的记忆 ─────────────────────────────────── */}
      <section className="card p-4">
        <h3 className="text-[13px] font-medium mb-1">所有助手共用的记忆（{shared.length}）</h3>
        <p className="text-[11.5px] text-[var(--color-muted)] mb-3">
          这些它对每个助手都生效。想让某个助手单独拥有一份（可以各自改、互不影响），
          用「复制到它」。
        </p>
        {shared.length === 0 ? (
          <p className="text-[12.5px] text-[var(--color-muted)]">还没有共用记忆。</p>
        ) : (
          <div className="space-y-1.5">
            {shared.map((m) => (
              <div key={m.id} className="p-2.5 rounded-md bg-[var(--color-surface-2)]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] break-words">{m.content}</div>
                    <div className="flex gap-2 mt-1 text-[10.5px] text-[var(--color-muted)] flex-wrap items-center">
                      <span>{KIND_LABEL[m.kind] ?? m.kind}</span>
                      <span>·</span>
                      <span>被用过 {m.hits} 次</span>
                    </div>
                  </div>
                  <button
                    className="btn text-[11px] px-2 py-1 shrink-0"
                    disabled={busy}
                    title="复制一份绑定给当前助手，之后可以单独修改"
                    onClick={() => void copyToThisAgent(m)}
                  >
                    复制到它
                  </button>
                </div>
              </div>
            ))}
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
              <label className="label">记忆从哪来</label>
              <select
                className="input"
                value={policy.recall_backend}
                disabled={busy}
                onChange={(e) =>
                  void patch({
                    recall_backend: e.target.value as MemoryPolicy["recall_backend"],
                  })
                }
              >
                <option value="local">平台内置记忆（本地关键词匹配）</option>
                <option value="external">外部记忆服务（接你自己的记忆库）</option>
                <option value="hybrid">两者都用 · 合并去重</option>
              </select>
              <p className="text-[11.5px] text-[var(--color-muted)] mt-1">
                {policy.recall_backend === "local"
                  ? "记忆存在平台数据库里，按关键词 + 最近使用打分。"
                  : policy.recall_backend === "external"
                    ? "只问外部服务；它没配好或连不上时会退回内置记忆（不会静默变空）。在「记忆」页配置外部服务。"
                    : "内置与外部各问一遍，同一句话只留一条；外部分数略降权，不会顶掉内置排序。"}
              </p>
            </div>

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
              <label className="label">
                每次最多回忆{" "}
                <b style={{ color: "var(--color-accent)" }}>{policy.recall_top_k}</b> 条
              </label>
              <input
                type="range"
                min={1}
                max={20}
                value={policy.recall_top_k}
                disabled={busy}
                className="range"
                style={{ ["--fill" as string]: `${((policy.recall_top_k - 1) / 19) * 100}%` }}
                onChange={(e) => void patch({ recall_top_k: Number(e.target.value) })}
              />
              <div className="flex justify-between text-[11px] text-[var(--color-muted)]">
                <span>少（省上下文）</span>
                <span>多（更靠得住）</span>
              </div>
            </div>

            <div>
              <label className="label">
                记忆最多占上下文约{" "}
                <b style={{ color: "var(--color-accent)" }}>
                  {Math.round(policy.max_inject_chars / 3)}
                </b>{" "}
                个字
              </label>
              <input
                type="range"
                min={200}
                max={8000}
                step={100}
                value={policy.max_inject_chars}
                disabled={busy}
                className="range"
                style={{
                  ["--fill" as string]: `${((policy.max_inject_chars - 200) / 7800) * 100}%`,
                }}
                onChange={(e) => void patch({ max_inject_chars: Number(e.target.value) })}
              />
              <div className="flex justify-between text-[11px] text-[var(--color-muted)]">
                <span>少（200 字）</span>
                <span>多（8000 字）</span>
              </div>
              <p className="text-[11px] text-[var(--color-muted)] mt-1">
                超出时优先丢掉最不相关的，避免占用太多对话空间
              </p>
            </div>

            <div>
              <label className="label">对话变长后自动精简</label>
              {/* 档位用选的（枚举值不给自由输入框 —— 手打轮次容易填出奇怪的数） */}
              <select
                className="input"
                value={COMPRESS_CHOICES.includes(policy.compress_after_turns) ? policy.compress_after_turns : -1}
                disabled={busy}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v >= 0) void patch({ compress_after_turns: v });
                }}
              >
                {!COMPRESS_CHOICES.includes(policy.compress_after_turns) && (
                  <option value={-1}>{policy.compress_after_turns} 轮（当前）</option>
                )}
                {COMPRESS_CHOICES.map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "不精简" : `超过 ${n} 轮`}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-[var(--color-muted)] mt-1">
                {policy.compress_after_turns === 0
                  ? "一直保留全部原文（对话很长时会占满上下文）"
                  : `每次任务跑完后检查：超过 ${policy.compress_after_turns} 轮就把较早的对话总结成一段话继续带着，最近的原文保留`}
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
