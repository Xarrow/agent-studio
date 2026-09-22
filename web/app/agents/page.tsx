"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { Agent, Credential, Provider, RuntimeCapabilities } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";

export default function AgentsPage() {
  const fb = useFeedback();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeCapabilities[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [creds, setCreds] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, r, p, c] = await Promise.all([
        api.agents(),
        api.runtimes(),
        api.providers(),
        api.credentials(),
      ]);
      setAgents(a);
      setRuntimes(r);
      setProviders(p);
      setCreds(c);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const duplicate = async (id: string) => {
    setBusy(id);
    try {
      await api.duplicateAgent(id, {});
      await load();
    } catch (e) {
      fb.error("复制 Agent 失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (agent: Agent) => {
    const ok = await fb.confirm({
      title: `删除 Agent「${agent.name}」？`,
      description: "该 Agent 的记忆绑定与挂载关系将一并清理。",
      danger: true,
      confirmText: "删除",
    });
    if (!ok) return;
    setBusy(agent.id);
    try {
      await api.deleteAgent(agent.id);
      await load();
    } catch (e) {
      fb.error("删除 Agent 失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-4 md:p-6 lg:p-7 max-w-6xl">
      <header className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Agents</h1>
          <p className="text-[13px] text-[var(--color-muted)] mt-1">
            {agents.length} 个 Agent · 定义、复制、试跑与观测
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          + 新建 Agent
        </button>
      </header>

      {err && (
        <div className="card p-4 mb-4 text-[13px] text-[var(--color-err)]">
          加载失败：{err}
        </div>
      )}

      {showNew && (
        <NewAgentDialog
          runtimes={runtimes}
          providers={providers}
          creds={creds}
          onClose={() => setShowNew(false)}
          onCreated={async () => {
            setShowNew(false);
            await load();
          }}
        />
      )}

      {loading ? (
        <div className="card p-6 text-[13px] text-[var(--color-muted)]">加载中…</div>
      ) : agents.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-[14px] mb-2">还没有 Agent</p>
          <p className="text-[12.5px] text-[var(--color-muted)] mb-4">
            创建一个，然后在页面里定义、试跑并观测完整的思考与工具调用过程。
          </p>
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>
            创建第一个 Agent
          </button>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {agents.map((a) => (
            <div key={a.id} className="card p-4 flex flex-col">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/agents/${a.id}`}
                    className="font-medium text-[14.5px] hover:text-[var(--color-accent)] truncate block"
                  >
                    {a.name}
                  </Link>
                  <div className="text-[11.5px] text-[var(--color-muted)] mono mt-0.5">
                    {a.slug} · v{a.version} · {a.id}
                  </div>
                </div>
                <span className="tag shrink-0">{a.definition?.runtime ?? a.runtime}</span>
              </div>

              <div className="text-[12px] text-[var(--color-muted)] mt-3 flex flex-wrap gap-x-4 gap-y-1">
                <span>
                  模型{" "}
                  <span className="mono text-[var(--color-text)]">
                    {a.definition?.model?.name || "—"}
                  </span>
                </span>
                <span>
                  工具{" "}
                  <span className="mono text-[var(--color-text)]">
                    {a.definition?.tools?.length ?? 0}
                  </span>
                </span>
                <span>
                  Skill{" "}
                  <span className="mono text-[var(--color-text)]">
                    {a.definition?.skills?.length ?? 0}
                  </span>
                </span>
                <span>更新 {fmt.relative(a.updated_at)}</span>
              </div>

              <div className="flex gap-2 mt-4 pt-3 border-t border-[var(--color-border)]">
                <Link href={`/agents/${a.id}`} className="btn">
                  编辑 / 试跑
                </Link>
                <button
                  className="btn"
                  disabled={busy === a.id}
                  onClick={() => duplicate(a.id)}
                >
                  复制
                </button>
                <button
                  className="btn ml-auto text-[var(--color-err)]"
                  disabled={busy === a.id}
                  onClick={() => remove(a)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- //
function NewAgentDialog({
  runtimes,
  providers,
  creds,
  onClose,
  onCreated,
}: {
  runtimes: RuntimeCapabilities[];
  providers: Provider[];
  creds: Credential[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [runtime, setRuntime] = useState(runtimes[0]?.name ?? "agentscope");
  const [provider, setProvider] = useState(providers[0]?.name ?? "deepseek");
  const [model, setModel] = useState(providers[0]?.models?.[0] ?? "");
  const [credRef, setCredRef] = useState("");
  const [prompt, setPrompt] = useState("你是一个乐于助人的助手。");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ★ 运行时切换 → 表单能力自动变化（capabilities 驱动）
  const caps = runtimes.find((r) => r.name === runtime);
  const providerMeta = providers.find((p) => p.name === provider);
  const usableCreds = creds.filter((c) => c.provider === provider);

  const submit = async () => {
    if (!name.trim()) {
      setErr("请填写名称");
      return;
    }
    setBusy(true);
    try {
      await api.createAgent({
        name: name.trim(),
        definition: {
          runtime,
          name: name.trim(),
          system_prompt: prompt,
          model: {
            provider,
            name: model || providerMeta?.models?.[0] || "",
            credential_ref: credRef || null,
          },
          tools: [],
          skills: [],
          middlewares: [],
          limits: { max_iters: 10, timeout_s: 120 },
          runtime_options: {},
        },
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[var(--color-overlay)] flex items-center justify-center p-4 z-50">
      <div className="card w-full max-w-lg p-5">
        <h2 className="text-[16px] font-medium mb-4">新建 Agent</h2>

        <div className="space-y-3.5">
          <div>
            <label className="label">名称</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：代码审查助手"
              autoFocus
            />
          </div>

          <div>
            <label className="label">运行时</label>
            <select
              className="input"
              value={runtime}
              onChange={(e) => setRuntime(e.target.value)}
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
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Provider</label>
              <select
                className="input"
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  const p = providers.find((x) => x.name === e.target.value);
                  setModel(p?.models?.[0] ?? "");
                  setCredRef("");
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
              <label className="label">模型</label>
              <input
                className="input mono"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                list="model-options"
              />
              <datalist id="model-options">
                {(providerMeta?.models ?? []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
          </div>

          <div>
            <label className="label">
              LLM 配置{usableCreds.length === 0 && "（该 provider 还没有配置，请先去「LLM 配置」页添加）"}
            </label>
            <select
              className="input"
              value={credRef}
              onChange={(e) => setCredRef(e.target.value)}
            >
              <option value="">— 使用环境变量默认 —</option>
              {usableCreds.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}（{c.masked_key}）
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">System Prompt</label>
            <textarea
              className="input"
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>

          {err && <div className="text-[12.5px] text-[var(--color-err)]">{err}</div>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? "创建中…" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
