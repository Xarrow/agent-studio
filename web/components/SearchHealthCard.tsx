"use client";

/**
 * 「内置搜索」状态卡 —— 让"搜索通道坏了"这件事在界面上能看见。
 *
 * 为什么值得单独一块：
 *   web_search 用的是别人的页面（腾讯搜索卡片接口 / Bing RSS）。它们改结构、
 *   封 IP、限流都不会通知我们，表现是"查询返回 200，内容却是无关的固定池结果"。
 *   用户那边的感受是"这 AI 说的东西查不到出处"，而平台看起来一切正常。
 *
 * 交互口径：
 *   · 只读上次自检结果，页面加载不顺带发网络请求；
 *   · 「立即检测」才真搜一次（两次探针，约 1~3 秒），结果就地刷新；
 *   · 失败给的是"哪一句没问出来 + 相关度 + 耗时"，不是一句"异常"。
 */

import { useEffect, useState } from "react";
import { api, fmt } from "@/lib/api";

type Probe = {
  query: string;
  ok: boolean;
  latency_ms: number;
  relevance: number;
  first: string;
  error: string;
};

type Health = {
  ok: boolean | null;
  checked_at: number;
  engine: string;
  interval_s: number;
  threshold: number;
  probes: Probe[];
};

export function SearchHealthCard() {
  const [h, setH] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .searchHealth()
      .then((x) => alive && setH(x))
      .catch(() => alive && setErr("状态读取失败"));
    return () => {
      alive = false;
    };
  }, []);

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setH(await api.checkSearchHealth());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const tone =
    h?.ok === true
      ? "var(--color-ok)"
      : h?.ok === false
        ? "var(--color-danger)"
        : "var(--color-muted)";

  const title =
    h?.ok === true ? "可用" : h?.ok === false ? "异常" : h ? "还没自检" : "读取中…";

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: tone }} />
          <span style={{ color: tone }}>{title}</span>
        </span>
        <span className="text-[var(--color-text-3)]">
          引擎 {h?.engine ?? "—"}
          {h?.checked_at ? ` · 上次自检 ${fmt.relative(h.checked_at)}` : ""}
          {h ? ` · 频率 ${Math.round(h.interval_s / 3600)} 小时` : ""}
        </span>
        <button className="btn btn-sm ml-auto" disabled={busy} onClick={() => void run()}>
          {busy ? "检测中…" : "立即检测"}
        </button>
      </div>

      {h && h.probes.length > 0 && (
        <div className="space-y-1">
          {h.probes.map((p) => (
            <div key={p.query} className="flex flex-wrap items-baseline gap-2 text-[11.5px]">
              <span
                className="shrink-0 tabular-nums"
                style={{ color: p.ok ? "var(--color-ok)" : "var(--color-danger)" }}
              >
                {p.ok ? "✓" : "✕"}
              </span>
              <span className="truncate text-[var(--color-text-2)]">{p.query}</span>
              <span className="tabular-nums text-[var(--color-text-3)]">
                相关度 {p.relevance.toFixed(2)} · {p.latency_ms}ms
              </span>
              <span className="min-w-0 flex-1 truncate text-[var(--color-text-3)]" title={p.first || p.error}>
                {p.first || p.error}
              </span>
            </div>
          ))}
        </div>
      )}

      <p className="text-[11.5px] leading-relaxed text-[var(--color-muted)]">
        自检用两句固定查询真实搜索一次（一句中文、一句英文），看首条结果里命中了多少查询词。
        低于 {h?.threshold ?? 0.5} 或超过 8 秒即判异常 —— 这通常意味着搜索源改了结构或封了请求，
        Agent 的 web_search 会开始返回无关内容。
      </p>

      {err && (
        <p className="text-[11.5px]" style={{ color: "var(--color-danger)" }}>
          {err}
        </p>
      )}
    </div>
  );
}
