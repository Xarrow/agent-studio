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
import { HitlPrompt } from "@/components/HitlPrompt";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, fmt, withToken } from "@/lib/api";
import type { Agent, RunEvent, Session, SearchHit } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { ProcessBar, eventsToSteps, recallProc, rememberProc } from "@/components/ui/run-timeline";
import BgProcsStrip from "@/components/BgProcsStrip";
import TodoStrip from "@/components/TodoStrip";
import SessionJobs, { JobButton } from "@/components/SessionJobs";
import { ProcessRail } from "./ProcessRail";
import { pushFrame, clearFrame } from "@/lib/browser-frame";
import { SlashMenu, type CommandItem } from "@/components/SlashMenu";
import { useImeGuard, isImeEvent } from "@/lib/ime";
import Markdown from "@/components/Markdown";
import { RunDetailById } from "@/components/RunDetailDialog";
import { AgentDetailDialog } from "./AgentDetailDialog";
import { ICON_PATHS, SETUP_ITEMS } from "@/lib/nav-items";
import { AgentSwitcher } from "./AgentSwitcher";
import { SkillsStrip } from "./SkillsStrip";
import { SkillPicker } from "./SkillPicker";
import { Sheet } from "./ui/Sheet";
import { MemoryPicker } from "./MemoryPicker";
import { QuickTags } from "./QuickTags";
import { FileOpenerProvider, FileRowButton } from "@/components/FileDialog";
import { copyText } from "@/lib/clipboard";
import { middleEllipsis, fileTypeKey, shortFilePath } from "@/lib/files";
import { BrowserStage, type BrowserAction } from "@/components/BrowserStage";
import type { BrowserStep } from "@/lib/types";
import { humanizeAssistantText } from "@/lib/messages";
import { FileTypeIcon } from "@/components/ui/icons";

/** 流式渲染期间的一条临时消息 */
interface LiveMsg {
  role: "user" | "assistant";
  text: string;
}

