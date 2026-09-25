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
import Markdown from "./Markdown";
import { useFeedback } from "@/components/ui/feedback";
import { WorkflowManager } from "@/components/WorkflowManager";
import { WorkflowCanvas, flattenLayers, type NodeState } from "@/components/WorkflowCanvas";
import {
  buildNodeLive,
  type NodeLiveInfo,
  type TraceData,
} from "@/components/StepExecPanel";
import { api } from "@/lib/api";
import type {
  Agent,
  OrchestrationDetail,
  OrchestrationStepRead,
  Workflow,
  WorkflowGraph,
  UploadItem,
} from "@/lib/types";

/** 顶栏可选的执行方式（"" = 自动判断） */
/** 执行方式：标签只留最短的词（长解释放 title，不占界面） */

/** 对话窗口里每条的状态用词（与画布同一套口径） */
/** 记住"上次在编哪份设计稿 / 上次的任务原文" —— 页面切走再回来要接得上。
 *  为什么值得记：编排是"边搭边想"的东西，回来发现画布换成了另一份、
 *  输入框也空了，人只能靠回忆重建上下文 —— 这是最劝退的一种丢失。 */
const LAST_WF_KEY = "playground:last-workflow";
const LAST_TASK_KEY = "playground:last-task";

const STEP_STATUS_TEXT: Record<string, string> = {
  pending: "等待",
  running: "进行中",
  ok: "完成",
  error: "失败",
  aborted: "已中断",
  waiting_hitl: "等你确认",
};
const stepStatusColor = (st: string) =>
  st === "ok"
    ? "var(--color-ok)"
    : st === "error"
      ? "var(--color-err)"
      : st === "waiting_hitl"
        ? "var(--color-warn)"
        : st === "running"
          ? "var(--color-accent)"
          : "var(--color-muted)";

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
  const [dirty, setDirty] = useState(false);

  const [selected, setSelected] = useState<string | null>(null);
  const [draggingAgentId, setDragging] = useState<string | null>(null);
  /** 任务卡上的附件（图片/文件）。上传后即落盘，运行时装进任务交给助手去读。 */
  const [attachments, setAttachments] = useState<UploadItem[]>([]);
  /** 工具 id → 名字。选助手时要把"它手里有什么家伙"显示成**名字**，不是"8 个"。 */
  const [toolNames, setToolNames] = useState<Record<string, string>>({});
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
  /** 每个子步骤的 trace —— **一份数据两处用**（画布上的节点摘要 + 下方详情），
   *  统一在这里轮询，避免画布和详情各拉一遍。 */
  const [traces, setTraces] = useState<Record<string, TraceData>>({});
  const tracesRef = useRef<Record<string, TraceData>>({});
  /** 历史执行（就地列表）—— 用户明确要求：不跳页，在 Playground 上就能看跑过什么 */
  const [hist, setHist] = useState<{ id: string; status: string; task: string; started_at: number; ended_at: number | null; step_count: number }[]>([]);
  const [histOpen, setHistOpen] = useState(false);
  /** 正在看的那次历史执行（非 null = 只读回放态） */
  const [viewing, setViewing] = useState<string | null>(null);
  /** 进历史前的编辑态（退出时还原） */
  const prevRef = useRef<{ graph: WorkflowGraph; detail: OrchestrationDetail | null; task: string } | null>(null);

  /** 顶栏那个「名字 ⌄」的小菜单（切换最近编排 / 保存改动都收在这里） */
  const [wfMenu, setWfMenu] = useState(false);
  /** 流程管理浮层（Playground 内就地打开，不跳页） */
  const [manager, setManager] = useState(false);
  /** 重命名态：名字**默认是入口**（点开=切换/新建/保存），只有点了「重命名」才变输入框 */
  const [renaming, setRenaming] = useState(false);

  /** 画布右侧抽屉正在看哪个节点（null = 收起）。执行内容都从这里看，不在页面下方另开一块 */
  const [detailNid, setDetailNid] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const nidRef = useRef(1);

  /* ── 载入助手 + 最近的设计稿 ─────────────────────────────────────────── */
  useEffect(() => {
    void (async () => {
      try {
        const [ags, wfs] = await Promise.all([api.agents(), api.workflows(30)]);
        setAgents(ags);
        setList(wfs);
        // 上次在编哪一份就回到哪一份（找不到才退回最近改动的那份）
        const remembered =
          typeof window !== "undefined" ? window.localStorage.getItem(LAST_WF_KEY) : null;
        const target = wfs.find((w) => w.id === remembered) ?? wfs[0];
        // 上次输入框里的任务也还回去（没跑过的话，这就是他刚写了一半的东西）
        const rememberedTask =
          typeof window !== "undefined" ? window.localStorage.getItem(LAST_TASK_KEY) : null;
        if (rememberedTask) setTask(rememberedTask);
        if (target) {
          loadWorkflow(target);
          // 顺手把这份设计稿**最近一次执行**带出来 —— 一进来就能看到上次每个助手
          // 干了什么（思考/工具/输出），不用先跑一遍才有东西看。
          const lastRuns = await api.workflowRuns(target.id, 1).catch(() => []);
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
    if (typeof window !== "undefined") window.localStorage.setItem(LAST_WF_KEY, w.id);
    setWf(w);
    setName(w.name);
    setGraph(w.graph);
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

  /** 载入一次历史执行到画布 —— 只读回放，不碰当前正在编辑的设计稿。
   *
   *  数据来源：orchestration.spec 冻结了当时那份图（即使之后助手被改也照样可复现），
   *  detail 提供每一步的状态/耗时/产出，于是画布、节点上的分色过程、结论卡
   *  全部复用同一套渲染 —— 不需要为"回放"再写一个界面。
   */
  const loadHistory = async (orcId: string) => {
    try {
      // 记住进入历史前的编辑态（退出时原样还原，不丢正在编的东西）
      prevRef.current = { graph, detail, task };
      const d = (await api.orchestration(orcId)) as unknown as OrchestrationDetail;
      const spec = (d.spec ?? {}) as { nodes?: { nid: string; agent_id: string }[]; edges?: { from: string; to: string }[] };
      if (spec.nodes?.length) {
        const g = { nodes: spec.nodes, edges: spec.edges ?? [] };
        setGraph(g);
      }
      setDetail(d);
      setTask((d.input as { text?: string } | undefined)?.text ?? "");
      setViewing(orcId);
      setHistOpen(false);
      fb.success("已载入历史执行", "只读回放 —— 想改就「用这次新建一份编排」");
    } catch {
      fb.error("载入失败", "这次执行可能已被清理");
    }
  };

  /** 退出历史回放：把进历史前的图/状态/任务原样还原（不用重新请求，也不会丢草稿） */
  const exitHistory = () => {
    const prev = prevRef.current;
    if (prev) {
      setGraph(prev.graph);
      setDetail(prev.detail);
      setTask(prev.task);
    }
    prevRef.current = null;
    setViewing(null);
  };

  /** 从「运行记录」深链过来：/playground?history=<orc_id> 直接进入那次执行的回放。
   *  这样 Runs 里点编排执行 = 以 workflow 的形式看它，而不是弹一个五页签的日志框。 */
  useEffect(() => {
    const h = new URLSearchParams(window.location.search).get("history");
    if (h) {
      void loadHistory(h);
      // 清掉参数，避免手动刷新时反复载入同一次（也便于用户接着编辑）
      window.history.replaceState(null, "", window.location.pathname);
    }
    // 只在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // 轮询节奏**自适应**：刚开始密集拉（250ms），逐渐退到 2s。
    // 为什么不能固定 2s：用户点「运行」后要干等最多 2 秒才看见第一个动作，
    // 那段时间被他当成"点了没反应"。后端实测 run_start→首次调模型是 0.00s，
    // 延迟全在轮询节奏上。
    let timer: number | undefined;
    let delay = 250;
    const tick = async () => {
      if (stop) return;
      if (running) {
        await pull();
        delay = Math.min(2000, Math.round(delay * 1.6));   // 250→400→640→1024→1638→2000
      }
      timer = window.setTimeout(tick, delay);
    };
    timer = window.setTimeout(tick, 120);
    return () => {
      stop = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [detail, running]);

  /* ── 存 ─────────────────────────────────────────────────────────────── */
  const save = async (silent = false): Promise<Workflow | null> => {
    try {
      const body = {
        name: name.trim() || "未命名编排",
        graph,
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

  /* ── 编排本身的管理：新建 / 复制 / 删除 ──────────────────────────────────
     之前这里只有"保存"一条路 —— 改完图保存只会**覆盖当前这份**，
     想留一份旧的、或者从头开一份新的，都没有入口（要新建只能改名字再存，
     还会把老的那份冲掉）。三个动作补在这里，都在 ⌄ 菜单里。 */
  /** 新建也要两步 —— 有未保存改动时直接清空等于把它们丢了，
   *  用户点"新建"的心智是"再开一份"，不是"扔掉手上这份"。 */
  const [confirmNew, setConfirmNew] = useState(false);
  const newWorkflow = () => {
    if (dirty && !confirmNew) {
      setConfirmNew(true);
      window.setTimeout(() => setConfirmNew(false), 4000);
      return;
    }
    setConfirmNew(false);
    setWf(null);                       // 没有 id → 下次保存走"新建"
    setName("未命名编排");
    setGraph({ nodes: [], edges: [] });
    setDirty(true);
    setOrcId(null);
    setDetail(null);
    setDetailNid(null);
    setWfMenu(false);
    fb.info("新编排", "点「＋ 加一步」加一个助手就能开搭；保存时会新建一份，不覆盖原来的");
  };

  const duplicateWorkflow = async () => {
    try {
      const created = await api.createWorkflow({
        name: `${name.trim() || "未命名编排"} 副本`,
        graph,
      });
      setList((prev) => [created, ...prev.filter((x) => x.id !== created.id)].slice(0, 30));
      loadWorkflow(created);
      setWfMenu(false);
      fb.success("已复制为副本", created.name);
    } catch (e) {
      fb.error("复制失败", e instanceof Error ? e.message : String(e));
    }
  };

  /** 删除要两步 —— 不用浏览器原生 confirm（原生弹窗在这个产品里是禁的），
   *  菜单里点一下变成"确认删除？"，再点一下才真删。 */
  const [confirmDel, setConfirmDel] = useState(false);
  const removeWorkflow = async () => {
    if (!wf) return;
    if (!confirmDel) {
      setConfirmDel(true);
      window.setTimeout(() => setConfirmDel(false), 4000);
      return;
    }
    try {
      const gone = wf.id;
      await api.deleteWorkflow(gone);
      const rest = list.filter((x) => x.id !== gone);
      setList(rest);
      setConfirmDel(false);
      setWfMenu(false);
      if (rest.length) {
        loadWorkflow(rest[0]);
      } else {
        setWf(null);
        setName("未命名编排");
        setGraph({ nodes: [], edges: [] });
        setOrcId(null);
        setDetail(null);
        setDetailNid(null);
      }
      fb.success("已删除", "这份编排没了（执行记录还在「运行记录」里）");
    } catch (e) {
      fb.error("删除失败", e instanceof Error ? e.message : String(e));
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

  useEffect(() => {
    void api
      .tools()
      .then((list) => setToolNames(Object.fromEntries(list.map((t) => [t.id, t.name]))))
      .catch(() => setToolNames({}));
  }, []);

  /** 运行中进度：第 x/y 步 + 正在跑的是谁。只在跑的时候出现（不占常驻视线） */
  const runProgress = (() => {
    if (!running) return null;
    const total = graph.nodes.length;
    const done = graph.nodes.filter((n) => ["ok", "err", "stale"].includes(runStates[n.nid] ?? "")).length;
    const active = graph.nodes.find((n) => ["run", "ask"].includes(runStates[n.nid] ?? ""));
    const who = active ? agents.find((a) => a.id === active.agent_id)?.name : "";
    return { total, done, step: Math.min(done + 1, Math.max(total, 1)), who };
  })();

  /** 自动保存：改动停下 1.2s 就存。
      商业产品的默认行为 —— 用户不该记得"保存"这回事（原来的手动保存是个断点：
      改完没点就切流程/刷新，改动就没了）。
      安全边界：① 加载页面时用的是 setGraph（不会置 dirty），所以不会误存；
                ② 运行中不存，避免和运行中的图快照打架。 */
  useEffect(() => {
    if (!dirty || running) return;
    const t = setTimeout(() => {
      void save(true);
    }, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, graph, name, running]);

  /** 有没有被手动拖过的节点（有坐标）。没有就完全不显示「整理」—— 不占视线 */
  const hasManual = graph.nodes.some((n) => typeof n.x === "number" || typeof n.y === "number");
  /** 一键整理：把手工坐标清掉，回到按连线自动排版。清掉后 hasManual 变 false，按钮自己消失 */
  const tidyLayout = () => {
    const next = { ...graph, nodes: graph.nodes.map((n) => ({ nid: n.nid, agent_id: n.agent_id })) };
    patchGraph(next);
  };

  /** 上传附件：逐个传（一个失败不影响别的，失败原因指名道姓报给用户） */
  const attachFiles = async (files: File[]) => {
    for (const f of files) {
      try {
        const up = await api.uploadFile(f);
        setAttachments((arr) => [...arr, up]);
      } catch (e) {
        fb.error(`「${f.name}」没传上去`, e instanceof Error ? e.message : String(e));
      }
    }
  };
  const detachFile = (id: string) => {
    setAttachments((arr) => arr.filter((a) => a.id !== id));
    void api.deleteUpload(id).catch(() => null);
  };

  const run = async () => {
    const text = task.trim();
    if (!text) return fb.error("还差一步", "先写一句任务，助手才知道要干什么");
    if (!graph.nodes.length) return fb.error("画布是空的", "点画布上的「＋ 加一步」选一个助手");
    setRunning(true);
    setRunStates(Object.fromEntries(graph.nodes.map((n) => [n.nid, "wait" as NodeState])));
    setOutputs({});
    setHitl(null);
    try {
      const saved = dirty || !wf ? await save(true) : wf;
      if (!saved) {
        setRunning(false);
        return;
      }
      // 附件：把**落盘路径**一并交给助手 —— 助手本来就有读文件的工具，
      // 不必为"传图/传文件"另造一套协议（少一层抽象，模型也看得懂）。
      const withFiles = attachments.length
        ? text +
          "\n\n附件（本次任务的参考资料，请按需读取）：\n" +
          attachments.map((a) => `- ${a.name} → ${a.path}`).join("\n")
        : text;
      const started = await api.runWorkflow(saved.id, { task: withFiles });
      setOrcId(started.orchestration_id);
      fb.success(`已开始 · ${started.step_count} 步`);
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

  /** 画布两端的卡要用：这次的任务原文、最后一步落在哪个节点 */
  const shownTask = (detail?.input as { text?: string } | undefined)?.text || task;
  const lastNid = useMemo(() => {
    const ordered = (detail?.steps ?? [])
      .slice()
      .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
    const last = ordered[ordered.length - 1];
    return last ? nodeForStep(last) : null;
  }, [detail]);

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

  /* 配置页签的内容 —— 它属于 Console 的状态（selNode / 助手编辑），所以不搬进画布，
     而是作为插槽传给画布那个"唯一的右栏"。以前它是并排的第二个右栏。 */
  const configPanel = selNode ? (
    <div className="flex min-h-0 flex-1 flex-col">

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
              <div className="flex flex-col gap-1">
                <span className="text-[12px] font-semibold" style={{ color: "var(--color-muted)" }}>
                  这次的产出
                </span>
                {/* 产出是模型给的 Markdown，必须渲染 —— 当纯文本贴出来会看到 `##` `**` 这类标记 */}
                <div
                  className="max-h-[220px] overflow-auto rounded-[8px] border px-2.5 py-2"
                  style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
                >
                  {outputs[selNode.nid] ? (
                    <Markdown text={outputs[selNode.nid]} />
                  ) : (
                    <span className="text-[12.5px]" style={{ color: "var(--color-muted)" }}>
                      （还没跑）
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] font-semibold" style={{ color: "var(--color-muted)" }}>
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
                className="rounded-[8px] border px-2.5 py-2 text-[12px] leading-relaxed"
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
    </div>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ══ 顶栏：只有两样 —— 编排名（自带切换/保存）+ 运行（自带执行方式）══════
          原来这里有 6 个控件：名字框、最近编排下拉、执行方式徽标 + 一段说明文字、
          执行方式下拉、保存、运行。同一件事两个控件（名字与下拉）、旁边还常驻一段
          解释 —— 这些不是信息，是噪音。现在合成两个：
            · 名字旁边的小箭头 = 切换最近编排 + 保存改动（脏了名字角上有个橙点）
            · 执行方式收进运行按钮旁的小选择器，当前会跑什么模式写在运行按钮上 */}
      <div
        className="pg-topbar flex items-center gap-3 border-b px-4 py-2.5"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      >
        <h1 className="shrink-0 text-[15.5px] font-semibold tracking-tight">Playground</h1>

        {/* 工作流入口（重做过）：
            以前是「一个输入框 + 一个无名 ⌄」—— 输入框看起来像"你必须先改名"，
            ⌄ 把切换/新建/保存/历史/删除全藏进一个符号里（"看到更多"的反面）。
            现在：**名字本身就是入口**（点开=菜单），**新建独立成一键**（一步可达），
            重命名收进菜单（点了才变输入框），未保存小点挂在名字旁。 */}
        <div className="relative flex items-center gap-1.5">
          <span className="shrink-0 text-[12px]" style={{ color: "var(--color-muted)" }}>
            工作流
          </span>
          {renaming ? (
            <input
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setDirty(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") {
                  e.preventDefault();
                  setRenaming(false);
                }
              }}
              onBlur={() => setRenaming(false)}
              className="w-[170px] rounded-[8px] border px-2 py-1.5 text-[12.5px] outline-none"
              style={{ borderColor: "var(--color-accent)", background: "var(--color-surface)" }}
              placeholder="给这份编排起个名字"
              title="回车保存名字（Esc 取消）"
            />
          ) : (
            <button
              type="button"
              onClick={() => setWfMenu((v) => !v)}
              className="flex max-w-[220px] items-center gap-1.5 rounded-[8px] border px-2.5 py-1.5 text-[12.5px] font-medium hover:bg-[var(--color-surface-2)]"
              style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
              title="切换编排 / 新建 / 重命名 / 保存 / 历史"
            >
              <span className="min-w-0 truncate">{name || "未命名编排"}</span>
              <span className="shrink-0 text-[11px]" style={{ color: "var(--color-muted)" }}>
                ▾
              </span>
            </button>
          )}
          {dirty && (
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: "var(--color-warn)" }}
              title="有未保存的改动"
            />
          )}
          {runProgress && (
            <span
              className="flex shrink-0 items-center gap-1.5 text-[12px] font-medium"
              style={{ color: "var(--color-accent)" }}
              title="正在执行：跑完的步骤会变绿，没轮到的压暗"
            >
              <i className="live-dot" />
              第 {runProgress.step}/{runProgress.total} 步
              {runProgress.who && (
                <span className="font-normal" style={{ color: "var(--color-muted)" }}>
                  {runProgress.who}
                </span>
              )}
            </span>
          )}
          {hasManual && (
            <button
              type="button"
              onClick={tidyLayout}
              className="df-ctl-sm shrink-0 justify-center hover:bg-[var(--color-surface-2)]"
              style={{ color: "var(--color-muted)", border: "1px solid var(--color-border)" }}
              title="按连线重新自动排版（会在保存时一起生效）"
            >
              整理
            </button>
          )}
          <button
            type="button"
            onClick={newWorkflow}
            className="df-ctl-sm shrink-0 justify-center hover:bg-[var(--color-surface-2)]"
            style={{
              color: confirmNew ? "var(--color-warn)" : "var(--color-accent)",
              border: `1px ${confirmNew ? "solid" : "dashed"} ${confirmNew ? "var(--color-warn)" : "var(--color-border)"}`,
            }}
            title={confirmNew ? "有未保存改动 —— 再点一下丢弃并新建" : "新建一个空白编排"}
          >
            {confirmNew ? "再点一次" : "＋"}
          </button>
          {wfMenu && (
            <div
              className="absolute left-0 top-full z-50 mt-1 w-[240px] rounded-[10px] border p-1"
              style={{
                borderColor: "var(--color-border)",
                background: "var(--color-surface)",
                boxShadow: "0 10px 28px rgba(20,24,31,.16)",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setWfMenu(false);
                  setManager(true);
                }}
                className="w-full rounded-[6px] px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--color-surface-2)]"
              >
                管理全部流程…
              </button>
              <div className="my-1 border-t" style={{ borderColor: "var(--color-border)" }} />
              <button
                type="button"
                onClick={() => {
                  setWfMenu(false);
                  setRenaming(true);
                }}
                className="w-full rounded-[6px] px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--color-surface-2)]"
              >
                重命名当前编排…
              </button>
              <div className="my-1 border-t" style={{ borderColor: "var(--color-border)" }} />
              {list.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => {
                    loadWorkflow(w);
                    setWfMenu(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--color-surface-2)]"
                >
                  <span className="min-w-0 flex-1 truncate">{w.name}</span>
                  {w.id === wf?.id && (
                    <span className="shrink-0 text-[12px]" style={{ color: "var(--color-accent)" }}>
                      当前
                    </span>
                  )}
                </button>
              ))}
              <div className="my-1 border-t" style={{ borderColor: "var(--color-border)" }} />
              <button
                type="button"
                disabled={!dirty}
                onClick={() => {
                  setWfMenu(false);
                  void save();
                }}
                className="w-full rounded-[6px] px-2 py-1.5 text-left text-[12.5px] disabled:opacity-45 hover:bg-[var(--color-surface-2)]"
              >
                {dirty ? "保存改动" : "已保存"}
              </button>
              <button
                type="button"
                onClick={() => void duplicateWorkflow()}
                className="w-full rounded-[6px] px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--color-surface-2)]"
              >
                复制为副本
              </button>
              <div className="my-1 border-t" style={{ borderColor: "var(--color-border)" }} />
              {wf && (
                <button
                  type="button"
                  onClick={() => {
                    // 就地展开历史，**不跳页**（"所有操作只在一个页面内完成"）
                    setWfMenu(false);
                    setHistOpen(true);
                    void api.workflowRuns(wf.id).then(setHist).catch(() => setHist([]));
                  }}
                  className="block w-full rounded-[6px] px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--color-surface-2)]"
                  style={{ color: "var(--color-accent)" }}
                >
                  历史执行（这份编排跑过的）…
                </button>
              )}
              <div className="my-1 border-t" style={{ borderColor: "var(--color-border)" }} />
              {wf && (
                <button
                  type="button"
                  onClick={() => void removeWorkflow()}
                  className="w-full rounded-[6px] px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--color-surface-2)]"
                  style={{ color: confirmDel ? "var(--color-err)" : "var(--color-muted)" }}
                >
                  {confirmDel ? "再点一下确认删除" : "删除这份编排"}
                </button>
              )}
            </div>
          )}
        </div>

      </div>

      {/* ══ 主体：助手栏 / 画布 / 节点详情 ══ */}
      <div className="pg-split flex min-h-0 flex-1">

        <div className="min-w-0 flex-1">
          <WorkflowManager
        open={manager}
        currentId={wf?.id ?? null}
        onClose={() => setManager(false)}
        onOpenWorkflow={(w) => loadWorkflow(w)}
        onNew={() => newWorkflow()}
        onDuplicate={() => void duplicateWorkflow()}
        onDeleted={() => {
          // 管理浮层删完会自己刷新；画布这边把「流程列表」也重新拉一次，
          // 免得切流程时看到已经删掉的名字
          void (async () => {
            const wfs = (await api.workflows(30)) as unknown as Workflow[];
            setList(wfs);
          })();
        }}
        onReplay={(orcId) => {
          setManager(false);
          void loadHistory(orcId);
        }}
      />

      <WorkflowCanvas
            agents={agents}
            graph={graph}
            onChange={(next) => patchGraph(next, { resetRun: downstreamOf(selected ?? "", next) })}
            selected={selected}
            onSelect={(nid) => {
              // 点 ⚙ = 打开"这个助手怎么配"的**居中弹层**（不再占右侧一栏）
              setSelected(nid);
            }}
            runStates={runStates}
            live={liveInfo}
            detailNid={detailNid}
            onDetail={(nid) => {
              // 点节点 = 只做选中高亮。信息（名字/状态/产出/分色过程）**直接显示在节点上**，
              // 不再往右侧开栏 —— 用户明确要求"移除右边侧边栏，直接在 agent 默认显示"
              setDetailNid(nid);
            }}
            taskText={shownTask}
            finalText={finalText}
            lastNid={lastNid}
            taskValue={task}
            attachments={attachments}
            onAttach={(files) => void attachFiles(files)}
            onDetach={detachFile}
            toolNames={toolNames}
            onAddStep={(agentId) => dropAgent(agentId, null)}
            onSwapAgent={(nid, agentId) => {
              // 换助手 = 改这一步的 agent_id。这一步和它**下游**的产出都作废，
              // 所以一并重置运行态（下游的输出是上游产物推出来的，不能留着骗人）。
              const next = { ...graph, nodes: graph.nodes.map((x) => (x.nid === nid ? { ...x, agent_id: agentId } : x)) };
              patchGraph(next, { resetRun: downstreamOf(nid, next) });
            }}
            onTaskValue={(v) => {
              setTask(v);
              if (typeof window !== "undefined") window.localStorage.setItem(LAST_TASK_KEY, v);
            }}
            onRun={() => void run()}
            running={running}

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


      </div>

      {/* 页面下方**不再有任何常驻组件** —— 任务输入搬进了画布左端的任务卡（方案 C）：
          写任务 = 给流程填入口，运行键就长在起点上，那一整条底栏还给画布。 */}

      {/* ══ 历史执行：居中弹层 ══════════════════════════════════════════════
          "workflow 的历史执行应该以 workflow 的方式显示" —— 点一次执行，
          画布就换成那次的图（图来自 orchestration.spec，冻结的是当时的定义）。 */}
      {histOpen && (
        <div
          className="pg-modal fixed inset-0 z-[70] flex items-center justify-center p-6"
          style={{ background: "var(--color-overlay)" }}
          onClick={() => setHistOpen(false)}
        >
          <div
            className="pg-panel df-card flex max-h-[80vh] w-full max-w-[620px] flex-col overflow-hidden border"
            style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
              <span className="text-[13.5px] font-semibold">历史执行</span>
              <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                这份编排跑过的 {hist.length} 次（最近在前）
              </span>
              <button
                type="button"
                onClick={() => setHistOpen(false)}
                className="ml-auto rounded-[6px] px-2 py-1 text-[12px] hover:bg-[var(--color-surface-2)]"
              >
                ✕
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {hist.length === 0 ? (
                <div className="px-3 py-8 text-center text-[12.5px]" style={{ color: "var(--color-muted)" }}>
                  这份编排还没跑过
                </div>
              ) : (
                hist.map((h) => {
                  const ok = h.status === "ok";
                  const bad = h.status === "error" || h.status === "failed";
                  const secs = h.ended_at && h.started_at ? Math.round((h.ended_at - h.started_at) / 1000) : null;
                  const when = new Date(h.started_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
                  return (
                    <button
                      key={h.id}
                      type="button"
                      onClick={() => void loadHistory(h.id)}
                      className="pg-hist-row mb-1 flex w-full items-center gap-3 rounded-[9px] border px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-2)]"
                      style={{ borderColor: "var(--color-border)" }}
                    >
                      <span
                        className="shrink-0 rounded-[5px] px-1.5 py-px text-[12px] font-medium"
                        style={{
                          background: `color-mix(in srgb, ${ok ? "var(--color-ok)" : bad ? "var(--color-err)" : "var(--color-accent)"} 12%, transparent)`,
                          color: ok ? "var(--color-ok)" : bad ? "var(--color-err)" : "var(--color-accent)",
                        }}
                      >
                        {ok ? "成功" : bad ? "失败" : h.status}
                      </span>
                      <span className="shrink-0 text-[12px]" style={{ color: "var(--color-muted)" }}>
                        {when}
                      </span>
                      <span className="pg-hist-task min-w-0 flex-1 truncate text-[12.5px]">{h.task || "（无任务描述）"}</span>
                      <span className="shrink-0 text-[12px]" style={{ color: "var(--color-muted)" }}>
                        {h.step_count} 步{secs != null ? ` · ${secs}s` : ""}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* 只读回放横幅：明确告诉用户"你现在看的是历史，不是正在编的图" */}
      {viewing && (
        <div
          className="flex items-center gap-3 border-b px-4 py-2 text-[12.5px]"
          style={{ background: "color-mix(in srgb, var(--color-accent) 8%, transparent)", borderColor: "var(--color-border)" }}
        >
          <span className="font-medium" style={{ color: "var(--color-accent)" }}>
            正在回放一次历史执行
          </span>
          <span style={{ color: "var(--color-muted)" }}>
            图取自那次执行时保存的定义；右边是它当时的真实状态与产出
          </span>
          <button
            type="button"
            onClick={exitHistory}
            className="ml-auto rounded-[6px] border px-2.5 py-1 text-[12px] hover:bg-[var(--color-surface)]"
            style={{ borderColor: "var(--color-border)" }}
          >
            退出回放
          </button>
        </div>
      )}

      {/* ══ 助手配置：居中弹层 ══════════════════════════════════════════════
          为什么不放右侧栏：用户要求"移除右边侧边栏，直接在 agent 默认显示" ——
          执行过程已经画在节点上默认可见；配置是低频动作，用弹层（同一页、不跳转、
          不常驻占位），关掉后画布仍是全宽。 */}
      {configPanel && (
        <div
          className="pg-modal fixed inset-0 z-[70] flex items-center justify-center p-6"
          style={{ background: "var(--color-overlay)" }}
          onClick={() => setSelected(null)}
        >
          <div
            className="pg-panel df-card flex max-h-[86vh] w-full max-w-[720px] flex-col overflow-hidden border"
            style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="min-h-0 flex-1 overflow-auto">{configPanel}</div>
          </div>
        </div>
      )}

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
      <span className="text-[12px] font-semibold" style={{ color: "var(--color-muted)" }}>
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
