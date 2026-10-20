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
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { Agent, RunEvent, Session, SearchHit } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { ProcessBar, eventsToSteps, recallProc, rememberProc } from "@/components/ui/run-timeline";
import BgProcsStrip from "@/components/BgProcsStrip";
import SessionJobs, { JobButton } from "@/components/SessionJobs";
import { BrowserLive } from "@/components/BrowserLive";
import { ProcessRail } from "@/components/ProcessRail";
import { SlashMenu, type CommandItem } from "@/components/SlashMenu";
import { useImeGuard, isImeEvent } from "@/lib/ime";
import Markdown from "@/components/Markdown";
import { RunDetailById } from "@/components/RunDetailDialog";
import { AgentDetailDialog } from "@/components/AgentDetailDialog";
import { FileOpenerProvider, FileRowButton } from "@/components/FileDialog";
import { copyText } from "@/lib/clipboard";
import { middleEllipsis, fileTypeKey } from "@/lib/files";
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
    { role: "user" | "assistant"; content: string; run_id: string | null; turn_index: number; id?: number; ts?: number }[]
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
  const endRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  /* ------------------------------- 数据加载 ------------------------------- */

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
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            role: m.role as "user" | "assistant",
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

  // 切会话：载入历史
  useEffect(() => {
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
  useEffect(() => {
    if (!followRef.current) return;
    const el = boxRef.current;
    if (!el) return;
    // 流式时用瞬时滚动（smooth 会被每帧的新内容打断，反而抖）
    el.scrollTop = el.scrollHeight;
  }, [history, live]);
  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
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
      description: "对话记录会被删除，但执行记录（Runs）会保留，可在调试台查看。",
      details: [
        `${s.turn_count} 轮对话 · ${s.message_count} 条消息`,
        `${dirLabel}/ 文件夹`,
      ],
      warning:
        fileCount > 0
          ? `这个会话的文件夹里有 ${fileCount} 个文件（共 ${fmt.bytes(fileBytes)}），会跟对话一起删掉，删了找不回来。`
          : "这个会话的文件夹会跟对话一起删掉。现在里面是空的，不会有文件丢失。",
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
  const attachStream = (runId: string, sentText: string) => {
    const es = new EventSource(api.streamUrl(runId));
    esRef.current = es;
    setLiveRunId(runId);

    es.onmessage = (e: MessageEvent) => {
      try {
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
          setLive((prev) => (prev ? { role: "assistant", text: prev.text + t } : prev));
        }
        if (ev.type === "browser_frame" && typeof p.frame === "string") {
          setBrowserFrame({
            data: p.frame,
            url: typeof p.url === "string" ? p.url : "",
            title: typeof p.title === "string" ? p.title : "",
          });
        }
      } catch {
        /* ignore */
      }
    };

    const settle = async () => {
      es.close();
      setBusy(false);
      setLiveRunId("");
      setBrowserFrame(null);
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
      <div className="h-full min-h-0 flex">
        {configAgent && (
          <AgentDetailDialog agentId={configAgent} onClose={() => setConfigAgent(null)} />
        )}

        {/* ── 会话栏（桌面在流内，可收起；窄屏走抽屉）────────────────────
            收起后不留空白 —— 只剩 44px 的把手，点一下回来。 */}
        {navOpen ? (
          <aside className="hidden lg:flex w-[264px] shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex-col min-h-0">
            <SessionsPane
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
          <button
            data-tap
            title="展开对话列表"
            onClick={toggleNav}
            className="hidden lg:flex w-11 shrink-0 flex-col items-center gap-2 py-3 border-r border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h10" />
            </svg>
            <span
              className="text-[10.5px] tabular-nums px-1.5 rounded-full"
              style={{ background: "var(--color-surface-2)", color: "var(--color-muted)" }}
            >
              {sessions.length}
            </span>
          </button>
        )}

        {/* ── 手机会话抽屉：浮在对话之上，不吃对话高度 ─────────────── */}
        {mobileNav && (
          <div className="lg:hidden fixed inset-0 z-40 flex">
            <div className="w-[280px] max-w-[84vw] bg-[var(--color-surface)] border-r border-[var(--color-border)] flex flex-col min-h-0">
              <SessionsPane
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
        <section className="flex-1 flex flex-col min-h-0 min-w-0">
          <header className="h-[52px] px-3 sm:px-4 flex items-center gap-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
            <button
              data-tap
              className="lg:hidden w-11 h-11 sm:w-9 sm:h-9 -ml-1 flex items-center justify-center rounded-lg text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]"
              title="对话列表"
              onClick={() => setMobileNav(true)}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M4 6h16M4 12h16M4 18h10" />
              </svg>
            </button>

            {/* 助手身份：受外层控制时是纯文本（参与者条是唯一入口），
                否则用下拉 —— 两处都能选助手就是两套真相 */}
            {controlledAgentId === undefined ? (
              <select
                className="input input-inline min-w-[150px] max-w-[220px] shrink-0 text-[13px]"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
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

            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              {/* 每条助手消息自己带「执行过程 / 完整记录」—— 顶栏再放一个
                  「本轮详情」就是同一件事的第二道门（用户反馈过：同一条
                  信息别两处给），所以这里只留「配置」。 */}
              {agentId && (
                <button
                  data-tap
                  className="btn btn-sm"
                  onClick={() => setConfigAgent(agentId)}
                >
                  配置
                </button>
              )}
            </div>
          </header>

          {/* 消息流 —— 阅读宽度封顶 768px 居中：一行扫 1000px 是眼睛的负担 */}
          <div className="relative flex-1 min-h-0 flex flex-col">
          <div className="flex-1 overflow-auto" ref={boxRef} onScroll={onScroll}>
            {history.length === 0 && !live ? (
              /* 空状态：不摆「开始对话」的废话 —— 直接给 3 个可点的开场问题，
                 点了就填进输入框（不自动发，让人改得动）。 */
              <div className="max-w-md mx-auto mt-16 px-6">
                <div className="text-center">
                  <div
                    className="inline-flex items-center justify-center w-11 h-11 rounded-2xl text-[19px] mb-3"
                    style={{ background: "var(--color-surface-2)" }}
                  >
                    ✦
                  </div>
                  <p className="text-[15px] font-medium">{currentAgent?.name || "Agent"}</p>
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
                      q: "帮我分析一个文件或一段数据",
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
              <div className="max-w-3xl mx-auto px-4 sm:px-5 py-6 space-y-5">
                {history.map((m, i) => {
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
                    />
                  );
                })}

                {/* 生成中：实时分色显示执行过程（思考 / 工具 / 结果 / 回答） */}
                {/* 手机/平板：画面卡片在消息流里；桌面只在右栏收起时用它顶替
                    （避免同一画面两处重复） */}
                {busy && browserFrame && (
                  <div className={railOpen ? "lg:hidden" : ""}>
                    <BrowserLive
                      frame={browserFrame}
                      onUserClick={async (x, y) => {
                        if (!liveRunId) return;
                        await fetch(`/api/runs/${liveRunId}/browser-input`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ kind: "click", x, y }),
                        }).catch(() => {});
                      }}
                      onUserText={async (text) => {
                        if (!liveRunId) return;
                        await fetch(`/api/runs/${liveRunId}/browser-input`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ kind: "text", text }),
                        }).catch(() => {});
                      }}
                    />
                  </div>
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
                className="absolute bottom-3 right-3 lg:right-5 inline-flex items-center gap-1.5 rounded-full pl-2.5 pr-3 h-8 text-[12px] shadow-md transition-opacity"
                style={{
                  background: "var(--color-surface)",
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
          <div className="border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 sm:px-4 pt-3 pb-2.5">
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
              />
            )}

            {sessionId && <BgProcsStrip sessionId={sessionId} busy={busy} />}

            {/* ── 本会话的文件（常驻，不再藏在 ⓘ 里）────────────────────
                用户要求：「每个会话生成的文档应该独立存放，在会话能看到存储的路径和文件」。
                所以这里**默认就在**：左边是这个会话的目录（点一下复制完整路径），
                右边是文件数；下面一行是这个会话产出的文件，点开就是文件操作框
                （预览 / 下载 / 复制路径）。没有文件时也留着这一条 —— 让人知道
                "以后生成的东西会落在哪"。 */}
            {sessionId && (
              <div
                className="max-w-3xl mx-auto mb-1.5 rounded-[12px] border px-2.5 py-1.5 max-md:px-2"
                style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
              >
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                  <button
                    type="button"
                    onClick={toggleFiles}
                    aria-expanded={openFiles}
                    title={openFiles ? "收起文件清单（把地方让给对话）" : "展开文件清单"}
                    className="shrink-0 rounded p-0.5 hover:bg-[var(--color-surface)] max-md:inline-flex max-md:min-h-[32px] max-md:min-w-[32px] max-md:items-center max-md:justify-center"
                    style={{ color: "var(--color-muted)" }}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      style={{ transform: openFiles ? "rotate(90deg)" : "rotate(0deg)", transition: "transform .15s ease" }}
                    >
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={toggleFiles}
                    className="shrink-0 hover:underline max-md:inline-flex max-md:min-h-[32px] max-md:items-center"
                    title={openFiles ? "收起文件清单" : "展开文件清单"}
                  >
                    本会话文件
                  </button>
                  <button
                    type="button"
                    className="mono min-w-0 flex-1 truncate text-left hover:underline max-md:inline-flex max-md:min-h-[32px] max-md:items-center"
                    title={`点一下复制完整路径\n${sessionFiles?.work_dir ?? ""}`}
                    onClick={() =>
                      void copyText(sessionFiles?.work_dir ?? "").then((ok) =>
                        ok
                          ? fb.success("已复制会话目录", sessionFiles?.work_dir ?? "")
                          : fb.info("会话目录", sessionFiles?.work_dir ?? ""),
                      )
                    }
                  >
                    {sessionFiles ? (
                      <>
                        <span className="md:hidden">{`…/sessions/${sessionId}`}</span>
                        <span className="max-md:hidden">{sessionFiles.work_dir}</span>
                      </>
                    ) : (
                      "…"
                    )}
                  </button>
                  <span className="shrink-0">· {sessionFiles?.count ?? 0} 个</span>
                  <button
                    type="button"
                    className="ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1 hover:underline max-md:min-h-[32px] max-md:min-w-[32px] max-md:justify-center disabled:opacity-60"
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
                {openFiles &&
                  (sessionFiles && sessionFiles.files.length > 0 ? (
                  <div className="mt-1 flex max-h-[96px] flex-wrap gap-1.5 overflow-y-auto pb-0.5">
                    {sessionFiles.files.slice(0, 6).map((f) => (
                      <FileRowButton
                        key={f.path}
                        file={{ path: `${sessionFiles.work_dir}/${f.path}`, url: f.url, size: f.size, mtime: f.mtime }}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[11.5px] hover:bg-[var(--color-surface)] max-md:min-h-[32px]"
                        style={{ borderColor: "var(--color-border)", color: "var(--color-text)" }}
                      >
                        <FileTypeIcon kind={fileTypeKey(f.path)} size={13} className="shrink-0 opacity-60" />
                        <span className="mono shrink-0" title={f.path}>
                          {f.path.includes("/")
                            ? `${f.path.slice(0, f.path.lastIndexOf("/") + 1)}${middleEllipsis(f.path.slice(f.path.lastIndexOf("/") + 1), 20)}`
                            : middleEllipsis(f.path, 22)}
                        </span>
                        <span style={{ color: "var(--color-muted)" }}>{fmt.bytes(f.size)}</span>
                      </FileRowButton>
                    ))}
                    {sessionFiles.files.length > 6 && (
                      <span className="inline-flex items-center px-1 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                        还有 {sessionFiles.files.length - 6} 个…
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="mt-0.5 text-[11px]" style={{ color: "var(--color-muted)" }}>
                    还没有文件 —— 这个会话生成的文档都会存在上面的目录里
                  </div>
                ))}
              </div>
            )}

            <div className="max-w-3xl mx-auto relative">
              {/* ── 输入坞 ────────────────────────────────────────
                  上下结构（上=正文，下=工具栏），不再左右平铺：多行输入时
                  按钮不会跟着文字跳。发送键用图标表达状态 —— 空闲是圆箭头、
                  执行中是方块，同一个位置形状变化，不用读字。
                  三条投喂路径统一走 addFiles：点附件 / 粘贴截图 / 拖文件进来。 */}
              <div
                className="rounded-[18px] border transition-colors"
                style={{
                  borderColor: paused
                    ? "var(--color-warn)"
                    : dragging
                      ? "var(--color-accent)"
                      : "var(--color-border)",
                  background: "var(--color-surface)",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
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
                  className="block w-full resize-none bg-transparent border-0 outline-none px-3.5 pt-2.5 pb-1 text-[13.5px] leading-6"
                  style={{ maxHeight: "40vh" }}
                  placeholder={
                    paused
                      ? "运行暂停，先处理上面的授权…"
                      : busy
                        ? "执行中…可以继续打字，等它跑完再发"
                        : pendingFiles.length > 0
                          ? `附了 ${pendingFiles.length} 个文件，说点什么…`
                          : "说点什么…"
                  }
                  value={input}
                  disabled={busy || paused}
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
                      void send();
                    }
                  }}
                />
                <div className="flex items-center gap-1 px-1.5 pb-1.5 pt-0.5">
                  <button
                    data-tap
                    type="button"
                    className="w-11 h-11 sm:w-8 sm:h-8 shrink-0 flex items-center justify-center rounded-xl text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] disabled:opacity-40"
                    title="添加附件：也能直接粘贴截图、把文件拖进来"
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
                        className="w-11 h-11 sm:w-8 sm:h-8 shrink-0 flex items-center justify-center rounded-xl hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
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
                    {busy ? (
                      <button
                        data-tap
                        type="button"
                        title="停止这一轮"
                        onClick={() => void stop()}
                        className="w-11 h-11 sm:w-8 sm:h-8 shrink-0 flex items-center justify-center rounded-full border"
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
                        className="w-11 h-11 sm:w-8 sm:h-8 shrink-0 flex items-center justify-center rounded-full transition-colors disabled:opacity-40"
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
              {sessionId && <JobButton count={jobCount} onClick={() => setJobOpen(true)} />}
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
            busy={busy}
            onCollapse={toggleRail}
            onUserClick={async (x, y) => {
              if (!liveRunId) return;
              await fetch(`/api/runs/${liveRunId}/browser-input`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind: "click", x, y }),
              }).catch(() => {});
            }}
            onUserText={async (text) => {
              if (!liveRunId) return;
              await fetch(`/api/runs/${liveRunId}/browser-input`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind: "text", text }),
              }).catch(() => {});
            }}
          />
        ) : (
          <button
            data-tap
            title={browserFrame ? "展开浏览器画面" : "浏览器画面（助手还没上网干活）"}
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
}: {
  sessions: Session[];
  sessionId: string;
  onPick: (id: string) => void;
  onNew: () => void;
  onRename: (s: Session) => void;
  onRemove: (s: Session) => void;
  onCollapse: () => void;
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
  const userBody = isUser
    ? content
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
                title="编辑这条消息（改完保存，之后的对话用它）"
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
