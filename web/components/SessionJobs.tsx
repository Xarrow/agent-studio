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
import { api } from "@/lib/api";
import { useFeedback } from "@/components/ui/feedback";
import { DLG_BACKDROP, DLG_CARD, Segmented } from "@/components/ui/kit";
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
      fb.info("还差一句", "写清楚每次让它做什么（比如「汇总三条 AI 新闻」）");
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
      description: `「${scheduleText(j)}」就不再自动跑了。已经跑出来的对话内容不受影响。`,
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
      <div className={`${DLG_CARD} max-w-[520px] p-4`} onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[14px] font-medium">{editing ? "改定时" : "排个班"}</h3>
          <button
            type="button"
            className="rounded px-2 py-1 text-[12px] max-md:min-h-[36px]"
            style={{ color: "var(--color-muted)" }}
            onClick={() => !busy && onOpenChange(false)}
          >
            关闭
          </button>
        </div>

        <label className="mb-1 block text-[12px]" style={{ color: "var(--color-muted)" }}>
          每次让它做什么
        </label>
        <textarea
          className="input mb-3 w-full"
          rows={2}
          placeholder="比如：汇总今天三条 AI 新闻，每条一句话，带链接"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          style={{ lineHeight: 1.6 }}
        />

        <label className="mb-1 block text-[12px]" style={{ color: "var(--color-muted)" }}>
          多久一次
        </label>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Segmented
            options={[
              { key: "hourly", label: "每小时" },
              { key: "daily", label: "每天" },
              { key: "weekly", label: "每周" },
            ]}
            value={mode}
            onChange={(k) => setMode(k)}
          />
          {mode !== "hourly" && (
            <span className="flex items-center gap-1">
              <select
                className="input"
                value={hour}
                onChange={(e) => setHour(e.target.value)}
                aria-label="小时"
              >
                {hourOpts.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
              <span style={{ color: "var(--color-muted)" }}>:</span>
              <select
                className="input"
                value={minute}
                onChange={(e) => setMinute(e.target.value)}
                aria-label="分钟"
              >
                {minOpts.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </span>
          )}
        </div>

        {mode === "weekly" && (
          <div className="mb-2 flex flex-wrap items-center gap-1">
            {WEEK.map((w) => {
              const on = weekdays.includes(w.k);
              return (
                <button
                  key={w.k}
                  type="button"
                  data-tap
                  onClick={() =>
                    setWeekdays((prev) => (on ? prev.filter((x) => x !== w.k) : [...prev, w.k]))
                  }
                  className="rounded-[7px] border px-2.5 text-[12px] max-md:min-h-[36px]"
                  style={{
                    minHeight: 32,
                    background: on ? "var(--color-accent)" : "var(--color-surface)",
                    color: on ? "#fff" : "var(--color-text)",
                    borderColor: "var(--color-border)",
                  }}
                >
                  {w.label}
                </button>
              );
            })}
          </div>
        )}

        <label className="mb-1 mt-3 block text-[12px]" style={{ color: "var(--color-muted)" }}>
          什么时候才真跑
        </label>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Segmented
            options={[
              { key: "", label: "每次都跑" },
              { key: "command", label: "命令输出变了才跑" },
              { key: "url", label: "网址内容变了才跑" },
            ]}
            value={monitorKind}
            onChange={(k) => setMonitorKind(k as "" | "command" | "url")}
          />
        </div>
        {monitorKind ? (
          <>
            <input
              className="input mb-1 w-full"
              placeholder={
                monitorKind === "url"
                  ? "https://example.com/feed（抓它的正文来比）"
                  : "比如 git -C /srv/app log -1 --format=%h"
              }
              value={monitor}
              onChange={(e) => setMonitor(e.target.value)}
              inputMode={monitorKind === "url" ? "url" : "text"}
            />
            <p className="mb-1 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
              到点时先跑这条检查；结果和上次一样就「整个跳过」（不调模型、不刷屏）。
              {monitorKind === "url" ? " 地址要 http(s)。" : " 命令 20 秒内要结束。"}
            </p>
          </>
        ) : null}

        <label className="mb-1 mt-2 block text-[12px]" style={{ color: "var(--color-muted)" }}>
          结果送到哪
        </label>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Segmented options={CHANNEL_OPTS} value={channel} onChange={(k) => setChannel(k)} />
          {channel === "webhook" && (
            <select
              className="input"
              value={format}
              onChange={(e) => setFormat(e.target.value as typeof format)}
              aria-label="报文格式"
            >
              {FORMAT_OPTS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          )}
        </div>
        {channel === "webhook" ? (
          <input
            className="input mb-1 w-full"
            placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            inputMode="url"
          />
        ) : (
          <p className="mb-1 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
            结果就是这个对话里的下一轮，回来能接着追问。
          </p>
        )}

        <label className="mt-3 flex min-h-[36px] items-center gap-2 text-[12px]">
          <input
            type="checkbox"
            checked={runNow}
            onChange={(e) => setRunNow(e.target.checked)}
            className="h-[18px] w-[18px]"
          />
          保存后立刻跑一次看看
        </label>

        <div className="mt-4 flex items-center gap-2">
          {editing && (
            <button
              type="button"
              className="rounded px-2 text-[12px] max-md:min-h-[36px]"
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
            className="btn ml-auto max-md:min-h-[40px]"
            disabled={busy}
            onClick={() => void save()}
            style={{ minWidth: 92 }}
          >
            {busy ? "保存中…" : "保存"}
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
              {items.filter((j) => j.enabled).length} 个在跑
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
                <div key={j.id} className="flex min-w-0 items-center gap-2 text-[12px]">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left hover:underline max-md:min-h-[32px]"
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
                  <button
                    type="button"
                    className="shrink-0 rounded border px-1.5 text-[11px] max-md:min-h-[32px]"
                    style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}
                    onClick={() => void toggle(j)}
                    title={j.enabled ? "暂停" : "恢复"}
                  >
                    {j.enabled ? "暂停" : "恢复"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {open && dialog}
    </>
  );
}

/** 输入框下面那个「定时」按钮（父组件放，点击打开上面的弹框） */
export function JobButton({ count, onClick }: { count: number; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      title="定时：让这个对话按时自己跑"
      className="inline-flex items-center gap-1 rounded px-1.5 text-[11.5px] hover:underline max-md:min-h-[32px]"
      style={{ color: count > 0 ? "var(--color-accent)" : "var(--color-muted)" }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
      定时{count > 0 ? ` ${count}` : ""}
    </button>
  );
}

