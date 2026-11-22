"use client";

/**
 * 对话页右侧配置抽屉 —— R1 的第一半。
 *
 * 为什么不是弹窗、也不是跳去 /agents/detail：
 * 用户在对话里想改的通常只有几样（模型、提示词、开场白、职责），
 * 跳页会丢掉"我刚说到哪儿"的上下文，改完还得再跳回来；弹窗又把对话盖住。
 * 抽屉贴着右边，对话still visible，改完立刻生效。
 *
 * 只放**高频**几项；要改工具/权限/记忆这些，给一个「完整配置」的链接过去。
 * 自动保存：停手 800ms 落库，不产生版本（版本靠详情页的「记为一版」）。
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { api } from "@/lib/api";
import { useFeedback } from "@/components/ui/feedback";
import { ModelPicker } from "@/components/ModelPicker";
import type { Agent, AgentDefinition, Credential, Provider } from "@/lib/types";

export function AgentConfigDrawer({
  agent,
  providers,
  creds,
  onClose,
  onSaved,
}: {
  agent: Agent;
  providers: Provider[];
  creds: Credential[];
  onClose: () => void;
  /** 保存成功后把新的 agent 交回去（页眉的模型名要立刻变） */
  onSaved: (a: Agent) => void;
}) {
  const fb = useFeedback();
  const [def, setDef] = useState<AgentDefinition>(agent.definition);
  const [desc, setDesc] = useState(agent.description ?? "");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState("");
  const [err, setErr] = useState<string | null>(null);
  /** 桌面 480、手机整屏（跟着视口走，旋转/缩窗口也跟得上） */
  const [drawerW, setDrawerW] = useState("480px");
  useEffect(() => {
    const fit = () => setDrawerW(window.innerWidth < 640 ? "100vw" : "480px");
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  /** 快照：判断有没有未保存的改动 */
  const [snap, setSnap] = useState(() => JSON.stringify([agent.definition, agent.description ?? ""]));
  const timer = useRef<number | null>(null);
  const latest = useRef({ def, desc });
  latest.current = { def, desc };

  const changed = JSON.stringify([def, desc]) !== snap;

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const d = latest.current;
      const updated = await api.updateAgent(
        agent.id,
        {
          name: (d.def.name ?? "").trim() || agent.name,
          definition: d.def,
          description: d.desc.trim() || undefined,
          // 自动保存不生成版本：版本留给详情页的「记为一版」
          bump_version: false,
        },
        agent.version,
      );
      setSnap(JSON.stringify([updated.definition, updated.description ?? ""]));
      setDef(updated.definition);
      setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
      onSaved(updated);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!changed) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      void save();
    }, 800);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed, def, desc]);

  // Esc 关闭；有未保存改动时先存一次再关
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (changed) await save();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed]);

  const patch = (p: Partial<AgentDefinition>) => setDef((d) => ({ ...d, ...p }));

  const body = (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} aria-hidden="true" />
      <aside
        /* 手机上全宽贴边（留 20px 缝只会显得没做完），桌面 480 */
        /* 宽度写在 globals.css 的 .config-drawer 里：桌面 480、手机整屏
           （Tailwind 的 sm:max-w-[480px] 在这个构建里没生效，实测只给 360） */
        className="fixed inset-y-0 right-0 z-50 flex flex-col shadow-2xl"
        /* 宽度用 JS 直接给：CSS 类与 sm:max-w 在这套构建里都没落到这个元素上
           （实测 computed 一直是 360），内联是最可控的写法 */
        style={{ background: "var(--color-surface)", width: drawerW }}
        role="dialog"
        aria-label="助手配置"
      >
        <header className="flex items-center gap-2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-medium">{def.name || agent.name}</div>
            <div className="text-[11.5px]" style={{ color: "var(--color-text-3)" }}>
              {saving ? "保存中…" : err ? `保存失败：${err}` : changed ? "改动待保存…" : savedAt ? `已自动保存 · ${savedAt}` : "改完自动保存"}
            </div>
          </div>
          <button
            data-tap
            onClick={onClose}
            aria-label="关闭配置"
            className="flex h-10 w-10 items-center justify-center rounded-[10px] hover:bg-[var(--color-surface-2)]"
            style={{ color: "var(--color-muted)" }}
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
          <div>
            <label className="label">一句话职责</label>
            <input
              className="input"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="它会出现在选助手的地方"
              maxLength={140}
            />
          </div>

          <div>
            <label className="label">开场白（新对话第一屏）</label>
            <input
              className="input"
              value={def.opening_line ?? ""}
              onChange={(e) => patch({ opening_line: e.target.value })}
              placeholder="例如：把日志或报错贴给我"
              maxLength={200}
            />
          </div>

          <div>
            <label className="label">系统提示词</label>
            <textarea
              className="input"
              rows={8}
              value={def.system_prompt}
              onChange={(e) => patch({ system_prompt: e.target.value })}
            />
          </div>

          {/* 服务商由模型决定：先选服务商再选模型，和配置页同一套 */}
          {def.runtime !== "a2a" && (
            <div>
              <label className="label">模型</label>
              <select
                className="input mb-2"
                value={def.model.provider}
                onChange={(e) => {
                  const name = e.target.value;
                  const c = creds.find((x) => x.provider === name);
                  patch({
                    model: {
                      ...def.model,
                      provider: name,
                      name: c?.default_model ?? "",
                      credential_ref: c?.id ?? null,
                    },
                  });
                }}
              >
                {providers.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.display_name}
                    {creds.some((c) => c.provider === p.name) ? "" : "（还没配密钥）"}
                  </option>
                ))}
              </select>
              <ModelPicker
                providers={providers}
                provider={def.model.provider}
                credentialId={def.model.credential_ref ?? null}
                value={def.model.name}
                onChange={(v) => patch({ model: { ...def.model, name: v } })}
              />
            </div>
          )}

          <details className="rounded-[10px]" style={{ background: "var(--color-surface-2)" }}>
            <summary
              data-tap
              className="flex min-h-[40px] cursor-pointer items-center gap-2 px-3 text-[12.5px]"
              style={{ color: "var(--color-text-2)" }}
            >
              高级参数
              <span className="text-[11.5px]" style={{ color: "var(--color-text-3)" }}>
                temperature{" "}
                {Math.round(Number((def.model.params as Record<string, number>)?.temperature ?? 0.7) * 100) / 100}
                （默认 0.70）
              </span>
            </summary>
            <div className="flex items-center gap-2 px-3 pb-3">
              <input
                className="input mono"
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={Math.round(Number((def.model.params as Record<string, number>)?.temperature ?? 0.7) * 100) / 100}
                onChange={(e) =>
                  patch({
                    model: {
                      ...def.model,
                      params: {
                        ...(def.model.params ?? {}),
                        temperature: Math.round(Number(e.target.value) * 100) / 100,
                      },
                    },
                  })
                }
              />
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => patch({ model: { ...def.model, params: { ...(def.model.params ?? {}), temperature: 0.7 } } })}
              >
                恢复默认
              </button>
            </div>
          </details>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-sm"
              disabled={saving || !changed}
              onClick={() => void save()}
            >
              现在保存
            </button>
            <Link
              href={`/agents/detail?id=${agent.id}`}
              className="text-[12px]"
              style={{ color: "var(--color-accent)" }}
            >
              工具 / 权限 / 记忆 →
            </Link>
          </div>
          {err && (
            <p className="text-[12px]" style={{ color: "var(--color-err)" }}>
              {err}
            </p>
          )}
          <p className="text-[11.5px]" style={{ color: "var(--color-text-3)" }}>
            改完下一条消息就按新配置走；想留一个可回滚的版本，去完整配置点「记为一版」。
          </p>
        </div>
      </aside>
    </>
  );

  // 挂到 body：祖先若有 transform / filter，fixed 会退化成相对它定位（实测只剩 360 宽）
  return typeof document === "undefined" ? body : createPortal(body, document.body);
}
