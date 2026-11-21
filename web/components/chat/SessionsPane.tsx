"use client";

/**
 * 会话列表（侧栏）。
 *
 * 从 ChatConsole.tsx 拆出来（约 900 行）：列表自己管搜索、分组折叠、置顶、
 * 行内改名、批量管理、撤销窗口、项目工作区；主组件只管"哪个会话被选中"，
 * 以及把动作转给后端。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, fmt } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { agentColor } from "@/lib/turn";
import type { SearchHit, Session } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { useHistoryLayer } from "@/lib/use-history-layer";
import { isImeEvent } from "@/lib/ime";
import { IconBtn, MenuItem } from "@/components/chat/ChatBits";

/** worker 会话的识别色：Router 是蓝、派出去的活是琥珀、普通对话不上色 */
const WORKER_COLOR = "var(--color-worker)";

export function SessionsPane({
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
  /** 「导出…」展开成两种格式时的目标会话 */
  const [exportFor, setExportFor] = useState<string | null>(null);
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
      {/* 助手会什么不再在侧栏放徽标：它和输入框上方的「技能」按钮开同一块面板，
          两个入口做一件事（侧栏是"会话导航"，技能属于"这个助手会什么"）。
          信息本身在面板里就有，这里不再占位。 */}

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
                                    {/* 导出收成一个入口：两种格式是同一件事的两种壳，
                                        平铺成两行只有选择成本（原来 7 项里 4 项是导出/复制） */}
                                    <MenuItem
                                      label={exportFor === s.id ? "导出 · Markdown" : "导出…"}
                                      onClick={() => {
                                        if (exportFor === s.id) {
                                          setMenuFor(null);
                                          setExportFor(null);
                                          onExport(s);
                                        } else {
                                          setExportFor(s.id);
                                        }
                                      }}
                                    />
                                    {exportFor === s.id && (
                                      <MenuItem
                                        label="导出 · JSON（含事件与用量）"
                                        onClick={() => {
                                          setMenuFor(null);
                                          setExportFor(null);
                                          onExportJson(s);
                                        }}
                                      />
                                    )}
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
            {/* 空对话（0 轮）一键选出来：以前连点「新对话」会攒下一串，删起来得逐条点 */}
            <button
              type="button"
              data-tap
              onClick={() => {
                const empties = sessions.filter((x) => (x.turn_count ?? 0) === 0).map((x) => x.id);
                setSelected(new Set(empties));
              }}
              className="h-8 rounded-[var(--radius-xs)] px-2 text-[length:var(--fs-sm)]"
              style={{ background: "var(--bg-hover)", color: "var(--color-text-2)" }}
            >
              选空对话
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
