"use client";

import Link from "next/link";
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useImeGuard } from "@/lib/ime";
import { api, fmt, STATUS_STYLE } from "@/lib/api";
import type {
  Agent,
  AgentDefinition,
  Credential,
  Issue,
  McpServer,
  Memory,
  MemoryPolicy,
  ModelSpec,
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
import { AgentQuickRun } from "@/components/AgentQuickRun";
import { Segmented } from "@/components/ui/kit";
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
import { CapabilityPicker } from "@/components/CapabilityPicker";

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
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const nameIme = useImeGuard();
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
    lastRun: { status: string; at: number; ms: number | null; id: string; error: string | null } | null;
  }>({ memoryOwn: null, memoryShared: null, lastRun: null });
  /** 「最近 error」就地展开的错误详情行（仅 error 徽标可点开） */
  const [lastRunOpen, setLastRunOpen] = useState(false);
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
                id: last.id,
                error: last.error,
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
   * 从对话页的「总是允许？去助手权限里配」跳过来（`?focus=permission`）：
   * 滚到权限块并高亮一下 —— 不然用户点完链接落在一个几百行长的配置页顶部，
   * 还得自己找「权限」在哪，等于把问题丢回给他。
   */
  useEffect(() => {
    if (!def) return;
    const target = new URLSearchParams(window.location.search).get("focus");
    if (target !== "permission") return;
    const timer = setTimeout(() => {
      const el = document.querySelector('[data-focus="permission"]');
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      (el as HTMLElement).style.transition = "box-shadow .4s";
      (el as HTMLElement).style.boxShadow = "0 0 0 3px color-mix(in srgb, var(--color-accent) 35%, transparent)";
      setTimeout(() => {
        (el as HTMLElement).style.boxShadow = "none";
      }, 2200);
    }, 350);
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
      // 重名等保存失败：就地红字提示（顶栏 msg 位置），并把输入框弹回当前有效名
      const msg = e instanceof Error ? e.message : String(e);
      setMsg(null);
      setNameErr(msg);
      setDef((d) => ({ ...(d ?? {}), name: agent?.name ?? next }) as AgentDefinition);
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
      <header className="flex items-start justify-between gap-4 mb-5 max-md:mb-3">
        <div className="min-w-0 flex-1">
          {/* 手机：返回键与标题**同一行**（原来是独立一行 36px，加上标题/状态/动作
              页头吃到 148px）；桌面仍是"返回在上、标题在下"。 */}
          <div className="flex flex-col max-md:flex-row max-md:items-center max-md:gap-1">
            {!inDialog && (
              <Link
                href="/agents"
                title="返回 Agents 列表"
                aria-label="返回 Agents 列表"
                className="inline-flex min-h-[36px] items-center text-[12px] text-[var(--color-muted)] max-md:-ml-2 max-md:w-9 max-md:shrink-0 max-md:justify-center max-md:rounded-[7px] lg:min-h-0"
              >
                <span className="md:hidden">←</span>
                <span className="max-md:hidden">← Agents</span>
              </Link>
            )}
            <h1 className="text-[21px] font-semibold tracking-tight mt-1 truncate max-md:mt-0">
              {agent.name}
            </h1>
          </div>
          {/* 一行说清「这个助手现在是什么状态」—— 原来是**四块等宽格子**
              （模型 / 工具 / Skills / 记忆）占一屏最贵的位置，而下面每一节
              又有完整信息 → 同一条信息两处 ✗。并进标题下一行副标题：
              值在前口径在后，要细看就去各自那一节。 */}
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 mt-1.5 text-[12px] text-[var(--color-muted)]">
            <span className="mono break-all" title="这个助手跑在哪个模型上">
              {def.model.name || "未指定模型"}
            </span>
            <span>工具 {def.tools.length}</span>
            {(def.skills.length > 0 || (def.mcp_servers ?? []).length > 0) && (
              <span>
                Skills {def.skills.length}
                {(def.mcp_servers ?? []).length > 0 ? ` · MCP ${(def.mcp_servers ?? []).length}` : ""}
              </span>
            )}
            {ov.memoryOwn !== null && (
              <span>记忆 {ov.memoryOwn + (ov.memoryShared ?? 0)}</span>
            )}
            {ov.lastRun && (
              <span className="inline-flex items-center gap-1.5">
                最近
                {/* 失败的 run 就地可展开看原因——原来是纯文字徽标，看到 error
                    却不知道错在哪，要自己绕到别处找现场 ✗ */}
                {ov.lastRun.status === "error" ? (
                  <button
                    data-tap
                    className="mono underline decoration-dotted underline-offset-2"
                    style={{ color: STATUS_STYLE.error, cursor: "pointer" }}
                    title={lastRunOpen ? "收起错误详情" : "展开错误详情"}
                    onClick={() => setLastRunOpen((v) => !v)}
                  >
                    {ov.lastRun.status}
                  </button>
                ) : (
                  <span className="mono" style={{ color: STATUS_STYLE[ov.lastRun.status as keyof typeof STATUS_STYLE] }}>
                    {ov.lastRun.status}
                  </span>
                )}
                {fmt.relative(ov.lastRun.at)}
              </span>
            )}
            <span className="mono opacity-70">{agent.slug} · v{agent.version}</span>
          </div>
          {/* 最近 run 失败时的就地错误详情行（点上面的 error 展开/收起）：
              信息默认可见 vs 页面干净之间的取舍 —— 错误摘要只占一行，折叠时
              用户也始终知道"最近一次失败了"，展开才给完整原因。 */}
          {lastRunOpen && ov.lastRun?.status === "error" && (
            <div className="mt-2 text-[12px] leading-relaxed rounded-[8px] px-3 py-2 max-w-[560px]"
              style={{ background: "color-mix(in srgb, var(--color-err, #dc2626) 8%, transparent)" }}>
              <div className="flex items-center gap-2 flex-wrap">
                <span style={{ color: STATUS_STYLE.error }}>最近一次执行失败</span>
                <span className="text-[var(--color-muted)]">{fmt.relative(ov.lastRun.at)}</span>
                {!inDialog && (
                  <Link
                    href={`/exec?agent=${agentId}`}
                    className="underline underline-offset-2 text-[var(--color-accent)]"
                    title="打开对话页查看完整执行现场"
                  >
                    去对话页看现场
                  </Link>
                )}
              </div>
              {ov.lastRun.error && (
                <p className="mono mt-1 break-all" style={{ color: "var(--color-err, #dc2626)" }}>
                  {ov.lastRun.error}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {msg && <span className="text-[12px] text-[var(--color-ok)]">{msg}</span>}
          {dirty && !saving && (
            <span
              className="text-[12px] flex items-center gap-1"
              style={{ color: "var(--color-warn)" }}
              title="还没保存，点「保存改动」"
            >
              <span className="live-dot">●</span> 有未保存的改动
            </span>
          )}
          <button
            data-tap
            className="btn"
            onClick={async () => {
              const c = await api.duplicateAgent(agentId, {});
              if (inDialog) {
                // 浮层里不跳走：复制完就地告知，用户可以在浮层里继续，或自己切过去
                setMsg(`已复制为「${c.name}」，可在助手列表找到`);
                return;
              }
              router.push(`/agents/detail?id=${c.id}`);
            }}
          >
            复制为副本
          </button>
          {/* 没改动就禁用：点了会白写一条版本记录（save() 无条件 PUT）——
                配置页不该因为「手滑点一下保存」多出一版历史 */}
          <button
            data-tap
            className="btn btn-primary"
            disabled={saving || !dirty}
            title={dirty ? "把这一版写回去（会记一条历史版本）" : "没有未保存的改动"}
            onClick={save}
          >
            {saving ? "保存中…" : dirty ? "保存改动" : "保存"}
          </button>
        </div>
      </header>

      {(errors.length > 0 || warnings.length > 0) && (
        <div className="card p-3.5 mb-4 space-y-1">
          {errors.map((i, n) => (
            <div key={`e${n}`} className="text-[12px] text-[var(--color-err)]">
              ✗ {i.field ? `${i.field}: ` : ""}
              {i.message}
            </div>
          ))}
          {warnings.map((i, n) => (
            <div key={`w${n}`} className="text-[12px] text-[var(--color-warn)]">
              ⚠ {i.field ? `${i.field}: ` : ""}
              {i.message}
            </div>
          ))}
        </div>
      )}



      {/* ── 主体：桌面双列 ──────────────────────────────────────
          左列 = 配置（基础 / 运行时 / 能力 / 历史版本）—— 改这东西的地方；
          右列 = 使用（试跑与观测 / 评测 / 记忆）—— 用这东西的地方。
          商业产品的对象页范式（Linear / Vercel）：配置在主列定宽可读，
          操作/观测在侧列 sticky 常驻 —— 「试跑」不再埋在第 5 段，
          屏幕一进来就能跑。窄屏自动退回单列（右列内容排到配置后面）。
          内容量宽从 1007px 收到 ~760px：System Prompt 一行不再横扫全屏。 */}
      <div className="flex flex-col gap-4 xl:grid xl:grid-cols-[minmax(0,1fr)_400px] xl:items-start">
        {/* ══ 左列：配置 ══ */}
        <div className="min-w-0 space-y-4">
      {/* ── 基础配置 ──────────────────────────
          布局定稿（用户要求以商业产品/UX 视角重排）：
          **单列、按心智模型排序** —— 一个 agent = 基础配置 + 能力（工具/MCP/Skill）
          原来是 2 列 grid 塞 5 个不等高 Fold，视觉错落且顺序对不上心智模型 ✗。 */}
      <div id="sec-define" className="grid gap-4 grid-cols-1 scroll-mt-14">
          <section className="card p-4 space-y-3.5">
            <h2 className="text-[14px] font-medium">定义</h2>
            <div>
              <label className="label">名称</label>
              {nameErr && (
                <p className="text-[12px] mb-1" style={{ color: "var(--color-err)" }}>
                  {nameErr}
                </p>
              )}
              {/* 名称：**失焦就自动保存**。
                  为什么（这是"名称改不了"的真因）：改完输入框后必须手动点「保存改动」，
                  而用户改完常常直接切走/返回列表 → 改动没提交 → 回来还是旧名 ✗
                  Playground 那边是"改停 1.2s 自动存"，两边心智要一致：
                  名称与一句话职责这类**单字段**改动，失焦即落库，不用再找保存键。 */}
              <input
                className="input"
                value={def.name}
                {...nameIme.props}
                onChange={(e) => {
                  const v = e.target.value;
                  if (nameErr) setNameErr(null);
                  // IME 组字期间不启动自动保存计时 —— 拼音打到一半的「名字」
                  // 会被 900ms 定时器落库（组字中间态比选字 Enter 更隐蔽）
                  if (nameIme.blocked(null)) return;
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
                title="Playground 列表里显示这句；留空取提示词首句"
              >
                一句话职责
              </label>
              <input
                className="input"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="例如：查服务状态；写代码、找 bug（留空取首句）"
                maxLength={140}
              />
            </div>
            {/* 流程里的角色（用户："agent 分类定义 Orchestrator —— 分析任务，管理上下文，
                验证结果，归纳总结能力，可以放在最开始 agent 和 最后的 agent"）。
                枚举值用**选择器**（不让用户手打）＋ option 里写通俗解释，不出现第二个术语。 */}
            <div>
              <label
                className="label flex items-center gap-1.5"
                title="干活：做完交下一步。编排者：管整条流程，最后验证归纳"
              >
                流程里的角色
              </label>
              <select
                className="input"
                value={def.role ?? "worker"}
                onChange={(e) => patch({ role: e.target.value as "worker" | "orchestrator" })}
              >
                <option value="worker">干活（默认）· 做完交给下一个</option>
                <option value="orchestrator">编排者 · 分析 → 上下文 → 验证 → 归纳</option>
              </select>
              {def.role === "orchestrator" && (
                <div className="mt-2 rounded-[8px] border p-2.5" style={{ borderColor: "var(--color-border)" }}>
                  {/* 两行解释常驻 ✗ → 收进 ?（内容一字未删 ✓ 只是不再每次都占视觉） */}
                  <Hint text="编排者自带四件事：分析 → 管上下文 → 验证 → 归纳" />
                  <textarea
                    className="input mono mt-2"
                    rows={8}
                    style={{ fontSize: 12, lineHeight: 1.7 }}
                    value={def.orchestrator_brief ?? ""}
                    placeholder={briefDefault || "（正在读取平台默认定义…）"}
                    onChange={(e) => patch({ orchestrator_brief: e.target.value })}
                  />
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                      {def.orchestrator_brief ? "正在使用：助手自己的定义" : "正在使用：平台默认定义（占位文字就是它）"}
                    </span>
                    {def.orchestrator_brief ? (
                      <button
                        type="button"
                        className="text-[12px] underline"
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
                  value={def.limits.max_iters ?? ""}
                  onChange={(e) =>
                    patch({
                      // 清空≠0：Number('')=0 会把「60 轮」静默变成「0 轮（立即停）」，
                      // 清空态先落 null，保存时后端按默认值处理
                      limits: {
                        ...def.limits,
                        max_iters: e.target.value === "" ? null : Number(e.target.value),
                      },
                    })
                  }
                />
                {def.limits.max_iters === -1 ? (
                  <p className="text-[12px] text-[var(--color-warn)] mt-1">
                    ⚠ 不限制轮数 —— 请靠超时兜底
                  </p>
                ) : (
                  <p className="text-[12px] text-[var(--color-muted)] mt-1">
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
                  value={def.limits.timeout_s ?? ""}
                  onChange={(e) =>
                    patch({
                      // 同 max_iters：清空≠0（0 秒超时=立即超时）
                      limits: {
                        ...def.limits,
                        timeout_s: e.target.value === "" ? null : Number(e.target.value),
                      },
                    })
                  }
                />
                <p className="text-[12px] text-[var(--color-muted)] mt-1">
                  默认 60 秒
                </p>
              </div>
              <div>
                <label className="label">花费上限（空 = 不限）</label>
                <input
                  className="input mono"
                  type="number"
                  min={0}
                  step={0.01}
                  placeholder="不限"
                  value={def.limits.max_cost_usd ?? ""}
                  onChange={(e) =>
                    patch({
                      limits: {
                        ...def.limits,
                        max_cost_usd: e.target.value === "" ? null : Number(e.target.value),
                      },
                    })
                  }
                />
                <p className="text-[12px] text-[var(--color-muted)] mt-1">
                  超过就停（按模型单价算）
                </p>
              </div>
            </div>
            {/* 模型与运行时并进同一张「定义」卡：两者回答的是同一件事
                「这个助手是谁、拿什么跑」。原先是两张卡、模型那节还默认收起 ——
                改个模型要先展开一次，多一道门。 */}
            <div className="pt-3.5 mt-1 border-t border-[var(--color-border)]">
              <h3 className="text-[13px] font-medium mb-2.5">模型与运行时</h3>
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
                  <Hint text="产物落这里，出不了沙箱。只填名字（如 报价调研），不要写路径" />
                </div>
                <input
                  className="input mono mt-2 w-full"
                  value={def.workspace ?? ""}
                  placeholder="留空 = 直接用会话目录"
                  onChange={(e) => patch({ workspace: e.target.value })}
                />
                {/* 文件目录隔离 —— 摆成**选择器**而不是让用户填（能枚举的值不给手打），
                    并且把"会话之间看不看得见文件"这句人话放在它旁边 */}
                <div className="mt-2.5">
                  <div className="text-[12.5px] mb-1">文件目录怎么分</div>
                  <Segmented
                    value={def.workspace_isolation ?? "session"}
                    onChange={(v) => patch({ workspace_isolation: v })}
                    options={[
                      { key: "session", label: "每个会话一个" },
                      { key: "shared", label: "所有会话共用一个" },
                    ]}
                  />
                  <p className="mt-1 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                    {(def.workspace_isolation ?? "session") === "shared"
                      ? "多会话共用这个目录：互相可见、同名会覆盖"
                      : "每会话一个目录：互不可见，产物可回流"}
                  </p>
                </div>
                {/* 原来这里是一段三行的解释常驻在表单里 ✗ —— 只有**第一次配**才需要读它，
                    每次滚动都要重读一遍是浪费。解释搬到旁边那个 ?（点击可开 ✓ 触屏可用 ✓），
                    只留下**会变的那一段**：实际路径（每改一次名字它就变，必须实时可见 ✓） */}
                {/* 项目上下文：放在目录里的 AGENTS.md 会被自动读进来 ——
                    这是"这个项目该怎么做"的地方，不该混进上面那个 system prompt（换项目就不适用了） */}
                <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                  放一个 <span className="mono">AGENTS.md</span> 写项目规矩（跑什么命令、产物放哪、别碰哪些文件），
                  每次开工自动读（≤8000 字）。
                </p>
                <p className="mt-1 text-[12px] mono" style={{ color: "var(--color-muted)" }}>
                  实际位置：
                  {(def.workspace_isolation ?? "session") === "shared"
                    ? `data/work/${def.workspace?.trim() || "（沙箱根）"}`
                    : `data/work/sessions/<这个会话的号>/${def.workspace?.trim()}`.replace(/\/$/, "")}
                </p>
              </div>

              {/* 权限 scope —— 由运行时能力决定是否出现（支持人工确认 = 有权限机制） */}
              {caps?.supports_hitl && (
                /* data-focus：对话页的「总是允许？去助手权限里配」会带
                   ?focus=permission 跳过来，靠这个锚点滚到位并高亮一下 */
                <div data-focus="permission">
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
                    // **切 Provider 不动凭据**（v2 修正）：v1「属于新 Provider 就保留」
                    // 挡不住来回切——volcengine→deepseek 时凭据不兼容被清成 null，
                    // 再切回来时凭据已经是 null，无从恢复 = 数据照样丢。
                    // 正解是切 Provider 时 credential_ref 原值保留：凭据下拉按
                    // provider 过滤，不兼容的凭据只是暂时不显示（select 空白），
                    // 切回来原值还在；真正选错凭据由下方不适配提示与保存后的
                    // 运行时校验兜住。
                    patch({
                      model: {
                        ...def.model,
                        provider: e.target.value,
                        name: p?.models?.[0] ?? "",
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
                {/* 切了 Provider 后原凭据不显示（按 provider 过滤掉了），但值还在 ——
                    必须告诉用户"没丢，只是这个 Provider 下看不见"，否则会被当成
                    凭据丢了去手填（v2 修复的根源误会）。 */}
                {usedCred && usedCred.provider !== def.model.provider && (
                  <p className="mt-1 text-[12px]" style={{ color: "var(--color-warn, #d97706)" }}>
                    当前凭据「{usedCred.name}」属于 {usedCred.provider}，与所选 Provider
                    不适配 —— 切回原 Provider 即恢复显示；或改选上面列表中的配置。
                  </p>
                )}
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

            {/* 备用模型：主模型的 key 失效 / 模型下线 / 这家整体 503 时，
                整轮换它重跑一次 —— 否则这条执行直接报废（用户只看到"模型不行"）。
                留空就是"不兜底"，行为和以前一样。 */}
            <div>
              <label className="label">备用模型（可选）</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
                <select
                  className="input"
                  value={def.fallback?.provider ?? ""}
                  onChange={(e) => {
                    const name = e.target.value;
                    if (!name) {
                      patch({ fallback: null });
                      return;
                    }
                    const p = providers.find((x) => x.name === name);
                    patch({
                      fallback: {
                        provider: name,
                        name: p?.models?.[0] ?? "",
                        credential_ref: null,
                      },
                    });
                  }}
                >
                  <option value="">不设 —— 主模型出问题就报错</option>
                  {providers.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.display_name}
                    </option>
                  ))}
                </select>
                {def.fallback && (
                  <ModelPicker
                    providers={providers}
                    provider={def.fallback.provider}
                    credentialId={def.fallback.credential_ref ?? null}
                    value={def.fallback.name}
                    onChange={(v) =>
                      patch({ fallback: { ...(def.fallback as ModelSpec), name: v } })
                    }
                  />
                )}
              </div>
              <p className="mt-1 text-[11.5px] text-[var(--color-muted)]">
                主模型的 key 失效、模型下线或这家整体 5xx 时，这一轮会换它重跑一次（运行记录里会写明换过）。
              </p>
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
            </div>
          </section>

          {/* ── 能力：工具 + MCP + Skills 一个选择器 ──────────────────
              用户心智是「这个助手会什么」一件事，原来三个 Fold 三套交互 ✗
              （AgentScope 的 Toolkit 也是同一只手管 tool/MCP/Skill）。 */}
          <Fold
            title="能力（工具 · MCP · Skills）"
            summary={`${def.tools.length + (def.mcp_servers ?? []).length + def.skills.length} 已选 / ${tools.length + mcpServers.length + skills.length} 可用`}
          >
            {/* 工具按需加载 —— 摆在这里而不是"更多设置"里：它影响的正是这一节的工具数量，
                用户看到"已选 27 个"时最该知道"这 27 个是不是每轮都发给模型" */}
            <label className="flex items-start gap-2 mb-3 cursor-pointer select-none">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={def.tools_lazy !== false}
                onChange={(e) => patch({ tools_lazy: e.target.checked })}
              />
              <span className="text-[12.5px] leading-relaxed">
                工具按需加载
                <span className="block text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                  只把常用工具（读写文件、跑命令、算数据、查资料）的完整定义发给模型；其余只在提示里列名字，
                  模型需要时自己取用。工具越多省得越多（接了 MCP 尤其明显）；关掉 = 全部一次性下发。
                </span>
              </span>
            </label>
            {tools.length === 0 && skills.length === 0 && mcpServers.length === 0 ? (
              <div className="space-y-2.5">
                <p className="text-[12px] text-[var(--color-muted)]">
                  还没有能力可选。先把内置工具同步进来（不用跳页）。
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={syncing}
                    onClick={() => void syncBuiltinTools()}
                  >
                    {syncing ? "同步中…" : "同步内置工具"}
                  </button>
                  <Link href="/tools" className="text-[12px] text-[var(--color-muted)] hover:underline">
                    去工具页创建自定义工具 / 注册 MCP / 导入 Skill →
                  </Link>
                </div>
              </div>
            ) : (
              <CapabilityPicker
                tools={tools}
                skills={skills}
                mcpServers={mcpServers}
                selectedToolIds={def.tools.map((t) => t.ref)}
                selectedSkillIds={def.skills.map((s) => s.ref)}
                selectedMcpIds={def.mcp_servers ?? []}
                onToggleTool={toggleTool}
                onToggleSkill={toggleSkill}
                onToggleMcp={toggleMcp}
              />
            )}
          </Fold>
        </div>
        </div>
        {/* ══ 左列完（定义 + 能力）══ */}

        {/* ══ 右列：用这个助手（sticky）══
            配置页的主操作是「试跑看效果」，所以它是常驻卡片、不进折叠；
            历史版本 / 评测 / 记忆是偶尔才翻的，统一收进一个「更多」段 ——
            之前它们是三个并列的折叠段，把主操作挤到了第 5 段之后。 */}
        <div className="min-w-0 space-y-4 xl:sticky xl:top-4 max-xl:contents">
          <section className="card p-4 max-xl:order-first">
            <div className="flex items-center gap-2 mb-3">
              <h2 className="text-[14px] font-medium">快速试跑</h2>
              <span className="text-[11.5px] text-[var(--color-muted)]">
                一句话，看它这一轮干了什么
              </span>
            </div>
            <AgentQuickRun
              agentId={agentId}
              disabled={errors.length > 0}
              unsaved={dirty}
              onSave={save}
            />
          </section>

          <Fold title="更多（历史版本 · 评测 · 记忆）">
            <div className="space-y-4">
              <div>
                <div className="text-[12px] font-medium mb-2">历史版本</div>
                <RevisionHistory kind="agent" targetId={agentId} onRestored={() => void load()} />
              </div>
              <div>
                <div className="text-[12px] font-medium mb-2">评测</div>
                <AgentEvalPanel agentId={agentId} disabled={dirty} />
              </div>
              <div>
                <div className="text-[12px] font-medium mb-2">
                  记忆
                  {ov.memoryOwn !== null && (
                    <span className="ml-2 font-normal text-[var(--color-muted)]">
                      自己的 {ov.memoryOwn} · 共用 {ov.memoryShared}
                    </span>
                  )}
                </div>
                <AgentMemoryPanel agentId={agentId} />
              </div>
            </div>
          </Fold>
        </div>
        {/* ══ 右列完 ══ */}
      </div>
      {/* ══ 双列容器完 ══ */}
    </div>
  );
}

/*
 * 注：RunPanel / EventTable / AgentMemoryPanel 已拆到
 *   @/components/AgentRunPanel.tsx
 *   @/components/AgentMemoryPanel.tsx
 * 原先它们都堆在本文件末尾（1400+ 行），拆开后单文件更易维护。
 */
