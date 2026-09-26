"use client";

import Link from "next/link";
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, fmt, STATUS_STYLE } from "@/lib/api";
import type {
  Agent,
  AgentDefinition,
  Credential,
  Issue,
  McpServer,
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
import { RevisionHistory } from "@/components/RevisionHistory";
import { PermissionScope, type PermConf } from "@/components/PermissionScope";
import { Hint } from "@/components/ui/hint";
import { ModelPicker } from "@/components/ModelPicker";
import { RunPanel } from "@/components/AgentRunPanel";
import { useFeedback } from "@/components/ui/feedback";

/** 可折叠分段：**段头常驻 + 一句状态摘要**，内容按需展开 —— 一屏看一段 ✓
    用户准绳「操作更少、看到更多」：折叠不是藏起来，摘要一直在段头上 ✓ */
function Fold({ title, summary, defaultOpen = false, children }: { title: string; summary?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="card mb-4 overflow-hidden">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <span className="text-[14px] font-medium">{title}</span>
        {summary && <span className="truncate text-[12px]" style={{ color: "var(--color-muted)" }}>{summary}</span>}
        <span className="ml-auto shrink-0 text-[12px]" style={{ color: "var(--color-accent)" }}>{open ? "收起" : "展开"}</span>
      </button>
      {open && <div className="border-t px-4 py-3" style={{ borderColor: "var(--color-border)" }}>{children}</div>}
    </section>
  );
}

/** 执行观测的三种视图：给人看 / 给开发者看 / 原始数据 */
type ViewMode = "chat" | "table" | "raw";

/**
 * 助手详情 —— 定义 / 试跑与观测 / 记忆 全在一页。
 *
 * **两种打开方式，同一份实现**：
 *   · 独立页面 /agents/<id>            （inDialog=false，可从列表/概览深链进来）
 *   · 对话页里点「配置」弹出的整屏浮层  （inDialog=true，聊天上下文不丢）
 *
 * 为什么要有浮层这种打开方式：正在聊天时点「配置」跳走，是"做一件事被弹走"——
 * 回来还得重新找回对话。配置和使用是同一件事的两半，不该互相打断。
 */
import { AgentEvalPanel } from "@/components/AgentEvalPanel";

export function AgentDetail({
  agentId,
  inDialog = false,
}: {
  agentId: string;
  /** 由浮层打开时为 true：隐藏"← Agents"（浮层里没有"上一层"），改用关闭按钮 */
  inDialog?: boolean;
}) {
  const fb = useFeedback();
  const router = useRouter();

  const [agent, setAgent] = useState<Agent | null>(null);
  const [def, setDef] = useState<AgentDefinition | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [creds, setCreds] = useState<Credential[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  /** 平台里已注册的 MCP 服务器（助手从这里勾选要挂哪些） */
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeCapabilities[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [saving, setSaving] = useState(false);
  /** 空状态里的「同步内置工具」用 —— 就地完成，不跳页 */
  const [syncing, setSyncing] = useState(false);
  /** 工具列表默认**只看已选**（详情页最占屏的就是这一列 ✗）；要看全部再展开 ✓ */
  const [showAllTools, setShowAllTools] = useState(false);
  /** Skills 列表默认只看已选（与工具同款；插在**容器内部**、不动 JSX 结构 ✓） */
  const [showAllSkills, setShowAllSkills] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /**
   * 概览汇总：这个助手「用了什么 + 最近跑成什么样」。
   *
   * 为什么单独取一份：记忆面板和试跑面板各自会拉自己的详情数据，但概览要在
   * **一屏之内**回答"它现在是什么状态"，所以这里取个轻量摘要 ——
   * 一两百毫秒，换来不用上下翻找。
   */
  /**
   * "已保存的样子"的快照（序列化）。
   *
   * 用途：算出当前是否有**未保存的改动**。之前这个页面完全没有这个概念 ——
   * 改了配置界面毫无变化，切走就悄悄丢了，而且试跑用的是**旧版本**却毫无提示。
   */
  const [savedSnap, setSavedSnap] = useState<string>("");
  /** 一句话职责（agent.description）—— 它会显示在 Playground 的选助手气泡里。
      跟 def 分开存（它不属于 definition），但**必须一起参与"未保存"判断**。 */
  const [desc, setDesc] = useState<string>("");
  /** 编排者职责的**平台内置定义**（只读，来自后端）—— 用户问"Orchestrator Agent 为什么没有定义？"
   *  → 定义必须看得见：这里拉出来当占位与对照，用户改了就用他自己的那份。 */
  const [briefDefault, setBriefDefault] = useState<string>("");
  /**
   * 这个助手不存在（被删了 / id 写错）。
   *
   * 单独拎出来是因为它是**最常见**的"打不开"原因 —— 助手被删之后，
   * 任何指向它的旧链接/书签都会落到这里。给一句人话 + 一条出路，
   * 而不是把接口的 "404 Not Found" 原样糊在屏幕上。
   */
  const [notFound, setNotFound] = useState(false);
  const [ov, setOv] = useState<{
    memoryOwn: number | null;
    memoryShared: number | null;
    lastRun: { status: string; at: number; ms: number | null } | null;
  }>({ memoryOwn: null, memoryShared: null, lastRun: null });
  /**
   * 把平台内置工具同步进来。
   *
   * 刻意放在这个页面（而不是让用户去工具页点）：当这个助手一个工具都没有时，
   * 这是让它立刻可用的那一步 —— 属于当前任务的一部分，不该跳页。
   */
  const syncBuiltinTools = async () => {
    setSyncing(true);
    try {
      const r = await api.syncBuiltins("agentscope");
      fb.success("已同步内置工具", `新增 ${r.created ?? 0} 个 · 更新 ${r.updated ?? 0} 个`);
      await load();
    } catch (e) {
      fb.error("同步失败", e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  const load = useCallback(async () => {
    try {
      const [a, p, c, t, s, m, r] = await Promise.all([
        api.agent(agentId),
        api.providers(),
        api.credentials(),
        api.tools(),
        api.skills(),
        api.mcpServers().catch(() => [] as McpServer[]),
        api.runtimes(),
      ]);
      setAgent(a);
      setDef(a.definition);
      setSavedSnap(snap(a.definition, a.description ?? ""));
      setDesc(a.description ?? "");
      setProviders(p);
      setCreds(c);
      setTools(t);
      setSkills(s);
      setMcpServers(m);
      setRuntimes(r);
      setErr(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 后端的文案是中文（"Agent 不存在: ag_xxx"），别只认英文 404
      setNotFound(/404|not found|不存在/i.test(msg));
      setErr(msg);
    }
  }, [agentId]);

  useEffect(() => {
    void api.orchestratorBrief().then((r) => setBriefDefault(r.brief)).catch(() => {});
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

  /**
   * 是否有未保存的改动。
   *
   * ⚠️ 必须定义在**下面这个 effect 之前**：effect 的依赖数组 `[dirty]` 是在
   * 渲染期求值的，如果 dirty 声明在后面，这里会撞上 TDZ
   * （Cannot access 'dirty' before initialization）→ 整页白掉。
   */
  const snap = (d: AgentDefinition, s: string) => JSON.stringify(d) + "|" + s;
const dirty = def !== null && savedSnap !== "" && snap(def, desc) !== savedSnap;

  /**
   * 有未保存改动时，关页面/刷新给个提示（不然改了半天一刷新全没）。
   *
   * ⚠️ 这个 effect **必须放在下面那个 `if (!def || !agent)` 早退之前** ——
   * 首次渲染 def 还是 null 会走早退，数据到了才执行到这里；如果它排在早退之后，
   * 两次渲染的 hook 数量就不一致，React 会直接抛错、整页白掉。
   * （踩过一次：页面变成 "This page couldn't load"。）
   */
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /** 最新 def 的快照：名称自动保存是**异步**的，不能拿旧闭包里的 def 覆盖别的字段。 */
  const defRef = useRef(def);
  defRef.current = def;

  /** 名称自动落库的定时器：改完停 900ms 存一次（不依赖是否触发失焦）。 */
  const nameTimer = useRef<number | null>(null);

  if (!def || !agent) {

    if (notFound) {
      return (
        <div className="p-4 md:p-6 lg:p-7 max-w-lg">
          <div className="card p-5">
            <h1 className="text-[16px] font-medium mb-2">这个助手不存在</h1>
            <p className="text-[13px] text-[var(--color-muted)] mb-4">
              它可能已经被删除了（旧链接或书签会落到这里）。平台现有的助手在列表里。
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <a className="btn btn-primary" href="/agents">
                去助手列表
              </a>
              <a className="btn" href="/agents">
                回 Agents 列表
              </a>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="p-4 md:p-6 lg:p-7 text-[13px] text-[var(--color-muted)]">
        {err ? `加载失败：${err}` : "加载中…"}
      </div>
    );
  }

  const caps = runtimes.find((r) => r.name === def.runtime);

  /**
   * 这个助手实际挂上的工具（平台侧命名）。
   * 权限规则只对助手真有的工具才有意义 —— 所以只列这些，不把全平台工具都倒出来。
   */
  const selectedToolNames = def.tools
    .filter((t) => t.enabled)
    .map((t) => tools.find((x) => x.id === t.ref)?.name)
    .filter((x): x is string => Boolean(x));

  /**
   * 当前运行时的权限 scope。
   * 刻意放在 ``runtime_options``（运行时专有配置的逃生舱）而不是通用定义里 ——
   * "权限"是 AgentScope 的概念，别的运行时未必有；这样通用层零改动。
   */
  const permConf = def.runtime_options?.[def.runtime]?.permission as PermConf | undefined;
  const providerMeta = providers.find((p) => p.name === def.model.provider);
  /** 这个助手实际用的那条 LLM 配置 */
  const usedCred = creds.find((c) => c.id === def.model.credential_ref) ?? null;
  const usableCreds = creds.filter((c) => c.provider === def.model.provider);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");

  const patch = (p: Partial<AgentDefinition>) => setDef({ ...def, ...p });

  /** 只改名字的轻量保存：失焦时调用。
   *  同时写顶层 name 与 def.name（历史数据里这两个可能已经不一致，保存一次就统一）。 */
  const saveNameOnly = async (next: string) => {
    try {
      const updated = await api.updateAgent(agentId, {
        name: next,
        definition: { ...((defRef.current ?? def) as AgentDefinition), name: next },
      });
      setAgent(updated);
      setDef(updated.definition);
      setSavedSnap(snap(updated.definition, updated.description ?? ""));
      setMsg("名称已保存");
      setTimeout(() => setMsg(null), 2000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };


  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      // **顶层 name 必须一起提交** —— 名字输入框改的是 def.name，
      // 而列表 / 画布节点 / 顶栏显示的都是**顶层** agent.name；
      // 之前只提交 definition，顶层 name 永远不更新 →
      // 用户改完名字保存"没反应"（与 workflow 改名失效同一类问题：一个字段两个真相）。
      // 这里让两者始终一致：以 def.name 为准，空则保留原名。
      const nextName = (def.name ?? "").trim() || agent?.name;
      const updated = await api.updateAgent(agentId, {
        name: nextName,
        definition: def,
        description: desc.trim() || undefined,
      });
      setAgent(updated);
      setDef(updated.definition);
      setSavedSnap(snap(updated.definition, updated.description ?? ""));
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

  /** 勾/取消一台 MCP 服务器 —— 清单由探测得到，这里只记"挂哪几台" */
  const toggleMcp = (id: string) => {
    const cur = def.mcp_servers ?? [];
    patch({ mcp_servers: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
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
          {!inDialog && (
            <Link href="/agents" className="text-[12px] text-[var(--color-muted)]">
              ← Agents
            </Link>
          )}
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
          {dirty && !saving && (
            <span
              className="text-[11.5px] flex items-center gap-1"
              style={{ color: "var(--color-warn)" }}
              title="改动还没写回去 —— 点「保存改动」，或离开前会被提醒"
            >
              <span className="live-dot">●</span> 有未保存的改动
            </span>
          )}
          <button
            className="btn"
            onClick={async () => {
              const c = await api.duplicateAgent(agentId, {});
              if (inDialog) {
                // 浮层里不跳走：复制完就地告知，用户可以在浮层里继续，或自己切过去
                setMsg(`已复制为「${c.name}」，可在助手列表找到`);
                return;
              }
              router.push(`/agents/${c.id}`);
            }}
          >
            复制为副本
          </button>
          <button className="btn btn-primary" disabled={saving} onClick={save}>
            {saving ? "保存中…" : dirty ? "保存改动" : "保存"}
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

      {/* ── 概览：**一行**说清"这个助手现在是什么状态" ───────────────────
          原来这里是**四块等宽格子**（模型 / 工具 / Skills / 记忆），每块三行（标题 + 值 + 小注）
          —— 一屏最贵的位置用四格回答四个数字 ✗，而下面「工具」「Skills」「记忆」各有完整章节
          → 同一条信息被显示了两次 ✗（用户准绳：操作更少、看到更多）
          改成一行副标题：值在前、口径在后（`工具 7/12` 的"已选/可用"一眼就懂 ✓），
          要细看就去各自那一节 ✓ */}
      <section className="card p-4 mb-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
          <span className="flex items-center gap-1.5">
            <span className="text-[11.5px] text-[var(--color-muted)]">模型</span>
            <span className="mono break-all">{def.model.name || "—"}</span>
            <span className="text-[11.5px] text-[var(--color-muted)]">
              {providers.find((x) => x.name === def.model.provider)?.display_name ??
                def.model.provider}
              {usedCred ? ` · ${usedCred.name}` : " · 用环境变量密钥"}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-[11.5px] text-[var(--color-muted)]">工具</span>
            <span className="mono">
              {def.tools.length}
              <span className="text-[var(--color-muted)]">/{tools.length}</span>
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-[11.5px] text-[var(--color-muted)]">Skills</span>
            <span className="mono">
              {def.skills.length}
              <span className="text-[var(--color-muted)]">/{skills.length}</span>
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-[11.5px] text-[var(--color-muted)]">记忆</span>
            <span className="mono">
              {ov.memoryOwn === null || ov.memoryShared === null
                ? "…"
                : `${ov.memoryOwn + ov.memoryShared} 条`}
            </span>
            {ov.memoryOwn !== null && (
              <span className="text-[11.5px] text-[var(--color-muted)]">
                自己的 {ov.memoryOwn} · 共用 {ov.memoryShared}
              </span>
            )}
          </span>
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
              {/* 名称：**失焦就自动保存**。
                  为什么（这是"名称改不了"的真因）：改完输入框后必须手动点「保存改动」，
                  而用户改完常常直接切走/返回列表 → 改动没提交 → 回来还是旧名 ✗
                  Playground 那边是"改停 1.2s 自动存"，两边心智要一致：
                  名称与一句话职责这类**单字段**改动，失焦即落库，不用再找保存键。 */}
              <input
                className="input"
                value={def.name}
                onChange={(e) => {
                  const v = e.target.value;
                  patch({ name: v });
                  // **改完停 900ms 自动落库** —— 不再依赖"用户恰好点到别处触发失焦"。
                  // 用户反复反馈"名称还是不能修改"：改完直接点「← Agents」返回 / 切标签页时，
                  // 失焦那一下的请求不保证落地 → 回来还是旧名 ✗。
                  // 与 Playground 的「改停 1.2s 自动存」同一套心智（用户要求过两边一致）。
                  if (nameTimer.current) window.clearTimeout(nameTimer.current);
                  const next = v.trim();
                  if (next && !(next === agent?.name && next === agent?.definition?.name)) {
                    nameTimer.current = window.setTimeout(() => { void saveNameOnly(next); }, 900);
                  }
                }}
                onBlur={() => {
                  const next = (def.name ?? "").trim();
                  if (!next) return;   // 清空 → 不动（不允许无名）
                  // **只有"两处都已经等于它"才算真没改**。
                  // 之前只跟顶层 agent.name 比 ✗ —— 而历史数据里顶层名与 def.name 可能不一致
                  // （用户那个助手：顶层「测试agent」 vs 内部「火山-AS测试agent」），
                  // 于是"把输入框改成顶层名"会被误判成"没改"直接 return →
                  // 输入框又读回旧值 → 用户看到的就是"名称改不了" ✗（用户反馈原话）。
                  // 现在：只要与**任一**不同，就写回两者（顶层 name 与 def.name 始终一致）。
                  if (next === agent?.name && next === agent?.definition?.name) return;
                  void saveNameOnly(next);
                }}
              />
            </div>
            <div>
              <label
                className="label flex items-center gap-1.5"
                title="这句话会出现在 Playground 选助手的地方，帮你一眼认出这个助手；留空则自动取 System Prompt 的第一句"
              >
                一句话职责
              </label>
              <input
                className="input"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="例如：查服务状态；帮你写代码、找 bug（留空则自动取提示词首句）"
                maxLength={140}
              />
            </div>
            {/* 流程里的角色（用户："agent 分类定义 Orchestrator —— 分析任务，管理上下文，
                验证结果，归纳总结能力，可以放在最开始 agent 和 最后的 agent"）。
                枚举值用**选择器**（不让用户手打）＋ option 里写通俗解释，不出现第二个术语。 */}
            <div>
              <label
                className="label flex items-center gap-1.5"
                title="决定它在流程里扮演什么角色。干活：做完自己这一步就交给下一个。编排者：对整条流程负责 —— 先把目标分析清楚、管好上下文，最后验证结果并归纳总结（适合放在流程的最开始或最后）。"
              >
                流程里的角色
              </label>
              <select
                className="input"
                value={def.role ?? "worker"}
                onChange={(e) => patch({ role: e.target.value as "worker" | "orchestrator" })}
              >
                <option value="worker">干活（默认）—— 做完这一步，交给下一个</option>
                <option value="orchestrator">编排者 —— 分析任务 / 管理上下文 / 验证结果 / 归纳总结</option>
              </select>
              {def.role === "orchestrator" && (
                <div className="mt-2 rounded-[8px] border p-2.5" style={{ borderColor: "var(--color-border)" }}>
                  {/* 两行解释常驻 ✗ → 收进 ?（内容一字未删 ✓ 只是不再每次都占视觉） */}
                  <Hint text="选「编排者」后，这个助手自带四项职责：分析任务 → 管理上下文 → 验证结果 → 归纳总结。下面是它运行时会拿到的定义（可以按这个助手改；留空就用平台默认那份）。" />
                  <textarea
                    className="input mono mt-2"
                    rows={8}
                    style={{ fontSize: 12, lineHeight: 1.7 }}
                    value={def.orchestrator_brief ?? ""}
                    placeholder={briefDefault || "（正在读取平台默认定义…）"}
                    onChange={(e) => patch({ orchestrator_brief: e.target.value })}
                  />
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                      {def.orchestrator_brief ? "正在使用：这个助手自己的定义" : "正在使用：平台默认定义（占位文字就是它）"}
                    </span>
                    {def.orchestrator_brief ? (
                      <button
                        type="button"
                        className="text-[11.5px] underline"
                        style={{ color: "var(--color-accent)" }}
                        onClick={() => patch({ orchestrator_brief: "" })}
                      >
                        恢复平台默认
                      </button>
                    ) : null}
                  </div>
                </div>
              )}
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

          <Fold title="运行时与模型">
            <div className="flex items-center justify-between">
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

              {/* 工作目录 —— **紧挨着权限放**：目录就是权限的边界，
                  "工作目录内直接放行"指的就是它，两者分开说得再清楚也容易脱节 */}
              <div
                className="mt-4 rounded-[10px] border p-3"
                style={{ borderColor: "var(--color-border)" }}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] font-semibold">工作目录</span>
                  <Hint text="这个助手读写文件、跑命令时落东西的目录。它建在平台沙箱里面，出不了沙箱；下面权限里说的「工作目录内」，指的就是它。 只填一个名字（例如 报价调研），不要写路径 —— 写了会被拒绝并退回平台默认。它与下面的权限配合：目录内按权限放行，出目录一律要你点头。" />
                </div>
                <input
                  className="input mono mt-2 w-full"
                  value={def.workspace ?? ""}
                  placeholder="留空 = 用平台共用的那个"
                  onChange={(e) => patch({ workspace: e.target.value })}
                />
                {/* 原来这里是一段三行的解释常驻在表单里 ✗ —— 只有**第一次配**才需要读它，
                    每次滚动都要重读一遍是浪费。解释搬到旁边那个 ?（点击可开 ✓ 触屏可用 ✓），
                    只留下**会变的那一段**：实际路径（每改一次名字它就变，必须实时可见 ✓） */}
                <p className="mt-1 text-[11.5px] mono" style={{ color: "var(--color-muted)" }}>
                  实际位置：data/work/{def.workspace?.trim() || "…"}
                </p>
              </div>

              {/* 权限 scope —— 由运行时能力决定是否出现（支持人工确认 = 有权限机制） */}
              {caps?.supports_hitl && (
                <PermissionScope
                  conf={permConf}
                  toolNames={selectedToolNames}
                  onChange={(next) =>
                    patch({
                      runtime_options: {
                        ...def.runtime_options,
                        [def.runtime]: {
                          ...(def.runtime_options?.[def.runtime] ?? {}),
                          permission: next,
                        },
                      },
                    })
                  }
                />
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
          </Fold>

          {/* MCP：挂哪几台外部工具服务（在「工具 → MCP」里注册与探测） */}
          <Fold
            title="MCP 工具"
            summary={`${(def.mcp_servers ?? []).length} 已选 / ${mcpServers.length} 已注册`}
          >
            <h2 className="text-[14px] font-medium mb-3 flex items-center gap-1.5">
              <Hint text="MCP 是一套标准协议：别人写好的工具服务，用这个协议接进来就能给助手用。挂上之后，它有哪些工具由服务器说了算（平台负责探测）。">
                MCP 工具
              </Hint>
              （{(def.mcp_servers ?? []).length} 已选 / {mcpServers.length} 已注册）
            </h2>
            {mcpServers.length === 0 ? (
              <p className="text-[12.5px] text-[var(--color-muted)]">
                还没有注册 MCP 服务器。去{" "}
                <a href="/tools" className="underline" style={{ color: "var(--color-accent)" }}>
                  工具 → MCP
                </a>{" "}
                注册一台（本地的 npx 服务或远端地址都行）。
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {mcpServers.map((m) => {
                  const on = (def.mcp_servers ?? []).includes(m.id);
                  return (
                    <label
                      key={m.id}
                      className="flex cursor-pointer items-start gap-2.5 rounded-[8px] border p-2.5"
                      style={{
                        borderColor: on ? "var(--color-accent)" : "var(--color-border)",
                        background: on
                          ? "color-mix(in srgb, var(--color-accent) 5%, transparent)"
                          : "transparent",
                      }}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={on}
                        onChange={() => toggleMcp(m.id)}
                      />
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium">{m.name}</span>
                        <span className="block text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                          {!m.enabled
                            ? "已停用（挂上也不会加载）"
                            : m.last_probe_ok
                              ? `${m.tools.length} 个工具`
                              : "还没探测成功，去工具页点「重新探测」"}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </Fold>

          <Fold title="工具" summary={`${def.tools.length} 已选 / ${tools.length} 可用`}>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-[14px] font-medium">
                工具（{def.tools.length} 已选 / {tools.length} 可用）
              </h2>
              {tools.length > 0 && (
                <button
                  type="button"
                  className="ml-auto text-[12px] hover:underline"
                  style={{ color: "var(--color-accent)" }}
                  onClick={() => setShowAllTools((v) => !v)}
                >
                  {showAllTools ? "只看已选" : `显示全部 ${tools.length} 个`}
                </button>
              )}
            </div>
            {tools.length === 0 ? (
              // 空状态里直接给"最常见的那一步"：不必为了同步内置工具跳去工具页
              // 再跳回来（回来还得重新找到这个助手）。创建自定义工具是另一件事，
              // 保留为次要链接。
              <div className="space-y-2.5">
                <p className="text-[12.5px] text-[var(--color-muted)]">
                  还没有工具。先把内置工具同步进来就能用了。
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={syncing}
                    onClick={() => void syncBuiltinTools()}
                  >
                    {syncing ? "同步中…" : "同步内置工具"}
                  </button>
                  <Link
                    href="/tools"
                    className="text-[12px] text-[var(--color-muted)] hover:underline"
                  >
                    或创建自定义 HTTP 工具 →
                  </Link>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5 max-h-72 overflow-auto">
                {!showAllTools && def.tools.length === 0 && (
                  <p className="px-2 py-1.5 text-[12.5px]" style={{ color: "var(--color-muted)" }}>
                    还没勾选任何工具 —— 点右上「显示全部 {tools.length} 个」挑几个。
                  </p>
                )}
                {(showAllTools ? tools : tools.filter((t) => def.tools.some((x) => x.ref === t.id))).map((t) => {
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
          </Fold>

          <Fold
            title="Skills"
            summary={`${def.skills.length} 已选 / ${skills.length} 可用`}
          >
            {skills.length === 0 ? (
              // Skill 必须填导入来源（Git / URL / 本地路径），是个完整表单 ——
              // 留在它自己的页面比塞进弹框更清楚，所以这里只做引导。
              <p className="text-[12.5px] text-[var(--color-muted)]">
                还没有 Skill。Skill 需要填导入来源（Git 仓库 / URL / 本地路径），去{" "}
                <Link href="/skills" className="text-[var(--color-accent)]">Skills</Link> 页导入。
              </p>
            ) : (
              <div
                className="space-y-1.5 max-h-72 overflow-auto"
                data-hide-off={!showAllSkills && def.skills.length > 0 ? "1" : undefined}
              >
                {/* 开关放在容器**内部第一行** —— 不引入兄弟节点，JSX 结构零改动 ✓
                    （上一版插在容器外面 → 括号里出现两个元素 → TS2657 ✗） */}
                <div className="mb-1.5 flex items-center gap-2 text-[12px]">
                  <span style={{ color: "var(--color-muted)" }}>
                    {showAllSkills ? "全部" : "已选"} {showAllSkills ? skills.length : def.skills.length} 个
                  </span>
                  {skills.length > 0 && (
                    <button
                      type="button"
                      className="ml-auto hover:underline"
                      style={{ color: "var(--color-accent)" }}
                      onClick={() => setShowAllSkills((v) => !v)}
                    >
                      {showAllSkills ? "只看已选" : `显示全部 ${skills.length} 个`}
                    </button>
                  )}
                </div>
                {skills.map((s) => {
                  const on = def.skills.some((x) => x.ref === s.id);
                  return (
                    <label
                      key={s.id}
                      className={`flex items-start gap-2.5 p-2 rounded-md hover:bg-[var(--color-surface-2)] cursor-pointer ${on ? "" : "sk-off"}`}
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
          </Fold>
        </div>

      {/* ── 历史版本 ───────────────────────────────────────────────
          放在"配置"与"使用"之间：它属于配置（改坏了退回去），
          但又不是每次都看 —— 所以不做成常驻工具条，做成一个可折叠感的区。 */}
      <div id="sec-revisions" className="scroll-mt-14">
        <Fold title="历史版本">
        <RevisionHistory kind="agent" targetId={agentId} onRestored={() => void load()} />
        </Fold>
      </div>

      {/* ── 试跑与观测 ─────────────────────────────────────────── */}
          <Fold
          title="试跑与观测"
          summary={
            ov.lastRun
              ? `最近：${ov.lastRun.status} · ${fmt.relative(ov.lastRun.at)}`
              : "还没跑过"
          }
        >
        <RunPanel
          agentId={agentId}
          agentName={agent.name}
          disabled={errors.length > 0}
          unsaved={dirty}
          onSave={save}
        />
          </Fold>

      {/* ── 评测 ─────────────────────────────────────────────────
          "我改了提示词，到底变好了还是变坏了？" —— 用同一套用例跑两次才有答案。
          放在助手页里（评测是这个助手的事），不新开导航/不加 tab。 */}
      <div id="sec-evals" className="scroll-mt-14">
        <Fold title="评测" summary={undefined}>
          <AgentEvalPanel agentId={agentId} disabled={dirty} />
        </Fold>
      </div>

      {/* ── 记忆 ───────────────────────────────────────────────── */}
      {/* 不另加外层标题：记忆面板的卡片自带「记忆」标题，再加一层就重复了 */}
      <div id="sec-memory" className="scroll-mt-14">
        <Fold
          title="记忆"
          summary={
            ov.memoryOwn === null
              ? undefined
              : `自己的 ${ov.memoryOwn} · 共用 ${ov.memoryShared}`
          }
        >
        <AgentMemoryPanel agentId={agentId} />
        </Fold>
      </div>
    </div>
  );
}

/*
 * 注：RunPanel / EventTable / AgentMemoryPanel 已拆到
 *   @/components/AgentRunPanel.tsx
 *   @/components/AgentMemoryPanel.tsx
 * 原先它们都堆在本文件末尾（1400+ 行），拆开后单文件更易维护。
 */
