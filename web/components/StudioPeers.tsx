"use client";

/**
 * 「节点」区块：把一个**别的 Agent Studio** 接进来。
 *
 * 为什么做成"一行一个节点 + 就地展开"，而不是弹窗向导：
 * 用户要的是"填个地址、看一眼、确认"这三件事连着做完；弹窗会遮住列表，
 * 还得出一次错回去改地址。这里错误就显示在输入框下面。
 *
 * 三类行：
 *   待接受（direction=in & pending）—— 对方连我，我点头才成立
 *   对端节点（我连的 / 互相连的）—— 展开看它开放了哪些助手
 *   内网对端 —— 会明确写"由对方发心跳"，因为它不会显示成"在线/离线"的常规心跳
 */

import { useCallback, useEffect, useState } from "react";

import { api } from "@/lib/api";
import type { StudioPeer, StudioPeerAgent, StudioPeerRemote } from "@/lib/types";
import { Chip, KV, Section, Switch } from "@/components/ui/kit";
import { DetailPanel } from "@/components/ui/DetailPanel";
import { useFeedback } from "@/components/ui/feedback";

function ago(ts?: number | null): string {
  if (!ts) return "从未";
  const d = Math.max(0, Date.now() - ts);
  if (d < 60_000) return "刚刚";
  if (d < 3_600_000) return `${Math.round(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} 小时前`;
  return `${Math.round(d / 86_400_000)} 天前`;
}

const STATUS: Record<string, { label: string; tone: "ok" | "warn" | "err" | "muted" }> = {
  active: { label: "正常", tone: "ok" },
  pending: { label: "待接受", tone: "warn" },
  offline: { label: "离线", tone: "err" },
  rejected: { label: "已拒绝", tone: "muted" },
  revoked: { label: "已撤销", tone: "muted" },
};

/** 状态点：比一排彩色胶囊安静，扫一眼就知道状态 */
function Dot({ tone }: { tone: "ok" | "warn" | "err" | "muted" }) {
  const color =
    tone === "ok" ? "var(--color-ok, #16a34a)"
    : tone === "warn" ? "var(--color-warn, #d97706)"
    : tone === "err" ? "var(--color-err)"
    : "var(--color-text-3)";
  return (
    <span
      aria-hidden
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: color }}
    />
  );
}

/** 口令掩码：只露头尾，避免整串糊在屏幕上 */
function maskToken(t: string): string {
  if (!t) return "";
  if (t.length <= 10) return t;
  return `${t.slice(0, 5)}••••••${t.slice(-4)}`;
}

const ARUN: Record<string, { label: string; tone: "ok" | "warn" | "err" | "muted" }> = {
  ok: { label: "可用", tone: "ok" },
  unknown: { label: "未检测", tone: "muted" },
  error: { label: "异常", tone: "err" },
};

/** 节点图标（内联描边，不用 emoji 也不引第三方） */
function IconNode() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7.5h.01M7 17h.01" />
    </svg>
  );
}

