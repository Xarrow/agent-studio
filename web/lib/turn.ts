/**
 * 一轮编排的"读数"：把一堆派活记录压成界面要的几句话。
 *
 * 为什么要单独抽出来：这是整页最容易算错的地方（几件、几件在干、几件失败、收口没有），
 * 也是用户判断"这一轮到底干啥了"的唯一入口。放在纯函数里，能真跑测试，
 * 不用靠点界面去猜。
 */

import type { Delegation } from "./types";

export const LIVE_STATUS = new Set(["pending", "queued", "running"]);

export interface TurnStats {
  total: number;
  running: number;
  ok: number;
  failed: number;
  /** 一句话状态：几件在干 / 都回来了 */
  phrase: string;
  /** 收口状态：等它收口 / 已收口 / 收口时出错 */
  closing: string;
  /** 这一轮整体是否还在进行 */
  active: boolean;
}

export function turnStats(items: Delegation[], parentStatus: string | null): TurnStats {
  const total = items.length;
  const running = items.filter((d) => LIVE_STATUS.has(d.status)).length;
  const ok = items.filter((d) => d.status === "ok").length;
  const failed = total - running - ok;
  const active = running > 0;
  const phrase = total === 0 ? "还没派活" : running > 0 ? `${running} 件在干` : "都回来了";
  const closing = active
    ? "等它收口"
    : parentStatus === "error"
      ? "收口时出错"
      : parentStatus === "ok"
        ? "已收口"
        : "等它收口";
  return { total, running, ok, failed, phrase, closing, active };
}

/** worker 当前在干嘛（收起状态也要能看出动静） */
export function liveHint(steps: { kind: string; label: string; body: string }[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.kind === "output") continue;
    const body = (s.body || "").replace(/\s+/g, " ").trim();
    const label = (s.label || "").replace(/\s+/g, " ").trim();
    const text = label && body ? `${label}：${body}` : label || body;
    if (text) return text.slice(0, 60);
  }
  return "";
}

export function statusText(s: string): string {
  if (s === "ok") return "做完了";
  if (s === "error") return "失败了";
  if (s === "aborted") return "中断了";
  if (s === "pending" || s === "queued") return "排队中";
  return "在干";
}

export function secs(a: number, b: number | null): string {
  const ms = Math.max(0, (b ?? Date.now()) - a);
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}


/**
 * 每个 worker 一个固定色：同一个助手在侧栏、编排区、会话身份带上都是同一个颜色。
 * 颜色不是装饰 —— 用户在侧栏看到"琥珀那一条"，翻到对话里还是琥珀，才认得出是同一个人。
 */
const AGENT_COLORS = ["#d97706", "#0d9488", "#7c3aed", "#db2777", "#2563eb", "#65a30d"];

export function agentColor(agentId: string | null | undefined): string {
  if (!agentId) return "#64748b";
  let h = 0;
  for (let i = 0; i < agentId.length; i++) h = (h * 31 + agentId.charCodeAt(i)) >>> 0;
  return AGENT_COLORS[h % AGENT_COLORS.length];
}
