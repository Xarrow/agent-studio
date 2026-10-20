"use client";

/**
 * 后台任务条 —— 会话里跑着的「活过这一轮」的进程。
 *
 * 为什么要有这一条
 * ----------------
 * 助手现在能把长活（构建、训练、批量下载）丢进后台（proc_start），
 * 但它不会一直替你盯着：这一轮结束、你关了页面、甚至服务重启，进程都还在跑。
 * 所以界面上必须有一处**常驻**的地方回答三个问题：
 *   在跑什么 / 跑了多久 / 完事了没有（退出码多少、输出是什么）。
 *
 * 设计口径（与「本会话文件」那条一致）
 * ------------------------------------
 * · 没有后台任务时**整条不出现** —— 空的常驻条是噪声
 * · 只有一条标题行，点开看每个任务；再点某个任务看它的日志尾部
 * · 跑完的会弹一次提示（从 running 变成结束才弹，不会每次刷新都弹）
 * · 手机 36px 点击高度、图标内联 SVG
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useFeedback } from "@/components/ui/feedback";
import type { BgProcInfo } from "@/lib/types";

const STATUS_TEXT: Record<BgProcInfo["status"], string> = {
  running: "在跑",
  exited: "完成",
  failed: "失败",
  killed: "已停止",
  unknown: "状态不明",
};

/** 秒 → 人话：45 秒 / 3 分 20 秒 / 1 小时 5 分 */
function hum(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m} 分 ${r} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h} 小时 ${mm} 分` : `${h} 小时`;
}

const STATUS_COLOR: Record<BgProcInfo["status"], string> = {
  running: "var(--color-accent)",
  exited: "var(--color-ok)",
  failed: "var(--color-err)",
  killed: "var(--color-muted)",
  unknown: "var(--color-muted)",
};

export default function BgProcsStrip({
  sessionId,
  busy = false,
}: {
  sessionId: string;
  /** 这一轮在执行 —— 期间要盯（助手可能刚起了个后台任务） */
  busy?: boolean;
}) {
  const fb = useFeedback();
  const [items, setItems] = useState<BgProcInfo[]>([]);
  const [open, setOpen] = useState(true);
  /** 展开日志的那个任务 id（一次只开一个） */
  const [logFor, setLogFor] = useState<string | null>(null);
  const [logText, setLogText] = useState("");
  const [logBusy, setLogBusy] = useState(false);
  const [killing, setKilling] = useState<string | null>(null);

  /** 上一次看到的状态 —— 用来判断"刚刚跑完"，只在变化时提示一次 */
  const prevStatus = useRef<Record<string, string>>({});
  const initial = useRef(true);

  const running = items.filter((i) => i.status === "running").length;

  const load = useCallback(async () => {
    try {
      const res = await api.procs(sessionId);
      setItems(res.items);
      // 刚跑完的提示一次（第一次加载不提示，不然一进页面就刷一堆）
      if (!initial.current) {
        for (const it of res.items) {
          const was = prevStatus.current[it.id];
          if (was === "running" && it.status !== "running") {
            if (it.status === "exited") {
              fb.success(
                `后台任务完成：${it.label}`,
                `跑了 ${Math.round(it.elapsed_s)} 秒，退出码 ${it.exit_code ?? 0}`,
              );
            } else if (it.status === "failed") {
              fb.error(
                `后台任务失败：${it.label}`,
                `退出码 ${it.exit_code ?? "?"}，点开看日志`,
              );
            }
          }
        }
      }
      prevStatus.current = Object.fromEntries(res.items.map((i) => [i.id, i.status]));
      initial.current = false;
    } catch {
      /* 列表拉不到不打扰用户（下一拍再试） */
    }
  }, [sessionId]);

  useEffect(() => {
    initial.current = true;
    prevStatus.current = {};
    void load();
    return () => setItems([]);
  }, [sessionId, load]);

  // 什么时候要盯：
  //   · 有任务在跑 → 每 3 秒（等它结束）
  //   · 这一轮正在执行 → 也每 3 秒（助手随时可能刚起一个，之前只在"有任务"时轮询，
  //     结果第一轮起了任务界面上却一直不出现 —— 起点就是这里漏了）
  useEffect(() => {
    if (running === 0 && !busy) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [running, busy, load]);

  // 一轮结束的那一下补一拍：刚起完任务就收尾是最常见的时机
  useEffect(() => {
    if (!busy) void load();
  }, [busy, load]);

  const openLog = async (it: BgProcInfo) => {
    if (logFor === it.id) {
      setLogFor(null);
      return;
    }
    setLogFor(it.id);
    setLogText("");
    setLogBusy(true);
    try {
      const res = await api.procLog(it.id, sessionId, 200);
      setLogText(res.text || "（还没有输出）");
    } catch (e) {
      setLogText(`读日志失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLogBusy(false);
    }
  };

  const kill = async (it: BgProcInfo) => {
    setKilling(it.id);
    try {
      await api.procKill(it.id, sessionId);
      fb.success("已停止", `${it.label}（连同它的子进程）`);
      await load();
    } catch (e) {
      fb.error("停止失败", e instanceof Error ? e.message : String(e));
    } finally {
      setKilling(null);
    }
  };

  if (items.length === 0) return null;

  return (
    <div
      className="max-w-3xl mx-auto mb-1.5 rounded-[12px] border px-2.5 py-1.5 max-md:px-2"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
    >
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]"
        style={{ color: "var(--color-muted)" }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? "收起后台任务" : "展开后台任务"}
          className="shrink-0 rounded p-0.5 hover:bg-[var(--color-surface)] max-md:inline-flex max-md:min-h-[32px] max-md:min-w-[32px] max-md:items-center max-md:justify-center"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform .15s ease" }}
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 hover:underline max-md:inline-flex max-md:min-h-[32px] max-md:items-center"
        >
          后台任务
        </button>
        <span className="inline-flex items-center gap-1">
          {running > 0 && (
            <span
              className="live-dot"
              style={{
                width: 5,
                height: 5,
                borderRadius: 999,
                background: "var(--color-accent)",
                display: "inline-block",
              }}
            />
          )}
          {running > 0 ? `${running} 个在跑` : "没有在跑的"}
          {items.length > running ? ` · 共 ${items.length} 个` : ""}
        </span>
      </div>

      {open && (
        <div className="mt-1.5 flex flex-col gap-1">
          {items.map((it) => (
            <div key={it.id} className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
                <span
                  className={it.status === "running" ? "live-dot" : ""}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: STATUS_COLOR[it.status],
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                  aria-hidden="true"
                />
                <button
                  type="button"
                  onClick={() => void openLog(it)}
                  className="min-w-0 flex-1 truncate text-left hover:underline max-md:inline-flex max-md:min-h-[32px] max-md:items-center"
                  title={`${it.command}\n点开看日志`}
                >
                  {it.label}
                </button>
                <span
                  className="shrink-0 text-[11px] tabular-nums"
                  style={{ color: STATUS_COLOR[it.status] }}
                  title={it.status === "running" ? "已跑" : "用时"}
                >
                  {STATUS_TEXT[it.status]}
                  {it.status === "running"
                    ? ` · ${hum(it.elapsed_s)}`
                    : it.exit_code !== null && it.status !== "exited"
                      ? ` · 退出码 ${it.exit_code} · ${hum(it.elapsed_s)}`
                      : ` · ${hum(it.elapsed_s)}`}
                </span>
                {it.status === "running" && (
                  <button
                    type="button"
                    data-tap
                    className="shrink-0 rounded px-1.5 text-[11.5px] max-md:inline-flex max-md:min-h-[32px] max-md:items-center"
                    style={{
                      border: "1px solid var(--color-border)",
                      background: "var(--color-surface)",
                      color: "var(--color-err)",
                    }}
                    disabled={killing === it.id}
                    onClick={() => void kill(it)}
                    title="停掉这个后台任务（连同子进程）"
                  >
                    {killing === it.id ? "停止中…" : "停止"}
                  </button>
                )}
              </div>
              {logFor === it.id && (
                <pre
                  className="mono mt-1 max-h-[180px] overflow-auto whitespace-pre-wrap break-words rounded-lg px-2 py-1.5 text-[11px] leading-[1.5]"
                  style={{
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    color: "var(--color-text)",
                  }}
                >
                  {logBusy ? "读日志中…" : logText}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
