"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";
import { api, fmt } from "@/lib/api";
import { useFirstLoad } from "@/lib/useFirstLoad";
import { isImeEvent } from "@/lib/ime";
import type {
  ActivityItem,
  Agent,
  Credential,
  Provider,
  RuntimeCapabilities,
  Skill,
  Tool,
} from "@/lib/types";
import { Chip, DLG_BACKDROP, DLG_CARD, Empty, KV, PageHead, Row, RowList } from "@/components/ui/kit";
import { DetailPanel } from "@/components/ui/DetailPanel";
import {
  IconChevronRight,
  IconCopy,
  IconGitBranch,
  IconPencil,
  IconPin,
  IconPlay,
  IconSkill,
  IconSpark,
  IconTrash,
  IconWrench,
} from "@/components/ui/icons";
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
    opening: "把要办的事交给我，我先拆清楚再往下派。",
    icon: "✦",
    label: "编排、统筹",
    desc: "管整条流程：分析 → 管上下文 → 验证 → 归纳",
    prompt:
      "你负责统筹与把关：分析目标与交付标准，整理上游产出，核验结果（缺项/矛盾/未做），最后给出结论与待确认项。",
  },
  {
    key: "code",
    opening: "把报错或代码贴给我，我先看看问题在哪。",
    icon: "💻",
    label: "写代码、查错",
    desc: "写代码、找 bug、解释代码",
    prompt:
      "你是一个编程助手。帮用户写代码、排查错误、解释逻辑。直接给可运行的代码并说明关键点；不确定就明说。",
  },
  {
    key: "qa",
    opening: "有什么想弄明白的，直接问。",
    icon: "📚",
    label: "答疑解惑",
    desc: "回答各种问题，把概念讲明白",
    prompt:
      "你是一个知识助手。用通俗的话回答，必要时举例。不确定就说不确定，不要编造。",
  },
  {
    key: "research",
    opening: "给我一个题目或链接，我把要点理出来。",
    icon: "🔍",
    label: "查资料、做整理",
    desc: "查信息、提炼要点、做总结",
    prompt:
      "你是一个资料整理助手。查信息、提炼要点、做结构化总结。先结论后依据，引用要说明来源。",
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
  /** 骨架只在首屏出现；之后的刷新原地更新，避免整页闪一下 */
  const { loaded, markLoaded } = useFirstLoad();
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
  /** 谁是「我派生出来的」—— 直接由列表算，不再为每个助手发一次请求 */
  const childrenOf = (id: string) => agents.filter((x) => x.parent_id === id);

  /** 就地展开的那一行 —— 展开里放「职责 / 工具真名 / Skills 真名 / 最近一次运行」，
   *  不必再跳详情页才能看清一个助手的配置（范式：点哪展开哪）。 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** 工具 / Skills 全量清单：助手卡上原来只写「工具 3」，说不出是**哪三个** */
  const [tools, setTools] = useState<Tool[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  /** 每个助手最近一次运行 —— 一次拉 100 条按 agent 归并，避免每个助手发一次请求 */
  const [lastRuns, setLastRuns] = useState<Record<string, ActivityItem>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, r, p, c, ts, sk, tl] = await Promise.all([
        api.agents(),
        api.runtimes(),
        api.providers(),
        api.credentials(),
        api.tools(),
        api.skills(),
        api.runTimeline({ limit: 100 }),
      ]);
      setAgents(a);
      setRuntimes(r);
      setProviders(p);
      setCreds(c);
      setTools(ts);
      setSkills(sk);
      // 时间线是新的在前 → 第一次遇到某个助手的那条就是它最近一次运行
      const byAgent: Record<string, ActivityItem> = {};
      for (const it of tl.items) {
        if (it.agent_id && !byAgent[it.agent_id]) byAgent[it.agent_id] = it;
      }
      setLastRuns(byAgent);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      markLoaded();
    }
  }, [markLoaded]);

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

  /** 就地换模型：不跳详情页，选完立刻生效（验收要求「改名、换模型不进详情页即可完成」） */
  const quickModel = async (a: Agent, name: string) => {
    if (!name || !a.definition) return;
    setBusy(a.id);
    try {
      const updated = await api.updateAgent(
        a.id,
        {
          name: a.name,
          definition: { ...a.definition, model: { ...a.definition.model, name } },
        },
        a.version,
      );
      setAgents((prev) => prev.map((x) => (x.id === a.id ? { ...x, ...updated } : x)));
      fb.success("模型已换", `${a.name} → ${name}`);
    } catch (e) {
      // 版本冲突（列表里的 version 落后一次保存）：拿最新那份再试一次，
      // 而不是把用户顶到"换个模型还要先刷新"的尴尬处
      const msg = e instanceof Error ? e.message : String(e);
      try {
        const fresh = await api.agent(a.id);
        const def = fresh.definition ?? a.definition;
        const updated = await api.updateAgent(
          a.id,
          { name: fresh.name, definition: { ...def, model: { ...def.model, name } } },
          fresh.version,
        );
        setAgents((prev) => prev.map((x) => (x.id === a.id ? { ...x, ...updated } : x)));
        fb.success("模型已换", `${a.name} → ${name}`);
      } catch {
        fb.error("换模型失败", msg);
        await load();
      }
    } finally {
      setBusy(null);
    }
  };

  const remove = async (agent: Agent) => {
    // 先数清会连带删掉多少会话：只说"一并清理"用户不知道代价多大
    let n = 0;
    try {
      const r = await api.sessions(agent.id);
      n = r.list.length;
    } catch {
      n = 0;
    }
    const ok = await fb.confirm({
      title: `删除助手「${agent.name}」？`,
      description: n
        ? `会同时删掉它的 ${n} 个会话（对话记录不可恢复），记忆绑定与挂载关系一并清理。`
        : "它还没有会话，只删这个助手本身：记忆绑定与挂载关系一并清理。",
      danger: true,
      confirmText: "删除",
    });
    if (!ok) return;
    setBusy(agent.id);
    try {
      await api.deleteAgent(agent.id);
      await load();
      fb.success("已删除", `「${agent.name}」及其记忆绑定一并清理`);
    } catch (e) {
      fb.error("删除 Agent 失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /** 工具的 ref 存的是「工具行的 id」而不是名字 —— 要拿给人看，必须查表换名 */
  const toolName = (ref: string) => tools.find((t) => t.id === ref)?.name ?? ref;
  const skillName = (ref: string) => skills.find((s) => s.id === ref)?.name ?? ref;

  const toggleRow = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="p-4 md:p-6 lg:p-7 max-w-6xl">
      <PageHead
        title="助手"
        // 数据没回来之前不要报 0（复测 F4：先闪一个假 0，几秒后才变真数）
        desc={loaded ? `${agents.length} 个助手 · 点一行看清配置与最近一次` : "正在读取助手清单…"}
        actions={
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>
            + 新建 Agent
          </button>
        }
      />

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
          onCreated={async (created) => {
            setShowNew(false);
            await load();
            // 建完直接进对话页说第一句 —— 不再有「建好之后该干嘛」这一步，
            // 也不用回详情页找「快速试跑」那个重复入口（验收 UX-009）
            fb.success("助手建好了", `「${created.name}」已建好，去说第一句`);
            window.location.href = `/exec?agent=${created.id}`;
          }}
        />
      )}

      {!loaded ? (
        <div className="card p-6 text-[13px] text-[var(--color-muted)]">加载中…</div>
      ) : agents.length === 0 ? (
        <div className="card">
          <Empty
            title="还没有 Agent"
            hint="创建一个，然后定义、试跑、看全过程"
            action={
              <button className="btn btn-primary" onClick={() => setShowNew(true)}>
                创建第一个 Agent
              </button>
            }
          />
        </div>
      ) : (
        /* 一行一个 Agent（原来是每项一张卡片框）。动作**不藏进 ⋯**——常驻可见：
           主操作蓝色「设置 / 定义」→ 次级「改名 / 复制一份」→ 危险「删除」红字靠最右 */
        <RowList>
          {agents.map((a) => {
            const open = expanded.has(a.id);
            const last = lastRuns[a.id];
            const toolNames = (a.definition?.tools ?? []).map((t) => toolName(t.ref));
            const skillNames = (a.definition?.skills ?? []).map((s) => skillName(s.ref));
            const runtime = a.definition?.runtime ?? a.runtime;
            return (
              <Fragment key={a.id}>
                <Row
                  expanded={open}
                  onToggle={() => toggleRow(a.id)}
                  actions={
                    <>
                      <Link
                        href={`/agents/detail?id=${a.id}`}
                        className="btn btn-primary text-[12px] max-md:px-2.5"
                        title="设置 / 定义：改提示词、模型、工具、权限"
                      >
                        <span className="max-md:hidden">设置 / 定义</span>
                        <span className="md:hidden">设置</span>
                      </Link>
                      <button
                        type="button"
                        className="btn text-[12px] max-md:w-9 max-md:px-0"
                        title="改名"
                        aria-label="改名"
                        disabled={busy === a.id}
                        onClick={() => {
                          setRenaming(a.id);
                          setNameDraft(a.name);
                        }}
                      >
                        <IconPencil className="md:hidden" />
                        <span className="max-md:hidden">改名</span>
                      </button>
                      <button
                        type="button"
                        className="btn text-[12px] max-md:w-9 max-md:px-0"
                        aria-label="复制一份"
                        disabled={busy === a.id}
                        title="按这份配置再建一个"
                        onClick={() => void duplicate(a.id)}
                      >
                        <IconCopy className="md:hidden" />
                        <span className="max-md:hidden">复制一份</span>
                      </button>
                      <button
                        type="button"
                        className="btn text-[12px] max-md:w-9 max-md:px-0"
                        style={{ color: "var(--color-err)" }}
                        aria-label="删除"
                        title="删除这个助手（会再确认一次）"
                        disabled={busy === a.id}
                        onClick={() => void remove(a)}
                      >
                        <IconTrash className="md:hidden" />
                        <span className="max-md:hidden">删除</span>
                      </button>
                    </>
                  }
                >
                  <span className="min-w-0 flex-1 basis-[240px]">
                    {renaming === a.id ? (
                      /* 就地改名：点开全选（直接打字即覆盖）。输入框自己的点击不再冒泡，
                         否则点一下就把这一行展开了。 */
                      <input
                        autoFocus
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          // 中文名组字中的回车是选字，不是「改完了」
                          if (e.key === "Enter" && !isImeEvent(e)) void rename(a);
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        onBlur={() => void rename(a)}
                        onFocus={(e) => e.currentTarget.select()}
                        className="input text-[14px]"
                        placeholder="给它起个名字"
                      />
                    ) : (
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[14.5px] font-medium">{a.name}</span>
                        {a.definition?.role === "orchestrator" && (
                          <Chip tone="accent" title="编排者：分析 → 管上下文 → 验证 → 归纳">
                            ✦ 编排者
                          </Chip>
                        )}
                      </span>
                    )}
                    {/* 元信息：图标 + 短词。原来是一整句
                        「deepseek-flash · 工具 25 · Skills 8 · 3 分钟前 ✓」——
                        手机上一换行就变成"一条一条竖着堆"。 */}
                    <span
                      className="mt-1 flex items-center gap-3 text-[11.5px]"
                      style={{ color: "var(--color-muted)" }}
                    >
                      <span className="inline-flex min-w-0 items-center gap-1" title="模型">
                        <IconSpark size={12} className="shrink-0" />
                        <span className="truncate mono">{a.definition?.model?.name || (a.runtime === "a2a" ? "远端管理" : "未指定模型")}</span>
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap" title="挂了多少工具">
                        <IconWrench size={12} />
                        {toolNames.length}
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap" title="挂了多少 Skill">
                        <IconSkill size={12} />
                        {skillNames.length}
                      </span>
                      {last ? (
                        <span
                          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap"
                          title={last.status === "ok" ? "上次跑成功了" : last.status === "error" ? "上次跑失败了" : "上次还没跑完"}
                          style={{
                            color:
                              last.status === "ok"
                                ? "var(--color-ok)"
                                : last.status === "error"
                                  ? "var(--color-err)"
                                  : "var(--color-accent)",
                          }}
                        >
                          <IconPlay size={12} />
                          {fmt.relative(last.at)}
                        </span>
                      ) : (
                        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
                          <IconPlay size={12} />
                          没跑过
                        </span>
                      )}
                    </span>
                  </span>
                  <Chip tone="muted">{runtime}</Chip>
                  <span className="shrink-0" style={{ color: "var(--color-muted)" }}>
                    <IconChevronRight size={16} />
                  </span>
                </Row>

                {open && (
                  <DetailPanel
                    title={a.name}
                    icon={<IconSpark size={22} />}
                    subtitle={
                      <>
                        {a.definition?.role === "orchestrator" && (
                          <Chip tone="accent" title="编排者：分析 → 管上下文 → 验证 → 归纳">
                            编排者
                          </Chip>
                        )}
                        <Chip tone="muted">{runtime}</Chip>
                        <span className="mono">{a.definition?.model?.name || (a.runtime === "a2a" ? "远端管理" : "未指定模型")}</span>
                        <span>v{a.version}</span>
                      </>
                    }
                    facts={[
                      { icon: <IconWrench size={13} />, text: `工具 ${toolNames.length}`, title: "挂了多少工具" },
                      { icon: <IconSkill size={13} />, text: `Skills ${skillNames.length}`, title: "挂了多少 Skill" },
                      last
                        ? { icon: <IconPlay size={13} />, text: `${fmt.relative(last.at)} · ${last.duration_ms != null ? fmt.ms(last.duration_ms) : "运行中"}`, title: last.title }
                        : { icon: <IconPlay size={13} />, text: "还没运行过" },
                      { icon: <IconPin size={13} />, text: a.slug, title: "唯一标识（脚本里用它）" },
                    ]}
                    actions={
                      <>
                        <Link
                          href={`/agents/detail?id=${a.id}`}
                          className="btn btn-primary btn-sm"
                          title="改提示词、模型、工具、权限"
                        >
                          <IconPencil size={14} />
                          设置 / 定义
                        </Link>
                        <Link href={`/exec?agent=${a.id}`} className="btn btn-sm" title="直接拿它跑一次">
                          <IconPlay size={14} />
                          跑一次
                        </Link>
                        <button
                          type="button"
                          className="btn btn-sm"
                          title="按这份配置再建一个"
                          disabled={busy === a.id}
                          onClick={() => void duplicate(a.id)}
                        >
                          <IconCopy size={14} />
                          复制一份
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          title="改名字"
                          disabled={busy === a.id}
                          onClick={() => {
                            setRenaming(a.id);
                            setNameDraft(a.name);
                          }}
                        >
                          <IconPencil size={14} />
                          改名
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm ml-auto"
                          style={{ color: "var(--color-err)" }}
                          title="删除这个助手（会再确认一次）"
                          disabled={busy === a.id}
                          onClick={() => void remove(a)}
                        >
                          <IconTrash size={14} />
                          删除
                        </button>
                      </>
                    }
                    onClose={() => toggleRow(a.id)}
                  >
                    {a.description ? (
                      <div className="mb-3 text-[13px] leading-relaxed">{a.description}</div>
                    ) : null}

                    {/* 就地换模型：看完列表里这行就知道它用哪个模型、能直接换，
                        不用点进详情页改完再回来（验收 UX-014） */}
                    {a.definition && a.definition.runtime !== "a2a" && (
                      <div
                        className="mb-3 rounded-[10px] px-3 py-2.5"
                        style={{ background: "var(--color-surface-2)" }}
                      >
                        <div
                          className="mb-1.5 text-[11.5px]"
                          style={{ color: "var(--color-text-3)" }}
                        >
                          模型（换完立刻生效）
                        </div>
                        <ModelPicker
                          providers={providers}
                          provider={a.definition.model.provider}
                          credentialId={a.definition.model.credential_ref ?? null}
                          value={a.definition.model.name}
                          onChange={(v) => void quickModel(a, v)}
                        />
                      </div>
                    )}

                    {/* 血缘：派生自谁 / 派生出哪些 —— 有血缘才显示，没有就不占一行 */}
                    {(a.parent_id || childrenOf(a.id).length > 0) && (
                      <div className="mb-3 rounded-[10px] px-3 py-2.5" style={{ background: "var(--color-surface-2)" }}>
                        <div className="mb-1.5 inline-flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                          <IconGitBranch size={12} />
                          fork 血缘（助手之间的派生关系）
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
                          {a.parent_id && (
                            <>
                              <span style={{ color: "var(--color-muted)" }}>派生自</span>
                              <Link
                                href={`/agents/detail?id=${a.parent_id}`}
                                className="hover:underline"
                                style={{ color: "var(--color-accent)" }}
                              >
                                {agents.find((x) => x.id === a.parent_id)?.name ?? "（已删除）"}
                              </Link>
                            </>
                          )}
                          {childrenOf(a.id).length > 0 && (
                            <>
                              {a.parent_id ? <span style={{ color: "var(--color-muted)" }}>·</span> : null}
                              <span style={{ color: "var(--color-muted)" }}>派生出</span>
                              {childrenOf(a.id).map((c) => (
                                <Link
                                  key={c.id}
                                  href={`/agents/detail?id=${c.id}`}
                                  className="rounded px-1.5 py-px hover:underline"
                                  style={{
                                    background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
                                    color: "var(--color-accent)",
                                  }}
                                >
                                  {c.name}
                                </Link>
                              ))}
                              <span style={{ color: "var(--color-muted)" }}>（点名字直接跳过去）</span>
                            </>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="grid gap-1.5 md:grid-cols-2">
                      <KV k="工具">
                        {toolNames.length > 0 ? (
                          <span className="flex flex-wrap gap-1">
                            {toolNames.map((n, i) => (
                              <Chip key={n + i} tone="muted">
                                {n}
                              </Chip>
                            ))}
                          </span>
                        ) : (
                          <span style={{ color: "var(--color-muted)" }}>没挂工具（只会聊天）</span>
                        )}
                      </KV>
                      <KV k="Skills">
                        {skillNames.length > 0 ? (
                          <span className="flex flex-wrap gap-1">
                            {skillNames.map((n, i) => (
                              <Chip key={n + i} tone="muted">
                                {n}
                              </Chip>
                            ))}
                          </span>
                        ) : (
                          <span style={{ color: "var(--color-muted)" }}>没挂 Skill</span>
                        )}
                      </KV>
                      <KV k="上限">
                        <span className="mono">
                          {a.definition?.limits?.max_iters ?? "—"} 轮 ·{" "}
                          {a.definition?.limits?.timeout_s ?? "—"}s 超时
                        </span>
                      </KV>
                      <KV k="最近运行">
                        {last ? (
                          <>
                            {fmt.relative(last.at)} · {last.title}
                            {last.duration_ms != null ? ` · ${fmt.ms(last.duration_ms)}` : ""}
                          </>
                        ) : (
                          <span style={{ color: "var(--color-muted)" }}>还没有运行过</span>
                        )}
                      </KV>
                    </div>
                  </DetailPanel>
                )}
              </Fragment>
            );
          })}
        </RowList>
      )}
    </div>
  );
}
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
  onCreated: (created: { id: string; name: string }) => void;
}) {
  const [name, setName] = useState("");
  /** 名字是不是用户自己写的：没写过就跟着模板走（不用为一个字段多想） */
  const [nameTouched, setNameTouched] = useState(false);
  const [presetKey, setPresetKey] = useState<string | null>(null);
  /** 它在流程里扮演什么角色 —— 枚举用**选择**，不问不填 */
  const [newRole, setNewRole] = useState<"worker" | "orchestrator">("worker");
  const [runtime, setRuntime] = useState(runtimes[0]?.name ?? "agentscope");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [credRef, setCredRef] = useState("");
  const [prompt, setPrompt] = useState("");
  const [desc, setDesc] = useState("");
  /** 开场白：新会话第一屏说这句；模板会带一条，可改 */
  const [opening, setOpening] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 关闭的两步确认态（首次点关闭 → 变成"再点一次"） */
  const [confirmClose, setConfirmClose] = useState(false);

  const dirty = !!(name.trim() || presetKey || prompt.trim() || desc.trim() || opening.trim());

  const requestClose = () => {
    if (dirty && !confirmClose) {
      setConfirmClose(true);
      window.setTimeout(() => setConfirmClose(false), 4000);
      return;
    }
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, confirmClose]);

  // 初始化「用哪个 AI」：优先选已经配好密钥的服务商，并自动带上那条密钥
  useEffect(() => {
    const withCred = providers.find((p) => creds.some((c) => c.provider === p.name));
    const p = withCred ?? providers[0];
    if (!p) return;
    setProvider(p.name);
    const c0 = creds.find((x) => x.provider === p.name);
    setModel(c0?.default_model || p.models?.[0] || "");
    setCredRef(c0?.id ?? "");
  }, [providers, creds]);

  const caps = runtimes.find((r) => r.name === runtime);
  const providerMeta = providers.find((p) => p.name === provider);
  const usableCreds = creds.filter((c) => c.provider === provider);
  const preset = PRESETS.find((x) => x.key === presetKey);
  const isCustom = presetKey === "custom";
  const selectedCred = creds.find((c) => c.id === credRef);

  const pickPreset = (p: (typeof PRESETS)[number]) => {
    setPresetKey(p.key);
    // 角色与用途是正交的两个维度，但选了「编排、统筹」这种，角色跟着预选上
    setNewRole(p.key === "orchestrator" ? "orchestrator" : "worker");
    if (p.key !== "custom") {
      setPrompt(p.prompt);
      setDesc(p.desc);
      setOpening(("opening" in p && String(p.opening)) || "");
      if (!nameTouched) setName(p.label);
    }
  };

  const submit = async () => {
    if (!name.trim()) {
      setErr("先给它起个名字（点上面的模板会自动填）");
      return;
    }
    if (!presetKey) {
      setErr("先选一个它要做的事");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const created = await api.createAgent({
        name: name.trim(),
        description: (desc.trim() || preset?.desc || "").slice(0, 140) || undefined,
        definition: {
          runtime,
          name: name.trim(),
          role: newRole,
          system_prompt: prompt.trim() || "你是一个乐于助人的助手。",
          opening_line: opening.trim(),
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
      onCreated({ id: created.id, name: created.name || name.trim() });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 预览区：右栏就是它建成后的样子（开场白、模型、密钥随输入实时变） */
  const preview = (
    <div className="space-y-3">
      <div className="rounded-[14px] p-4" style={{ background: "var(--color-surface-2)" }}>
        <div className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
          新会话第一屏
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-2xl text-[15px]"
            style={{ background: "var(--color-surface-3)", color: "var(--color-text-2)" }}
          >
            ✦
          </span>
          <span className="truncate text-[14px] font-medium">{name.trim() || "未命名助手"}</span>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "var(--color-text-2)" }}>
          {opening.trim() || desc.trim() || "（还没有开场白，第一屏会是空的）"}
        </p>
        <div
          className="mt-4 flex items-center rounded-[10px] px-3 py-2.5 text-[12.5px]"
          style={{ background: "var(--color-surface)", color: "var(--color-text-3)" }}
        >
          说点什么…
        </div>
      </div>
      <div className="text-[12px] leading-relaxed" style={{ color: "var(--color-text-3)" }}>
        <div>
          模型 <span className="mono">{model || "（建好后在配置里选）"}</span>
        </div>
        <div className="mt-0.5">
          {selectedCred ? `密钥 ${selectedCred.name}` : "这条模型还没配密钥"}
        </div>
        <div className="mt-0.5">
          {newRole === "orchestrator" ? "编排者：分析 → 上下文 → 验证 → 归纳" : "干活：做完交给下一个"}
        </div>
      </div>
    </div>
  );

  return (
    <div className={DLG_BACKDROP} onClick={requestClose}>
      <div
        className="card flex max-h-[92dvh] w-full max-w-[880px] flex-col overflow-hidden rounded-b-none rounded-t-[14px] p-5 sm:my-auto sm:max-h-[88dvh] sm:rounded-[12px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-medium">新建助手</h2>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <button
              type="button"
              onClick={requestClose}
              title="关闭（Esc）"
              aria-label="关闭"
              className="flex h-10 w-10 items-center justify-center rounded-[10px] text-[15px] leading-none hover:bg-[var(--color-surface-2)]"
              style={{ color: confirmClose ? "var(--color-err)" : "var(--color-muted)" }}
            >
              ✕
            </button>
            {confirmClose && (
              <span className="text-[12px]" style={{ color: "var(--color-err)" }}>
                再点一次关闭，填的内容会丢
              </span>
            )}
          </div>
        </div>

        {/* 一页填完：左边配置、右边就是它建成后的样子；手机上预览排在末尾一块 */}
        <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto md:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
          <div className="space-y-4">
            {/* ① 用途模板：点了就把名字、交代、开场白一起带进来 */}
            <div>
              <label className="label">它帮你做什么？（选一个，下面的都会自动填好）</label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {PRESETS.map((p) => {
                  const on = presetKey === p.key;
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => pickPreset(p)}
                      className="rounded-md p-2.5 text-left transition-colors"
                      style={{
                        background: on ? "color-mix(in srgb, var(--color-accent) 10%, transparent)" : "var(--color-surface-2)",
                        outline: on ? "1.5px solid var(--color-accent)" : "none",
                      }}
                    >
                      <div
                        className="text-[13px] font-medium"
                        style={{ color: on ? "var(--color-accent)" : undefined }}
                      >
                        {p.icon} {p.label}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">名字</label>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => {
                    setNameTouched(true);
                    setName(e.target.value);
                  }}
                  placeholder="点上面的模板会自动填"
                  autoFocus
                />
              </div>
              <div>
                <label className="label">一句话职责</label>
                <input
                  className="input"
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder="例如：写代码、找 bug"
                  maxLength={60}
                />
              </div>
            </div>

            <div>
              <label className="label">开场白（新会话第一屏说这句）</label>
              <input
                className="input"
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
                placeholder="例如：把日志或报错贴给我，我帮你定位"
                maxLength={120}
              />
            </div>

            <div>
              <label className="label">它会按这段交代做事（可修改）</label>
              <textarea
                className="input"
                rows={isCustom ? 4 : 3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="例如：你是我的读书笔记助手，整理成要点，语气简洁。"
              />
            </div>

            <div>
              <label className="label">模型</label>
              <ModelPicker
                providers={providers}
                provider={provider}
                credentialId={credRef || null}
                value={model}
                onChange={setModel}
              />
              {providers.length === 0 && (
                <p className="mt-1 text-[12px]" style={{ color: "var(--color-err)" }}>
                  还没有可用的服务商，先去「LLM 配置」加一个。
                </p>
              )}
              {providers.length > 0 && usableCreds.length === 0 && (
                <p className="mt-1 text-[12px]" style={{ color: "var(--color-err)" }}>
                  {providerMeta?.display_name ?? provider} 还没有密钥，建成后跑不起来。
                </p>
              )}
            </div>

            <div>
              <label className="label">它在流程里扮演什么角色</label>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { v: "worker" as const, t: "干活", d: "做完这一步，交给下一个" },
                  { v: "orchestrator" as const, t: "编排者", d: "分析 / 上下文 / 验证 / 归纳" },
                ]).map((o) => {
                  const on = newRole === o.v;
                  return (
                    <button
                      key={o.v}
                      type="button"
                      onClick={() => setNewRole(o.v)}
                      className="rounded-[10px] px-3 py-2 text-left"
                      style={{
                        background: on ? "color-mix(in srgb, var(--color-accent) 8%, transparent)" : "var(--color-surface-2)",
                        outline: on ? "1.5px solid var(--color-accent)" : "none",
                      }}
                    >
                      <div
                        className="text-[13px] font-medium"
                        style={{ color: on ? "var(--color-accent)" : undefined }}
                      >
                        {o.t}
                      </div>
                      <div className="mt-0.5 text-[12px]" style={{ color: "var(--color-text-3)" }}>
                        {o.d}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <button
                type="button"
                data-tap
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex items-center gap-1 text-[12px]"
                style={{ color: "var(--color-accent)" }}
              >
                <span>{showAdvanced ? "▾" : "▸"}</span> 高级设置（一般不用改）
              </button>
              {showAdvanced && (
                <div className="mt-2 space-y-3">
                  <div>
                    <label className="label">运行时</label>
                    <select className="input" value={runtime} onChange={(e) => setRuntime(e.target.value)}>
                      {runtimes.map((r) => (
                        <option key={r.name} value={r.name}>
                          {r.display_name}
                        </option>
                      ))}
                    </select>
                    {caps && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {caps.supports_hitl && <span className="tag">人工确认</span>}
                        {caps.supports_thinking && <span className="tag">思考过程</span>}
                        {caps.supports_skills && <span className="tag">Skill</span>}
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="label">用哪条密钥</label>
                    <select
                      className="input"
                      value={credRef}
                      onChange={(e) => setCredRef(e.target.value)}
                    >
                      <option value="">不指定（运行时再定）</option>
                      {usableCreds.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>

            {err && (
              <div className="text-[12px]" style={{ color: "var(--color-err)" }}>
                {err}
              </div>
            )}
          </div>

          <div className="md:sticky md:top-0 md:self-start">{preview}</div>
        </div>

        <div
          className="sticky bottom-0 -mx-5 mt-4 flex items-center justify-end gap-2 border-t bg-[var(--color-surface)] px-5 pb-1 pt-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <span className="mr-auto text-[12px]" style={{ color: "var(--color-text-3)" }}>
            {presetKey ? "创建后会直接进对话页试一句" : "先选一个它要做的事"}
          </span>
          <button className="btn" onClick={requestClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !name.trim() || !presetKey}
            onClick={submit}
          >
            {busy ? "创建中…" : "创建并开始聊"}
          </button>
        </div>
      </div>
    </div>
  );
}
