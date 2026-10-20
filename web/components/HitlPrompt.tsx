"use client";

/**
 * 授权请求条 —— 运行暂停、等你点头时出现
 * ================================
 *
 * 为什么做成共享组件
 * ----------------
 * 「对话」「多 Agent 编排」「测试 agent（试跑）」本质是同一件事：**运行中途要授权**。
 * 三个地方必须长得一样、点起来也一样。后端一直支持 resume
 * （`POST /api/runs/resume/{id}`，无状态恢复：重新编译 Agent 再回灌确认结果），
 * 界面上少一处就没法继续。
 *
 * 设计原则（为什么长这样）
 * --------------------
 * 1. **说人话**：标题是「执行命令 / 写入文件」这种动作，不是 `Bash`。
 *    原始工具名只作小字留着（排查要用）。参数挑要害那一个显示，想看全部再展开
 *    —— 别一上来把 JSON 摊给用户审。
 * 2. **风险分级 + 危险操作二次确认**：`rm -rf /`、`sudo`、`DROP TABLE`、
 *    `curl | sh` 这类标红，允许要**点两下**（第一下是意愿、第二下是确认）。
 *    正常操作（ls / 读文件）不标红 —— 什么都标红 = 用户闭眼点，护栏就失效了。
 * 3. **点完就用不了**：提交后整块收成一行状态。resume 之后模型可能立刻又要一次
 *    授权（先写脚本、再跑脚本是常态），旧条若还能点，用户手快点的就是旧条 ——
 *    回灌上一轮的 tool_call id，AgentScope 直接拒绝、run 报错（实测过：
 *    一条 run 连要 5 次确认，第 4 次的确认条点在了第 5 次的等待上）。
 * 4. **拒绝也要给出路**：总是允许给成真链接（助手配置页的权限段），不是一句空话。
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
import { highestRisk, summarizeCalls } from "@/lib/hitl";

export function HitlPrompt({
  runId,
  payload,
  /** 恢复**之前**调用 —— 调用方在这里把事件流接上，避免丢掉恢复后的新事件 */
  onBeforeResume,
  /** 恢复请求**成功**后调用（用来刷新界面 / 接上后续事件流） */
  onResumed,
  /** 恢复请求失败 */
  onError,
  /** 「总是允许去哪配」的链接（助手配置页的权限段）。不给就不显示这句 */
  permissionHref,
  /** 紧凑模式：内嵌在时间线/详情里时用（少些留白） */
  compact,
}: {
  runId: string;
  payload: Record<string, unknown> | null | undefined;
  onBeforeResume?: () => void;
  onResumed?: (confirm: boolean) => void;
  onError?: (message: string) => void;
  permissionHref?: string;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  /** 已提交过的那次决定 —— 提交后整块收成状态行，不能再点第二次（见文件头第 3 条） */
  const [sent, setSent] = useState<null | boolean>(null);
  const [err, setErr] = useState<string | null>(null);
  /** 危险操作走到第二步了（第一下是意愿，第二下才是确认） */
  const [confirming, setConfirming] = useState(false);
  /** 展开看完整参数的那一条 */
  const [showFull, setShowFull] = useState<number | null>(null);
  /** 「本会话内不再问这个工具」—— 危险操作不提供这个选项（每次都该问） */
  const [remember, setRemember] = useState(false);
  const calls = summarizeCalls(payload);
  const danger = highestRisk(calls) === "danger";
  const risky = calls.filter((c) => c.risk?.level === "danger");

  const resume = async (confirm: boolean, rememberTool = false) => {
    if (busy || sent !== null) return;
    setBusy(true);
    setSent(confirm);
    setErr(null);
    onBeforeResume?.(); // 先接流，再恢复 —— 顺序不能反
    try {
      await api.resumeRun(runId, {
        confirm,
        ...(rememberTool ? { remember: true } : {}),
        ...(payload && Object.keys(payload).length ? { payload } : {}),
      });
      onResumed?.(confirm);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      setSent(null); // 没发成功，允许重试
      setConfirming(false);
      onError?.(msg);
    } finally {
      setBusy(false);
    }
  };

  /* ── 已提交：收成一行状态，不再可点 ───────────────────────── */
  if (sent !== null) {
    const color = sent ? "var(--color-ok)" : "var(--color-err)";
    return (
      <div
        className="flex items-center gap-2 rounded-xl border px-3 py-2 text-[12.5px] flex-wrap"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {sent ? <path d="M20 6L9 17l-5-5" /> : <><path d="M18 6L6 18" /><path d="M6 6l12 12" /></>}
        </svg>
        <span style={{ color }}>{sent ? "已允许，继续执行…" : "已拒绝，等它收尾…"}</span>
        {calls.length > 0 && (
          <span className="text-[var(--color-muted)] truncate">
            {calls.map((c) => c.label).join("、")}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className="rounded-xl overflow-hidden border"
      style={{
        borderColor: danger ? "var(--color-err)" : "var(--color-warn)",
        background: "var(--color-surface)",
        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
      }}
    >
      {/* 顶部：谁在等、几个操作、有没有危险 */}
      <div
        className="flex items-center gap-2 px-3 py-2 flex-wrap"
        style={{
          background: danger
            ? "color-mix(in srgb, var(--color-err) 12%, transparent)"
            : "color-mix(in srgb, var(--color-warn) 14%, transparent)",
        }}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke={danger ? "var(--color-err)" : "var(--color-warn)"}
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="4" y="10.5" width="16" height="10" rx="2" />
          <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
        </svg>
        <span
          className="text-[13px] font-medium"
          style={{ color: danger ? "var(--color-err)" : "var(--color-warn)" }}
        >
          需要你授权才能继续
        </span>
        <span className="text-[12px] text-[var(--color-muted)]">
          {calls.length > 0 ? `${calls.length} 个操作` : "助手发起了授权请求"}
        </span>
        {danger && (
          <span
            className="ml-auto rounded-full px-2 py-[2px] text-[11px] font-medium"
            style={{ background: "var(--color-err)", color: "#fff" }}
          >
            危险操作
          </span>
        )}
      </div>

      {/* 中间：一条一个操作 */}
      {calls.length > 0 && (
        <div className={compact ? "px-3 py-2 space-y-2" : "px-3 py-2.5 space-y-2.5"}>
          {calls.map((c, i) => (
            <div key={i} className="rounded-lg px-2.5 py-2" style={{ background: "var(--color-surface-2)" }}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[13px] font-medium">{c.label}</span>
                {c.raw && c.raw !== c.label && (
                  <span className="mono text-[10.5px] text-[var(--color-muted)]">{c.raw}</span>
                )}
                {c.risk?.level === "danger" && (
                  <span
                    className="rounded-full px-1.5 py-[1px] text-[10.5px] font-medium"
                    style={{
                      background: "color-mix(in srgb, var(--color-err) 16%, transparent)",
                      color: "var(--color-err)",
                    }}
                  >
                    危险
                  </span>
                )}
                {c.risk?.level === "caution" && (
                  <span
                    className="rounded-full px-1.5 py-[1px] text-[10.5px]"
                    style={{ background: "var(--color-surface)", color: "var(--color-muted)" }}
                  >
                    会改动文件
                  </span>
                )}
              </div>
              <div className="mono text-[11.5px] mt-1 break-all leading-relaxed">{c.detail}</div>
              {c.risk?.level === "danger" && (
                <div className="text-[11.5px] mt-1" style={{ color: "var(--color-err)" }}>
                  {c.risk.reason}
                </div>
              )}
              <button
                type="button"
                data-tap
                className="text-[11.5px] mt-1 text-[var(--color-muted)] hover:text-[var(--color-text)] hover:underline"
                onClick={() => setShowFull(showFull === i ? null : i)}
                aria-expanded={showFull === i}
              >
                {showFull === i ? "收起参数" : "看完整参数"}
              </button>
              {showFull === i && (
                <pre
                  className="mono text-[11px] mt-1.5 rounded-md p-2 overflow-auto max-h-64 whitespace-pre-wrap break-all"
                  style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
                >
                  {c.full}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}

      {err && (
        <div className="px-3 pb-1 text-[12px]" style={{ color: "var(--color-err)" }}>
          恢复失败：{err}
        </div>
      )}

      {/* 底部：动作 */}
      <div
        className="flex items-center gap-2 px-3 py-2 flex-wrap border-t"
        style={{ borderColor: "var(--color-border)" }}
      >
        {confirming ? (
          /* 危险操作第二步：先把后果说清楚，再让点 */
          <div className="flex items-center gap-2 flex-wrap w-full">
            <span className="text-[12.5px] font-medium" style={{ color: "var(--color-err)" }}>
              确认要执行{risky.length > 1 ? "这些" : "这个"}危险操作？
            </span>
            <span className="text-[12px] text-[var(--color-muted)]">
              {risky.map((c) => c.risk?.reason).filter(Boolean).join("；")}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button
                data-tap
                className="btn btn-sm"
                style={{ background: "var(--color-err)", borderColor: "var(--color-err)", color: "#fff" }}
                disabled={busy}
                onClick={() => void resume(true)}
              >
                {busy ? "执行中…" : "确认执行"}
              </button>
              <button data-tap className="btn btn-sm" disabled={busy} onClick={() => setConfirming(false)}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <>
            <button
              data-tap
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => (danger ? setConfirming(true) : void resume(true, remember))}
              style={danger ? { background: "var(--color-err)", borderColor: "var(--color-err)" } : undefined}
            >
              {busy ? "处理中…" : danger ? "允许执行" : "允许"}
            </button>
            {!danger && (
              /* 同类操作问十遍是主要噪音源；危险操作故意不给这个选项（每次都该问） */
              <label className="flex items-center gap-1.5 text-[12px] text-[var(--color-muted)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  disabled={busy}
                />
                本会话内不再问{calls.length === 1 ? `「${calls[0].label}」` : "这类操作"}
              </label>
            )}
            <button
              data-tap
              className="btn btn-sm"
              style={{ color: "var(--color-err)" }}
              disabled={busy}
              onClick={() => void resume(false)}
            >
              拒绝
            </button>
            <span className="text-[12px] text-[var(--color-muted)]">
              拒绝后它会拿到结果、自己换个做法。
            </span>
            {permissionHref && (
              <a
                href={permissionHref}
                data-tap
                className="ml-auto text-[12px] hover:underline"
                style={{ color: "var(--color-accent)" }}
              >
                总是允许？去助手权限里配 →
              </a>
            )}
          </>
        )}
      </div>
    </div>
  );
}
