"use client";

/**
 * 对话 —— 单助手对话与多助手编排，**同一个界面**。
 *
 * 为什么不再是"两个模式切来切去"
 * ----------------------------
 * 上一版把两个页面合到了一页，但顶部还留着一道「单 Agent 对话 | 多 Agent 编排」
 * 的分段选择。那道门其实是**历史包袱**：它的存在只是因为底下是两个各自独立的
 * 组件，需要有人告诉页面该显示哪一个。
 *
 * 但从用户的角度，这两件事本来就是同一件：**把任务交给助手**。
 * 唯一的区别是**几个助手、怎么分工**。所以真正该被"选"的不是"模式"，
 * 而是**参与者**：
 *
 *   参与者 1 个  → 就是普通对话（多轮、有历史、能接着聊）
 *   再加一个     → 就地变成编排（谁先谁后、是否并行，由下层自己呈现）
 *
 * 「加一个助手」这个动作本身就是升级 —— 用户不需要先去门那边选一次模式，
 * 再回来重新选助手、重新说一遍任务。原来那样，聊到一半发现这事得分工，
 * 是**两道门 + 一次重述**；现在是一次点击。
 *
 * 参与者也成为**唯一的真相**：原来助手在对话组件里选一次、在编排托盘里再拖一次，
 * 同一件事存了两份状态 —— 现在只有这一处。
 */

import { useEffect, useMemo, useState } from "react";

import { api } from "@/lib/api";
import type { Agent } from "@/lib/types";
import { ChatConsole } from "@/components/ChatConsole";
import { OrchestrationConsole } from "@/components/OrchestrationConsole";

export function ConversationConsole({ initialAgents }: { initialAgents?: string[] } = {}) {
  const [agents, setAgents] = useState<Agent[]>([]);
  /** 参与者（助手 id）。唯一真相 —— 两个下层组件都由它驱动 */
  const [participants, setParticipants] = useState<string[]>(initialAgents ?? []);
  const [loading, setLoading] = useState(true);

  // 拉助手列表；参与者为空时默认坐下第一个（进来就能说话）
  useEffect(() => {
    void (async () => {
      try {
        const list = await api.agents();
        setAgents(list);
        setParticipants((prev) => (prev.length ? prev : list.length ? [list[0].id] : []));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const solo = participants.length <= 1;
  /** 还没参与进来的助手 —— 下拉里只列这些（已经在了就没必要再出现） */
  const available = useMemo(
    () => agents.filter((a) => !participants.includes(a.id)),
    [agents, participants],
  );
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  const add = (id: string) => {
    if (!id) return;
    setParticipants((prev) => (prev.includes(id) ? prev : [...prev, id]));
  };
  const remove = (id: string) => {
    setParticipants((prev) => {
      const next = prev.filter((x) => x !== id);
      // 至少留一个：一个都不剩的话页面就没主体了
      return next.length ? next : prev;
    });
  };

  if (loading) {
    return (
      <div className="p-4 md:p-6 lg:p-7 text-[13px] text-[var(--color-muted)]">加载中…</div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <header className="shrink-0 px-4 md:px-6 pt-4 md:pt-5 pb-3 border-b border-[var(--color-border)]">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-[20px] font-semibold tracking-tight">对话</h1>
            {/* 一句话把机制讲清：几个助手决定它是对话还是编排 */}
            <p className="text-[12.5px] text-[var(--color-muted)] mt-0.5">
              {solo
                ? "跟一个助手连续对话 —— 历史自动保存，下次接着聊。再加一个助手，它就变成编排。"
                : "几个助手分工干一件事 —— 下面就是它们的协作过程。"}
            </p>
          </div>
        </div>

        {/* 参与者条 —— 全页唯一的"谁参与"控制 */}
        <div className="flex items-center gap-1.5 flex-wrap mt-3">
          <span className="text-[11.5px] text-[var(--color-muted)] shrink-0">参与者</span>
          {participants.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1.5 rounded-full pl-2.5 pr-1.5 py-1 text-[12px] bg-[var(--color-surface-2)]"
            >
              {nameOf(id)}
              {participants.length > 1 && (
                <button
                  className="text-[var(--color-muted)] hover:text-[var(--color-text)] px-0.5"
                  title="移出参与者"
                  onClick={() => remove(id)}
                >
                  ✕
                </button>
              )}
            </span>
          ))}

          {available.length > 0 && (
            <select
              className="input w-auto text-[12px] py-1"
              value=""
              onChange={(e) => add(e.target.value)}
              title="再加一个助手 —— 加了就变成编排"
            >
              <option value="">+ 加一个助手</option>
              {available.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </header>

      {/* 参与者决定下层显示什么 —— 没有"模式"这个中间概念 */}
      <div className={`flex-1 min-h-0 ${solo ? "overflow-hidden" : "overflow-auto"}`}>
        {solo ? (
          <ChatConsole agentId={participants[0] ?? ""} />
        ) : (
          <OrchestrationConsole agentIds={participants} />
        )}
      </div>
    </div>
  );
}
