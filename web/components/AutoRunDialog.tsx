"use client";

/**
 * 自动运行（无人值守）—— 让这条流程**不需要人在界面前**也能跑起来。
 *
 * 产品判断写在明面上
 * ------------------
 * · **定时用枚举，不用 cron**：用户该「选」不该「填」（cron 是第二个术语，
 *   写错了还看不出来）。所以只有 每小时 / 每天 / 每周 + 时:分 + 星期多选 ——
 *   覆盖"日报 / 周报 / 每小时巡检"，且看一眼就懂。
 * · **默认任务**：一条没有任务描述的流程"自动跑"没有意义，所以这里是必填的语义，
 *   没填时界面**明说"定时不会跑"**（而不是安静地什么都不发生）。
 * · **外部触发**：给别的系统一把专属地址（token 在路径里），
 *   它们没法塞 header —— 这是最省事的可对接形态。可一键重置。
 * · 覆盖式保存 + 保存后立刻显示"下次什么时候跑"，用户马上能核对。
 */

import { useCallback, useEffect, useState } from "react";

import { api, fmt } from "@/lib/api";
import { useFeedback } from "@/components/ui/feedback";

type Auto = {
  mode: string;
  at: string;
  weekdays: string;
  default_task: string;
  describe: string;
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_source: string;
  hook_path: string;
  problems: string[];
};

const MODES: { key: string; label: string; hint: string }[] = [
  { key: "", label: "不定时", hint: "只有你点「运行」时才跑" },
  { key: "hourly", label: "每小时", hint: "每个整点跑一次" },
  { key: "daily", label: "每天", hint: "每天在指定时间跑一次" },
  { key: "weekly", label: "每周", hint: "每周在指定的几天跑" },
];

const WEEK = [
  { key: "1", label: "周一" },
  { key: "2", label: "周二" },
  { key: "3", label: "周三" },
  { key: "4", label: "周四" },
  { key: "5", label: "周五" },
  { key: "6", label: "周六" },
  { key: "7", label: "周日" },
];

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTES = ["00", "05", "10", "15", "20", "30", "40", "45", "50"];