export function ChatConsole({ agentId: controlledAgentId }: { agentId?: string }) {
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
  const agentId = controlledAgentId ?? ownAgentId;
  const setAgentId = setOwnAgentId;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
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
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);

  const esRef = useRef<EventSource | null>(null);
  /** sessionId 的镜像：SSE 回调在闭包里跑，必须读到"此刻"的会话 */
  const sessionIdRef = useRef("");
  sessionIdRef.current = sessionId;
  /** 这条 SSE 属于哪个会话 —— 用户切走之后，它推来的东西一律不许上屏 */
  const streamSessionRef = useRef("");
  const endRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

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
        const list = await api.sessions(aid);
        setSessions(list);
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
    try {
      const detail = await api.session(sid);
      setHistory(
        detail.messages
          // system = 心跳这类"平台说的话"：不属于任何一轮，但要留在历史里
          // （关掉页面回来还能看到后台任务跑到哪了）
          .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
          .map((m) => ({
            role: m.role as "user" | "assistant" | "system",
            // 框架的内部话术（"I notice the interruption…"）不能原样给用户看
            content: m.role === "assistant" ? humanizeAssistantText(m.content) : m.content,
            run_id: m.run_id,
            turn_index: m.turn_index,
            id: m.id,
            ts: m.ts,
          })),
      );
    } catch {
      setHistory([]);
    }
  }, []);

  // 切 Agent：重载会话列表，选中最近一个；没有就自动建一个
  useEffect(() => {
    if (!agentId) return;
    void (async () => {
      const list = await loadSessions(agentId);
      if (list.length > 0) {
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

  // 切会话：先把上一会话的实时现场收掉，再载入历史
  useEffect(() => {
    // 不关流的话，旧会话里还在跑的 run 会继续往 live 里追加文本，
    // 串到新会话的屏幕上 —— 这就是"A 会话的内容出现在 B 会话"的根因
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    streamSessionRef.current = "";
    setLive(null);
    setLiveEvents([]);
    liveEventsRef.current = [];
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
  }, [sessionId, loadMessages]);

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
  const slashItems: CommandItem[] = [
    {
      id: "new",
      label: "新对话",
      hint: "另起一个干净的会话",
      fill: "/新对话",
      run: () => void newChat(),
    },
    ...agents.map((a) => ({
      id: `agent-${a.id}`,
      label: `切换到 ${a.name}`,
      hint: (a.description ?? "").slice(0, 40) || "换一个助手接着聊",
      fill: `/${a.name}`,
      run: () => setAgentId(a.id),
    })),
  ];

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

  const attachStream = (runId: string, sentText: string) => {
    const es = new EventSource(api.streamUrl(runId));
    esRef.current = es;
    streamSessionRef.current = sessionId;
    setLiveRunId(runId);
    setBrowserActions([]);
    setBrowserSteps([]);
    lastBrowserRun.current = runId;

    es.onmessage = (e: MessageEvent) => {
      try {
        // 用户已经切到别的会话了：这条流属于旧会话，不许再往界面上写
        if (streamSessionRef.current !== sessionIdRef.current) return;
        const ev = JSON.parse(e.data) as RunEvent;
        // 收下**全部**事件：不只文本，还包括思考与工具调用，
        // 这样执行过程能实时按颜色分段显示出来
        setLiveEvents((prev) => {
          const next = [...prev, ev];
          liveEventsRef.current = next;
          return next;
        });
        const p = ev.payload as Record<string, unknown>;
        if (ev.type === "text_delta") {
          const t = typeof p.text === "string" ? p.text : typeof p.delta === "string" ? p.delta : "";
          // 恢复现场时 live 还是空的（切回来/刷新后重新挂流）：
          // 第一条增量到了就把它开出来，否则这段输出永远上不了屏
          setLive((prev) =>
            prev ? { role: "assistant", text: prev.text + t } : { role: "assistant", text: t },
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

    const settle = async () => {
      es.close();
      if (streamSessionRef.current !== sessionIdRef.current) return;   // 早就切走了，别动当前界面
      setBusy(false);
      setLiveRunId("");
      // 帧**不清**：这轮浏览停在哪一页，用户事后再点开还能看见（开新 run 时才重置）。
      // 画面只进内存、不落库；持久的那一张在会话文件的 browser/<run>.jpg 里。
      void loadBrowserSteps();
      const r = await api.run(runId).catch(() => null);
      if (r && r.status === "waiting_hitl") {
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

    es.addEventListener("done", () => void settle());
    es.onerror = () => void settle();
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

    setFailed(null);
    setHitl(null);
    setInput("");
    setPendingFiles([]);
    setBusy(true);
    setRunStart(Date.now());
    runStartRef.current = Date.now();
    liveEventsRef.current = [];
    setLive({ role: "user", text: composed });
    // 直接进入助手流式态（user 消息由 live 显示，完成后由 history 接管）
    const userEcho = { role: "user" as const, content: composed, run_id: null, turn_index: 0 };
    setHistory((h) => [...h, userEcho]);
    setLive({ role: "assistant", text: "" });
    setLiveEvents([]);
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
  /** 运行停在等授权时输入坞不可用 —— 否则会又起一轮，和暂停的那一轮抢同一个会话 */
  const paused = !!hitl;

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
  //  · Chrome 直播栏 railOpen：**默认关，真有直播画面时才自动出现** ——
  //    之前桌面常驻 420px（占主区 34%）显示「没有正在直播的浏览器画面」✗
  // ⚠️ 位置纪律：必须在**所有提前 return 之前**（本组件有 loading / 无助手两条
  // 提前返回）—— 放在它们之后会让两种情况 hook 数量不同，React 抛 #310
  // （Rendered more hooks than during the previous render），整页变错误页（踩过两次）。
  const [navOpen, setNavOpen] = useState(true);
  const [mobileNav, setMobileNav] = useState(false);
  /* 工具栏上的两个手边入口：换了/勾了立刻生效，不离开对话 */
  const [skillOpen, setSkillOpen] = useState(false);
  const [memOpen, setMemOpen] = useState(false);
  /** 抽屉两个视图：会话（默认）/ 功能与配置。手机上全站只有这一个抽屉，
      功能入口不能另开一个抽屉，也不能塞成横向短标签条（短名和侧栏的完整
      标签对不上，就是"不统一"的来源）。 */
  const [navView, setNavView] = useState<"sessions" | "menu">("sessions");
  /** 助手选择面板开合：「哪个形态被点开了」。三种挂载点只认自己那一份，
   *  共用布尔值会让面板在窗口跨断点缩放后凭空冒出来（桌面开着的面板飘到手机上）。 */
  const [switcherOpen, setSwitcherOpen] = useState<null | "bar" | "sidebar" | "mini">(null);
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
  const [railOpen, setRailOpen] = useState(false);
  /** 用户在本次会话里手动关过直播栏吗 —— 关过就不再自动弹回来 */
  const railTouched = useRef(false);
  /** 存储位置这类「自托管自证」信息：默认收起，点 ⓘ 才展开（原来是常驻噪声） */
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
  const openFiles = filesOpenPref ?? fileCount <= 3;

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
  // 一轮跑完顺手刷一下（刚产出的文件当场就能看见）
  useEffect(() => {
    if (!busy) void loadSessionFiles();
  }, [busy, loadSessionFiles]);
  useEffect(() => {
    try {
      const savedNav = localStorage.getItem("chat.navOpen");
      const savedRail = localStorage.getItem("chat.railOpen");
      if (savedNav !== null) setNavOpen(savedNav === "1");
      if (savedRail !== null) {
        setRailOpen(savedRail === "1");
        railTouched.current = true;
      }
    } catch {}
  }, []);
  const toggleNav = () => {
    setNavOpen((v) => {
      try { localStorage.setItem("chat.navOpen", v ? "0" : "1"); } catch {}
      return !v;
    });
  };
  const toggleRail = () => {
    railTouched.current = true;
    setRailOpen((v) => {
      try { localStorage.setItem("chat.railOpen", v ? "0" : "1"); } catch {}
      return !v;
    });
  };
  // 直播画面一到，右栏自己出来（用户没手动关过的话）
  useEffect(() => {
    if (browserFrame && !railTouched.current) setRailOpen(true);
  }, [browserFrame]);
  /** 兼容旧调用点：input 的 change 事件给的是 FileList */
  const pickFiles = (files: FileList | null) => void addFiles(files);

  /* ------------------------------- 渲染 ------------------------------- */

  if (loading) {
    return <div className="p-4 md:p-6 lg:p-7 text-[13px] text-[var(--color-muted)]">加载中…</div>;
  }

  const currentAgent = agents.find((a) => a.id === agentId);

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
            <Link href="/agents" className="btn btn-primary text-[13px]">
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
          <aside className="hidden lg:flex w-[264px] shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex-col min-h-0">
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
                    <SkillsStrip agent={currentAgent} onChanged={() => void reloadAgents()} />
                  </>
                  ) : null
              }
              sessions={sessions}
              sessionId={sessionId}
              onPick={setSessionId}
              onNew={() => void newChat()}
              onRename={(s) => void renameSession(s)}
              onRemove={(s) => void removeSession(s)}
              onCollapse={toggleNav}
            />
          </aside>
        ) : (
          <div className="hidden lg:flex w-11 shrink-0 flex-col items-center gap-2 py-3 border-r border-[var(--color-border)] bg-[var(--color-surface)]">
            {controlledAgentId === undefined && (
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
            <div className="drawer-in relative w-[280px] max-w-[84vw] bg-[var(--color-surface)] border-r border-[var(--color-border)] flex flex-col min-h-0">
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
                      className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg text-[var(--color-muted)] active:bg-[var(--color-surface-2)]"
                    >
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M15 18l-6-6 6-6" />
                      </svg>
                    </button>
                    <span className="text-[15px] font-semibold tracking-tight">功能与配置</span>
                  </div>
                  <div className="flex-1 overflow-y-auto py-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))]">
                    {SETUP_ITEMS.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setMobileNav(false)}
                        className="mx-1.5 flex items-center gap-2.5 rounded-lg px-2.5 min-h-[44px] active:bg-[var(--color-surface-2)]"
                      >
                        <span className="shrink-0 text-[var(--color-muted)]">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d={ICON_PATHS[item.icon] ?? ""} />
                          </svg>
                        </span>
                        <span className="min-w-0 flex flex-col">
                          <span className="text-[14px] leading-tight">{item.label}</span>
                          <span className="text-[11.5px] leading-snug truncate text-[var(--color-muted)]">{item.tip}</span>
                        </span>
                      </Link>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <SessionsPane
                    agentSlot={
                      controlledAgentId === undefined ? (
                        <div className="px-0.5">
                          <SkillsStrip agent={currentAgent} onChanged={() => void reloadAgents()} />
                        </div>
                      ) : null
                    }
                    sessions={sessions}
                    sessionId={sessionId}
                    onPick={(id) => {
                      setSessionId(id);
                      setMobileNav(false);
                    }}
                    onNew={() => {
                      void newChat();
                      setMobileNav(false);
                    }}
                    onRename={(s) => void renameSession(s)}
                    onRemove={(s) => void removeSession(s)}
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

            {/* 助手身份：受外层控制时是纯文本（参与者条是唯一入口），
                否则用下拉 —— 两处都能选助手就是两套真相 */}
            {controlledAgentId === undefined ? (
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
            ) : (
              <span className="min-w-0 flex items-center gap-2">
                <span className="text-[13.5px] font-medium truncate">
                  {currentAgent?.name ?? "（未选助手）"}
                </span>
                <span
                  className="shrink-0 inline-flex items-center gap-1 text-[11.5px]"
                  style={{ color: busy ? "var(--color-accent)" : "var(--color-muted)" }}
                >
                  <span
                    className={busy ? "live-dot" : ""}
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      background: busy ? "var(--color-accent)" : "var(--color-ok)",
                      display: "inline-block",
                    }}
                  />
                  {busy ? "执行中" : "就绪"}
                </span>
              </span>
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

          {/* 消息流 —— 阅读宽度封顶 768px 居中：一行扫 1000px 是眼睛的负担 */}
          <div className="relative flex-1 min-h-0 flex flex-col">
          <div
            className="flex-1 overflow-auto max-lg:pt-[calc(44px+env(safe-area-inset-top))]"
            ref={boxRef}
            onScroll={onScroll}
            style={{ paddingBottom: dockH + 8 }}
            data-msg-scroll
          >
            {history.length === 0 && !live ? (
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
                  {controlledAgentId === undefined && agents.length > 1 && (
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
              <div className="msg-stream max-w-3xl mx-auto px-4 sm:px-5 py-6 space-y-5">
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
                  return (
                    <Bubble
                      key={m.id ?? i}
                      role={m.role}
                      content={m.content}
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
                      onBranch={
                        m.role === "user" && m.turn_index && !busy
                          ? () => void branchFrom(m.turn_index!)
                          : undefined
                      }
                    />
                  );
                })}

                {/* 生成中：实时分色显示执行过程（思考 / 工具 / 结果 / 回答） */}
                {/* 手机/平板：画面卡片在消息流里；桌面只在右栏收起时用它顶替
                    （避免同一画面两处重复） */}
                {(browserFrame || browserActions.length > 0 || browserSteps.length > 0) && (
                  <BrowserStage
                    variant="inline"
                    frame={browserFrame}
                    actions={browserActions}
                    busy={busy}
                    waiting={browserWaiting}
                    onOpen={() => setBrowserOpen(true)}
                    steps={browserSteps}
                  />
                )}
                {/* 生成中：只给一条**收起**的过程条 + 下面正常流的回答。
                    想看它每一步在干嘛，点开这一行（默认不摊开，
                    否则一屏全是"思考/调用工具"，结果反而被挤到看不见）。 */}
                {busy && (
                  <div className="w-full max-w-[88%] max-md:max-w-[90%]">
                    <ProcessBar
                      steps={eventsToSteps(liveEvents, liveInput)}
                      running
                      elapsedMs={liveElapsed}
                    />
                  </div>
                )}
                {/* 流式回答：过程条在上面（它现在在干嘛），结果在下面实时长出来。
                    过程默认收起，所以"只看结果"成立；要看细节点那一行。 */}
                {live?.role === "assistant" && (
                  <Bubble role="assistant" content={live.text} streaming />
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
            className="absolute inset-x-0 bottom-0 z-20 px-3 sm:px-4 pt-0.5 pb-1"
            style={{
              background: "color-mix(in srgb, var(--color-bg) 34%, transparent)",
              backdropFilter: "blur(32px) saturate(2.1)",
              WebkitBackdropFilter: "blur(32px) saturate(2.1)",
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
              <div className="max-w-3xl mx-auto mb-2">
                <HitlPrompt
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
                className="max-w-3xl mx-auto mb-2 rounded-xl px-3 py-2 flex items-start gap-3 flex-wrap text-[12.5px]"
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
              <div className="max-w-3xl mx-auto mb-2 flex flex-wrap gap-2">
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
                      style={{ background: "rgba(0,0,0,0.45)", color: "#fff" }}
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
                hint={`${fileCount} 个 · ${fmt.bytes(
                  (sessionFiles?.files ?? []).reduce((a, f) => a + (f.size || 0), 0),
                )}`}
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
                <div className="flex min-w-0 items-center gap-2 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                  {/* 桌面上就是那串路径：点一下复制（收起由左边那个 chip 管） */}
                  <button
                    type="button"
                    className="mono min-w-0 flex-1 truncate text-left hover:underline max-md:hidden"
                    title={`点一下复制完整路径\n${sessionFiles?.work_dir ?? ""}`}
                    onClick={() =>
                      void copyText(sessionFiles?.work_dir ?? "").then((ok) =>
                        ok
                          ? fb.success("已复制会话目录", sessionFiles?.work_dir ?? "")
                          : fb.info("会话目录", sessionFiles?.work_dir ?? ""),
                      )
                    }
                  >
                    {sessionFiles?.work_dir ?? "…"}
                  </button>
                  {/* 管理：把文件变成可勾选，用来批量删。常驻可见（不藏进 ⋯） */}
                  {fileCount > 0 ? (
                    <button
                      type="button"
                      className="ml-auto shrink-0 rounded px-1 text-[12px] hover:underline max-md:min-h-[32px] max-md:min-w-[36px]"
                      style={{ color: managing ? "var(--color-err)" : "var(--color-accent)" }}
                      onClick={() => {
                        setManaging((v) => !v);
                        setPicked([]);
                        setBulkConfirm(false);
                      }}
                      title="勾选多个文件一起删"
                    >
                      {managing ? "退出管理" : "管理"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1 rounded px-1 hover:underline max-md:min-h-[32px] max-md:min-w-[32px] max-md:justify-center disabled:opacity-60"
                    style={{ color: "var(--color-accent)" }}
                    onClick={() => void loadSessionFiles()}
                    disabled={filesBusy}
                    aria-label="刷新本会话文件"
                    title="重新读一遍这个会话目录"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      style={filesBusy ? { animation: "spin 1s linear infinite" } : { opacity: 0.75 }}
                    >
                      <path d="M21 12a9 9 0 1 1-3-6.7" />
                      <path d="M21 3v6h-6" />
                    </svg>
                    <span className="max-md:hidden">{filesBusy ? "读取中" : "刷新"}</span>
                  </button>
                </div>

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
                  <div className="mt-1 flex max-h-[46vh] flex-col overflow-y-auto pb-0.5">
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
                              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
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
                  {/* 管理态的动作条：就地出现，不占平时的位置 */}
                  {managing && (
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px]">
                      <span style={{ color: "var(--color-muted)" }}>已选 {picked.length} 个</span>
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
                          color: bulkConfirm ? "#fff" : "var(--color-err)",
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
                      <button
                        type="button"
                        className="btn ml-auto px-2 py-0.5 text-[12px] max-md:min-h-[32px]"
                        onClick={() => {
                          setManaging(false);
                          setPicked([]);
                          setBulkConfirm(false);
                        }}
                      >
                        完成
                      </button>
                    </div>
                  )}
                  </>
                ) : (
                  <div className="mt-0.5 text-[11px]" style={{ color: "var(--color-muted)" }}>
                    还没有文件 —— 这个会话生成的文档都会存在上面的目录里
                  </div>
                ))}
              </div>
              </Sheet>
            )}

            <div className="max-w-3xl mx-auto relative">
              {/* 快速标签：常说的几句点一下就填进输入框（标签本身在设置里增删）。
                  空会话不出现 —— 一句话都没有的时候，「询问是否完成」没上下文，
                  只是白占输入区上方一行。 */}
              {(history.length > 0 || live) && (
              <div className="composer-chips">
              <QuickTags
                prefix={
                  <>
                  {sessionId && fileCount > 0 ? (
                    <button
                      type="button"
                      data-tap
                      onClick={toggleFiles}
                      aria-expanded={openFiles}
                      title={`这个会话产出的 ${fileCount} 个文件（点开看清单）`}
                      /* 只给它上 accent 色：它是「这次的产出」（对象），右边那排是
                         「点了填进输入框」（动作）。同一款胶囊，靠颜色分性质 ——
                         尺寸和形态一个字没动，宁可轻也不要做粗。 */
                      className="chip-thin shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border text-[12px] transition-colors hover:bg-[var(--color-surface-2)]"
                      style={{
                        borderColor: openFiles
                          ? "var(--color-accent)"
                          : "color-mix(in srgb, var(--color-accent) 42%, transparent)",
                        background: openFiles
                          ? "color-mix(in srgb, var(--color-accent) 10%, transparent)"
                          : "transparent",
                        color: "var(--color-accent)",
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                      </svg>
                      {fileCount} 个文件
                    </button>
                  ) : null}

                  </>
                }
                onPick={appendToInput}
              />
              <SkillPicker
                agent={currentAgent}
                onChanged={() => void reloadAgents()}
                open={skillOpen}
                onOpenChange={setSkillOpen}
              />
              <MemoryPicker
                open={memOpen}
                onOpenChange={setMemOpen}
                onPick={(t) => {
                  appendToInput(t);
                  setMemOpen(false);
                }}
              />
              </div>
              )}

              {/* ── 输入坞 ────────────────────────────────────────
                  上下结构（上=正文，下=工具栏），不再左右平铺：多行输入时
                  按钮不会跟着文字跳。发送键用图标表达状态 —— 空闲是圆箭头、
                  执行中是方块，同一个位置形状变化，不用读字。
                  三条投喂路径统一走 addFiles：点附件 / 粘贴截图 / 拖文件进来。 */}
              <div
                data-composer
                className="composer-focus rounded-[18px] border"
                style={{
                  borderColor: paused
                    ? "var(--color-warn)"
                    : dragging
                      ? "var(--color-accent)"
                      : "color-mix(in srgb, var(--color-text) 9%, transparent)",
                  background: "color-mix(in srgb, var(--color-surface) 40%, transparent)",
                  backdropFilter: "blur(22px) saturate(1.9)",
                  WebkitBackdropFilter: "blur(22px) saturate(1.9)",
                  boxShadow: dragging
                    ? "inset 0 1px 0 rgba(255,255,255,.7), 0 12px 32px -8px rgba(37,99,235,.28), 0 2px 8px -2px rgba(15,23,42,.12)"
                    : "inset 0 1px 0 rgba(255,255,255,.7), 0 10px 30px -10px rgba(15,23,42,.22), 0 2px 8px -3px rgba(15,23,42,.10)",
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
                  className="block w-full resize-none bg-transparent border-0 outline-none px-3.5 py-2 text-[14px] leading-[24px] min-h-[44px]"
                  style={{ maxHeight: "40vh" }}
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
                <div className="flex items-center gap-1 px-1.5 pb-0 pt-0">
                  <button
                    data-tap
                    type="button"
                    className="w-9 h-9 sm:w-8 sm:h-8 shrink-0 flex items-center justify-center rounded-xl text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] disabled:opacity-40"
                    title="添加附件（可粘贴截图、拖入文件）"
                    disabled={busy || paused || uploading}
                    onClick={() => fileRef.current?.click()}
                  >
                    {uploading ? (
                      <span className="text-[13px]">…</span>
                    ) : (
                      /* 内联 SVG 回形针（禁 emoji 图标） */
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                      </svg>
                    )}
                  </button>
                  {/* 一个定时任务都没有时才摆这个入口：有了上面就有 strip，含「＋ 再排一个」 */}
                  {sessionId && jobCount === 0 && <JobButton onClick={() => setJobOpen(true)} />}

                  {/* 技能 / 记忆放这里，不放上面那排 chips：
                      chips 是「这轮对话的上下文」（文件、常说的句子），多了就得左右滑；
                      这两个是「工具」，和附件、定时同性质，待在工具栏才对。 */}
                  {currentAgent && (
                    <button
                      data-tap
                      type="button"
                      aria-expanded={skillOpen}
                      title="这个助手挂了哪些技能（点开就地勾选）"
                      onClick={() => {
                        setMemOpen(false);
                        setSkillOpen((v) => !v);
                      }}
                      className="w-9 h-9 sm:w-8 sm:h-8 shrink-0 flex items-center justify-center rounded-xl hover:bg-[var(--color-surface-2)] transition-colors"
                      style={{ color: skillOpen ? "var(--color-accent)" : "var(--color-muted)" }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 3 4 7v6c0 4.4 3.4 7.4 8 8 4.6-.6 8-3.6 8-8V7l-8-4z" />
                      </svg>
                    </button>
                  )}
                  <button
                    data-tap
                    type="button"
                    aria-expanded={memOpen}
                    title="翻一条记忆填进输入框"
                    onClick={() => {
                      setSkillOpen(false);
                      setMemOpen((v) => !v);
                    }}
                    className="w-9 h-9 sm:w-8 sm:h-8 shrink-0 flex items-center justify-center rounded-xl hover:bg-[var(--color-surface-2)] transition-colors"
                    style={{ color: memOpen ? "var(--color-accent)" : "var(--color-muted)" }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 5h16v12H8l-4 4V5z" />
                    </svg>
                  </button>
                  <span className="hidden sm:block text-[11.5px] truncate text-[var(--color-muted)]">
                    {dragging
                      ? "松手即添加为附件"
                      : paused
                        ? "运行暂停，等你授权"
                        : busy
                          ? "助手正在执行…"
                          : ""}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    {paths && (
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
                        className="h-9 sm:h-8 px-2.5 shrink-0 flex items-center justify-center rounded-full text-[12.5px] font-medium"
                        style={{ background: "var(--color-accent)", color: "#fff" }}
                      >
                        插话
                      </button>
                    ) : null}
                    {busy ? (
                      <button
                        data-tap
                        type="button"
                        title="停止这一轮"
                        onClick={() => void stop()}
                        className="w-9 h-9 sm:w-8 sm:h-8 shrink-0 flex items-center justify-center rounded-full border"
                        style={{
                          borderColor: "var(--color-border)",
                          background: "var(--color-surface-2)",
                          color: "var(--color-err)",
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                          <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="currentColor" />
                        </svg>
                      </button>
                    ) : (
                      <button
                        data-tap
                        type="button"
                        title={paused ? "运行暂停，先处理授权" : "发送（Enter）"}
                        disabled={paused || (!input.trim() && pendingFiles.length === 0)}
                        onClick={() => void send()}
                        className="w-9 h-9 sm:w-8 sm:h-8 shrink-0 flex items-center justify-center rounded-full transition-colors disabled:opacity-40"
                        style={{
                          background:
                            input.trim() || pendingFiles.length > 0
                              ? "var(--color-accent)"
                              : "var(--color-surface-2)",
                          color: input.trim() || pendingFiles.length > 0 ? "#fff" : "var(--color-muted)",
                        }}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
                    it.run();
                  }}
                  onClose={() => setSlashOpen(false)}
                />
              )}
            </div>

            <div className="max-w-3xl mx-auto mt-1.5 flex items-center gap-3 text-[11.5px] text-[var(--color-muted)]">
              <span className="hidden sm:inline">Enter 发送 · Shift + Enter 换行 · 可直接粘贴截图</span>
              {paused && <span className="ml-auto">运行暂停中</span>}
            </div>

            {showPaths && paths && (
              <div
                className="max-w-3xl mx-auto mt-1.5 rounded-lg px-2.5 py-2 text-[11.5px] flex flex-wrap items-center gap-x-2 gap-y-1"
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

        {/* ── 右栏：Chrome 直播（只在真有画面时出现 / 手动开）────────────
            没有画面时给 44px 把手；点一下可以手动打开（看历史画面）。 */}
        {railOpen ? (
          <ProcessRail
            frame={browserFrame}
            actions={browserActions}
            busy={busy}
            waiting={browserWaiting}
            onCollapse={toggleRail}
            onUserClick={async (x, y) => sendBrowser({ kind: "click", x, y })}
            onUserText={async (text) => sendBrowser({ kind: "text", text })}
            onUserScroll={async (dy) => sendBrowser({ kind: "scroll", dy })}
            steps={browserSteps}
            onLoadSteps={() => void loadBrowserSteps()}
          />
        ) : (
          <button
            data-tap
            title="浏览器"
            onClick={toggleRail}
            className="hidden lg:flex w-11 shrink-0 flex-col items-center gap-2 py-3 border-l border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 9h18M9 3c-2 3-2 15 0 18M15 3c2 3 2 15 0 18" />
            </svg>
            {busy && browserFrame && (
              <span className="w-2 h-2 rounded-full live-dot" style={{ background: "var(--color-accent)" }} />
            )}
          </button>
        )}
      </div>
      {/* 浏览器面板 —— 桌面居中窗口，手机贴底抽屉（和文件预览同一个手感）。
          点缩略条打开；画面可点、可滚、可打字，登录要用户自己来。 */}
      {browserOpen && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center md:items-center" role="dialog" aria-modal="true" aria-label="浏览器画面">
          <div className="absolute inset-0" style={{ background: "rgba(15,23,42,0.4)" }} onClick={() => setBrowserOpen(false)} />
          <div
            className="relative flex w-full flex-col overflow-hidden rounded-t-[16px] md:max-w-[900px] md:rounded-[14px]"
            style={{
              height: "88vh",
              maxHeight: "88vh",
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
  sessions,
  sessionId,
  onPick,
  onNew,
  onRename,
  onRemove,
  onCollapse,
  agentSlot,
}: {
  sessions: Session[];
  sessionId: string;
  onPick: (id: string) => void;
  onNew: () => void;
  onRename: (s: Session) => void;
  onRemove: (s: Session) => void;
  onCollapse: () => void;
  /** 助手身份块：会话都属于某个助手，它排在列表最上面 */
  agentSlot?: React.ReactNode;
}) {
  const [q, setQ] = useState("");
  /** 打开菜单的会话 id（一次只开一个） */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** 对话**内容**命中的结果（标题命中在本地即时过滤，内容命中要问后端） */
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [hitBusy, setHitBusy] = useState(false);

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

  const kw = q.trim().toLowerCase();
  const list = kw
    ? sessions.filter((s) => (s.title || "未命名对话").toLowerCase().includes(kw))
    : sessions;

  // 按最近活跃分组（今天 / 昨天 / 7 天内 / 更早）
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const today = dayStart.getTime();
  const groups: { label: string; items: Session[] }[] = [
    { label: "今天", items: [] },
    { label: "昨天", items: [] },
    { label: "过去 7 天", items: [] },
    { label: "更早", items: [] },
  ];
  for (const s of list) {
    const t = s.last_active_at || 0;
    if (t >= today) groups[0].items.push(s);
    else if (t >= today - 86_400_000) groups[1].items.push(s);
    else if (t >= today - 7 * 86_400_000) groups[2].items.push(s);
    else groups[3].items.push(s);
  }

  return (
    <>
      {agentSlot && (
        <div className="px-1.5 pt-1.5 pb-1 border-b border-[var(--color-border)] mb-1">{agentSlot}</div>
      )}
      <div className="p-2.5 pb-1.5 flex items-center gap-1.5">
        <button className="btn btn-primary flex-1" onClick={onNew}>
          + 新对话
        </button>
        <button
          data-tap
          title="收起"
          onClick={onCollapse}
          className="w-9 h-9 shrink-0 hidden lg:flex items-center justify-center rounded-lg text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]"
        >
          «
        </button>
      </div>

      {/* 搜索：会话多了不靠翻 */}
      <div className="px-2.5 pb-1.5">
        <div className="relative">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            width="13"
            height="13"
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
            className="input pl-8 h-9 text-[13px]"
            data-tap
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto px-1.5 pb-2">
        {sessions.length === 0 ? (
          <p className="text-[12.5px] text-[var(--color-muted)] p-2.5 leading-relaxed">
            还没有对话。点「新对话」开始。
          </p>
        ) : (
          <>
            {/* 标题和内容都没有命中时才说"没有" —— 只要有一边命中就照常列 */}
            {list.length === 0 && hits.length === 0 && !hitBusy && (
              <p className="text-[12.5px] text-[var(--color-muted)] p-2.5 leading-relaxed">
                没有叫「{q.trim()}」的对话，内容里也没有。
              </p>
            )}
            {groups.map((g) =>
              g.items.length === 0 ? null : (
              <div key={g.label} className="mb-1">
                <div className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-[var(--color-muted)]">
                  {g.label}
                </div>
                <div className="space-y-0.5">
                  {g.items.map((s) => {
                    const active = s.id === sessionId;
                    return (
                      <div
                        key={s.id}
                        className={`group relative flex items-center gap-1 rounded-lg pl-2 pr-1 py-1.5 cursor-pointer transition-colors ${
                          active ? "bg-[var(--color-surface-2)]" : "hover:bg-[var(--color-surface-2)]"
                        }`}
                        onClick={() => onPick(s.id)}
                      >
                        {/* 当前会话：左边一条竖色条 */}
                        <span
                          className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-full"
                          style={{ background: active ? "var(--color-accent)" : "transparent" }}
                          aria-hidden="true"
                        />
                        <div className="min-w-0 flex-1">
                          <div
                            className="text-[12.5px] truncate"
                            style={
                              active
                                ? { color: "var(--color-accent)", fontWeight: 500 }
                                : undefined
                            }
                          >
                            {s.title || "未命名对话"}
                          </div>
                          <div className="text-[10.5px] text-[var(--color-muted)] truncate mt-0.5">
                            {s.turn_count} 轮 · {fmt.relative(s.last_active_at)}
                          </div>
                        </div>
                        <button
                          className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] lg:opacity-0 lg:group-hover:opacity-100"
                          data-tap-lg
                          title="更多"
                          aria-haspopup="menu"
                          aria-expanded={menuFor === s.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuFor(menuFor === s.id ? null : s.id);
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
                            {/* 点哪儿都关（比监听 document 更省事，也不怕漏解绑） */}
                            <div
                              className="fixed inset-0 z-40"
                              onClick={(e) => {
                                e.stopPropagation();
                                setMenuFor(null);
                              }}
                            />
                            <div
                              className="absolute right-1 top-8 z-50 w-[124px] rounded-lg py-1 shadow-lg"
                              style={{
                                background: "var(--color-surface)",
                                border: "1px solid var(--color-border)",
                              }}
                              role="menu"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                className="w-full text-left px-2.5 py-1.5 text-[12.5px] hover:bg-[var(--color-surface-2)]"
                                onClick={() => {
                                  setMenuFor(null);
                                  onRename(s);
                                }}
                              >
                                改名
                              </button>
                              <button
                                className="w-full text-left px-2.5 py-1.5 text-[12.5px] hover:bg-[var(--color-surface-2)]"
                                style={{ color: "var(--color-err)" }}
                                onClick={() => {
                                  setMenuFor(null);
                                  onRemove(s);
                                }}
                              >
                                删除
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ),
            )}

            {/* ── 对话内容命中（跨会话检索）──────────────────────────
                标题只是第一段；真正的"以前聊过"在正文里。标题命中在本地过滤，
                内容命中要问后端（300ms 防抖）。点一条 = 打开那个会话。 */}
            {q.trim().length >= 2 && (
              <div className="mt-1 border-t pt-1" style={{ borderColor: "var(--color-border)" }}>
                <div className="px-2 pt-1 pb-1 text-[11px] font-medium tracking-wide text-[var(--color-muted)]">
                  对话内容{hitBusy ? " · 搜索中…" : hits.length ? ` · ${hits.length} 条` : ""}
                </div>
                {!hitBusy && hits.length === 0 && list.length > 0 && (
                  <p className="px-2 pb-1 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                    没有在对话内容里找到「{q.trim()}」。
                  </p>
                )}
                {hits.map((h) => (
                  <button
                    key={h.message_id}
                    type="button"
                    data-tap
                    onClick={() => onPick(h.session_id)}
                    className="w-full text-left rounded-lg px-2 py-1.5 hover:bg-[var(--color-surface-2)] max-md:min-h-[36px]"
                    title={h.snippet}
                  >
                    <span className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                      <span className="truncate">{h.session_title}</span>
                      <span className="shrink-0">· {fmt.relative(h.ts)}</span>
                      <span className="shrink-0">· {h.role === "assistant" ? "我" : "你"}</span>
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-snug line-clamp-2">
                      {h.snippet}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** 一条消息气泡：商业对话产品的标准形态 ——
 *  · 消息本体（用户右蓝/助手左浅）
 *  · hover 动作条：复制 / 编辑 / 重试（编辑只对已落库消息；重试只对用户消息）
 *  · 助手消息下方可折叠「执行过程」（默认收起，点开懒加载） */
function Bubble({
  role,
  content,
  runId,
  userInput,
  ts,
  messageId,
  sessionId,
  onEdited,
  onRetry,
  onRewind,
  onBranch,
  streaming = false,
}: {
  role: "user" | "assistant";
  content: string;
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
  /** 从这一轮之前另起会话（原会话不动） */
  onBranch?: () => void;
  streaming?: boolean;
}) {
  const isUser = role === "user";
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<RunEvent[] | null>(null);
  const [loadingEv, setLoadingEv] = useState(false);
  /** 完整记录弹框（气泡内自己持有 —— 它是独立组件，不是 ChatConsole 的作用域） */
  const [detailOpen, setDetailOpen] = useState(false);
  /** 这一轮的用量与耗时（展开时顺手拉 run 拿 —— 不展开就不拉） */
  const [meta, setMeta] = useState<{ tokens: number; seconds: number } | null>(null);
  /** 就地编辑态 */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  /** 重来的二次确认：删历史是不可逆的，点一下就删太狠（取消不花任何成本） */
  const [confirmRewind, setConfirmRewind] = useState(false);
  const fb = useFeedback();

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

  const saveEdit = async () => {
    if (!canEdit || !draft.trim() || saving) return;
    setSaving(true);
    try {
      await api.updateSessionMessage(sessionId!, messageId!, draft.trim());
      onEdited!(draft.trim());
      setEditing(false);
      fb.success("已保存");
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
    // 懒加载：折叠时不拉数据，展开才拉（避免一进对话页就发一堆请求）
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
      <div className={isUser ? "max-w-[88%] max-md:max-w-[90%]" : "min-w-0 flex-1"}>
        {/* 编辑态：textarea 就地展开（不用弹窗——上下文不丢） */}
        {editing ? (
          <div
            className="rounded-lg p-2.5"
            style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-accent)" }}
          >
            <textarea
              className="input w-full text-[13.5px] resize-none"
              rows={Math.min(10, Math.max(2, draft.split("\n").length))}
              value={draft}
              autoFocus
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Cmd/Ctrl+Enter 保存；组字中的 Enter 交给输入法
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  if (isImeEvent(e)) return;
                  e.preventDefault();
                  void saveEdit();
                }
                if (e.key === "Escape") setEditing(false);
              }}
            />
            <div className="mt-2 flex justify-end gap-2">
              <button
                className="btn btn-sm"
                disabled={saving}
                onClick={() => setEditing(false)}
              >
                取消
              </button>
              <button
                className="btn btn-primary btn-sm"
                disabled={saving || !draft.trim()}
                onClick={() => void saveEdit()}
              >
                {saving ? "保存中…" : "保存"}
              </button>
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
              detail={
                <>
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
              ? `text-white w-fit max-w-full whitespace-pre-wrap ml-auto text-[15px] ${
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
                  background: "var(--color-accent)",
                  boxShadow:
                    "0 1px 2px color-mix(in srgb, var(--color-accent) 32%, transparent), inset 0 1px 0 rgba(255,255,255,0.14)",
                }
              : undefined
          }
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
                          style={{ borderColor: "rgba(255,255,255,0.35)" }}
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

        {/* 动作条：桌面 hover 显形；手机**常驻**（hover 不存在的东西必须常驻）。
            时间戳放最左（占位但不抢眼），复制/编辑/重发跟在后面。 */}
        {!streaming && (
          <div
            className={`mt-1 flex items-center gap-0.5 ${isUser ? "justify-end" : ""} lg:opacity-0 lg:group-hover:opacity-100 transition-opacity`}
          >
            {ts ? (
              <span className="text-[11px] mr-1.5" style={{ color: "var(--color-muted)" }}>
                {new Date(ts * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
              </span>
            ) : null}
            <button
              data-tap
              className="text-[11.5px] px-1.5 py-0.5 rounded"
              style={{ color: copied ? "var(--color-ok)" : "var(--color-muted)" }}
              title="复制"
              onClick={copy}
            >
              {copied ? "已复制" : "复制"}
            </button>
            {canEdit && (
              <button
                data-tap
                className="text-[11.5px] px-1.5 py-0.5 rounded hover:text-[var(--color-text)]"
                style={{ color: "var(--color-muted)" }}
                title="编辑这条消息"
                onClick={() => {
                  setDraft(userBody);
                  setEditing(true);
                }}
              >
                编辑
              </button>
            )}
            {onRetry && (
              <button
                data-tap
                className="text-[11.5px] px-1.5 py-0.5 rounded hover:text-[var(--color-text)]"
                style={{ color: "var(--color-muted)" }}
                title="把这条消息原样再发一遍"
                onClick={onRetry}
              >
                重发
              </button>
            )}
            {/* 重来 vs 重发：重发 = 叠在新一轮（历史还在）；重来 = 把这轮及之后擦掉，
                改完再发。想留原答案试另一条路就用「分支」——它开新会话，这边一个字不动。 */}
            {onRewind && !confirmRewind && (
              <button
                data-tap
                className="text-[11.5px] px-1.5 py-0.5 rounded hover:text-[var(--color-text)]"
                style={{ color: "var(--color-muted)" }}
                title="回到这一轮之前，原文回到输入框"
                onClick={() => setConfirmRewind(true)}
              >
                重来
              </button>
            )}
            {onRewind && confirmRewind && (
              <span className="inline-flex items-center gap-1">
                <span className="text-[11.5px]" style={{ color: "var(--color-danger)" }}>
                  删掉这轮和之后的消息？
                </span>
                <button
                  data-tap
                  className="text-[11.5px] px-1.5 py-0.5 rounded font-medium"
                  style={{ color: "var(--color-danger)" }}
                  onClick={() => {
                    setConfirmRewind(false);
                    onRewind();
                  }}
                >
                  确认重来
                </button>
                <button
                  data-tap
                  className="text-[11.5px] px-1.5 py-0.5 rounded"
                  style={{ color: "var(--color-muted)" }}
                  onClick={() => setConfirmRewind(false)}
                >
                  取消
                </button>
              </span>
            )}
            {onBranch && (
              <button
                data-tap
                className="text-[11.5px] px-1.5 py-0.5 rounded hover:text-[var(--color-text)]"
                style={{ color: "var(--color-muted)" }}
                title="从这一轮之前另起会话"
                onClick={onBranch}
              >
                分支
              </button>
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
