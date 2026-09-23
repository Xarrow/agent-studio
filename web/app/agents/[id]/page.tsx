"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, fmt, STATUS_STYLE } from "@/lib/api";
import type {
  Agent,
  AgentDefinition,
  Credential,
  Issue,
  Memory,
  MemoryPolicy,
  Provider,
  RunEvent,
  RuntimeCapabilities,
  Session,
  Skill,
  Tool,
} from "@/lib/types";
import { AgentMemoryPanel } from "@/components/AgentMemoryPanel";
import { ModelPicker } from "@/components/ModelPicker";
import { RunPanel } from "@/components/AgentRunPanel";
import { useFeedback } from "@/components/ui/feedback";

/** 执行观测的三种视图：给人看 / 给开发者看 / 原始数据 */
type ViewMode = "chat" | "table" | "raw";

export default function AgentEditorPage() {
  const fb = useFeedback();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const agentId = params.id;

  const [agent, setAgent] = useState<Agent | null>(null);
  const [def, setDef] = useState<AgentDefinition | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [creds, setCreds] = useState<Credential[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeCapabilities[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /**
   * 概览汇总：这个助手「用了什么 + 最近跑成什么样」。
   *
   * 为什么单独取一份：记忆面板和试跑面板各自会拉自己的详情数据，但概览要在
   * **一屏之内**回答"它现在是什么状态"，所以这里取个轻量摘要 ——
   * 一两百毫秒，换来不用上下翻找。
   */
  const [ov, setOv] = useState<{
    memoryOwn: number | null;
    memoryShared: number | null;
    lastRun: { status: string; at: number; ms: number | null } | null;
  }>({ memoryOwn: null, memoryShared: null, lastRun: null });
  const load = useCallback(async () => {
    try {
      const [a, p, c, t, s, r] = await Promise.all([
        api.agent(agentId),
        api.providers(),
        api.credentials(),
        api.tools(),
        api.skills(),
        api.runtimes(),
      ]);
      setAgent(a);
      setDef(a.definition);
      setProviders(p);
      setCreds(c);
      setTools(t);
      setSkills(s);
      setRuntimes(r);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 概览数据：记忆条数 + 最近一次执行。只读展示，不需要用户操作。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [own, shared, runs] = await Promise.all([
          api.memories({ agentId, scope: "agent", status: "active" }),
          api.memories({ scope: "global", status: "active" }),
          api.runs(agentId, 1),
        ]);
        if (!alive) return;
        const last = runs[0];
        setOv({
          memoryOwn: own.length,
          memoryShared: shared.length,
          lastRun: last
            ? {
                status: last.status,
                at: last.started_at,
                ms:
                  last.ended_at && last.started_at
                    ? last.ended_at - last.started_at
                    : null,
              }
            : null,
        });
      } catch {
        if (alive) setOv({ memoryOwn: null, memoryShared: null, lastRun: null });
      }
    })();
    return () => {
      alive = false;
    };
  }, [agentId]);

  // 定义变化时做实时校验（防抖）
  useEffect(() => {
    if (!def) return;
    const timer = setTimeout(() => {
      api
        .validate(def)
        .then((r) => setIssues(r.issues))
        .catch(() => setIssues([]));
    }, 400);
    return () => clearTimeout(timer);
  }, [def]);

  if (!def || !agent) {
    return (
      <div className="p-4 md:p-6 lg:p-7 text-[13px] text-[var(--color-muted)]">
        {err ? `加载失败：${err}` : "加载中…"}
      </div>
    );
  }

  const caps = runtimes.find((r) => r.name === def.runtime);
  const providerMeta = providers.find((p) => p.name === def.model.provider);
  /** 这个助手实际用的那条 LLM 配置 */
  const usedCred = creds.find((c) => c.id === def.model.credential_ref) ?? null;
  const usableCreds = creds.filter((c) => c.provider === def.model.provider);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");

  const patch = (p: Partial<AgentDefinition>) => setDef({ ...def, ...p });

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const updated = await api.updateAgent(agentId, { definition: def });
      setAgent(updated);
      setDef(updated.definition);
      setMsg(`已保存（v${updated.version}）`);
      setTimeout(() => setMsg(null), 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleTool = (id: string) => {
    const has = def.tools.some((t) => t.ref === id);
    patch({
      tools: has
        ? def.tools.filter((t) => t.ref !== id)
        : [...def.tools, { ref: id, enabled: true }],
    });
  };

  const toggleSkill = (id: string) => {
    const has = def.skills.some((s) => s.ref === id);
    patch({
      skills: has
        ? def.skills.filter((s) => s.ref !== id)
        : [...def.skills, { ref: id }],
    });
  };

  return (
    <div className="p-4 md:p-6 lg:p-7 max-w-[1700px]">
      <header className="flex items-start justify-between gap-4 mb-5">
        <div className="min-w-0">
          <Link href="/agents" className="text-[12px] text-[var(--color-muted)]">
            ← Agents
          </Link>
          <h1 className="text-[21px] font-semibold tracking-tight mt-1 truncate">
            {agent.name}
          </h1>
          <div className="text-[11.5px] text-[var(--color-muted)] mono mt-0.5">
            {agent.slug} · v{agent.version} · {agent.id}
            {agent.parent_id && ` · 复制自 ${agent.parent_id}`}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {msg && <span className="text-[12px] text-[var(--color-ok)]">{msg}</span>}
          <button
            className="btn"
            onClick={async () => {
              const c = await api.duplicateAgent(agentId, {});
              router.push(`/agents/${c.id}`);
            }}
          >
            复制为副本
          </button>
          <button className="btn btn-primary" disabled={saving} onClick={save}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </header>

      {(errors.length > 0 || warnings.length > 0) && (
        <div className="card p-3.5 mb-4 space-y-1">
          {errors.map((i, n) => (
            <div key={`e${n}`} className="text-[12.5px] text-[var(--color-err)]">
              ✗ {i.field ? `${i.field}: ` : ""}
              {i.message}
            </div>
          ))}
          {warnings.map((i, n) => (
            <div key={`w${n}`} className="text-[12.5px] text-[var(--color-warn)]">
              ⚠ {i.field ? `${i.field}: ` : ""}
              {i.message}
            </div>
          ))}
        </div>
      )}

      {/* ── 概览：一屏之内回答"这个助手现在是什么状态" ──────────────
          以前要看这些得在三个 tab 之间来回切；现在一眼扫完。 */}
      <section className="card p-4 mb-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <div className="text-[11.5px] text-[var(--color-muted)]">模型</div>
            <div className="text-[13.5px] mono mt-0.5 break-all">
              {def.model.name || "—"}
            </div>
            <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
              {providers.find((x) => x.name === def.model.provider)?.display_name ??
                def.model.provider}
              {usedCred ? ` · ${usedCred.name}` : " · 用环境变量密钥"}
            </div>
          </div>
          <div>
            <div className="text-[11.5px] text-[var(--color-muted)]">工具</div>
            <div className="text-[13.5px] mt-0.5">{def.tools.length} 个已选</div>
            <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
              共 {tools.length} 个可用
            </div>
          </div>
          <div>
            <div className="text-[11.5px] text-[var(--color-muted)]">Skills</div>
            <div className="text-[13.5px] mt-0.5">{def.skills.length} 个已选</div>
            <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
              共 {skills.length} 个可用
            </div>
          </div>
          <div>
            <div className="text-[11.5px] text-[var(--color-muted)]">记忆</div>
            <div className="text-[13.5px] mt-0.5">
              {ov.memoryOwn === null || ov.memoryShared === null
                ? "…"
                : `${ov.memoryOwn + ov.memoryShared} 条`}
            </div>
            <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
              {ov.memoryOwn === null
                ? ""
                : `自己的 ${ov.memoryOwn} · 共用 ${ov.memoryShared}`}
            </div>
          </div>
        </div>
        {ov.lastRun && (
          <div className="mt-3 pt-3 border-t border-[var(--color-border)] text-[12px] text-[var(--color-muted)]">
            最近一次执行：
            <span
              className="mono"
              style={{ color: STATUS_STYLE[ov.lastRun.status as keyof typeof STATUS_STYLE] }}
            >
              {ov.lastRun.status}
            </span>
            {" · "}
            {fmt.ms(ov.lastRun.ms)}
            {" · "}
            {fmt.relative(ov.lastRun.at)}
          </div>
        )}
      </section>


      {/* ── 定义 ──────────────────────────────────────────────── */}
      <div id="sec-define" className="grid gap-4 grid-cols-1 lg:grid-cols-2 scroll-mt-14">
          <section className="card p-4 space-y-3.5">
            <h2 className="text-[14px] font-medium">基础</h2>
            <div>
              <label className="label">名称</label>
              <input
                className="input"
                value={def.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </div>
            <div>
              <label className="label">System Prompt</label>
              <textarea
                className="input"
                rows={6}
                value={def.system_prompt}
                onChange={(e) => patch({ system_prompt: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">最大迭代轮数（-1 = 不限制）</label>
                <input
                  className="input mono"
                  type="number"
                  min={-1}
                  value={def.limits.max_iters}
                  onChange={(e) =>
                    patch({
                      limits: { ...def.limits, max_iters: Number(e.target.value) },
                    })
                  }
                />
                {def.limits.max_iters === -1 ? (
                  <p className="text-[11px] text-[var(--color-warn)] mt-1">
                    ⚠ 不限制轮数 —— 请靠超时兜底
                  </p>
                ) : (
                  <p className="text-[11px] text-[var(--color-muted)] mt-1">
                    推理-行动循环上限
                  </p>
                )}
              </div>
              <div>
                <label className="label">超时（秒，0 = 不超时）</label>
                <input
                  className="input mono"
                  type="number"
                  min={0}
                  value={def.limits.timeout_s}
                  onChange={(e) =>
                    patch({
                      limits: { ...def.limits, timeout_s: Number(e.target.value) },
                    })
                  }
                />
                <p className="text-[11px] text-[var(--color-muted)] mt-1">
                  默认 60 秒，可自定义
                </p>
              </div>
            </div>
          </section>

          <section className="card p-4 space-y-3.5">
            <div className="flex items-center justify-between">
              <h2 className="text-[14px] font-medium">运行时与模型</h2>
              {caps && <span className="tag">{caps.display_name}</span>}
            </div>

            <div>
              <label className="label">
                运行时（切换后下方可配置项随之变化）
              </label>
              <select
                className="input"
                value={def.runtime}
                onChange={(e) => patch({ runtime: e.target.value })}
              >
                {runtimes.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.display_name}
                  </option>
                ))}
              </select>
              {caps && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {caps.supports_hitl && <span className="tag">人工确认</span>}
                  {caps.supports_thinking && <span className="tag">思考过程</span>}
                  {caps.supports_skills && <span className="tag">Skill</span>}
                  {caps.supports_structured_output && <span className="tag">结构化输出</span>}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Provider</label>
                <select
                  className="input"
                  value={def.model.provider}
                  onChange={(e) => {
                    const p = providers.find((x) => x.name === e.target.value);
                    patch({
                      model: {
                        ...def.model,
                        provider: e.target.value,
                        name: p?.models?.[0] ?? "",
                        credential_ref: null,
                      },
                    });
                  }}
                >
                  {providers.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.display_name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">LLM 配置</label>
                <select
                  className="input"
                  value={def.model.credential_ref ?? ""}
                  onChange={(e) =>
                    patch({
                      model: { ...def.model, credential_ref: e.target.value || null },
                    })
                  }
                >
                  <option value="">— 环境变量默认 —</option>
                  {usableCreds.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}（{c.masked_key}）
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* 模型放在「LLM 配置」之后 —— 下拉里的候选是靠那条凭据探测出来的 */}
            <div>
              <label className="label">模型</label>
              <ModelPicker
                providers={providers}
                provider={def.model.provider}
                credentialId={def.model.credential_ref}
                value={def.model.name}
                onChange={(v) => patch({ model: { ...def.model, name: v } })}
              />
            </div>

            <div>
              <label className="label">temperature</label>
              <input
                className="input mono"
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={Number((def.model.params as Record<string, number>)?.temperature ?? 0.7)}
                onChange={(e) =>
                  patch({
                    model: {
                      ...def.model,
                      params: { ...(def.model.params ?? {}), temperature: Number(e.target.value) },
                    },
                  })
                }
              />
            </div>
          </section>

          <section className="card p-4">
            <h2 className="text-[14px] font-medium mb-3">
              工具（{def.tools.length} 已选 / {tools.length} 可用）
            </h2>
            {tools.length === 0 ? (
              <p className="text-[12.5px] text-[var(--color-muted)]">
                还没有工具。去 <Link href="/tools" className="text-[var(--color-accent)]">工具</Link>{" "}
                页同步内置工具或创建自定义 HTTP 工具。
              </p>
            ) : (
              <div className="space-y-1.5 max-h-72 overflow-auto">
                {tools.map((t) => {
                  const on = def.tools.some((x) => x.ref === t.id);
                  // 平台不适用的工具（如 Linux 上的 PowerShell）：置灰 + 禁止勾选
                  const platformOk = t.flags?.platform_ok !== false;
                  const note = t.flags?.platform_note;
                  return (
                    <label
                      key={t.id}
                      title={platformOk ? undefined : String(note ?? "")}
                      className={`flex items-start gap-2.5 p-2 rounded-md ${
                        platformOk
                          ? "hover:bg-[var(--color-surface-2)] cursor-pointer"
                          : "opacity-60 cursor-not-allowed"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!platformOk}
                        onChange={() => toggleTool(t.id)}
                        className="mt-0.5 accent-[var(--color-accent)]"
                      />
                      <span className="min-w-0">
                        <span
                          className={`text-[13px] mono ${platformOk ? "" : "line-through"}`}
                        >
                          {t.name}
                        </span>
                        <span className="tag ml-2">{t.kind}</span>
                        {!platformOk && (
                          <span className="tag ml-1.5 text-[var(--color-err)]">
                            当前平台不可用
                          </span>
                        )}
                        {Boolean(t.flags?.dangerous) && platformOk && (
                          <span className="tag ml-1.5 text-[var(--color-warn)]">
                            写/执行
                          </span>
                        )}
                        {t.description && (
                          <span className="block text-[11.5px] text-[var(--color-muted)] mt-0.5">
                            {t.description}
                          </span>
                        )}
                        {!platformOk && typeof note === "string" && (
                          <span className="block text-[11px] text-[var(--color-err)] mt-0.5">
                            {note}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </section>

          <section className="card p-4">
            <h2 className="text-[14px] font-medium mb-3">
              Skills（{def.skills.length} 已选 / {skills.length} 可用）
            </h2>
            {skills.length === 0 ? (
              <p className="text-[12.5px] text-[var(--color-muted)]">
                还没有 Skill。去 <Link href="/skills" className="text-[var(--color-accent)]">Skills</Link>{" "}
                页从 Git / URL / 本地导入。
              </p>
            ) : (
              <div className="space-y-1.5 max-h-72 overflow-auto">
                {skills.map((s) => {
                  const on = def.skills.some((x) => x.ref === s.id);
                  return (
                    <label
                      key={s.id}
                      className="flex items-start gap-2.5 p-2 rounded-md hover:bg-[var(--color-surface-2)] cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleSkill(s.id)}
                        className="mt-0.5 accent-[var(--color-accent)]"
                      />
                      <span className="min-w-0">
                        <span className="text-[13px]">{s.name}</span>
                        {s.description && (
                          <span className="block text-[11.5px] text-[var(--color-muted)] mt-0.5 line-clamp-2">
                            {s.description}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </section>
        </div>

      {/* ── 试跑与观测 ─────────────────────────────────────────── */}
      <section id="sec-run" className="mt-4 scroll-mt-14">
        <h2 className="text-[14px] font-medium mb-3">试跑与观测</h2>
        <RunPanel agentId={agentId} agentName={agent.name} disabled={errors.length > 0} />
      </section>

      {/* ── 记忆 ───────────────────────────────────────────────── */}
      {/* 不另加外层标题：记忆面板的卡片自带「记忆」标题，再加一层就重复了 */}
      <section id="sec-memory" className="mt-4 scroll-mt-14">
        <AgentMemoryPanel agentId={agentId} />
      </section>
    </div>
  );
}

/*
 * 注：RunPanel / EventTable / AgentMemoryPanel 已拆到
 *   @/components/AgentRunPanel.tsx
 *   @/components/AgentMemoryPanel.tsx
 * 原先它们都堆在本文件末尾（1400+ 行），拆开后单文件更易维护。
 */
