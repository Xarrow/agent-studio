"use client";

/**
 * 助手文件权限 —— 策略说明 + 危险模式开关 + 文件操作审计
 * ======================================================
 *
 * 放在「系统设置」里，不新开一级导航（用户第 6 条：运行记录或设置里能查到即可）。
 * 三段，从上到下就是用户心里的顺序：
 *
 *   1. **现在是怎么管的**（读不限制、写越界要点头、~/.hermes 禁区）—— 先让他确认
 *      "我懂了规则"，再给开关。规则藏起来只给开关，等于让他盲开。
 *   2. **危险模式**：默认关；打开要**二次确认 + 风险说明**（用户第 4 条），
 *      打开后全局顶栏有常驻红条、可一键关回（那是 DangerModeBanner，不在这）。
 *   3. **审计**：最近动过哪些文件、谁点头的、谁拦下的 —— 开了危险模式以后，
 *      下面立刻能看到「危险模式跳过」那几条，因果一目了然。
 *
 * 交互口径（全站一致）：不用原生 confirm；破坏性动作两步确认；动作常驻可见。
 */

import { useCallback, useEffect, useState } from "react";

import { api } from "@/lib/api";
import { broadcastDangerMode, DANGER_MODE_KEY } from "@/lib/danger-mode";
import { Empty, Switch } from "@/components/ui/kit";
import type { FileAuditRow } from "@/lib/types";

const DANGER_KEY = DANGER_MODE_KEY;

/** 结果 → 颜色/语气（一眼看出这条是放行还是拦下） */
const RESULT_TONE: Record<string, { color: string; bg: string }> = {
  allowed: { color: "var(--color-muted)", bg: "var(--color-surface-2)" },
  approved: { color: "var(--color-ok)", bg: "color-mix(in srgb, var(--color-ok) 12%, transparent)" },
  rejected: { color: "var(--color-err)", bg: "color-mix(in srgb, var(--color-err) 12%, transparent)" },
  skipped: { color: "var(--color-warn)", bg: "color-mix(in srgb, var(--color-warn) 14%, transparent)" },
  blocked: { color: "var(--color-err)", bg: "color-mix(in srgb, var(--color-err) 16%, transparent)" },
};

/** 把开关状态广播出去 —— 顶栏那条常驻提示靠它即时更新（不用刷新页面） */
export { broadcastDangerMode };

