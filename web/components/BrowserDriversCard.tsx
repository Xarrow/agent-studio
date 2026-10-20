"use client";

/**
 * 浏览器驱动 —— 环境配置里的"内核在哪、是哪个版本"。
 *
 * 为什么要有这一块
 * ----------------
 * 浏览器的路径以前写死在代码里（``/usr/bin/chromium``）。系统包一升级、
 * 或者要试一个新版本（新内核修了某个站点的 TLS/字体问题），现场既看不见
 * "现在用的到底是哪个"，也没地方换 —— 只能改代码 + 重启。
 *
 * 两种协议，别混着讲
 * ----------------
 * · **CDP**：Chromium 系（Chromium / Chrome / Brave / Edge）。平台的浏览器工具就是按它写的。
 * · **BiDi**：Firefox 从 129 起只认这个（W3C 标准）。这里也能真跑 —— 动作、读正文、
 *   截图、点击都走同一套接口，只是底层换成了 BiDi。
 *
 * 布局：一行一个驱动（引擎 / 版本 / 协议 / 来源 / 动作常驻），装新版本在下面单独一段。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import type { BrowserDriverEngine, BrowserDriverRow } from "@/lib/api";
import { useFeedback } from "@/components/ui/feedback";

const PROTO_LABEL: Record<string, string> = { cdp: "CDP", bidi: "BiDi" };

export function BrowserDriversCard() {
  const fb = useFeedback();
  const [active, setActive] = useState<BrowserDriverRow | null>(null);
  const [rows, setRows] = useState<BrowserDriverRow[]>([]);
  const [engines, setEngines] = useState<BrowserDriverEngine[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  /** 装新版本：引擎 → 版本清单 → 进度 */
  const [kind, setKind] = useState("");
  const [versions, setVersions] = useState<{ version: string; url: string; stable: boolean }[]>([]);
  const [version, setVersion] = useState("");
  const [job, setJob] = useState<{ phase: string; percent: number; status: string } | null>(null);
  const [vLoading, setVLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.browserDrivers();
      setActive(d.active);
      setRows(d.installed);
      setEngines(d.engines.filter((e) => e.managed));
    } catch (e) {
      fb.error("读取浏览器驱动失败", e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // fb 不进依赖：useFeedback() 每次渲染给新对象，进依赖会无限重取
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  /** 选中引擎后拉它能装的版本（官方清单） */
  const pickKind = async (k: string) => {
    setKind(k);
    setVersion("");
    setVersions([]);
    if (!k) return;
    setVLoading(true);
    try {
      const d = await api.browserVersions(k);
      setVersions(d.items);
      setVersion((d.items.find((x) => x.stable) || d.items[0])?.version ?? "");
      if (d.items.length === 0 && d.note) fb.info("这个引擎", d.note);
    } catch (e) {
      fb.error("拿不到版本清单", e instanceof Error ? e.message : String(e));
    } finally {
      setVLoading(false);
    }
  };

  const install = async () => {
    const target = versions.find((v) => v.version === version);
    if (!target) return;
    setBusy(true);
    setJob({ phase: "准备", percent: 0, status: "running" });
    try {
      const j = await api.browserInstall(kind, target.version, target.url);
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(async () => {
        try {
          const s = await api.browserInstallStatus(j.id);
          setJob({ phase: s.phase, percent: s.percent, status: s.status });
          if (s.status === "ok") {
            if (timer.current) clearInterval(timer.current);
            timer.current = null;
            setJob(null);
            setBusy(false);
            fb.success("装好了", `${kind === "firefox" ? "Firefox" : "Chrome"} ${target.version}`);
            await load();
          } else if (s.status === "error") {
            if (timer.current) clearInterval(timer.current);
            timer.current = null;
            setJob(null);
            setBusy(false);
            fb.error("安装失败", s.error || "未知原因");
          }
        } catch {
          /* 轮询失败就等下一次 */
        }
      }, 1200);
    } catch (e) {
      setJob(null);
      setBusy(false);
      fb.error("装不上", e instanceof Error ? e.message : String(e));
    }
  };

  const activate = async (r: BrowserDriverRow) => {
    setBusy(true);
    try {
      const a = await api.browserActivate({
        kind: r.kind,
        path: r.path,
        version: r.version,
        source: r.source,
      });
      setActive(a);
      await load();
      fb.success("已切换", `${a.label} ${a.version}（下一次执行生效）`);
    } catch (e) {
      fb.error("切换失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      const a = await api.browserReset();
      setActive(a);
      await load();
      fb.success("已切回系统默认", `${a.label} ${a.version}`);
    } catch (e) {
      fb.error("切回失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: BrowserDriverRow) => {
    const ok = await fb.confirm({
      title: `删除 ${r.label} ${r.version}？`,
      description: "只删平台装的这一份（系统包管理器装的不受影响）。",
      danger: true,
      confirmText: "删除",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.browserUninstall(r.kind, r.version);
      await load();
      fb.success("已删除", `${r.label} ${r.version}`);
    } catch (e) {
      fb.error("删不掉", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="text-[12.5px] text-[var(--color-muted)]">读取中…</div>;
  }

  return (
    <div className="space-y-3">
      {/* 当前在用 */}
      <div className="rounded-md border p-2.5" style={{ borderColor: "var(--color-border)" }}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className="rounded px-1.5 py-0.5 text-[10.5px]"
            style={{
              background: "color-mix(in srgb, var(--color-ok) 14%, transparent)",
              color: "var(--color-ok)",
            }}
          >
            在用
          </span>
          <span className="text-[13.5px] font-medium">{active?.label}</span>
          <span className="mono text-[12px]">{active?.version || "—"}</span>
          <span
            className="rounded px-1.5 py-0.5 text-[10.5px]"
            style={{
              background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
              color: "var(--color-accent)",
            }}
            title={active?.proto === "bidi" ? "WebDriver BiDi（Firefox）" : "Chrome DevTools Protocol"}
          >
            {PROTO_LABEL[active?.proto ?? ""] ?? active?.proto}
          </span>
          <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
            {active?.source === "managed" ? "平台装的" : "系统装的"}
          </span>
          {active?.custom ? (
            <button
              type="button"
              className="ml-auto rounded-[5px] px-2 py-1 text-[12px]"
              style={{ color: "var(--color-accent)", border: "1px solid color-mix(in srgb, var(--color-accent) 34%, transparent)" }}
              onClick={() => void reset()}
              disabled={busy}
            >
              切回系统 Chromium
            </button>
          ) : null}
        </div>
        {active?.path ? (
          <div className="mono mt-1 break-all text-[11.5px]" style={{ color: "var(--color-muted)" }}>
            {active.path}
          </div>
        ) : null}
      </div>

      {/* 这台机器上能用的驱动 */}
      <div className="text-[12px]" style={{ color: "var(--color-muted)" }}>
        这台机器上的驱动（{rows.length}）
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((r) => (
          <div
            key={`${r.kind}-${r.version}-${r.source}`}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[6px] border px-2 py-1.5 text-[12px]"
            style={{
              borderColor: "var(--color-border)",
              background: r.active ? "color-mix(in srgb, var(--color-accent) 5%, transparent)" : undefined,
            }}
          >
            <span className="min-w-[112px] font-medium">{r.label}</span>
            <span className="mono">{r.version || "—"}</span>
            <span style={{ color: "var(--color-muted)" }}>{PROTO_LABEL[r.proto] ?? r.proto}</span>
            <span style={{ color: "var(--color-muted)" }}>
              {r.source === "managed" ? "平台" : "系统"}
              {r.size_mb ? ` · ${r.size_mb} MB` : ""}
            </span>
            {r.active ? (
              <span className="ml-auto" style={{ color: "var(--color-ok)" }}>
                ✓ 在用
              </span>
            ) : (
              <span className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-[5px] px-2 py-0.5"
                  style={{ color: "var(--color-accent)" }}
                  onClick={() => void activate(r)}
                  disabled={busy}
                >
                  用这个
                </button>
                {r.source === "managed" && (
                  <button
                    type="button"
                    className="rounded-[5px] px-2 py-0.5"
                    style={{ color: "var(--color-err)" }}
                    onClick={() => void remove(r)}
                    disabled={busy}
                  >
                    删除
                  </button>
                )}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* 装一个新版本 */}
      <div className="rounded-md border p-2.5" style={{ borderColor: "var(--color-border)" }}>
        <div className="mb-2 text-[12px]" style={{ color: "var(--color-muted)" }}>
          装一个新版本（下载到平台目录，不动系统）
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="rounded border bg-transparent px-2 py-1 text-[12.5px]"
            style={{ borderColor: "var(--color-border)" }}
            value={kind}
            onChange={(e) => void pickKind(e.target.value)}
            disabled={busy}
          >
            <option value="">选引擎…</option>
            {engines.map((e) => (
              <option key={e.kind} value={e.kind}>
                {e.label}
              </option>
            ))}
          </select>
          <select
            className="rounded border bg-transparent px-2 py-1 text-[12.5px]"
            style={{ borderColor: "var(--color-border)" }}
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            disabled={busy || !kind || versions.length === 0}
          >
            {vLoading && <option value="">读取版本…</option>}
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                {v.version}
                {v.stable ? "（稳定）" : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded-[5px] px-2.5 py-1 text-[12.5px]"
            style={{
              background: "var(--color-accent)",
              color: "#fff",
              opacity: !kind || !version || busy ? 0.5 : 1,
            }}
            onClick={() => void install()}
            disabled={!kind || !version || busy}
          >
            安装
          </button>
          {job && (
            <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
              {job.phase} {job.percent}%
            </span>
          )}
        </div>
        {job && (
          <div className="mt-2 h-1 w-full overflow-hidden rounded" style={{ background: "var(--color-border)" }}>
            <div
              className="h-full transition-all"
              style={{ width: `${job.percent}%`, background: "var(--color-accent)" }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
