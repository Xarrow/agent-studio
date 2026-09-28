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
import type { Agent, RunEvent, Session } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { RunTimeline, eventsToSteps, summarize } from "@/components/ui/run-timeline";
import { ProcessRail } from "@/components/ProcessRail";
import { SlashMenu, type CommandItem } from "@/components/SlashMenu";
import { useImeGuard } from "@/lib/ime";
import Markdown from "@/components/Markdown";
import { RunDetailById } from "@/components/RunDetailDialog";
import { AgentDetailDialog } from "@/components/AgentDetailDialog";

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
  const [detailRun, setDetailRun] = useState<string | null>(null);
  /** `/` 命令菜单是否打开（输入以 / 开头时） */
  const [slashOpen, setSlashOpen] = useState(false);
  /** 输入法守卫：中文组字没上屏时按 Enter 是「选字」，不能当发送 */
  const ime = useImeGuard();
  /** 服务器上的存放路径 —— 界面上说清"这些对话存在哪"（自托管必须让用户能核对） */
  const [paths, setPaths] = useState<Awaited<ReturnType<typeof api.paths>> | null>(null);
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
    { role: "user" | "assistant"; content: string; run_id: string | null; turn_index: number }[]
  >([]);
  /** 当前正在流式生成的内容 */
  const [live, setLive] = useState<LiveMsg | null>(null);
  /** 正在生成的这次执行的**全部事件**（用来实时画分色过程） */
  const [liveEvents, setLiveEvents] = useState<RunEvent[]>([]);
  /** 本次发送的内容（作为执行过程的第一段「输入」） */
  const [liveInput, setLiveInput] = useState("");
  /** 正在跑的这一轮的 run id —— 停止时要拿它去 abort 后端 */
  const [liveRunId, setLiveRunId] = useState("");
  /** 待发送的附件（已上传，拿绝对路径注入消息让助手用 Read 读） */
  const [pendingFiles, setPendingFiles] = useState<{ name: string; path: string }[]>([]);
  const [busy, setBusy] = useState(false);
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
            content: m.content,
            run_id: m.run_id,
            turn_index: m.turn_index,
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
    void loadMessages(sessionId);
  }, [sessionId, loadMessages]);

  // 自动滚到底
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, live]);

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
    const ok = await fb.confirm({
      title: `删除对话「${s.title || s.id}」？`,
      description: "对话记录会被删除，但执行记录（Runs）会保留，可在调试台查看。",
      details: [`${s.turn_count} 轮对话`, `${s.message_count} 条消息`],
      danger: true,
      confirmText: "删除",
    });
    if (!ok) return;
    try {
      await api.deleteSession(s.id);
      const list = await loadSessions(agentId);
      if (s.id === sessionId) {
        setSessionId(list.length > 0 ? list[0].id : "");
      }
      fb.success("已删除");
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
        setLiveEvents((prev) => [...prev, ev]);
        const p = ev.payload as Record<string, unknown>;
        if (ev.type === "text_delta") {
          const t = typeof p.text === "string" ? p.text : typeof p.delta === "string" ? p.delta : "";
          setLive((prev) => (prev ? { role: "assistant", text: prev.text + t } : prev));
        }
      } catch {
        /* ignore */
      }
    };

    const settle = async () => {
      es.close();
      setBusy(false);
      setLiveRunId("");
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
        ? "\n\n" + pendingFiles.map((f) => `[附件] ${f.path}（${f.name}，可用 Read 工具读取）`).join("\n")
        : "";
    const composed = (text || "（请处理附件）") + attachNote;

    setFailed(null);
    setHitl(null);
    setInput("");
    setPendingFiles([]);
    setBusy(true);
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

  /** 选了文件 → 上传 → 进待发清单（路径注入方案，见 send()） */
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const pickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const items = await Promise.all([...files].map((f) => api.uploadFile(f)));
      setPendingFiles((prev) => [
        ...prev,
        ...items.map((it) => ({ name: it.name, path: it.path })),
      ]);
    } catch (e) {
      fb.error("附件上传失败", e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

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
          <p className="text-[12.5px] text-[var(--color-muted)] leading-relaxed mb-4">
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
    <div className="h-full min-h-0 flex flex-col lg:flex-row">
      {configAgent && (
        <AgentDetailDialog agentId={configAgent} onClose={() => setConfigAgent(null)} />
      )}
      {/* ── 会话列表 ─────────────────────────────────────────── */}
      <aside className="lg:w-64 shrink-0 border-b lg:border-b-0 lg:border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col max-h-[38vh] lg:max-h-none">
        <div className="p-3 border-b border-[var(--color-border)]">
          <button className="btn btn-primary w-full" onClick={() => void newChat()}>
            + 新对话
          </button>
        </div>
        <div className="flex-1 overflow-auto p-2 space-y-0.5">
          {sessions.length === 0 ? (
            <p className="text-[12px] text-[var(--color-muted)] p-2">还没有对话</p>
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                className={`group flex items-center gap-1 rounded-md px-2 py-2 cursor-pointer transition-colors ${
                  s.id === sessionId
                    ? "bg-[var(--color-surface-2)] text-[var(--color-accent)]"
                    : "text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]"
                }`}
                onClick={() => setSessionId(s.id)}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] truncate">{s.title || "未命名对话"}</div>
                  <div className="text-[10.5px] opacity-70 truncate">
                    {s.turn_count} 轮 · {fmt.relative(s.last_active_at)}
                  </div>
                </div>
                <button
                  className="shrink-0 w-9 h-9 flex items-center justify-center rounded-md text-[13px] text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] lg:w-7 lg:h-7 lg:opacity-0 lg:group-hover:opacity-100"
                  data-tap-lg
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation();
                    void renameSession(s);
                  }}
                >
                  ✎
                </button>
                <button
                  className="shrink-0 w-9 h-9 flex items-center justify-center rounded-md text-[13px] text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-err)] lg:w-7 lg:h-7 lg:opacity-0 lg:group-hover:opacity-100"
                  data-tap-lg
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeSession(s);
                  }}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* ── 对话区 ───────────────────────────────────────────── */}
      <section className="flex-1 flex flex-col min-h-0 min-w-0">
        <header className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-3 flex-wrap">
          {/* 受外层控制时不显示自带的助手下拉 —— 参与者条是唯一入口，
              两处都能选助手就是两套真相 */}
          {controlledAgentId === undefined && (
            <select
              className="input w-auto min-w-[160px]"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          {controlledAgentId !== undefined && (
            <span className="text-[13.5px] font-medium truncate">
              {currentAgent?.name ?? "（未选助手）"}
            </span>
          )}
          <span className="text-[11.5px] text-[var(--color-muted)] truncate">
            {currentAgent?.description || "runtime-agnostic Agent"}
          </span>
          <div className="ml-auto flex items-center gap-3">
            {history.length > 0 && history[history.length - 1].run_id && (
              <>
                <button
                  data-tap
                  className="text-[11.5px] hover:underline whitespace-nowrap"
                  style={{ color: "var(--color-accent)" }}
                  onClick={() => setDetailRun(history[history.length - 1].run_id ?? null)}
                >
                  查看详情 →
                </button>
                {detailRun && (
                  <RunDetailById runId={detailRun} onClose={() => setDetailRun(null)} />
                )}
              </>
            )}
            {/* 「配置」用整屏浮层打开，不跳页 —— 正在聊的时候去改配置，
                回来时对话、输入框、滚动位置都还在（跳页就全丢了） */}
            {agentId && (
              <button
                data-tap
                className="text-[11.5px] text-[var(--color-muted)] hover:text-[var(--color-text)] whitespace-nowrap"
                onClick={() => setConfigAgent(agentId)}
              >
                配置
              </button>
            )}
          </div>
        </header>

        {/* 消息流 */}
        <div className="flex-1 overflow-auto px-4 py-5" ref={boxRef}>
          {history.length === 0 && !live ? (
            <div className="max-w-lg mx-auto text-center mt-8">
              <p className="text-[15px] font-medium">开始和「{currentAgent?.name || "Agent"}」对话</p>
              <p className="text-[12.5px] text-[var(--color-muted)] mt-2">
                它会记住这个对话里说过的内容，也会用上你教过它的长期记忆。
              </p>
            </div>
          ) : (
            <div className="max-w-4xl mx-auto space-y-5">
              {history.map((m, i) => {
                // 给助手的执行过程带上「用户说了什么」，这样六段里第一段（输入）有着落
                const prevUser =
                  m.role === "assistant"
                    ? ([...history.slice(0, i)].reverse().find((x) => x.role === "user")?.content ?? undefined)
                    : undefined;
                return (
                  <Bubble
                    key={i}
                    role={m.role}
                    content={m.content}
                    runId={m.run_id}
                    userInput={prevUser}
                  />
                );
              })}

              {/* 生成中：实时分色显示执行过程（思考 / 工具 / 结果 / 回答） */}
              {busy && liveEvents.length > 0 && (
                <div className="w-full">
                  <div className="text-[11.5px] text-[var(--color-muted)] mb-2 flex items-center gap-1.5">
                    <span className="live-dot">●</span> 执行中…
                  </div>
                  <RunTimeline steps={eventsToSteps(liveEvents, liveInput)} compact />
                </div>
              )}
              {busy && liveEvents.length === 0 && (
                <div className="text-[12.5px] text-[var(--color-muted)] live-dot">思考中…</div>
              )}
            </div>
          )}
          <div ref={endRef} />
        </div>

        {/* 输入区 */}
        <div className="border-t border-[var(--color-border)] px-4 py-3">
          {/* 这一轮停在等你授权 —— 就地确认，聊天现场不跳不丢 */}
          {hitl && (
            <div className="max-w-3xl mx-auto mb-2">
              <HitlPrompt
                runId={hitl.runId}
                payload={hitl.payload}
                onBeforeResume={() => attachStream(hitl.runId, liveInput)}
                onResumed={() => setBusy(true)}
                onError={(m) => fb.error("恢复失败", m)}
              />
            </div>
          )}

          {/* 上一轮失败了 —— 摆出来 + 一键重试（失败后最常见的动作就是再试一次） */}
          {failed && (
            <div
              className="max-w-3xl mx-auto mb-2 rounded-md px-3 py-2 flex items-start gap-3 flex-wrap text-[12px]"
              style={{
                background: "color-mix(in srgb, var(--color-err) 10%, transparent)",
                color: "var(--color-err)",
              }}
            >
              <span className="flex-1 min-w-[200px] break-words">
                这一轮失败了：{failed.message}
              </span>
              <button
                className="btn btn-sm shrink-0"
                disabled={busy}
                onClick={() => void send(failed.text)}
              >
                重试
              </button>
              <button
                className="text-[11.5px] shrink-0 hover:underline"
                onClick={() => setFailed(null)}
              >
                忽略
              </button>
            </div>
          )}
          <div className="max-w-4xl mx-auto flex gap-2 items-end relative">
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => void pickFiles(e.target.files)}
            />
            <button
              className="btn shrink-0 w-10 px-0"
              title="附件（助手会用 Read 工具读）"
              disabled={busy || uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? "…" : "📎"}
            </button>
            <textarea
              className="input flex-1 resize-none text-[13px]"
              rows={1}
              style={{ maxHeight: "9rem" }}
              placeholder={pendingFiles.length > 0 ? `附了 ${pendingFiles.length} 个文件，说点什么…` : "发消息…（Enter 发送，Shift + Enter 换行）"}
              value={input}
              disabled={busy}
              {...ime.props}
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
            {busy ? (
              <button className="btn text-[var(--color-warn)]" onClick={() => void stop()}>
                停止
              </button>
            ) : (
              <button
                className="btn btn-primary"
                disabled={!input.trim() && pendingFiles.length === 0}
                onClick={() => void send()}
              >
                发送
              </button>
            )}
          </div>
          {/* 待发附件 —— 名字即所见，点 ✕ 撤掉（还没进消息，撤掉零成本） */}
          {pendingFiles.length > 0 && (
            <div className="max-w-4xl mx-auto mt-2 flex flex-wrap gap-1.5">
              {pendingFiles.map((f, i) => (
                <span
                  key={f.path + i}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px]"
                  style={{ background: "var(--color-surface-2)" }}
                >
                  {f.name}
                  <button
                    data-tap
                    className="text-[var(--color-muted)] hover:text-[var(--color-err)]"
                    title="撤掉"
                    onClick={() => setPendingFiles((p) => p.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          {/* 存在哪 —— 自托管平台上，用户随时能核对落点（点一下复制路径） */}
          {paths && (
            <div
              className="max-w-4xl mx-auto mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]"
              style={{ color: "var(--color-muted)" }}
            >
              <span>会话保存在服务器</span>
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
              <span>· 助手干活的工作目录</span>
              <span className="mono">{paths.work_dir}</span>
            </div>
          )}
        </div>
      </section>

      {/* 右栏执行过程（xl 起常驻；手机/平板用消息内折叠条 —— 同一数据两个视口形态） */}
      <ProcessRail
        liveEvents={liveEvents}
        busy={busy}
        liveInput={liveInput}
        lastRunId={
          !busy && history.length > 0 ? history[history.length - 1].run_id : null
        }
      />
    </div>
  );
}

/** 一条消息气泡：用户靠右，助手靠左；助手消息可展开**完整执行过程** */
function Bubble({
  role,
  content,
  runId,
  userInput,
  streaming = false,
}: {
  role: "user" | "assistant";
  content: string;
  runId?: string | null;
  /** 这一轮里用户说了什么（用于执行过程的第一段「输入」） */
  userInput?: string;
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

  const hasTrace = !isUser && !!runId && !streaming;

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

  const steps = events ? eventsToSteps(events, userInput) : [];

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={isUser ? "max-w-[85%]" : "min-w-0 flex-1"}>
        <div
          className={`rounded-lg px-3.5 py-2.5 text-[13.5px] leading-relaxed break-words ${
            isUser ? "text-white w-fit ml-auto whitespace-pre-wrap" : ""
          }`}
          style={
            isUser
              ? { background: "var(--color-accent)" }
              : { background: "var(--color-surface-2)", color: "var(--color-text)" }
          }
        >
          {isUser ? (
            content
          ) : (
            <Markdown text={content} />
          )}
          {streaming && <span className="live-dot ml-0.5">▍</span>}
        </div>

        {hasTrace && (
          <div className="mt-1.5">
            <div className="flex items-center gap-3 flex-wrap">
              <button
                data-tap
                onClick={() => void toggle()}
                className="text-[11.5px] text-[var(--color-accent)] hover:underline flex items-center gap-1"
              >
                <span>{open ? "▾" : "▸"}</span>
                执行过程
                {events && events.length > 0 && (
                  <span className="text-[var(--color-muted)]">
                    （{summarize(steps)}）
                  </span>
                )}
              </button>
              <button
                data-tap
                onClick={() => setDetailOpen(true)}
                className="text-[11.5px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
              >
                完整记录 →
              </button>
              {meta && (
                <span className="text-[11px] text-[var(--color-muted)]">
                  {meta.tokens > 0 ? `${fmt.int(meta.tokens)} tokens · ` : ""}
                  {fmt.ms(meta.seconds * 1000)}
                </span>
              )}
              {detailOpen && runId && (
                <RunDetailById runId={runId} onClose={() => setDetailOpen(false)} />
              )}
            </div>

            {open && (
              <div
                className="mt-2 p-3 rounded-lg"
                style={{
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-border)",
                }}
              >
                {loadingEv ? (
                  <div className="text-[12.5px] text-[var(--color-muted)]">加载执行过程…</div>
                ) : steps.length === 0 ? (
                  <div className="text-[12.5px] text-[var(--color-muted)]">
                    这次执行没有可展示的步骤。
                  </div>
                ) : (
                  <RunTimeline steps={steps} />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
