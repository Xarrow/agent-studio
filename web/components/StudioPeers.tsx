"use client";

/**
 * 「节点」区块：把一个**别的 Agent Studio** 接进来，并逐级看它的详情。
 *
 * 布局口径（用户定的）：
 *   · **同一个页面里展开**，不弹抽屉、不跳页；
 *   · 点节点行 → 这一行下面展开它的详情与助手清单；再点一次收起；
 *   · 点助手行 → 在该行下面展开助手详情；
 *   · 不用图标（emoji / 图形图标都不放），层级只靠字号、灰度、间距和状态点。
 *
 * 三类行：
 *   待接受（direction=in & pending）—— 对方连我，我点头才成立
 *   对端节点（我连的 / 互相连的）—— 展开看详情与它开放的助手
 *   内网对端 —— 明确写"由对方发心跳"，因为它不会走常规的在线/离线
 */

import { useCallback, useEffect, useState } from "react";

import { api } from "@/lib/api";
import type { StudioPeer, StudioPeerAgent, StudioPeerRemote } from "@/lib/types";
import { Chip, KV, Section, Switch } from "@/components/ui/kit";
import { useFeedback } from "@/components/ui/feedback";

function ago(ts?: number | null): string {
  if (!ts) return "从未";
  const d = Math.max(0, Date.now() - ts);
  if (d < 60_000) return "刚刚";
  if (d < 3_600_000) return `${Math.round(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} 小时前`;
  return `${Math.round(d / 86_400_000)} 天前`;
}

type Tone = "ok" | "warn" | "err" | "muted";

const STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: "正常", tone: "ok" },
  pending: { label: "待接受", tone: "warn" },
  offline: { label: "离线", tone: "err" },
  rejected: { label: "已拒绝", tone: "muted" },
  revoked: { label: "已撤销", tone: "muted" },
};

const ARUN: Record<string, { label: string; tone: Tone }> = {
  ok: { label: "可用", tone: "ok" },
  unknown: { label: "未检测", tone: "muted" },
  error: { label: "异常", tone: "err" },
};

/** 状态点：比一排彩色胶囊安静，扫一眼就知道状态（不是图标，只是一个色点） */
function Dot({ tone }: { tone: Tone }) {
  const color =
    tone === "ok"
      ? "var(--color-ok, #16a34a)"
      : tone === "warn"
        ? "var(--color-warn, #d97706)"
        : tone === "err"
          ? "var(--color-err)"
          : "var(--color-text-3)";
  return (
    <span aria-hidden className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
  );
}

