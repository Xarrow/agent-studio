"use client";

/**
 * Playground —— 编排工作台。
 *
 * 为什么是"一个工作台"而不是"对话 + 编排两个页面"
 * ------------------------------------------------
 * 这两件事对用户本来是同一件：**把任务交给助手**，区别只有几个助手、怎么分工。
 * 一个节点 = 跟一个助手聊；再加一个 = 编排。所以该被"选"的不是模式，是**参与者**。
 * （模式仍然存在，但它是**推导出来的结果**，显示在顶栏 —— 需要时可覆盖。）
 *
 * 数据分两层，别混：
 *   workflow    设计稿：可反复改、反复跑，存 nodes + edges
 *   orchestration  一次执行：不可变的事实，跑完进「运行记录」
 * 所以画布上的改动只动 workflow，跑的时候才产生 orchestration。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFeedback } from "@/components/ui/feedback";
import { WorkflowCanvas, flattenLayers, type NodeState } from "@/components/WorkflowCanvas";
import {
  StepExecPanel,
  buildNodeLive,
  type NodeLiveInfo,
  type StepBrief,
  type TraceData,
} from "@/components/StepExecPanel";
import { api } from "@/lib/api";
import type {
  Agent,
  OrchestrationDetail,
  OrchestrationStepRead,
  Workflow,
  WorkflowGraph,
} from "@/lib/types";

/** 顶栏可选的执行方式（"" = 自动判断） */
const MODE_OPTIONS: [string, string][] = [
  ["", "自动判断（按连线）"],
  ["single", "单个助手"],
  ["serial", "串行接力"],
  ["parallel", "并行"],
  ["master_worker", "主从（拆任务 + 汇总）"],
  ["dag", "分层（按依赖）"],
];

const STATUS_TO_NODE: Record<string, NodeState> = {
  pending: "wait",
  running: "run",
  waiting_hitl: "ask",
  ok: "ok",
  error: "err",
  aborted: "err",
  skipped: "stale",
};

