"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { Credential, CredentialTestResult, Provider } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { Chip, Empty, KV, PageHead, Row, RowDetail, RowList, Section } from "@/components/ui/kit";
import { PriceBook } from "@/components/PriceBook";
import { Hint, HINTS } from "@/components/ui/hint";
import { CredentialChatDialog } from "@/components/CredentialChatDialog";

export default function CredentialsPage() {
  const fb = useFeedback();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [creds, setCreds] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  /** 正在编辑的凭据（null = 没在编辑） */
  const [editing, setEditing] = useState<Credential | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  /** 手填的模型名（每套凭据一个）：探测不出清单的服务商靠它测 ✓ */
  const [typedModel, setTypedModel] = useState<Record<string, string>>({});
  /** 已显示明文的凭据：id → 明文 key（默认空 = 全部隐藏） */
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  /** 正在做「对话测试」的凭据（null = 没开） */
  const [chatting, setChatting] = useState<Credential | null>(null);
  const [testResult, setTestResult] = useState<Record<string, CredentialTestResult>>({});
  /** 就地展开的那一套钥匙（展开里 = 端点/时间 + 明文密钥 + 测试结果详情） */
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, c] = await Promise.all([api.providers(), api.credentials()]);
      setProviders(p);
      setCreds(c);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 显示明文 key。先确认一次，避免误点/被旁人看到；60 秒后自动隐藏 */
  const reveal = async (c: Credential) => {
    const ok = await fb.confirm({
      title: `显示「${c.name}」的 API Key？`,
      description: "明文会显示在页面上，60 秒后自动隐藏。",
      details: ["请确认屏幕前没有别人，也不要在录屏或共享屏幕时操作。"],
      confirmText: "显示",
    });
    if (!ok) return;
    try {
      const r = await api.revealCredentialKey(c.id);
      setRevealed((prev) => ({ ...prev, [c.id]: r.api_key }));
      window.setTimeout(() => {
        setRevealed((prev) => {
          if (!(c.id in prev)) return prev;
          const next = { ...prev };
          delete next[c.id];
          return next;
        });
      }, 60_000);
    } catch (e) {
      fb.error("读取密钥失败", e instanceof Error ? e.message : String(e));
    }
  };

  const hide = (id: string) =>
    setRevealed((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const copyKey = async (id: string) => {
    try {
      await navigator.clipboard.writeText(revealed[id]);
      fb.success("已复制到剪贴板");
    } catch {
      fb.warn("复制失败", "浏览器不允许剪贴板访问，请手动选中复制。");
    }
  };

  const test = async (id: string, model?: string) => {
    setTesting(id);
    try {
      // 传了模型名就用它测（服务商没有 /models 清单时，这是唯一能验证的路 ✓）
      const r = await api.testCredential(id, model);
      setTestResult((prev) => ({ ...prev, [id]: r }));
    } catch (e) {
      setTestResult((prev) => ({
        ...prev,
        [id]: {
          ok: false,
          provider: "",
          model: null,
          latency_ms: null,
          models: [],
          error: e instanceof Error ? e.message : String(e),
          checked_at: Date.now(),
        },
      }));
    } finally {
      setTesting(null);
    }
  };

  const remove = async (c: Credential) => {
    const ok = await fb.confirm({
      title: `删除配置「${c.name}」？`,
      description: "引用它的 Agent 将无法运行。",
      danger: true,
      confirmText: "删除",
    });
    if (!ok) return;
    try {
      await api.deleteCredential(c.id);
      fb.success(`已删除配置「${c.name}」`);
      await load();
    } catch (e) {
      fb.error("删除配置失败", e instanceof Error ? e.message : String(e));
    }
  };

  const byProvider = providers.map((p) => ({
    meta: p,
    items: creds.filter((c) => c.provider === p.name),
  }));

  return (
    <div className="p-4 md:p-6 lg:p-7 max-w-5xl">
      <PageHead
        title="LLM 配置"
        desc={
          <>
            让 AI 能工作的「钥匙」。在这里填一次，所有助手都能用；存进来会加密，不会再明文显示。
            支持 {providers.length} 家服务商，同一家可以配多套（主号 / 备用号）。
          </>
        }
        actions={
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>
            + 添加配置
          </button>
        }
      />

      {err && (
        <div className="card p-4 mb-4 text-[13px] text-[var(--color-err)]">
          加载失败：{err}
        </div>
      )}

      {showNew && (
        <NewCredentialDialog
          providers={providers}
          onClose={() => setShowNew(false)}
          onCreated={async () => {
            setShowNew(false);
            await load();
          }}
        />
      )}

      {chatting && (
        <CredentialChatDialog
          key={chatting.id}
          credential={chatting}
          onClose={() => setChatting(null)}
        />
      )}

      {editing && (
        <EditCredentialDialog
          key={editing.id}
          providers={providers}
          credential={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}

      {loading ? (
        <div className="card p-6 text-[13px] text-[var(--color-muted)]">加载中…</div>
      ) : creds.length === 0 ? (
        <div className="card">
          <Empty
            title="还没有配置任何 LLM Key"
            hint="添加后 Agent 就能选用。Key 加密存储，列表只显示脱敏串。"
            action={
              <button className="btn btn-primary" onClick={() => setShowNew(true)}>
                添加第一份配置
              </button>
            }
          />
        </div>
      ) : (
        /* 一行一套钥匙（原来每套一张卡片，五颗动作按钮把卡片撑得很高）。
           行上只留「认得出是谁 + 通不通」；端点、时间、明文密钥、测试详情收进就地展开。 */
        <RowList>
          {creds.map((c) => {
            const r = testResult[c.id];
            const open = expanded === c.id;
            return (
              <Fragment key={c.id}>
                <Row
                  expanded={open}
                  onToggle={() => setExpanded(open ? null : c.id)}
                  actions={
                    <>
                      <button
                        type="button"
                        className="btn text-[12.5px]"
                        onClick={() => setEditing(c)}
                      >
                        编辑
                      </button>
                      {revealed[c.id] ? (
                        <button
                          type="button"
                          className="btn text-[12.5px]"
                          onClick={() => hide(c.id)}
                        >
                          隐藏密钥
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn text-[12.5px]"
                          onClick={() => void reveal(c)}
                        >
                          显示密钥
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn text-[12.5px]"
                        title="直接跟模型聊两句，不经过助手"
                        onClick={() => setChatting(c)}
                      >
                        对话测试
                      </button>
                      <button
                        type="button"
                        className="btn text-[12.5px]"
                        disabled={testing === c.id}
                        onClick={() => {
                          setExpanded(c.id);
                          void test(c.id);
                        }}
                      >
                        {testing === c.id ? "测试中…" : "测试连接"}
                      </button>
                      <button
                        type="button"
                        className="btn text-[12.5px]"
                        style={{ color: "var(--color-err)" }}
                        onClick={() => void remove(c)}
                      >
                        删除
                      </button>
                    </>
                  }
                >
                  <span className="min-w-0 flex-1 basis-[240px]">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate text-[14px] font-medium">{c.name}</span>
                      <Chip tone="muted">{c.provider_display}</Chip>
                      {c.last_test_ok === true && <Chip tone="ok">上次测试通过</Chip>}
                      {c.last_test_ok === false && <Chip tone="err">上次测试失败</Chip>}
                    </span>
                    <span
                      className="mono mt-0.5 block truncate text-[11.5px]"
                      style={{ color: "var(--color-muted)" }}
                    >
                      {revealed[c.id] ? revealed[c.id] : c.masked_key} ·{" "}
                      {c.base_url || "默认端点"} · 默认模型 {c.default_model || "未设置"}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px]" style={{ color: "var(--color-muted)" }}>
                    {open ? "▾" : "▸"}
                  </span>
                </Row>

                {open && (
                  <RowDetail>
                    <div className="grid gap-1.5 md:grid-cols-2">
                      <KV k="端点">
                        <span className="mono">{c.base_url || "默认端点"}</span>
                      </KV>
                      <KV k="默认模型">
                        {c.default_model ? (
                          <span className="mono">{c.default_model}</span>
                        ) : (
                          <span style={{ color: "var(--color-muted)" }}>
                            未设置（用服务商推荐的第一个）
                          </span>
                        )}
                      </KV>
                      {c.created_at > 0 ? (
                        <KV k="添加时间">{fmt.relative(c.created_at)}</KV>
                      ) : null}
                      {c.last_test_at ? <KV k="上次测试">{fmt.relative(c.last_test_at)}</KV> : null}
                    </div>

                    {revealed[c.id] ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="mono break-all text-[12px]">{revealed[c.id]}</span>
                        <button
                          type="button"
                          className="btn text-[11.5px] px-2 py-1"
                          onClick={() => void copyKey(c.id)}
                        >
                          复制
                        </button>
                        <button
                          type="button"
                          className="btn text-[11.5px] px-2 py-1"
                          onClick={() => hide(c.id)}
                        >
                          隐藏
                        </button>
                      </div>
                    ) : null}

                    {r ? (
                      <div
                        className="mt-2.5 rounded-[8px] border p-2.5 text-[12.5px]"
                        style={{ borderColor: r.ok ? "var(--color-ok)" : "var(--color-err)" }}
                      >
                        {r.ok ? (
                          <>
                            <div style={{ color: "var(--color-ok)" }}>✓ 连接正常</div>
                            <div
                              className="mt-0.5 text-[11.5px]"
                              style={{ color: "var(--color-muted)" }}
                            >
                              延迟 {fmt.ms(r.latency_ms)} · 可用模型 {r.models.length} 个
                            </div>
                            {r.models.length > 0 ? (
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {r.models.slice(0, 12).map((m) => (
                                  <Chip key={m} tone="muted">
                                    {m.trim()}
                                  </Chip>
                                ))}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <div style={{ color: "var(--color-err)" }}>
                            ✗ {r.error}
                            {r.latency_ms ? ` （${fmt.ms(r.latency_ms)}）` : ""}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="mt-2.5 text-[12px]" style={{ color: "var(--color-muted)" }}>
                        点右侧「测试连接」验一下能不能通 —— 延迟与可用模型会显示在这里。
                      </div>
                    )}
                  </RowDetail>
                )}
              </Fragment>
            );
          })}
        </RowList>
      )}

      {/* 单价：把"用了多少 token"变成"花了多少钱"。放在密钥下面 ——
          它的输入是密钥连着的那些模型，动线是"配好 key → 顺手把单价填了"。 */}
      <div className="mt-3">
        <PriceBook />
      </div>

      {/* 支持的 Provider：原来 9 张静态卡片（三列网格，每张只放名称/端点/说明），
          改成分区里一行一家 —— 顺手把「这家配了几套钥匙」摆出来。 */}
      <div className="mt-3">
        <Section
          title="支持的 Provider"
          count={`${byProvider.length} 家`}
          desc="平台已经知道怎么跟这些服务商说话；钥匙配在上面的列表里，这里只是清单与默认端点"
        >
          <div className="flex flex-col">
            {byProvider.map(({ meta, items }) => (
              <div
                key={meta.name}
                className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b py-2 last:border-b-0"
                style={{ borderColor: "var(--color-border)" }}
              >
                <span className="min-w-0 flex-1 basis-[220px]">
                  <span className="block text-[13.5px] font-medium">{meta.display_name}</span>
                  <span
                    className="mono mt-0.5 block truncate text-[11.5px]"
                    style={{ color: "var(--color-muted)" }}
                  >
                    {meta.default_base_url || "（固定端点）"}
                    {meta.requires_key ? " · 需要 API Key" : " · 无需 Key"}
                    {meta.note ? ` · ${meta.note}` : ""}
                  </span>
                </span>
                <Chip tone={items.length > 0 ? "ok" : "muted"}>
                  {items.length > 0 ? `已配 ${items.length} 套` : "还没配"}
                </Chip>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}


// --------------------------------------------------------------------------- //
function NewCredentialDialog({
  providers,
  onClose,
  onCreated,
}: {
  providers: Provider[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [provider, setProvider] = useState(providers[0]?.name ?? "deepseek");
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  /** 新增时也可手填默认模型 ✓ */
  const [model, setModel] = useState("");
  const [tested, setTested] = useState<CredentialTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const meta = providers.find((p) => p.name === provider);
  const effectiveBase = baseUrl || meta?.default_base_url || "";

  const doTest = async () => {
    setBusy(true);
    setErr(null);
    setTested(null);
    try {
      setTested(
        await api.probeCredential({
          name: name || "probe",
          provider,
          api_key: apiKey,
          base_url: effectiveBase || null,
          default_model: model.trim() || null,
        }),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!name.trim()) {
      setErr("请填写配置名称");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.createCredential({
        name: name.trim(),
        provider,
        api_key: apiKey,
        base_url: effectiveBase || null,
        default_model: model.trim() || null,
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[var(--color-overlay)] flex items-center justify-center p-4 z-50">
      <div className="card w-full max-w-lg p-5">
        <h2 className="text-[16px] font-medium mb-1">添加 LLM 配置</h2>
        <p className="text-[12px] text-[var(--color-muted)] mb-4">
          可以先用「测试连接」验证，通过后再保存。
        </p>

        <div className="space-y-3.5">
          <div>
            <label className="label">Provider</label>
            <select
              className="input"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setTested(null);
                setBaseUrl("");
              }}
            >
              {providers.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.display_name}
                  {p.requires_key ? "" : "（无需 Key）"}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">名称（便于区分，如 deepseek-主号）</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="deepseek-main"
            />
          </div>

          <div>
            <label className="label">
              API Key {meta?.requires_key === false && "（该 Provider 无需 Key）"}
            </label>
            <input
              className="input mono"
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setTested(null);
              }}
              placeholder="sk-…"
            />
          </div>

          <div>
            <label className="label">
              Base URL{meta?.allows_base_url === false ? "（固定，不可改）" : "（可留空用默认）"}
            </label>
            <input
              className="input mono"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={meta?.default_base_url || ""}
              disabled={meta?.allows_base_url === false}
            />
          </div>

          <div>
            <label className="label">默认模型（可手填）</label>
            <div className="flex gap-2 items-stretch">
              <input
                className="input mono min-w-0 flex-1"
                placeholder="例如 deepseek-v4-flash —— 服务商没有模型清单时手填 ✓"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setTested(null);
                }}
              />
              <button
                className="btn shrink-0"
                disabled={busy}
                title="按这个模型名发一次极小调用，确认能不能真用"
                onClick={() => void doTest()}
              >
                {busy ? "测试中…" : "测试"}
              </button>
            </div>
          </div>

          {tested && (
            <div
              className={`text-[12.5px] ${tested.ok ? "text-[var(--color-ok)]" : "text-[var(--color-err)]"}`}
            >
              {tested.ok
                ? `✓ 连接成功 · 延迟 ${fmt.ms(tested.latency_ms)} · 发现 ${tested.models.length} 个模型`
                : `✗ ${tested.error}`}
            </div>
          )}
          {err && <div className="text-[12.5px] text-[var(--color-err)]">{err}</div>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn" disabled={busy || !apiKey} onClick={doTest}>
            测试连接
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>
            {busy ? "处理中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
/**
 * 编辑已有 LLM 配置。
 *
 * 两个刻意的设计
 * --------------
 * 1. **Key 留空 = 不修改**。改名字/端点/模型时不必重新粘贴密钥，避免用户
 *    为了改一个字段把密钥又贴一遍（也是泄露面）。
 2. **模型可以手填** ✓（2026-09-26 起生效；早前「只能从探测结果里选、不能手填」的规矩**已作废** ✗）**。「探测可用模型」会真调一次
 *    provider 的 /models 接口拿清单，点一下就选中；探测不到时退回该 provider
 *    的推荐清单（仍可点选），但**不开放自由输入** —— 手填一个不存在的模型名
 *    只会在真正执行时才报错，把问题推迟到最难排查的时刻。
 */
function EditCredentialDialog({
  providers,
  credential,
  onClose,
  onSaved,
}: {
  providers: Provider[];
  credential: Credential;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [provider, setProvider] = useState(credential.provider);
  const [name, setName] = useState(credential.name);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(credential.base_url ?? "");
  const [model, setModel] = useState(credential.default_model ?? "");

  const [found, setFound] = useState<string[]>([]);
  const [probeNote, setProbeNote] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const meta = providers.find((p) => p.name === provider);
  const dirty =
    provider !== credential.provider ||
    name !== credential.name ||
    baseUrl !== (credential.base_url ?? "") ||
    model !== (credential.default_model ?? "") ||
    apiKey.length > 0;

  /** 探测该凭据可用的模型清单 */
  const probeModels = async () => {
    setProbing(true);
    setProbeNote(null);
    try {
      const r = await api.credentialModels(credential.id);
      setFound(r.models ?? []);
      if (r.ok && (r.models?.length ?? 0) > 0) {
        setProbeNote(`✓ 探测到 ${r.models.length} 个模型，点一下即可选用`);
      } else if (r.suggested?.length) {
        // 探测不到就退回 provider 的推荐清单，用户仍可一键选
        setFound(r.suggested);
        setProbeNote(
          `未能从服务商取到清单${r.error ? `（${r.error}）` : ""}，下面是推荐的模型名，可直接选或手填。`,
        );
      } else {
        setProbeNote("没能取到模型清单，请手动填写模型名称。");
      }
    } catch (e) {
      setProbeNote(`探测失败：${e instanceof Error ? e.message : String(e)}，请手动填写。`);
    } finally {
      setProbing(false);
    }
  };

  /** 按**手填**的模型名做一次真实连通性测试（后端 /test 支持带 model ✓，max_tokens=1 ✓ 几乎不花钱） */
  const testModel = async () => {
    if (!model.trim()) return;
    setBusy(true);
    setProbeNote("测试中…");
    try {
      const r = await api.testCredential(credential.id, model.trim());
      setProbeNote(
        r.ok
          ? `✓ 这个模型能用 · 延迟 ${fmt.ms(r.latency_ms)}${r.model ? ` · ${r.model}` : ""}`
          : `✗ 用不了：${r.error ?? "未知错误"}`,
      );
    } catch (e) {
      setProbeNote(`✗ 测试失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doTest = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.testCredential(credential.id, model || undefined);
      if (r.ok) {
        const n = r.models?.length ?? 0;
        setErr(null);
        setProbeNote(`✓ 连接正常 · 延迟 ${fmt.ms(r.latency_ms)}${n ? ` · 发现 ${n} 个模型` : ""}`);
        if (n) setFound(r.models);
      } else {
        setProbeNote(null);
        setErr(r.error || "连接失败");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!name.trim()) {
      setErr("请填写配置名称");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.updateCredential(credential.id, {
        name: name.trim(),
        provider,
        base_url: baseUrl.trim() || null,
        // 留空 = 不改 key（后端的语义就是这样）
        ...(apiKey ? { api_key: apiKey } : {}),
        // 空串 = 清空该字段
        default_model: model.trim(),
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[var(--color-overlay)] flex items-center justify-center p-4 z-50 overflow-y-auto">
      <div className="card w-full max-w-lg p-5 my-8">
        <h2 className="text-[16px] font-medium mb-1">编辑配置「{credential.name}」</h2>
        <p className="text-[12px] text-[var(--color-muted)] mb-4">
          API Key 留空表示不修改。其它字段改完保存即生效。
        </p>

        <div className="space-y-3.5">
          <div>
            <label className="label">Provider</label>
            <select
              className="input"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setFound([]);
                setProbeNote(null);
              }}
            >
              {providers.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.display_name}
                  {p.requires_key ? "" : "（无需 Key）"}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">名称</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div>
            <label className="label">API Key（留空 = 不修改）</label>
            <input
              className="input mono"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={`当前：${credential.masked_key}（不填即保持）`}
            />
          </div>

          <div>
            <label className="label">
              Base URL{meta?.allows_base_url === false ? "（固定，不可改）" : ""}
            </label>
            <input
              className="input mono"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={meta?.default_base_url || ""}
              disabled={meta?.allows_base_url === false}
            />
          </div>

          {/* ── 默认模型 ─────────────────────────────────────── */}
          <div className="pt-1 border-t border-[var(--color-border)]">
            <label className="label mt-3">默认模型</label>
            <div className="flex gap-2 items-stretch">
              {/* 模型**可以手填**（用户要求：编辑配置里手动添加模型 → 测试 → 保存 ✓）
                  探测只是"能选就不填"的便利 ✓ —— 有些服务商（如火山引擎方舟的 Agent Plan key）
                  根本没有 /models 清单，探测不出来，只能手填 ✓ */}
              <input
                className="input mono min-w-0 flex-1"
                placeholder="手填模型名，或点右侧探测后从下方选"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setProbeNote(null);
                }}
              />
              <button className="btn shrink-0" disabled={probing} onClick={probeModels}>
                {probing ? "探测中…" : "探测可用模型"}
              </button>
              <button
                className="btn shrink-0"
                disabled={!model.trim() || busy}
                title="按这个模型名发一次极小调用，验证能不能真用（不发对话、几乎不花钱）"
                onClick={() => void testModel()}
              >
                测试
              </button>
              {model && (
                <button
                  className="btn shrink-0"
                  title="清除已选模型"
                  onClick={() => {
                    setModel("");
                    setProbeNote(null);
                  }}
                >
                  清除
                </button>
              )}
            </div>

            {probeNote && (
              <p className="text-[11.5px] text-[var(--color-muted)] mt-1.5">{probeNote}</p>
            )}

            {found.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {found.map((m) => {
                  const on = model.trim() === m;
                  return (
                    <button
                      key={m}
                      onClick={() => setModel(m)}
                      className="tag mono"
                      style={{
                        cursor: "pointer",
                        background: on
                          ? "color-mix(in srgb, var(--color-accent) 16%, transparent)"
                          : undefined,
                        color: on ? "var(--color-accent)" : undefined,
                        borderColor: on ? "var(--color-accent)" : undefined,
                      }}
                    >
                      {on ? "● " : ""}
                      {m}
                    </button>
                  );
                })}
              </div>
            )}

            {model.trim() === "" && (
              <p className="text-[11.5px] text-[var(--color-muted)] mt-1.5">
                未选择时，模型由使用它的助手决定（在助手的模型设置里选）。
              </p>
            )}
          </div>

          {err && <div className="text-[12.5px] text-[var(--color-err)]">{err}</div>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn" disabled={busy || !dirty} onClick={doTest}>
            测试连接
          </button>
          <button className="btn btn-primary" disabled={busy || !dirty} onClick={save}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