/** 口令掩码：只露头尾，避免整串糊在屏幕上 */
function maskToken(t: string): string {
  if (!t) return "";
  if (t.length <= 10) return t;
  return `${t.slice(0, 5)}••••••${t.slice(-4)}`;
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

  // 就地展开：哪个节点打开着、哪个助手展开着（同一页内，不弹层）
  const [openPeer, setOpenPeer] = useState<string | null>(null);
  const [openAgent, setOpenAgent] = useState<string | null>(null);

  const [nodeAgents, setNodeAgents] = useState<Record<string, StudioPeerAgent[]>>({});
  const [nodeRemote, setNodeRemote] = useState<Record<string, StudioPeerRemote | null>>({});
  const [nodeErr, setNodeErr] = useState<Record<string, string>>({});
  const [nodeAge, setNodeAge] = useState<Record<string, number>>({});

  // 本节点的连接口令（对端要填它才能读我的助手清单）
  const [myToken, setMyToken] = useState<string>("");
  const [tokenInput, setTokenInput] = useState("");
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
      if (typeof got.remote_age_ms === "number") {
        setNodeAge((prev) => ({ ...prev, [peerId]: got.remote_age_ms as number }));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const togglePeer = async (peerId: string) => {
    const next = openPeer === peerId ? null : peerId;
    setOpenPeer(next);
    setOpenAgent(null);
    if (next && nodeAgents[peerId] === undefined) await loadAgents(peerId);
  };

  const toggleAgentEnabled = async (peerId: string, agentId: string, enabled: boolean) => {
    try {
      await api.patchRemoteAgent(agentId, { enabled });
      fb.success(enabled ? "已启用" : "已停用");
      await loadAgents(peerId);
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

  const pending = (peers ?? []).filter((p) => p.status === "pending");
  const active = (peers ?? []).filter((p) => p.status !== "pending");

  return (
    <div className="mt-5">
      <Section
        title="节点"
        desc="连接另一个 Agent Studio；点节点就地展开详情与它开放的助手"
        right={
          <button
            className="btn btn-sm"
            onClick={() => {
              setOpen((v) => !v);
              setErr(null);
              setPreview(null);
            }}
          >
            {open ? "取消" : "＋ 连接节点"}
          </button>
        }
      >
        {/* 本节点连接口令 */}
        <div
          className="mb-3 flex flex-wrap items-center gap-2 rounded-md px-2.5 py-2"
          style={{ background: "var(--color-surface-2)" }}
        >
          <span className="shrink-0 text-[12px]" style={{ color: "var(--color-text-2)" }}>
            本节点连接口令
          </span>
          <code className="mono min-w-0 flex-1 truncate text-[11px]" title="对端连我时要填它">
            {myToken ? maskToken(myToken) : "（读取中…）"}
          </code>
          <span className="hidden text-[11px] sm:inline" style={{ color: "var(--color-text-3)" }}>
            对端读我的助手清单 / 握手 / 心跳时要用
          </span>
          <button
            className="btn btn-sm"
            disabled={!myToken}
            onClick={() => {
              void navigator.clipboard?.writeText(myToken);
              fb.success("连接口令已复制");
            }}
          >
            复制
          </button>
          <button
            className="btn btn-sm"
            disabled={!myToken || busy === "rotate"}
            onClick={() => {
              if (!window.confirm("轮换口令后，已连上的对端需要重新填新口令，确定轮换？")) return;
              void run(
                "rotate",
                async () => {
                  const r = await api.studioTokenRotate();
                  setMyToken(r.token);
                },
                "口令已轮换",
              );
            }}
          >
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
                onChange={(e) => {
                  setUrl(e.target.value);
                  setPreview(null);
                  setErr(null);
                }}
              />
              <button className="btn btn-sm shrink-0" disabled={!url.trim() || busy === "preview"} onClick={doPreview}>
                {busy === "preview" ? "连接中…" : "先看一下"}
              </button>
            </div>
            <input
              className="input mt-2"
              placeholder="对方的连接口令（在对方「节点」区块复制，nd_ 开头）"
              value={tokenInput}
              onChange={(e) => {
                setTokenInput(e.target.value);
                setErr(null);
              }}
            />
            <label className="mt-2 flex items-center gap-2 text-[12px]" style={{ color: "var(--color-text-2)" }}>
              <Switch checked={mutual} onChange={setMutual} ariaLabel="双向连接" />
              双向连接（对方那边也会出现一条待接受的请求）
            </label>

            {preview && (
              <div className="mt-2 rounded-md p-2.5" style={{ background: "var(--color-surface-2)" }}>
                <div className="text-[12px]">
                  能连上：<span className="font-medium">{preview.name || "未命名节点"}</span>，开放{" "}
                  {preview.agents.length} 个助手
                  {preview.private ? "（内网地址：不会由本机发心跳）" : ""}
                </div>
                {preview.agents.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {preview.agents.map((a) => (
                      <Chip key={a.id}>{a.name || a.id}</Chip>
                    ))}
                  </div>
                )}
                <button className="btn btn-primary btn-sm mt-2" disabled={busy === "connect"} onClick={doConnect}>
                  {busy === "connect" ? "连接中…" : "确认连接"}
                </button>
              </div>
            )}
            {err && <div className="mt-2 text-[12px]" style={{ color: "var(--color-err)" }}>{err}</div>}
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
                <span className="text-[12px] font-medium">待接受</span>
                <span className="text-[13px] font-medium">{p.name}</span>
                <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                  {p.agents_count} 个助手 · {ago(p.last_seen_at)}请求连接你
                </span>
                <span className="ml-auto flex gap-1.5">
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={busy === p.id}
                    onClick={() => run(p.id, () => api.studioPeerAccept(p.id), "已接受")}
                  >
                    接受
                  </button>
                  <button
                    className="btn btn-sm"
                    disabled={busy === p.id}
                    onClick={() => run(p.id, () => api.studioPeerReject(p.id), "已拒绝")}
                  >
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
            还没有节点。点右上「＋ 连接节点」，填上对方地址和它的连接口令；连上之后点节点，就地展开它开放了哪些助手。
          </div>
        ) : (
          active.map((p) => {
            const st = STATUS[p.status] ?? STATUS.active;
            const isOpen = openPeer === p.id;
            const agents = nodeAgents[p.id];
            const remote = nodeRemote[p.id];
            const rErr = nodeErr[p.id] || "";
            return (
              <div
                key={p.id}
                className="border-t first:border-t-0"
                style={{ borderColor: "var(--color-line)" }}
              >
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => void togglePeer(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void togglePeer(p.id);
                    }
                  }}
                  className="flex min-h-[52px] cursor-pointer items-center gap-3 rounded-md px-1 py-2 transition-colors hover:bg-[var(--bg-hover,rgba(0,0,0,0.03))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent,#2563eb)]"
                  style={isOpen ? { background: "var(--bg-selected)" } : undefined}
                >
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
                        <span
                          className="text-[11px]"
                          style={{ color: "var(--color-text-3)" }}
                          title="对方是内网地址：由它发心跳给我"
                        >
                          仅对方心跳
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px]" style={{ color: "var(--color-text-3)" }}>
                      {p.base_url || "地址未知"} · 已同步 {p.agents_synced}/{p.agents_count} 个助手 · 上次同步{" "}
                      {ago(p.last_sync_at)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="btn btn-sm"
                      disabled={busy === p.id || !p.base_url}
                      onClick={() => {
                        void run(p.id, () => api.studioPeerSync(p.id), "已同步").then(() => loadAgents(p.id));
                      }}
                    >
                      同步
                    </button>
                    <button
                      className="btn btn-sm"
                      style={{ color: "var(--color-err)" }}
                      disabled={busy === p.id}
                      onClick={() => {
                        if (!window.confirm(`移除节点「${p.name}」？它同步过来的助手会一起删掉。`)) return;
                        void run(p.id, () => api.studioPeerRemove(p.id), "已移除").then(() => setOpenPeer(null));
                      }}
                    >
                      移除
                    </button>
                  </span>
                </div>

                {isOpen && (
                  <div className="mb-2 ml-1 space-y-3 rounded-md border p-3" style={{ borderColor: "var(--color-line)" }}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[12px] font-medium">远程详情</span>
                      <span className="flex items-center gap-1 text-[11px]" style={{ color: "var(--color-text-2)" }}>
                        <Dot tone={st.tone} />
                        {st.label}
                      </span>
                      <button
                        className="btn btn-sm ml-auto"
                        disabled={busy === `${p.id}:live`}
                        onClick={() => run(`${p.id}:live`, () => loadAgents(p.id, true))}
                      >
                        刷新详情
                      </button>
                    </div>

                    <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                      <KV k="名称">{remote?.name || p.name}</KV>
                      <KV k="版本">{remote?.version ? `${remote.version}（${remote.protocol || "studio/1"}）` : "—"}</KV>
                      <KV k="节点 ID">
                        <code className="mono text-[11px]">{remote?.studio_id || p.studio_id}</code>
                      </KV>
                      <KV k="地址">
                        <code className="mono text-[11px]">{remote?.base_url || p.base_url || "未知"}</code>
                      </KV>
                      <KV k="助手">
                        {remote
                          ? `对端开放 ${remote.agents_open ?? 0} / 共 ${remote.agents_total ?? "?"}，已同步 ${p.agents_synced}`
                          : `已同步 ${p.agents_synced} / 记录 ${p.agents_count}`}
                      </KV>
                      <KV k="指纹">
                        <code className="mono text-[11px]">{p.fingerprint || "—"}</code>
                      </KV>
                      <KV k="心跳">
                        {p.heartbeat ? "本机每 60 秒发一次" : "对方是内网：由它发心跳给我"} · 上次 {ago(p.last_seen_at)}
                      </KV>
                      <KV k="上次同步">{ago(p.last_sync_at)}</KV>
                      <KV k="连接方式">
                        {p.direction === "both" ? "互相连接" : p.direction === "in" ? "对方连我" : "本机连它"}
                      </KV>
                      <KV k="加入时间">{new Date(p.created_at).toLocaleString()}</KV>
                      <KV k="详情取自">
                        {remote ? ago(Date.now() - (nodeAge[p.id] ?? 0)) : "—"}
                      </KV>
                      <KV k="对端口令">
                        {editPeer === p.id ? (
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
                                void run(
                                  `${p.id}:token`,
                                  () => api.studioPeerSetToken(p.id, peerTokenDraft.trim()),
                                  "口令已保存",
                                ).then(() => {
                                  setEditPeer(null);
                                  setPeerTokenDraft("");
                                });
                              }}
                            >
                              保存
                            </button>
                            <button
                              className="btn btn-sm"
                              onClick={() => {
                                setEditPeer(null);
                                setPeerTokenDraft("");
                              }}
                            >
                              取消
                            </button>
                          </span>
                        ) : (
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span style={{ color: "var(--color-text-3)" }}>已配置（密文存储）</span>
                            <button
                              className="btn btn-sm"
                              onClick={() => {
                                setEditPeer(p.id);
                                setPeerTokenDraft("");
                              }}
                            >
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
                          onClick={() => {
                            void navigator.clipboard?.writeText(remote.card_url);
                            fb.success("名片地址已复制");
                          }}
                        >
                          复制
                        </button>
                      </div>
                    )}
                    {rErr && (
                      <div className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                        刚没读到对端名片：{rErr}（下面用本地记录）
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
                            <div key={i} className="h-9 animate-pulse rounded-md" style={{ background: "var(--color-line)" }} />
                          ))}
                        </div>
                      ) : agents.length === 0 ? (
                        <div
                          className="rounded-md border border-dashed px-3 py-3 text-[12px]"
                          style={{ borderColor: "var(--color-line)", color: "var(--color-text-3)" }}
                        >
                          还没有同步到本地助手。点上面的「同步」。
                        </div>
                      ) : (
                        <div className="overflow-hidden rounded-md border" style={{ borderColor: "var(--color-line)" }}>
                          {agents.map((a) => {
                            const as = ARUN[a.status] ?? ARUN.unknown;
                            const aOpen = openAgent === a.id;
                            return (
                              <div
                                key={a.id}
                                className="border-t first:border-t-0"
                                style={{ borderColor: "var(--color-line)" }}
                              >
                                <div
                                  role="button"
                                  tabIndex={0}
                                  onClick={() => setOpenAgent(aOpen ? null : a.id)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      setOpenAgent(aOpen ? null : a.id);
                                    }
                                  }}
                                  className="flex min-h-[44px] cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-[var(--bg-hover,rgba(0,0,0,0.03))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent,#2563eb)]"
                                  style={aOpen ? { background: "var(--bg-selected)" } : undefined}
                                >
                                  <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-2">
                                      <span className="truncate text-[12.5px]">{a.name}</span>
                                      <span
                                        className="flex items-center gap-1 text-[11px]"
                                        style={{ color: "var(--color-text-2)" }}
                                      >
                                        <Dot tone={as.tone} />
                                        {as.label}
                                      </span>
                                      {!a.enabled && (
                                        <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                                          已停用
                                        </span>
                                      )}
                                    </span>
                                    <span className="mt-0.5 block truncate text-[11px]" style={{ color: "var(--color-text-3)" }}>
                                      {a.skills.length} 个技能 · 上次可用 {ago(a.last_ok_at)}
                                    </span>
                                  </span>
                                  <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                                    {aOpen ? "收起" : "详情"}
                                  </span>
                                </div>

                                {aOpen && (
                                  <div className="space-y-3 border-t px-3 py-3" style={{ borderColor: "var(--color-line)" }}>
                                    <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--color-text-2)" }}>
                                      {a.description || "远端没有提供说明"}
                                    </p>
                                    {a.skills.length > 0 && (
                                      <div className="flex flex-wrap gap-1">
                                        {a.skills.map((sk) => (
                                          <Chip key={sk} tone="muted">{sk}</Chip>
                                        ))}
                                      </div>
                                    )}
                                    <div className="flex items-center gap-2">
                                      <code className="mono min-w-0 flex-1 truncate text-[11px]" title={a.card_url || a.url}>
                                        {a.card_url || a.url}
                                      </code>
                                      <button
                                        className="btn btn-sm shrink-0"
                                        onClick={() => {
                                          void navigator.clipboard?.writeText(a.card_url || a.url);
                                          fb.success("A2A 地址已复制");
                                        }}
                                      >
                                        复制地址
                                      </button>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-3">
                                      <label className="flex items-center gap-1.5 text-[12px]">
                                        <Switch
                                          checked={a.enabled}
                                          ariaLabel={`启用 ${a.name}`}
                                          onChange={(next) => void toggleAgentEnabled(p.id, a.id, next)}
                                        />
                                        在本机使用
                                      </label>
                                      <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                                        远端助手 ID {a.remote_agent_id || "—"} · 状态检查 {ago(a.last_checked_at)}
                                      </span>
                                    </div>
                                    {a.last_error && (
                                      <div className="text-[11px]" style={{ color: "var(--color-err)" }}>{a.last_error}</div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </Section>
    </div>
  );
}
