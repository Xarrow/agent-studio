"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { Agent, Credential, Provider, RuntimeCapabilities } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { Hint, HINTS } from "@/components/ui/hint";
import { ModelPicker } from "@/components/ModelPicker";

/**
 * 「你希望它帮你做什么」的预设 —— 选一个就自动带上角色设定。
 *
 * 为什么要有预设：新手面对空白的 System Prompt 输入框会卡住。
 * 给几个常见的做事方式，点一下就有一份写好的交代，且**仍可修改**。
 */
const PRESETS = [
  {
    key: "code",
    icon: "💻",
    label: "写代码、查错",
    desc: "帮你写代码、找 bug、解释代码怎么跑",
    prompt:
      "你是一个编程助手。帮用户写代码、排查错误、解释代码逻辑。回答时直接给出可运行的代码，并简要说明关键点；不确定的地方要明确说出来。",
  },
  {
    key: "qa",
    icon: "📚",
    label: "答疑解惑",
    desc: "回答各种问题，把概念讲明白",
    prompt:
      "你是一个知识助手。用通俗易懂的话回答问题，必要时举例说明。不确定的地方要明确说不确定，不要编造。",
  },
  {
    key: "research",
    icon: "🔍",
    label: "查资料、做整理",
    desc: "搜信息、提炼要点、做结构化总结",
    prompt:
      "你是一个资料整理助手。帮用户查找信息、提炼要点、做结构化总结。优先给出结论，再给依据；引用信息时说明来源。",
  },
  {
    key: "custom",
    icon: "✨",
    label: "自定义",
    desc: "自己写一段交代，告诉它该做什么",
    prompt: "",
  },
] as const;

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
                  <Hint text="这个助手背后用的是哪个 AI 模型。">模型</Hint>{" "}
                  <span className="mono text-[var(--color-text)]">
                    {a.definition?.model?.name || "—"}
                  </span>
                </span>
                <span>
                  <Hint text={HINTS.tool}>工具</Hint>{" "}
                  <span className="mono text-[var(--color-text)]">
                    {a.definition?.tools?.length ?? 0}
                  </span>
                </span>
                <span>
                  <Hint text={HINTS.skill}>Skill</Hint>{" "}
                  <span className="mono text-[var(--color-text)]">
                    {a.definition?.skills?.length ?? 0}
                  </span>
                </span>
                <span>更新 {fmt.relative(a.updated_at)}</span>
              </div>

              {/* 主操作是「聊天」（用它），次操作是「设置」（改它）——
                  合在一个「编辑 / 试跑」里会让"使用"这条最短路径断掉 */}
              <div className="flex flex-wrap gap-2 mt-4 pt-3 border-t border-[var(--color-border)]">
                <Link
                  href={`/chat?agent=${a.id}`}
                  className="btn btn-primary flex-1 text-center text-[12.5px]"
                >
                  聊天
                </Link>
                <Link href={`/agents/${a.id}`} className="btn text-[12.5px]">
                  设置
                </Link>
                <button
                  className="btn text-[12.5px]"
                  disabled={busy === a.id}
                  onClick={() => duplicate(a.id)}
                  title="按这个助手的配置，复制出一个新的"
                >
                  复制
                </button>
                <button
                  className="btn ml-auto text-[12.5px] text-[var(--color-err)]"
                  disabled={busy === a.id}
                  onClick={() => remove(a)}
                  title="删除这个助手（记录会保留）"
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
  const [presetKey, setPresetKey] = useState<string | null>(null);
  const [runtime, setRuntime] = useState(runtimes[0]?.name ?? "agentscope");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [credRef, setCredRef] = useState("");
  const [prompt, setPrompt] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 初始化「用哪个 AI」：优先选**已经配好密钥**的服务商，并自动带上那条密钥
  useEffect(() => {
    const withCred = providers.find((p) => creds.some((c) => c.provider === p.name));
    const p = withCred ?? providers[0];
    if (!p) return;
    setProvider(p.name);
    setModel(p.models?.[0] ?? "");
    const c = creds.find((x) => x.provider === p.name);
    setCredRef(c?.id ?? "");
  }, [providers, creds]);

  const caps = runtimes.find((r) => r.name === runtime);
  const providerMeta = providers.find((p) => p.name === provider);
  const usableCreds = creds.filter((c) => c.provider === provider);
  const preset = PRESETS.find((x) => x.key === presetKey);
  const isCustom = presetKey === "custom";
  const selectedCred = creds.find((c) => c.id === credRef);

  const submit = async () => {
    if (!name.trim()) {
      setErr("先给它起个名字吧");
      return;
    }
    if (!presetKey) {
      setErr("选一个它要做的事（第 ② 步）");
      return;
    }
    setBusy(true);
    try {
      await api.createAgent({
        name: name.trim(),
        definition: {
          runtime,
          name: name.trim(),
          system_prompt: prompt.trim() || "你是一个乐于助人的助手。",
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
    <div className="fixed inset-0 bg-[var(--color-overlay)] flex items-start sm:items-center justify-center p-4 z-50 overflow-auto">
      <div className="card w-full max-w-lg p-5 my-auto">
        <h2 className="text-[16px] font-medium mb-1">新建助手</h2>
        <p className="text-[12.5px] text-[var(--color-muted)] mb-4">
          回答三个问题就行，其他的它会自己配好。
        </p>

        <div className="space-y-5">
          {/* ① 名字 */}
          <div>
            <label className="label flex items-center gap-1.5">
              <span className="text-[var(--color-accent)] font-semibold">①</span>
              它叫什么名字？
            </label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：代码小助手"
              autoFocus
            />
          </div>

          {/* ② 做什么 —— 选一个预设，自动带上「角色设定」 */}
          <div>
            <label className="label flex items-center gap-1.5">
              <span className="text-[var(--color-accent)] font-semibold">②</span>
              你希望它帮你做什么？
            </label>
            <div className="grid grid-cols-2 gap-2">
              {PRESETS.map((p) => {
                const on = presetKey === p.key;
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => {
                      setPresetKey(p.key);
                      if (p.key !== "custom") setPrompt(p.prompt);
                    }}
                    className={`text-left rounded-md p-3 transition-colors border ${
                      on
                        ? "border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)]"
                        : "border-[var(--color-border)] hover:border-[var(--color-accent-dim)]"
                    }`}
                  >
                    <div className="text-[13.5px] font-medium">
                      {p.icon} {p.label}
                    </div>
                    <div className="text-[11.5px] text-[var(--color-muted)] mt-0.5 leading-snug">
                      {p.desc}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* 自定义时才让人写「角色设定」 */}
            {(isCustom || (preset && presetKey !== "custom")) && (
              <div className="mt-3">
                <label className="label flex items-center gap-1.5">
                  {isCustom ? "写一段交代（角色设定）" : "它会按这段交代做事（可修改）"}
                  <Hint text={HINTS.systemPrompt} />
                </label>
                <textarea
                  className="input"
                  rows={isCustom ? 4 : 2}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={
                    isCustom
                      ? "例如：你是我的读书笔记助手，帮我把读到的内容整理成要点，语气简洁。"
                      : undefined
                  }
                />
              </div>
            )}
          </div>

          {/* ③ 用哪个 AI —— 自动选好推荐项，不用懂 Provider/模型/密钥 */}
          <div>
            <label className="label flex items-center gap-1.5">
              <span className="text-[var(--color-accent)] font-semibold">③</span>
              <Hint text="不同服务商的 AI 有不同脾气和价格。已经替你选好了推荐项，不用改。">
                用哪个 AI
              </Hint>
            </label>
            {providers.length === 0 ? (
              <div className="text-[12.5px] text-[var(--color-err)]">
                还没有可用的服务商，请先到「LLM 配置」添加一个。
              </div>
            ) : (
              <>
                <select
                  className="input"
                  value={provider}
                  onChange={(e) => {
                    const p = providers.find((x) => x.name === e.target.value);
                    setProvider(e.target.value);
                    setModel(p?.models?.[0] ?? "");
                    const c = creds.find((x) => x.provider === e.target.value);
                    setCredRef(c?.id ?? "");
                  }}
                >
                  {providers.map((p) => {
                    const hasKey = creds.some((c) => c.provider === p.name);
                    return (
                      <option key={p.name} value={p.name}>
                        {p.display_name}
                        {hasKey ? "（已配置钥匙 ✓）" : "（还没配钥匙）"}
                      </option>
                    );
                  })}
                </select>
                <p className="text-[11.5px] text-[var(--color-muted)] mt-1.5">
                  {selectedCred
                    ? `使用你的密钥：${selectedCred.name}（${selectedCred.masked_key}）`
                    : usableCreds.length === 0
                      ? "这个服务商还没有密钥，去「LLM 配置」加一个吧。"
                      : "会自动选用已配置的密钥。"}
                </p>
              </>
            )}
          </div>

          {/* 高级：运行时与参数 —— 默认收起 */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-[12.5px] text-[var(--color-accent)] flex items-center gap-1"
            >
              <span>{showAdvanced ? "▾" : "▸"}</span> 高级设置（一般不用改）
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3 pl-3 border-l-2 border-[var(--color-border)]">
                <div>
                  <label className="label flex items-center gap-1.5">
                    <Hint text={HINTS.runtime}>运行时</Hint>
                  </label>
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
                      {caps.supports_hitl && (
                        <Hint text={HINTS.hitl}><span className="tag">人工确认</span></Hint>
                      )}
                      {caps.supports_thinking && (
                        <Hint text={HINTS.thinking}><span className="tag">思考过程</span></Hint>
                      )}
                      {caps.supports_skills && (
                        <Hint text={HINTS.skill}><span className="tag">Skill</span></Hint>
                      )}
                    </div>
                  )}
                </div>
                <div>
                  <label className="label flex items-center gap-1.5">
                    <Hint text="同一家服务商里有不同档位，贵的更聪明、便宜的更快。">模型</Hint>
                  </label>
                  <ModelPicker
                    providers={providers}
                    provider={provider}
                    credentialId={credRef}
                    value={model}
                    onChange={setModel}
                  />
                </div>
              </div>
            )}
          </div>

          {err && <div className="text-[12.5px] text-[var(--color-err)]">{err}</div>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !name.trim() || !presetKey}
            onClick={submit}
          >
            {busy ? "创建中…" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
