"use client";

/**
 * 人工确认条 —— 运行暂停、等你授权时出现。
 *
 * 为什么做成共享组件
 * ----------------
 * 「对话」「多 Agent 编排」「测试 agent（试跑）」本质是同一件事：**运行中途要授权**。
 * 三个地方必须长得一样、点起来也一样。之前只有试跑页有一份实现，重构时丢了 ——
 * 于是三个地方集体卡死：后端一直支持 resume（`POST /api/runs/resume/{id}`，
 * 无状态恢复：重新编译 Agent 再回灌确认结果），但**没有任何界面能点**。
 * 模型只能输出"我在等你的许可"，用户无从下手。
 *
 * 后端交互（三处一致）
 * ------------------
 * 1. 运行发出 `hitl_request` 事件 → run.status 变 `waiting_hitl`，请求存进 `pending_hitl`
 * 2. 用户点允许/拒绝 → `POST /api/runs/resume/{id}`，把**原始 payload**（含 reply_id、
 *    tool_calls）回灌 —— 后端要用它定位到那一次调用
 * 3. **必须先挂上事件流再恢复**：恢复后立刻产生的新事件不会重播，晚挂就丢
 */

import { useState } from "react";

import { api } from "@/lib/api";

type ToolCall = { id?: string; name?: string; input?: unknown };

/** 事件里的 input 可能是**对象**，也可能是**JSON 字符串**（AgentScope 两种都给过） */
function parseInput(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null; // 不是 JSON，交给调用方按原文显示
    }
  }
  return null;
}

/**
 * 把待确认的调用提炼成"工具 + 关键参数"，用人话显示出来。
 *
 * 坑：`input` 有时是 JSON **字符串**（`"{\"command\": \"mkdir -p x\"}"`）。
 * 直接当对象用会得到 `0: {` 这种鬼东西 —— 必须先将它解析成对象。
 */
export function describeHitl(
  payload: Record<string, unknown> | null | undefined,
): { tool: string; detail: string }[] {
  const calls = (payload?.tool_calls as ToolCall[] | undefined) ?? [];
  return calls.map((tc) => {
    const tool = tc.name ?? "(未知工具)";
    const input = parseInput(tc.input);
    if (!input) {
      // 解析不出对象就把原文摆出来（宁可丑，也别显示错）
      const raw = typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input ?? {});
      return { tool, detail: raw.slice(0, 200) };
    }
    // 参数里挑最像"要害"的那个显示；挑不到就把整个入参摊平
    const key =
      ["command", "file_path", "path", "url", "query"].find(
        (k) => typeof input[k] === "string",
      ) ?? Object.keys(input)[0];
    const detail =
      key && input[key] !== undefined
        ? `${key}: ${String(input[key])}`
        : JSON.stringify(input).slice(0, 200);
    return { tool, detail };
  });
}

export function HitlPrompt({
  runId,
  payload,
  /** 恢复**之前**调用 —— 调用方在这里把事件流接上，避免丢掉恢复后的新事件 */
  onBeforeResume,
  /** 恢复请求**成功**后调用（用来刷新界面 / 接上后续事件流） */
  onResumed,
  /** 恢复请求失败 */
  onError,
}: {
  runId: string;
  payload: Record<string, unknown> | null | undefined;
  onBeforeResume?: () => void;
  onResumed?: (confirm: boolean) => void;
  onError?: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const items = describeHitl(payload);

  const resume = async (confirm: boolean) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    // 先接流，再恢复 —— 顺序不能反
    onBeforeResume?.();
    try {
      // 有明细才回灌；没有就让服务端用它自己存的那份（发 null 没有意义）
      await api.resumeRun(runId, {
        confirm,
        ...(payload && Object.keys(payload).length ? { payload } : {}),
      });
      onResumed?.(confirm);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      onError?.(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-md p-3"
      style={{
        background: "color-mix(in srgb, var(--color-warn) 10%, transparent)",
        border: "1px solid var(--color-warn)",
      }}
    >
      <div className="text-[12.5px] font-medium mb-1" style={{ color: "var(--color-warn)" }}>
        它想执行需要你授权的操作，等你点头才继续
      </div>

      <div className="space-y-1.5 mb-3">
        {items.length === 0 ? (
          <div className="text-[11.5px] text-[var(--color-muted)]">（没有解析出具体调用）</div>
        ) : (
          items.map((it, i) => (
            <div key={i} className="rounded bg-[var(--color-surface-2)] px-2 py-1.5">
              <div className="text-[12px] font-medium mono">{it.tool}</div>
              <div className="text-[11.5px] text-[var(--color-muted)] mono break-all">
                {it.detail}
              </div>
            </div>
          ))
        )}
      </div>

      {err && <div className="text-[11.5px] text-[var(--color-err)] mb-2">恢复失败：{err}</div>}

      <div className="flex items-center gap-2 flex-wrap">
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void resume(true)}>
          {busy ? "处理中…" : "允许"}
        </button>
        <button
          className="btn btn-sm"
          style={{ color: "var(--color-err)" }}
          disabled={busy}
          onClick={() => void resume(false)}
        >
          拒绝
        </button>
        <span className="text-[11px] text-[var(--color-muted)]">
          不想每次都问？去助手的「权限」里调范围。
        </span>
      </div>
    </div>
  );
}