export function StudioPeers({ onSynced }: { onSynced?: () => void }) {
  const fb = useFeedback();
  const [peers, setPeers] = useState<StudioPeer[] | null>(null);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [mutual, setMutual] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    name?: string;
    agents: { id: string; name?: string; description?: string }[];
    private: boolean;
  } | null>(null);

  // 逐级展开：节点（点开看它下面的助手）→ 助手（点开看详情）

  const [nodeAgents, setNodeAgents] = useState<Record<string, StudioPeerAgent[]>>({});
  //: 点开节点时读到的对端名片（"远程的详情"就是这个）
  const [nodeRemote, setNodeRemote] = useState<Record<string, StudioPeerRemote | null>>({});
  const [nodeErr, setNodeErr] = useState<Record<string, string>>({});
  const [nodeStale, setNodeStale] = useState<Record<string, boolean>>({});
  const [nodeAge, setNodeAge] = useState<Record<string, number>>({});
  //: 右侧抽屉：选中的节点 / 助手（一次只开一个，与全站详情一致）
  const [selNode, setSelNode] = useState<string | null>(null);
  const [selAgentId, setSelAgentId] = useState<string | null>(null);
  //: 本节点的连接口令（对端要填它才能读我的清单）
  const [myToken, setMyToken] = useState<string>("");
  const [tokenInput, setTokenInput] = useState("");
  //: 某个节点正在编辑对端口令
  const [editPeer, setEditPeer] = useState<string | null>(null);
  const [peerTokenDraft, setPeerTokenDraft] = useState("");

  const load = useCallback(async () => {
    try {
      const got = await api.studioPeers();
      setPeers(got.peers);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    void api.studioToken().then((r) => setMyToken(r.token)).catch(() => undefined);
  }, [load]);

  const loadAgents = useCallback(async (peerId: string, live = false) => {
    try {
      const got = await api.studioPeerAgents(peerId, live);
      setNodeAgents((prev) => ({ ...prev, [peerId]: got.agents }));
      setNodeRemote((prev) => ({ ...prev, [peerId]: got.remote }));
      setNodeErr((prev) => ({ ...prev, [peerId]: got.remote_error || "" }));
      setNodeStale((prev) => ({ ...prev, [peerId]: Boolean(got.remote_stale) }));
      if (typeof got.remote_age_ms === "number") {
        setNodeAge((prev) => ({ ...prev, [peerId]: got.remote_age_ms as number }));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const openNode = async (peerId: string) => {
    setSelNode(peerId);
    setSelAgentId(null);
    if (nodeAgents[peerId] === undefined) await loadAgents(peerId);
  };

  const toggleAgent = async (agentId: string, enabled: boolean, peerId?: string) => {
    try {
      // 调用方自己的开关：停用后这个远端助手不再出现在助手的可挂载清单里
      await api.patchRemoteAgent(agentId, { enabled });
      fb.success(enabled ? "已启用" : "已停用");
      if (peerId) await loadAgents(peerId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      if (ok) fb.success(ok);
      await load();
      onSynced?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doPreview = () =>
    run("preview", async () => {
      const got = await api.studioPeersPreview(url.trim());
      setPreview({ name: got.name, agents: got.agents || [], private: got.private });
    });

  const doConnect = () =>
    run(
      "connect",
      async () => {
        const got = await api.studioPeerConnect(url.trim(), mutual, tokenInput.trim());
        setOpen(false);
        setPreview(null);
        setUrl("");
        setTokenInput("");
        if (got.notes?.length) fb.success(got.notes.join("；"));
      },
      "已连接",
    );

  const selPeer = (peers ?? []).find((p) => p.id === selNode) ?? null;
  const selAgents = selNode ? nodeAgents[selNode] : undefined;
  const selAgent = (selAgents ?? []).find((a) => a.id === selAgentId) ?? null;
  const remote = selNode ? nodeRemote[selNode] : null;
  const agents = selAgents;

  const pending = (peers ?? []).filter((p) => p.status === "pending");
  const active = (peers ?? []).filter((p) => p.status !== "pending");

  return (
    <div className="mt-5">
      <Section
        title="节点"
        desc="连接另一个 Agent Studio，把它开放的助手同步到这里"
        right={
          <button className="btn btn-sm" onClick={() => { setOpen((v) => !v); setErr(null); setPreview(null); }}>
            {open ? "取消" : "＋ 连接节点"}
          </button>
        }
      >
        {/* 本节点的连接口令：对端连我时要填它（公开接口只暴露名片，清单要口令） */}
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md px-2.5 py-2"
             style={{ background: "var(--color-surface-2)" }}>
          <span className="shrink-0 text-[12px]" style={{ color: "var(--color-text-2)" }}>本节点连接口令</span>
          <code className="mono min-w-0 flex-1 truncate text-[11px]" title="对端连我时要填它">
            {myToken ? maskToken(myToken) : "（读取中…）"}
          </code>
          <span className="hidden text-[11px] sm:inline" style={{ color: "var(--color-text-3)" }}>
            对端读我的助手清单 / 握手 / 心跳时要用
          </span>
          <button className="btn btn-sm" disabled={!myToken}
                  onClick={() => { void navigator.clipboard?.writeText(myToken); fb.success("连接口令已复制"); }}>
            复制
          </button>
          <button className="btn btn-sm" disabled={!myToken || busy === "rotate"}
                  onClick={() => {
                    if (!window.confirm("轮换口令后，已连上的对端需要重新填新口令，确定轮换？")) return;
                    void run("rotate", async () => {
                      const r = await api.studioTokenRotate();
                      setMyToken(r.token);
                    }, "口令已轮换");
                  }}>
            轮换
          </button>
        </div>

        {open && (
          <div className="mb-3 rounded-lg border p-3" style={{ borderColor: "var(--color-line)" }}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                className="input flex-1"
                placeholder="另一台 Agent Studio 的地址，如 https://as.example.com"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setPreview(null); setErr(null); }}
              />
              <button className="btn btn-sm shrink-0" disabled={!url.trim() || busy === "preview"} onClick={doPreview}>
                {busy === "preview" ? "连接中…" : "先看一下"}
              </button>
            </div>
            <input
              className="input mt-2"
              placeholder="对方的连接口令（在对方「节点」区块复制，nd_ 开头）"
              value={tokenInput}
              onChange={(e) => { setTokenInput(e.target.value); setErr(null); }}
            />
            <label className="mt-2 flex items-center gap-2 text-[12px]" style={{ color: "var(--color-text-2)" }}>
              <Switch checked={mutual} onChange={setMutual} ariaLabel="双向连接" />
              双向连接（对方那边也会出现一条待接受的请求）
            </label>

            {preview && (
              <div className="mt-2 rounded-md p-2.5" style={{ background: "var(--color-surface-2)" }}>
                <div className="text-[12px]">
                  能连上：<span className="font-medium">{preview.name || "未命名节点"}</span>
                  ，开放 {preview.agents.length} 个助手
                  {preview.private ? "（内网地址：不会由本机发心跳）" : ""}
                </div>
                {preview.agents.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {preview.agents.map((a) => (
                      <Chip key={a.id}>{a.name || a.id}</Chip>
                    ))}
                  </div>
                )}
                <button
                  className="btn btn-primary btn-sm mt-2"
                  disabled={busy === "connect"}
                  onClick={doConnect}
                >
                  {busy === "connect" ? "连接中…" : "确认连接"}
                </button>
              </div>
            )}
            {err && (
              <div className="mt-2 text-[12px]" style={{ color: "var(--color-err)" }}>{err}</div>
            )}
          </div>
        )}

        {pending.length > 0 && (
          <div className="mb-2">
            {pending.map((p) => (
              <div
                key={p.id}
                className="mb-1.5 flex flex-wrap items-center gap-2 rounded-md py-2 pl-2.5 pr-2"
                style={{
                  background: "color-mix(in srgb, var(--color-warn, #d97706) 7%, transparent)",
                  borderLeft: "3px solid var(--color-warn, #d97706)",
                }}
              >
                <Chip tone="warn">待接受</Chip>
                <span className="text-[13px] font-medium">{p.name}</span>
                <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                  {p.agents_count} 个助手 · {ago(p.last_seen_at)}请求连接你
                </span>
                <span className="ml-auto flex gap-1.5">
                  <button className="btn btn-sm btn-primary" disabled={busy === p.id}
                          onClick={() => run(p.id, () => api.studioPeerAccept(p.id), "已接受")}>
                    接受
                  </button>
                  <button className="btn btn-sm" disabled={busy === p.id}
                          onClick={() => run(p.id, () => api.studioPeerReject(p.id), "已拒绝")}>
                    拒绝
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        {peers === null ? (
          <div className="space-y-2" aria-label="加载中">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-9 animate-pulse rounded-md" style={{ background: "var(--color-line)" }} />
            ))}
          </div>
        ) : active.length === 0 && pending.length === 0 ? (
          <div
            className="rounded-md border border-dashed px-3 py-4 text-[12px]"
            style={{ borderColor: "var(--color-line)", color: "var(--color-text-3)" }}
          >
            还没有节点。点右上「＋ 连接节点」，填上对方地址和它的连接口令；
            连上之后，点节点就能看到它开放了哪些助手。
          </div>
        ) : (          active.map((p) => {
            const st = STATUS[p.status] ?? STATUS.active;
            const isSel = selNode === p.id;
            return (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                onClick={() => void openNode(p.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void openNode(p.id);
                  }
                }}
                className="flex min-h-[52px] cursor-pointer items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-[var(--bg-hover,rgba(0,0,0,0.03))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent,#2563eb)]"
                style={isSel ? { background: "var(--bg-selected)" } : undefined}
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg"
                      style={{ background: "color-mix(in srgb, var(--color-accent) 10%, transparent)", color: "var(--color-accent)" }}>
                  <IconNode />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">{p.name}</span>
                    <span className="flex items-center gap-1 text-[11px]" style={{ color: "var(--color-text-2)" }}>
                      <Dot tone={st.tone} />
                      {st.label}
                    </span>
                    {p.direction === "both" && (
                      <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>互相连接</span>
                    )}
                    {!p.heartbeat && (
                      <span className="text-[11px]" style={{ color: "var(--color-text-3)" }} title="对方是内网地址：由它发心跳给我">
                        仅对方心跳
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px]" style={{ color: "var(--color-text-3)" }}>
                    {p.base_url || "地址未知"} · 已同步 {p.agents_synced}/{p.agents_count} 个助手 · 上次同步 {ago(p.last_sync_at)}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="btn btn-sm"
                    disabled={busy === p.id || !p.base_url}
                    onClick={() => { void run(p.id, () => api.studioPeerSync(p.id), "已同步"); }}
                  >
                    同步
                  </button>
                  <button
                    className="btn btn-sm"
                    style={{ color: "var(--color-err)" }}
                    disabled={busy === p.id}
                    onClick={() => {
                      if (!window.confirm(`移除节点「${p.name}」？它同步过来的助手会一起删掉。`)) return;
                      void run(p.id, () => api.studioPeerRemove(p.id), "已移除").then(() => setSelNode(null));
                    }}
                  >
                    移除
                  </button>
                </span>
              </div>
            );
          })
        )}
      </Section>

      {/* 节点 / 助手详情：统一走右侧抽屉（与技能、记忆、凭据、远程 Agent 列表同一套壳） */}
      {/* 一次只开一个抽屉：看助手详情时，节点抽屉让位（关掉助手就回到节点） */}
      {selPeer && !selAgent && (
        <DetailPanel
          title={selPeer.name}
          subtitle={
            <>
              <span className="flex items-center gap-1">
                <Dot tone={(STATUS[selPeer.status] ?? STATUS.active).tone} />
                {(STATUS[selPeer.status] ?? STATUS.active).label}
              </span>
              <span>·</span>
              <span>{selPeer.base_url || "地址未知"}</span>
              <span>·</span>
              <span>已同步 {selPeer.agents_synced}/{selPeer.agents_count} 个助手</span>
            </>
          }
          icon={<IconNode />}
          facts={[
            { icon: <span aria-hidden>💓</span>, text: selPeer.heartbeat ? "本机每 60 秒心跳" : "由对方发心跳" },
            { icon: <span aria-hidden>⏱</span>, text: `上次同步 ${ago(selPeer.last_sync_at)}` },
            { icon: <span aria-hidden>🔗</span>, text: selPeer.direction === "both" ? "互相连接" : selPeer.direction === "in" ? "对方连我" : "本机连它" },
          ]}
          actions={
            <>
              <button
                className="btn btn-primary btn-sm"
                disabled={busy === `${selPeer.id}:sync` || !selPeer.base_url}
                onClick={() => {
                  void run(`${selPeer.id}:sync`, () => api.studioPeerSync(selPeer.id), "已同步")
                    .then(() => loadAgents(selPeer.id));
                }}
              >
                同步助手
              </button>
              <button
                className="btn btn-sm"
                disabled={busy === `${selPeer.id}:live`}
                onClick={() => run(`${selPeer.id}:live`, () => loadAgents(selPeer.id, true))}
              >
                刷新对端详情
              </button>
              <button
                className="btn btn-sm"
                style={{ color: "var(--color-err)" }}
                onClick={() => {
                  if (!window.confirm(`移除节点「${selPeer.name}」？它同步过来的助手会一起删掉。`)) return;
                  void run(selPeer.id, () => api.studioPeerRemove(selPeer.id), "已移除")
                    .then(() => { setSelNode(null); setSelAgentId(null); });
                }}
              >
                移除节点
              </button>
            </>
          }
          onClose={() => { setSelNode(null); setSelAgentId(null); }}
        >
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
              <KV k="节点 ID"><code className="mono text-[11px]">{remote?.studio_id || selPeer.studio_id}</code></KV>
              <KV k="版本">{remote?.version ? `${remote.version}（${remote.protocol || "studio/1"}）` : "—"}</KV>
              <KV k="助手">{remote ? `对端开放 ${remote.agents_open ?? 0} / 共 ${remote.agents_total ?? "?"}` : "—"}</KV>
              <KV k="指纹"><code className="mono text-[11px]">{selPeer.fingerprint || "—"}</code></KV>
              <KV k="详情取自">
                {remote ? ago(Date.now() - (nodeAge[selPeer.id] ?? 0)) : "—"}
              </KV>
              <KV k="加入时间">{new Date(selPeer.created_at).toLocaleString()}</KV>
              <KV k="对端口令">
                {editPeer === selPeer.id ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <input
                      className="input h-7 flex-1 py-0 text-[11px]"
                      placeholder="nd_ 开头"
                      value={peerTokenDraft}
                      onChange={(e) => setPeerTokenDraft(e.target.value)}
                    />
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        void run(`${selPeer.id}:token`, () => api.studioPeerSetToken(selPeer.id, peerTokenDraft.trim()), "口令已保存")
                          .then(() => { setEditPeer(null); setPeerTokenDraft(""); });
                      }}
                    >
                      保存
                    </button>
                    <button className="btn btn-sm" onClick={() => { setEditPeer(null); setPeerTokenDraft(""); }}>
                      取消
                    </button>
                  </span>
                ) : (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span style={{ color: "var(--color-text-3)" }}>已配置（密文存储）</span>
                    <button className="btn btn-sm" onClick={() => { setEditPeer(selPeer.id); setPeerTokenDraft(""); }}>
                      更换
                    </button>
                  </span>
                )}
              </KV>
            </div>

            {remote && (
              <div className="flex items-center gap-2 rounded-md px-2.5 py-2" style={{ background: "var(--color-surface-2)" }}>
                <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>名片地址</span>
                <code className="mono min-w-0 flex-1 truncate text-[11px]">{remote.card_url}</code>
                <button
                  className="btn btn-sm shrink-0"
                  onClick={() => { void navigator.clipboard?.writeText(remote.card_url); fb.success("名片地址已复制"); }}
                >
                  复制
                </button>
              </div>
            )}
            {nodeErr[selPeer.id] && (
              <div className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                刚才没读到对端名片：{nodeErr[selPeer.id]}（下面用本地记录）
              </div>
            )}

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[12px] font-medium">它开放的助手</span>
                <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                  {agents === undefined ? "读取中…" : `${agents.length} 个已同步`}
                </span>
              </div>
              {agents === undefined ? (
                <div className="space-y-2">
                  {[0, 1].map((i) => (
                    <div key={i} className="h-10 animate-pulse rounded-md" style={{ background: "var(--color-line)" }} />
                  ))}
                </div>
              ) : agents.length === 0 ? (
                <div className="rounded-md border border-dashed px-3 py-3 text-[12px]"
                     style={{ borderColor: "var(--color-line)", color: "var(--color-text-3)" }}>
                  还没有同步到本地助手。点上面的「同步助手」。
                </div>
              ) : (
                <div className="overflow-hidden rounded-md border" style={{ borderColor: "var(--color-line)" }}>
                  {agents.map((a) => {
                    const as = ARUN[a.status] ?? ARUN.unknown;
                    return (
                      <button
                        key={a.id}
                        className="flex w-full items-center gap-3 border-t px-3 py-2 text-left first:border-t-0 hover:bg-[var(--bg-hover,rgba(0,0,0,0.03))]"
                        style={{ borderColor: "var(--color-line)" }}
                        onClick={() => setSelAgentId(a.id)}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-[12.5px]">{a.name}</span>
                            <span className="flex items-center gap-1 text-[11px]" style={{ color: "var(--color-text-2)" }}>
                              <Dot tone={as.tone} />
                              {as.label}
                            </span>
                            {!a.enabled && (
                              <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>已停用</span>
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-[11px]" style={{ color: "var(--color-text-3)" }}>
                            {a.skills.length} 个技能 · 上次可用 {ago(a.last_ok_at)}
                          </span>
                        </span>
                        <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>详情 ›</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </DetailPanel>
      )}

      {selAgent && (
        <DetailPanel
          title={selAgent.name}
          subtitle={
            <>
              <span className="flex items-center gap-1">
                <Dot tone={(ARUN[selAgent.status] ?? ARUN.unknown).tone} />
                {(ARUN[selAgent.status] ?? ARUN.unknown).label}
              </span>
              <span>·</span>
              <span>来自 {selPeer?.name || "远端节点"}</span>
              {!selAgent.enabled && (<><span>·</span><span>已停用</span></>)}
            </>
          }
          icon={<span className="text-[16px]" aria-hidden>🤖</span>}
          facts={[
            { icon: <span aria-hidden>🧩</span>, text: `${selAgent.skills.length} 个技能` },
            { icon: <span aria-hidden>⏱</span>, text: `上次可用 ${ago(selAgent.last_ok_at)}` },
          ]}
          actions={
            <>
              <label className="flex items-center gap-2 text-[12px]">
                <Switch
                  checked={selAgent.enabled}
                  ariaLabel={`启用 ${selAgent.name}`}
                  onChange={(next) => { void toggleAgent(selAgent.id, next); }}
                />
                在本机使用
              </label>
              <button
                className="btn btn-sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(selAgent.card_url || selAgent.url);
                  fb.success("A2A 地址已复制");
                }}
              >
                复制 A2A 地址
              </button>
            </>
          }
          onClose={() => setSelAgentId(null)}
        >
          <div className="space-y-4">
            <p className="text-[13px] leading-relaxed" style={{ color: "var(--color-text-2)" }}>
              {selAgent.description || "远端没有提供说明"}
            </p>
            {selAgent.skills.length > 0 && (
              <div>
                <div className="mb-1.5 text-[12px] font-medium">技能</div>
                <div className="flex flex-wrap gap-1">
                  {selAgent.skills.map((sk) => (
                    <Chip key={sk} tone="muted">{sk}</Chip>
                  ))}
                </div>
              </div>
            )}
            <div>
              <div className="mb-1.5 text-[12px] font-medium">A2A 接入</div>
              <div className="rounded-md border p-2.5" style={{ borderColor: "var(--color-line)" }}>
                <div className="flex items-center gap-2">
                  <code className="mono min-w-0 flex-1 truncate text-[11px]">{selAgent.card_url || selAgent.url}</code>
                  <button
                    className="btn btn-sm shrink-0"
                    onClick={() => {
                      void navigator.clipboard?.writeText(selAgent.card_url || selAgent.url);
                      fb.success("A2A 地址已复制");
                    }}
                  >
                    复制
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
                  <KV k="远端助手 ID"><code className="mono text-[11px]">{selAgent.remote_agent_id || "—"}</code></KV>
                  <KV k="状态检查">{ago(selAgent.last_checked_at)}</KV>
                </div>
              </div>
            </div>
            {selAgent.last_error && (
              <div className="text-[12px]" style={{ color: "var(--color-err)" }}>{selAgent.last_error}</div>
            )}
            <div className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
              「在本机使用」是这个远端助手在你这里的开关：关掉后它不再出现在助手的可挂载清单里；
              对方关闭开放时，这里会显示异常并给出原因。
            </div>
          </div>
        </DetailPanel>
      )}

    </div>
  );
}