export function FilePolicySettings() {
  const [danger, setDanger] = useState<boolean | null>(null);
  /** 二次确认展开：第一下只是表达意愿，这里才是真开 */
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rows, setRows] = useState<FileAuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [protectedDirs, setProtectedDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await api.fileAudit(30);
      setRows(r.items || []);
      setTotal(r.total || 0);
      setDanger(Boolean(r.danger_mode));
      setProtectedDirs(r.protected || []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const enable = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.setAppSetting(DANGER_KEY, true);
      setDanger(true);
      broadcastDangerMode(true);
      setConfirming(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.setAppSetting(DANGER_KEY, false);
      setDanger(false);
      broadcastDangerMode(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onToggle = (next: boolean) => {
    if (next) {
      setConfirming(true); // 打开必须走二次确认（用户第 4 条）
      return;
    }
    void disable();
  };

  return (
    <div className="space-y-3">
      {/* ── 现在的规则（信息默认可见，不用点开看） ─────────────── */}
      <ul className="text-[12.5px] leading-relaxed space-y-1" style={{ color: "var(--color-text)" }}>
        <li>
          <b>读</b>：除禁区外不限制 —— 家目录、别的会话目录、系统目录都能读，<b>不打扰你</b>。
        </li>
        <li>
          <b>写</b>：当前会话的工作目录内直接执行；<b>之外一律先弹确认卡</b>
          （新建 / 覆盖 / 删除 / 移动都算），拒绝或超时就不执行。
        </li>
        <li>
          <b>禁区</b>：<span className="mono">{protectedDirs.join("、") || "~/.hermes"}</span>{" "}
          读写都拒绝（符号链接指过去也拦）。这是 Hermes 自己的运行目录，助手碰了会影响 Hermes 本身。
        </li>
      </ul>

      {/* ── 危险模式 ─────────────────────────────────────────── */}
      <div
        className="rounded-[10px] px-3 py-2.5"
        style={{ background: danger ? "color-mix(in srgb, var(--color-err) 7%, var(--color-surface-2))" : "var(--color-surface-2)" }}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-medium">危险模式：跳过文件写入确认</span>
          <span
            className="rounded-full px-1.5 py-[1px] text-[10.5px]"
            style={
              danger
                ? { background: "var(--color-err)", color: "var(--color-accent-contrast)" }
                : { background: "var(--color-surface)", color: "var(--color-muted)" }
            }
          >
            {danger === null ? "读取中…" : danger ? "已开启" : "已关闭（默认）"}
          </span>
          <div className="ml-auto">
            <Switch
              checked={Boolean(danger)}
              disabled={busy || danger === null}
              onChange={onToggle}
              ariaLabel="危险模式：跳过文件写入确认"
            />
          </div>
        </div>
        <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--color-muted)" }}>
          开启后，助手往会话目录之外写文件<b>不再弹确认卡、直接执行</b>。
          禁区（~/.hermes）和「删库 / 格式化 / 关机」这类硬拦截不受影响，仍然会拒。
          开关是全局一份、跟着数据走，不用每个会话重新设。
        </p>

        {confirming && (
          <div
            className="mt-2 rounded-lg px-2.5 py-2"
            style={{ background: "color-mix(in srgb, var(--color-err) 10%, transparent)" }}
          >
            <div className="text-[12.5px] font-medium" style={{ color: "var(--color-err)" }}>
              确认开启危险模式？开启期间它可以直接改你机器上的文件，看完这行再点。
            </div>
            <div className="text-[12px] mt-1" style={{ color: "var(--color-text)" }}>
              具体后果：助手在会话目录外新建/覆盖/删除文件都不会再问你；
              它写错地方、覆盖掉你的文件，你<b>当场不会收到任何提示</b>。所有操作仍会记在下面的审计里，
              事后可查。随时可以在顶栏那条红色提示上点「关掉」恢复确认。
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                data-tap
                className="btn btn-sm"
                disabled={busy}
                onClick={() => void enable()}
                style={{ background: "var(--color-err)", borderColor: "var(--color-err)", color: "var(--color-accent-contrast)" }}
              >
                {busy ? "开启中…" : "确认开启"}
              </button>
              <button data-tap className="btn btn-sm" disabled={busy} onClick={() => setConfirming(false)}>
                取消
              </button>
            </div>
          </div>
        )}
      </div>

      {err && (
        <p className="text-[12px]" style={{ color: "var(--color-err)" }}>
          {err}
        </p>
      )}

      {/* ── 审计 ─────────────────────────────────────────────── */}
      <div>
        <div className="flex flex-wrap items-center gap-2 mb-1.5">
          <span className="text-[12.5px] font-medium">文件操作记录</span>
          <span className="text-[11.5px]" style={{ color: "var(--color-muted)" }}>
            最近 30 条 · 共 {total} 条（被允许 / 被拒绝 / 危险模式跳过 / 禁区拦截都记）
          </span>
          <button data-tap className="btn btn-sm ml-auto" disabled={loading} onClick={() => void load()}>
            刷新
          </button>
        </div>
        {rows.length === 0 ? (
          <Empty title="还没有文件操作记录" hint="助手写文件（含被拒绝、被拦下的）之后，这里会出现一条" />
        ) : (
          /* 一行一条：时间 · 助手 · 操作 · 路径 · 结果。分隔用底色差，不用 1px 线 */
          <div className="rounded-[10px] overflow-hidden" style={{ background: "var(--color-surface-2)" }}>
            {rows.map((r, i) => {
              const tone = RESULT_TONE[r.result] || RESULT_TONE.allowed;
              return (
                <div
                  key={r.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2.5 py-1.5 text-[12px]"
                  style={{ background: i % 2 ? "transparent" : "var(--color-surface)" }}
                >
                  <span className="mono text-[11px]" style={{ color: "var(--color-muted)" }}>
                    {fmtTs(r.ts)}
                  </span>
                  <span className="font-medium">{r.agent_name || r.agent_id || "（未知助手）"}</span>
                  <span style={{ color: "var(--color-muted)" }}>{r.op || "写"}</span>
                  <span className="mono break-all" style={{ color: "var(--color-text)" }}>
                    {r.path}
                  </span>
                  <span
                    className="ml-auto rounded-full px-1.5 py-[1px] text-[10.5px] shrink-0"
                    style={{ background: tone.bg, color: tone.color }}
                    title={r.rule}
                  >
                    {r.result_label}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** 毫秒 → 本地 `MM-DD HH:MM`（审计里够用，不引第三方库） */
function fmtTs(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
