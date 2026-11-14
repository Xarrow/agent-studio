"use client";

/**
 * 对话 —— 像聊天一样使用 Agent（面向使用者，不是调试者）
 *
 * 与「试跑与观测」的分工：
 *   /chat     使用：只管聊，历史永不消失，多轮默认开启，零技术噪音
 *   试跑与观测 调试：事件表 / 原始 JSON / 协议层耗时（开发者视图）
 *
 * 两者共用同一套 Session/Run 数据 —— 在对话里聊的内容，调试台能看到完整事件流；
 * 反之亦然。**不是两套系统，是同一份数据的两个视图。**
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { HitlPrompt } from "@/components/HitlPrompt";
import { DelegationBlock } from "@/components/DelegationBlock";
import { agentColor } from "@/lib/turn";

/** worker 会话的识别色：Router 是蓝、派出去的活是琥珀、普通对话不上色 */
const WORKER_COLOR = "var(--color-worker)";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, fmt, withToken } from "@/lib/api";
import type { Agent, Run, RunEvent, Session, SearchHit, Skill, Tool, Memory } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { ProcessBar, eventsToSteps, recallProc, rememberProc } from "@/components/ui/run-timeline";
import BgProcsStrip from "@/components/BgProcsStrip";
import TodoStrip from "@/components/TodoStrip";
import SessionJobs, { JobButton } from "@/components/SessionJobs";
import { pushFrame, clearFrame } from "@/lib/browser-frame";
import { pushSessionLayer, useHistoryLayer } from "@/lib/use-history-layer";
import { SlashMenu, type CommandItem } from "@/components/SlashMenu";
import { useImeGuard, isImeEvent } from "@/lib/ime";
import Markdown from "@/components/Markdown";
import { RunDetailById } from "@/components/RunDetailDialog";
import { AgentDetailDialog } from "./AgentDetailDialog";
import { ICON_PATHS, SETUP_ITEMS, USE_ITEMS } from "@/lib/nav-items";
import { AgentSwitcher } from "./AgentSwitcher";
import { SkillEntry, ToolEntry, MemoryEntry } from "./ToolEntries";
import { Sheet } from "./ui/Sheet";
import { MemoryPicker } from "./MemoryPicker";
import { QuickTags } from "./QuickTags";
import { SourceBadge } from "./SourceBadge";
import { FileOpenerProvider, FileRowButton } from "@/components/FileDialog";
import { copyText } from "@/lib/clipboard";
import { middleEllipsis, fileTypeKey, shortFilePath } from "@/lib/files";
import { BrowserStage, type BrowserAction } from "@/components/BrowserStage";
import { SideDock, type DockPanel } from "@/components/SideDock";
import type { BrowserStep } from "@/lib/types";
import { humanizeAssistantText } from "@/lib/messages";
import { FileTypeIcon } from "@/components/ui/icons";

/** 流式渲染期间的一条临时消息 */
interface LiveMsg {
  role: "user" | "assistant";
  text: string;
}

