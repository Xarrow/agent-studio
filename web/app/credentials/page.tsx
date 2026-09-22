"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { Credential, CredentialTestResult, Provider } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { Hint, HINTS } from "@/components/ui/hint";

export default function CredentialsPage() {
  const fb = useFeedback();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [creds, setCreds] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
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
                    <div className="text-[12px] text-[var(--color-muted)] mono mt-1.5">
                      {c.masked_key} · {c.base_url || "默认端点"}
                    </div>
                    {c.created_at > 0 && (
                      <div className="text-[11.5px] text-[var(--color-muted)] mt-1">
                        添加于 {fmt.relative(c.created_at)}
                        {c.last_test_at ? ` · 测试于 ${fmt.relative(c.last_test_at)}` : ""}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0">
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
