"use client";

/**
 * 会话上的「定时」—— 让这个对话在你不看着的时候也跑。
 *
 * 用户视角的一句话：每天早上 9 点，让它按我说的做一次；结果回到这个对话里
 * （我回来能接着追问），或者推一份到飞书/企业微信群（人不在电脑前也知道）。
 *
 * 口径：
 * · 频率是**枚举**（每小时 / 每天 / 每周 + 时间 + 星期），不让用户写 cron ——
 *   cron 是"第二个术语"，写错了还看不出来。
 * · 投递两选一：本对话（默认，零配置）/ Webhook（贴地址 + 选格式）。
 *   飞书、企业微信、钉钉的群机器人都是"POST 一个 JSON"，所以一个地址框能覆盖三种。
 * · 没有定时任务时，只有输入框下面一个安静的「定时」按钮；有任务时多一条常驻行，
 *   写明频率、下一次、上一轮结果，可以直接关/开。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import { useFeedback } from "@/components/ui/feedback";
import { DLG_BACKDROP, FieldLabel, Switch } from "@/components/ui/kit";
import type { SessionJob } from "@/lib/types";

const WEEK = [
  { k: "1", label: "一" },
  { k: "2", label: "二" },
  { k: "3", label: "三" },
  { k: "4", label: "四" },
  { k: "5", label: "五" },
  { k: "6", label: "六" },
  { k: "7", label: "日" },
];

const CHANNEL_OPTS = [
  { key: "session" as const, label: "这个对话" },
  { key: "webhook" as const, label: "Webhook" },
];

const FORMAT_OPTS = [
  { key: "feishu", label: "飞书" },
  { key: "wecom", label: "企业微信" },
  { key: "dingtalk", label: "钉钉" },
  { key: "generic", label: "自定义 JSON" },
];

function scheduleText(j: { mode: string; at: string; weekdays: string }): string {
  if (j.mode === "hourly") return "每小时";
  const wd = (j.weekdays || "1").split(",").filter(Boolean).map((n) => WEEK.find((w) => w.k === n)?.label ?? "");
  if (j.mode === "weekly") return `每周${wd.join("、")} ${j.at}`;
  return `每天 ${j.at}`;
}

/** 「下一次」说人话：今天 09:00 / 明天 09:00 / 3 小时后 */
function whenText(ms: number | null): string {
  if (!ms) return "未安排";
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 86400000).toDateString() === d.toDateString();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return `今天 ${hm}`;
  if (tomorrow) return `明天 ${hm}`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`;
}

const STATUS_TONE: Record<string, { text: string; color: string }> = {
  ok: { text: "上一轮成功", color: "var(--color-ok)" },
  error: { text: "上一轮失败", color: "var(--color-err)" },
  aborted: { text: "上一轮被停止", color: "var(--color-err)" },
  skipped: { text: "上一轮跳过", color: "var(--color-muted)" },
};

export default function SessionJobs({
  sessionId,
  open,
  onOpenChange,
  onCount,
}: {
  sessionId: string;
  /** 由父组件控制：输入框下面那个「定时」按钮点开时传 { open: true } */
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 有几个定时任务（父组件那个「定时」按钮要显示数字） */
  onCount?: (n: number) => void;
}) {
  const fb = useFeedback();
  const [items, setItems] = useState<SessionJob[]>([]);
  const [busy, setBusy] = useState(false);
  /** 静态导出时首屏在服务端渲染，document 还不存在 —— 挂载后才开 portal */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  /** 正在编辑的任务 id（null = 新建） */
  const [editing, setEditing] = useState<string | null>(null);

  // 表单
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"hourly" | "daily" | "weekly">("daily");
  const [hour, setHour] = useState("09");
  const [minute, setMinute] = useState("00");
  const [weekdays, setWeekdays] = useState<string[]>(["1"]);
  const [channel, setChannel] = useState<"session" | "webhook">("session");
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<"feishu" | "wecom" | "dingtalk" | "generic">("feishu");
  const [runNow, setRunNow] = useState(false);
  // 变更门：只在有变化时才跑（省钱也不刷屏）
  const [monitorKind, setMonitorKind] = useState<"" | "command" | "url">("");
  const [monitor, setMonitor] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api.sessionJobs(sessionId);
      setItems(r.items);
      onCount?.(r.items.length);
    } catch {
      /* 拉不到不打扰（下拉一次再看） */
    }
  }, [sessionId]);

  useEffect(() => {
    setItems([]);
    setEditing(null);
    void load();
  }, [sessionId, load]);

  // 有任务在跑的时候顺手刷新"上一轮"状态（20 秒够，和调度器一拍）
  useEffect(() => {
    if (items.length === 0) return;
    const t = setInterval(() => void load(), 20000);
    return () => clearInterval(t);
  }, [items.length, load]);

  const startNew = useCallback(() => {
    setEditing(null);
    setPrompt("");
    setMode("daily");
    setHour("09");
    setMinute("00");
    setWeekdays(["1"]);
    setChannel("session");
    setUrl("");
    setFormat("feishu");
    setRunNow(false);
    setMonitorKind("");
    setMonitor("");
    onOpenChange(true);
  }, [onOpenChange]);

  const startEdit = (j: SessionJob) => {
    setEditing(j.id);
    setPrompt(j.prompt);
    setMode(j.mode);
    const [h, m] = (j.at || "09:00").split(":");
    setHour(h || "09");
    setMinute(m || "00");
    setWeekdays((j.weekdays || "1").split(",").filter(Boolean));
    setChannel(j.deliver?.channel === "webhook" ? "webhook" : "session");
    setUrl(j.deliver?.url || "");
    setFormat((j.deliver?.format as typeof format) || "feishu");
    setRunNow(false);
    setMonitorKind((j.monitor_kind as "" | "command" | "url") || "");
    setMonitor(j.monitor || "");
    onOpenChange(true);
  };

  const save = async () => {
    const text = prompt.trim();
    if (!text) {
      fb.info("还差一句", "写清每次让它做什么");
      return;
    }
    if (channel === "webhook" && !/^https?:\/\//.test(url.trim())) {
      fb.info("投递地址不对", "必须以 http:// 或 https:// 开头");
      return;
    }
    if (monitorKind && !monitor.trim()) {
      fb.info("还差检查内容", "选了「只在有变化时跑」，就要说清检查什么");
      return;
    }
    setBusy(true);
    try {
      const body = {
        prompt: text,
        mode,
        at: `${hour}:${minute}`,
        weekdays: weekdays.join(",") || "1",
        enabled: true,
        deliver:
          channel === "webhook"
            ? ({ channel, url: url.trim(), format } as Record<string, string>)
            : ({ channel: "session" } as Record<string, string>),
        monitor_kind: monitorKind,
        monitor: monitorKind ? monitor.trim() : "",
      };
      const saved = editing
        ? await api.updateSessionJob(editing, body)
        : await api.createSessionJob(sessionId, body);
      onOpenChange(false);
      if (runNow) {
        try {
          await api.runJobNow(saved.id);
          fb.success("已排上，先跑了一次", "结果会出现在这个对话里");
        } catch (e) {
          fb.info("排上了，但这次没跑起来", e instanceof Error ? e.message : String(e));
        }
      } else {
        fb.success(editing ? "已保存" : "已排上", `${scheduleText(saved)} · 下次 ${whenText(saved.next_run_at)}`);
      }
      await load();
    } catch (e) {
      fb.error("没保存成功", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (j: SessionJob) => {
    try {
      await api.updateSessionJob(j.id, { enabled: !j.enabled });
      await load();
    } catch (e) {
      fb.error("改不动", e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (j: SessionJob) => {
    const ok = await fb.confirm({
      title: "删掉这个定时？",
      description: `不再自动跑；已跑出的内容不受影响`,
      confirmText: "删掉",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteSessionJob(j.id);
      await load();
      fb.success("已删除");
    } catch (e) {
      fb.error("删不掉", e instanceof Error ? e.message : String(e));
    }
  };

  const hourOpts = useMemo(() => Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")), []);
  const minOpts = useMemo(() => ["00", "15", "30", "45"], []);

  // 输入框下面的「定时」按钮（父组件渲染）+ 有任务时的常驻条 + 弹框
  const dialog = (
    <div className={DLG_BACKDROP} onClick={() => !busy && onOpenChange(false)}>
      {/*
        手机 = 底部抽屉（贴底、全宽、封顶 92dvh），桌面 = 居中卡片。
        内部拆成「固定标题 / 可滚动表单 / 固定操作条」三段 —— 表单再长，
        保存键也不会被推到滚动区外面去。
      */}
      <div
        className="card flex w-full max-w-[560px] flex-col overflow-hidden rounded-b-none rounded-t-[16px] max-h-[92dvh] sm:my-auto sm:max-h-[88dvh] sm:rounded-[14px]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题 */}
        <div className="flex shrink-0 items-center gap-2 border-b px-4 pb-2.5 pt-3" style={{ borderColor: "var(--color-border)" }}>
          <h3 className="text-[15px] font-medium">{editing ? "改定时" : "排个班"}</h3>
          <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
            {editing ? "" : "让这个对话到点自己跑"}
          </span>
          <button
            type="button"
            aria-label="关闭"
            className="ml-auto grid h-11 w-11 place-items-center rounded-lg hover:bg-[var(--color-surface-2)] lg:h-8 lg:w-8"
            style={{ color: "var(--color-muted)" }}
            onClick={() => !busy && onOpenChange(false)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {/* 表单 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <FieldLabel hint="到点它会自己发这句话">让它做什么</FieldLabel>
          <textarea
            className="input mb-4 w-full text-[16px] lg:text-[13.5px]"
            rows={3}
            placeholder="比如：汇总今天三条 AI 新闻，每条一句话，带链接"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            style={{ lineHeight: 1.55 }}
          />

          <FieldLabel>多久一次</FieldLabel>
          <div className="flex items-center gap-0.5 rounded-[11px] border p-0.5" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
            {([
              { k: "hourly", label: "每小时" },
              { k: "daily", label: "每天" },
              { k: "weekly", label: "每周" },
            ] as const).map((o) => {
              const on = o.k === mode;
              return (
                <button
                  key={o.k}
                  type="button"
                  onClick={() => setMode(o.k)}
                  className="min-h-[44px] flex-1 rounded-[8px] text-[13.5px] transition-colors lg:min-h-[36px] lg:text-[12.5px]"
                  style={{
                    background: on ? "var(--color-accent)" : undefined,
                    color: on ? "#fff" : "var(--color-muted)",
                    fontWeight: on ? 500 : undefined,
                  }}
                >
                  {o.label}
                </button>
              );
            })}
          </div>

          {mode !== "hourly" && (
            <div className="mt-2 flex items-center gap-2">
              <select
                className="input h-11 flex-1 text-[16px] lg:h-9 lg:text-[13.5px]"
                value={hour}
                onChange={(e) => setHour(e.target.value)}
                aria-label="小时"
              >
                {hourOpts.map((h) => (
                  <option key={h} value={h}>{h} 点</option>
                ))}
              </select>
              <select
                className="input h-11 flex-1 text-[16px] lg:h-9 lg:text-[13.5px]"
                value={minute}
                onChange={(e) => setMinute(e.target.value)}
                aria-label="分钟"
              >
                {minOpts.map((m) => (
                  <option key={m} value={m}>{m} 分</option>
                ))}
              </select>
            </div>
          )}

          {mode === "weekly" && (
            <div className="mt-2 grid grid-cols-7 gap-1.5">
              {WEEK.map((w) => {
                const on = weekdays.includes(w.k);
                return (
                  <button
                    key={w.k}
                    type="button"
                    data-tap
                    onClick={() => setWeekdays((prev) => (on ? prev.filter((x) => x !== w.k) : [...prev, w.k]))}
                    className="h-11 rounded-[9px] border text-[13px] transition-colors lg:h-9 lg:text-[12px]"
                    style={{
                      background: on ? "var(--color-accent)" : "var(--color-surface)",
                      color: on ? "#fff" : "var(--color-text)",
                      borderColor: on ? "var(--color-accent)" : "var(--color-border)",
                    }}
                    aria-pressed={on}
                  >
                    {w.label.replace("周", "")}
                  </button>
                );
              })}
            </div>
          )}

          <div className="mt-4">
            <FieldLabel>结果送到哪</FieldLabel>
            <div className="flex items-center gap-0.5 rounded-[11px] border p-0.5" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
              {CHANNEL_OPTS.map((o) => {
                const on = o.key === channel;
                return (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => setChannel(o.key)}
                    className="min-h-[44px] flex-1 rounded-[8px] text-[13.5px] transition-colors lg:min-h-[36px] lg:text-[12.5px]"
                    style={{
                      background: on ? "var(--color-accent)" : undefined,
                      color: on ? "#fff" : "var(--color-muted)",
                      fontWeight: on ? 500 : undefined,
                    }}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            {channel === "webhook" ? (
              <div className="mt-2 space-y-2">
                <select
                  className="input h-11 w-full text-[16px] lg:h-9 lg:text-[13.5px]"
                  value={format}
                  onChange={(e) => setFormat(e.target.value as typeof format)}
                  aria-label="报文格式"
                >
                  {FORMAT_OPTS.map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>
                <input
                  className="input h-11 w-full text-[16px] lg:h-9 lg:text-[13.5px]"
                  placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  inputMode="url"
                />
              </div>
            ) : (
              <p className="mt-1.5 text-[12px]" style={{ color: "var(--color-muted)" }}>
                结果就是这个对话里的下一轮，回来能接着追问。
              </p>
            )}
          </div>

          {/* 高级：5% 场景，不占常驻位置 */}
          <details className="mt-4 rounded-[10px] border px-3 py-2" style={{ borderColor: "var(--color-border)" }}>
            <summary className="flex min-h-[36px] cursor-pointer items-center gap-1.5 text-[12.5px]" style={{ color: "var(--color-muted)" }}>
              高级：只在有变化时才跑
              {monitorKind ? <span style={{ color: "var(--color-accent)" }}>· 已开启</span> : null}
            </summary>
            <div className="mt-2">
              <div className="flex items-center gap-0.5 rounded-[11px] border p-0.5" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
                {([
                  { k: "", label: "每次都跑" },
                  { k: "command", label: "命令" },
                  { k: "url", label: "网址" },
                ] as const).map((o) => {
                  const on = o.k === monitorKind;
                  return (
                    <button
                      key={o.k}
                      type="button"
                      onClick={() => setMonitorKind(o.k)}
                      className="min-h-[44px] flex-1 rounded-[8px] text-[13px] transition-colors lg:min-h-[36px] lg:text-[12.5px]"
                      style={{
                        background: on ? "var(--color-accent)" : undefined,
                        color: on ? "#fff" : "var(--color-muted)",
                      }}
                    >
                      {o.label}
                    </button>
                  );
                })}
              </div>
              {monitorKind ? (
                <>
                  <input
                    className="input mt-2 h-11 w-full text-[16px] lg:h-9 lg:text-[13.5px]"
                    placeholder={
                      monitorKind === "url"
                        ? "https://example.com/feed（抓它的正文来比）"
                        : "比如 git -C /srv/app log -1 --format=%h"
                    }
                    value={monitor}
                    onChange={(e) => setMonitor(e.target.value)}
                    inputMode={monitorKind === "url" ? "url" : "text"}
                  />
                  <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                    到点先跑这条检查；结果和上次一样就「整个跳过」（不调模型、不刷屏）。
                    {monitorKind === "url" ? " 地址要 http(s)。" : " 命令 20 秒内要结束。"}
                  </p>
                </>
              ) : null}
            </div>
          </details>

          <label className="mt-3 flex min-h-[44px] items-center gap-2.5 text-[13px]">
            <input
              type="checkbox"
              checked={runNow}
              onChange={(e) => setRunNow(e.target.checked)}
              className="h-[20px] w-[20px]"
            />
            保存后立刻跑一次看看
          </label>
        </div>

        {/* 操作条：始终可见。删除靠左红字，主操作靠右 —— 危险动作不和保存挨着 */}
        <div
          className="flex shrink-0 items-center gap-2 border-t px-4 py-2.5"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
        >
          {editing && (
            <button
              type="button"
              className="min-h-[36px] rounded-lg px-2 text-[13px]"
              style={{ color: "var(--color-err)" }}
              onClick={() => {
                const j = items.find((x) => x.id === editing);
                if (j) void remove(j);
              }}
            >
              删除
            </button>
          )}
          <button
            type="button"
            className="btn ml-auto px-4"
            onClick={() => !busy && onOpenChange(false)}
          >
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary px-5"
            disabled={busy || !prompt.trim()}
            onClick={() => void save()}
          >
            {busy ? "保存中…" : editing ? "保存" : "排上"}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* 常驻条：只在有定时任务时出现（空条是噪声） */}
      {items.length > 0 && (
        <div className="panel-strip max-w-3xl mx-auto mb-1.5 px-2.5 py-1.5 max-md:px-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
            <span className="panel-title inline-flex items-center gap-1">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              定时任务
            </span>
            <span style={{ color: "var(--color-muted)" }}>
              {/* 「在跑」不准确：定时任务多数时间在等下一次，不是正在执行 */}
              {items.filter((j) => j.enabled).length} 个已启用
              {items.some((j) => !j.enabled) &&
                ` · ${items.filter((j) => !j.enabled).length} 个已暂停`}
            </span>
            <button
              type="button"
              className="ml-auto rounded px-1.5 text-[11.5px] max-md:min-h-[32px]"
              style={{ color: "var(--color-accent)" }}
              onClick={startNew}
            >
              ＋ 再排一个
            </button>
          </div>
          <div className="mt-1 flex flex-col gap-0.5">
            {items.map((j) => {
              const st = j.last_status ? STATUS_TONE[j.last_status] : null;
              return (
                <div key={j.id} className="flex min-w-0 items-center gap-1 text-[12px]">
                  <button
                    type="button"
                    className="min-h-[44px] min-w-0 flex-1 truncate text-left lg:min-h-[32px]"
                    title={j.prompt}
                    onClick={() => startEdit(j)}
                  >
                    <span style={{ color: j.enabled ? "var(--color-text)" : "var(--color-muted)" }}>
                      {scheduleText(j)}
                    </span>
                    <span className="ml-1.5 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                      {" · "}
                      {j.enabled ? `下次 ${whenText(j.next_run_at)}` : "已暂停"}
                      {j.deliver?.channel === "webhook" ? " · 推送到群" : ""}
                      {j.monitor_kind ? " · 有变化才跑" : ""}
                    </span>
                  </button>
                  {st && (
                    <span className="shrink-0 text-[11px]" style={{ color: st.color }}>
                      {st.text}
                    </span>
                  )}
                  {/* 开/关用开关：比「暂停 / 恢复」两个字更像它现在的状态 */}
                  <Switch
                    checked={j.enabled}
                    onChange={() => void toggle(j)}
                    ariaLabel={j.enabled ? "暂停这个定时" : "恢复这个定时"}
                    title={j.enabled ? "正在生效，点一下暂停" : "已暂停，点一下恢复"}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/*
        用 portal 挂到 body：这个组件的挂载点在输入坞里面，而输入坞有
        backdrop-filter（毛玻璃）—— 那会让它成为 position:fixed 的参照物，
        弹框就被拽到输入坞里居中/贴底，而不是整个视口。
      */}
      {open && mounted ? createPortal(dialog, document.body) : null}
    </>
  );
}

/**
 * 输入坞工具排里的「定时」入口（附件右边那一组工具之一）。
 *
 * 以前它在最下面那行说明文字里（"Enter 发送 · … · 定时"）—— 说明里混动作，
 * 又是灰的 11.5px 无边框，触屏还没有 hover，看起来就是一句话的一部分。
 * 挪进工具栏、加边框和图标之后它才像个能点的东西。
 *
 * 已经有定时任务时不摆这个（上面那条 strip 里有「＋ 再排一个」）：
 * 同一个动作只留一个入口。
 */
export function JobButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="让这个对话按时自己跑：每天/每周到点自动执行"
      className="h-11 sm:h-8 shrink-0 inline-flex items-center gap-1 rounded-xl border px-2.5 text-[12px] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
      style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
      定时
    </button>
  );
}

