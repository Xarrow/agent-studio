"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { Credential, CredentialTestResult, Provider } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
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
  /** 已显示明文的凭据：id → 明文 key（默认空 = 全部隐藏） */
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  /** 正在做「对话测试」的凭据（null = 没开） */
  const [chatting, setChatting] = useState<Credential | null>(null);
  const [testResult, setTestResult] = useState<Record<string, CredentialTestResult>>({});

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

  const test = async (id: string) => {
    setTesting(id);
    try {
      const r = await api.testCredential(id);
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
      <header className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight flex items-center gap-1.5">
            <Hint text={HINTS.credential}>LLM 配置</Hint>
          </h1>
          <p className="text-[13px] text-[var(--color-muted)] mt-1">
            让 AI 能工作的「钥匙」。在这里填一次，所有助手都能用；存进来会加密，不会再明文显示。
          </p>
          <p className="text-[11.5px] text-[var(--color-muted)] mt-1">
            支持 {providers.length} 家 <Hint text={HINTS.provider}>服务商</Hint> · 同一家可配多套钥匙（主号
            / 备用号）
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          + 添加配置
        </button>
      </header>

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
        <div className="card p-8 text-center mb-6">
          <p className="text-[14px] mb-2">还没有配置任何 LLM Key</p>
          <p className="text-[12.5px] text-[var(--color-muted)] mb-4">
            添加后 Agent 就能选用。Key 加密存储，列表只显示脱敏串。
          </p>
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>
            添加第一份配置
          </button>
        </div>
      ) : (
        <div className="space-y-2.5 mb-7">
          {creds.map((c) => {
            const r = testResult[c.id];
            return (
              <div key={c.id} className="card p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2.5">
                      <span className="font-medium text-[14px]">{c.name}</span>
                      <span className="tag">{c.provider_display}</span>
                      {c.last_test_ok === true && (
                        <span className="tag text-[var(--color-ok)]">✓ 上次测试通过</span>
                      )}
                      {c.last_test_ok === false && (
                        <span className="tag text-[var(--color-err)]">✗ 上次测试失败</span>
                      )}
                    </div>
                    <div className="text-[12px] text-[var(--color-muted)] mono mt-1.5 flex items-center gap-2 flex-wrap">
                      {revealed[c.id] ? (
                        <>
                          <span className="text-[var(--color-text)] break-all">
                            {revealed[c.id]}
                          </span>
                          <button
                            className="btn text-[10.5px] px-1.5 py-0.5"
                            onClick={() => void copyKey(c.id)}
                          >
                            复制
                          </button>
                          <button
                            className="btn text-[10.5px] px-1.5 py-0.5"
                            onClick={() => hide(c.id)}
                          >
                            隐藏
                          </button>
                        </>
                      ) : (
                        <span>{c.masked_key}</span>
                      )}
                      <span>· {c.base_url || "默认端点"}</span>
                    </div>
                    <div className="text-[12px] text-[var(--color-muted)] mt-1">
                      默认模型：{" "}
                      {c.default_model ? (
                        <span className="mono text-[var(--color-text)]">{c.default_model}</span>
                      ) : (
                        <span className="text-[var(--color-muted)]">未设置</span>
                      )}
                    </div>
                    {c.created_at > 0 && (
                      <div className="text-[11.5px] text-[var(--color-muted)] mt-1">
                        添加于 {fmt.relative(c.created_at)}
                        {c.last_test_at ? ` · 测试于 ${fmt.relative(c.last_test_at)}` : ""}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button className="btn" onClick={() => setEditing(c)}>
                      编辑
                    </button>
                    {revealed[c.id] ? (
                      <button className="btn" onClick={() => hide(c.id)}>
                        隐藏密钥
                      </button>
                    ) : (
                      <button className="btn" onClick={() => void reveal(c)}>
                        显示密钥
                      </button>
                    )}
                    <button
                      className="btn"
                      title="直接跟模型聊两句，不经过助手"
                      onClick={() => setChatting(c)}
                    >
                      对话测试
                    </button>
                    <button
                      className="btn"
                      disabled={testing === c.id}
                      onClick={() => test(c.id)}
                    >
                      {testing === c.id ? "测试中…" : "测试连接"}
                    </button>
                    <button className="btn text-[var(--color-err)]" onClick={() => remove(c)}>
                      删除
                    </button>
                  </div>
                </div>

                {r && (
                  <div className="mt-3 pt-3 border-t border-[var(--color-border)] text-[12.5px]">
                    {r.ok ? (
                      <div>
                        <span className="text-[var(--color-ok)]">✓ 连接正常</span>
                        <span className="text-[var(--color-muted)]">
                          {" "}
                          · 延迟 {fmt.ms(r.latency_ms)} · 模型 {r.models.length} 个
                        </span>
                        {r.models.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {r.models.slice(0, 12).map((m) => (
                              <span key={m} className="tag mono">
                                {m.trim()}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-[var(--color-err)]">
                        ✗ {r.error}
                        {r.latency_ms ? ` （${fmt.ms(r.latency_ms)}）` : ""}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 单价：把"用了多少 token"变成"花了多少钱"。放在密钥下面 ——
          它的输入是密钥连着的那些模型，用户的动线是"配好 key → 顺手把单价填了"。 */}
      <PriceBook />

      <section>
        <h2 className="text-[15px] font-medium mb-3">支持的 Provider</h2>
        <div className="grid gap-2 md:grid-cols-3">
          {byProvider.map(({ meta, items }) => (
            <div key={meta.name} className="card p-3.5">
              <div className="flex items-center justify-between">
                <span className="text-[13.5px] font-medium">{meta.display_name}</span>
                <span className="tag mono">{items.length}</span>
              </div>
              <div className="text-[11.5px] text-[var(--color-muted)] mt-1.5 mono truncate">
                {meta.default_base_url || "（固定端点）"}
              </div>
              <div className="text-[11.5px] text-[var(--color-muted)] mt-1">
                {meta.requires_key ? "需要 API Key" : "无需 Key"}
                {meta.note ? ` · ${meta.note}` : ""}
              </div>
            </div>
          ))}
        </div>
      </section>
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
 * 2. **模型只能从探测结果里选，不能手填**。「探测可用模型」会真调一次
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
              {/* 只读展示：模型不能手填，必须从探测出来的清单里点选 */}
              <div className="input mono flex-1 flex items-center min-h-[38px]">
                {model ? (
                  <span className="text-[var(--color-text)]">{model}</span>
                ) : (
                  <span className="text-[var(--color-muted)]">未选择</span>
                )}
              </div>
              <button className="btn shrink-0" disabled={probing} onClick={probeModels}>
                {probing ? "探测中…" : "探测可用模型"}
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