export function PlaygroundConsole() {
  const fb = useFeedback();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [list, setList] = useState<Workflow[]>([]);
  const [wf, setWf] = useState<Workflow | null>(null);
  const [graph, setGraph] = useState<WorkflowGraph>({ nodes: [], edges: [] });
  const [name, setName] = useState("未命名编排");
  const [modeOverride, setModeOverride] = useState("");
  const [dirty, setDirty] = useState(false);

  const [selected, setSelected] = useState<string | null>(null);
  const [draggingAgentId, setDragging] = useState<string | null>(null);
  /** 拖拽时跟着手指/鼠标的小卡片（用 position:fixed，不受画布滚动影响） */
  const [ghost, setGhost] = useState<{ x: number; y: number; name: string } | null>(null);
  /** 指针正悬停在哪个节点上（画布据此预览"会插到它后面"） */
  const [hoverNid, setHoverNid] = useState<string | null>(null);

  const [task, setTask] = useState("");
  const [running, setRunning] = useState(false);
  const [orcId, setOrcId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrchestrationDetail | null>(null);
  const [runStates, setRunStates] = useState<Record<string, NodeState>>({});
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const [hitl, setHitl] = useState<{ nid: string; runId: string; payload: Record<string, unknown> | null } | null>(null);
  const [showLog, setShowLog] = useState(false);
  /** 每个子步骤的 trace —— **一份数据两处用**（画布上的节点摘要 + 下方详情），
   *  统一在这里轮询，避免画布和详情各拉一遍。 */
  const [traces, setTraces] = useState<Record<string, TraceData>>({});
  const tracesRef = useRef<Record<string, TraceData>>({});
  /** 哪些步骤的过程被收起了（默认全展开：2~3 个助手正好一屏看全） */
  const [closedSteps, setClosedSteps] = useState<Record<string, boolean>>({});
  const esRef = useRef<EventSource | null>(null);
  const nidRef = useRef(1);

  /* ── 载入助手 + 最近的设计稿 ─────────────────────────────────────────── */
  useEffect(() => {
    void (async () => {
      try {
        const [ags, wfs] = await Promise.all([api.agents(), api.workflows(30)]);
        setAgents(ags);
        setList(wfs);
        if (wfs.length) {
          loadWorkflow(wfs[0]);
          // 顺手把这份设计稿**最近一次执行**带出来 —— 一进来就能看到上次每个助手
          // 干了什么（思考/工具/输出），不用先跑一遍才有东西看。
          const lastRuns = await api.workflowRuns(wfs[0].id, 1).catch(() => []);
          const last = lastRuns[0];
          if (last?.id) {
            setOrcId(last.id);          // 列表里的 id 就是编排 id
            subscribe(last.id);
          }
        }
      } catch {
        /* 初次进来拉不到就留空画布，不打断 */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadWorkflow = (w: Workflow) => {
    setWf(w);
    setName(w.name);
    setGraph(w.graph);
    setModeOverride(w.mode_override ?? "");
    setDirty(false);
    setSelected(null);
    setRunStates({});
    setOutputs({});
    setHitl(null);
    setOrcId(null);
    setDetail(null);
    // 节点 id 续号，避免新建的 nid 和老图撞车
    const maxN = w.graph.nodes.reduce((m, n) => {
      const num = parseInt(n.nid.replace(/^n/, ""), 10);
      return Number.isFinite(num) ? Math.max(m, num) : m;
    }, 0);
    nidRef.current = maxN + 1;
  };

  /* ── 图的改动：只动本地，标脏；跑之前会自动存 ───────────────────────── */
  const patchGraph = useCallback(
    (next: WorkflowGraph, opts: { resetRun?: string[] } = {}) => {
      setGraph(next);
      setDirty(true);
      if (opts.resetRun?.length) {
        setRunStates((prev) => {
          const out = { ...prev };
          opts.resetRun!.forEach((nid) => {
            if (out[nid] && out[nid] !== "stale") out[nid] = "stale";
          });
          return out;
        });
      }
    },
    [],
  );

  /** 结构一变，这一步和它下游的产出就跟当前图对不上了 → 标「需重跑」 */
  const downstreamOf = (nid: string, g: WorkflowGraph): string[] => {
    const seen = new Set<string>();
    const stack = [nid];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      g.edges.filter((e) => e.from === cur).forEach((e) => stack.push(e.to));
    }
    return [...seen];
  };

  /**
   * 从助手栏"拿起"一个助手 —— 用**指针事件**而不是 HTML5 拖放。
   *
   * 为什么不用 HTML5 拖放：它在**触屏上根本不触发**（浏览器不支持），
   * 也就是手机上完全拖不动。指针事件鼠标和手指同一套，才谈得上"支持拖拽"。
   *
   * 两个动作都留了路：
   *   · 拖（移动超过 6px）：跟手一张小卡片，松手落点决定"新开一条"还是"接在它后面"
   *   · 点（没移动）：直接加一条 —— 手机上一根指头就能放，不必先学会拖
   */
  const startAgentDrag = (e: React.PointerEvent, agentId: string, name: string) => {
    if (running) return;
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      if (!moved) {
        moved = true;
        setDragging(agentId);
      }
      setGhost({ x: ev.clientX, y: ev.clientY, name });
      // 顺手告诉画布"现在悬在哪个节点上" —— 好让它提前显示"会插到它后面"
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      setHoverNid(
        el?.closest("[data-canvas-drop]")
          ? ((el.closest("[data-nid]") as HTMLElement | null)?.dataset.nid ?? null)
          : null,
      );
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setGhost(null);
      setDragging(null);
      setHoverNid(null);
      if (!moved) {
        // 点击 = 加一条新的（不猜"加在哪" —— 直接新开一条，最不容易出错）
        dropAgent(agentId, null);
        return;
      }
      // 落点交给画布上的标记：节点上 → 接在它后面；画布空白 → 新开一条
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const onCanvas = el?.closest("[data-canvas-drop]");
      if (!onCanvas) return; // 丢在别处（比如导航栏）= 取消
      const nodeEl = el?.closest("[data-nid]") as HTMLElement | null;
      dropAgent(agentId, nodeEl?.dataset.nid ?? null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  /** 把一个助手从编排里移掉 —— 它两端的连线一起清掉（留着悬空连线只会让人困惑） */
  const removeNode = (nid: string) => {
    const next: WorkflowGraph = {
      ...graph,
      nodes: graph.nodes.filter((n) => n.nid !== nid),
      edges: graph.edges.filter((e) => e.from !== nid && e.to !== nid),
    };
    patchGraph(next, { resetRun: downstreamOf(nid, graph) });   // 下游要重跑：输入变了
    if (selected === nid) setSelected(null);
  };

  const dropAgent = (agentId: string, targetNid: string | null) => {
    const nid = `n${nidRef.current++}`;
    if (!targetNid) {
      const next = { ...graph, nodes: [...graph.nodes, { nid, agent_id: agentId }] };
      patchGraph(next);
      setSelected(nid);
      return;
    }
    // 插到"它"与它的下游之间：A→B 变成 A→N→B
    const moved = graph.edges
      .filter((e) => e.from === targetNid)
      .map((e) => ({ from: nid, to: e.to }));
    const kept = graph.edges.filter((e) => e.from !== targetNid);
    const next = {
      ...graph,
      nodes: [...graph.nodes, { nid, agent_id: agentId }],
      edges: [...kept, ...moved, { from: targetNid, to: nid }],
    };
    patchGraph(next, { resetRun: downstreamOf(targetNid, next) });
    setSelected(nid);
  };

  const preset = (kind: "single" | "serial" | "fan") => {
    const ids = agents.slice(0, kind === "single" ? 1 : 3).map((a) => a.id);
    if (!ids.length) return;
    const nodes = ids.map((agent_id, i) => ({ nid: `n${i + 1}`, agent_id }));
    nidRef.current = ids.length + 1;
    const edges =
      kind === "serial"
        ? nodes.slice(1).map((n, i) => ({ from: nodes[i].nid, to: n.nid }))
        : [];
    patchGraph({ nodes, edges });
  };

  /* ── 拉每个步骤的 trace（画布与详情共用一份）───────────────────────────── */
  useEffect(() => {
    const steps = detail?.steps ?? [];
    if (!steps.length) return;
    let stop = false;
    const pull = async (force = false) => {
      for (const st of steps) {
        const settled = ["ok", "error", "aborted"].includes(st.status);
        // force：刚跑完时**必须重拉一次** —— 上一次拉到的可能还是半截的
        // trace（事件正在写），不重拉的话悬停卡里会出现"没有思考/没有输出"。
        if (!force && settled && tracesRef.current[st.run_id]) continue;
        try {
          const t = (await api.runTrace(st.run_id)) as unknown as TraceData;
          if (stop) return;
          tracesRef.current = { ...tracesRef.current, [st.run_id]: t };
          setTraces(tracesRef.current);
        } catch {
          /* 拿不到就等下一轮 */
        }
      }
    };
    void pull(!running);   // 没在跑（刚跑完/看历史）→ 强制重拉一次，保证拿到完整 trace
    // 只有还在跑的时候才持续轮询 —— 看历史时拉一次就够，别空转
    const timer = window.setInterval(() => {
      if (running) void pull();
    }, 2000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [detail, running]);

  /* ── 存 ─────────────────────────────────────────────────────────────── */
  const save = async (silent = false): Promise<Workflow | null> => {
    try {
      const body = {
        name: name.trim() || "未命名编排",
        graph,
        mode_override: modeOverride || null,
      };
      const saved = wf ? await api.updateWorkflow(wf.id, body) : await api.createWorkflow(body);
      setWf(saved);
      setDirty(false);
      setList((prev) => [saved, ...prev.filter((x) => x.id !== saved.id)].slice(0, 30));
      if (!silent) fb.success(dirty ? "已保存" : "已保存改动");
      return saved;
    } catch (e) {
      fb.error("保存失败", e instanceof Error ? e.message : String(e));
      return null;
    }
  };

  /* ── 跑 ─────────────────────────────────────────────────────────────── */
  const subscribe = (id: string) => {
    esRef.current?.close();
    const es = new EventSource(api.orchestrationStreamUrl(id));
    esRef.current = es;
    const refresh = async () => {
      try {
        const d = await api.orchestration(id);
        setDetail(d);
        if ((d.steps ?? []).length) setShowLog(true);   // 有步骤就直接摊开，不用再点一次
        // 有步骤在等确认 → 把待确认内容取回来，显示在**那个节点**上
        const waiting = (d.steps ?? []).find((s) => s.status === "waiting_hitl");
        if (waiting) {
          const run = await api.run(waiting.run_id).catch(() => null);
          const nid = nodeForStep(waiting);
          if (nid && run?.pending_hitl) {
            setHitl({ nid, runId: waiting.run_id, payload: run.pending_hitl as Record<string, unknown> });
          }
        } else {
          setHitl(null);
        }
        if (["ok", "partial", "error", "aborted"].includes(d.status)) {
          setRunning(false);
          es.close();
        }
      } catch {
        /* 拉不到就等下一次事件 */
      }
    };
    es.onmessage = () => void refresh();
    es.onerror = () => void refresh();
    void refresh();
  };

  /** 把子步骤按 agent 顺序对回节点 —— 与后端 order_index 一个口径 */
  const nodeForStep = (s: OrchestrationStepRead): string | null => {
    const used = new Set<string>();
    const steps = (detail?.steps ?? []).slice().sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
    for (const st of steps) {
      const hit = graph.nodes.find((n) => n.agent_id === st.agent_id && !used.has(n.nid));
      if (hit) used.add(hit.nid);
      if (st.run_id === s.run_id) return hit?.nid ?? null;
    }
    return graph.nodes.find((n) => n.agent_id === s.agent_id)?.nid ?? null;
  };

  /** 把"这次执行的事实"映射回画布节点 —— 由状态驱动，不写在刷新回调里。
   *
   * 为什么必须是 effect：进页面时 **graph 和 detail 是前后脚到的**，谁先谁后不定。
   * 写在刷新回调里会读到闭包中**旧的 graph**（那时还是空的）→ 一个节点都映射不上 →
   * 画布上全是"待运行"，而底部面板却有数据；更糟的是这次执行已经结束，
   * 不会再有下一次刷新来纠正它。做成 effect 后，graph 或 detail 一变就重算。 */
  useEffect(() => {
    const steps = (detail?.steps ?? [])
      .slice()
      .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
    if (!steps.length || !graph.nodes.length) return;
    const states: Record<string, NodeState> = {};
    const outs: Record<string, string> = {};
    const used = new Set<string>();
    for (const s of steps) {
      const hit = graph.nodes.find((n) => n.agent_id === s.agent_id && !used.has(n.nid));
      if (!hit) continue;
      used.add(hit.nid);
      states[hit.nid] = STATUS_TO_NODE[s.status] ?? "wait";
      if (s.output_text) outs[hit.nid] = s.output_text;
    }
    setRunStates(states);
    setOutputs(outs);
  }, [detail, graph]);

  const run = async () => {
    const text = task.trim();
    if (!text) return fb.error("还差一步", "先写一句任务，助手才知道要干什么");
    if (!graph.nodes.length) return fb.error("画布是空的", "从左边拖一个助手进来");
    setRunning(true);
    setShowLog(true);
    setRunStates(Object.fromEntries(graph.nodes.map((n) => [n.nid, "wait" as NodeState])));
    setOutputs({});
    setHitl(null);
    try {
      const saved = dirty || !wf ? await save(true) : wf;
      if (!saved) {
        setRunning(false);
        return;
      }
      const started = await api.runWorkflow(saved.id, { task: text });
      setOrcId(started.orchestration_id);
      fb.success(`已开始：${started.mode_label} · ${started.step_count} 步`);
      subscribe(started.orchestration_id);
    } catch (e) {
      setRunning(false);
      fb.error("发起失败", e instanceof Error ? e.message : String(e));
    }
  };

  const hitlAction = async (action: "allow" | "allow_all" | "deny") => {
    if (!hitl) return;
    try {
      await api.resumeRun(hitl.runId, {
        confirm: action !== "deny",
        payload: { ...(hitl.payload ?? {}), remember: action === "allow_all" },
      });
      setHitl(null);
      if (orcId) subscribe(orcId);
    } catch (e) {
      fb.error("确认失败", e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => () => esRef.current?.close(), []);

  /* 未保存提醒：编排是"搭"出来的，丢了很气人 */
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  // output 是宽松的 Record（各模式自己决定放什么），取出来先收敛成字符串再渲染
  const finalText = typeof detail?.output?.content === "string" ? detail.output.content : "";

  const selNode = graph.nodes.find((n) => n.nid === selected) ?? null;
  const selAgent = agents.find((a) => a.id === selNode?.agent_id);
  const derived = wf?.derived_mode ?? (graph.nodes.length > 1 ? "待保存" : "single");
  const derivedHint = wf?.derived_hint ?? "保存后由服务端按连线判断";

  /** 把每个步骤的 trace 挂回它的节点 —— 画布据此在节点上显示"正在干什么" */
  const liveInfo = useMemo(() => {
    const out: Record<string, NodeLiveInfo> = {};
    for (const st of detail?.steps ?? []) {
      const t = traces[st.run_id];
      if (!t) continue;
      const nid = nodeForStep(st);
      if (nid) out[nid] = buildNodeLive(t, st.status);
    }
    return out;
  }, [detail, traces]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ══ 顶栏：名字 + 推导出的执行方式（可覆盖）+ 运行 ══ */}
      <div
        className="flex flex-wrap items-center gap-3 border-b px-4 py-2.5"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      >
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="text-[15.5px] font-semibold tracking-tight">Playground</h1>
          <span className="truncate text-[12.5px]" style={{ color: "var(--color-muted)" }}>
            把助手拖进来，让它们分工做一件事 —— 只放一个，就是对话。
          </span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
            className="w-[168px] rounded-[8px] border px-2 py-1.5 text-[12.5px]"
            style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
            placeholder="给这份编排起个名字"
          />
          {list.length > 1 && (
            <select
              value={wf?.id ?? ""}
              onChange={(e) => {
                const w = list.find((x) => x.id === e.target.value);
                if (w) loadWorkflow(w);
              }}
              className="rounded-[8px] border px-2 py-1.5 text-[12.5px]"
              style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
              title="最近编排"
            >
              {list.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
          <div
            className="flex items-center gap-2 rounded-full border px-2.5 py-1 text-[12.5px]"
            style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
          >
            <b>{derived}</b>
            <span style={{ color: "var(--color-muted)" }}>{derivedHint}</span>
            <select
              value={modeOverride}
              onChange={(e) => {
                setModeOverride(e.target.value);
                setDirty(true);
              }}
              className="rounded-[6px] border-0 bg-transparent text-[12px]"
              style={{ color: "var(--color-accent)" }}
              title="执行方式由连线推导；这里可以覆盖"
            >
              {MODE_OPTIONS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {dirty && (
            <span className="text-[12px]" style={{ color: "var(--color-warn)" }}>
              ● 有未保存的改动
            </span>
          )}
          <button
            type="button"
            onClick={() => void save()}
            className="rounded-[8px] border px-3 py-1.5 text-[13px]"
            style={{ borderColor: "var(--color-border)" }}
          >
            {dirty ? "保存改动" : "保存"}
          </button>
          <button
            type="button"
            disabled={running}
            onClick={() => void run()}
            className="rounded-[8px] px-3.5 py-1.5 text-[13px] font-medium text-white disabled:opacity-45"
            style={{ background: "var(--color-accent)" }}
          >
            {running ? "运行中…" : "运行"}
          </button>
        </div>
      </div>

      {/* ══ 主体：助手栏 / 画布 / 节点详情 ══ */}
      <div className="flex min-h-0 flex-1">
        <aside
          className="flex w-[208px] shrink-0 flex-col border-r"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
        >
          <div className="px-3.5 pt-3 pb-1 text-[12px] font-semibold" style={{ color: "var(--color-muted)" }}>
            助手
          </div>
          <div className="px-3.5 pb-2 text-[11.5px] leading-snug" style={{ color: "var(--color-muted)" }}>
            拖到空白处 = 新开一条；拖到某个助手上 = 接在它后面；点一下 = 直接加一条。
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto px-2.5 pb-3">
            {agents.map((a) => (
              <div
                key={a.id}
                onPointerDown={(e) => startAgentDrag(e, a.id, a.name)}
                // touchAction:none —— 手指按在这张卡上时不要让它变成页面滚动，
                // 否则 pointermove 会被浏览器截走，拖拽在手机上就废了
                className="flex cursor-grab touch-none items-center gap-2 rounded-[8px] border px-2.5 py-2 active:cursor-grabbing"
                style={{
                  borderColor: draggingAgentId === a.id ? "var(--color-accent)" : "var(--color-border)",
                  background: "var(--color-surface)",
                  opacity: running ? 0.5 : 1,
                }}
                title={`${a.name} · ${a.definition?.system_prompt?.slice(0, 40) ?? ""}`}
              >
                <span
                  className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] border text-[12px] font-semibold"
                  style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)", color: "var(--color-muted)" }}
                >
                  {a.name.slice(0, 1)}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium">{a.name}</span>
                  <span className="block truncate text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                    {a.definition?.model?.name ?? ""}
                  </span>
                </span>
              </div>
            ))}
            {!agents.length && (
              <div className="px-2 text-[12px]" style={{ color: "var(--color-muted)" }}>
                还没有助手，先去 <a href="/agents" className="underline">Agents</a> 建一个。
              </div>
            )}
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <WorkflowCanvas
            agents={agents}
            graph={graph}
            onChange={(next) => patchGraph(next, { resetRun: downstreamOf(selected ?? "", next) })}
            selected={selected}
            onSelect={setSelected}
            runStates={runStates}
            live={liveInfo}
            outputs={outputs}
            hitl={hitl ? { nid: hitl.nid, payload: hitl.payload } : null}
            onHitl={(a) => void hitlAction(a)}
            draggingAgentId={draggingAgentId}
            hoverNid={hoverNid}
            onDropped={dropAgent}
            frozen={running}
            onPreset={preset}
          />
        </div>

        {selNode && (
          <aside
            className="flex w-[300px] shrink-0 flex-col overflow-auto border-l"
            style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
          >
            <div className="flex items-center gap-2 border-b px-3.5 py-3" style={{ borderColor: "var(--color-border)" }}>
              <b className="text-[13.5px]">{selAgent?.name ?? "助手已删除"}</b>
              <button
                type="button"
                className="ml-auto text-[12px]"
                style={{ color: "var(--color-muted)" }}
                onClick={() => setSelected(null)}
              >
                收起
              </button>
            </div>
            <div className="flex flex-col gap-3.5 p-3.5 text-[12.5px]">
              <Field label="这一步做什么" hint="它给这个助手的定位">
                {selAgent?.definition?.system_prompt || "（没写 System Prompt）"}
              </Field>
              <Field label="上游" hint="它的输入来自谁">
                {graph.edges
                  .filter((e) => e.to === selNode.nid)
                  .map((e) => agents.find((a) => a.id === graph.nodes.find((n) => n.nid === e.from)?.agent_id)?.name)
                  .filter(Boolean)
                  .join("、") || "（无 · 起点）"}
              </Field>
              <Field label="下游" hint="它的产出喂给谁">
                {graph.edges
                  .filter((e) => e.from === selNode.nid)
                  .map((e) => agents.find((a) => a.id === graph.nodes.find((n) => n.nid === e.to)?.agent_id)?.name)
                  .filter(Boolean)
                  .join("、") || "（无 · 终点）"}
              </Field>
              <Field label="这次的产出">{outputs[selNode.nid] || "（还没跑）"}</Field>
              <div className="flex flex-col gap-1.5">
                <span className="text-[11.5px] font-semibold" style={{ color: "var(--color-muted)" }}>
                  角色
                </span>
                <label className="flex items-center gap-2 text-[12.5px]">
                  <input
                    type="checkbox"
                    checked={graph.master_nid === selNode.nid}
                    onChange={(e) =>
                      patchGraph({ ...graph, master_nid: e.target.checked ? selNode.nid : null })
                    }
                  />
                  这是主控（不勾 = 按连线自动判断）
                </label>
              </div>
              <p
                className="rounded-[8px] border px-2.5 py-2 text-[11.5px] leading-relaxed"
                style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}
              >
                提示词、记忆、权限这些属于助手本身，点下面的按钮去改 ——
                这里只调它在整条链里的位置。
              </p>
              <a
                href={`/agents/${selNode.agent_id}`}
                className="rounded-[8px] border px-3 py-2 text-center text-[12.5px]"
                style={{ borderColor: "var(--color-border)" }}
              >
                配置这个助手 →
              </a>
              <button
                type="button"
                disabled={running}
                onClick={() => removeNode(selNode.nid)}
                className="rounded-[8px] border px-3 py-2 text-center text-[12.5px] disabled:opacity-50"
                style={{
                  borderColor: "color-mix(in srgb, var(--color-err) 30%, var(--color-border))",
                  color: "var(--color-err)",
                }}
              >
                把这个助手从编排里移掉
              </button>
            </div>
          </aside>
        )}
      </div>

      {/* ══ 运行 + 观测 ══ */}
      <div className="border-t" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
        {showLog && (
          <div className="max-h-[220px] overflow-auto border-b px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
            {(detail?.steps ?? []).length === 0 && (
              <div className="text-[12.5px]" style={{ color: "var(--color-muted)" }}>
                {running ? "已发起，等第一个步骤开始…" : "这次编排还没有步骤"}
              </div>
            )}
            <div className="flex flex-col gap-2.5">
              {(detail?.steps ?? [])
                .slice()
                .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
                .map((s, i) => (
                  <StepExecPanel
                    key={s.run_id}
                    index={i}
                    step={s as unknown as StepBrief}
                    trace={traces[s.run_id]}
                    live={running && (s.status === "running" || s.status === "pending")}
                    open={!closedSteps[s.run_id]}
                    onToggle={() =>
                      setClosedSteps((prev) => ({ ...prev, [s.run_id]: !prev[s.run_id] }))
                    }
                  />
                ))}
            </div>
            {finalText && (
              <div className="mt-3 border-t pt-2 text-[12.5px]" style={{ borderColor: "var(--color-border)" }}>
                <b>最终结果：</b>
                <div className="mt-1 whitespace-pre-wrap">{finalText}</div>
              </div>
            )}
          </div>
        )}
        <div className="flex items-center gap-2.5 px-4 py-2.5">
          <input
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void run();
            }}
            placeholder="给这次编排一个任务 —— 比如：调研三家云厂商的 GPU 报价并汇总成表"
            className="min-w-0 flex-1 rounded-[8px] border px-3 py-2 text-[13px]"
            style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
          />
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            className="shrink-0 text-[11.5px]"
            style={{ color: "var(--color-muted)" }}
          >
            {showLog ? "收起过程" : "看过程"}
          </button>
          {orcId && (
            <a
              href="/runs"
              className="shrink-0 text-[11.5px]"
              style={{ color: "var(--color-accent)" }}
              title="这次执行的完整记录在「运行记录」里"
            >
              运行记录 →
            </a>
          )}
          <span className="shrink-0 text-[11px]" style={{ color: "var(--color-muted)" }}>
            ⌘↵
          </span>
        </div>
      </div>

      {/* 跟手的小卡片：让"我正拿着谁"看得见（手机上尤其要紧，指头会挡住原件） */}
      {ghost && (
        <div
          className="pointer-events-none fixed z-[60] rounded-[8px] border px-2.5 py-1.5 text-[12.5px] font-medium"
          style={{
            left: ghost.x + 14,
            top: ghost.y + 10,
            background: "var(--color-surface)",
            borderColor: "var(--color-accent)",
            color: "var(--color-accent)",
            boxShadow: "0 8px 20px rgba(20,24,31,.16)",
          }}
        >
          {ghost.name}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11.5px] font-semibold" style={{ color: "var(--color-muted)" }}>
        {label}
        {hint && (
          <span className="ml-1.5 font-normal" style={{ color: "var(--color-muted)" }}>
            {hint}
          </span>
        )}
      </span>
      <div
        className="max-h-[180px] overflow-auto rounded-[8px] border px-2.5 py-2 text-[12.5px] whitespace-pre-wrap break-words"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
      >
        {children}
      </div>
    </div>
  );
}
