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
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { Agent, RunEvent, Session } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { RunTimeline, eventsToSteps, summarize } from "@/components/ui/run-timeline";
import { RunDetailById } from "@/components/RunDetailDialog";
import { AgentDetailDialog } from "@/components/AgentDetailDialog";

/** 流式渲染期间的一条临时消息 */
interface LiveMsg {
  role: "user" | "assistant";
  text: string;
}

export function ChatConsole() {
  const fb = useFeedback();

  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState<string>("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
  // 执行详情用弹框看，不跳页 —— 聊天上下文（输入框内容、滚动位置）不该
  // 因为「想看一眼这轮到底怎么回事」而丢掉。
  const [detailRun, setDetailRun] = useState<string | null>(null);
  /** 正在浮层里配置的助手（从对话页直接打开，不离开对话） */
  const [configAgent, setConfigAgent] = useState<string | null>(null);

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
        const list = await api.agents();
        setAgents(list);
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

  const send = async () => {
    const text = input.trim();
    if (!text || busy || !sessionId || !agentId) return;

    setInput("");
    setBusy(true);
    setLive({ role: "user", text });
    // 直接进入助手流式态（user 消息由 live 显示，完成后由 history 接管）
    const userEcho = { role: "user" as const, content: text, run_id: null, turn_index: 0 };
    setHistory((h) => [...h, userEcho]);
    setLive({ role: "assistant", text: "" });
    setLiveEvents([]);
    setLiveInput(text);

    try {
      const run = await api.createRun({
        agent_id: agentId,
        input: text,
        session_id: sessionId,
        origin: "chat",
      });

      const es = new EventSource(api.streamUrl(run.id));
      esRef.current = es;

      const onDelta = (e: MessageEvent) => {
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
      es.onmessage = onDelta;

      es.addEventListener("done", async () => {
        es.close();
        setLive(null);
        setBusy(false);
        // 用服务端的权威历史覆盖（包含刚写入的这一轮）
        await loadMessages(sessionId);
        await loadSessions(agentId);
      });

      es.onerror = async () => {
        es.close();
        setLive(null);
        setBusy(false);
        await loadMessages(sessionId);
        await loadSessions(agentId);
      };
    } catch (e) {
      fb.error("发送失败", e instanceof Error ? e.message : String(e));
      setLive(null);
      setBusy(false);
    }
  };

  const stop = async () => {
    // 关流 + 中止后端执行
    esRef.current?.close();
    setLive(null);
    setBusy(false);
    fb.warn("已停止接收输出", "后端可能仍在执行，可在 Runs 里查看结果");
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
    <div className="h-full flex flex-col lg:flex-row">
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
                  className="shrink-0 w-9 h-9 flex items-center justify-center rounded-md text-[13px] text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] md:w-7 md:h-7 md:opacity-0 md:group-hover:opacity-100"
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation();
                    void renameSession(s);
                  }}
                >
                  ✎
                </button>
                <button
                  className="shrink-0 w-9 h-9 flex items-center justify-center rounded-md text-[13px] text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-err)] md:w-7 md:h-7 md:opacity-0 md:group-hover:opacity-100"
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
      <section className="flex-1 flex flex-col min-w-0">
        <header className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-3 flex-wrap">
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
          <span className="text-[11.5px] text-[var(--color-muted)] truncate">
            {currentAgent?.description || "runtime-agnostic Agent"}
          </span>
          <div className="ml-auto flex items-center gap-3">
            {history.length > 0 && history[history.length - 1].run_id && (
              <>
                <button
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
            <div className="max-w-3xl mx-auto space-y-5">
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
          <div className="max-w-3xl mx-auto flex gap-2 items-end">
            <textarea
              className="input flex-1 resize-none text-[13px]"
              rows={1}
              style={{ maxHeight: "9rem" }}
              placeholder="发消息…（Enter 发送，Shift + Enter 换行）"
              value={input}
              disabled={busy}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {busy ? (
              <button className="btn text-[var(--color-warn)]" onClick={() => void stop()}>
                停止
              </button>
            ) : (
              <button className="btn btn-primary" disabled={!input.trim()} onClick={() => void send()}>
                发送
              </button>
            )}
          </div>
        </div>
      </section>
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
        setEvents(await api.runEvents(runId));
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
          className={`rounded-lg px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words ${
            isUser ? "text-white w-fit ml-auto" : ""
          }`}
          style={
            isUser
              ? { background: "var(--color-accent)" }
              : { background: "var(--color-surface-2)", color: "var(--color-text)" }
          }
        >
          {content}
          {streaming && <span className="live-dot ml-0.5">▍</span>}
        </div>

        {hasTrace && (
          <div className="mt-1.5">
            <div className="flex items-center gap-3 flex-wrap">
              <button
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
                onClick={() => setDetailOpen(true)}
                className="text-[11.5px] text-[var(--color-muted)] hover:text-[var(--color-text)]"
              >
                完整记录 →
              </button>
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