export function ChatConsole({
  agentId: controlledAgentId,
  initialSession,
}: {
  agentId?: string;
  /** 深链进来的会话（/exec?s=…）：首屏直接打开它 */
  initialSession?: string;
}) {
  const fb = useFeedback();

  const [agents, setAgents] = useState<Agent[]>([]);
  /**
   * 跟谁聊。
   *
   * 外层（对话页的参与者条）传进来时**以外层为准** —— 参与者是页面级状态，
   * 不该在两个组件里各存一份（那就会出现"上面显示 A、下面在跟 B 聊"）。
   * 没传时才用自己这份（老的单独用法仍然成立）。
   */
  const [ownAgentId, setOwnAgentId] = useState<string>("");
  /**
   * 用户在这里亲手选过的助手。
   *
   * 受外层控制（/exec?agent=xxx）时以前是纯文本、点不动 —— 从助手页「跑一次」
   * 进来的用户就再也换不了人，只能回上页重进。现在：外层给了初始值，但**用户点过
   * 之后以他点的为准**（页面级状态只提供初始值，不该变成一道锁）。
   */
  const [pickedAgent, setPickedAgent] = useState<string | null>(null);
  const agentId = pickedAgent ?? controlledAgentId ?? ownAgentId;
  const setAgentId = (id: string) => {
    setPickedAgent(id);
    setOwnAgentId(id);
  };
  /** 切换助手时想落到哪条会话（点树上的子节点用；不然会被"选最近一条"覆盖） */
  const pendingPick = useRef<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  /** 全量会话：只用来把"我这条对话派出去的 worker"捞出来挂树，别的助手的一律不显示 */
  const [allSessions, setAllSessions] = useState<Session[]>([]);
  /**
   * 侧栏显示哪些会话：**当前助手的对话** + 它们派出去的 worker（别的助手的会话）。
   *
   * 之前是把所有 router/worker 会话都并进来 —— 结果选「编排者」时，能看到
   * 「简明助手」自己的对话、别的助手派出去的活，全混在一个列表里。
   * 现在只认血缘：worker 的父会话必须是我这儿的某条会话，否则不出现。
   */
  const navSessions = useMemo(() => {
    const mine = new Set(sessions.map((s) => s.id));
    const seen = new Set<string>();
    const out: Session[] = [];
    for (const s of sessions) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
    }
    for (const s of allSessions) {
      if (s.kind !== "worker") continue;
      if (!s.parent_session_id || !mine.has(s.parent_session_id)) continue;
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
    }
    return out;
  }, [allSessions, sessions]);
  /** 当前会话的角色 —— 派活会话要一眼看出"这不是你直接聊的那个"，并给回 Router 的门 */
  const [curKind, setCurKind] = useState<"router" | "worker" | "chat">("chat");
  const [curTicket, setCurTicket] = useState<string | null>(null);
  /** 这条 worker 会话是被哪条对话派出来的（票的父会话）——「回到 Router」就回它 */
  const [curParent, setCurParent] = useState<string | null>(null);
  /** 当前 worker 会话是哪个助手 —— 身份带要用它的固定色，跟侧栏/编排区对上 */
  const [curAgentId, setCurAgentId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string>(initialSession || "");
  /**
   * 「自动挑」——这一句交给谁由内容决定。默认**关**：多数时候人心里有数，
   * 平台别抢方向盘。开了之后每句话都先过路由，认不出来就问一句。
   */
  const [autoPick, setAutoPick] = useState(false);
  /** 当前选的是不是 Router（role=orchestrator）。
   *  选了它，消息就该**直接交给它**：由它分析、拆解、按域分派 —— 不该再让用户挑"这句交给谁"。
   *  那一步是把 Router 的活抢回来给人干，等于把编排退回到人工路由。 */
  const curAgent = agents.find((a) => a.id === agentId);
  const isRouterAgent = (curAgent?.definition?.role || "") === "orchestrator";
  // 换到 Router 时，把上一次"这句该交给谁"的候选清掉：那句话已经交给 Router 了
  useEffect(() => {
    if (isRouterAgent) {
      setRouteAsk(null);
      setRouteNote(null);
    }
  }, [isRouterAgent]);
  /** 认不出来时的候选条（点了谁就用谁发，不再猜第二遍） */
  const [routeAsk, setRouteAsk] = useState<{
    text: string;
    reason: string;
    options: { agent_id: string; name: string }[];
    /** 值得一起干的几位（≥2 才有意义）；空 = 只是"选一位" */
    multi: { agent_id: string; name: string }[];
    /** 一起跑时谁汇总 */
    master: string;
  } | null>(null);
  /** 刚刚这句话交给了谁 + 为什么（常驻在输入框上方，不用翻日志） */
  const [routeNote, setRouteNote] = useState<{
    name: string;
    reason: string;
    switched: boolean;
    /** 扇出跑的是编排、没有 run 可挂流 —— 给一个去看它的入口 */
    href?: string;
  } | null>(null);

  useEffect(() => {
    try {
      setAutoPick(window.localStorage.getItem("studio.autoPick") === "1");
    } catch {
      /* 隐私模式下读不到就用默认关 */
    }
  }, []);
  // 执行详情用弹框看，不跳页 —— 聊天上下文（输入框内容、滚动位置）不该
  // 因为「想看一眼这轮到底怎么回事」而丢掉。
  /** `/` 命令菜单是否打开（输入以 / 开头时） */
  const [slashOpen, setSlashOpen] = useState(false);
  /** 输入法守卫：中文组字没上屏时按 Enter 是「选字」，不能当发送 */
  const ime = useImeGuard();
  /** 服务器上的存放路径 —— 界面上说清"这些对话存在哪"（自托管必须让用户能核对） */
  const [paths, setPaths] = useState<Awaited<ReturnType<typeof api.paths>> | null>(null);
  /** 这个会话的工作目录与产物（会话隔离后按会话列） */
  const [sessionFiles, setSessionFiles] = useState<Awaited<
    ReturnType<typeof api.sessionFiles>
  > | null>(null);

  const loadSessionFiles = useCallback(async () => {
    if (!sessionId) {
      setSessionFiles(null);
      return;
    }
    setFilesBusy(true);
    try {
      setSessionFiles(await api.sessionFiles(sessionId));
    } catch {
      setSessionFiles(null); // 打不开就不显示这块 —— 不打扰用户
    } finally {
      setFilesBusy(false);
    }
  }, [sessionId]);

  /** 正在浮层里配置的助手（从对话页直接打开，不离开对话） */
  /** 置顶：列表和顶栏共用一份（存 localStorage，不碰后端） */
  const [pinned, setPinned] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("studio.pinned") || "[]");
      return new Set(Array.isArray(raw) ? raw : []);
    } catch {
      return new Set();
    }
  });
  const togglePin = (id: string) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem("studio.pinned", JSON.stringify([...next]));
      } catch {}
      return next;
    });
  };
  /** 会话产物（product/）：不再挂输入区上方，改成会话文件面板里的第一行 */
  const [dl, setDl] = useState<Awaited<ReturnType<typeof api.sessionDeliverable>> | null>(null);
  useEffect(() => {
    setDl(null);
    if (!sessionId) return;
    let alive = true;
    const tick = () =>
      api
        .sessionDeliverable(sessionId)
        .then((d) => {
          if (alive) setDl(d);
        })
        .catch(() => {});
    tick();
    const t = setInterval(tick, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sessionId]);

  /** 输入卡片左下角「+」菜单 */
  const [plusOpen, setPlusOpen] = useState(false);

  /** 顶栏：标题就地改名 / 更多菜单 / 滚动后出现分隔线 */
  const [headerEditing, setHeaderEditing] = useState(false);
  const [headerDraft, setHeaderDraft] = useState("");
  const [headerMenu, setHeaderMenu] = useState(false);
  const [topScrolled, setTopScrolled] = useState(false);

  /** 导出会话：Markdown（给人读）/ JSON（给程序读）。纯前端拼，走已有会话详情接口 */
  const exportSession = async (s: Session, fmt: "md" | "json" = "md") => {
    try {
      const d = await api.session(s.id);
      let body = "";
      let type = "text/markdown;charset=utf-8";
      if (fmt === "json") {
        body = JSON.stringify(
          {
            id: s.id,
            title: s.title || "未命名对话",
            agent_id: s.agent_id,
            exported_at: new Date().toISOString(),
            messages: (d.messages || []).map((m) => ({
              role: m.role,
              content: m.content || "",
              run_id: m.run_id ?? null,
              ts: m.ts ?? null,
            })),
          },
          null,
          2,
        );
        type = "application/json;charset=utf-8";
      } else {
        const lines: string[] = [`# ${s.title || "未命名对话"}`, ""];
        for (const m of d.messages || []) {
          if (m.role === "user") lines.push("## 我", "", m.content || "", "");
          else if (m.role === "assistant") lines.push("## 助手", "", m.content || "", "");
        }
        body = lines.join("\n");
      }
      const blob = new Blob([body], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(s.title || s.id).replace(/[\\/:*?"<>|]/g, "_")}.${fmt}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      fb.error("导出失败", e instanceof Error ? e.message : String(e));
    }
  };

  const [configAgent, setConfigAgent] = useState<string | null>(null);
  /**
   * 上一轮失败的记录（原始输入 + 错误原因）。
   *
   * 之前这里完全看不到失败：会话消息结构里没有状态字段，一轮跑挂了界面上
   * 什么都不显示 —— 用户只看到"没反应"，不知道是失败了还是没发出去。
   * 现在把失败摆出来，并且给一键重试（失败最常见的下一步就是"再试一次"）。
   */
  const [failed, setFailed] = useState<{ text: string; message: string } | null>(null);
  /**
   * 这一轮停在"等你授权"（hitl_request 的 payload）。
   *
   * 之前这里什么都不显示：AgentScope 停下来等人点头，而界面上没有任何可点的东西，
   * 模型只能输出"我在等你的许可"—— 用户完全不知道该干什么。
   */
  const [hitl, setHitl] = useState<{ runId: string; payload: Record<string, unknown> } | null>(null);

  /** 已落库的历史消息 */
  const [history, setHistory] = useState<
    {
      role: "user" | "assistant" | "system";
      content: string;
      run_id: string | null;
      turn_index: number;
      id?: number;
      ts?: number;
      /** 这一轮读过几个网页（0 = 不显示「引用」标识） */
      sources_count?: number;
    }[]
  >([]);
  /** history 的镜像 ref：刷新恢复块要读"刚加载完"的最新历史，
   *  但不能把它加进 useEffect 依赖（会反复触发）—— 用 ref 桥一下。 */
  const historyRef = useRef(history);
  historyRef.current = history;
  /** 当前正在流式生成的内容 */
  const [live, setLive] = useState<LiveMsg | null>(null);
  /** 正在生成的这次执行的**全部事件**（用来实时画分色过程） */
  const [liveEvents, setLiveEvents] = useState<RunEvent[]>([]);
  /** 最新事件与开始时间的镜像 —— settle 在闭包里跑，读 state 会拿到旧值 */
  const liveEventsRef = useRef<RunEvent[]>([]);
  /** 单条流最多留多少事件。
   *
   *  **没有上限就是内存炸弹**（2026-10-31 现场 Aw-Snap）：事件数组只增不减，
   *  一次 6000+ 事件的 run 把 payload 全留在堆里；更要命的是原来每条事件都
   *  `setLiveEvents` → 每来一条就把 3000 行的 ChatConsole 整棵重渲染一遍，
   *  6000 条 = 6000 次渲染风暴，渲染进程被 OOM 杀掉。
   *  完整事件仍在库里，点「执行过程」时按需从 /api/runs/events 取，界面不丢东西。 */
  const LIVE_EVENTS_MAX = 1200;
  const eventFlushRef = useRef<number | null>(null);
  const flushLiveEvents = () => {
    if (eventFlushRef.current != null) return;
    // 攒一小会儿再吐给 React：8 次/秒够顺滑，渲染次数降一到两个数量级
    eventFlushRef.current = window.setTimeout(() => {
      eventFlushRef.current = null;
      setLiveEvents(liveEventsRef.current.slice());
    }, 120);
  };
  const appendLiveEvent = (ev: RunEvent) => {
    const buf = liveEventsRef.current;
    buf.push(ev);
    if (buf.length > LIVE_EVENTS_MAX) buf.splice(0, buf.length - LIVE_EVENTS_MAX);
    flushLiveEvents();
  };
  const resetLiveEvents = () => {
    if (eventFlushRef.current != null) {
      clearTimeout(eventFlushRef.current);
      eventFlushRef.current = null;
    }
    liveEventsRef.current = [];
    setLiveEvents([]);
  };
  const runStartRef = useRef<number>(0);
  /** 浏览器画面（Agent 的 Chromium screencast 直播帧，base64 JPEG —— 不落库，纯实时） */
  const [browserFrame, setBrowserFrame] = useState<{ data: string; url: string; title: string } | null>(null);
  const liveMeta = useRef<{ url: string; title: string }>({ url: "", title: "" });
  /* 浏览器动作字幕 + 打开面板 —— 帧只说"现在长什么样"，动作才说"它在干什么" */
  const [browserActions, setBrowserActions] = useState<BrowserAction[]>([]);
  /* 动作字幕批量上屏：browser_action 一轮能来几十条，每条 setState 就是一次整树
     commit；攒 120ms 一起上，肉眼无差，commit 少一个量级。 */
  const pendingActions = useRef<BrowserAction[]>([]);
  const actionTimer = useRef<number>(0);
  const flushActions = useCallback(() => {
    actionTimer.current = 0;
    const batch = pendingActions.current;
    if (!batch.length) return;
    pendingActions.current = [];
    setBrowserActions((prev) => [...prev, ...batch].slice(-60));
  }, []);
  const [browserOpen, setBrowserOpen] = useState(false);
  /** 用户暂停了浏览器的助手动作（协作式；换一轮就复位） */
  const [browserPaused, setBrowserPaused] = useState(false);
  /** 会话加载的请求序号（防旧回包覆盖新会话） */
  const loadSeqRef = useRef(0);
  /** 还没加载的更早轮次的上界（0 = 已到顶）；配合 api.sessionTurns 往上翻 */
  const [beforeTurn, setBeforeTurn] = useState(0);
  /** 消息还在路上：给 3 块骨架，而不是空白（切会话时最刺眼的就是这片空） */
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  /** 会话目录（一轮一条）+ 当前所在轮（滚动同步） */
  const [outline, setOutline] = useState<
    {
      turn_id: string;
      seq: number;
      digest: string;
      status: "done" | "running" | "waiting" | "error";
      created_at: number;
      step_count: number;
      artifact_count: number;
    }[]
  >([]);
  const [activeTurn, setActiveTurn] = useState<number | null>(null);
  const [outlineLoading, setOutlineLoading] = useState(false);
  /** 每个会话上次目录的 ETag（按会话记，不然切回来时拿着别家的 tag 必然 200） */
  const outlineEtagRef = useRef<Map<string, string | null>>(new Map());
  /* ── 右侧工具坞 ──
     展开/收起、开哪个面板、宽度都记在 localStorage：这是用户的布局偏好，
     每次进来都回到"收起"会让人以为功能没了。 */
  const [dockOpen, setDockOpen] = useState(false);
  const [dockPanel, setDockPanel] = useState<DockPanel>("browser");
  const [dockW, setDockW] = useState(400);
  /** 「步骤」标签看哪一次执行：点过程条的「在右栏看」时写入 */
  const [dockStepRun, setDockStepRun] = useState<string | null>(null);
  /** 用户亲手操作过右栏之后，就不再自动展开（自动抢焦点只允许一次） */
  const dockTouched = useRef(false);
  /** 浏览器这一轮第一次出画面时自动展开一次 */
  const dockAutoOpened = useRef(false);
  /** 文件数上一轮的值：有新增就在图标上点一下 */
  const [filesSeen, setFilesSeen] = useState(0);

  useEffect(() => {
    try {
      const o = localStorage.getItem("dock.open");
      if (o === "1") setDockOpen(true);
      const w = Number(localStorage.getItem("dock.w") || "");
      if (w >= 320 && w <= 560) setDockW(w);
      const p = localStorage.getItem("dock.panel");
      if (p === "browser" || p === "files" || p === "steps") setDockPanel(p);
    } catch {
      /* 隐私模式拿不到 localStorage：用默认值 */
    }
  }, []);
  const saveDock = useCallback((o: boolean, p: DockPanel, w: number) => {
    try {
      localStorage.setItem("dock.open", o ? "1" : "0");
      localStorage.setItem("dock.panel", p);
      localStorage.setItem("dock.w", String(w));
    } catch {
      /* 忽略 */
    }
  }, []);
  const openDock = useCallback(
    (p: DockPanel) => {
      dockTouched.current = true;
      setDockPanel(p);
      setDockOpen(true);
      saveDock(true, p, dockW);
    },
    [dockW, saveDock],
  );

  /* 浏览器这一轮第一次出画面：自动展开一次（用户一旦亲手动过右栏，就不再抢） */
  useEffect(() => {
    if (dockAutoOpened.current || dockTouched.current) return;
    if (!browserFrame) return;
    dockAutoOpened.current = true;
    setDockPanel("browser");
    setDockOpen(true);
    saveDock(true, "browser", dockW);
  }, [browserFrame, dockW, saveDock]);

  /* 左滑/返回键 = 关掉浏览器画面，而不是退出网页（手机上手势会被当成浏览器返回） */
  useHistoryLayer(browserOpen, () => setBrowserOpen(false));
  /* 执行过程留档：每步动作 + 当时那一屏（后端写在会话目录 browser/<run>/ 下） */
  const [browserSteps, setBrowserSteps] = useState<BrowserStep[]>([]);
  const lastBrowserRun = useRef<string>("");
  /* 「需要你上手」只在最后一个动作是 wait_login 时为真 —— 不用后端再加标记，
     动作流本身就是真相来源（登录完成后助手会继续 navigate/click，状态自然解除）。 */
  const browserWaiting =
    browserActions.length > 0 && browserActions[browserActions.length - 1].action === "wait_login";
  /** 本次发送的内容（作为执行过程的第一段「输入」） */
  const [liveInput, setLiveInput] = useState("");
  /** 正在跑的这一轮的 run id —— 停止时要拿它去 abort 后端 */
  const [liveRunId, setLiveRunId] = useState("");
  /** 待发送的附件（已上传，拿绝对路径注入消息让助手用 Read 读） */
  const [pendingFiles, setPendingFiles] = useState<
    { name: string; path: string; kind: "image" | "file"; url: string; size: number }[]
  >([]);
  const [busy, setBusy] = useState(false);
  /** 定时任务弹框（这个对话按时自己跑） */
  const [jobOpen, setJobOpen] = useState(false);
  // 清单在"一轮结束"时才整体刷新（跑的过程中由 TodoStrip 自己按 busy 轮询）
  const [todoTick, setTodoTick] = useState(0);
  const [jobCount, setJobCount] = useState(0);
  /** 本轮开始时间（毫秒）——过程条右侧那个秒数用它算 */
  const [runStart, setRunStart] = useState<number>(0);
  /** 每秒跳一次，只为让耗时数字动起来 */
  const [, setClock] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setClock((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);
  const liveElapsed = runStart ? Date.now() - runStart : 0;
  /* 过程条的数据源：liveEvents 只在 flush（约 8 次/秒）时换引用，memo 之后
     同一次渲染里不会重复把几千条事件重算成步骤（原来每渲染一次都重算）。 */
  const liveSteps = useMemo(() => eventsToSteps(liveEvents, liveInput), [liveEvents, liveInput]);
  const [input, setInput] = useState("");
  /* 草稿按会话存：切会话不丢没发出去的字。写入放在下面两个 effect 里 ——
     直接在 onChange 里写会把「刚切过去还没恢复」的空串覆盖掉草稿。 */
  const draftSid = useRef<string>("");

  /* 目录：切会话就拉一次；一轮跑完再拉一次（新问题要出现在目录末尾）。
     为什么不等消息：目录是结构，几百字节，先到先画，用户点得动。 */
  useEffect(() => {
    if (!sessionId) {
      setOutline([]);
      return;
    }
    let dead = false;
    setOutlineLoading(true);
    api
      .sessionOutline(sessionId, outlineEtagRef.current.get(sessionId) ?? null)
      .then((r) => {
        if (dead) return;
        // 304 = 内容没变：沿用现有目录，不重画、不闪
        if (!r.notModified) {
          setOutline(r.items || []);
          outlineEtagRef.current.set(sessionId, r.etag);
        }
        setOutlineLoading(false);
      })
      .catch(() => {
        if (!dead) {
          setOutline([]);
          setOutlineLoading(false);
        }
      });
    return () => {
      dead = true;
    };
  }, [sessionId, busy]);

  /* 滚动同步：视口上方 1/3 处那一轮 = 当前项 */
  useEffect(() => {
    const box = document.querySelector("[data-msg-scroll]");
    if (!box || outline.length === 0) return;
    const els = () => [...box.querySelectorAll<HTMLElement>("[data-turn]")];
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const t = Number((e.target as HTMLElement).dataset.turn || 0);
          if (t) setActiveTurn(t);
        }
      },
      { root: box, rootMargin: "-20% 0px -70% 0px", threshold: 0 },
    );
    els().forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [outline, history.length, sessionId]);

  /** 把后端拿到的消息转成界面用的形状（首屏与翻页共用一份规则） */
  const toHistory = useCallback(
    (msgs: { id: number; turn_index: number; role: string; content: string; run_id: string | null; ts: number; sources_count?: number }[]) =>
      msgs
        .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
        .map((m) => ({
          role: (m.content.startsWith("【自动汇报") ? "system" : m.role) as
            | "user"
            | "assistant"
            | "system",
          content: m.role === "assistant" ? humanizeAssistantText(m.content) : m.content,
          run_id: m.run_id,
          turn_index: m.turn_index,
          id: m.id,
          ts: m.ts,
          sources_count: m.sources_count ?? 0,
        })),
    [],
  );

  /** 往上翻：取更早的 20 轮插到头部，并保持滚动锚点（不跳） */
  const loadOlder = useCallback(async () => {
    if (!sessionId || loadingOlder || !beforeTurn) return;
    setLoadingOlder(true);
    const box = document.querySelector("[data-msg-scroll]");
    const prevH = box?.scrollHeight ?? 0;
    try {
      const r = await api.sessionTurns(sessionId, { before: beforeTurn, limit: 20 });
      const older = toHistory(r.messages as never);
      setHistory((h) => [...older, ...h]);
      setBeforeTurn(Number(r.before_turn ?? 0));
      requestAnimationFrame(() => {
        if (box) box.scrollTop += box.scrollHeight - prevH;
      });
    } catch {
      fb.error("加载更早的消息失败", "网络恢复后重试");
    } finally {
      setLoadingOlder(false);
    }
  }, [sessionId, loadingOlder, beforeTurn, toHistory, fb]);

  /** 跳到第 N 轮：滚到那一条的用户气泡，并给 600ms 高亮 */
  const jumpTurn = useCallback((seq: number) => {
    const box = document.querySelector("[data-msg-scroll]");
    const el = box?.querySelector<HTMLElement>(`[data-turn="${seq}"]`);
    if (!el && sessionId) {
      // 这一轮还没加载：取它前后各若干轮插进来，再滚过去（不打断阅读位置）
      void api
        .sessionTurns(sessionId, { around: seq, limit: 20 })
        .then((r) => {
          const extra = toHistory(r.messages as never);
          setHistory((h) => {
            const seen = new Set(h.map((x) => x.id));
            const add = extra.filter((x) => !seen.has(x.id));
            return [...add, ...h].sort(
              (a, b) => (a.turn_index || 0) - (b.turn_index || 0) || (a.id || 0) - (b.id || 0),
            );
          });
          requestAnimationFrame(() => {
            const target = document.querySelector<HTMLElement>(`[data-msg-scroll] [data-turn="${seq}"]`);
            target?.scrollIntoView({ behavior: "smooth", block: "start" });
          });
        })
        .catch(() => fb.error("定位失败", "这一轮取不回来，试试往上翻"));
      setActiveTurn(seq);
      return;
    }
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    const prev = el.style.outline;
    el.style.outline = "2px solid color-mix(in srgb, var(--color-accent) 80%, transparent)";
    el.style.outlineOffset = "4px";
    window.setTimeout(() => {
      el.style.outline = prev;
      el.style.outlineOffset = "";
    }, 650);
    setActiveTurn(seq);
    try {
      window.history.replaceState(null, "", `#turn-${seq}`);
    } catch {
      /* 忽略 */
    }
  }, []);

  /* 草稿按会话保存 / 恢复（见 draftSid 的说明） */
  useEffect(() => {
    draftSid.current = sessionId;
    try {
      setInput(sessionId ? localStorage.getItem(`chat.draft.${sessionId}`) || "" : "");
    } catch {
      setInput("");
    }
  }, [sessionId]);
  useEffect(() => {
    if (!sessionId || draftSid.current !== sessionId) return;
    try {
      if (input.trim()) localStorage.setItem(`chat.draft.${sessionId}`, input);
      else localStorage.removeItem(`chat.draft.${sessionId}`);
    } catch {
      /* 隐私模式：不存就是 */
    }
  }, [input, sessionId]);

  const [loading, setLoading] = useState(true);

  const esRef = useRef<EventSource | null>(null);
  /** sessionId 的镜像：SSE 回调在闭包里跑，必须读到"此刻"的会话 */
  const sessionIdRef = useRef("");
  sessionIdRef.current = sessionId;
  /** 这条 SSE 属于哪个会话 —— 用户切走之后，它推来的东西一律不许上屏 */
  const streamSessionRef = useRef("");
  const endRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  /** 断流自动重挂的计数：同一 run 连断 3 次说明服务/网络真有问题，
      再挂只会无限打转 —— 停下来把话说明白。 */
  const esReattachRef = useRef<{ runId: string; count: number }>({ runId: "", count: 0 });
  /** 已经收尾的 run —— 空闲轮询据此判断"这条是新一轮还是我刚看完的那条"，
      否则会对着一轮已经结束的执行反复重挂 SSE。 */
  const settledRunsRef = useRef<Set<string>>(new Set());
  /** liveRunId 的镜像（供定时器里的闭包读当前值） */
  const liveRunIdRef = useRef("");
  liveRunIdRef.current = liveRunId;
  /** attachStream 的稳定引用：轮询定时器要用它挂流，但不能因为它每次渲染都变
      就把定时器重建一遍（4 秒一轮的定时器被反复清掉等于没跑）。 */
  const attachRef = useRef<(runId: string, sentText: string) => void>(() => {});

  /* ------------------------------- 数据加载 ------------------------------- */

  /** 只刷助手清单（挂/卸技能之后要它，不重跑整段初始化） */
  const reloadAgents = useCallback(async () => {
    try {
      setAgents(await api.agents());
    } catch {
      /* 刷不动就维持现状 */
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [list, p] = await Promise.all([
          api.agents(),
          // 顺手带出服务器存放路径（不额外加一次往返；拿不到就不显示那行）
          api.paths().catch(() => null),
        ]);
        setAgents(list);
        setPaths(p);
        // 优先用 URL 带来的助手（从「我的助手」卡片点「聊天」进来时）：
        // 这样用户点谁就聊谁，不用再选一次
        const want =
          typeof window !== "undefined"
            ? new URLSearchParams(window.location.search).get("agent")
            : null;
        const pick = want && list.some((a) => a.id === want) ? want : list[0]?.id;
        if (pick) setAgentId(pick);
      } catch (e) {
        fb.error("加载 Agents 失败", e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [fb]);

  const loadSessions = useCallback(
    async (aid: string): Promise<Session[]> => {
      if (!aid) return [];
      try {
        const r = await api.sessions(aid, listEtagRef.current.get(aid) ?? null);
        const list = r.notModified ? sessionsRef.current : r.list;
        if (!r.notModified) {
          listEtagRef.current.set(aid, r.etag);
          setSessions(r.list);
        }
        // 侧栏另外挂 Router / 派活两组 —— 它们跨助手，不能只按当前助手过滤
        void api
          .sessions()
          .then((r) => {
            if (!r.notModified) setAllSessions(r.list);
          })
          .catch(() => undefined);
        return list;
      } catch (e) {
        fb.error("加载会话失败", e instanceof Error ? e.message : String(e));
        return [];
      }
    },
    [fb],
  );

  const loadMessages = useCallback(async (sid: string) => {
    if (!sid) {
      setHistory([]);
      return;
    }
    // 请求序号：快速切换会话时，晚到的旧回包必须丢弃 —— 否则会把上一个会话的
    // 消息画到新会话上（用户看到的是"切成功但内容还是旧的"）。
    const seq = ++loadSeqRef.current;
    setMessagesLoading(true);
    // 立刻清空旧内容：宁可先看骨架，也不要让上一会话的字留在屏幕上
    setHistory((h) => (h.length ? [] : h));
    try {
      const detail = await api.session(sid, 30);
      if (seq !== loadSeqRef.current) return;
      setCurKind(detail.session.kind ?? "chat");
      setCurTicket(detail.session.ticket_title ?? null);
      setCurParent(detail.session.parent_session_id ?? null);
      setCurAgentId(detail.session.agent_id ?? null);
      const fresh = detail.messages
          // system = 心跳这类"平台说的话"：不属于任何一轮，但要留在历史里
          // （关掉页面回来还能看到后台任务跑到哪了）
          .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
          .map((m) => ({
            // 平台的自动汇报（派活收口那一轮）不是用户说的话：按"系统消息"渲染，
            // 否则界面上看起来像用户自己贴了一段表格
            role: (m.content.startsWith("【自动汇报") ? "system" : m.role) as
              | "user"
              | "assistant"
              | "system",
            // 框架的内部话术（"I notice the interruption…"）不能原样给用户看
            content: m.role === "assistant" ? humanizeAssistantText(m.content) : m.content,
            run_id: m.run_id,
            turn_index: m.turn_index,
            id: m.id,
            ts: m.ts,
            sources_count: m.sources_count ?? 0,
          }));
      // 保留已经往上翻出来的更早消息：轮询/刷新不该把用户翻上去的历史又吞掉
      const earliestFresh = fresh.length ? Math.min(...fresh.map((x) => x.turn_index || 0)) : Infinity;
      const older = Number.isFinite(earliestFresh)
        ? historyRef.current.filter((x) => (x.turn_index || 0) < earliestFresh)
        : [];
      setHistory(older.length ? [...older, ...fresh] : fresh);
      setBeforeTurn(
        older.length
          ? Math.min(...older.map((x) => x.turn_index || 1)) - 1
          : Number(detail.before_turn ?? 0),
      );
    } catch {
      if (seq === loadSeqRef.current) setHistory([]);
    } finally {
      if (seq === loadSeqRef.current) setMessagesLoading(false);
    }
  }, []);

  /* 平台自动轮的消息（巡检/收口）是在你上一轮 SSE 结束**之后**才落库的 ——
     页面开着不动就永远看不到，用户观感就是「派完就没了，worker 咋样不知道」。
     空闲时轻轮询：不仅拉消息，还要看**会话里有没有新起的 run**。

     为什么必须盯着 run：Router 派完活这一轮就结束了，worker 回来后平台会在
     同一会话里**另起一轮**（origin=router 的收口/巡检）。那一轮是新的 run，
     页面没有它的 SSE —— 只轮询消息的话，整轮跑完才看得见，用户看到的就是
     「页面已经结束了，worker 的结果呢？」，非得手动刷新才出来。
     现在发现会话里有没跑完的 run 就直接挂上它的流，过程实时可见。 */
  useEffect(() => {
    if (busy || !sessionId) return;
    let alive = true;
    const tick = async () => {
      const inflight = await api.inFlightRuns(sessionId).catch(() => [] as Run[]);
      if (!alive) return;
      const live = (inflight || []).find(
        (r) =>
          (r.status === "running" || r.status === "pending") &&
          !settledRunsRef.current.has(r.id) &&
          r.id !== liveRunIdRef.current,
      );
      if (live) {
        setBusy(true);
        attachRef.current(live.id, "");
        return;
      }
      void loadMessages(sessionId);
    };
    const t = setInterval(() => void tick(), 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [busy, sessionId, loadMessages]);

  // 切 Agent：重载会话列表，选中最近一个；没有就自动建一个
  useEffect(() => {
    if (!agentId) return;
    void (async () => {
      const list = await loadSessions(agentId);
      // 深链（/exec?s=…）优先：地址里点名的那一个会话，哪怕它不在这个助手名下也照开
      const want = initialSession || deepSidRef.current || pendingPick.current;
      pendingPick.current = null;
      if (
        want &&
        (list.some((x) => x.id === want) || initialSession === want || deepSidRef.current === want)
      ) {
        setSessionId(want);
      } else if (list.length > 0) {
        setSessionId(list[0].id);
      } else {
        try {
          const s = await api.createSession(agentId, "新对话");
          setSessions([s]);
          setSessionId(s.id);
        } catch (e) {
          fb.error("新建会话失败", e instanceof Error ? e.message : String(e));
        }
      }
    })();
  }, [agentId, loadSessions, fb]);

  /* 深链：组件自己读一次地址（?s= 或 /exec/<id>）。
     不依赖上层传 prop —— prop 要走 effect 才到位，中间那几拍已经被
     "选中最近一个会话" 的逻辑覆盖掉了，深链就丢了。 */
  const deepDoneRef = useRef(false);
  /** 深链点名的那条会话：切换助手时不能被"选中最近一个"覆盖 */
  const deepSidRef = useRef("");
  useEffect(() => {
    if (deepDoneRef.current) return;
    deepDoneRef.current = true;
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    const sid =
      q.get("s") || (window.location.pathname.match(/^\/exec\/([^/?#]+)/)?.[1] ?? "");
    if (!sid) return;
    deepSidRef.current = sid;
    setSessionId(sid);
    void api
      .session(sid, 1)
      .then((d) => {
        const aid = d.session.agent_id;
        if (aid) setAgentId(aid);
      })
      .catch(() => null);
  }, []);

  /* 深链进来的会话：先问一句它属于哪个助手，把助手选择器也切过去。
     不切的话页面顶部显示 A、内容是 B 的会话，一发送就被后端拒（会话与 Agent 不匹配）。 */
  useEffect(() => {
    if (!initialSession) return;
    let dead = false;
    api
      .session(initialSession, 1)
      .then((d) => {
        if (dead) return;
        const aid = d.session.agent_id;
        if (aid && aid !== agentId) setAgentId(aid);
        // 助手切换会触发"选中最近一个会话"，把深链点名的那个顶掉 —— 这里再按回来
        setSessionId(initialSession);
      })
      .catch(() => {
        /* 会话不存在就按默认助手走，交给 loadMessages 报错 */
      });
    return () => {
      dead = true;
    };
    // 只在首次挂载时做：之后用户在页面里换助手/换会话不该被拉回深链那个
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSession]);

  /* 地址栏跟着当前会话走：复制地址 = 复制到这条对话 */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const pathSid = url.pathname.match(/^\/exec\/([^/?#]+)/)?.[1] ?? "";
    if (sessionId && sessionId !== pathSid) url.searchParams.set("s", sessionId);
    else url.searchParams.delete("s");
    if (agentId) url.searchParams.set("agent", agentId);
    window.history.replaceState(null, "", url.toString());
  }, [sessionId, agentId]);

  // 切会话：先把上一会话的实时现场收掉，再载入历史
  useEffect(() => {
    // 不关流的话，旧会话里还在跑的 run 会继续往 live 里追加文本，
    // 串到新会话的屏幕上 —— 这就是"A 会话的内容出现在 B 会话"的根因
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    streamSessionRef.current = "";
    setLive(null);
    resetLiveEvents();
    setLiveRunId("");
    setHitl(null);
    setBusy(false);
    // 浏览器现场同样属于上一个会话：画面帧、动作字幕、过程回顾都要清掉，
    // 否则切过去还能看到别人会话里那张网页截图和「打开 example.com」
    setBrowserFrame(null);
    pendingActions.current = [];
    if (actionTimer.current) { clearTimeout(actionTimer.current); actionTimer.current = 0; }
    setBrowserActions([]);
    setBrowserSteps([]);
    setBrowserOpen(false);
    lastBrowserRun.current = "";
    liveMeta.current = { url: "", title: "" };
    clearFrame();
    void (async () => {
      await loadMessages(sessionId);
      // ── 刷新恢复：会话里还有在跑的 run 就重新挂上 SSE ──
      // 后端没停（事件继续落库），只是页面的 SSE 断了；stream 端点
      // 先回放已落库事件再推增量，接上即恢复现场，不丢任何内容。
      if (!sessionId) return;
      try {
        const inflight = await api.inFlightRuns(sessionId);
        const live1 = inflight.find((r) => r.status === "running" || r.status === "pending");
        const hitl1 = inflight.find((r) => r.status === "waiting_hitl");
        if (live1) {
          // 用户输入从这条 run 关联的最后一条用户消息取（输入里可能带附件标记，
          // 原样传给 attachStream 才能把附件展示和过程时间线对上）
          const lastUser = [...historyRef.current]
            .reverse()
            .find((m) => m.role === "user" && m.run_id === live1.id);
          const inputText = lastUser?.content ?? "";
          setBusy(true);
          attachStream(live1.id, inputText);
        } else if (hitl1) {
          // 停在等确认：把确认条恢复出来（现场从历史 + pending_hitl 读）
          const r = await api.run(hitl1.id).catch(() => null);
          if (r?.pending_hitl) {
            const lastUser = [...historyRef.current]
              .reverse()
              .find((m) => m.role === "user" && m.run_id === hitl1.id);
            setHitl({ runId: hitl1.id, payload: r.pending_hitl as Record<string, unknown> });
            setLiveInput(lastUser?.content ?? "");
          }
        }
      } catch {
        /* 恢复失败不阻塞会话加载 —— 历史照常显示 */
      }
    })();
  }, [sessionId, agentId, loadMessages]);

  /* 自动跟随（对标主流对话）：只有「已经在底部附近」才跟着新内容走。
     用户往上翻看历史时，新的 token 不许把他拽回去 —— 这是聊天界面最容易
     惹人烦的毛病。离开底部时右下浮一个「回到最新」。 */
  const followRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  /* 程序自己滚的时候，不要被 onScroll 判成"用户往上翻了"。
     否则：贴底 → 中间态触发 scroll → gap 很大 → follow=false → 再也不贴底，
     表现就是每次进会话都差一截空白。 */
  /* 用时间戳而不是布尔标志：标志要靠 rAF 复位，而 MutationObserver 一密集
     就会反复置 true，reset 永远轮不到 —— onScroll 被永久屏蔽，浮标再不出现。 */
  const lastPinAt = useRef(0);
  const pinBottom = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    lastPinAt.current = Date.now();
    el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(() => {
    if (!followRef.current) return;
    const el = boxRef.current;
    if (!el) return;
    // 流式时用瞬时滚动（smooth 会被每帧的新内容打断，反而抖）
    pinBottom();
  }, [history, live, pinBottom]);
  const onScroll = () => {
    const el0 = boxRef.current;
    if (el0) setTopScrolled(el0.scrollTop > 2);
    // 自己刚贴过底（120ms 内）产生的那次 scroll 不算用户操作
    if (Date.now() - lastPinAt.current < 120) return;
    const el = boxRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    followRef.current = near;
    setAtBottom(near);
  };
  const jumpLatest = () => {
    followRef.current = true;
    setAtBottom(true);
    const el = boxRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  useEffect(() => () => esRef.current?.close(), []);

  /* 页面是静态导出的，chunk 文件名又不带内容哈希 —— 一直开着的标签页永远拿不到
     新代码，用户会一直对着旧界面（比如"卡顿还没修"）。这里每分钟问一次后端
     构建戳，变了就提示刷新，不自动刷（会打断正在写的输入）。 */
  const [staleBuild, setStaleBuild] = useState(false);
  useEffect(() => {
    let mine = 0;
    let stop = false;
    const check = async () => {
      try {
        const r = await fetch(withToken("/api/version"), { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as { build?: number };
        if (stop || !d.build) return;
        if (!mine) mine = d.build;
        else if (d.build !== mine) setStaleBuild(true);
      } catch {
        /* 断网就不管，下次再问 */
      }
    };
    void check();
    const t = setInterval(() => void check(), 60000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  /* ------------------------------- 操作 ------------------------------- */

  /** `/` 命令表 —— 能枚举的一律给选择（用户口径：让用户选择而不是输入） */
  /* `/` 菜单里的技能/工具/记忆：第一次打开菜单时拉一次，之后复用。
     （每天用不到，不该在进对话时就打三个接口） */
  const [slashLib, setSlashLib] = useState<{ skills: Skill[]; tools: Tool[]; mems: Memory[] }>({
    skills: [],
    tools: [],
    mems: [],
  });
  useEffect(() => {
    if (!slashOpen) return;
    if (slashLib.skills.length || slashLib.tools.length) return;
    let alive = true;
    void Promise.all([
      api.skills().catch(() => [] as Skill[]),
      api.tools().catch(() => [] as Tool[]),
      api.memories({ status: "active" }).catch(() => [] as Memory[]),
    ]).then(([sk, tl, mem]) => {
      if (!alive) return;
      setSlashLib({
        skills: (sk as Skill[]).filter((x) => (x.state ?? "active") !== "archived"),
        tools: tl as Tool[],
        mems: mem as Memory[],
      });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashOpen]);

  /** `/` 菜单里勾技能/工具：和工具行那两个面板走同一条写入路径 */
  const slashToggle = async (kind: "skill" | "tool", id: string) => {
    if (!currentAgent) return;
    const def = currentAgent.definition;
    if (kind === "skill") {
      const cur = (def.skills ?? []).map((x) => x.ref);
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      await api.updateAgent(currentAgent.id, {
        definition: { ...def, skills: next.map((r) => ({ ref: r })) },
      }).catch(() => null);
    } else {
      const cur = (def.tools ?? []).map((x) => x.ref);
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      await api.updateAgent(currentAgent.id, {
        definition: { ...def, tools: next.map((r) => ({ ref: r, enabled: true })) },
      }).catch(() => null);
    }
    void reloadAgents();
  };


  const newChat = async () => {
    if (!agentId) return;
    try {
      const s = await api.createSession(agentId, "新对话");
      await loadSessions(agentId);
      setSessionId(s.id);
      setHistory([]);
      setLive(null);
    } catch (e) {
      fb.error("新建对话失败", e instanceof Error ? e.message : String(e));
    }
  };

  /** 从这里重来：删掉这轮及之后，原文回到输入框（不自动发送 —— 让人先改） */
  const rewindTo = async (turnIndex: number, text: string) => {
    if (!sessionId) return;
    try {
      const r = await api.rewindSession(sessionId, turnIndex);
      await loadMessages(sessionId);
      await loadSessions(agentId);
      setInput(text);
      fb.success(
        "已回到这一轮",
        `删了 ${r.deleted} 条，剩 ${r.remaining} 条`,
      );
    } catch (e) {
      fb.error("回滚失败", e instanceof Error ? e.message : String(e));
    }
  };

  /** 从这轮之前另起会话（原会话不动） */
  const branchFrom = async (turnIndex: number) => {
    if (!sessionId) return;
    try {
      const s = await api.branchSession(sessionId, turnIndex);
      await loadSessions(agentId);
      setSessionId(s.id);
      fb.success("已另起一个会话", `「${s.title}」：已带过去，原会话没动`);
    } catch (e) {
      fb.error("分支失败", e instanceof Error ? e.message : String(e));
    }
  };

  const removeSession = async (s: Session) => {
    // 先数一下这个会话的文件夹里有什么 —— 删会话会**连文件夹一起删**，
    // 不提前说清楚，用户以为只是删掉聊天记录，产物就没了。
    let fileCount = 0;
    let fileBytes = 0;
    let dirLabel = `sessions/${s.id}`;
    try {
      const fl = await api.sessionFiles(s.id, 1000);
      fileCount = fl.count;
      fileBytes = (fl.files || []).reduce((a, f) => a + (f.size || 0), 0);
      if (fl.work_dir) {
        // 展示给人看的短路径：只留 `sessions/<会话号>` 这一段（绝对路径太长）
        const seg = fl.work_dir.split("/").filter(Boolean);
        if (seg.length >= 2) dirLabel = seg.slice(-2).join("/");
      }
    } catch {
      /* 数不到文件不影响删除本身，就退化成只说"文件夹会一起删" */
    }

    const ok = await fb.confirm({
      title: `删除对话「${s.title || s.id}」？`,
      description: "对话删掉，执行记录保留",
      details: [
        `${s.turn_count} 轮对话 · ${s.message_count} 条消息`,
        `${dirLabel}/ 文件夹`,
      ],
      warning:
        fileCount > 0
          ? `文件夹里 ${fileCount} 个文件（${fmt.bytes(fileBytes)}）会一起删掉，找不回来`
          : "会话文件夹会一起删，现在是空的",
      danger: true,
      confirmText: fileCount > 0 ? "连文件夹一起删" : "删除",
    });
    if (!ok) return;
    try {
      const res = await api.deleteSession(s.id);
      const list = await loadSessions(agentId);
      if (s.id === sessionId) {
        setSessionId(list.length > 0 ? list[0].id : "");
      }
      fb.success(
        res?.removed_dir
          ? fileCount > 0
            ? `已删除（含文件夹里的 ${fileCount} 个文件）`
            : "已删除（会话文件夹也清掉了）"
          : "已删除",
      );
    } catch (e) {
      fb.error("删除失败", e instanceof Error ? e.message : String(e));
    }
  };

  /** 行内改名：列表里直接改，不再弹框（阶段 2 的要求） */
  const renameSessionInline = async (s: Session, title: string) => {
    try {
      await api.updateSession(s.id, { title });
      await loadSessions(agentId);
    } catch (e) {
      fb.error("重命名失败", e instanceof Error ? e.message : String(e));
    }
  };

  /** 真删（不弹确认）：撤销窗口由会话列表自己管，8 秒后才走到这里 */
  const deleteSessionNow = async (s: Session) => {
    try {
      const res = await api.deleteSession(s.id);
      const list = await loadSessions(agentId);
      if (s.id === sessionId) {
        setSessionId(list.length > 0 ? list[0].id : "");
      }
      fb.success(res?.removed_dir ? "已删除（会话文件夹也清掉了）" : "已删除");
    } catch (e) {
      fb.error("删除失败", e instanceof Error ? e.message : String(e));
    }
  };

  const renameSession = async (s: Session) => {
    const name = await fb.prompt({
      title: "重命名对话",
      label: "名称",
      defaultValue: s.title || "",
      validate: (v) => (v.trim() ? null : "名称不能为空"),
      confirmText: "保存",
    });
    if (name === null || name.trim() === s.title) return;
    try {
      await api.updateSession(s.id, { title: name.trim() });
      await loadSessions(agentId);
      fb.success("已重命名");
    } catch (e) {
      fb.error("重命名失败", e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * 挂上某个 Run 的事件流，直到它**结束或暂停**。
   *
   * 抽出来是因为两条路径都要用：新发送（send），以及人工确认后恢复 ——
   * resume 之后运行会继续产出事件，必须有人接着收，否则用户只看到确认条消失、
   * 后面发生了什么全然不知。
   */
  /** 在画面上做的动作（点击/打字/滚动）→ 打进那个 run 的 Chromium。
   *  凭证只走这条路进浏览器，不进模型、不落库。 */
  /** 拉这一次浏览器执行的步骤留档 */
  const loadBrowserSteps = useCallback(async () => {
    const runId = lastBrowserRun.current || liveRunId;
    if (!sessionId || !runId) return;
    try {
      const r = await api.browserSteps(sessionId, runId);
      setBrowserSteps(r.steps ?? []);
    } catch {
      /* 没有留档就是空的，不打扰用户 */
    }
  }, [sessionId, liveRunId]);

  /* 刷新之后内存里的帧和动作都没了 —— 从会话目录里把最近一次的留档捞回来，
     这样"它上次在网上干了什么"这个入口不会消失（点开就是时间线 + 每步截图）。 */
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    void api
      .browserRuns(sessionId)
      .then((r) => {
        if (!alive) return;
        const first = r.runs?.[0];
        if (!first) return;
        if (!lastBrowserRun.current) lastBrowserRun.current = first.run_id;
        void loadBrowserSteps();
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (browserOpen) void loadBrowserSteps();
  }, [browserOpen, loadBrowserSteps]);

  const sendBrowser = useCallback(
    async (body: Record<string, unknown>) => {
      if (!liveRunId) return;
      await fetch(`/api/runs/${liveRunId}/browser-input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {});
    },
    [liveRunId],
  );

  const attachStream = (runId: string, sentText: string, reattachments = 0) => {
    const es = new EventSource(api.streamUrl(runId));
    esRef.current = es;
    streamSessionRef.current = sessionId;
    setLiveRunId(runId);
    setBrowserActions([]);
    setBrowserSteps([]);
    lastBrowserRun.current = runId;
    esReattachRef.current = { runId, count: reattachments };

    es.onmessage = (e: MessageEvent) => {
      try {
        // 用户已经切到别的会话了：这条流属于旧会话，不许再往界面上写
        if (streamSessionRef.current !== sessionIdRef.current) return;
        const ev = JSON.parse(e.data) as RunEvent;
        // 收下**全部**事件：不只文本，还包括思考与工具调用，
        // 这样执行过程能实时按颜色分段显示出来。
        // 走缓冲 + 限长（appendLiveEvent）：每条事件只进 ref，120ms 攒一批再交给
        // React，否则 6000 条事件 = 6000 次整棵组件重渲染（标签页被杀）。
        appendLiveEvent(ev);
        const p = ev.payload as Record<string, unknown>;
        if (ev.type === "text_delta") {
          const t = typeof p.text === "string" ? p.text : typeof p.delta === "string" ? p.delta : "";
          // 恢复现场时 live 还是空的（切回来/刷新后重新挂流）：
          // 第一条增量到了就把它开出来，否则这段输出永远上不了屏
          setLive((prev) =>
            prev ? { role: "assistant", text: prev.text + t } : { role: "assistant", text: t },
          );
        }
        if (ev.type === "hitl_request" && p && Object.keys(p).length) {
          // 授权请求**一到就弹**，不等流结束 —— 中间差着工具执行的尾巴（慢的几秒），
          // 用户看到的是"说完了却没下文"；当场弹条才是"它在等我"的即时反馈。
          // settle 之后还会再 set 一次（以 run.pending_hitl 为准，防重放丢 payload）。
          setHitl((prev) =>
            prev && prev.payload === p
              ? prev
              : { runId, payload: p as Record<string, unknown> },
          );
        }
        if (ev.type === "browser_action") {
          const summary = typeof p.summary === "string" ? p.summary : "";
          if (summary) {
            pendingActions.current.push({
              action: typeof p.action === "string" ? p.action : "",
              summary,
              target: typeof p.target === "string" ? p.target : "",
              url: typeof p.url === "string" ? p.url : "",
            });
            if (!actionTimer.current) actionTimer.current = window.setTimeout(flushActions, 120);
          }
        }
        if (ev.type === "browser_frame" && typeof p.frame === "string") {
          const u = typeof p.url === "string" ? p.url : "";
          // 收尾时会吐 about:blank 的白屏帧，丢掉它；url 偶尔为空（后端还没读到
          // document.URL）—— 那种时候沿用上一次的地址，别把地址栏清空。
          if (!u.startsWith("about:")) {
            // 位图走广播通道，直接写进 <img>；state 只在地址/标题变化时更新，
            // 否则每秒几十帧会把整个对话树重渲染一遍 —— 那就是卡顿的来源。
            const t = (typeof p.title === "string" && p.title) || "";
            const nu = u || liveMeta.current.url || "";
            const nt = t || liveMeta.current.title || "";
            liveMeta.current = { url: nu, title: nt };
            pushFrame({ data: p.frame as string, url: nu, title: nt });
            setBrowserFrame((prev) =>
              prev && prev.url === nu && prev.title === nt ? prev : { data: "", url: nu, title: nt }
            );
          }
        }
      } catch {
        /* ignore */
      }
    };

    /** settle 由两条路触发：服务端 'done'（正常收尾）与 es.onerror（断流）。
        断流时 run 可能还没落完终态 —— 直接查一次就放弃会让「等确认」的样子
        整个消失（用户看到的就是"对话突然断了"，刷新才回来）。这里小退避重试，
        拿到终态为止；始终拿不到就摆一条可见的错误，绝不静默。 */
    const settle = async (how: "done" | "error" = "done") => {
      es.close();
      if (streamSessionRef.current !== sessionIdRef.current) return;   // 早就切走了，别动当前界面
      setBusy(false);
      setLiveRunId("");
      // 帧**不清**：这轮浏览停在哪一页，用户事后再点开还能看见（开新 run 时才重置）。
      // 画面只进内存、不落库；持久的那一张在会话文件的 browser/<run>.jpg 里。
      void loadBrowserSteps();
      let r = null;
      for (let i = 0; i < 4; i++) {
        r = await api.run(runId).catch(() => null);
        if (r && (r.status === "waiting_hitl" || !["running", "pending"].includes(r.status))) break;
        await new Promise((res) => setTimeout(res, 600 * (i + 1)));
      }
      if (!r) {
        // 连 run 都查不到 —— 不装没事，明确说
        fb.error("连接中断", "这轮执行的状态查不到了，请刷新页面恢复现场");
        return;
      }
      if (r.status === "running" || r.status === "pending") {
        // 后端还在跑而流断了：自动重挂（stream 端点会回放已落库事件再推增量）。
        // 同一 run 连挂 3 次仍断 → 不再打转，明确告诉用户现场怎么回来。
        if (how === "error") {
          const prev = esReattachRef.current;
          const n = prev.runId === runId ? prev.count : 0;
          if (n >= 3) {
            fb.error("连接反复中断", "后端还在执行，但页面接不上事件流；刷新页面即可恢复现场");
            return;
          }
          esReattachRef.current = { runId, count: n + 1 };
          attachStream(runId, sentText, n + 1);
          return;
        }
      } else if (r.status !== "waiting_hitl") {
        // 真的收尾了：记下来，别让空闲轮询把这一轮又当成"新起的 run"重挂一遍。
        // waiting_hitl 不算收尾 —— 用户点完确认后端会接着跑同一条 run。
        settledRunsRef.current.add(runId);
      }
      if (r.status === "waiting_hitl") {
        // **不是结束，是暂停等你点头** —— 保留现场（不清 live），
        // 这样确认之后接着往同一个视图里追加，看起来是连贯的一次执行。
        // 每次 settle 都**重新读 pending_hitl**：resume 之后模型可能又要一次
        // 授权（新的 tool_call id）——旧条已锁死不可点，这里必须换**新条**，
        // 否则用户手里的还是上一轮的确认内容，点了必被 AgentScope 拒。
        setHitl((prev) =>
          prev && prev.payload === (r.pending_hitl as Record<string, unknown>)
            ? prev
            : { runId, payload: (r.pending_hitl as Record<string, unknown>) ?? {} },
        );
        return;
      }
      setHitl(null);
      // 刚跑完这一轮的过程摘要留在内存里 —— 气泡收起态立刻能显示"2 段思考 · 7.0s"，
      // 而不是退化成"点开看每一步"（事件是点开才拉的）
      try {
        rememberProc(
          runId,
          eventsToSteps(liveEventsRef.current, sentText),
          Date.now() - (runStartRef.current || Date.now()),
        );
      } catch {
        /* 摘要只是锦上添花，失败不影响收尾 */
      }
      setLive(null);
      // 这一轮可能改了清单（新建/勾掉），刷新清单条
      setTodoTick((n) => n + 1);
      // 用服务端的权威历史覆盖（包含刚写入的这一轮）
      await loadMessages(sessionId);
      await loadSessions(agentId);
      await verifyTurn(runId, sentText);
    };

    es.addEventListener("done", () => void settle("done"));
    es.onerror = () => void settle("error");
  };
  // 定时器里用的是"最新那个 attachStream"（它捕获了当下的 sessionId / 各种 ref）
  attachRef.current = attachStream;

  /**
   * 自动挑助手：定助手 → 定会话 → 起 run 全在服务端一次做完（前端分两步会出现
   * "提示交给 A、实际跑给 B"）。认不出来**不硬派** —— 把候选摆出来让人点。
   */
  const runAuto = async (text: string, forceAgentId?: string) => {
    setFailed(null);
    setHitl(null);
    setRouteAsk(null);
    setBusy(true);
    setRunStart(Date.now());
    runStartRef.current = Date.now();
    resetLiveEvents();
    try {
      const res = await api.autoStart({
        input: text,
        session_id: sessionId || undefined,
        origin: "chat",
        force_agent_id: forceAgentId,
      });
      if (res.kind === "needs_choice") {
        // 认不出来就别猜：话收进候选条、输入框腾空（否则用户对着残留文字再发一次）
        setBusy(false);
        setLive(null);
        setInput("");
        setPendingFiles([]);
        const multi = (res.decision.multi ?? []).map((m) => ({
          agent_id: m.agent_id,
          name: m.name || m.agent_id,
        }));
        setRouteAsk({
          text,
          reason: res.decision.reason,
          options: res.decision.alternatives.map((a) => ({
            agent_id: a.agent_id,
            name: a.name || a.agent_id,
          })),
          multi,
          // 汇总者：优先路由选中的那位（它就是分最高/规则命中的），否则第一位
          master: res.decision.agent_id || multi[0]?.agent_id || "",
        });
        return;
      }
      const switched = res.agent_id !== agentId;
      if (switched) setAgentId(res.agent_id);
      setSessionId(res.session_id);
      setRouteNote({ name: res.agent_name, reason: forceAgentId ? "你选的" : res.route.reason, switched });
      setInput("");
      setPendingFiles([]);
      setLive({ role: "user", text });
      setHistory((h) => [
        ...h,
        { role: "user" as const, content: text, run_id: res.run.id, turn_index: res.run.turn_index ?? 0 },
      ]);
      setLive({ role: "assistant", text: "" });
      setLiveInput(text);
      attachStream(res.run.id, text);
    } catch (e) {
      setFailed({ text, message: e instanceof Error ? e.message : String(e) });
      setLive(null);
      setBusy(false);
    }
  };

  const send = async (override?: unknown) => {
    // 允许传文本进来（重试时用）—— 传进来的可能是事件对象，所以只认字符串
    const text = (typeof override === "string" ? override : input).trim();
    if ((!text && pendingFiles.length === 0) || busy || !sessionId || !agentId) return;

    // 附件：上传后拿到服务端绝对路径 —— 以路径注入消息，助手用 Read 工具读
    //（不用 base64 塞进 input：大文件爆上下文，且文本类文件 Read 更省）
    const attachNote =
      pendingFiles.length > 0
        ? "\n\n" +
          pendingFiles.map((f) => `[附件] ${f.path}（${f.name}，可用 Read 工具读取）`).join("\n") +
          // 展示层标记：前端按它把附件还原成缩略图/卡片；对模型无害（就是一行 URL）
          "\n" + pendingFiles.map((f) => `[attach:${f.kind}:${f.url}:${f.name}:${f.size}]`).join("\n")
        : "";
    const composed = (text || "（请处理附件）") + attachNote;

    // 自动挑助手：先问平台这句话归谁，再决定要不要开跑（认不出来就把候选摆出来）。
    // Router 例外：它就是那个"决定交给谁"的角色，再问用户一遍纯属多余。
    if (autoPick && !isRouterAgent) {
      await runAuto(composed);
      return;
    }

    setFailed(null);
    setHitl(null);
    setInput("");
    setPendingFiles([]);
    setBusy(true);
    setRunStart(Date.now());
    runStartRef.current = Date.now();
    resetLiveEvents();
    setBrowserPaused(false);
    setLive({ role: "user", text: composed });
    // 直接进入助手流式态（user 消息由 live 显示，完成后由 history 接管）
    const userEcho = { role: "user" as const, content: composed, run_id: null, turn_index: 0 };
    setHistory((h) => [...h, userEcho]);
    setLive({ role: "assistant", text: "" });
    setLiveInput(composed);

    try {
      const run = await api.createRun({
        agent_id: agentId,
        input: composed,
        session_id: sessionId,
        origin: "chat",
      });
      attachStream(run.id, composed);
    } catch (e) {
      // 请求本身就没发出去 —— 同样要摆出来（原来只弹个 toast，消失后无从追溯）
      setFailed({ text: composed, message: e instanceof Error ? e.message : String(e) });
      setLive(null);
      setBusy(false);
    }
  };

  /**
   * 一轮跑完后核对结果：失败就把错误摆到界面上（而不是静默什么都没发生）。
   */
  const verifyTurn = async (runId: string, sentText: string) => {
    try {
      const r = await api.run(runId);
      if (r.status === "error" || r.status === "aborted") {
        setFailed({ text: sentText, message: r.error || `执行${r.status === "aborted" ? "被中断" : "失败"}` });
      }
    } catch {
      /* 核对失败不影响主流程 */
    }
  };

  /**
   * 运行中插话 —— 不重跑、不打断当前这一步，把那句话塞进这一轮的上下文。
   * 排在这一轮后面发的消息，等助手看到时想拦的事情已经发生了。
   */
  const steer = async () => {
    const text = input.trim();
    if (!text || !liveRunId) return;
    setInput("");
    try {
      const r = await api.steerRun(liveRunId, text);
      setHistory((h) => [
        ...h,
        { role: "user" as const, content: `（运行中插话）${text}`, run_id: liveRunId, turn_index: 0 },
      ]);
      fb.success(r.message || "已插话", text.slice(0, 80));
    } catch (e) {
      setInput(text);
      fb.warn("没插上", e instanceof Error ? e.message : String(e));
    }
  };

  /** 改完问句并重跑：作废这一轮及之后，用新内容直接再问一次。
      与「重来」的区别只在于——它不问「要不要」，改完就往下走。 */
  const rerunWith = async (turnIndex: number, text: string) => {
    if (!sessionId) return;
    try {
      const r = await api.rewindSession(sessionId, turnIndex);
      await loadMessages(sessionId);
      await loadSessions(agentId);
      fb.info("已作废这一轮之后的回答", `删了 ${r.deleted} 条，按新问法重答`);
      await send(text);
    } catch (e) {
      fb.error("重跑失败", e instanceof Error ? e.message : String(e));
      setInput(text);
    }
  };

  const stop = async () => {
    // 关流 + **中止后端执行**（不是只不看了 —— 那会白烧 token，
    // 用户点停止的意图就是「别做了」；abort 端点会把 run 标成 aborted）
    esRef.current?.close();
    if (liveRunId) await api.abortRun(liveRunId).catch(() => null);
    setLiveRunId("");
    setLive(null);
    setBusy(false);
    fb.warn("已停止", "这一轮已中止；输入还在，改改再发就行");
  };

  /* Esc 停止这一轮（对标主流：想停手时不用去够按钮）。
     只在执行中生效，且组字/菜单里按 Esc 不算。 */
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      void stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);

  /** 选了文件 / 粘贴图片 / 拖进来 → 上传 → 进待发清单（路径注入方案，见 send()） */
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  /** 文本域：自动长高用 */
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  /** 往输入框尾部追加一段文字并把焦点放回末尾 —— 快捷问句、记忆都走这里。
   *  只填不发：人能改，改完再发。 */
  const appendToInput = useCallback((t: string) => {
    setInput((prev) => (prev.trim() ? prev.replace(/\s+$/, "") + " " + t : t));
    setTimeout(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = ta.value.length;
      }
    }, 0);
  }, []);
  /** 有文件被拖到输入坞上方（给边框高亮 + 「松手即添加」提示） */
  const [dragging, setDragging] = useState(false);
  /** 运行停在等授权时输入坞不可用 —— 否则会又起一轮，和暂停的那一轮抢同一个会话。
   *  **但「已提交、正在恢复」之后要放开**：那一刻 run 已经往前跑了，input 禁用会让
   *  用户以为还卡着（底部还写着"运行暂停中"）。 */
  const paused = !!hitl && !busy;

  /**
   * 授权条的实例身份 —— **换一次请求就必须换一个实例**。
   *
   * HitlPrompt 把「已提交」记在自己的 `sent` 里（提交后整块收成一行状态、不能再点第二下，
   * 见该组件文件头第 3 条）。同一个实例只是换 `payload` 时，它仍然是 `sent=true`，
   * 于是**新的一次授权整条不显示**：用户看到的还是上一轮那句「已允许，继续执行…」，
   * 直到刷新页面（重新挂载组件）才看得到新的请求 —— 现场表现就是
   * 「权限确认不会在页面上显示，刷新后才出现」。
   *
   * 所以 key 必须跟着「这一次要授权的调用」变：run + reply_id + 各 tool_call id。
   */
  const hitlKey = hitl
    ? `${hitl.runId}:${String(hitl.payload?.reply_id ?? "")}:${(
        (hitl.payload?.tool_calls as { id?: string }[] | undefined) ?? []
      )
        .map((c) => c?.id ?? "")
        .join(",")}`
    : "none";

  /**
   * 文本域跟着内容长高（1 行起步，最多到视口 40%）。
   * 不做这个的话长输入会缩在单行里靠内部滚动条看，写法一多就瞎。
   */
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    const cap = Math.max(160, Math.round(window.innerHeight * 0.4));
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
  }, [input, paused]);

  /** 统一入口：点「+」/ 粘贴 / 拖拽三条路都走这里 */
  const addFiles = async (files: FileList | File[] | null) => {
    const list = files ? [...files] : [];
    if (list.length === 0) return;
    setUploading(true);
    try {
      const items = await Promise.all(list.map((f) => api.uploadFile(f)));
      setPendingFiles((prev) => [
        ...prev,
        ...items.map((it) => ({
          name: it.name,
          path: it.path,
          kind: (it.kind === "image" ? "image" : "file") as "image" | "file",
          url: it.url,
          size: it.size,
        })),
      ]);
    } catch (e) {
      fb.error("附件上传失败", e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // ── 布局开合状态 ────────────────────────────────────────
  // 三块区域各有明确职责，默认值按「一屏最贵的位置给谁」定：
  //  · 会话栏 navOpen：桌面在流内（260px），窄屏改为**抽屉**（不占高度）
  //  · 手机抽屉 mobileNav：默认关 —— 之前会话列表在手机上常驻，
  //    实测吃掉 338/844px（40% 屏高），对话只剩 450px 高 ✗
  //  · 右栏 Chrome 直播栏已移除（2026-10-29 用户拍板）——画面走消息流内
  //    缩略条 + 点开的居中大画面，右栏不再占位
  // ⚠️ 位置纪律：必须在**所有提前 return 之前**（本组件有 loading / 无助手两条
  // 提前返回）—— 放在它们之后会让两种情况 hook 数量不同，React 抛 #310
  // （Rendered more hooks than during the previous render），整页变错误页（踩过两次）。
  /** 会话栏宽度（220–360，记住用户调过的值） */
  const [navW, setNavW] = useState(264);
  const navWRef = useRef(264);
  useEffect(() => {
    navWRef.current = navW;
  }, [navW]);
  useEffect(() => {
    try {
      const w = Number(localStorage.getItem("chat.navW") || "");
      if (w >= 220 && w <= 360) setNavW(w);
    } catch {
      /* 忽略 */
    }
  }, []);
  const [mobileNav, setMobileNav] = useState(false);
  /* 手机抽屉也是一层历史：左滑先关抽屉（不是退出网页） */
  useHistoryLayer(mobileNav, () => setMobileNav(false));

  /* 切会话也记一层：手机上左滑回到**上一个会话**，而不是退出网页。
     抽屉里点会话会顺带关抽屉 —— close() 对非栈顶层只摘记录不回退，
     所以先 push 会话层，抽屉那条记录随后被静默摘掉，不会多退一级。 */
  const pickSession = (id: string, takeOver = false) => {
    if (!id || id === sessionId) return;
    const prev = sessionId;
    // 侧栏树里的子节点是**别的助手**的会话：直接打开会"会话变了、助手没变"，
    // 所以要连助手一起切；切完还要回到这一条（切 Agent 的 effect 默认选最近一条）。
    const target = [...sessions, ...allSessions].find((x) => x.id === id);
    if (target && target.agent_id && target.agent_id !== agentId) {
      pendingPick.current = id;
      setAgentId(target.agent_id);
    } else {
      setSessionId(id);
    }
    if (prev) pushSessionLayer(() => setSessionId(prev), takeOver);
  };
  /** 抽屉两个视图：会话（默认）/ 功能与配置。手机上全站只有这一个抽屉，
      功能入口不能另开一个抽屉，也不能塞成横向短标签条（短名和侧栏的完整
      标签对不上，就是"不统一"的来源）。 */
  const [navView, setNavView] = useState<"sessions" | "menu">("sessions");
  /** 助手选择面板开合：「哪个形态被点开了」。三种挂载点只认自己那一份，
   *  共用布尔值会让面板在窗口跨断点缩放后凭空冒出来（桌面开着的面板飘到手机上）。 */
  const [switcherOpen, setSwitcherOpen] = useState<null | "bar" | "sidebar" | "mini">(null);
  const router = useRouter();
  const pathname = usePathname();
  /** 抽屉里的菜单项点完就跳页 —— 抽屉的关闭**交给路由变化**来做。
   *
   *  之前是 onClick 里先 setMobileNav(false) 再 router.push(href)，而 Link 自己
   *  也会导航：两次导航互相打断，实际表现是"抽屉关了、页面没动"（手机上点
   *  「Agents / 工具 / LLM 配置」全都没反应，得刷新或手动改地址）。
   *  现在只让 Link 导航，抽屉在路径变了以后收起来。 */
  useEffect(() => {
    setMobileNav(false);
    setNavView("sessions");
  }, [pathname]);
  /** 底部输入坞的高度：它是浮在消息之上的（毛玻璃要透出下面滚过的内容），
   *  所以消息区要留出这么一块内边距，否则最后一条会被压在底下。 */
  const [dockH, setDockH] = useState(150);
  const dockRO = useRef<ResizeObserver | null>(null);
  /** 用 callback ref 而不是 useEffect：这一块可能是条件渲染后才挂上的，
   *  effect 只跑一次会永远量到 0。 */
  const dockRef = useCallback((el: HTMLDivElement | null) => {
    dockRO.current?.disconnect();
    if (!el) return;
    const sync = () => setDockH(el.offsetHeight || 0);
    sync();
    dockRO.current = new ResizeObserver(sync);
    dockRO.current.observe(el);
  }, []);

  /** 兜底：ResizeObserver 在部分环境里不报（无头/后台标签），每次渲染后同步量一次，
   *  差异超过 2px 才写回 —— 相等就停，不会自激。 */
  useLayoutEffect(() => {
    const el = document.querySelector<HTMLDivElement>("[data-dock]");
    if (!el) return;
    const h = el.offsetHeight;
    if (h > 0 && Math.abs(h - dockH) > 2) setDockH(h);
  });

  /* dock 高度一变（快捷标签出现/隐藏、键盘弹出收掉那一行），消息区底部留白跟着变。
     还停在底部的就重新贴底 —— 不然会凭空多出一百多像素的空白，看起来像"消息没加载完"。
     判据放宽到 300：布局变化本身就会制造一两百像素的空隙，用 80 判"不在底部"
     会把自己锁死（不贴底 → 判为离底 → 永远不贴底）。用户真往上翻时离底都远大于 300。 */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (!followRef.current && gap > 300) return;
    followRef.current = true;
    pinBottom();
  }, [dockH, history.length, pinBottom]);

  /* 进会话的兜底贴底：消息是分几批进来的（历史 → 执行过程 → 折叠块），
     每一批都会把内容撑高一点，等 MutationObserver 追完往往还差几十像素。
     这里在 50/300/900ms 各贴一次，之后就交给上面的跟随逻辑。 */
  useEffect(() => {
    if (!sessionId) return;
    followRef.current = true;
    setAtBottom(true);
    const timers = [50, 300, 900].map((ms) => window.setTimeout(() => pinBottom(), ms));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [sessionId, pinBottom]);

  /* 消息内容自己长高（图片、执行过程条、表格渲染完）时也要贴底。
     只靠 history 变化不够 —— 那些是异步组件，撑高发生在渲染之后，
     结果就是"进来看不到最新那条，底部差一条空白"。 */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const mo = new MutationObserver(() => {
      if (!followRef.current) return;
      requestAnimationFrame(() => {
        if (followRef.current) pinBottom();
      });
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
    // 依赖 sessionId：切换会话时滚动容器可能被整块重建（加载态 → 有消息），
    // 只在 mount 时挂一次会盯着一个已经不在文档里的旧节点，永远收不到通知。
  }, [sessionId]);

  // 视口变化（转屏、拖窗口）时输入坞的高度也会变，得重新量
  useEffect(() => {
    const sync = () => {
      const el = document.querySelector<HTMLDivElement>("[data-dock]");
      if (el) setDockH(el.offsetHeight || 0);
    };
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
    };
  }, []);
  const [showPaths, setShowPaths] = useState(false);
  /* 会话文件清单能不能折叠 —— 文件一多这条会占掉对话区；
     默认：≤3 个就摊开（少的时候看得见才有用），多了先收起（点箭头/标题展开）。
     用户手动点过就记住他的选择（localStorage），别每次刷新都跟他对着来。 */
  const [filesOpenPref, setFilesOpenPref] = useState<boolean | null>(null);
  /** 刷新会话文件清单时给按钮一个转圈（不然点了没反应，人会连点） */
  const [filesBusy, setFilesBusy] = useState(false);
  useEffect(() => {
    try {
      const v = localStorage.getItem("chat.filesOpen");
      if (v === "1") setFilesOpenPref(true);
      else if (v === "0") setFilesOpenPref(false);
    } catch {
      /* 隐私模式下 localStorage 会抛，忽略 */
    }
  }, []);
  const fileCount = sessionFiles?.count ?? 0;
  /* 打开文件面就等于"看见了"，把小红点清掉 */
  useEffect(() => {
    if (dockOpen && dockPanel === "files") setFilesSeen(fileCount);
  }, [dockOpen, dockPanel, fileCount]);
  /* 默认收起：进对话先看消息，「N 个文件」chip 在输入区上方，点一下才出面板。
     之前 ≤3 个默认摊开 —— 文件面板带遮罩直接糊在对话上，用户一进会话就被挡（实测反馈）。
     用户手动点过就记住他的选择（localStorage），别每次刷新都跟他对着来。 */
  const openFiles = filesOpenPref ?? false;
  /* 文件面板同样是一层：打开时左滑关面板，而不是退出网页（手机实测最容易被踩到） */
  useHistoryLayer(openFiles && fileCount > 0 && sessionId !== "", () => setFilesOpenPref(false));

  /* ---- 文件查询 / 删除 ----
     文件多了要能找、能一次删掉几个。搜索只在本会话目录里过滤（名字或后缀），
     管理态才把文件变成可勾选的 —— 平时点一下还是打开预览，不改变原有习惯。 */
  const [fileQuery, setFileQuery] = useState("");
  const [managing, setManaging] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const shownFiles = useMemo(() => {
    const all = sessionFiles?.files ?? [];
    const q = fileQuery.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (f) => f.path.toLowerCase().includes(q) || middleEllipsis(f.path, 60).toLowerCase().includes(q),
    );
  }, [sessionFiles, fileQuery]);
  const togglePick = (path: string) =>
    setPicked((cur) => (cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path]));
  const bulkDelete = async () => {
    if (!sessionId || picked.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      const r = await api.deleteSessionFiles(sessionId, picked);
      fb.success(`删掉了 ${r.count} 个文件`, picked.length ? picked.slice(0, 3).join("、") + (picked.length > 3 ? " 等" : "") : "");
      setPicked([]);
      setBulkConfirm(false);
      setManaging(false);
      await loadSessionFiles();
    } catch (e) {
      fb.error("删除失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBulkBusy(false);
    }
  };
  const toggleFiles = () => {
    const next = !openFiles;
    setFilesOpenPref(next);
    try {
      localStorage.setItem("chat.filesOpen", next ? "1" : "0");
    } catch {
      /* 同上 */
    }
  };
  const [navOpen, setNavOpen] = useState(true);
  /** 会话列表的条件请求：按助手记住上次 ETag，内容没变就不重画列表 */
  const listEtagRef = useRef<Map<string, string | null>>(new Map());
  const sessionsRef = useRef<Session[]>([]);
  sessionsRef.current = sessions;
  /* 空间不够时优先收会话栏：右栏一开，内容列就只剩不到 520px 了。
     只恢复「这次是我们自己收的」，用户手动收的不动（手动优先，直到视口跨断点）。 */
  const navAutoCollapsed = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    // 1280–1439 时 264 侧栏 + 400 右栏会把内容列压到 520 以下，所以这里也收
    const narrow = window.innerWidth < 1440;
    if (dockOpen && narrow && navOpen) {
      navAutoCollapsed.current = true;
      setNavOpen(false);
    } else if (!dockOpen && navAutoCollapsed.current) {
      navAutoCollapsed.current = false;
      setNavOpen(true);
    }
  }, [dockOpen, navOpen]);



  // 一轮跑完顺手刷一下（刚产出的文件当场就能看见）
  useEffect(() => {
    if (!busy) void loadSessionFiles();
  }, [busy, loadSessionFiles]);
  useEffect(() => {
    try {
      const savedNav = localStorage.getItem("chat.navOpen");
      if (savedNav !== null) setNavOpen(savedNav === "1");
    } catch {}
  }, []);
  /* 键盘：⌘/Ctrl+B 收起/展开会话栏，⌘/Ctrl+K 聚焦搜索。
     输入框里按 ⌘B 也要生效（这是全局布局动作，不是文本编辑）。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleNav();
      } else if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>('input[placeholder="搜索对话"]');
        input?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // toggleNav 是稳定闭包（内部只 setState + 写 localStorage）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleNav = () => {
    setNavOpen((v) => {
      try { localStorage.setItem("chat.navOpen", v ? "0" : "1"); } catch {}
      return !v;
    });
  };
  /** 兼容旧调用点：input 的 change 事件给的是 FileList */
  const pickFiles = (files: FileList | null) => void addFiles(files);

  /** 首轮回复完成后自动起标题：只动默认名（新对话/未命名），用户改过的绝不覆盖。
      纯前端：取首条用户消息截 20 字，走已有的 updateSession 接口，不新增后端。 */
  useEffect(() => {
    if (!sessionId || busy) return;
    const cur = sessions.find((s) => s.id === sessionId);
    if (!cur) return;
    const t = (cur.title || "").trim();
    if (t && !/^(新对话|未命名)/.test(t)) return;
    const firstUser = history.find((m) => m.role === "user" && (m.content || "").trim());
    if (!firstUser) return;
    if (!history.some((m) => m.role === "assistant")) return;
    const text = (firstUser.content || "").replace(/\s+/g, " ").trim().slice(0, 20);
    if (!text) return;
    void api
      .updateSession(sessionId, { title: text })
      .then(() => loadSessions(agentId))
      .catch(() => {});
  }, [sessionId, busy, sessions, history, agentId, loadSessions]);

  /* ------------------------------- 渲染 ------------------------------- */

  if (loading) {
    return <div className="p-4 md:p-6 lg:p-7 text-[13px] text-[var(--color-muted)]">加载中…</div>;
  }

  const currentAgent = agents.find((a) => a.id === agentId);
  /** 顶栏要显示/改名的当前会话 */
  const curSes = sessions.find((x) => x.id === sessionId);
  /** 最新一条助手/用户消息：动作条要常驻（更早的靠 hover） */
  const lastAssistantIdx = history.map((x) => x.role).lastIndexOf("assistant");
  const lastUserIdx = history.map((x) => x.role).lastIndexOf("user");

  /* `/` 菜单的条目：必须定义在 currentAgent 之后 —— 里面 .map 会立即读
     currentAgent.definition 判断「已挂」，放前面就是 TDZ（Cannot access before initialization）。 */
  const slashItems: CommandItem[] = [
    {
      id: "new",
      label: "新对话",
      hint: "另起一个干净的会话",
      fill: "/新对话",
      run: () => void newChat(),
    },
    /* 技能 / 工具：选中即勾上或取消（勾着的排在前面） */
    ...slashLib.skills.map((sk) => {
      const on = (currentAgent?.definition.skills ?? []).some((x) => x.ref === sk.id);
      return {
        id: `sk-${sk.id}`,
        group: "技能",
        on,
        label: sk.name,
        hint: (sk.description ?? "").slice(0, 40),
        run: () => void slashToggle("skill", sk.id),
      };
    }),
    ...slashLib.tools.map((tl) => {
      const on = (currentAgent?.definition.tools ?? []).some((x) => x.ref === tl.id);
      return {
        id: `tl-${tl.id}`,
        group: "工具",
        on,
        label: tl.name,
        hint: (tl.description ?? "").slice(0, 40),
        run: () => void slashToggle("tool", tl.id),
      };
    }),
    /* 记忆：选中把内容填进输入框（想让它照着做） */
    ...slashLib.mems.map((m) => ({
      id: `mem-${m.id}`,
      group: "记忆",
      label: m.content.slice(0, 30) + (m.content.length > 30 ? "…" : ""),
      hint: m.layer === "user" ? "关于你" : "助手笔记",
      run: () => appendToInput(m.content),
    })),
    /* 切助手放最后：这一屏里更常做的是「给这轮加个技能/工具」 */
    ...agents.map((a) => ({
      id: `agent-${a.id}`,
      group: "助手",
      label: `切换到 ${a.name}`,
      hint: (a.description ?? "").slice(0, 40) || "换一个助手接着聊",
      fill: `/${a.name}`,
      run: () => setAgentId(a.id),
    })),
  ];

  /* 一个助手都没有 —— 别让人对着空下拉框发呆，直接给出路 */
  if (!loading && agents.length === 0) {
    return (
      <div className="h-[calc(100dvh-3.5rem)] md:h-dvh flex items-center justify-center p-6">
        <div className="card p-6 max-w-md text-center">
          <div className="text-[28px] mb-2">✦</div>
          <h2 className="text-[16px] font-medium mb-2">还没有可以聊的助手</h2>
          <p className="text-[12px] text-[var(--color-muted)] leading-relaxed mb-4">
            助手就是「会自己想办法帮你做事的 AI」。
            <br />
            创建一个，然后就能像发消息一样让它干活了。
          </p>
          <div className="flex flex-col sm:flex-row gap-2 justify-center">
            <Link href="/agents" className="rounded-[var(--radius-sm)] px-3 py-1.5 text-[13px]" style={{ background: "var(--color-surface-2)", color: "var(--color-text)" }}>
              创建一个助手
            </Link>
            <Link href="/credentials" className="btn text-[13px]">
              先配模型密钥
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    /* 对话里的"文件"（正文路径、工具产物）点开是操作框 —— 这里给它们会话上下文 */
    <FileOpenerProvider
      sessionId={sessionId}
      workDir={sessionFiles?.work_dir}
      onFileChanged={() => void loadSessionFiles()}
      onReveal={(path) => {
        setFilesOpenPref(true);
        void loadSessionFiles();
        fb.info("已打开会话文件", path);
      }}
    >
      <div className="h-full min-h-0 flex max-md:-mt-[44px] max-md:h-[calc(100%+44px)]">
        {/* 手里这份页面过期了：一直开着的标签页不会自己换代码，提示一下，别让用户
            对着旧界面判断"改了没用" */}
        {staleBuild && (
          <div
            className="fixed left-1/2 top-2 z-[90] -translate-x-1/2 rounded-full border px-3 py-1.5 text-[12px] shadow-lg"
            style={{
              background: "var(--color-surface)",
              borderColor: "var(--color-accent)",
              color: "var(--color-text)",
            }}
            role="status"
          >
            界面已更新
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="ml-2 font-medium underline"
              style={{ color: "var(--color-accent)" }}
            >
              刷新
            </button>
          </div>
        )}
        {configAgent && (
          <AgentDetailDialog agentId={configAgent} onClose={() => setConfigAgent(null)} />
        )}

        {/* ── 会话栏（桌面在流内，可收起；窄屏走抽屉）────────────────────
            收起后不留空白 —— 只剩 44px 的把手，点一下回来。 */}
        {navOpen ? (
          <aside
            className="relative hidden lg:flex shrink-0 bg-[var(--color-surface)] flex-col min-h-0"
            style={{ width: navW }}
          >
            {/* 拖拽柄：双击回到默认宽度（260）—— 调过的宽度常常是临时需求 */}
            <span
              role="separator"
              aria-orientation="vertical"
              aria-label="调整会话栏宽度"
              onMouseDown={(e) => {
                const startX = e.clientX;
                const startW = navW;
                const move = (ev: MouseEvent) => {
                  const w = Math.min(360, Math.max(220, startW + (ev.clientX - startX)));
                  setNavW(w);
                };
                const up = () => {
                  document.removeEventListener("mousemove", move);
                  document.removeEventListener("mouseup", up);
                  try {
                    localStorage.setItem("chat.navW", String(navWRef.current));
                  } catch {
                    /* 忽略 */
                  }
                };
                document.addEventListener("mousemove", move);
                document.addEventListener("mouseup", up);
              }}
              onDoubleClick={() => {
                setNavW(264);
                try {
                  localStorage.setItem("chat.navW", "264");
                } catch {
                  /* 忽略 */
                }
              }}
              className="absolute -right-[3px] top-0 bottom-0 z-10 w-[6px] cursor-col-resize"
              style={{ background: "transparent" }}
            />
            <SessionsPane
              agentSlot={
                controlledAgentId === undefined ? (
                  <>
                    <AgentSwitcher
                      variant="sidebar"
                      agents={agents}
                      value={agentId}
                      onChange={setAgentId}
                      busy={busy}
                      open={switcherOpen === "sidebar"}
                      onOpenChange={(v) => setSwitcherOpen(v ? "sidebar" : null)}
                      onSettings={agentId ? () => setConfigAgent(agentId) : undefined}
                    />
                  </>
                  ) : null
              }
              agentId={agentId}
              sessions={navSessions}
              sessionId={sessionId}
              onPick={pickSession}
              onNew={() => void newChat()}
              onRename={(s) => void renameSession(s)}
              onRemove={(s) => void removeSession(s)}
              onDelete={(s) => void deleteSessionNow(s)}
              onRenameCommit={(s, t) => void renameSessionInline(s, t)}
              pinned={pinned}
              onTogglePin={togglePin}
              onExport={(s) => void exportSession(s, "md")}
              onExportJson={(s) => void exportSession(s, "json")}
              onCollapse={toggleNav}
            />
          </aside>
        ) : (
          <div className="hidden lg:flex w-11 shrink-0 flex-col items-center gap-2 py-3 bg-[var(--color-surface)]">
            {(
              <AgentSwitcher
                variant="mini"
                agents={agents}
                value={agentId}
                onChange={setAgentId}
                busy={busy}
                open={switcherOpen === "mini"}
                onOpenChange={(v) => setSwitcherOpen(v ? "mini" : null)}
              />
            )}
            <button
              data-tap
              title="展开对话列表"
              onClick={toggleNav}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]"
            >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h10" />
            </svg>
            </button>
            <span
              className="text-[10.5px] tabular-nums px-1.5 rounded-full"
              style={{ background: "var(--color-surface-2)", color: "var(--color-muted)" }}
            >
              {sessions.length}
            </span>
          </div>
        )}

        {/* ── 手机会话抽屉：浮在对话之上，不吃对话高度 ─────────────── */}
        {mobileNav && (
          <div className="lg:hidden fixed inset-0 z-40 flex">
            <div className="veil-in absolute inset-0" style={{ background: "rgba(15,23,42,.28)" }} onClick={() => setMobileNav(false)} />
            <div className="drawer-in relative w-[312px] max-w-[86vw] bg-[var(--color-surface)] flex flex-col min-h-0">
              {navView === "menu" ? (
                /* 功能视图 —— 和桌面侧栏同一份定义、同样的完整标签 */
                <>
                  <div className="shrink-0 h-[calc(44px+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] flex items-center gap-1 pl-1 pr-3 border-b border-[var(--color-border)]"
                style={{
                  background: "color-mix(in srgb, var(--color-surface) 62%, transparent)",
                  backdropFilter: "blur(16px) saturate(1.7)",
                  WebkitBackdropFilter: "blur(16px) saturate(1.7)",
                }}>
                    <button
                      data-tap
                      aria-label="返回对话列表"
                      onClick={() => setNavView("sessions")}
                      className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg text-[var(--color-muted)] active:bg-[var(--color-surface-2)] border"
                      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
                    >
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M15 18l-6-6 6-6" />
                      </svg>
                    </button>
                    <span className="text-[15px] font-semibold tracking-tight">功能与配置</span>
                  </div>
                  {/* 和桌面侧栏同一套行式菜单：图标 + 名字（+ 一句说明）。
                      条目同源（USE_ITEMS / SETUP_ITEMS）、同样分「使用 / 配置」两组，
                      手机上不另造一种排版 —— 换个设备不该像换了个产品。 */}
                  <div className="flex-1 overflow-y-auto px-2 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
                    {[
                      { label: "使用", items: USE_ITEMS },
                      { label: "配置", items: SETUP_ITEMS },
                    ].map((grp) => (
                      <div key={grp.label} className="mb-1.5">
                        <div className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--color-muted)]">
                          {grp.label}
                        </div>
                        {grp.items.map((item) => (
                          /* 这一处**故意用原生 a**，不用 next/link。
                             手机上（从 /exec 的抽屉点出去）Link 的客户端导航会被
                             随即回滚成 /exec —— 抽屉关了、页面没动，用户看到的
                             就是「点了没反应」。原生 a 走整页加载，一定跳得过去；
                             这几个是配置页，整页加载的代价可以接受。 */
                          <a
                            key={item.href}
                            href={item.href}
                            onClick={() => setNavView("sessions")}
                            className="flex items-center gap-2.5 rounded-lg px-2 py-2 min-h-[48px] active:bg-[var(--color-surface-2)] transition-colors"
                          >
                            <span className="shrink-0" style={{ color: "var(--color-muted)" }}>
                              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d={ICON_PATHS[item.icon] ?? ""} />
                              </svg>
                            </span>
                            <span className="min-w-0 flex flex-col">
                              <span className="text-[14px] leading-tight">{item.label}</span>
                              <span className="text-[11.5px] leading-snug truncate text-[var(--color-muted)]">
                                {item.tip}
                              </span>
                            </span>
                          </a>
                        ))}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <SessionsPane
                    agentSlot={
                      <div className="px-0.5">
                        {(
                          <AgentSwitcher
                            variant="sidebar"
                            agents={agents}
                            value={agentId}
                            onChange={setAgentId}
                            busy={busy}
                            open={switcherOpen === "sidebar"}
                            onOpenChange={(v) => setSwitcherOpen(v ? "sidebar" : null)}
                            onSettings={agentId ? () => setConfigAgent(agentId) : undefined}
                          />
                        )}
                      </div>
                    }
                    sessions={navSessions}
                    sessionId={sessionId}
                    onPick={(id) => {
                      pickSession(id, true); // 接管抽屉那条历史，免得左滑出现「空退」
                      setMobileNav(false);
                    }}
                    onNew={() => {
                      void newChat();
                      setMobileNav(false);
                    }}
                    onRename={(s) => void renameSession(s)}
                    onRemove={(s) => void removeSession(s)}
                    onDelete={(s) => void deleteSessionNow(s)}
                    onRenameCommit={(s, t) => void renameSessionInline(s, t)}
                    pinned={pinned}
                    onTogglePin={togglePin}
                    onExport={(s) => void exportSession(s, "md")}
                    onExportJson={(s) => void exportSession(s, "json")}
                    onCollapse={() => setMobileNav(false)}
                  />
                  <div className="shrink-0 border-t border-[var(--color-border)] pb-[env(safe-area-inset-bottom)]">
                    <button
                      data-tap
                      onClick={() => setNavView("menu")}
                      className="w-full flex items-center gap-2.5 px-3 h-12 text-[var(--color-muted)] active:bg-[var(--color-surface-2)]"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M4 6h16M4 12h16M4 18h10" />
                      </svg>
                      <span className="text-[13.5px]">功能与配置</span>
                      <span className="ml-auto text-[var(--color-muted)]">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M9 18l6-6-6-6" />
                        </svg>
                      </span>
                    </button>
                  </div>
                </>
              )}
            </div>
            <button
              aria-label="关闭对话列表"
              className="flex-1"
              style={{ background: "var(--color-overlay)" }}
              onClick={() => setMobileNav(false)}
            />
          </div>
        )}

        {/* ── 对话区 ─────────────────────────────────────────── */}
        <section className="relative flex-1 flex flex-col min-h-0 min-w-0">
          {/* 移动端唯一那条顶栏：菜单 + 当前助手 + 配置。
              之前它上面还叠着全局的「Agent Studio」条（fixed 56 + 这条 52），
              中间大片空白，像没做完 —— 现在对话页不出全局那条，只剩这一条。 */}
          {/* absolute 而不是 relative：顶栏要浮在消息流之上，滚动时正文才从它
              下面穿过 —— 毛玻璃得有东西可透才叫毛玻璃，纯色背景上做 blur 是白做。 */}
          <header
            className="absolute top-0 inset-x-0 z-20 h-[calc(44px+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] pl-1 pr-1.5 flex items-center gap-1 border-b border-[var(--color-border)] lg:hidden"
          >
            {/* 毛玻璃单独一层（同 Nav）：挂在 header 自身会让里面的
                position:fixed 面板相对 header 定位，助手选择面板会飞出屏幕。 */}
            <div
              aria-hidden="true"
              className="absolute inset-0 -z-10"
              style={{
                background: "color-mix(in srgb, var(--color-bg) 70%, transparent)",
                backdropFilter: "blur(20px) saturate(1.8)",
                WebkitBackdropFilter: "blur(20px) saturate(1.8)",
              }}
            />
            <button
              data-tap
              className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] active:bg-[var(--color-surface-2)]"
              title="对话列表"
              onClick={() => {
                setNavView("sessions");
                setMobileNav(true);
              }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M4 6h16M4 12h16M4 18h10" />
              </svg>
            </button>

            {/* 助手身份：任何时候都是下拉（受外层控制时外层只给初始值） */}
            {(
              <AgentSwitcher
                variant="bar"
                className="flex-1"
                agents={agents}
                value={agentId}
                onChange={setAgentId}
                busy={busy}
                open={switcherOpen === "bar"}
                onOpenChange={(v) => setSwitcherOpen(v ? "bar" : null)}
              />
            )}

            <div className="ml-auto flex items-center gap-0.5 shrink-0">
              {/* 每条助手消息自己带「执行过程 / 完整记录」—— 顶栏再放一个
                  「本轮详情」就是同一件事的第二道门（用户反馈过：同一条
                  信息别两处给），所以这里只留「配置」。
                  用齿轮而不是「配置」两个字的按钮：一个字块在同一行里比
                  名字还重，会把这行顶成「左边身份、右边一个按钮」的割裂感；
                  齿轮是通用认知，且图标按钮比文字按钮矮一号。 */}
              {agentId && (
                <button
                  data-tap
                  className="w-9 h-9 shrink-0 flex items-center justify-center rounded-lg text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] active:bg-[var(--color-surface-2)]"
                  title="助手配置"
                  aria-label="助手配置"
                  onClick={() => setConfigAgent(agentId)}
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </button>
              )}
            </div>
          </header>

          {/* 会话身份条 —— 只在**派活会话**上出现，说的都是事实：这是哪件活的会话、
              能回到 Router。Router 会话本身不再挂一句「它派活你只跟它说话」——
              这种话应该在跑的时候由它自己讲，不是印在页面上。 */}
          {curKind === "worker" && (
            <div
              className={`shrink-0 flex items-center gap-2 px-3 h-7 text-[12px] max-lg:mt-[calc(44px+env(safe-area-inset-top))] max-lg:h-[44px] ${curKind === "worker" ? "max-lg:cursor-pointer" : ""}`}
              style={{
                background: `color-mix(in srgb, ${agentColor(curAgentId)} 9%, var(--color-surface))`,
                color: agentColor(curAgentId),
                borderBottom: `1px solid color-mix(in srgb, ${agentColor(curAgentId)} 22%, transparent)`,
              }}
              data-session-kind={curKind}
              onClick={
                curKind === "worker"
                  ? async () => {
                      // 手机上整条身份条就是"回 Router"的按钮 —— 30px 高的小药丸点不中
                      try {
                        // 回到"派我出来的那条对话"（票的父会话），而不是另造一个常驻入口
                        if (curParent) pickSession(curParent);
                      } catch {
                        /* 拿不到就算了 */
                      }
                    }
                  : undefined
              }
            >
              <span
                className="shrink-0 rounded-full"
                style={{ width: 6, height: 6, background: agentColor(curAgentId) }}
                aria-hidden="true"
              />
              <span className="min-w-0 truncate">
                派活会话{curTicket ? ` · 票「${curTicket}」` : ""}
              </span>
              {curKind === "worker" && curParent && (
              <button
                className="ml-auto shrink-0 px-2 h-6 rounded-md text-[11.5px] max-lg:hidden"
                style={{ background: "color-mix(in srgb, currentColor 12%, transparent)", color: "inherit" }}
                data-tap
                onClick={async () => {
                  try {
                    if (curParent) pickSession(curParent);
                  } catch {
                    /* 拿不到就算了：不打断正在看的对话 */
                  }
                }}
              >
                回到 Router
              </button>
              )}
            </div>
          )}

          {/* ── 会话顶栏（lg+）：标题就地改名 + 置顶/导出/更多 ─────────────
              和画布同底色、平时刻意不画分隔线；只有滚动后才出现 1px 极淡边。 */}
          <div
            className="relative hidden h-11 shrink-0 items-center gap-1 px-3 lg:flex"
            style={{
              background: "var(--color-bg)",
              borderBottom: `1px solid ${topScrolled ? "color-mix(in srgb, var(--color-border) 70%, transparent)" : "transparent"}`,
              transition: "border-color var(--dur-1) var(--ease)",
            }}
          >
            {headerEditing ? (
              <input
                autoFocus
                value={headerDraft}
                onChange={(e) => setHeaderDraft(e.target.value)}
                onBlur={() => setHeaderEditing(false)}
                onKeyDown={(e) => {
                  // 组字中的 Enter 是选字：中文没上屏就回车会把半截拼音当标题提交
                  if (isImeEvent(e)) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    setHeaderEditing(false);
                    const t = headerDraft.trim();
                    if (curSes && t && t !== curSes.title) void renameSessionInline(curSes, t);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setHeaderEditing(false);
                  }
                }}
                className="min-w-0 flex-1 rounded-[var(--radius-xs)] border px-1.5 py-0.5 text-[length:var(--fs-base)] outline-none"
                style={{
                  borderColor: "var(--color-accent)",
                  background: "var(--color-surface)",
                  color: "var(--color-text)",
                }}
              />
            ) : (
              <button
                type="button"
                data-tap
                title="点一下改名"
                onClick={() => {
                  setHeaderDraft(curSes?.title || "");
                  setHeaderEditing(true);
                }}
                className="min-w-0 flex-1 truncate rounded-[var(--radius-xs)] px-1.5 py-1 text-left text-[length:var(--fs-base)] hover:bg-[var(--bg-selected)]"
                style={{ color: "var(--color-text)", fontWeight: 500 }}
              >
                {curSes?.title || (sessionId ? "未命名对话" : "新对话")}
              </button>
            )}

            <IconBtn
              label="目录"
              onClick={() => openDock("outline")}
              path="M4 6h12M4 12h12M4 18h12M20 6h.01M20 12h.01M20 18h.01"
            />
            <IconBtn
              label={curSes && pinned.has(curSes.id) ? "取消置顶" : "置顶"}
              onClick={() => curSes && togglePin(curSes.id)}
              active={!!curSes && pinned.has(curSes.id)}
              path="M12 17v5M6 4h12l-2 6 3 3v2H5v-2l3-3-2-6z"
            />
            <IconBtn
              label="导出"
              onClick={() => curSes && void exportSession(curSes)}
              path="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
            />
            <IconBtn
              label="更多"
              onClick={() => setHeaderMenu((v) => !v)}
              path="M5 12h.01M12 12h.01M19 12h.01"
            />

            {headerMenu && curSes && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setHeaderMenu(false)} />
                <div
                  className="absolute right-2 top-10 z-50 w-[132px] rounded-[var(--radius-md)] py-1"
                  role="menu"
                  style={{
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    boxShadow: "var(--shadow-2)",
                  }}
                >
                  <MenuItem
                    label="重命名"
                    onClick={() => {
                      setHeaderMenu(false);
                      setHeaderDraft(curSes.title || "");
                      setHeaderEditing(true);
                    }}
                  />
                  <MenuItem
                    label="导出 Markdown"
                    onClick={() => {
                      setHeaderMenu(false);
                      void exportSession(curSes, "md");
                    }}
                  />
                  <MenuItem
                    label="导出 JSON"
                    onClick={() => {
                      setHeaderMenu(false);
                      void exportSession(curSes, "json");
                    }}
                  />
                  <div className="my-1 h-px" style={{ background: "var(--color-border)" }} />
                  <MenuItem
                    label="删除"
                    danger
                    onClick={() => {
                      setHeaderMenu(false);
                      void deleteSessionNow(curSes);
                    }}
                  />
                </div>
              </>
            )}
          </div>

          {/* 消息流 —— 阅读宽度封顶 768px 居中：一行扫 1000px 是眼睛的负担 */}
          <div className="relative flex-1 min-h-0 flex flex-col">
            {/* 刻度轨：大纲的缩略视图。只有 1 个提问时不出现（一条刻度没有信息量），
                40 条以上等距抽样 —— 刻度是「在哪」，不是「全部」。 */}
            {outline.length > 1 && (
              <nav
                aria-label="会话目录刻度"
                className="pointer-events-none absolute inset-y-0 right-1 z-10 hidden w-4 flex-col items-end justify-center gap-[3px] py-6 xl:flex"
              >
                {(() => {
                  const max = 40;
                  const step = Math.max(1, Math.ceil(outline.length / max));
                  const ticks = outline.filter((_, i) => i % step === 0);
                  const activeSeq = activeTurn ?? ticks[0]?.seq;
                  return ticks.map((it) => {
                    const active = it.seq === activeSeq;
                    return (
                      <button
                        key={it.turn_id}
                        type="button"
                        data-tap
                        aria-label={`第 ${it.seq} 个问题：${it.digest}`}
                        title={it.digest}
                        onClick={() => jumpTurn(it.seq)}
                        className="pointer-events-auto rounded-full transition-all"
                        style={{
                          width: active ? 12 : 7,
                          height: 2,
                          background: active ? "var(--color-accent)" : "color-mix(in srgb, var(--color-text) 22%, transparent)",
                          transitionDuration: "var(--dur-1)",
                        }}
                      />
                    );
                  });
                })()}
              </nav>
            )}
          <div
            className="flex-1 overflow-auto max-lg:pt-[calc(44px+env(safe-area-inset-top))]"
            ref={boxRef}
            onScroll={onScroll}
            style={{ paddingBottom: dockH + 14 }}
            data-msg-scroll
          >
            {beforeTurn > 0 && (
              <div className="mx-auto mb-2 w-full max-w-[760px] px-2">
                <button
                  type="button"
                  data-tap
                  disabled={loadingOlder}
                  onClick={() => void loadOlder()}
                  className="mx-auto block rounded-full border px-3 py-1 text-[12px] hover:bg-[var(--bg-selected)] disabled:opacity-60"
                  style={{ borderColor: "var(--color-border)", color: "var(--color-text-2)" }}
                >
                  {loadingOlder ? "正在加载…" : `加载更早的消息（还有 ${beforeTurn} 轮）`}
                </button>
              </div>
            )}
            {messagesLoading && history.length === 0 ? (
              <div className="mx-auto mt-6 w-full max-w-[760px] space-y-4 px-3" aria-busy="true" aria-label="消息加载中">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="space-y-2">
                    <div className="h-3 w-1/3 rounded" style={{ background: "var(--color-surface-3)" }} />
                    <div className="h-3 w-11/12 rounded" style={{ background: "var(--color-surface-3)", opacity: 0.8 - i * 0.15 }} />
                    <div className="h-3 w-4/5 rounded" style={{ background: "var(--color-surface-3)", opacity: 0.65 - i * 0.15 }} />
                  </div>
                ))}
              </div>
            ) : history.length === 0 && !live ? (
              /* 空状态：不摆「开始对话」的废话 —— 直接给 3 个可点的开场问题，
                 点了就填进输入框（不自动发，让人改得动）。 */
              <div className="max-w-md mx-auto mt-16 px-6">
                <div className="text-center">
                  <div
                    className="inline-flex items-center justify-center w-9 h-9 rounded-2xl text-[19px] mb-3"
                    style={{ background: "var(--color-surface-2)" }}
                  >
                    ✦
                  </div>
                  <p className="text-[15px] font-medium">{currentAgent?.name || "Agent"}</p>
                  {agents.length > 1 && (
                    <button
                      data-tap
                      onClick={() =>
                        setSwitcherOpen(
                          window.innerWidth < 1024 ? "bar" : navOpen ? "sidebar" : "mini",
                        )
                      }
                      className="mt-1 inline-flex items-center gap-1 text-[12px] rounded-md px-2 h-7 hover:bg-[var(--color-surface-2)]"
                      style={{ color: "var(--color-accent)" }}
                    >
                      换一个助手
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>
                  )}
                  {currentAgent?.description && (
                    <p className="text-[12.5px] text-[var(--color-muted)] mt-1.5 leading-relaxed">
                      {currentAgent.description}
                    </p>
                  )}
                </div>
                {/* 开场建议：主流对话的做法是给"能直接点的事"，不是一堆空提示。
                    点了只填进输入框（不自动发），人还能改。 */}
                <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {[
                    {
                      icon: (
                        <>
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <path d="M14 2v6h6" />
                        </>
                      ),
                      q: "分析一个文件或一段数据",
                      hint: "看目录里的东西，给结论",
                    },
                    {
                      icon: (
                        <>
                          <circle cx="11" cy="11" r="7" />
                          <path d="m20 20-3.5-3.5" />
                        </>
                      ),
                      q: "上网查点资料并总结给我",
                      hint: "搜索、读页面、说重点",
                    },
                    {
                      icon: (
                        <>
                          <path d="m8 6-5 6 5 6" />
                          <path d="m16 6 5 6-5 6" />
                        </>
                      ),
                      q: "写一段代码或脚本",
                      hint: "写完直接跑一遍验证",
                    },
                    {
                      icon: (
                        <>
                          <path d="M4 5h16" />
                          <path d="M4 12h16" />
                          <path d="M4 19h10" />
                        </>
                      ),
                      q: "把这件活整理成一份文档",
                      hint: "输出 Markdown 或表格",
                    },
                  ].map((it) => (
                    <button
                      key={it.q}
                      data-tap
                      className="group text-left rounded-xl px-3 py-2.5 border transition-colors hover:bg-[var(--color-surface-2)] flex items-start gap-2.5"
                      style={{ borderColor: "var(--color-border)", color: "var(--color-text)" }}
                      onClick={() => {
                        setInput(it.q);
                        (document.querySelector("section textarea") as HTMLTextAreaElement | null)?.focus();
                      }}
                    >
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0 mt-0.5"
                        style={{ color: "var(--color-muted)" }}
                        aria-hidden="true"
                      >
                        {it.icon}
                      </svg>
                      <span className="min-w-0">
                        <span className="block text-[13px] leading-snug">{it.q}</span>
                        <span className="block text-[11.5px] mt-0.5" style={{ color: "var(--color-muted)" }}>
                          {it.hint}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div
              key={sessionId || "empty"}
              className="msg-stream session-enter max-w-[760px] mx-auto px-4 sm:px-5 py-6 space-y-5"
            >
                {history.map((m, i) => {
                  // 平台自己的提示（心跳/系统事件）：一行居中的灰字，不占气泡
                  if (m.role === "system") {
                    return (
                      <div
                        key={m.id ?? `sys-${i}`}
                        className="flex justify-center px-2 text-[11.5px] leading-[1.6]"
                        style={{ color: "var(--color-muted)" }}
                      >
                        <span
                          className="max-w-[42rem] rounded-md px-2 py-1 text-center"
                          style={{ background: "var(--color-surface-2)" }}
                        >
                          {m.content}
                        </span>
                      </div>
                    );
                  }
                  // 给助手的执行过程带上「用户说了什么」，这样六段里第一段（输入）有着落
                  const prevUser =
                    m.role === "assistant"
                      ? ([...history.slice(0, i)].reverse().find((x) => x.role === "user")?.content ?? undefined)
                      : undefined;
                  const bubble = (
                    <Bubble
                      role={m.role}
                      content={m.content}
                      pinnedActions={i === lastAssistantIdx || i === lastUserIdx}
                      runId={m.run_id}
                      userInput={prevUser}
                      ts={m.ts}
                      messageId={m.id}
                      sessionId={sessionId}
                      onEdited={(content2) =>
                        setHistory((h) => h.map((x, j) => (j === i ? { ...x, content: content2 } : x)))
                      }
                      onRetry={m.role === "user" && !busy ? () => void send(m.content) : undefined}
                      onRewind={
                        m.role === "user" && m.turn_index && !busy
                          ? () => void rewindTo(m.turn_index!, m.content)
                          : undefined
                      }
                      onRerun={
                        m.role === "user" && m.turn_index && !busy
                          ? (text) => void rerunWith(m.turn_index!, text)
                          : undefined
                      }
                      onBranch={
                        m.role === "user" && m.turn_index && !busy
                          ? () => void branchFrom(m.turn_index!)
                          : undefined
                      }
                      onRetryReply={
                        m.role === "assistant" && !busy && prevUser
                          ? () => void send(prevUser)
                          : undefined
                      }
                      onOpenDock={(rid) => {
                        setDockStepRun(rid);
                        openDock("steps");
                      }}
                      onMakeDoc={
                        m.role === "assistant"
                          ? () =>
                              appendToInput(
                                "把上面这轮整理成一份 Markdown 文档，存到会话目录的 product/ 下",
                              )
                          : undefined
                      }
                    />
                  );
                  return m.role === "assistant" && m.run_id ? (
                    // 顺序即心智：先看它拆给谁、各自干到哪，最后才是结论。
                    // 反过来的话，用户先读到"都办好了"，过程只能往回找。
                    <div key={m.id ?? i} data-turn={m.turn_index || undefined} className="space-y-2">
                      <div className="max-w-[70%] max-md:max-w-[86%]">
                        <DelegationBlock runId={m.run_id} />
                      </div>
                      {bubble}
                      {/* 引用标识：这条回答读过哪些网页（只认工具真返回过的链接） */}
                      <SourceBadge runId={m.run_id} count={m.sources_count ?? 0} />
                    </div>
                  ) : (
                    <div key={m.id ?? i} data-turn={m.turn_index || undefined}>
                      {bubble}
                    </div>
                  );
                })}

                {/* 生成中：实时分色显示执行过程（思考 / 工具 / 结果 / 回答） */}
                {/* 浏览器卡只在**这一轮还在跑**的时候浮在流里；跑完它就收进那一轮的
                    执行过程（点开过程能看到每一步和当时的画面），不再单独悬在回复后面。 */}
                {busy && (browserFrame || browserActions.length > 0 || browserSteps.length > 0) && (
                  <BrowserStage
                    variant="inline"
                    frame={browserFrame}
                    actions={browserActions}
                    busy={busy}
                    waiting={browserWaiting}
                    onOpen={() => {
                      // 宽屏：右栏就是它的位置（对话不被遮）；窄屏没有右栏，仍用浮层
                      if (typeof window !== "undefined" && window.innerWidth >= 1280) {
                        openDock("browser");
                      } else {
                        setBrowserOpen(true);
                      }
                    }}
                    steps={browserSteps}
                  />
                )}
                {/* 生成中：只给一条**收起**的过程条 + 下面正常流的回答。
                    想看它每一步在干嘛，点开这一行（默认不摊开，
                    否则一屏全是"思考/调用工具"，结果反而被挤到看不见）。 */}
                {busy && (
                  <div className="w-full max-w-[88%] max-md:max-w-[90%] space-y-2">
                    <ProcessBar
                      steps={liveSteps}
                      running
                      elapsedMs={liveElapsed}
                      detail={
                        liveRunId ? (
                          <button
                            data-tap
                            onClick={() => {
                              setDockStepRun(liveRunId);
                              openDock("steps");
                            }}
                            className="text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
                          >
                            在右栏看 →
                          </button>
                        ) : null
                      }
                    />
                    {/* Router 把活派出去之后，最要紧的是"派给谁、干到哪了" ——
                        以前这一屏什么都没有，用户只能等一条最终答复。 */}
                    {liveRunId && <DelegationBlock runId={liveRunId} live />}
                  </div>
                )}
                {/* 流式回答：过程条在上面（它现在在干嘛），结果在下面实时长出来。
                    过程默认收起，所以"只看结果"成立；要看细节点那一行。 */}
                {live?.role === "assistant" && (
                  <Bubble role="assistant" content={live.text} streaming />
                )}
                {/* 追问建议：放在最新回复下面（最多 3 个，来自设置里的常用句），
                    点一下填进输入框 —— 输入区上方不再常驻一排胶囊。 */}
                {!busy && !live && history.length > 0 && (
                  <div className="pt-1">
                    <QuickTags onPick={appendToInput} />
                  </div>
                )}
              </div>
            )}
            <div ref={endRef} />
          </div>
            {/* 离开底部才出现：圆按钮贴在输入坞上方右侧，点一下回到最新 */}
            {!atBottom && (
              <button
                type="button"
                data-tap
                onClick={jumpLatest}
                title="回到最新"
                className="fab-in absolute right-3 lg:right-5 inline-flex items-center gap-1.5 rounded-full pl-2.5 pr-3 h-8 text-[12px] shadow-md z-10"
                style={{
                  // 输入坞现在是浮起来的，这个按钮要跟着抬到它上面
                  bottom: dockH + 12,
                  background: "color-mix(in srgb, var(--color-surface) 88%, transparent)",
                  backdropFilter: "blur(8px)",
                  WebkitBackdropFilter: "blur(8px)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text)",
                }}
              >
                {busy && (
                  <span
                    className="live-dot"
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: 999,
                      background: "var(--color-accent)",
                      display: "inline-block",
                    }}
                  />
                )}
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 5v14" />
                  <path d="m19 12-7 7-7-7" />
                </svg>
                最新
              </button>
            )}
          </div>

          {/* ── 输入区 ──────────────────────────────────────────
              一个圆角输入坞包住「附件 / 输入 / 发送」—— 它们是同一件事的
              三个部分，不该是三个漂浮的控件。存储路径这类自证信息收进
              底部 ⓘ（原来每次输入都在下面排两行服务器路径，是开发者噪声）。 */}
          <div
            ref={dockRef}
            data-dock
            className="absolute inset-x-0 bottom-0 z-20 px-3 sm:px-4 pt-0.5 pb-2.5 max-md:pb-[calc(10px+env(safe-area-inset-bottom))]"
            style={{
              background: "color-mix(in srgb, var(--color-bg) 34%, transparent)",
              backdropFilter: "blur(24px) saturate(2.1)",
              WebkitBackdropFilter: "blur(24px) saturate(2.1)",
              borderTop: "1px solid color-mix(in srgb, var(--color-border) 45%, transparent)",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,.55), 0 -18px 44px -24px rgba(15,23,42,.42)",
            }}
          >
            {/* 上沿渐隐：消息滚进来时是淡进玻璃，而不是被一条硬边切断 */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 -top-10 h-10"
              style={{
                background:
                  "linear-gradient(to top, color-mix(in srgb, var(--color-bg) 34%, transparent), transparent)",
              }}
            />
            {hitl && (
              <div className="mx-auto mb-3 max-w-[760px]">
                <HitlPrompt
                  key={hitlKey}
                  runId={hitl.runId}
                  payload={hitl.payload}
                  onBeforeResume={() => attachStream(hitl.runId, liveInput)}
                  onResumed={() => setBusy(true)}
                  onError={(m) => fb.error("恢复失败", m)}
                  permissionHref={
                    agentId ? `/agents/detail?id=${agentId}&focus=permission` : undefined
                  }
                />
              </div>
            )}

            {failed && (
              <div
                className="max-w-[760px] mx-auto mb-2 rounded-xl px-3 py-2 flex items-start gap-3 flex-wrap text-[12.5px]"
                style={{
                  background: "color-mix(in srgb, var(--color-err) 10%, transparent)",
                  color: "var(--color-err)",
                }}
              >
                <span className="flex-1 min-w-[200px] break-words">
                  {/* 超时不是「模型答错了」：话已经说全了（"执行超时：这一轮超过 8 秒…"），
                      别再套一层"这一轮没跑完"，不然一句话里两个"这一轮" */}
                  {/超时/.test(failed.message) ? failed.message : `这一轮失败了：${failed.message}`}
                </span>
                <button className="btn btn-sm shrink-0" disabled={busy} onClick={() => void send(failed.text)}>
                  {/超时/.test(failed.message) ? "继续" : "重试"}
                </button>
                <button
                  className="shrink-0 rounded px-1 text-[12px] hover:underline max-md:min-h-[32px] max-md:px-2"
                  onClick={() => setFailed(null)}
                >
                  忽略
                </button>
              </div>
            )}

            {pendingFiles.length > 0 && (
              <div className="max-w-[760px] mx-auto mb-2 flex flex-wrap gap-2">
                {pendingFiles.map((f, i) => (
                  <div
                    key={f.path + i}
                    className="relative rounded-lg border overflow-hidden"
                    style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
                  >
                    {f.kind === "image" ? (
                      <a href={f.url} target="_blank" rel="noreferrer" className="block">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={f.url} alt={f.name} className="w-12 h-12 object-cover" />
                      </a>
                    ) : (
                      <div className="flex items-center gap-2 pl-2.5 pr-9 py-1.5 max-w-[240px]">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--color-muted)]" aria-hidden="true">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <path d="M14 2v6h6" />
                        </svg>
                        <span className="min-w-0">
                          <span className="block truncate text-[12px] leading-tight">{f.name}</span>
                          <span className="block text-[10.5px] leading-tight text-[var(--color-muted)]">
                            {fmt.bytes(f.size)}
                          </span>
                        </span>
                      </div>
                    )}
                    <button
                      data-tap
                      className="absolute top-0.5 right-0.5 flex h-5 w-5 items-center justify-center rounded-full text-[11px] hover:brightness-110"
                      style={{ background: "rgba(0,0,0,0.45)", color: "var(--color-accent-fg)" }}
                      title="撤掉"
                      onClick={() => setPendingFiles((p) => p.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* ── 后台任务（跑得住比一轮更久的活）────────────────────
                助手用 proc_start 起的进程挂在这个会话上：关页面、run 结束都不影响。
                没有任务时整条不渲染；有的话显示谁在跑、跑了多久、完事没有。 */}
            {/* ── 定时（这个对话按时自己跑）────────────────────────
                没有任务时只有输入框下面那个「定时」按钮；有任务时多这一条。 */}
            {sessionId && (
              <SessionJobs
                sessionId={sessionId}
                open={jobOpen}
                onOpenChange={setJobOpen}
                onCount={setJobCount}
                draft={input}
              />
            )}

            {sessionId && <TodoStrip sessionId={sessionId} busy={busy} refreshKey={todoTick} />}

            {sessionId && <BgProcsStrip sessionId={sessionId} busy={busy} />}

            {/* ── 本会话的文件 ───────────────────────────────────────
                有文件才出现（0 个文件时这一条只剩一个谁都看不懂的
                `…/sessions/ses_xxx/`，白白吃掉输入区 46px）；手机上也不显示路径，
                只显示「4 个文件」，点开才看清单 —— 手机屏宽 390，路径在这里
                是纯技术噪音，复制路径也挪进弹层。桌面保留路径（有地方放）。 */}
            {/* 展开时才是「面板」，收起时只剩快捷标签行最左边那个「N 个文件」
                chip —— 这一条不再自己占一行。 */}
            {sessionId && fileCount > 0 && openFiles && (
              <Sheet
                open
                onClose={() => setFilesOpenPref(false)}
                title="这个会话的文件"
                hint={
                  managing
                    ? `已选 ${picked.length} / ${fileCount}`
                    : `${fileCount} 个 · ${fmt.bytes(
                        (sessionFiles?.files ?? []).reduce((a, f) => a + (f.size || 0), 0),
                      )}`
                }
                extra={
                  <span className="flex items-center gap-0.5">
                    <button
                      type="button"
                      className="w-8 h-8 grid place-items-center rounded-lg hover:bg-[var(--color-surface-2)] disabled:opacity-50"
                      style={{ color: "var(--color-muted)" }}
                      onClick={() => void loadSessionFiles()}
                      disabled={filesBusy}
                      aria-label="刷新文件清单"
                      title="重新读一遍这个会话目录"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.9"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        style={filesBusy ? { animation: "spin 1s linear infinite" } : undefined}
                      >
                        <path d="M21 12a9 9 0 1 1-3-6.7" />
                        <path d="M21 3v6h-6" />
                      </svg>
                    </button>
                    {fileCount > 0 && (
                      <button
                        type="button"
                        className="h-8 px-2 rounded-lg text-[12px] hover:bg-[var(--color-surface-2)]"
                        style={{ color: managing ? "var(--color-err)" : "var(--color-accent)" }}
                        onClick={() => {
                          setManaging((v) => !v);
                          setPicked([]);
                          setBulkConfirm(false);
                        }}
                        title="勾选多个文件一起删"
                      >
                        {managing ? "完成" : "管理"}
                      </button>
                    )}
                  </span>
                }
                maxH="78vh"
                width={440}
              >
              <div
                className="px-3.5 py-2"
                style={
                  managing
                    ? { background: "color-mix(in srgb, var(--color-accent) 6%, transparent)" }
                    : undefined
                }
              >

                {/* 产物：以前挂在输入区上方占一整条，现在收进这个面板的第一行。
                    移动端没有右栏，也照样从这里进 —— 面板在手机上是贴底抽屉。 */}
                {dl?.exists && (
                  <div
                    className="mb-1 flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5"
                    style={{ background: "var(--color-surface-2)" }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                    </svg>
                    <span className="min-w-0 flex-1 truncate text-[length:var(--fs-sm)]" style={{ color: "var(--color-text)" }}>
                      产物 · {dl.file_count} 个文件
                      <span className="ml-1.5" style={{ color: "var(--color-text-3)" }}>
                        {fmt.bytes(dl.size || 0)}
                      </span>
                    </span>
                    <a
                      href={api.deliverableZipUrl(sessionId)}
                      data-tap
                      className="shrink-0 rounded px-1.5 py-0.5 text-[length:var(--fs-xs)] hover:bg-[var(--color-surface)]"
                      style={{ color: "var(--color-text-2)" }}
                    >
                      下载
                    </a>
                    <button
                      type="button"
                      data-tap
                      className="shrink-0 rounded px-1.5 py-0.5 text-[length:var(--fs-xs)] hover:bg-[var(--color-surface)]"
                      style={{ color: "var(--color-accent)" }}
                      onClick={async () => {
                        try {
                          const r = await api.publishSessionDeliverable(sessionId);
                          if (r.url) fb.success("已发布", r.url);
                          else fb.info("已发到服务器目录", `${r.dir}/${r.slug}/`);
                        } catch (e) {
                          fb.error("发布失败", e instanceof Error ? e.message : String(e));
                        }
                      }}
                    >
                      发布
                    </button>
                  </div>
                )}

                {/* 路径只在桌面上露一行，点一下复制；手机上它有 0 信息量 ——
                    要的是「有哪些文件」，路径属于排查时才看的东西。 */}
                {sessionFiles?.work_dir && (
                  <button
                    type="button"
                    className="mono block w-full truncate text-left text-[11px] py-0.5 hover:underline max-md:hidden"
                    style={{ color: "var(--color-muted)" }}
                    title={`点一下复制完整路径\n${sessionFiles.work_dir}`}
                    onClick={() =>
                      void copyText(sessionFiles.work_dir).then((ok) =>
                        ok
                          ? fb.success("已复制会话目录", sessionFiles.work_dir)
                          : fb.info("会话目录", sessionFiles.work_dir),
                      )
                    }
                  >
                    {sessionFiles.work_dir}
                  </button>
                )}

                {(sessionFiles && sessionFiles.files.length > 0 ? (
                  <>
                  {/* 查询：文件一多就靠它找。只在超过 6 个时出现 —— 少的时候摆个搜索框纯属噪音。 */}
                  {fileCount > 6 && (
                    <div className="mt-1 flex items-center gap-1.5">
                      {/* 不写死 height：手机会把 12px 的字撑成 30px 高的小方块，
                          iOS 还会因为字号 <16px 聚焦放大整页。交给 .input 自己按断点收。 */}
                      <input
                        className="input input-inline flex-1 text-[13px]"
                        value={fileQuery}
                        onChange={(e) => setFileQuery(e.target.value)}
                        placeholder="按文件名找（输入就过滤）"
                        aria-label="在本会话文件里查找"
                      />
                      {fileQuery ? (
                        <button
                          type="button"
                          className="btn shrink-0 px-2 py-0.5 text-[12px] max-md:min-h-[32px]"
                          onClick={() => setFileQuery("")}
                        >
                          清空
                        </button>
                      ) : null}
                      <span className="shrink-0 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                        {shownFiles.length}/{fileCount}
                      </span>
                    </div>
                  )}
                  {/* 文件全列出来（以前只摆 6 个、剩下写成"还有 N 个…"点不到 —— 等于没给）。
                      高度封在 40vh 并允许滚动：文件再多也不会把输入坞顶到屏幕外。 */}
                  {/* 一行一个文件，铺满宽度：胶囊流会让右侧空一大片、名字还被
                      截成一样长，扫起来得来回找。列表是文件该有的样子。 */}
                  {/* 管理态的动作条：放在列表**上面**，文件再多也不会被滚走 */}
                  {managing && (
                    <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[12px]">
                      {/* 「已选 N」已经在标题那一行写着，这里不重复 */}
                      <span className="text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                        点文件勾选，可多选
                      </span>
                      <button
                        type="button"
                        className="btn px-2 py-0.5 text-[12px] max-md:min-h-[32px]"
                        onClick={() => setPicked(shownFiles.map((f) => f.path))}
                      >
                        全选
                      </button>
                      <button
                        type="button"
                        className="btn px-2 py-0.5 text-[12px] max-md:min-h-[32px]"
                        disabled={bulkBusy}
                        style={{
                          color: bulkConfirm ? "var(--color-accent-contrast)" : "var(--color-err)",
                          background: bulkConfirm ? "var(--color-err)" : "transparent",
                          borderColor: "var(--color-err)",
                        }}
                        onClick={() => {
                          if (picked.length === 0) return;
                          if (!bulkConfirm) {
                            setBulkConfirm(true);
                            return;
                          }
                          void bulkDelete();
                        }}
                      >
                        {bulkBusy
                          ? "删除中…"
                          : bulkConfirm
                            ? `确认删除 ${picked.length} 个（不可撤销）`
                            : `删除选中${picked.length ? `（${picked.length}）` : ""}`}
                      </button>
                    </div>
                  )}
                  <div className="flex max-h-[46vh] flex-col overflow-y-auto pb-0.5">
                    {shownFiles.map((f) =>
                      managing ? (
                        /* 管理态：点一下是勾选（不是打开预览）—— 这时的目的就是删 */
                        <button
                          key={f.path}
                          type="button"
                          onClick={() => togglePick(f.path)}
                          aria-pressed={picked.includes(f.path)}
                          className="w-full flex items-center gap-2.5 rounded-lg px-2 py-2.5 text-left text-[12.5px] transition-colors"
                          style={{
                            background: picked.includes(f.path)
                              ? "color-mix(in srgb, var(--color-accent) 10%, transparent)"
                              : undefined,
                            color: "var(--color-text)",
                          }}
                        >
                          <span
                            aria-hidden
                            className="inline-flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[3px] border"
                            style={{
                              borderColor: picked.includes(f.path) ? "var(--color-accent)" : "var(--color-border)",
                              background: picked.includes(f.path) ? "var(--color-accent)" : "transparent",
                            }}
                          >
                            {picked.includes(f.path) ? (
                              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-contrast)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                <path d="M20 6 9 17l-5-5" />
                              </svg>
                            ) : null}
                          </span>
                          <span className="mono" title={f.path}>
                            {shortFilePath(f.path)}
                          </span>
                          <span style={{ color: "var(--color-muted)" }}>{fmt.bytes(f.size)}</span>
                        </button>
                      ) : (
                        <FileRowButton
                          key={f.path}
                          file={{ path: `${sessionFiles.work_dir}/${f.path}`, url: f.url, size: f.size, mtime: f.mtime }}
                          className="w-full flex items-center gap-2.5 rounded-lg px-2 py-2.5 text-left hover:bg-[var(--color-surface-2)] transition-colors"
                          style={{ color: "var(--color-text)" }}
                          onOpen={() => setFilesOpenPref(false)}
                        >
                          <FileTypeIcon kind={fileTypeKey(f.path)} size={15} className="shrink-0 opacity-60" />
                          <span className="mono flex-1 min-w-0 truncate text-[12.5px]" title={f.path}>
                            {shortFilePath(f.path)}
                          </span>
                          <span className="shrink-0 tabular-nums text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                            {fmt.bytes(f.size)}
                          </span>
                        </FileRowButton>
                      ),
                    )}
                    {shownFiles.length === 0 && fileQuery ? (
                      <span className="inline-flex items-center px-1 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                        没有匹配「{fileQuery}」的文件
                      </span>
                    ) : null}
                  </div>
                  </>
                ) : (
                  <div className="mt-0.5 text-[11px]" style={{ color: "var(--color-muted)" }}>
                    还没有文件 —— 这个会话生成的文档都会存在上面的目录里
                  </div>
                ))}
              </div>
              </Sheet>
            )}

            <div className="max-w-[760px] mx-auto relative">
              {/* 认不出来时的候选条：这句话留在手里，点谁就用谁发（不再猜第二遍） */}
              {routeAsk && (
                <div
                  className="mb-2 rounded-[14px] border px-3 py-2"
                  style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px]" style={{ color: "var(--color-muted)" }}>
                      这句该交给谁？
                    </span>
                    {(routeAsk.multi.length >= 2 ? routeAsk.multi : routeAsk.options).map((o) => (
                      <button
                        key={o.agent_id}
                        data-tap
                        type="button"
                        className="btn h-[32px] px-3 text-[12.5px] max-md:h-[44px]"
                        onClick={() => void runAuto(routeAsk.text, o.agent_id)}
                      >
                        {o.name}
                      </button>
                    ))}
                    <button
                      data-tap
                      type="button"
                      className="h-[32px] px-2 text-[12.5px] max-md:h-[44px]"
                      style={{ color: "var(--color-muted)" }}
                      onClick={() => {
                        setInput(routeAsk.text);
                        setRouteAsk(null);
                      }}
                    >
                      取消
                    </button>
                  </div>
                  <div className="mt-1 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                    {routeAsk.reason}
                  </div>
                </div>
              )}

              {/* 刚交给谁 —— 常驻一行，不用翻日志才知道这句话去哪了 */}
              {routeNote && !routeAsk && (
                <div
                  className="mb-1.5 flex items-center gap-1.5 px-3 text-[11.5px]"
                  style={{ color: "var(--color-muted)" }}
                >
                  <span style={{ color: "var(--color-accent)" }}>↳</span>
                  <span>
                    交给 <b style={{ color: "var(--color-text)" }}>{routeNote.name}</b>
                    {routeNote.switched ? "（已切到它的对话）" : ""}
                  </span>
                  <span className="truncate" title={routeNote.reason}>
                    {routeNote.reason}
                  </span>
                  {routeNote.href && (
                    <a
                      href={routeNote.href}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 underline"
                      style={{ color: "var(--color-accent)" }}
                    >
                      看编排
                    </a>
                  )}
                </div>
              )}

              {/* ── 输入坞 ────────────────────────────────────────
                  上下结构（上=正文，下=工具栏），不再左右平铺：多行输入时
                  按钮不会跟着文字跳。发送键用图标表达状态 —— 空闲是圆箭头、
                  执行中是方块，同一个位置形状变化，不用读字。
                  三条投喂路径统一走 addFiles：点附件 / 粘贴截图 / 拖文件进来。 */}
              <div
                data-composer
                data-paused={paused ? "1" : "0"}
                className="composer-focus rounded-[var(--radius-2xl)] border"
                style={{
                  borderColor: paused
                    ? "color-mix(in srgb, var(--color-warn) 55%, transparent)"
                    : dragging
                      ? "var(--color-accent)"
                      : "color-mix(in srgb, var(--color-text) 9%, transparent)",
                  background: paused
                    ? "color-mix(in srgb, var(--color-surface-2) 70%, transparent)"
                    : "color-mix(in srgb, var(--color-surface) 40%, transparent)",
                  backdropFilter: "blur(22px) saturate(1.9)",
                  WebkitBackdropFilter: "blur(22px) saturate(1.9)",
                  boxShadow: dragging
                    ? "inset 0 1px 0 rgba(255,255,255,.7), 0 12px 32px -8px rgba(37,99,235,.28)"
                    : "var(--shadow-2)",
                }}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes("Files")) {
                    e.preventDefault();
                    setDragging(true);
                  }
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  void addFiles(e.dataTransfer.files);
                }}
              >
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => void pickFiles(e.target.files)}
                />
                <textarea
                  ref={taRef}
                  rows={1}
                  className="block w-full resize-none bg-transparent border-0 outline-none px-4 py-3 text-[14px] leading-[24px] min-h-[56px]"
                  style={{ maxHeight: 208 }}
                  placeholder={
                    paused
                      ? "运行暂停，先处理上面的授权…"
                      : busy
                        ? "执行中 · 回车即插话"
                        : pendingFiles.length > 0
                          ? `附了 ${pendingFiles.length} 个文件，说点什么…`
                          : "说点什么…"
                  }
                  value={input}
                  disabled={paused}
                  {...ime.props}
                  onPaste={(e) => {
                    // 截图直接 Cmd/Ctrl+V —— 比先存成文件再点附件顺手得多
                    const files = [...(e.clipboardData?.files ?? [])];
                    if (files.length > 0) {
                      e.preventDefault();
                      void addFiles(files);
                    }
                  }}
                  onChange={(e) => {
                    setInput(e.target.value);
                    setSlashOpen(e.target.value.startsWith("/"));
                  }}
                  onKeyDown={(e) => {
                    // Enter 发送，但**组字中的 Enter 是输入法选字**（中文拼音没上屏
                    // 就回车会把半截拼音发出去）—— 交给输入法，不拦不发。
                    if (e.key === "Enter" && !e.shiftKey) {
                      if (ime.blocked(e)) return;
                      e.preventDefault();
                      void (busy ? steer() : send());
                    }
                  }}
                />
                {/* 运行中（busy）只留「插话 / 停止」——
                    附件、定时、技能、工具、记忆这几颗在跑的时候点了也没用，
                    留着它们会把右边两颗挤出输入框（实测 390 宽下多出约 90px，
                    320 宽更是一排顶到屏幕外）。 */}
                {/* 右边留 2px（原来 6px + 1px 边框，看着离框边还有一小截，
                    发送按钮像是浮在中间）。左边仍留 6px，回形针那侧不贴边。 */}
                <div className="flex min-w-0 items-center gap-1 pb-0 pl-1.5 pr-1 pt-0">
                  {/* 左侧工具组自己可横向滚（窄屏 320 下一排放不开），
                      右侧「插话 / 发送」永远不滚、不被挤走 */}
                  <div
                    className="flex min-w-0 items-center gap-1 overflow-x-auto"
                    style={{ scrollbarWidth: "none" }}
                  >
                  {!busy && (
                  <>
                  {/* 「+」菜单：附件、会话文件、整理成文档、整理成 Skills 全从这里进。
                      原来只有一颗回形针，另外两个动作散在追问建议里，等于没有固定入口。 */}
                  <div className="relative shrink-0">
                    <button
                      data-tap
                      type="button"
                      className="flex h-9 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 text-[length:var(--fs-sm)] disabled:opacity-40 hover:bg-[var(--bg-selected)] sm:h-8"
                      style={{ color: "var(--color-text-2)" }}
                      title="添加：附件 / 会话文件 / 整理成文档 / 整理成 Skills"
                      aria-haspopup="menu"
                      aria-expanded={plusOpen}
                      disabled={paused || uploading}
                      onClick={() => setPlusOpen((v) => !v)}
                    >
                      {uploading ? (
                        <span className="text-[13px]">…</span>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                      )}
                      <span className="hidden sm:inline">添加</span>
                    </button>

                    {plusOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setPlusOpen(false)} />
                        <div
                          className="absolute bottom-[calc(100%+6px)] left-0 z-50 w-[190px] rounded-[var(--radius-md)] py-1"
                          role="menu"
                          style={{
                            background: "var(--color-surface)",
                            border: "1px solid var(--color-border)",
                            boxShadow: "var(--shadow-2)",
                          }}
                        >
                          <MenuItem
                            label="上传附件"
                            onClick={() => {
                              setPlusOpen(false);
                              fileRef.current?.click();
                            }}
                          />
                          <MenuItem
                            label="文件 · 产物"
                            onClick={() => {
                              setPlusOpen(false);
                              toggleFiles();
                            }}
                          />
                          <div className="my-1 h-px" style={{ background: "var(--color-border)" }} />
                          <MenuItem
                            label="整理成文档"
                            onClick={() => {
                              setPlusOpen(false);
                              appendToInput("把上面这轮整理成一份 Markdown 文档，存到会话目录的 product/ 下");
                            }}
                          />
                          <MenuItem
                            label="整理成 Skills"
                            onClick={() => {
                              setPlusOpen(false);
                              appendToInput("把上面这套做法整理成一个 Skill（写 SKILL.md 到 skills/ 目录）");
                            }}
                          />
                        </div>
                      </>
                    )}
                  </div>
                  {/* 一个定时任务都没有时才摆这个入口：有了上面就有 strip，含「＋ 再排一个」 */}
                  {sessionId && jobCount === 0 && <JobButton onClick={() => setJobOpen(true)} />}

                  {/* 技能 / 记忆放这里，不放上面那排 chips：
                      chips 是「这轮对话的上下文」（文件、常说的句子），多了就得左右滑；
                      这两个是「工具」，和附件、定时同性质，待在工具栏才对。
                      状态在组件内部自持 —— 开关面板不该让消息流跟着重渲染。 */}
                  <SkillEntry agent={currentAgent} onChanged={() => void reloadAgents()} />
                  <ToolEntry agent={currentAgent} onChanged={() => void reloadAgents()} />
                  <MemoryEntry onPick={appendToInput} />
                  </>
                  )}
                  </div>
                  <span className="hidden sm:block text-[11.5px] truncate text-[var(--color-muted)]">
                    {dragging
                      ? "松手即添加为附件"
                      : busy && !paused
                        ? "助手正在执行…"
                        : ""}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    {/* 自动挑：开着的时候每句话先过路由 —— 认不出来会问，不会闷头猜。
                        选了 Router（编排者）就不出现：路由是它的本职，再让用户挑人等于把它架空。 */}
                    {!isRouterAgent && (
                    <label
                      className="flex h-8 shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 text-[length:var(--fs-sm)]"
                      style={{ color: "var(--color-text-2)" }}
                      title="这句话交给谁：当前助手 / 按内容自动挑（认不出来会问你）"
                    >
                      交给
                      <select
                        value={autoPick ? "auto" : "manual"}
                        onChange={(e) => {
                          const next = e.target.value === "auto";
                          setAutoPick(next);
                          if (!next) {
                            setRouteAsk(null);
                            setRouteNote(null);
                          }
                          try {
                            window.localStorage.setItem("studio.autoPick", next ? "1" : "0");
                          } catch {
                            /* 存不了就算了，下次默认关 */
                          }
                        }}
                        className="h-7 rounded-[var(--radius-xs)] border-0 bg-transparent pr-1 text-[length:var(--fs-sm)] outline-none"
                        style={{ color: "var(--color-text)" }}
                      >
                        <option value="manual">当前助手</option>
                        <option value="auto">自动挑</option>
                      </select>
                    </label>
                    )}
                    {false && (
                      <button
                        data-tap
                        type="button"
                        className="w-9 h-9 sm:w-8 sm:h-8 shrink-0 flex items-center justify-center rounded-xl hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
                        style={{ color: showPaths ? "var(--color-accent)" : "var(--color-muted)" }}
                        title="对话存在哪、助手在哪干活"
                        aria-expanded={showPaths}
                        onClick={() => {
                          const next = !showPaths;
                          setShowPaths(next);
                          if (next) void loadSessionFiles();
                        }}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <circle cx="12" cy="12" r="9" />
                          <path d="M12 11v5M12 8h.01" />
                        </svg>
                      </button>
                    )}
                    {busy && input.trim() ? (
                      <button
                        data-tap
                        type="button"
                        title="插话：塞进这一轮，不打断当前这一步"
                        onClick={() => void steer()}
                        className="w-9 h-9 sm:w-8 sm:h-8 shrink-0 flex items-center justify-center rounded-full"
                        style={{ background: "var(--color-accent)", color: "var(--color-accent-fg)" }}
                      >
                        {/* 气泡 + 箭头 = 把话塞进去，不打断当前这一步 */}
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 20l1.8-5.1A7.5 7.5 0 1 1 20 11.5Z" />
                          <path d="M9 11.5h6M13 9l2.5 2.5L13 14" />
                        </svg>
                      </button>
                    ) : null}
                    {busy ? (
                      <button
                        data-tap
                        type="button"
                        title="停止这一轮"
                        onClick={() => void stop()}
                        /* 不要圆形底板、不要描边 —— 就是一颗红色方块图标。
                           36×36 只是热区，hover 才浮一层淡底。 */
                        className="w-9 h-9 shrink-0 grid place-items-center rounded-full transition-colors hover:bg-[var(--color-surface-2)]"
                        style={{ color: "var(--color-err)" }}
                      >
                        <svg width="13" height="13" viewBox="0 0 12 12" aria-hidden="true">
                          <rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" />
                        </svg>
                      </button>
                    ) : (
                      <button
                        data-tap
                        type="button"
                        title={
                          paused
                            ? "运行暂停，先处理授权"
                            : input.trim() || pendingFiles.length > 0
                              ? "发送（Enter）"
                              : "写点什么再发"
                        }
                        disabled={paused || (!input.trim() && pendingFiles.length === 0)}
                        onClick={() => void send()}
                        /* 实心强调色只留给"发送"：有内容 = 蓝底白箭头；
                           空内容 = 灰底，点了也没反应。 */
                        className="w-9 h-9 shrink-0 grid place-items-center rounded-full transition-colors disabled:cursor-not-allowed"
                        style={{
                          background:
                            input.trim() || pendingFiles.length > 0
                              ? "var(--color-accent)"
                              : "var(--color-surface-2)",
                          color:
                            input.trim() || pendingFiles.length > 0
                              ? "var(--color-accent-fg)"
                              : "var(--color-text-3)",
                        }}
                      >
                        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M12 19V5" />
                          <path d="M5 12l7-7 7 7" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {slashOpen && !busy && (
                <SlashMenu
                  query={input.slice(1)}
                  items={slashItems}
                  onPick={(it) => {
                    setSlashOpen(false);
                    // 输入框里那串 `/xxx` 只是指令，别留在正文里被发出去
                    setInput("");
                    it.run();
                  }}
                  onClose={() => setSlashOpen(false)}
                />
              )}
            </div>

            <div className="max-w-[760px] mx-auto mt-1.5 flex items-center gap-3 text-[11.5px] text-[var(--color-muted)]">
              <span className="hidden sm:inline">Enter 发送 · Shift + Enter 换行 · 可直接粘贴截图</span>
            </div>

            {showPaths && paths && (
              <div
                className="max-w-[760px] mx-auto mt-1.5 rounded-lg px-2.5 py-2 text-[11.5px] flex flex-wrap items-center gap-x-2 gap-y-1"
                style={{ background: "var(--color-surface-2)", color: "var(--color-muted)" }}
              >
                <span>对话保存在</span>
                <button
                  type="button"
                  data-tap
                  className="mono hover:underline"
                  title="点一下复制完整路径"
                  onClick={() => {
                    const p = paths.database_file ?? paths.database_url;
                    void navigator.clipboard?.writeText(p).then(
                      () => fb.success("已复制路径", p),
                      () => fb.info("路径", p),
                    );
                  }}
                >
                  {paths.database_file ?? paths.database_url}
                </button>
                <span>· 助手工作目录</span>
                <span className="mono">{paths.work_dir}</span>
              </div>
            )}

            {/* 这个会话的文件已经常驻在输入坞上方，这里不再重复列一遍 */}
          </div>
        </section>

        {/* 右侧工具坞（≥1280 才渲染；更窄的屏走原来的抽屉/浮层） */}
        <SideDock
          panel={dockPanel}
          outline={outline}
          outlineLoading={outlineLoading}
          activeTurn={activeTurn}
          onJumpTurn={jumpTurn}
          stepRunId={dockStepRun || liveRunId || null}
          currentRunId={
            liveRunId ||
            (dockStepRun ?? ([...history].reverse().find((m) => m.run_id)?.run_id as string) ?? null)
          }
          onPanel={(p) => setDockPanel(p)}
          open={dockOpen}
          onOpenChange={(v) => {
            dockTouched.current = true;
            setDockOpen(v);
            saveDock(v, dockPanel, dockW);
          }}
          width={dockW}
          onWidth={(w) => {
            setDockW(w);
            saveDock(dockOpen, dockPanel, w);
          }}
          frame={browserFrame}
          actions={browserActions}
          steps={browserSteps}
          browserBusy={busy}
          browserWaiting={browserWaiting}
          browserPaused={browserPaused}
          onBrowserPause={(p) => {
            setBrowserPaused(p);
            if (liveRunId) void api.pauseBrowser(liveRunId, p).catch(() => setBrowserPaused(!p));
          }}
          onBrowserOpenFull={() => setBrowserOpen(true)}
          onUserClick={async (x, y) => sendBrowser({ kind: "click", x, y })}
          onUserText={async (text) => sendBrowser({ kind: "text", text })}
          onUserScroll={async (dy) => sendBrowser({ kind: "scroll", dy })}
          sessionId={sessionId || undefined}
          files={sessionFiles?.files ?? []}
          workDir={sessionFiles?.work_dir}
          filesBusy={filesBusy}
          onFilesRefresh={() => void loadSessionFiles()}
          hasNewFiles={fileCount > filesSeen}
          deliverable={dl}
          deliverableZipUrl={sessionId ? api.deliverableZipUrl(sessionId) : undefined}
          onPublishDeliverable={
            sessionId
              ? () => {
                  void api
                    .publishSessionDeliverable(sessionId)
                    .then((r) => {
                      if (r.url) fb.success("已发布", r.url);
                      else fb.info("已发到服务器目录", `${r.dir}/${r.slug}/`);
                    })
                    .catch((e) => fb.error("发布失败", e instanceof Error ? e.message : String(e)));
                }
              : undefined
          }
        />
      </div>

      {/* 浏览器面板 —— 桌面居中窗口，手机贴底抽屉（和文件预览同一个手感）。
          点缩略条打开；画面可点、可滚、可打字，登录要用户自己来。 */}
      {browserOpen && (
        <div className="dialog-free fixed inset-0 z-[70] flex items-end justify-center md:items-center" role="dialog" aria-modal="true" aria-label="浏览器画面">
          <div className="absolute inset-0" style={{ background: "rgba(15,23,42,0.4)" }} onClick={() => setBrowserOpen(false)} />
          <div
            className="relative flex w-full flex-col overflow-hidden rounded-t-[16px] md:max-w-[760px] md:rounded-[14px]"
            style={{
              height: "72vh",
              maxHeight: "72vh",
              border: "1px solid var(--color-border-strong)",
              background: "var(--color-surface)",
              boxShadow: "0 24px 60px rgba(15,23,42,0.28)",
            }}
          >
            <BrowserStage
              variant="panel"
              frame={browserFrame}
              actions={browserActions}
              busy={busy}
              waiting={browserWaiting}
              onUserClick={async (x, y) => sendBrowser({ kind: "click", x, y })}
              onUserText={async (text) => sendBrowser({ kind: "text", text })}
              onUserScroll={async (dy) => sendBrowser({ kind: "scroll", dy })}
              onClose={() => setBrowserOpen(false)}
              steps={browserSteps}
              onLoadSteps={() => void loadBrowserSteps()}
            />
          </div>
        </div>
      )}
    </FileOpenerProvider>
  );
}

/** 会话列表 —— 桌面在流内 / 窄屏在抽屉里，同一份实现两处渲染。
 *
 *  对标主流 Agent 对话的侧栏（ChatGPT / Claude 那一套）：
 *   · 顶部一个搜索框 —— 几十个会话时靠翻是翻不到的
 *   · 按时间分组：今天 / 昨天 / 过去 7 天 / 更早（比一排"3 天前"好扫）
 *   · 每行 hover 出一个「⋯」，改名和删除收进菜单（原来俩文字按钮一直占着，
 *     一行里三个可点目标，误删风险高）
 *   · 当前会话左侧一条竖色条 + 淡底，一眼知道在哪
 */
function SessionsPane({
  agentId,
  sessions,
  sessionId,
  onPick,
  onNew,
  onRename,
  onRemove,
  onCollapse,
  agentSlot,
  onDelete,
  onRenameCommit,
  pinned,
  onTogglePin,
  onExport,
  onExportJson,
}: {
  sessions: Session[];
  sessionId: string;
  onPick: (id: string) => void;
  onNew: () => void;
  onRename: (s: Session) => void;
  onRemove: (s: Session) => void;
  onCollapse: () => void;
  /** 直接删（不弹确认）—— 撤销窗口由列表自己管，过了 8 秒才调用它 */
  onDelete: (s: Session) => void | Promise<void>;
  /** 行内改名提交 */
  onRenameCommit: (s: Session, title: string) => void | Promise<void>;
  /** 置顶集合（与顶栏共用一份） */
  pinned: Set<string>;
  onTogglePin: (id: string) => void;
  onExport: (s: Session) => void;
  onExportJson: (s: Session) => void;
  /** 助手身份块：会话都属于某个助手，它排在列表最上面 */
  agentSlot?: React.ReactNode;
  /** 当前助手 id：工作区记忆按助手分开存 */
  agentId?: string;
}) {
  /** 树：哪些父会话展开了它派出去的 worker（当前会话是 worker 时自动展开其父） */
  const [openTree, setOpenTree] = useState<Set<string>>(() => new Set());
  const [q, setQ] = useState("");
  /** 打开菜单的会话 id（一次只开一个） */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** 对话**内容**命中的结果（标题命中在本地即时过滤，内容命中要问后端） */
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [hitBusy, setHitBusy] = useState(false);

  /* ── 阶段 2 的列表交互 ───────────────────────────────────────── */
  /** 行内改名：正在改哪一条 + 草稿 */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** 批量管理 / 分组折叠 / 撤销窗口 */
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** 只看置顶：置顶已经单独成组，这个开关用来"只看这个组" */
  const [onlyPinned, setOnlyPinned] = useState(false);
  /** 当前项目工作区（按助手记，null = 无项目纯对话） */
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [wsOpen, setWsOpen] = useState(false);
  const [wsDraft, setWsDraft] = useState("");
  /** 技能数（全局 / 该项目下的），给工作区卡片上的胶囊用 */
  const [skillRows, setSkillRows] = useState<{ name: string; source?: Record<string, unknown> }[]>([]);
  const [foldedGroups, setFoldedGroups] = useState<Set<string>>(() => new Set());
  const [undo, setUndo] = useState<{ n: number; restore: () => void } | null>(null);
  const pending = useRef(new Map<string, { s: Session; timer: ReturnType<typeof setTimeout> }>());
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const fb = useFeedback();

  useEffect(() => {
    if (!agentId) return;
    try {
      const v = window.localStorage.getItem(`studio.workspace.${agentId}`);
      setWorkspace(v || null);
    } catch {
      setWorkspace(null);
    }
  }, [agentId]);

  useEffect(() => {
    void api
      .skills()
      .then((rows) => setSkillRows(rows.map((r) => ({ name: r.name, source: r.source as Record<string, unknown> }))))
      .catch(() => setSkillRows([]));
  }, []);

  const setWorkspaceFor = (path: string | null) => {
    if (!agentId) return;
    if (path) window.localStorage.setItem(`studio.workspace.${agentId}`, path);
    else window.localStorage.removeItem(`studio.workspace.${agentId}`);
    setWorkspace(path);
    setWsOpen(false);
  };

  /** 项目内技能：来源地址落在工作区目录下的那些（口径写在卡片 tooltip 里） */
  const projectSkills = workspace
    ? skillRows.filter((r) => {
        const src = r.source ?? {};
        const addr = String(src.address ?? src.path ?? src.origin_path ?? "");
        return addr.startsWith(workspace);
      })
    : [];
  const globalSkills = workspace ? skillRows.length - projectSkills.length : skillRows.length;

  /** 复制对话：拉一次详情，按「我/助手」铺成 Markdown（粘到文档/IM 里直接能读） */
  const copyConversation = async (s: Session) => {
    try {
      const d = await api.session(s.id);
      const body = d.messages
        .filter((m) => m.content && m.content.trim())
        .map((m) => `${m.role === "user" ? "**我**" : "**助手**"}\n\n${m.content.trim()}`)
        .join("\n\n---\n\n");
      await copyText(`# ${s.ticket_title || s.title || "对话"}\n\n${body}`);
      fb.success("已复制整段对话", `${d.messages.length} 条消息`);
    } catch (e) {
      fb.error("复制失败", e instanceof Error ? e.message : String(e));
    }
  };

  const startRename = (s: Session) => {
    setDraft(s.ticket_title || s.title || "");
    setRenamingId(s.id);
    setMenuFor(null);
  };
  const commitRename = (s: Session) => {
    const t = draft.trim();
    setRenamingId(null);
    if (t && t !== (s.title || "")) void onRenameCommit(s, t);
  };

  /** 删 = 先从列表拿掉 + 给 8 秒撤销；到点才真的调接口 */
  const dropSession = (s: Session, opts?: { silent?: boolean }) => {
    setHidden((prev) => new Set(prev).add(s.id));
    const entry = pending.current.get(s.id);
    if (entry) clearTimeout(entry.timer);
    const timer = setTimeout(() => {
      pending.current.delete(s.id);
      void onDelete(s);
      setUndo((cur) => (cur && cur.n > 1 ? { ...cur, n: cur.n - 1 } : null));
    }, 8000);
    pending.current.set(s.id, { s, timer });
    setUndo((cur) => ({
      n: (cur?.n ?? 0) + 1,
      restore: () => {
        for (const [, v] of pending.current) {
          clearTimeout(v.timer);
        }
        pending.current.clear();
        setHidden(new Set());
        setUndo(null);
      },
    }));
    if (!opts?.silent) setMenuFor(null);
  };

  // 输入停下来 300ms 再搜（打一个字发一次请求既慢又抖）
  useEffect(() => {
    const kw = q.trim();
    if (kw.length < 2) {
      setHits([]);
      setHitBusy(false);
      return;
    }
    let alive = true;
    setHitBusy(true);
    const t = setTimeout(() => {
      void api
        .search(kw, { limit: 12 })
        .then((r) => {
          if (alive) setHits(r.messages);
        })
        .catch(() => {
          if (alive) setHits([]);
        })
        .finally(() => {
          if (alive) setHitBusy(false);
        });
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);

  // 当前正看的是某个 worker 的会话：把父会话自动展开，别让人找不到自己是从哪进来的
  useEffect(() => {
    const cur = sessions.find((x) => x.id === sessionId);
    const pid = cur?.kind === "worker" ? cur.parent_session_id : null;
    if (pid) setOpenTree((prev) => (prev.has(pid) ? prev : new Set(prev).add(pid)));
  }, [sessionId, sessions]);

  const kw = q.trim().toLowerCase();
  // 搜的是**列表上看见的字**：worker 会话显示的是票标题（ticket_title），
  // 只比 s.title 就等于搜 "worker-8a519538" 才找得到「下载抖音视频…」。
  const shownTitle = (s: Session) => (s.ticket_title || s.title || "未命名对话").toLowerCase();
  // 待删的（还在 8 秒撤销窗口里）先从列表拿掉；置顶的排到各分组最前
  const visible = sessions.filter((s) => !hidden.has(s.id));
  const sorted = visible.slice().sort((a, b) => {
    const pa = pinned.has(a.id) ? 1 : 0;
    const pb = pinned.has(b.id) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (b.last_active_at || 0) - (a.last_active_at || 0);
  });
  const list = kw ? sorted.filter((s) => shownTitle(s).includes(kw)) : sorted;

  // 按最近活跃分组（今天 / 昨天 / 7 天内 / 更早）
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const today = dayStart.getTime();
  // 树：worker 挂在**派出它的那个会话**下面（票的 thread_id 记的就是父会话）。
  // 1 个 Router 对 N 个 worker，这件事在列表里就该长成树，而不是两排平铺。
  const kids = new Map<string, Session[]>();
  for (const s of list) {
    if (s.kind !== "worker") continue;
    const pid = s.parent_session_id || "";
    if (pid && list.some((x) => x.id === pid)) {
      const arr = kids.get(pid) ?? [];
      arr.push(s);
      kids.set(pid, arr);
    }
  }

  const groups: { label: string; items: Session[]; kind?: "router" | "worker" }[] = [
    { label: "已置顶", items: [] },
    { label: "Router", items: [], kind: "router" },
    { label: "今天", items: [] },
    { label: "昨天", items: [] },
    { label: "过去 7 天", items: [] },
    { label: "更早", items: [] },
  ];
  for (const s of list) {
    const t = s.last_active_at || 0;
    // Router 单独归拢（它不是"聊出来的对话"）。
    // worker：能找到父会话的已经挂进树里（kids），只有孤儿才落到日期分组 ——
    // 不再单独开一个「派活 N 件」组（用户要求移除，树已经表达清楚了）。
    if (pinned.has(s.id)) groups[0].items.push(s);
    else if (s.kind === "router") groups[1].items.push(s);
    else if (s.kind === "worker" && kids.has(s.parent_session_id || "")) continue;
    else if (t >= today) groups[2].items.push(s);
    else if (t >= today - 86_400_000) groups[3].items.push(s);
    else if (t >= today - 7 * 86_400_000) groups[4].items.push(s);
    else groups[5].items.push(s);
  }


  return (
    <>
      {agentSlot && (
        <div className="px-1.5 pt-1.5 pb-1 mb-1">{agentSlot}</div>
      )}
      {/* 当前项目工作区：一句话说清"这条对话在哪个目录下干活、带了多少技能"。
          选一次记在浏览器里（按助手分开），不改变平台的数据模型。 */}
      <div className="px-2.5 pb-1.5">
        <div
          className="rounded-[var(--radius-sm)] px-2 py-1.5"
          style={{ background: "var(--color-surface-2)" }}
        >
          <button
            type="button"
            data-tap
            onClick={() => {
              setWsDraft(workspace ?? "");
              setWsOpen((v) => !v);
            }}
            className="flex w-full items-center gap-1.5 text-left"
            title={workspace ? `工作区：${workspace}` : "当前是纯对话模式（没有绑定项目目录）"}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--color-text-3)" }}>
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <span className="mono min-w-0 flex-1 truncate text-[11.5px]" style={{ color: workspace ? "var(--color-text)" : "var(--color-text-3)" }}>
              {workspace || "无项目 · 纯对话"}
            </span>
            <span className="shrink-0 text-[10.5px]" style={{ color: "var(--color-text-3)" }}>切换</span>
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <span className="rounded-full px-1.5 py-[1px] text-[10.5px] tabular-nums" style={{ background: "var(--bg-hover)", color: "var(--color-text-2)" }}>
              全局技能 {globalSkills}
            </span>
            <span className="rounded-full px-1.5 py-[1px] text-[10.5px] tabular-nums" style={{ background: "var(--bg-hover)", color: "var(--color-text-2)" }} title="来源地址落在当前工作区目录下的技能">
              项目技能 {projectSkills.length}
            </span>
          </div>
          {wsOpen && (
            <div className="mt-1.5 space-y-1">
              <input
                className="input w-full text-[12px]"
                placeholder="项目目录，例如 ~/projects/my-app"
                value={wsDraft}
                onChange={(e) => setWsDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (isImeEvent(e)) return;
                  if (e.key === "Enter") setWorkspaceFor(wsDraft.trim() || null);
                  if (e.key === "Escape") setWsOpen(false);
                }}
              />
              <div className="flex items-center gap-1.5">
                <button className="btn btn-primary h-7 text-[11.5px]" onClick={() => setWorkspaceFor(wsDraft.trim() || null)}>
                  绑定
                </button>
                <button className="btn h-7 text-[11.5px]" onClick={() => setWorkspaceFor(null)}>
                  无项目
                </button>
                <button className="btn h-7 text-[11.5px] ml-auto" onClick={() => setWsOpen(false)}>
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 头部：新对话 + 管理（批量） */}
      <div className="px-2.5 pb-1.5 flex items-center gap-1.5">
        <button
          className="flex-1 rounded-[var(--radius-sm)] min-h-[40px] max-md:min-h-[44px] text-[length:var(--fs-base)] max-md:text-[length:var(--fs-md)] transition-colors hover:brightness-[0.97]"
          style={{ background: "var(--color-surface-2)", color: "var(--color-text)" }}
          onClick={onNew}
        >
          + 新对话
        </button>
        <button
          type="button"
          data-tap
          onClick={() => {
            setManaging((v) => !v);
            setSelected(new Set());
          }}
          className="h-9 shrink-0 rounded-[var(--radius-sm)] px-2 text-[length:var(--fs-sm)]"
          style={{
            color: managing ? "var(--color-text)" : "var(--color-text-2)",
            background: managing ? "var(--bg-selected)" : "transparent",
          }}
          title={managing ? "退出管理" : "批量管理会话"}
        >
          {managing ? "完成" : "管理"}
        </button>
        <button
          data-tap
          title="收起会话栏"
          onClick={onCollapse}
          className="w-9 h-9 shrink-0 hidden lg:flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-2)] hover:bg-[var(--bg-selected)]"
        >
          «
        </button>
      </div>

      {/* 搜索：会话多了不靠翻 */}
      <div className="px-2.5 pb-1.5">
        <div className="relative">
          <svg
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--color-muted)"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索对话"
            className="input h-9 text-[length:var(--fs-sm)]"
            /* .input 的 padding 是未分层 CSS，Tailwind 的 pl-* 压不过它（全站已知坑），
               这里用内联把左内边距钉到 36px = 16(图标距) + 16(图标宽) + 4(间距) */
            style={{ paddingLeft: 36 }}
            data-tap
          />
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <button
            type="button"
            data-tap
            onClick={() => setOnlyPinned((v) => !v)}
            aria-pressed={onlyPinned}
            className="rounded-full px-2 py-[2px] text-[11px] transition-colors"
            style={{
              background: onlyPinned ? "var(--bg-selected)" : "transparent",
              color: onlyPinned ? "var(--color-text)" : "var(--color-text-3)",
              border: "1px solid var(--color-border)",
            }}
          >
            仅看置顶
          </button>
          <span className="text-[10.5px]" style={{ color: "var(--color-text-3)" }}>
            {pinned.size ? `${pinned.size} 条已置顶` : "还没置顶任何对话"}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-1.5 pb-2">
        {sessions.length === 0 ? (
          <p className="text-[length:var(--fs-sm)] text-[var(--color-text-3)] p-2.5 leading-relaxed">
            还没有对话。点「新对话」开始。
          </p>
        ) : (
          <>
            {/* 标题和内容都没有命中时才说"没有" —— 只要有一边命中就照常列 */}
            {list.length === 0 && hits.length === 0 && !hitBusy && (
              <p className="text-[length:var(--fs-sm)] text-[var(--color-text-3)] p-2.5 leading-relaxed">
                没有叫「{q.trim()}」的对话，内容里也没有。
              </p>
            )}
            {groups
              .filter((g) => (onlyPinned ? g.label === "已置顶" : true))
              .map((g) =>
              g.items.length === 0 ? null : (
                <div key={g.label} className="mb-1">
                  {/* 分组标题：11px 三档灰、无圆点、可折叠、右侧数量 */}
                  <button
                    type="button"
                    onClick={() =>
                      setFoldedGroups((prev) => {
                        const next = new Set(prev);
                        if (next.has(g.label)) next.delete(g.label);
                        else next.add(g.label);
                        return next;
                      })
                    }
                    aria-expanded={!foldedGroups.has(g.label)}
                    className="sticky top-0 z-10 flex w-full items-center gap-1 px-3 pt-3 pb-1.5 text-left text-[length:var(--fs-xs)] backdrop-blur-sm"
                    style={{
                      color: "var(--color-text-3)",
                      background: "color-mix(in srgb, var(--color-surface) 88%, transparent)",
                    }}
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      style={{
                        transform: foldedGroups.has(g.label) ? "none" : "rotate(90deg)",
                        transition: "transform var(--dur-1) var(--ease)",
                      }}
                    >
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                    <span className="flex-1">{g.label}</span>
                    <span className="tabular-nums">{g.items.length}</span>
                  </button>
                  {!foldedGroups.has(g.label) && (
                    <div className="space-y-[2px]">
                      {g.items.map((s) => {
                        const active = s.id === sessionId;
                        const isWorker = s.kind === "worker";
                        const labelText = isWorker
                          ? s.ticket_title || s.title.replace(/^worker-/, "派活 ")
                          : s.title || "未命名对话";
                        const isPinned = pinned.has(s.id);
                        const picked = selected.has(s.id);
                        const editing = renamingId === s.id;
                        return (
                          <div key={s.id}>
                            <div
                              role="button"
                              tabIndex={0}
                              aria-current={active ? "true" : undefined}
                              className="group relative flex h-[52px] cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] pl-2.5 pr-1 transition-colors hover:bg-[var(--bg-selected)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                              style={{
                                background: active ? "var(--bg-selected)" : "transparent",
                                outlineColor: "var(--color-accent)",
                              }}
                              onClick={() => {
                                if (managing) {
                                  setSelected((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(s.id)) next.delete(s.id);
                                    else next.add(s.id);
                                    return next;
                                  });
                                  return;
                                }
                                onPick(s.id);
                              }}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                setMenuFor(menuFor === s.id ? null : s.id);
                              }}
                              onKeyDown={(e) => {
                                if (editing) return;
                                if (isImeEvent(e)) return;
                                if (e.key === "F2") {
                                  e.preventDefault();
                                  startRename(s);
                                } else if (e.key === "Delete") {
                                  e.preventDefault();
                                  dropSession(s);
                                } else if (e.key === "F10" && e.shiftKey) {
                                  e.preventDefault();
                                  setMenuFor(s.id);
                                } else if (e.key === "Enter") {
                                  e.preventDefault();
                                  onPick(s.id);
                                }
                              }}
                            >
                              {managing && (
                                <input
                                  type="checkbox"
                                  checked={picked}
                                  onChange={() =>
                                    setSelected((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(s.id)) next.delete(s.id);
                                      else next.add(s.id);
                                      return next;
                                    })
                                  }
                                  onClick={(e) => e.stopPropagation()}
                                  className="h-[16px] w-[16px] shrink-0 accent-[var(--color-accent)]"
                                  title="选中这条会话"
                                />
                              )}
                              {isPinned && (
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="var(--color-text-3)"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-label="已置顶"
                                  className="shrink-0"
                                >
                                  <path d="M12 17v5M6 4h12l-2 6 3 3v2H5v-2l3-3-2-6z" />
                                </svg>
                              )}

                              <div className="min-w-0 flex-1">
                                {editing ? (
                                  <input
                                    autoFocus
                                    value={draft}
                                    onChange={(e) => setDraft(e.target.value)}
                                    onClick={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => {
                                      // 同上：改名输入里的组字 Enter 不能当提交
                                      if (isImeEvent(e)) return;
                                      if (e.key === "Enter") {
                                        e.preventDefault();
                                        commitRename(s);
                                      } else if (e.key === "Escape") {
                                        e.preventDefault();
                                        setRenamingId(null);
                                      }
                                    }}
                                    onBlur={() => setRenamingId(null)}
                                    className="w-full rounded-[var(--radius-xs)] border px-1.5 py-0.5 text-[length:var(--fs-base)] outline-none"
                                    style={{
                                      borderColor: "var(--color-accent)",
                                      background: "var(--color-surface)",
                                      color: "var(--color-text)",
                                    }}
                                  />
                                ) : (
                                  <div
                                    className="truncate text-[length:var(--fs-base)] max-md:text-[length:var(--fs-md)] leading-[1.3]"
                                    style={{
                                      color: "var(--color-text)",
                                      fontWeight: 500,
                                      /* 长标题右侧 24px 渐隐，不用省略号 */
                                      maskImage:
                                        "linear-gradient(to right, var(--color-text) calc(100% - 24px), transparent)",
                                      WebkitMaskImage:
                                        "linear-gradient(to right, var(--color-text) calc(100% - 24px), transparent)",
                                    }}
                                    title={labelText}
                                    onDoubleClick={(e) => {
                                      e.stopPropagation();
                                      startRename(s);
                                    }}
                                  >
                                    {labelText}
                                  </div>
                                )}
                                <div className="mt-0.5 truncate text-[length:var(--fs-xs)] max-md:text-[length:var(--fs-sm)] tabular-nums" style={{ color: "var(--color-text-3)" }}>
                                  {s.turn_count} 轮 · {fmt.relative(s.last_active_at)}
                                </div>
                              </div>

                              {(kids.get(s.id)?.length ?? 0) > 0 && (
                                <button
                                  className="shrink-0 h-7 px-1.5 flex items-center gap-0.5 rounded-[var(--radius-xs)] text-[10.5px] tabular-nums"
                                  style={{
                                    color: WORKER_COLOR,
                                    background: "color-mix(in srgb, var(--color-warn) 10%, transparent)",
                                  }}
                                  data-tap
                                  title={`这个对话派出了 ${kids.get(s.id)!.length} 件活`}
                                  aria-expanded={openTree.has(s.id)}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenTree((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(s.id)) next.delete(s.id);
                                      else next.add(s.id);
                                      return next;
                                    });
                                  }}
                                >
                                  <svg
                                    width="10"
                                    height="10"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.4"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    aria-hidden="true"
                                    style={{
                                      transform: openTree.has(s.id) ? "rotate(90deg)" : "none",
                                      transition: "transform var(--dur-1)",
                                    }}
                                  >
                                    <path d="M9 6l6 6-6 6" />
                                  </svg>
                                  {kids.get(s.id)!.length}
                                </button>
                              )}

                              {/* 置顶：hover 浮现，键盘 focus 也在（触屏靠 ⋯ 菜单里的同一项） */}
                              <button
                                className="hidden shrink-0 grid h-6 w-6 place-items-center rounded-[var(--radius-xs)] hover:bg-[var(--color-surface)] group-hover:grid group-focus-within:grid"
                                data-tap
                                title={isPinned ? "取消置顶" : "置顶"}
                                aria-pressed={isPinned}
                                style={{ color: isPinned ? "var(--color-accent)" : "var(--color-text-3)" }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onTogglePin(s.id);
                                }}
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="M12 17v5M6 4h12l-2 6 3 3v2H5v-2l3-3-2-6z" />
                                </svg>
                              </button>

                              {/* 常驻「⋯」：不 hover 也在，选中/聚焦时加深 */}
                              <button
                                className="shrink-0 grid h-6 w-6 place-items-center rounded-[var(--radius-xs)] hover:bg-[var(--color-surface)]"
                                data-tap
                                title="更多操作"
                                aria-haspopup="menu"
                                aria-expanded={menuFor === s.id}
                                style={{
                                  color: "var(--color-text-2)",
                                  opacity: active || menuFor === s.id ? 1 : 0.55,
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setMenuFor(menuFor === s.id ? null : s.id);
                                }}
                                onFocus={(e) => {
                                  e.currentTarget.style.opacity = "1";
                                }}
                                onBlur={(e) => {
                                  e.currentTarget.style.opacity = active ? "1" : "0.55";
                                }}
                              >
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                  <circle cx="5" cy="12" r="1.6" />
                                  <circle cx="12" cy="12" r="1.6" />
                                  <circle cx="19" cy="12" r="1.6" />
                                </svg>
                              </button>

                              {menuFor === s.id && (
                                <>
                                  <div
                                    className="fixed inset-0 z-40"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setMenuFor(null);
                                    }}
                                  />
                                  <div
                                    className="absolute right-1 top-[46px] z-50 w-[136px] rounded-[var(--radius-md)] py-1"
                                    style={{
                                      background: "var(--color-surface)",
                                      border: "1px solid var(--color-border)",
                                      boxShadow: "var(--shadow-2)",
                                    }}
                                    role="menu"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <MenuItem
                                      label="重命名"
                                      onClick={() => {
                                        setMenuFor(null);
                                        startRename(s);
                                      }}
                                    />
                                    <MenuItem
                                      label={isPinned ? "取消置顶" : "置顶"}
                                      onClick={() => {
                                        setMenuFor(null);
                                        onTogglePin(s.id);
                                      }}
                                    />
                                    <MenuItem
                                      label="导出 Markdown"
                                      onClick={() => {
                                        setMenuFor(null);
                                        onExport(s);
                                      }}
                                    />
                                    <MenuItem
                                      label="导出 JSON"
                                      onClick={() => {
                                        setMenuFor(null);
                                        onExportJson(s);
                                      }}
                                    />
                                    <MenuItem
                                      label="复制对话"
                                      onClick={() => {
                                        setMenuFor(null);
                                        void copyConversation(s);
                                      }}
                                    />
                                    <MenuItem
                                      label="复制链接"
                                      onClick={() => {
                                        setMenuFor(null);
                                        const url = `${window.location.origin}/exec?s=${s.id}&agent=${s.agent_id}`;
                                        void copyText(url).then(
                                          () => fb.success("已复制对话链接", url),
                                          () => fb.error("复制失败", url),
                                        );
                                      }}
                                    />
                                    <div className="my-1 h-px" style={{ background: "var(--color-border)" }} />
                                    <MenuItem
                                      label="删除"
                                      danger
                                      onClick={() => {
                                        setMenuFor(null);
                                        dropSession(s);
                                      }}
                                    />
                                  </div>
                                </>
                              )}
                            </div>

                            {/* 子树：这个对话派出去的 worker */}
                            {openTree.has(s.id) && (kids.get(s.id)?.length ?? 0) > 0 && (
                              <div className="relative">
                                <span
                                  className="absolute left-[19px] top-0 bottom-3 w-px"
                                  style={{ background: "color-mix(in srgb, var(--color-warn) 35%, transparent)" }}
                                  aria-hidden
                                />
                                {kids.get(s.id)!.map((c) => {
                                  const cActive = c.id === sessionId;
                                  return (
                                    <div
                                      key={c.id}
                                      className="relative ml-3 cursor-pointer rounded-[var(--radius-xs)] py-1.5 pl-6 pr-1 hover:bg-[var(--bg-selected)]"
                                      style={{ background: cActive ? "var(--bg-selected)" : undefined }}
                                      onClick={() => onPick(c.id)}
                                    >
                                      <span
                                        className="absolute left-[7px] top-1/2 h-px w-3"
                                        style={{ background: "color-mix(in srgb, var(--color-warn) 35%, transparent)" }}
                                        aria-hidden
                                      />
                                      <div className="flex min-w-0 items-center gap-1.5">
                                        <span
                                          className="shrink-0 rounded-full"
                                          style={{ width: 6, height: 6, background: agentColor(c.agent_id) }}
                                          aria-hidden
                                        />
                                        <span
                                          className="min-w-0 flex-1 truncate text-[length:var(--fs-sm)]"
                                          style={{ color: "var(--color-text-2)" }}
                                          title={c.ticket_title || c.title}
                                        >
                                          {c.ticket_title || c.title.replace(/^worker-/, "派活 ")}
                                        </span>
                                        <span className="shrink-0 text-[10.5px] tabular-nums" style={{ color: "var(--color-text-3)" }}>
                                          {c.turn_count} 轮
                                        </span>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ),
            )}

            {/* ── 对话内容命中（跨会话检索）*/}
            {q.trim().length >= 2 && (
              <div className="mt-1 border-t pt-1" style={{ borderColor: "var(--color-border)" }}>
                <div className="px-2 pt-1 pb-1 text-[length:var(--fs-xs)] text-[var(--color-text-3)]">
                  对话内容{hitBusy ? " · 搜索中…" : hits.length ? ` · ${hits.length} 条` : ""}
                </div>
                {!hitBusy && hits.length === 0 && list.length > 0 && (
                  <p className="px-2 pb-1 text-[11.5px]" style={{ color: "var(--color-text-3)" }}>
                    没有在对话内容里找到「{q.trim()}」。
                  </p>
                )}
                {hits.map((h) => (
                  <button
                    key={h.message_id}
                    type="button"
                    data-tap
                    onClick={() => onPick(h.session_id)}
                    className="w-full rounded-[var(--radius-sm)] px-2 py-1.5 text-left hover:bg-[var(--bg-selected)]"
                    title={h.snippet}
                  >
                    <span className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--color-text-3)" }}>
                      <span className="truncate">{h.session_title}</span>
                      <span className="shrink-0">· {fmt.relative(h.ts)}</span>
                      <span className="shrink-0">· {h.role === "assistant" ? "我" : "你"}</span>
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-snug line-clamp-2">{h.snippet}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* 批量条：管理模式下固定在列表底部 */}
      {managing && (
        <div
          className="shrink-0 border-t px-2 py-2"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-tap
              onClick={() =>
                setSelected((prev) =>
                  prev.size === sessions.length ? new Set() : new Set(sessions.map((s) => s.id)),
                )
              }
              className="h-8 rounded-[var(--radius-xs)] px-2 text-[length:var(--fs-sm)]"
              style={{ color: "var(--color-text-2)", background: "var(--color-surface-2)" }}
            >
              {selected.size === sessions.length ? "取消全选" : "全选"}
            </button>
            <button
              type="button"
              data-tap
              disabled={selected.size === 0}
              onClick={() => {
                const victims = sessions.filter((s) => selected.has(s.id));
                setSelected(new Set());
                for (const v of victims) dropSession(v, { silent: true });
              }}
              className="ml-auto h-8 rounded-[var(--radius-xs)] px-2.5 text-[length:var(--fs-sm)] disabled:opacity-45"
              style={{ color: "var(--color-err)", background: "color-mix(in srgb, var(--color-err) 10%, transparent)" }}
            >
              删除所选 ({selected.size})
            </button>
          </div>
        </div>
      )}

      {/* 删除后的撤销提示：8 秒内可撤回（这期间并没有真的调接口） */}
      {undo && (
        <div
          className="absolute inset-x-2 bottom-2 z-50 flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-[length:var(--fs-sm)]"
          style={{ background: "var(--color-text)", color: "var(--color-bg)", boxShadow: "var(--shadow-2)" }}
          role="status"
        >
          <span className="min-w-0 flex-1 truncate">{undo.n > 1 ? `已删除 ${undo.n} 个对话` : "已删除"}</span>
          <button
            type="button"
            className="shrink-0 underline"
            onClick={() => {
              undo.restore();
            }}
          >
            撤销
          </button>
        </div>
      )}
    </>
  );
}

/** 顶栏图标按钮：28px 命中区 + 常驻 tooltip（不靠 hover 才认识） */
function IconBtn({
  label,
  onClick,
  path,
  active,
}: {
  label: string;
  onClick: () => void;
  path: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      data-tap
      data-tip={label}
      aria-label={label}
      onClick={onClick}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-xs)] hover:bg-[var(--bg-selected)]"
      style={{ color: active ? "var(--color-text)" : "var(--color-text-2)" }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={path} />
      </svg>
    </button>
  );
}

/** 会话行菜单里的一项：40px 高、左对齐；danger 用危险色（不进红底） */
function MenuItem({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center px-2.5 py-1.5 text-left text-[length:var(--fs-sm)] hover:bg-[var(--bg-selected)]"
      style={{ color: danger ? "var(--color-err)" : "var(--color-text)" }}
      data-tap
    >
      {label}
    </button>
  );
}

/** 一条消息气泡：商业对话产品的标准形态 ——
 *  · 消息本体（用户右蓝/助手左浅）
 *  · hover 动作条：复制 / 编辑 / 重试（编辑只对已落库消息；重试只对用户消息）
 *  · 助手消息下方可折叠「执行过程」（默认收起，点开懒加载） */
/** 消息动作条上的一个图标按钮：30×30 触控区 + 文字提示（不靠 hover 才认识） */
function MsgAction({
  label,
  path,
  onClick,
  tone,
}: {
  label: string;
  /** 24×24 描边路径 */
  path: string;
  onClick: () => void;
  tone?: "ok";
}) {
  return (
    <button
      data-tap
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-[44px] w-[44px] items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-2)] max-md:h-[44px] max-md:w-[44px]"
      style={{ color: tone === "ok" ? "var(--color-ok)" : "var(--color-muted)" }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={path} />
      </svg>
    </button>
  );
}

function Bubble({
  role,
  content,
  pinnedActions = false,
  runId,
  userInput,
  ts,
  messageId,
  sessionId,
  onEdited,
  onRetry,
  onRewind,
  onRerun,
  onBranch,
  onRetryReply,
  onMakeDoc,
  onOpenDock,
  streaming = false,
}: {
  role: "user" | "assistant";
  content: string;
  /** 最新一条：动作条常驻（更早的桌面端 hover 才出现） */
  pinnedActions?: boolean;
  runId?: string | null;
  /** 这一轮里用户说了什么（用于执行过程的第一段「输入」） */
  userInput?: string;
  /** 消息落库时间（epoch 秒）—— hover 动作条里显示，平时不占视觉 */
  ts?: number;
  /** 消息在 session_message 表的 id（可编辑的凭证；没 id = 刚发出去还没落库） */
  messageId?: number;
  sessionId?: string;
  /** 编辑保存成功后的回写（父组件更新本地 history） */
  onEdited?: (content: string) => void;
  /** 用户消息的「重试」= 把这条消息原样再发一遍 */
  onRetry?: () => void;
  /** 从这一轮之前重来：截断历史 + 把用户原文填回输入框（父组件做） */
  onRewind?: () => void;
  /** 改完直接让它重新回答（把这一轮及之后作废，用新内容重跑） */
  onRerun?: (text: string) => void;
  /** 从这一轮之前另起会话（原会话不动） */
  onBranch?: () => void;
  /** 助手消息的「重试」= 这一轮的提问再跑一次 */
  onRetryReply?: () => void;
  /** 助手消息的「整理成文档」= 把这轮整理成 Markdown 存到 product/ */
  onMakeDoc?: () => void;
  /** 在右栏「步骤」里打开这一轮的执行详情 */
  onOpenDock?: (runId: string) => void;
  streaming?: boolean;
}) {
  const isUser = role === "user";
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<RunEvent[] | null>(null);
  const [loadingEv, setLoadingEv] = useState(false);
  /** 完整记录弹框（气泡内自己持有 —— 它是独立组件，不是 ChatConsole 的作用域） */
  const [detailOpen, setDetailOpen] = useState(false);
  /* 完整记录弹框也能用左滑关掉（手机上返回手势先关弹框，不退页面） */
  useHistoryLayer(detailOpen, () => setDetailOpen(false));
  /** 这一轮的用量与耗时（历史消息挂载即拉——收起态也要显示 tokens/耗时） */
  const [meta, setMeta] = useState<{ tokens: number; seconds: number } | null>(null);
  /** 就地编辑态 */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  /** 重来的二次确认：删历史是不可逆的，点一下就删太狠（取消不花任何成本） */
  const [confirmRewind, setConfirmRewind] = useState(false);
  const fb = useFeedback();

  // 历史消息挂载即拉 usage（轻接口，一次）：收起态的过程行要显示
  // 「N tokens · 耗时」——审计实测收起时只有「执行过程 · 点开看每一步」，
  // 用户看不出这一轮跑了多少。事件仍保持懒加载（展开才拉，重得多）。
  useEffect(() => {
    if (!runId) return;
    let dead = false;
    api
      .run(runId)
      .then((run) => {
        if (dead) return;
        const u = (run.usage || {}) as Record<string, number>;
        const tokens =
          Number(u.total ?? 0) || Number(u.tokens_in ?? 0) + Number(u.tokens_out ?? 0) || 0;
        const seconds =
          run.ended_at && run.started_at ? Math.max(0, (run.ended_at - run.started_at) / 1000) : 0;
        setMeta({ tokens, seconds });
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [runId]);

  const hasTrace = !isUser && !!runId && !streaming;
  const canEdit = isUser && !!messageId && !!sessionId && !!onEdited && !streaming;

  const copy = () => {
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    // navigator.clipboard 在非安全上下文（http 内网 IP）可能不存在 → 老式 execCommand 兜底
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(content).then(done, () => fallbackCopy(content, done));
    } else {
      fallbackCopy(content, done);
    }
  };

  const fallbackCopy = (text: string, done: () => void) => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      done();
    } catch {
      fb.info("复制失败", text.slice(0, 200));
    }
  };

  /** 保存这一条。``rerun`` = 保存后立刻让它按新内容重答（下面的回答作废）。 */
  const saveEdit = async (rerun = false) => {
    if (!canEdit || !draft.trim() || saving) return;
    const next = draft.trim();
    setSaving(true);
    try {
      // 重跑要连历史一起动，所以先把新文本存进去再作废后文 ——
      // 顺序反过来的话，被作废那几条里就有「还没改的旧问法」，审计对不上。
      await api.updateSessionMessage(sessionId!, messageId!, next);
      onEdited!(next);
      setEditing(false);
      if (rerun && onRerun) {
        onRerun(next);
        return;
      }
      fb.success("已保存", "只改了记录，回答没变；要它按新问法重答点「保存并重跑」");
    } catch {
      fb.error("保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (events === null && runId) {
      setLoadingEv(true);
      try {
        const [evs, run] = await Promise.all([
          api.runEvents(runId),
          api.run(runId).catch(() => null),
        ]);
        setEvents(evs);
        // 用量+耗时：一次顺手带出（token 数取 total，没有就算了）
        if (run) {
          const u = (run.usage || {}) as Record<string, number>;
          const tokens =
            Number(u.total ?? 0) || Number(u.tokens_in ?? 0) + Number(u.tokens_out ?? 0) || 0;
          const seconds =
            run.ended_at && run.started_at ? Math.max(0, (run.ended_at - run.started_at) / 1000) : 0;
          setMeta({ tokens, seconds });
        }
      } catch {
        setEvents([]);
      } finally {
        setLoadingEv(false);
      }
    }
  };

  // 事件是点开才拉的；刚跑完那一轮先用内存里的摘要顶上（刷新后没有就等点开）
  const memo = runId ? recallProc(runId) : null;
  const steps = events ? eventsToSteps(events, userInput) : (memo?.steps ?? []);

  /* 用户消息里的附件展示：从 content 里解析 [attach:kind:url:name:size] 标记行，
     还原成缩略图/文件卡片；正文去掉附件标记行只留人话。 */
  const attachMatches = [...content.matchAll(/\[attach:(image|file):([^:\]]+):([^:\]]*):(\d+)\]/g)];
  const attachments = attachMatches.map((m) => ({
    kind: m[1] as "image" | "file",
    url: m[2],
    name: m[3] || "附件",
    size: Number(m[4]) || 0,
  }));
  // 运行中插话：历史里以「（运行中插话）」开头 —— 剥掉标记，单独给一个小标签，
  // 让人一眼看出这句是"打断式补充"，不是新一轮的提问。
  const isSteerMsg = isUser && content.startsWith("（运行中插话）");
  const bodySource = isSteerMsg ? content.slice("（运行中插话）".length) : content;
  const userBody = isUser
    ? bodySource
        .split("\n")
        .filter((ln) => !ln.startsWith("[attach:") && !ln.startsWith("[附件] "))
        .join("\n")
        .trim()
    : content;

  /* 短消息（一行内、没附件）= 胶囊；多行/带附件 = 圆角块（右下角收窄做"尾巴"）。
     手机上就一句「好」不该占一个 18px 圆角的大方块。 */
  const shortMsg = !userBody.includes("\n") && userBody.length <= 24 && attachments.length === 0;

  return (
    <div className={`flex group ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={isUser ? "max-w-[70%] max-md:max-w-[86%]" : "min-w-0 flex-1"}>
        {/* 编辑态：textarea 就地展开（不用弹窗——上下文不丢） */}
        {editing ? (
          /* 编辑态：不是一个"小表单"，而是把这条问句**重新变成输入框**——
             改完立刻能重答，是这个交互唯一真正的目的。 */
          <div
            /* 宽度跟气泡站一边（用户消息靠右、不铺满整屏）——
                铺满 1400px 的输入框改一句 20 字的话，视线要横着扫一遍 */
            className="ml-auto w-full overflow-hidden rounded-xl"
            style={{
              maxWidth: "min(42rem, 100%)",
              background: "var(--color-surface)",
              border: "1px solid var(--color-accent)",
              boxShadow: "0 0 0 3px color-mix(in srgb, var(--color-accent) 14%, transparent)",
            }}
          >
            <div
              className="flex items-center gap-2 px-3 py-2"
              style={{ background: "color-mix(in srgb, var(--color-accent) 8%, transparent)" }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
              <span className="text-[12px] font-medium" style={{ color: "var(--color-accent)" }}>
                改这条问句
              </span>
              <button
                className="ml-auto shrink-0 rounded p-0.5 text-[var(--color-muted)] hover:text-[var(--color-text)]"
                title="取消（Esc）"
                disabled={saving}
                onClick={() => setEditing(false)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <textarea
              className="w-full resize-none border-0 bg-transparent px-3 py-2.5 text-[14px] leading-relaxed outline-none"
              rows={Math.min(12, Math.max(2, draft.split("\n").length))}
              value={draft}
              autoFocus
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (isImeEvent(e)) return;
                // ⌘/Ctrl+Enter = 改完并重跑（主路径）；⌘/Ctrl+S = 只保存
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void saveEdit(!!onRerun);
                }
                if (e.key.toLowerCase() === "s" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void saveEdit(false);
                }
                if (e.key === "Escape") setEditing(false);
              }}
            />
            <div
              className="flex flex-wrap items-center gap-2 px-3 py-2"
              style={{ borderTop: "1px solid var(--color-border)", background: "var(--color-surface-2)" }}
            >
              {onRerun ? (
                <span className="text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                  重跑会作废这条之后的回答
                </span>
              ) : null}
              <div className="ml-auto flex items-center gap-1.5">
                <button className="btn btn-sm" disabled={saving} onClick={() => setEditing(false)}>
                  取消
                </button>
                <button
                  className="btn btn-sm"
                  disabled={saving || !draft.trim()}
                  title="只改记录，回答保持原样（⌘S）"
                  onClick={() => void saveEdit(false)}
                >
                  只改记录
                </button>
                {onRerun ? (
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={saving || !draft.trim()}
                    title="保存并让它按新内容重新回答（⌘↵）"
                    onClick={() => void saveEdit(true)}
                  >
                    {saving ? "重跑中…" : "保存并重跑"}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <>
        {/* 过程在上、结果在下（和实时态同一个顺序）：过程默认收起，
            只露这一行；结果就是下面这段正文，不带任何过程底色。 */}
        {hasTrace && (
          <div className="mb-1.5">
            <ProcessBar
              steps={steps}
              open={open}
              onToggle={() => void toggle()}
              loading={loadingEv}
              elapsedMs={
                meta?.seconds ? meta.seconds * 1000 : memo?.ms ? memo.ms : undefined
              }
              usage={meta}
              detail={
                <>
                  {onOpenDock && runId && (
                    <button
                      data-tap
                      onClick={() => onOpenDock(runId)}
                      className="text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
                    >
                      在右栏看 →
                    </button>
                  )}
                  <button
                    data-tap
                    onClick={() => setDetailOpen(true)}
                    className="text-[12px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
                  >
                    完整记录 →
                  </button>
                  {meta && (
                    <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                      {meta.tokens > 0 ? `${fmt.int(meta.tokens)} tokens · ` : ""}
                      {fmt.ms(meta.seconds * 1000)}
                    </span>
                  )}
                </>
              }
            />
          </div>
        )}
        <div
          className={`break-words ${
            isUser
              ? `text-[var(--color-text)] w-fit max-w-full whitespace-pre-wrap [word-break:break-all] ml-auto text-[15px] ${
                  /* 短消息（一行内、无附件）= 胶囊；长消息 = 18px 圆角块，右下角收成 6px
                     （气泡"尾巴"角），右边贴齐。用户要求：气泡样式与尺寸激进一点。 */
                  shortMsg
                    ? "rounded-full px-4 py-2 leading-[1.6]"
                    : "rounded-[18px] rounded-br-[6px] px-3.5 py-2.5 leading-[1.6]"
                }`
              : "text-[15px] leading-[1.8] text-[var(--color-text)] max-w-[46rem]"
          }`}
          style={
            isUser
              ? {
                  background: "var(--color-surface-2)",
                  boxShadow: "var(--shadow-1)",
                }
              : undefined
          }
          /* 双击气泡直接改（桌面最快的一条路；手机还是点下面那个笔）。
             不绑单击：单击要留给"选一段文字复制"。 */
          onDoubleClick={
            isUser && canEdit
              ? () => {
                  setDraft(userBody);
                  setEditing(true);
                }
              : undefined
          }
          title={isUser && canEdit ? "双击可改" : undefined}
        >
          {isUser ? (
            <>
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 justify-end mb-2">
                  {attachments.map((a, i) =>
                    a.kind === "image" ? (
                      <a key={i} href={a.url} target="_blank" rel="noreferrer" className="block">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={a.url}
                          alt={a.name}
                          className="max-h-40 rounded-lg object-cover border"
                          style={{ borderColor: "var(--color-border)" }}
                        />
                      </a>
                    ) : (
                      /* 附件也是"文件类显示"：点开同样是那个操作框（预览/下载/复制），
                         与正文路径、会话文件清单**同一个行为**。 */
                      <FileRowButton
                        key={i}
                        file={{ path: a.url, name: a.name, url: a.url, size: a.size }}
                        className="inline-flex items-center gap-2 rounded-lg pl-2.5 pr-3 py-2 max-w-[240px] text-[12px] hover:brightness-110"
                        style={{ background: "rgba(255,255,255,0.16)", border: "1px solid rgba(255,255,255,0.25)" }}
                      >
                        <span
                          className="inline-flex items-center gap-2"
                          style={{ background: "transparent" }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <path d="M14 2v6h6" />
                          </svg>
                          <span className="min-w-0 text-left">
                            <span className="block truncate leading-tight">{a.name}</span>
                            <span className="block text-[10.5px] opacity-80 leading-tight">{fmt.bytes(a.size)}</span>
                          </span>
                        </span>
                      </FileRowButton>
                    ),
                  )}
                </div>
              )}
              {isSteerMsg && (
                <span className="block text-[11px] opacity-80 leading-tight mb-0.5">运行中插话</span>
              )}
              {userBody}
            </>
          ) : (
            <Markdown text={content} chat />
          )}
          {streaming && <span className="live-dot ml-0.5">▍</span>}
        </div>

        {/* 动作条：一排等宽图标（不是一排小字）。文字按钮在手机上挤成一串、
            还分不清谁是谁；图标 + title 一眼认，触控区 30×30 也够。
            桌面 hover 显形，手机**常驻**（hover 不存在的东西必须常驻）。 */}
        {!streaming && (
          <div
            className={`mt-1 flex items-center gap-1 ${isUser ? "justify-end" : ""} ${
              pinnedActions
                ? "opacity-100"
                : "lg:opacity-0 lg:group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
            }`}
          >
            {ts ? (
              <span className="mr-1.5 text-[11px] tabular-nums" style={{ color: "var(--color-muted)" }}>
                {new Date(ts * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
              </span>
            ) : null}

            {confirmRewind ? (
              /* 破坏性动作在**原地**确认，不弹窗、不跳位 */
              <span
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1"
                style={{ background: "color-mix(in srgb, var(--color-err) 10%, transparent)" }}
              >
                <span className="text-[11.5px]" style={{ color: "var(--color-err)" }}>
                  删掉这轮和之后的消息？
                </span>
                <button
                  data-tap
                  className="rounded px-1.5 py-0.5 text-[11.5px] font-medium"
                  style={{ color: "var(--color-err)" }}
                  onClick={() => {
                    setConfirmRewind(false);
                    onRewind?.();
                  }}
                >
                  确认
                </button>
                <button
                  data-tap
                  className="rounded px-1.5 py-0.5 text-[11.5px]"
                  style={{ color: "var(--color-muted)" }}
                  onClick={() => setConfirmRewind(false)}
                >
                  取消
                </button>
              </span>
            ) : (
              <>
                <MsgAction
                  label={copied ? "已复制" : "复制"}
                  tone={copied ? "ok" : undefined}
                  onClick={copy}
                  path="M9 9h10v10H9zM5 15V5h10" /* 复制 */
                />
                {canEdit && (
                  <MsgAction
                    label="编辑"
                    onClick={() => {
                      setDraft(userBody);
                      setEditing(true);
                    }}
                    path="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"
                  />
                )}
                {onRetry && (
                  <MsgAction label="重发" onClick={onRetry} path="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />
                )}
                {onRetryReply && (
                  <MsgAction
                    label="重试"
                    onClick={onRetryReply}
                    path="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"
                  />
                )}
                {onMakeDoc && (
                  <MsgAction
                    label="整理成文档"
                    onClick={onMakeDoc}
                    path="M7 3h7l4 4v14H7zM14 3v4h4M10 12h6M10 16h6"
                  />
                )}
                {onRewind && (
                  <MsgAction
                    label="重来"
                    onClick={() => setConfirmRewind(true)}
                    path="M9 14 4 9l5-5M4 9h9a6 6 0 0 1 0 12H7"
                  />
                )}
                {onBranch && (
                  <MsgAction label="分支" onClick={onBranch} path="M6 3v12a3 3 0 0 0 3 3h9M18 15l3 3-3 3M6 8h8" />
                )}
              </>
            )}
          </div>
        )}
          </>
        )}

        {/* 完整记录弹框：位置无关（是浮层），过程条已经在正文上方 */}
        {hasTrace && detailOpen && runId && (
          <RunDetailById runId={runId} onClose={() => setDetailOpen(false)} />
        )}
      </div>
    </div>
  );
}
