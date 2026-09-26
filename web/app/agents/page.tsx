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
    key: "orchestrator",
    icon: "✦",
    label: "编排、统筹",
    desc: "对整条流程负责：分析任务、管理上下文、验证结果、归纳总结",
    prompt:
      "你负责统筹与把关，而不是只做完手里这一小步：先把目标分析清楚并明确交付标准；把上游产出整理成结构化上下文；对结果做核验（缺项/矛盾/未做）；最后给出结论性交付并列出待确认项与风险。",
  },
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
  /** 列表里就地改名：非 null = 正在改这个助手的名字（用户反馈"看不到修改名称的入口"） */
  const [renaming, setRenaming] = useState<string | null>(null);
  /** 卡片上的「⋯」菜单（设置/改名/复制/删除）—— 一次只开一个 ✓ 点别处关 */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");

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

  /** 列表里**就地改名**。
   *
   *  为什么加（用户："为什么还是看不到修改 agent 名称的入口"）
   *  --------------------------------------------------------
   *  之前只能进详情页改，而且名字就是普通输入框、没有任何提示 —— 等于"没有入口" ✗。
   *  这里在每张卡片上给一个明确的「改名」：点了名字变输入框，回车或点到别处即保存，Esc 取消。
   *  同时写顶层 name 与 definition.name（这两个历史数据里可能不一致，写一次就统一）。 */
  const rename = async (a: Agent) => {
    const next = nameDraft.trim();
    setRenaming(null);
    if (!next || next === a.name) return;
    setBusy(a.id);
    try {
      await api.updateAgent(a.id, {
        name: next,
        definition: { ...(a.definition ?? {}), name: next } as Agent["definition"],
      });
      fb.success("名字改好了", next);
      await load();
    } catch (e) {
      fb.error("改名失败", e instanceof Error ? e.message : String(e));
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
                <div className="min-w-0 flex-1">
                  {renaming === a.id ? (
                    <input
                      autoFocus
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void rename(a);
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={() => void rename(a)}
                      /* 点开就全选：直接打字即覆盖，不用先删 */
                      onFocus={(e) => e.currentTarget.select()}
                      className="input text-[14px]"
                      placeholder="给它起个名字"
                    />
                  ) : (
                    <Link
                      href={`/agents/${a.id}`}
                      className="font-medium text-[14.5px] hover:text-[var(--color-accent)] truncate block"
                    >
                      {a.name}
                      {a.definition?.role === "orchestrator" && (
                        <span className="shrink-0 rounded-full border px-1.5 py-[1px] text-[10.5px]" style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }} title="编排者：分析任务 → 管理上下文 → 验证结果 → 归纳总结">✦ 编排者</span>
                      )}
                    </Link>
                  )}
                  {/* 原来这行是 `slug · v2 · ag_4afeff0c121943bd` —— 24 位 id 是**开发者噪声** ✗
                      （卡片上没人要用 id 认助手，详情页里仍然完整保留 ✓）
                      只留"认得出来是谁 + 第几版"这两条人对人说话会用的信息 ✓ */}
                  <div className="text-[11.5px] text-[var(--color-muted)] mono mt-0.5">
                    {a.slug} · v{a.version}
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
                  <Hint text={HINTS.skill}>Skills</Hint>{" "}
                  <span className="mono text-[var(--color-text)]">
                    {a.definition?.skills?.length ?? 0}
                  </span>
                </span>
                <span>更新 {fmt.relative(a.updated_at)}</span>
              </div>

              {/* 卡上动作：设置（主）+ ⋯（次级）—— 原来还有「聊天」，已按用户要求移除 ✓ */}
              <div className="flex flex-wrap gap-2 mt-4 pt-3 border-t border-[var(--color-border)]">
                {/* **聊天入口已移除**（用户："移除 Agents 上聊天的功能"）——
                    Agents 页只负责"配好这个助手"；要用它请去 Playground 把它放进流程（用起来 = 编排的一部分）。
                    卡上仍留一个明确的主操作：设置（名字本身也是入口 ✓），次级动作全在 ⋯ 里 ✓ */}
                <Link href={`/agents/${a.id}`} className="btn btn-primary flex-1 text-center text-[12.5px]">
                  设置
                </Link>
                {/* 卡上只留**一个**主操作（聊天 = 用它）+ 一个「⋯」（设置 / 改名 / 复制 / 删除）
                    —— 原来 5 个动作平铺：`设置` 与"点名字进设置"重复，4 个次级动作把主操作挤小了 ✗
                    （用户准绳：操作更少、看到更多；触屏上尤其明显 ✓） */}
                <div className="relative">
                  <button
                    type="button"
                    className="btn px-2.5 text-[12.5px]"
                    disabled={busy === a.id}
                    onClick={() => setMenuFor(menuFor === a.id ? null : a.id)}
                    title="更多：设置 / 改名 / 复制 / 删除"
                    aria-label="更多操作"
                  >
                    ⋯
                  </button>
                  {menuFor === a.id && (
                    <div
                      className="absolute bottom-full right-0 z-50 mb-1 min-w-[132px] overflow-hidden rounded-[8px] border py-1 text-[12.5px] shadow-lg"
                      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
                    >
                      <Link
                        href={`/agents/${a.id}`}
                        className="block px-3 py-1.5 text-left hover:bg-[color-mix(in_srgb,var(--color-accent)_7%,transparent)]"
                        onClick={() => setMenuFor(null)}
                      >
                        设置 / 定义
                      </Link>
                      <button
                        type="button"
                        className="block w-full px-3 py-1.5 text-left hover:bg-[color-mix(in_srgb,var(--color-accent)_7%,transparent)]"
                        disabled={busy === a.id}
                        onClick={() => {
                          setMenuFor(null);
                          setRenaming(a.id);
                          setNameDraft(a.name);
                        }}
                      >
                        改名
                      </button>
                      <button
                        type="button"
                        className="block w-full px-3 py-1.5 text-left hover:bg-[color-mix(in_srgb,var(--color-accent)_7%,transparent)]"
                        disabled={busy === a.id}
                        onClick={() => {
                          setMenuFor(null);
                          void duplicate(a.id);
                        }}
                      >
                        复制一份
                      </button>
                      <button
                        type="button"
                        className="block w-full px-3 py-1.5 text-left hover:bg-[color-mix(in_srgb,var(--color-accent)_7%,transparent)]"
                        style={{ color: "var(--color-err)" }}
                        disabled={busy === a.id}
                        onClick={() => {
                          setMenuFor(null);
                          void remove(a);
                        }}
                      >
                        删除…
                      </button>
                    </div>
                  )}
                </div>
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
  /** 它在流程里扮演什么角色 —— 枚举用**选择**，不问不填。
   *  编排者（Orchestrator）自带四项职责：分析任务 / 管理上下文 / 验证结果 / 归纳总结；
   *  在这里就能定下来，省掉"先建一个普通助手、再回详情页改成编排者"那一步。 */
  const [newRole, setNewRole] = useState<"worker" | "orchestrator">("worker");
  const [runtime, setRuntime] = useState(runtimes[0]?.name ?? "agentscope");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [credRef, setCredRef] = useState("");
  const [prompt, setPrompt] = useState("");
  /** 一句话职责 —— 会出现在选助手的地方（Playground 的「＋ 加一步」气泡）。
      默认跟预设走（预设的 desc 就是一句现成的职责），可改 —— 用户不用为一个字段多想。 */
  const [desc, setDesc] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 关闭的两步确认态（首次点关闭 → 变成"再点一次"）。
   *  用户明确要求：破坏性/丢改动的动作**不用原生弹窗**，用变色 + 再点一次。 */
  const [confirmClose, setConfirmClose] = useState(false);

  /** 填过东西没有 —— 决定了关闭要不要两步确认（空表单直接关） */
  const dirty = !!(name.trim() || presetKey || prompt.trim() || desc.trim());

  const requestClose = () => {
    if (dirty && !confirmClose) {
      setConfirmClose(true);
      window.setTimeout(() => setConfirmClose(false), 4000);   // 4 秒内有效
      return;
    }
    onClose();
  };

  /** Esc 关闭（浮层再长也能关；未保存时同样走两步确认） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, confirmClose]);

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
        // 一句话职责必带：没手填就用预设的（预设的 desc 本来就是一句职责）——
        // 这样"新建的助手"天然就有可展示的职责，不用回头补。
        description: (desc.trim() || preset?.desc || "").slice(0, 140) || undefined,
        definition: {
          runtime,
          name: name.trim(),
          role: newRole,
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
    <div
      className="fixed inset-0 bg-[var(--color-overlay)] flex items-start sm:items-center justify-center p-4 z-50 overflow-auto"
      onClick={requestClose}
    >
      {/* 面板本体：点它不关（否则点输入框就把弹层关掉了） */}
      {/* 手机上：面板最高 92vh、内容自己滚、**「取消 / 创建」常驻底部** ——
          否则"创建"被顶到视口外面，手指要先把整个表单滚到底才够得到 ✗（实测过） */}
      <div
        className="card w-full max-w-lg p-5 my-auto flex max-h-[92dvh] flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部：标题 + **右上角固定的关闭键** —— 之前只有最底部一个"取消"，
            内容一长就得滚到底才找得到，用户反馈"弹出来关不掉"。 */}
        <div className="mb-4 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-medium mb-1">新建助手</h2>
            <p className="text-[12.5px] text-[var(--color-muted)]">
              回答三个问题就行，其他的它会自己配好。
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <button
              type="button"
              onClick={requestClose}
              title="关闭（Esc）"
              aria-label="关闭"
              className="rounded-[8px] px-2 py-1 text-[15px] leading-none hover:bg-[var(--color-surface-2)]"
              style={{ color: confirmClose ? "var(--color-err)" : "var(--color-muted)" }}
            >
              ✕
            </button>
            {confirmClose && (
              <span className="text-[11.5px]" style={{ color: "var(--color-err)" }}>
                再点一次关闭，填的内容会丢
              </span>
            )}
          </div>
        </div>

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
                      // 分类与角色是**正交**的两个维度，所以不合并成一道题；
                      // 但选了「编排、统筹」这类，角色跟着预选上，省一次点击（③ 仍可改）
                      setNewRole(p.key === "orchestrator" ? "orchestrator" : "worker");
                      if (p.key !== "custom") {
                        setPrompt(p.prompt);
                        setDesc(p.desc); // 一句话职责跟预设走（用户可改，不用自己编）
                      }
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

          {/* ③ 角色 —— 枚举就两个，做成"选一张卡"，不让人打字（用户："让用户选择而不是输入"） */}
          <div>
            <label
              className="label flex items-center gap-1.5"
              title="干活：做完自己这一步就交给下一个。编排者：对整条流程负责 —— 先把目标分析清楚、管好上下文，最后验证结果并归纳总结；适合放在流程的最开始或最后。"
            >
              <span className="text-[var(--color-accent)] font-semibold">③</span>
              它在流程里扮演什么角色？
            </label>
            <div className="grid grid-cols-2 gap-2">
              {([
                { v: "worker" as const, t: "干活", d: "做完这一步，交给下一个" },
                { v: "orchestrator" as const, t: "编排者", d: "分析任务 / 管上下文 / 验结果 / 归纳" },
              ]).map((o) => {
                const on = newRole === o.v;
                return (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => setNewRole(o.v)}
                    className="rounded-[10px] border px-3 py-2 text-left"
                    style={{
                      borderColor: on ? "var(--color-accent)" : "var(--color-border)",
                      background: on ? "color-mix(in srgb, var(--color-accent) 6%, transparent)" : "var(--color-surface)",
                    }}
                  >
                    <div className="text-[13px] font-medium" style={{ color: on ? "var(--color-accent)" : undefined }}>
                      {o.t}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-[var(--color-muted)]">{o.d}</div>
                  </button>
                );
              })}
            </div>
            {newRole === "orchestrator" && (
              <div className="mt-1.5 text-[11.5px] text-[var(--color-muted)]">
                建好之后可以在它的详情页看到并修改**编排者的职责定义**。
              </div>
            )}
          </div>
            {/* 一句话职责：不在"三个问题"里 —— 选预设时自动带出来，想改才改。
                它决定了用户在选助手时能不能一眼认出这个助手。 */}
            <div className="mt-3">
              <label className="label flex items-center gap-1.5" title="这句话会出现在 Playground 选助手的地方，帮你一眼认出它">
                一句话职责
                <span className="text-[11.5px] font-normal" style={{ color: "var(--color-muted)" }}>
                  （选助手时会显示，已按预设自动填好）
                </span>
              </label>
              <input
                className="input"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="例如：查服务状态；帮你写代码、找 bug"
                maxLength={60}
              />
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
              <span className="text-[var(--color-accent)] font-semibold">④</span>
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

        {/* 动作条：吸在面板底部（sticky），窗口再小也够得到 */}
        <div
          className="sticky bottom-0 -mx-5 mt-5 flex justify-end gap-2 border-t bg-[var(--color-surface)] px-5 pb-1 pt-3"
          style={{ borderColor: "var(--color-border)" }}
        >
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
