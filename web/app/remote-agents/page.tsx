"use client";

/**
 * 「远程 Agent」——把外部 A2A agent 注册进来、看清它会干什么、挂到助手上直接调用。
 *
 * 一条链在界面上就是四个动作（用户要的就是这条链）：
 *   注册（粘贴地址 → **解析预览** → 确认）· 治理（改名/凭据/超时/启停/重新解析/删除）
 *   · 解析（技能清单摆在一行一行的表格里，不是我读给你听）· 绑定（勾助手 → 挂上）
 *
 * 口径（按平台的既有规矩来）：
 *   · 一行一个远端对象，点行就地展开，不跳页；
 *   · 常用动作**常驻可见**（测试调用 / 重新解析 / 挂到助手），删除是红字靠最右、两步确认；
 *   · 挂载复用既有机制 —— 注册时会自动生成一个 `kind=a2a` 工具，助手的「工具」里就能勾到。
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import { api, apiBase } from "@/lib/api";
import type { Agent, RemoteAgentParsed, RemoteAgentRecord } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import {
  Chip,
  DLG_BACKDROP,
  DLG_CARD,
  Empty,
  FieldLabel,
  KV,
  PageHead,
  Row,
  RowDetail,
  RowList,
  Section,
  Segmented,
  Toolbar,
} from "@/components/ui/kit";

type Filter = "all" | "ok" | "error" | "off";

function StatusChip({ r }: { r: RemoteAgentRecord }) {
  if (!r.enabled) return <Chip tone="muted">已停用</Chip>;
  if (r.status === "ok") return <Chip tone="ok">可用</Chip>;
  if (r.status === "error") return <Chip tone="warn">异常</Chip>;
  return <Chip tone="muted">未探测</Chip>;
}

/** 技能清单：一行一个技能（名字 + 标签 + 描述），手机上不横向滚。 */
function SkillTable({ parsed }: { parsed: RemoteAgentParsed }) {
  const skills = parsed.skills ?? [];
  if (!skills.length) {
    return (
      <p className="text-[12.5px]" style={{ color: "var(--color-muted)" }}>
        这个远端没在卡片里声明技能（只给了名字/描述）—— 挂上后靠描述让模型判断。
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {skills.map((s, i) => (
        <div
          key={s.id || i}
          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded px-2 py-1"
          style={{ background: "var(--color-surface)" }}
        >
          <span className="text-[12.5px] font-medium">{s.name || s.id}</span>
          {(s.tags ?? []).map((t) => (
            <span
              key={t}
              className="rounded px-1 text-[11px]"
              style={{ background: "var(--color-surface-2)", color: "var(--color-muted)" }}
            >
              {t}
            </span>
          ))}
          {s.description ? (
            <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
              {s.description}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export default function RemoteAgentsPage() {
  const fb = useFeedback();
  const [rows, setRows] = useState<RemoteAgentRecord[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [registering, setRegistering] = useState(false);
  const [copied, setCopied] = useState(false);
  // API 地址与前端 api 客户端同一口径（lib/api.ts 的 apiBase）：内网 hostname:8848、公网走反代
  const base = apiBase();
  const selfRegUrl = `${base}/api/remote-agents/self`;
  const selfCardUrl = `${base}/.well-known/agent-card.json`;
  async function copySelfreg() {
    try {
      await navigator.clipboard.writeText(selfRegUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      fb.error("复制失败", "手动选中文本复制");
    }
  }

  const load = useCallback(async () => {
    try {
      const [list, ags] = await Promise.all([api.remoteAgents(), api.agents()]);
      setRows(list);
      setAgents(ags);
    } catch (e) {
      fb.error("读取失败", e instanceof Error ? e.message : String(e));
      setRows([]);
    }
  }, [fb]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = useMemo(() => {
    const list = rows ?? [];
    if (filter === "all") return list;
    if (filter === "off") return list.filter((r) => !r.enabled);
    return list.filter((r) => r.enabled && r.status === filter);
  }, [rows, filter]);

  const stats = useMemo(() => {
    const list = rows ?? [];
    return {
      total: list.length,
      ok: list.filter((r) => r.enabled && r.status === "ok").length,
      bad: list.filter((r) => r.enabled && r.status !== "ok").length,
      bound: list.filter((r) => (r.bound_agents ?? []).length > 0).length,
    };
  }, [rows]);

  async function run(key: string, fn: () => Promise<unknown>, okMsg?: string) {
    setBusy(key);
    try {
      await fn();
      if (okMsg) fb.success(okMsg);
      await load();
    } catch (e) {
      fb.error("操作失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function onTest(r: RemoteAgentRecord) {
    await run(`test:${r.id}`, async () => {
      const got = await api.testRemoteAgent(r.id);
      if (got.ok) {
        fb.success(
          `远端在线（${got.ms}ms）`,
          got.answer ? `回答：${got.answer.slice(0, 120)}` : "远端已跑完，没有返回文本",
        );
      } else {
        fb.error("调用失败", got.error || `远端状态：${got.state}`);
      }
    });
  }

  async function onBind(r: RemoteAgentRecord, agentId: string, attach: boolean) {
    const ag = agents.find((a) => a.id === agentId);
    if (!ag) return;
    if (!r.tool_id) {
      fb.error("这个远端还没有对应的工具行", "点「重新解析」重建一次");
      return;
    }
    // 绑定 = 把这个远程 agent 生成的工具行加/减到助手定义的 tools 里
    // （助手的工具就是 {ref: 工具行 id} 列表 —— 复用既有机制，不为远端另造一套）
    const current = (ag.definition?.tools ?? []) as { ref?: string }[];
    const refs = current.map((t) => t.ref).filter((x): x is string => !!x);
    const next = attach
      ? Array.from(new Set([...refs, r.tool_id]))
      : refs.filter((x) => x !== r.tool_id);
    await run(`bind:${r.id}:${agentId}`, async () => {
      await api.updateAgent(agentId, {
        definition: { ...(ag.definition as object), tools: next.map((ref) => ({ ref })) } as never,
      });
      fb.success(attach ? `已挂到「${ag.name}」` : `已从「${ag.name}」取下`);
    });
  }

  async function onDelete(r: RemoteAgentRecord) {
    const ok = await fb.confirm({
      title: `删除远程 agent「${r.name}」？`,
      description:
        (r.bound_agents ?? []).length > 0
          ? `它还被 ${r.bound_agents.length} 个助手挂着 —— 先在那些助手的「工具」里取消勾选，再删除。`
          : "只删平台里的注册项，不影响远端那台 agent。",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    await run(`del:${r.id}`, () => api.removeRemoteAgent(r.id), "已删除");
  }

  return (
    <>
      <PageHead
        title="远程 Agent"
        desc="注册外部 A2A agent（另一台 agent-studio 或任何实现了 A2A 的 agent）——解析它的能力，挂到助手上直接调用"
      />

      <div className="mb-3">
        <Toolbar>
          <button className="btn btn-primary" onClick={() => setRegistering(true)}>
            ＋ 注册
          </button>
          <button className="btn" onClick={() => void copySelfreg()}>
            {copied ? "已复制注册地址" : "复制自注册地址"}
          </button>
          <button
            className="btn"
            disabled={busy === "refresh-all" || !(rows ?? []).length}
            onClick={() =>
              void run("refresh-all", async () => {
                const list = rows ?? [];
                let bad = 0;
                for (const r of list) {
                  try {
                    await api.refreshRemoteAgent(r.id);
                  } catch {
                    bad += 1;
                  }
                }
                fb.success(
                  `已重新解析 ${list.length} 个远端`,
                  bad ? `其中 ${bad} 个拉取失败（状态已标为异常）` : "全部正常",
                );
              })
            }
          >
            {busy === "refresh-all" ? "解析中…" : "全部重新解析"}
          </button>
          <span className="ml-auto hidden text-[12.5px] sm:inline" style={{ color: "var(--color-muted)" }}>
            挂载 {stats.bound} / {stats.total}
          </span>
        </Toolbar>
      </div>

      <Section
        title="已注册的远端"
        desc="一行一个远端：点开看它声明了哪些技能、被哪些助手用着；要调用就直接挂到助手上"
      >
        <div className="mb-2">
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { key: "all", label: "全部", count: stats.total },
              { key: "ok", label: "可用", count: stats.ok },
              { key: "error", label: "异常", count: stats.bad },
              { key: "off", label: "已停用" },
            ]}
          />
        </div>

        {rows === null ? (
          <Empty title="读取中…" />
        ) : !shown.length ? (
          <Empty
            title={stats.total ? "这个筛选下没有远端" : "还没有接入任何远程 agent"}
            hint="两种接法：粘对方的地址注册进来（拉），或把自注册地址发给对方、它推卡片进来（推）。远端需实现 A2A 协议。"
            action={
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-primary" onClick={() => setRegistering(true)}>
                  粘地址注册
                </button>
                <button className="btn" onClick={() => void copySelfreg()}>
                  {copied ? "已复制 ✓" : "复制自注册地址"}
                </button>
              </div>
            }
          />
        ) : (
          <RowList>
            {shown.map((r) => {
              const expanded = open === r.id;
              const skills = r.parsed?.skills ?? [];
              const boundIds = new Set((r.bound_agents ?? []).map((b) => b.agent_id));
              return (
                <Fragment key={r.id}>
                  <Row
                    expanded={expanded}
                    onToggle={() => setOpen(expanded ? null : r.id)}
                    actions={
                      <>
                        <button
                          className="btn btn-primary"
                          disabled={!r.enabled || busy === `test:${r.id}`}
                          onClick={() => void onTest(r)}
                        >
                          {busy === `test:${r.id}` ? "调用中…" : "测试调用"}
                        </button>
                        <button
                          className="btn"
                          disabled={busy === `refresh:${r.id}`}
                          onClick={() =>
                            void run(`refresh:${r.id}`, () => api.refreshRemoteAgent(r.id), "已重新解析")
                          }
                        >
                          {busy === `refresh:${r.id}` ? "解析中…" : "重新解析"}
                        </button>
                        <button
                          className="ml-auto text-[12.5px]"
                          style={{ color: "var(--color-danger)" }}
                          onClick={() => void onDelete(r)}
                        >
                          删除
                        </button>
                      </>
                    }
                  >
                    <span className="truncate text-[13px] font-medium">{r.name}</span>
                    <StatusChip r={r} />
                    <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                      技能 {skills.length}
                    </span>
                    {r.bound_agents.length ? (
                      <Chip tone="accent">已挂 {r.bound_agents.length} 个助手</Chip>
                    ) : (
                      <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                        未挂载
                      </span>
                    )}
                    <span
                      className="mono hidden truncate text-[11.5px] sm:inline"
                      style={{ color: "var(--color-muted)" }}
                    >
                      {(() => { try { return new URL(r.url).host; } catch { return r.url; } })()}
                    </span>
                  </Row>

                  {expanded ? (
                    <RowDetail>
                      <div className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1">
                          <KV k="地址">
                            <code className="mono break-all text-[12px]">{r.url}</code>
                          </KV>
                          <KV k="版本">
                            {r.parsed?.version || "—"} · A2A {r.parsed?.protocol_version || "—"}
                            {r.parsed?.capabilities?.streaming ? " · 支持流式" : ""}
                          </KV>
                          <KV k="远端助手">
                            {r.remote_agent_id ? `${r.remote_agent_id}（远端按这个选助手）` : "不指定，用远端的默认助手"}
                          </KV>
                          <KV k="鉴权">
                            {r.has_token ? `已配（${r.auth_header} · ${r.auth_scheme}）` : "未配（内网直连）"}
                          </KV>
                          <KV k="单次上限">{Math.round(r.timeout_s)}s</KV>
                          <KV k="最近解析">
                            {r.last_checked_at
                              ? `${new Date(r.last_checked_at).toLocaleString()}${r.status === "ok" ? " · 成功" : r.status === "error" ? " · 失败" : ""}`
                              : "—"}
                          </KV>
                          {r.note ? <KV k="备注">{r.note}</KV> : null}
                        </div>

                        {r.last_error ? (
                          <div
                            className="rounded px-2 py-1.5 text-[12px]"
                            style={{
                              background: "color-mix(in srgb, var(--color-warn) 12%, transparent)",
                              color: "var(--color-warn)",
                            }}
                          >
                            最近一次失败：{r.last_error}
                          </div>
                        ) : null}

                        <div>
                          <FieldLabel>远程声明的技能（解析自它的 agent card）</FieldLabel>
                          <SkillTable parsed={r.parsed} />
                        </div>

                        <div>
                          <FieldLabel hint="勾上就用它了 —— 助手的「工具」里也会出现同名工具">挂到助手</FieldLabel>
                          {agents.length ? (
                            <div className="flex flex-wrap gap-2">
                              {agents.map((a) => {
                                const on = boundIds.has(a.id);
                                return (
                                  <button
                                    key={a.id}
                                    className={on ? "btn btn-primary" : "btn"}
                                    disabled={busy === `bind:${r.id}:${a.id}` || !r.enabled}
                                    onClick={() => void onBind(r, a.id, !on)}
                                  >
                                    {on ? "✓ " : ""}
                                    {a.name}
                                  </button>
                                );
                              })}
                            </div>
                          ) : (
                            <p className="text-[12.5px]" style={{ color: "var(--color-muted)" }}>
                              平台上还没有助手
                            </p>
                          )}
                        </div>

                        <EditRow
                          r={r}
                          busy={busy}
                          onSave={(patch, msg) =>
                            run(`edit:${r.id}`, () => api.patchRemoteAgent(r.id, patch), msg)
                          }
                        />
                      </div>
                    </RowDetail>
                  ) : null}
                </Fragment>
              );
            })}
          </RowList>
        )}
      </Section>

      <Section
        title="远端自注册（A2A 推送）"
        desc="把这个地址给远端 —— 它把自己的 agent card 推过来就完成了注册；重推一次 = 更新技能清单"
        defaultOpen={false}
      >
        <div className="flex flex-col gap-2">
          <KV k="注册地址">
            <code className="mono text-[12px]" id="selfreg-url">
              {selfRegUrl}
            </code>
            <button className="btn" onClick={() => void copySelfreg()}>
              复制
            </button>
          </KV>
          <KV k="本平台卡片">
            <code className="mono text-[12px]">{selfCardUrl}</code>
          </KV>
          <div
            className="flex flex-col gap-1 rounded p-2.5"
            style={{ background: "var(--color-surface-2)" }}
          >
            <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
              远端用一条 POST 完成注册（body 是它自己的 agent card，url 字段填它的回连地址；重推一次 = 更新技能清单）：
            </span>
            <pre
              className="mono overflow-x-auto whitespace-pre text-[11.5px]"
              style={{ color: "var(--color-muted)" }}
            >{`curl -X POST ${selfRegUrl} \
  -H 'Content-Type: application/json' \
  -d '{"name":"我的助手","description":"……","skills":[],"url":"http://远端地址:端口"}'`}</pre>
          </div>
          {copied ? (
            <span className="text-[12px]" style={{ color: "var(--color-ok)" }}>
              已复制
            </span>
          ) : null}
        </div>
      </Section>

      {registering ? (
        <RegisterDialog
          onClose={() => setRegistering(false)}
          onDone={async () => {
            setRegistering(false);
            await load();
          }}
        />
      ) : null}
    </>
  );
}

/** 就地编辑：名字 / 远端助手 / 凭据 / 超时 / 备注 / 启停。 */
function EditRow({
  r,
  busy,
  onSave,
}: {
  r: RemoteAgentRecord;
  busy: string;
  onSave: (patch: Record<string, unknown>, msg: string) => Promise<void>;
}) {
  const [name, setName] = useState(r.name);
  const [remoteAgentId, setRemoteAgentId] = useState(r.remote_agent_id ?? "");
  const [timeoutS, setTimeoutS] = useState(String(Math.round(r.timeout_s)));
  const [note, setNote] = useState(r.note ?? "");
  const [token, setToken] = useState("");
  const [openEdit, setOpenEdit] = useState(false);

  if (!openEdit) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn" onClick={() => setOpenEdit(true)}>
          编辑
        </button>
        <button
          className="btn"
          disabled={busy === `toggle:${r.id}`}
          onClick={() => void onSave({ enabled: !r.enabled }, r.enabled ? "已停用" : "已启用")}
        >
          {r.enabled ? "停用" : "启用"}
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-2 rounded p-2.5"
      style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <FieldLabel>显示名</FieldLabel>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <FieldLabel hint="远端平台认这个字段来选具体助手；留空用它的默认助手">远端助手 id</FieldLabel>
          <input
            className="input"
            value={remoteAgentId}
            onChange={(e) => setRemoteAgentId(e.target.value)}
            placeholder="可留空"
          />
        </div>
        <div>
          <FieldLabel hint="远端跑多久由远端决定，这里只是「别无限等」">单次上限（秒）</FieldLabel>
          <input className="input" value={timeoutS} onChange={(e) => setTimeoutS(e.target.value)} />
        </div>
        <div>
          <FieldLabel hint={r.has_token ? "已配凭据；留空 = 不改，填内容 = 覆盖" : "远端要鉴权就填（加密存）"}>
            访问令牌
          </FieldLabel>
          <input
            className="input"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={r.has_token ? "••••（留空不改）" : "可留空"}
          />
        </div>
      </div>
      <div>
        <FieldLabel>备注</FieldLabel>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          className="btn btn-primary"
          disabled={busy === `edit:${r.id}`}
          onClick={() => {
            const patch: Record<string, unknown> = {
              name,
              remote_agent_id: remoteAgentId,
              timeout_s: Number(timeoutS) || r.timeout_s,
              note,
            };
            if (token) patch.token = token;
            void onSave(patch, "已保存");
          }}
        >
          保存
        </button>
        <button className="btn" onClick={() => setOpenEdit(false)}>
          收起
        </button>
      </div>
    </div>
  );
}

/** 注册：粘地址 → **解析预览**（先看清它是什么）→ 确认。 */
function RegisterDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const fb = useFeedback();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [authHeader, setAuthHeader] = useState("Authorization");
  const [authScheme, setAuthScheme] = useState("Bearer");
  const [job, setJob] = useState<"idle" | "resolving" | "saving">("idle");
  const [preview, setPreview] = useState<{
    base: string;
    summary: string;
    parsed: RemoteAgentParsed;
    skills: number;
  } | null>(null);
  const [err, setErr] = useState("");
  const [selfRegisterUrl, setSelfRegisterUrl] = useState("/api/remote-agents/self");
  useEffect(() => {
    if (typeof window !== "undefined") {
      setSelfRegisterUrl(`${window.location.origin.replace(":3000", ":8848")}/api/remote-agents/self`);
    }
  }, []);

  async function doResolve() {
    setJob("resolving");
    setErr("");
    setPreview(null);
    try {
      const got = await api.resolveRemoteAgent({
        url,
        auth_header: authHeader,
        auth_scheme: authScheme,
        token: token || undefined,
      });
      setPreview(got);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setJob("idle");
    }
  }

  async function doSave() {
    if (!preview) return;
    setJob("saving");
    try {
      await api.createRemoteAgent({
        url,
        auth_header: authHeader,
        auth_scheme: authScheme,
        token: token || undefined,
      });
      fb.success("已注册", "助手的「工具」里现在能看到它了");
      await onDone();
    } catch (e) {
      fb.error("注册失败", e instanceof Error ? e.message : String(e));
    } finally {
      setJob("idle");
    }
  }

  return (
    <div className={DLG_BACKDROP}>
      <div className={`${DLG_CARD} flex max-h-[88vh] w-full max-w-2xl flex-col p-4`}>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[14px] font-medium">接入远程 Agent（粘地址）</span>
          <button className="btn ml-auto" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <div>
            <FieldLabel hint="支持 http://host:port、.../a2a、或直接粘 .../.well-known/agent-card.json">
              远端地址
            </FieldLabel>
            <div className="flex flex-wrap gap-2">
              <input
                className="input flex-1"
                value={url}
                placeholder="http://192.168.2.13:8848"
                onChange={(e) => setUrl(e.target.value)}
              />
              <button className="btn btn-primary" disabled={!url.trim() || job !== "idle"} onClick={() => void doResolve()}>
                {job === "resolving" ? "解析中…" : "解析"}
              </button>
            </div>
          </div>

          <button className="self-start text-[12.5px]" style={{ color: "var(--color-accent)" }} onClick={() => setAdvanced(!advanced)}>
            {advanced ? "收起凭据设置" : "远端需要鉴权？填凭据"}
          </button>
          {advanced ? (
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <FieldLabel>请求头</FieldLabel>
                <input className="input" value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} />
              </div>
              <div>
                <FieldLabel>前缀</FieldLabel>
                <input className="input" value={authScheme} onChange={(e) => setAuthScheme(e.target.value)} />
              </div>
              <div>
                <FieldLabel hint="加密存在平台里，界面上只回「配没配」">令牌</FieldLabel>
                <input className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
              </div>
            </div>
          ) : null}

          {err ? (
            <div
              className="rounded px-2 py-1.5 text-[12.5px]"
              style={{
                background: "color-mix(in srgb, var(--color-warn) 12%, transparent)",
                color: "var(--color-warn)",
              }}
            >
              解析失败：{err}
            </div>
          ) : null}

          {preview ? (
            <div
              className="flex flex-col gap-2 rounded p-2.5"
              style={{ background: "var(--color-surface-2)" }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium">{preview.parsed.name}</span>
                <Chip tone="ok">解析成功</Chip>
                <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                  {preview.parsed.version ? `版本 ${preview.parsed.version}` : ""}
                  {preview.parsed.protocol_version ? ` · A2A ${preview.parsed.protocol_version}` : ""}
                  {` · 技能 ${preview.skills}`}
                </span>
              </div>
              <p className="text-[12.5px]" style={{ color: "var(--color-muted)" }}>
                {preview.parsed.description || "（远端没写描述）"}
              </p>
              <p className="mono break-all text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                归一化地址：{preview.base}
              </p>
              <SkillTable parsed={preview.parsed} />
            </div>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" disabled={!preview || job !== "idle"} onClick={() => void doSave()}>
            {job === "saving" ? "接入中…" : "确认接入"}
          </button>
          <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
            注册后会自动生成一个同名工具，助手的「工具」里就能勾到它
          </span>
        </div>

        <div
          className="mt-2 rounded p-2 text-[12px]"
          style={{ background: "var(--color-surface-2)", color: "var(--color-muted)" }}
        >
          <span>反过来，远端 agent 也能<b>自己注册进来</b>：它向</span>
          <span className="mono break-all"> {"POST " + selfRegisterUrl} </span>
          <span>
            推送自己的 A2A 卡片即可（同一地址重推 = 更新技能清单，不重复建）。进来后与手工注册同一条治理链，你照样能停用/删除。
          </span>
        </div>
      </div>
    </div>
  );
}