export function AutoRunDialog({
  wfId,
  wfName,
  onClose,
  onSaved,
}: {
  wfId: string;
  wfName: string;
  onClose: () => void;
  onSaved?: (describe: string) => void;
}) {
  const fb = useFeedback();
  const [auto, setAuto] = useState<Auto | null>(null);
  const [mode, setMode] = useState("");
  const [hour, setHour] = useState("09");
  const [minute, setMinute] = useState("00");
  const [days, setDays] = useState<string[]>(["1"]);
  const [task, setTask] = useState("");
  const [saving, setSaving] = useState(false);
  const [armRotate, setArmRotate] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const a = (await api.workflowAuto(wfId)) as Auto;
      setAuto(a);
      setMode(a.mode || "");
      const [h, m] = (a.at || "09:00").split(":");
      setHour(h || "09");
      setMinute(m || "00");
      setDays((a.weekdays || "1").split(",").filter(Boolean));
      setTask(a.default_task || "");
    } catch (e) {
      fb.error("读取自动运行设置失败", e instanceof Error ? e.message : String(e));
    }
  }, [wfId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
  }, [load]);

  // Esc 关掉（自研浮层规矩：不用原生弹窗）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    if (mode === "weekly" && days.length === 0) {
      fb.error("还没选星期几", "每周跑的话，至少要选一天");
      return;
    }
    if (mode && !task.trim()) {
      fb.error("还差「默认任务」", "没有任务描述，定时到点了也不知道该让它做什么");
      return;
    }
    setSaving(true);
    try {
      const a = (await api.saveWorkflowAuto(wfId, {
        mode,
        at: `${hour}:${minute}`,
        weekdays: mode === "weekly" ? days.join(",") : "",
        default_task: task.trim(),
      })) as Auto;
      setAuto(a);
      fb.success(mode ? `已开启：${a.describe}` : "已关掉自动运行");
      onSaved?.(a.describe);
    } catch (e) {
      fb.error("保存失败", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const hookUrl =
    auto?.hook_path && typeof window !== "undefined"
      ? `${window.location.origin}${auto.hook_path}`
      : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      fb.error("复制失败", "请手动选中地址复制");
    }
  };

  const rotate = async () => {
    if (!armRotate) {
      setArmRotate(true); // 破坏性操作：两步确认（4 秒内有效）
      setTimeout(() => setArmRotate(false), 4000);
      return;
    }
    setArmRotate(false);
    try {
      const a = (await api.rotateWorkflowTrigger(wfId)) as Auto;
      setAuto(a);
      fb.success("触发地址已换新", "旧地址立即失效");
    } catch (e) {
      fb.error("重置失败", e instanceof Error ? e.message : String(e));
    }
  };

  const toggleDay = (k: string) =>
    setDays((d) => (d.includes(k) ? d.filter((x) => x !== k) : [...d, k].sort()));

  return (
    <div
      className="pg-modal fixed inset-0 z-[75] flex items-center justify-center p-4"
      style={{ background: "var(--color-overlay)" }}
      onClick={onClose}
    >
      <div
        className="df-card flex max-h-[90vh] w-full max-w-[560px] flex-col overflow-hidden border"
        style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
          <span className="text-[15px] font-semibold">自动运行</span>
          <span className="min-w-0 flex-1 truncate text-[12.5px]" style={{ color: "var(--color-muted)" }}>
            {wfName} —— 不用你在界面前，它也能按点跑
          </span>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-[6px] px-2 py-1 text-[13px]"
            style={{ color: "var(--color-muted)" }}
            title="关闭"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-3.5">
          {/* ── 默认任务 ───────────────────────────────────────────── */}
          <label className="block">
            <span className="text-[12.5px] font-semibold">默认任务</span>
            <span className="ml-1.5 text-[12px]" style={{ color: "var(--color-muted)" }}>
              每次自动跑都用这句（外部调用时可以在请求里临时换掉）
            </span>
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={2}
              placeholder="例如：汇总昨天新增的归档，列成清单"
              className="mt-1 w-full rounded-[8px] border px-2.5 py-2 text-[13px] outline-none"
              style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
            />
          </label>

          {/* ── 定时 ───────────────────────────────────────────────── */}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12.5px] font-semibold">什么时候跑</span>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                className="rounded-[8px] border px-2 py-1.5 text-[13px]"
                style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
              >
                {MODES.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
              {(mode === "daily" || mode === "weekly") && (
                <>
                  <select
                    value={hour}
                    onChange={(e) => setHour(e.target.value)}
                    className="rounded-[8px] border px-2 py-1.5 text-[13px]"
                    style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
                    title="小时"
                  >
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                  <span>:</span>
                  <select
                    value={minute}
                    onChange={(e) => setMinute(e.target.value)}
                    className="rounded-[8px] border px-2 py-1.5 text-[13px]"
                    style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
                    title="分钟"
                  >
                    {MINUTES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
            <div className="mt-1 text-[12px]" style={{ color: "var(--color-muted)" }}>
              {MODES.find((m) => m.key === mode)?.hint}
            </div>
            {mode === "weekly" && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {WEEK.map((d) => {
                  const on = days.includes(d.key);
                  return (
                    <button
                      key={d.key}
                      type="button"
                      onClick={() => toggleDay(d.key)}
                      className="rounded-[6px] border px-2 py-1 text-[12px]"
                      style={{
                        borderColor: on ? "var(--color-accent)" : "var(--color-border)",
                        background: on ? "color-mix(in srgb, var(--color-accent) 12%, transparent)" : "var(--color-surface)",
                        color: on ? "var(--color-accent)" : "var(--color-muted)",
                      }}
                    >
                      {d.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── 现状：下次 / 上次 ──────────────────────────────────── */}
          {auto && (
            <div
              className="rounded-[8px] border px-3 py-2 text-[12.5px]"
              style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
            >
              <div>
                当前：
                <b>{auto.describe}</b>
                {auto.mode && auto.next_run_at ? ` · 下次 ${fmt.time(auto.next_run_at)}` : ""}
              </div>
              {auto.last_run_at ? (
                <div style={{ color: "var(--color-muted)" }}>
                  上次自动跑：{fmt.time(auto.last_run_at)}（
                  {auto.last_run_source === "schedule" ? "定时" : "外部调用"}）
                </div>
              ) : null}
              {auto.problems.map((p) => (
                <div key={p} style={{ color: "var(--color-warn)" }}>
                  ⚠ {p}
                </div>
              ))}
            </div>
          )}

          {/* ── 外部触发 ───────────────────────────────────────────── */}
          <div>
            <div className="text-[12.5px] font-semibold">外部触发地址</div>
            <div className="mt-1 text-[12px]" style={{ color: "var(--color-muted)" }}>
              任何系统 POST 或 GET 这个地址，就能让这条流程跑一次；请求里带{" "}
              <span className="mono">{'{"task": "临时任务"}'}</span> 可临时换任务。
            </div>
            <div className="mt-1.5 flex items-center gap-1.5">
              <input
                readOnly
                value={hookUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="mono min-w-0 flex-1 rounded-[8px] border px-2 py-1.5 text-[11.5px]"
                style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
              />
              <button
                type="button"
                onClick={() => void copy()}
                className="shrink-0 rounded-[8px] border px-2.5 py-1.5 text-[12px]"
                style={{ borderColor: "var(--color-border)" }}
              >
                {copied ? "已复制" : "复制"}
              </button>
              <button
                type="button"
                onClick={() => void rotate()}
                className="shrink-0 rounded-[8px] border px-2.5 py-1.5 text-[12px]"
                style={{
                  borderColor: armRotate ? "var(--color-err)" : "var(--color-border)",
                  color: armRotate ? "var(--color-err)" : undefined,
                }}
                title="换一把新的触发地址，旧的立即失效"
              >
                {armRotate ? "再点一次即重置" : "重置"}
              </button>
            </div>
          </div>
        </div>

        <div
          className="flex items-center gap-2 border-t px-4 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
            保存后立即生效
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-[8px] border px-3 py-1.5 text-[12.5px]"
            style={{ borderColor: "var(--color-border)" }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded-[8px] px-3.5 py-1.5 text-[12.5px] font-medium disabled:opacity-50"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-fg)" }}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
