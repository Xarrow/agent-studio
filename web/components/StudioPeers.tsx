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
import type { StudioPeer, StudioPeerAgent } from "@/lib/types";
import { Chip, Section, Switch } from "@/components/ui/kit";
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

const ARUN: Record<string, { label: string; tone: "ok" | "warn" | "err" | "muted" }> = {
  ok: { label: "可用", tone: "ok" },
  unknown: { label: "未检测", tone: "muted" },
  error: { label: "异常", tone: "err" },
};

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
  const [openPeer, setOpenPeer] = useState<string | null>(null);
  const [openAgent, setOpenAgent] = useState<string | null>(null);
  const [nodeAgents, setNodeAgents] = useState<Record<string, StudioPeerAgent[]>>({});

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
  }, [load]);

  const loadAgents = useCallback(async (peerId: string) => {
    try {
      const got = await api.studioPeerAgents(peerId);
      setNodeAgents((prev) => ({ ...prev, [peerId]: got.agents }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const togglePeer = async (peerId: string) => {
    const next = openPeer === peerId ? null : peerId;
    setOpenPeer(next);
    setOpenAgent(null);
    if (next) await loadAgents(next);
  };

  const toggleAgent = async (peerId: string, agent: StudioPeerAgent, enabled: boolean) => {
    try {
      // 调用方自己的开关：停用后这个远端助手不再出现在助手的可挂载清单里
      await api.patchRemoteAgent(agent.id, { enabled });
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
        const got = await api.studioPeerConnect(url.trim(), mutual);
        setOpen(false);
        setPreview(null);
        setUrl("");
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
        desc="连接另一个 Agent Studio，把它开放的助手同步到这里"
        right={
          <button className="btn btn-sm" onClick={() => { setOpen((v) => !v); setErr(null); setPreview(null); }}>
            {open ? "取消" : "＋ 连接节点"}
          </button>
        }
      >
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
              <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2.5"
                   style={{ borderColor: "var(--line-warn, var(--color-line))" }}>
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
          <div className="text-[12px]" style={{ color: "var(--color-text-3)" }}>加载中…</div>
        ) : active.length === 0 && pending.length === 0 ? (
          <div className="text-[12px]" style={{ color: "var(--color-text-3)" }}>
            还没有节点。连上一个之后，它开放的助手会出现在下面的列表里（来源标为节点名）。
          </div>
        ) : (
          active.map((p) => {
            const st = STATUS[p.status] ?? STATUS.active;
            const isOpen = openPeer === p.id;
            const agents = nodeAgents[p.id];
            return (
              <div key={p.id} className="border-t first:border-t-0" style={{ borderColor: "var(--color-line)" }}>
                {/* 节点行：整行可点开（≥44px 触屏区），动作在最右常驻 */}
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
                  className="flex min-h-[44px] cursor-pointer flex-wrap items-center gap-2 py-2"
                >
                  <span className="w-3 shrink-0 text-[11px]" style={{ color: "var(--color-text-3)" }}>
                    {isOpen ? "▾" : "▸"}
                  </span>
                  <span className="text-[13px] font-medium">{p.name}</span>
                  <Chip tone={st.tone}>{st.label}</Chip>
                  {p.direction === "both" && <Chip>互相连接</Chip>}
                  {!p.heartbeat && <Chip title="对方是内网地址：由它发心跳给我">仅对方心跳</Chip>}
                  <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                    {p.base_url || "地址未知"} · {p.agents_synced}/{p.agents_count} 个助手 · 上次同步 {ago(p.last_sync_at)}
                  </span>
                  <span className="ml-auto flex gap-1.5" onClick={(e) => e.stopPropagation()}>
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
                        void run(p.id, () => api.studioPeerRemove(p.id), "已移除");
                      }}
                    >
                      移除
                    </button>
                  </span>
                </div>
                {p.last_error && (
                  <div className="w-full pb-1 text-[11px]" style={{ color: "var(--color-err)" }}>{p.last_error}</div>
                )}

                {/* 展开：这个节点下可用的助手（点助手再展开详情） */}
                {isOpen && (
                  <div className="mb-2 ml-5 border-l pl-3" style={{ borderColor: "var(--color-line)" }}>
                    {agents === undefined ? (
                      <div className="py-1 text-[12px]" style={{ color: "var(--color-text-3)" }}>加载中…</div>
                    ) : agents.length === 0 ? (
                      <div className="py-1 text-[12px]" style={{ color: "var(--color-text-3)" }}>
                        这个节点还没有同步到本地助手（点上面的「同步」）
                      </div>
                    ) : (
                      agents.map((a) => {
                        const as = ARUN[a.status] ?? ARUN.unknown;
                        const aOpen = openAgent === a.id;
                        return (
                          <div key={a.id} className="border-t first:border-t-0" style={{ borderColor: "var(--color-line)" }}>
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
                              className="flex min-h-[40px] cursor-pointer flex-wrap items-center gap-2 py-1.5"
                            >
                              <span className="w-3 shrink-0 text-[11px]" style={{ color: "var(--color-text-3)" }}>
                                {aOpen ? "▾" : "▸"}
                              </span>
                              <span className="text-[12.5px]">{a.name}</span>
                              <Chip tone={as.tone}>{as.label}</Chip>
                              {!a.enabled && <Chip tone="muted">已停用</Chip>}
                              {a.skills.length > 0 && (
                                <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                                  {a.skills.length} 个技能
                                </span>
                              )}
                              <span className="ml-auto text-[11px]" style={{ color: "var(--color-text-3)" }}>
                                上次可用 {ago(a.last_ok_at)}
                              </span>
                            </div>

                            {aOpen && (
                              <div className="mb-2 rounded-md p-2.5" style={{ background: "var(--color-surface-2)" }}>
                                <div className="text-[12px]" style={{ color: "var(--color-text-2)" }}>
                                  {a.description || "远端没有提供说明"}
                                </div>
                                {a.skills.length > 0 && (
                                  <div className="mt-1.5 flex flex-wrap gap-1">
                                    {a.skills.slice(0, 12).map((s) => (
                                      <Chip key={s} tone="muted">{s}</Chip>
                                    ))}
                                  </div>
                                )}
                                <div className="mt-2 flex items-center gap-1.5">
                                  <code
                                    className="mono min-w-0 flex-1 truncate text-[11px]"
                                    style={{ color: "var(--color-text-2)" }}
                                    title={a.card_url || a.url}
                                  >
                                    {a.card_url || a.url}
                                  </code>
                                  <button
                                    className="btn btn-sm shrink-0"
                                    onClick={() => {
                                      void navigator.clipboard?.writeText(a.card_url || a.url);
                                      fb.success("A2A 地址已复制");
                                    }}
                                  >
                                    复制
                                  </button>
                                </div>
                                <div className="mt-2 flex flex-wrap items-center gap-3">
                                  <label className="flex items-center gap-1.5 text-[12px]">
                                    <Switch
                                      checked={a.enabled}
                                      ariaLabel={`启用 ${a.name}`}
                                      onChange={(next) => void toggleAgent(p.id, a, next)}
                                    />
                                    在本机使用
                                  </label>
                                  <span className="text-[11px]" style={{ color: "var(--color-text-3)" }}>
                                    远端助手 ID {a.remote_agent_id || "—"} · 状态检查 {ago(a.last_checked_at)}
                                  </span>
                                </div>
                                {a.last_error && (
                                  <div className="mt-1.5 text-[11px]" style={{ color: "var(--color-err)" }}>{a.last_error}</div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
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
