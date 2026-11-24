"use client";

/**
 * 消息气泡（用户 / 助手）。
 *
 * 从 ChatConsole.tsx 拆出来（516 行）：气泡自带编辑、重试、回看、
 * 执行详情弹框与用量展示，跟"会话列表""输入坞"没有耦合 —— 拆开后
 * 主组件只剩编排，气泡可以单独改样式而不用碰 5 千行的文件。
 */

import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { api, fmt, withToken } from "@/lib/api";
import type { RunEvent, Session } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { ProcessBar, eventsToSteps, recallProc } from "@/components/ui/run-timeline";
import { useHistoryLayer } from "@/lib/use-history-layer";
import Markdown from "@/components/Markdown";
import { FileRowButton } from "@/components/FileDialog";
import { isImeEvent } from "@/lib/ime";
import { RunDetailById } from "@/components/RunDetailDialog";

/** 时间戳：当天只给 HH:mm；不是今天就带日期（历史会话里只有 14:50 根本判断不出哪天） */
export function fmtStamp(ts: number | string | Date): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return hm;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

/** 气泡里的动作条（复制 / 重试 / 编辑…）：常驻可见，不靠 hover */
export function MsgAction({
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
      /* 桌面「图标 + 文字」、手机纯图标 44px —— 与助手列表的动作条同一套口径；
         之前用户消息只有图标、助手回复是文字，同一个界面上两套写法（验收提到） */
      className="flex h-[44px] items-center justify-center gap-1 rounded-md px-1.5 transition-colors hover:bg-[var(--color-surface-2)] max-md:w-[44px] max-md:px-0"
      style={{ color: tone === "ok" ? "var(--color-ok)" : "var(--color-muted)" }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={path} />
      </svg>
      <span className="max-md:hidden text-[length:var(--fs-sm)]">{label}</span>
    </button>
  );
}

export function Bubble({
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
  /** 长回答折叠：超过 600 字先收成 8 行，展开才全文（回看时不被巨长回答顶走） */
  const [expanded, setExpanded] = useState(false);
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
              <span className="text-[length:var(--fs-sm)] font-medium" style={{ color: "var(--color-accent)" }}>
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
              className="w-full resize-none border-0 bg-transparent px-3 py-2.5 text-[length:var(--fs-md)] leading-relaxed outline-none"
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
                <span className="text-[length:var(--fs-sm)]" style={{ color: "var(--color-muted)" }}>
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
                      className="text-[length:var(--fs-sm)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
                    >
                      在右栏看 →
                    </button>
                  )}
                  <button
                    data-tap
                    onClick={() => setDetailOpen(true)}
                    className="text-[length:var(--fs-sm)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
                  >
                    完整记录 →
                  </button>
                  {meta && (
                    <span className="text-[length:var(--fs-sm)]" style={{ color: "var(--color-muted)" }}>
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
              ? `text-[var(--color-text)] w-fit max-w-full whitespace-pre-wrap [word-break:break-all] ml-auto text-[length:var(--fs-lg)] ${
                  /* 短消息（一行内、无附件）= 胶囊；长消息 = 18px 圆角块，右下角收成 6px
                     （气泡"尾巴"角），右边贴齐。用户要求：气泡样式与尺寸激进一点。 */
                  shortMsg
                    ? "rounded-full px-4 py-2 leading-[1.6]"
                    : "rounded-[18px] rounded-br-[6px] px-3.5 py-2.5 leading-[1.6]"
                }`
              : "text-[length:var(--fs-lg)] leading-[1.8] text-[var(--color-text)] max-w-[46rem]"
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
                        className="inline-flex items-center gap-2 rounded-lg pl-2.5 pr-3 py-2 max-w-[240px] text-[length:var(--fs-sm)] hover:brightness-110"
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
                            <span className="block text-[length:var(--fs-xs)] opacity-80 leading-tight">{fmt.bytes(a.size)}</span>
                          </span>
                        </span>
                      </FileRowButton>
                    ),
                  )}
                </div>
              )}
              {isSteerMsg && (
                <span className="block text-[length:var(--fs-xs)] opacity-80 leading-tight mb-0.5">运行中插话</span>
              )}
              {userBody}
            </>
          ) : (
            (() => {
              const long = !streaming && content.length > 600;
              const collapsed = long && !expanded;
              return (
                <>
                  <div
                    style={
                      collapsed
                        ? { maxHeight: 208, overflow: "hidden", position: "relative" }
                        : undefined
                    }
                  >
                    <Markdown text={content} chat />
                    {collapsed ? (
                      <div
                        aria-hidden
                        className="pointer-events-none absolute inset-x-0 bottom-0 h-12"
                        style={{
                          background:
                            "linear-gradient(to top, var(--color-surface), transparent)",
                        }}
                      />
                    ) : null}
                  </div>
                  {long ? (
                    <button
                      type="button"
                      className="mt-1 text-[length:var(--fs-sm)]"
                      style={{ color: "var(--color-accent)" }}
                      onClick={() => setExpanded((v) => !v)}
                      aria-expanded={expanded}
                    >
                      {expanded ? "收起" : `展开全文 · ${content.length} 字`}
                    </button>
                  ) : null}
                </>
              );
            })()
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
              <span className="mr-1.5 text-[length:var(--fs-xs)] tabular-nums" style={{ color: "var(--color-muted)" }}>
                {/* ts 是**毫秒**时间戳（后端 now_ms 落库）。以前这里又乘了 1000，
                    年月直接溢出到几万年后，时间显示成 14:50 / 03:12 这种随机值 ——
                    同一个会话里时间跳来跳去，用户会怀疑对话被改过。 */}
                {fmtStamp(ts)}
              </span>
            ) : null}

            {confirmRewind ? (
              /* 破坏性动作在**原地**确认，不弹窗、不跳位 */
              <span
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1"
                style={{ background: "color-mix(in srgb, var(--color-err) 10%, transparent)" }}
              >
                <span className="text-[length:var(--fs-sm)]" style={{ color: "var(--color-err)" }}>
                  删掉这轮和之后的消息？
                </span>
                <button
                  data-tap
                  className="rounded px-1.5 py-0.5 text-[length:var(--fs-sm)] font-medium"
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
                  className="rounded px-1.5 py-0.5 text-[length:var(--fs-sm)]"
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
