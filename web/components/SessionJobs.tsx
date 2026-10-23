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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

/** 「什么时候跑」先说整句 —— 只列几个真用得上的，剩下的走「自定义…」 */
const DAILY_PRESETS = [
  { key: "d-09", label: "每天 09:00", at: "09:00" },
  { key: "d-12", label: "每天 12:00", at: "12:00" },
  { key: "d-18", label: "每天 18:00", at: "18:00" },
  { key: "d-21", label: "每天 21:00", at: "21:00" },
];
const WEEKLY_PRESETS = [
  { key: "w-1-09", label: "每周一 09:00", at: "09:00", wd: "1" },
  { key: "w-5-18", label: "每周五 18:00", at: "18:00", wd: "5" },
  { key: "w-135-09", label: "每周一三五 09:00", at: "09:00", wd: "1,3,5" },
];

/**
 * 节奏选择器：一个下拉说完整句（每天 09:00 / 每周一三五 09:00 / 每小时）。
 * 选了「自定义…」才把时间、星期这些零件露出来 —— 零件不该是第一个问题。
 */
function RhythmPicker({
  value,
  onChange,
  custom,
}: {
  value: string;
  onChange: (k: string) => void;
  custom?: ReactNode;
}) {
  return (
    <>
      <select
        className="input h-9 w-full lg:h-9"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="多久跑一次"
      >
        <option value="hourly">每小时</option>
        {DAILY_PRESETS.map((p) => (
          <option key={p.key} value={p.key}>{p.label}</option>
        ))}
        {WEEKLY_PRESETS.map((p) => (
          <option key={p.key} value={p.key}>{p.label}</option>
        ))}
        <option value="custom">自定义…</option>
      </select>
      {value === "custom" ? custom : null}
    </>
  );
}

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
  draft,
}: {
  sessionId: string;
  /** 输入框里正在写的字 —— 打开时直接带进「排新班」，不用再打一遍 */
  draft?: string;
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
  // （「保存后立刻跑一次」改成卡片上的「跑一次」按钮，随时可验证）
  // 变更门：只在有变化时才跑（省钱也不刷屏）
  const [monitorKind, setMonitorKind] = useState<"" | "command" | "url">("");
  const [monitor, setMonitor] = useState("");
  const [rhythmCustom, setRhythmCustom] = useState(false);

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

  // 打开抽屉时，把输入坞里正在写的那句话带进来 —— 用户的本意就是「把这句话变成每天的」
  useEffect(() => {
    if (!open) return;
    setEditing(null);
    setPrompt((prev) => prev.trim() ? prev : (draft ?? "").trim());
  }, [open, draft]);

  // 有任务在跑的时候顺手刷新"上一轮"状态（20 秒够，和调度器一拍）
  useEffect(() => {
    if (items.length === 0) return;
    const t = setInterval(() => void load(), 20000);
    return () => clearInterval(t);
  }, [items.length, load]);

  /** 回到「排新班」状态（清空表单，不关抽屉） */
  const resetForm = useCallback(() => {
    setEditing(null);
    setRhythmCustom(false);
    setPrompt("");
    setMode("daily");
    setHour("09");
    setMinute("00");
    setWeekdays(["1"]);
    setChannel("session");
    setUrl("");
    setFormat("feishu");
    setMonitorKind("");
    setMonitor("");
  }, []);

  const startNew = useCallback(() => {
    setEditing(null);
    setRhythmCustom(false);
    setPrompt("");
    setMode("daily");
    setHour("09");
    setMinute("00");
    setWeekdays(["1"]);
    setChannel("session");
    setUrl("");
    setFormat("feishu");
    setMonitorKind("");
    setMonitor("");
    onOpenChange(true);
  }, [onOpenChange]);

  const startEdit = (j: SessionJob) => {
    setEditing(j.id);
    setRhythmCustom(false); // 先按它自己的值算：能对上预设就显示预设，对不上自然落"自定义…"
    setPrompt(j.prompt);
    setMode(j.mode);
    const [h, m] = (j.at || "09:00").split(":");
    setHour(h || "09");
    setMinute(m || "00");
    setWeekdays((j.weekdays || "1").split(",").filter(Boolean));
    setChannel(j.deliver?.channel === "webhook" ? "webhook" : "session");
    setUrl(j.deliver?.url || "");
    setFormat((j.deliver?.format as typeof format) || "feishu");
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
      fb.success(editing ? "已保存" : "已排上", `${scheduleText(saved)} · 下次 ${whenText(saved.next_run_at)}`);
      // 排上之后不关抽屉：能立刻看到它进了下面的列表，也能接着排第二条
      if (editing) onOpenChange(false);
      else resetForm();
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

  /** 立刻跑一次（验证它到底会产出什么） */
  const runJobNow = async (j: SessionJob) => {
    try {
      await api.runJobNow(j.id);
      fb.success("已经跑起来了", "结果会出现在这个对话里");
      await load();
    } catch (e) {
      fb.error("没跑起来", e instanceof Error ? e.message : String(e));
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
  /* ── 节奏：几个枚举好的选项 + 自定义 ───────────────────────────────────
     用户脑子里是「每天 9 点」这种整句，不是 mode/at/weekdays 三个字段。
     所以先说整句，只有选了「自定义…」才暴露时间/星期这些零件。 */
  const rhythmKey = (m: string, h: string, mi: string, wd: string) => {
    if (m === "hourly") return "hourly";
    if (m === "daily") {
      const hit = DAILY_PRESETS.find((x) => x.at === `${h}:${mi}`);
      return hit ? hit.key : "custom";
    }
    const one = wd.split(",").filter(Boolean);
    const hit = WEEKLY_PRESETS.find((x) => x.at === `${h}:${mi}` && x.wd === one.join(","));
    return hit ? hit.key : "custom";
  };
  /* rhythm 是从 mode/时间/星期派生出来的；「自定义…」本身没有对应的值可存，
     所以单独记一个开关 —— 否则一选就被算回预设值，下拉弹回去（报过的 bug）。 */
  const rhythm = rhythmCustom ? "custom" : rhythmKey(mode, hour, minute, weekdays.join(","));
  const applyRhythm = (k: string) => {
    if (k === "custom") {
      setRhythmCustom(true);
      return;
    }
    setRhythmCustom(false);
    const daily = DAILY_PRESETS.find((x) => x.key === k);
    if (daily) {
      setMode("daily");
      setHour(daily.at.split(":")[0]);
      setMinute(daily.at.split(":")[1]);
      return;
    }
    const weekly = WEEKLY_PRESETS.find((x) => x.key === k);
    if (weekly) {
      setMode("weekly");
      setHour(weekly.at.split(":")[0]);
      setMinute(weekly.at.split(":")[1]);
      setWeekdays(weekly.wd.split(","));
      return;
    }
    if (k === "hourly") setMode("hourly");
    // custom：保持原值，露出下面的时间/星期控件
  };

  /** 一张定时卡：说清「什么时候、做什么、结果去哪」，点「改」就地展开编辑 */
  const jobCard = (j: SessionJob) => {
    const editingThis = editing === j.id;
    const st = j.last_status ? STATUS_TONE[j.last_status] : null;
    return (
      <div
        key={j.id}
        className="rounded-[12px] border px-3 py-2.5"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-medium" style={{ color: j.enabled ? "var(--color-text)" : "var(--color-muted)" }}>
            {scheduleText(j)}
          </span>
          <span className="text-[11.5px]" style={{ color: j.enabled ? "var(--color-muted)" : "var(--color-warn)" }}>
            {j.enabled ? `下次 ${whenText(j.next_run_at)}` : "已暂停"}
          </span>
          {st ? (
            <span className="text-[11px]" style={{ color: st.color }}>{st.text}</span>
          ) : null}
          <div className="ml-auto">
            <Switch
              checked={j.enabled}
              onChange={() => void toggle(j)}
              ariaLabel={j.enabled ? "暂停这个定时" : "恢复这个定时"}
            />
          </div>
        </div>

        <p className="mt-0.5 text-[12.5px] leading-snug" style={{ color: j.enabled ? "var(--color-text)" : "var(--color-muted)" }}>
          {j.prompt}
        </p>

        <div className="mt-1 flex items-center gap-2 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
          <span>
            {j.deliver?.channel === "webhook" ? "推到群里" : "结果回到这个对话"}
            {j.monitor_kind ? " · 有变化才跑" : ""}
          </span>
          <button
            type="button"
            className="ml-auto min-h-[30px] rounded px-2.5 text-[12.5px] max-md:min-h-[36px]"
            style={{ color: "var(--color-accent)" }}
            onClick={() => (editingThis ? resetForm() : startEdit(j))}
          >
            {editingThis ? "收起" : "改"}
          </button>
          {/* 想看看它到底跑出什么，不用等下一次 */}
          <button
            type="button"
            className="min-h-[30px] rounded px-2.5 text-[12.5px] max-md:min-h-[36px]"
            style={{ color: "var(--color-muted)" }}
            onClick={() => void runJobNow(j)}
          >
            跑一次
          </button>
        </div>

        {editingThis && (
          <div className="mt-2 border-t pt-2.5" style={{ borderColor: "var(--color-border)" }}>
            <FieldLabel hint="到点它会自己发这句话">让它做什么</FieldLabel>
            <textarea
              className="input mb-2.5 w-full"
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              style={{ lineHeight: 1.5 }}
            />
            <FieldLabel>什么时候跑</FieldLabel>
            <RhythmPicker
              value={rhythm}
              onChange={applyRhythm}
              custom={
                <>
                  {mode !== "hourly" && (
                    <div className="mt-2 flex items-center gap-2">
                      <select className="input h-9 flex-1 lg:h-9" value={hour} onChange={(e) => setHour(e.target.value)} aria-label="小时">
                        {hourOpts.map((h) => <option key={h} value={h}>{h} 点</option>)}
                      </select>
                      <select className="input h-9 flex-1 lg:h-9" value={minute} onChange={(e) => setMinute(e.target.value)} aria-label="分钟">
                        {minOpts.map((m) => <option key={m} value={m}>{m} 分</option>)}
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
                            className="h-9 rounded-[9px] border text-[13px] lg:h-9"
                            style={{
                              background: on ? "var(--color-accent)" : "var(--color-surface)",
                              color: on ? "#fff" : "var(--color-text)",
                              borderColor: on ? "var(--color-accent)" : "var(--color-border)",
                            }}
                            aria-pressed={on}
                          >
                            {w.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              }
            />
            <div className="mt-2.5 flex items-center gap-2">
              <select
                className="input h-9 flex-1 lg:h-9"
                value={channel === "webhook" ? "webhook" : "session"}
                onChange={(e) => setChannel(e.target.value as "session" | "webhook")}
                aria-label="结果送到哪"
              >
                <option value="session">结果回到这个对话</option>
                <option value="webhook">推到群（Webhook）</option>
              </select>
              {channel === "webhook" && (
                <select
                  className="input h-9"
                  value={format}
                  onChange={(e) => setFormat(e.target.value as typeof format)}
                  aria-label="报文格式"
                >
                  {FORMAT_OPTS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              )}
            </div>
            {channel === "webhook" && (
              <input
                className="input mt-2 h-9 w-full lg:h-9"
                placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                inputMode="url"
              />
            )}

            <details className="mt-2.5 rounded-[10px] border px-2.5 py-1.5" style={{ borderColor: "var(--color-border)" }}>
              <summary className="flex min-h-[36px] cursor-pointer items-center gap-1.5 text-[12.5px] lg:min-h-[30px]" style={{ color: "var(--color-muted)" }}>
                只在有变化时才跑
                {monitorKind ? <span style={{ color: "var(--color-accent)" }}>· 已开启</span> : null}
              </summary>
              <div className="mt-1.5">
                <select
                  className="input h-9 w-full lg:h-9"
                  value={monitorKind}
                  onChange={(e) => setMonitorKind(e.target.value as "" | "command" | "url")}
                  aria-label="变更门"
                >
                  <option value="">每次都跑</option>
                  <option value="command">命令输出变了才跑</option>
                  <option value="url">网址内容变了才跑</option>
                </select>
                {monitorKind ? (
                  <>
                    <input
                      className="input mt-2 h-9 w-full lg:h-9"
                      placeholder={monitorKind === "url" ? "https://example.com/feed" : "比如 git -C /srv/app log -1 --format=%h"}
                      value={monitor}
                      onChange={(e) => setMonitor(e.target.value)}
                      inputMode={monitorKind === "url" ? "url" : "text"}
                    />
                    <p className="mt-1 text-[11px]" style={{ color: "var(--color-muted)" }}>
                      结果和上次一样就「整个跳过」（不调模型、不刷屏）。
                    </p>
                  </>
                ) : null}
              </div>
            </details>

            <div className="mt-2.5 flex items-center gap-2">
              <button
                type="button"
                className="min-h-[36px] rounded-lg px-2.5 text-[13px] lg:min-h-[30px]"
                style={{ color: "var(--color-err)" }}
                onClick={() => void remove(j)}
              >
                删除
              </button>
              <button
                type="button"
                className="btn btn-primary ml-auto px-4"
                disabled={busy || !prompt.trim()}
                onClick={() => void save()}
              >
                {busy ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  /*
    抽屉 = 两件事：
      上：排新班（一句话 + 什么时候跑 + 一个按钮就排上）
      下：已经在跑的（卡片列表，点「改」就地展开）
    没有第二层弹框，也不再把四段表单一次性怼到脸上。
  */
  const dialog = (
    <div className={DLG_BACKDROP} onClick={() => !busy && onOpenChange(false)}>
      <div
        className="card flex w-full max-w-[560px] flex-col overflow-hidden rounded-b-none rounded-t-[16px] max-h-[92dvh] sm:my-auto sm:max-h-[88dvh] sm:rounded-[14px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b px-4 pb-2.5 pt-3" style={{ borderColor: "var(--color-border)" }}>
          <h3 className="text-[15px] font-medium">这个对话的班表</h3>
          <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
            到点自己跑
          </span>
          <button
            type="button"
            aria-label="关闭"
            className="ml-auto grid h-9 w-9 place-items-center rounded-lg hover:bg-[var(--color-surface-2)]"
            style={{ color: "var(--color-muted)" }}
            onClick={() => !busy && onOpenChange(false)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* 排新班 */}
          {editing === null && (
            <div className="mb-3">
              <textarea
                className="input w-full"
                rows={2}
                placeholder="到点让它做什么？比如：汇总今天三条 AI 新闻，每条一句话，带链接"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                style={{ lineHeight: 1.55 }}
              />
              <div className="mt-2 flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <RhythmPicker value={rhythm} onChange={applyRhythm} />
                </div>
                <button
                  type="button"
                  className="btn btn-primary shrink-0 px-4"
                  disabled={busy || !prompt.trim()}
                  onClick={() => void save()}
                >
                  {busy ? "…" : "排上"}
                </button>
              </div>
              {rhythm === "custom" && (
                <div className="mt-2">
                  <div className="flex items-center gap-2">
                    <select className="input h-9 flex-1 lg:h-9" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} aria-label="频率">
                      <option value="hourly">每小时</option>
                      <option value="daily">每天</option>
                      <option value="weekly">每周</option>
                    </select>
                    {mode !== "hourly" && (
                      <>
                        <select className="input h-9" value={hour} onChange={(e) => setHour(e.target.value)} aria-label="小时">
                          {hourOpts.map((h) => <option key={h} value={h}>{h} 点</option>)}
                        </select>
                        <select className="input h-9" value={minute} onChange={(e) => setMinute(e.target.value)} aria-label="分钟">
                          {minOpts.map((m) => <option key={m} value={m}>{m} 分</option>)}
                        </select>
                      </>
                    )}
                  </div>
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
                            className="h-9 rounded-[9px] border text-[13px] lg:h-9"
                            style={{
                              background: on ? "var(--color-accent)" : "var(--color-surface)",
                              color: on ? "#fff" : "var(--color-text)",
                              borderColor: on ? "var(--color-accent)" : "var(--color-border)",
                            }}
                            aria-pressed={on}
                          >
                            {w.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 已经在跑的 */}
          {items.length > 0 && (
            <>
              <div className="mb-1.5 flex items-center gap-2 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                <span className="panel-title" style={{ fontSize: 11.5 }}>
                  已经在跑
                </span>
                <span>{items.filter((j) => j.enabled).length} 个</span>
                <button
                  type="button"
                  className="ml-auto min-h-[30px] rounded px-2.5 text-[12px] max-md:min-h-[36px]"
                  style={{ color: "var(--color-accent)" }}
                  onClick={() => resetForm()}
                >
                  ＋ 再排一个
                </button>
              </div>
              <div className="flex flex-col gap-1.5">{items.map((j) => jobCard(j))}</div>
            </>
          )}
          {items.length === 0 && editing === null && (
            <p className="mt-1 text-[12px]" style={{ color: "var(--color-muted)" }}>
              还没有班。上面写一句、选个时间，就是一条。
            </p>
          )}
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
            {/* 标题本身就是「打开班表」的入口：有任务时工具排那个按钮就不摆了，
                但列表得有地方看得到 */}
            <button
              type="button"
              className="panel-title inline-flex items-center gap-1 rounded max-md:min-h-[36px]"
              onClick={() => {
                resetForm();
                onOpenChange(true);
              }}
              title="打开班表：看全部、改时间、再排一个"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              定时任务
            </button>
            <span style={{ color: "var(--color-muted)" }}>
              {/* 「在跑」不准确：定时任务多数时间在等下一次，不是正在执行 */}
              {items.filter((j) => j.enabled).length} 个已启用
              {items.some((j) => !j.enabled) &&
                ` · ${items.filter((j) => !j.enabled).length} 个已暂停`}
            </span>
            <button
              type="button"
              className="ml-auto min-h-[30px] rounded px-2.5 text-[12px] max-md:min-h-[36px]"
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
                    className="min-h-[36px] min-w-0 flex-1 truncate text-left"
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
      className="h-9 sm:h-8 shrink-0 inline-flex items-center gap-1 rounded-xl border px-2.5 text-[12px] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
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

