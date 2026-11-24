"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useFirstLoad } from "@/lib/useFirstLoad";
import { api, fmt } from "@/lib/api";
import type { Credential, CredentialDetectResult, CredentialTestResult, Provider } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";
import { Chip, DLG_BACKDROP, DLG_CARD, Empty, KV, Menu, PageHead, Row, RowList, Section } from "@/components/ui/kit";
import { DetailPanel } from "@/components/ui/DetailPanel";
import { Select } from "@/components/ui/select";

/** 对话模型服务商：kind="tools" 的是工具密钥（搜索/抓取/OCR/语音），不该进 LLM 配置 */
const isLlmProvider = (p: Provider) => (p.kind ?? "llm") !== "tools";
import { ModelPicker, dedupeModelNames } from "@/components/ModelPicker";
import {
  IconChat,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconCopy,
  IconEye,
  IconKey,
  IconLink,
  IconPencil,
  IconPlus,
  IconSpark,
  IconTrash,
} from "@/components/ui/icons";
import { PriceBook } from "@/components/PriceBook";
import { Hint, HINTS } from "@/components/ui/hint";
import { CredentialChatDialog } from "@/components/CredentialChatDialog";

export default function CredentialsPage() {
  const fb = useFeedback();
  /** 骨架只在首屏出现；刷新原地更新，避免整页闪一下 */
  const { loaded, markLoaded } = useFirstLoad();
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
      markLoaded();
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
      details: ["确认周围没人、没在录屏"],
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
      fb.warn("复制失败", "浏览器不让读剪贴板，请手动复制");
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

  /**
   * 一条凭据的动作集：**行内和展开面板共用这一套**（以前两处各写一遍，措辞还不一致）。
   * 只留 3 个：编辑 / 自检 / ⋯。「自检」= 探端点 + 验证 key 真的能调；
   * 原来并排的「测试连接」「对话测试」名字太近、用户分不清，对话调试收进 ⋯。
   */
  const credActions = (c: Credential, big = false) => {
    const btn = big ? "btn btn-sm" : "btn text-[length:var(--fs-sm)] max-md:w-9 max-md:px-0";
    const primary = big ? "btn btn-primary btn-sm" : "btn text-[length:var(--fs-sm)] max-md:w-9 max-md:px-0";
    const label = (text: string) => (big ? text : <span className="max-md:hidden">{text}</span>);
    return (
      <>
        <button type="button" className={primary} title="编辑" aria-label="编辑" onClick={() => setEditing(c)}>
          <IconPencil size={big ? 14 : undefined} className={big ? undefined : "md:hidden"} />
          {label("编辑")}
        </button>
        <button
          type="button"
          className={btn}
          title="拿这条钥匙探一次端点，验证它能不能真的调用"
          aria-label="自检"
          disabled={testing === c.id}
          onClick={() => {
            setExpanded(c.id);
            void test(c.id);
          }}
        >
          <IconLink size={big ? 14 : undefined} className={big ? undefined : "md:hidden"} />
          {label(testing === c.id ? "自检中…" : "自检")}
        </button>
        <Menu
          title="更多"
          items={[
            {
              label: revealed[c.id] ? "隐藏密钥" : "显示密钥",
              onSelect: () => {
                setExpanded(c.id);          // 明文只在展开面板里出现，先展开再说
                if (revealed[c.id]) hide(c.id);
                else void reveal(c);
              },
            },
            { label: "对话测试", onSelect: () => setChatting(c), hint: "跟模型聊一句，不经过助手" },
            {
              label: "删除",
              danger: true,
              // 被引用时**直接禁用**：以前只是文案写"删不掉"，点下去仍然弹确认框，
              // 用户确认后才被后端 409 拒 —— 看着像"能删但没生效"（验收报的 P0）。
              disabled: (c.used_by ?? 0) > 0,
              onSelect: () => void remove(c),
              hint:
                (c.used_by ?? 0) > 0
                  ? `${c.used_by} 个助手在用，删不掉${c.used_by_names?.length ? "：" + c.used_by_names.join("、") : ""}`
                  : undefined,
            },
          ]}
        />
      </>
    );
  };

  const remove = async (c: Credential) => {
    if ((c.used_by ?? 0) > 0) {
      fb.warn("这条配置还在用", `${c.used_by} 个助手引用了它；先给它们换一条再删。`);
      return;
    }
    // 没被引用才走到这里：仍然要求输入配置名，避免手滑（删的是长期可用的钥匙）
    const typed = await fb.prompt({
      title: `删除配置「${c.name}」`,
      label: `输入配置名「${c.name}」确认`,
      description: "对话和记忆不会跟着删；这条钥匙会立刻失效。",
      validate: (v) => (v.trim() === c.name ? null : "名字不一致，没有删除"),
      confirmText: "删除",
    });
    const ok = typed !== null && typed.trim() === c.name;
    if (!ok) return;
    try {
      await api.deleteCredential(c.id);
      fb.success(`已删除配置「${c.name}」`);
      await load();
    } catch (e) {
      fb.error("删除配置失败", e instanceof Error ? e.message : String(e));
    }
  };

  // 工具密钥（kind="tools"：搜索/抓取/OCR/语音）不是对话模型：
  // 只在「能力」页配，不进这里的服务商下拉，也不按服务商分组列出来。
  const llmProviders = providers.filter((p) => (p.kind ?? "llm") !== "tools");

  const byProvider = llmProviders.map((p) => ({
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
            {!loaded
              ? "正在读取…"
              : llmProviders.length
                ? `支持 ${llmProviders.length} 家服务商`
                : "支持多家服务商"}
            ，同一家可以配多套。
          </>
        }
        actions={
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>
            + 添加配置
          </button>
        }
      />

      {err && (
        <div className="card p-4 mb-4 text-[length:var(--fs-base)] text-[var(--color-err)]">
          加载失败：{err}
        </div>
      )}

      {showNew && (
        <NewCredentialDialog
          providers={providers}
          creds={creds}
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

      {!loaded ? (
        <div className="card p-6 text-[length:var(--fs-base)] text-[var(--color-muted)]">加载中…</div>
      ) : creds.length === 0 ? (
        <div className="card">
          <Empty
            title="还没有配置任何 LLM Key"
            hint="添加后即可选用；Key 加密存，只显示脱敏串"
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
                  actions={credActions(c)}
                >
                  <span className="min-w-0 flex-1 basis-[240px]">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate text-[length:var(--fs-md)] font-medium">{c.name}</span>
                      <Chip tone="muted">{c.provider_display}</Chip>
                      {/* 被几个助手在用：删除会被拒绝，先让用户看得见 */}
                      {(c.used_by ?? 0) > 0 && (
                        <Chip tone="muted" title="删掉这条，这些助手就没有可用的钥匙了">
                          {c.used_by} 个助手在用
                        </Chip>
                      )}
                      {c.last_test_ok === true && <Chip tone="ok">上次测试通过</Chip>}
                      {c.last_test_ok === false && <Chip tone="err">上次测试失败</Chip>}
                      {/* 失败原因落库了就该给用户看（last_test_error 随列表返回，
                          原来前端从不显示——刷新后只剩一个红 chip，无从排查） */}
                      {c.last_test_ok === false && c.last_test_error && (
                        <span
                          className="basis-full truncate text-[length:var(--fs-sm)]"
                          style={{ color: "var(--color-err)" }}
                          title={c.last_test_error}
                        >
                          {c.last_test_error}
                        </span>
                      )}
                    </span>
                    {/* 元信息：图标 + 短词，三个事实不再用「·」串成一句话 */}
                    <span
                      className="mt-1 flex items-center gap-3 text-[length:var(--fs-sm)]"
                      style={{ color: "var(--color-muted)" }}
                    >
                      <span className="inline-flex min-w-0 items-center gap-1" title="密钥（掩码）">
                        <IconKey size={12} className="shrink-0" />
                        {/* 行里永远只放掩码 —— 明文只出现在下面展开面板的 API Key 区块（点「显示」才有）。
                            之前这里也渲染 revealed，等于同一份明文同时挂在两处、收起面板后行里还留着。 */}
                        <span className="truncate mono">{c.masked_key}</span>
                      </span>
                      <span className="inline-flex min-w-0 items-center gap-1" title="请求端点">
                        <IconLink size={12} className="shrink-0" />
                        <span className="truncate mono">{c.base_url || "默认端点"}</span>
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap" title="默认模型">
                        <IconSpark size={12} />
                        {c.default_model || "未指定"}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0" style={{ color: "var(--color-muted)" }}>
                    <IconChevronRight size={16} />
                  </span>
                </Row>

                {open && (
                  <DetailPanel
                    title={c.name}
                    icon={<IconKey size={22} />}
                    subtitle={
                      <>
                        <Chip tone="muted">{c.provider_display}</Chip>
                        {c.last_test_ok === true && <Chip tone="ok">上次通过</Chip>}
                        {c.last_test_ok === false && <Chip tone="err">上次失败</Chip>}
                      </>
                    }
                    facts={[
                      { icon: <IconLink size={13} />, text: c.base_url || "默认端点", title: "请求打到哪个地址" },
                      { icon: <IconSpark size={13} />, text: c.default_model || "未指定模型", title: "默认模型" },
                      ...(c.last_test_at
                        ? [{ icon: <IconClock size={13} />, text: `测于 ${fmt.relative(c.last_test_at)}`, title: "上次测试时间" }]
                        : []),
                      ...(c.created_at > 0
                        ? [{ icon: <IconPlus size={13} />, text: `添加于 ${fmt.relative(c.created_at)}`, title: "添加时间" }]
                        : []),
                    ]}
                    actions={credActions(c, true)}
                    onClose={() => setExpanded(null)}
                  >
                    {/* 密钥本体：默认掩码，点了才显示 —— 明文只在这个区块里出现 */}
                    <div
                      className="rounded-[var(--radius-md)] border p-3"
                      style={{ borderColor: "var(--color-border)", background: "var(--color-bg)" }}
                    >
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 text-[length:var(--fs-sm)]" style={{ color: "var(--color-muted)" }}>
                          <IconKey size={12} />
                          API Key
                        </span>
                        <span className="flex items-center gap-1">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[length:var(--fs-sm)] hover:bg-[var(--color-surface-2)]"
                            style={{ color: "var(--color-accent)" }}
                            onClick={() => (revealed[c.id] ? hide(c.id) : void reveal(c))}
                          >
                            <IconEye size={12} />
                            {revealed[c.id] ? "隐藏" : "显示"}
                          </button>
                          {revealed[c.id] ? (
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[length:var(--fs-sm)] hover:bg-[var(--color-surface-2)]"
                              style={{ color: "var(--color-accent)" }}
                              onClick={() => void copyKey(c.id)}
                            >
                              <IconCopy size={12} />
                              复制
                            </button>
                          ) : null}
                        </span>
                      </div>
                      <div className="mono break-all text-[length:var(--fs-base)]">
                        {revealed[c.id] || c.masked_key}
                      </div>
                    </div>

                    {/* 测试结果：成功给绿的框 + 延迟 + 可用模型；失败给红的框 + 原始错误 */}
                    {r ? (
                      <div
                        className="mt-3 rounded-[var(--radius-md)] border p-3 text-[length:var(--fs-base)]"
                        style={{ borderColor: r.ok ? "var(--color-ok)" : "var(--color-err)" }}
                      >
                        {r.ok ? (
                          <>
                            <div className="inline-flex items-center gap-1.5" style={{ color: "var(--color-ok)" }}>
                              <IconCheck size={14} />
                              连接正常
                            </div>
                            <div className="mt-1 inline-flex items-center gap-1.5 text-[length:var(--fs-sm)]" style={{ color: "var(--color-muted)" }}>
                              <IconClock size={12} />
                              延迟 {fmt.ms(r.latency_ms)}
                              <span>·</span>
                              可用模型 {r.models.length} 个
                            </div>
                            {r.models.length > 0 ? (
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {r.models.slice(0, 12).map((m) => (
                                  <Chip key={m} tone="muted">
                                    {m.trim()}
                                  </Chip>
                                ))}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <div className="inline-flex items-start gap-1.5" style={{ color: "var(--color-err)" }}>
                            <IconTrash size={14} className="mt-0.5 shrink-0" />
                            <span>
                              {r.error}
                              {r.latency_ms ? ` （${fmt.ms(r.latency_ms)}）` : ""}
                            </span>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </DetailPanel>
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
          // 加载完再报家数：否则首屏先写「支持的 Provider 0 家」，用户以为一家都不支持
          count={loaded ? `${byProvider.length} 家` : undefined}
        >
          {!loaded ? (
            <div className="py-2 text-[length:var(--fs-base)]" style={{ color: "var(--color-muted)" }}>
              正在读取服务商清单…
            </div>
          ) : (
          <div className="flex flex-col">
            {byProvider.map(({ meta, items }) => (
              <div
                key={meta.name}
                className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-[var(--radius-sm)] px-1.5 py-2.5 hover:bg-[var(--bg-hover)]"
              >
                <span className="min-w-0 flex-1 basis-[220px]">
                  <span className="block text-[length:var(--fs-md)] font-medium">{meta.display_name}</span>
                  <span
                    className="mono mt-0.5 block truncate text-[length:var(--fs-sm)]"
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
          )}
        </Section>
      </div>
    </div>
  );
}


// --------------------------------------------------------------------------- //
function NewCredentialDialog({
  providers,
  creds,
  onClose,
  onCreated,
}: {
  providers: Provider[];
  /** 已有配置：用来在保存前就拦住"名字重复"，而不是等后端 409 */
  creds: Credential[];
  onClose: () => void;
  onCreated: () => void;
}) {
  /* 第一屏只有一个主动作：粘贴 Key。服务商 / 名称 / 端点 / 测试 / 模型清单
     都由平台按这个 Key 认出来 —— 「选服务商 → 填名 → 填端点 → 填 Key →
     手输模型 → 测试 → 保存」那 6 步对一次性动作来说太重了。 */
  const [apiKey, setApiKey] = useState("");
  /** 空串 = 还没认出来（下拉里让用户选） */
  const [provider, setProvider] = useState("");
  const [providerTouched, setProviderTouched] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [detected, setDetected] = useState<CredentialDetectResult | null>(null);
  const [phase, setPhase] = useState<"idle" | "detecting" | "ok" | "fail">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 同一个（Key + 指定服务商）只自动识别一次 */
  const detectFor = useRef("");

  const meta = providers.find((p) => p.name === provider);
  /** 这家要不要 Key（Ollama 这类本地服务不用） */
  const needsKey = meta?.requires_key !== false;
  /**
   * 这家能不能自动验证：要 Key、且平台知道它的默认端点。
   * Gemini（自有协议、没有默认端点）和 Ollama（本地、不需要 Key）拿 OpenAI 兼容
   * 的探针去试只会把**好 Key 判成坏 Key**（401/404）—— 这类不拦保存，
   * 但界面上说清「没验证过」，别让人以为已验证。
   */
  const canVerify = Boolean(meta?.default_base_url) && needsKey;
  /** 已验证（或这家本来就验证不了 → 允许保存，只说清事实） */
  const verified = phase === "ok" || (Boolean(provider) && !canVerify);
  /** 系统生成的名称：留空就用它，且保证不与现有重名 */
  const autoName = (p: string) => {
    const taken = new Set(creds.map((c) => c.name));
    let n = 1;
    while (taken.has(`${p}-${n}`)) n += 1;
    return `${p}-${n}`;
  };
  const finalName = nameDraft.trim() || (provider ? autoName(provider) : "");

  const runDetect = async (key: string, prov?: string) => {
    setPhase("detecting");
    setErr(null);
    setDetected(null);
    setModels([]);
    try {
      const r = await api.detectCredential({ api_key: key, provider: prov });
      setDetected(r);
      if (!r.ok) {
        setPhase("fail");
        setErr(r.reason || "没能识别这个 Key。检查一下，或从下拉里改选服务商。");
        return;
      }
      setProvider(r.provider);
      setBaseUrl(r.base_url ?? "");
      // 真实清单优先；这家不列模型时用推荐清单兜底（仍是选择器，不给自由文本）
      const list = dedupeModelNames(r.models?.length ? r.models : r.suggested || []);
      setModels(list);
      setModel(list[0] ?? "");
      setPhase("ok");
    } catch {
      setPhase("fail");
      setErr("识别失败：连不上平台服务。检查网络后点「重新识别」。");
    }
  };

  /* 粘贴即测：停手 600ms 自动识别 + 验证（不用再点「测试连接」） */
  useEffect(() => {
    const k = apiKey.trim();
    // 用户选了一家平台验证不了的服务商（Gemini/Ollama）：不去试，直接给它的静态清单
    if (provider && !canVerify) {
      const list = dedupeModelNames(meta?.models ?? []);
      setModels(list);
      setModel((m) => m || list[0] || "");
      setPhase("idle");
      return;
    }
    if (k.length < 12) {
      setPhase("idle");
      setDetected(null);
      setModels([]);
      return;
    }
    const sig = `${k}|${providerTouched ? provider : ""}`;
    if (detectFor.current === sig) return;
    const t = window.setTimeout(() => {
      detectFor.current = sig;
      void runDetect(k, providerTouched ? provider : undefined);
    }, 600);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, provider, providerTouched, canVerify]);

  const save = async () => {
    if (!provider) {
      setErr("还没认出这家服务商：从下面的下拉里选一家，再点完成。");
      return;
    }
    if (needsKey && !apiKey.trim()) {
      setErr("先粘贴 API Key。");
      return;
    }
    if (!verified) {
      setErr("这个 Key 还没验证通过，先修好 Key（或改选服务商）再保存。");
      return;
    }
    if (!finalName) {
      setErr("先给这条配置起个名字。");
      return;
    }
    if (creds.some((c) => c.name === finalName)) {
      setErr(`名称「${finalName}」已存在，换一个。`);
      return;
    }
    if (!model) {
      setErr("先选一个默认模型。");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.createCredential({
        name: finalName,
        provider,
        api_key: apiKey.trim(),
        base_url: baseUrl.trim() || null,
        default_model: model,
      });
      onCreated();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(/409|已存在/.test(msg) ? `名称「${finalName}」已存在，换一个。` : `保存失败：${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const canSave = Boolean(provider) && (!needsKey || apiKey.trim()) && verified && Boolean(model);
  const saveHint = Boolean(provider) && !canVerify
    ? needsKey
      ? "这家没法自动验证：Key 会原样保存，保存后用一次对话确认能通"
      : "本地服务不需要 Key：选好模型就能保存"
    : !apiKey.trim()
      ? "先粘贴 API Key（平台会自动认出服务商并验证）"
      : phase === "detecting"
        ? "正在识别这个 Key…"
        : !verified
          ? "这个 Key 还没验证通过：修好它，或从下拉里改选服务商"
          : !model
            ? "先选一个默认模型"
            : "";

  return (
    <div className={DLG_BACKDROP}>
      <div className={`${DLG_CARD} max-w-lg p-5`}>
        <h2 className="text-[16px] font-medium mb-1">添加 LLM 配置</h2>
        <p className="text-[length:var(--fs-sm)] text-[var(--color-muted)] mb-4">粘贴 Key → 确认模型 → 完成。</p>

        <div className="space-y-3">
          {/* 第一屏唯一的主动作 */}
          <div>
            <label className="label">
              API Key{needsKey ? "" : "（这家不需要 Key，可留空）"}
            </label>
            <input
              className="input mono"
              type="password"
              autoFocus
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setErr(null);
              }}
              placeholder="粘贴 sk-… / 你的服务商 Key"
            />
          </div>

          {/* 识别结果一行：认出哪家、要不要手动改 */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--fs-sm)]">
            {phase === "detecting" && <span style={{ color: "var(--color-text-3)" }}>正在识别服务商并验证…</span>}
            {phase === "ok" && detected && (
              <span style={{ color: "var(--color-ok)" }}>
                ✓ 认出是 {detected.display_name}
                {detected.latency_ms != null ? ` · ${fmt.ms(detected.latency_ms)}` : ""}
                {` · ${detected.models.length || models.length} 个模型`}
              </span>
            )}
            {phase === "idle" && !provider && (
              <span style={{ color: "var(--color-text-3)" }}>粘贴后自动识别服务商；认不出再从下面选。</span>
            )}
            {Boolean(provider) && !canVerify && (
              <span style={{ color: "var(--color-text-3)" }}>
                这家平台没法自动验证（没有可试的接口），保存后用一次对话确认。
              </span>
            )}
            <label className="ml-auto flex items-center gap-1.5" style={{ color: "var(--color-text-3)" }}>
              服务商
              <Select
                className="!w-[172px]"
                compact
                ariaLabel="服务商"
                value={provider}
                placeholder="（未识别 · 从这选）"
                options={[
                  { value: "", label: "（未识别 · 从这选）" },
                  ...providers.filter(isLlmProvider).map((p) => ({
                    value: p.name,
                    label: p.display_name,
                  })),
                ]}
                onChange={(v) => {
                  setProvider(v);
                  setProviderTouched(true);
                  setDetected(null);
                  setModels([]);
                  setModel("");
                  if (!v) setBaseUrl("");
                }}
              />
            </label>
          </div>

          {err && <div className="text-[length:var(--fs-sm)] text-[var(--color-err)]">{err}</div>}

          {/* 验证通过后（或这家本来就验证不了）才出现：名称（可留空）/ 默认模型选择器 */}
          {verified && (
            <>
              <div>
                <label className="label">名称</label>
                <input
                  className="input"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder={finalName || "自动生成"}
                />
                <p className="mt-1 text-[length:var(--fs-sm)]" style={{ color: "var(--color-text-3)" }}>
                  留空就用「{finalName}」（系统生成，不会与现有重名）
                </p>
              </div>

              <div>
                <label className="label">默认模型</label>
                <ModelPicker
                  providers={providers}
                  provider={provider}
                  models={models}
                  allowManual={false}
                  value={model}
                  onChange={setModel}
                />
                {models.length === 0 && (
                  <p className="mt-1 text-[length:var(--fs-sm)]" style={{ color: "var(--color-warn)" }}>
                    这家没给出模型清单：先选一个推荐模型（也可以保存后在配置里重新探测）。
                  </p>
                )}
              </div>

              <details className="text-[length:var(--fs-sm)]">
                <summary className="cursor-pointer select-none py-1" style={{ color: "var(--color-text-3)" }}>
                  端点（默认已填好，一般不用改）
                </summary>
                <input
                  className="input mono mt-1.5"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={meta?.default_base_url || ""}
                  disabled={meta?.allows_base_url === false}
                />
              </details>
            </>
          )}

          {phase === "fail" && detected && detected.tried.length > 0 && (
            <div className="text-[length:var(--fs-sm)]" style={{ color: "var(--color-text-3)" }}>
              试过：{detected.tried.map((t: { display_name: string }) => t.display_name).join("、")}。识别不出就从上面改选服务商。
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 mt-5">
          {/* 禁用原因写在按钮旁边 + title 上，不用「点了没反应」的哑按钮 */}
          <span className="mr-auto text-[length:var(--fs-sm)]" style={{ color: "var(--color-text-3)" }}>
            {saveHint}
          </span>
          {/* 验证不了的服务商没有「重新识别」这一步，别摆一个点了也不动的按钮 */}
          {(!provider || canVerify) && (
            <button
              className="btn"
              disabled={!apiKey.trim() || busy || phase === "detecting"}
              title={!apiKey.trim() ? "先粘贴 API Key 才能验证" : "重新识别并验证这个 Key"}
              onClick={() => {
                const k = apiKey.trim();
                detectFor.current = `${k}|${providerTouched ? provider : ""}`;
                void runDetect(k, providerTouched ? provider : undefined);
              }}
            >
              {phase === "detecting" ? "识别中…" : "重新识别"}
            </button>
          )}
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy || !canSave} title={saveHint || undefined} onClick={save}>
            {busy ? "保存中…" : "完成"}
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
  const probingRef = useRef(false);
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
    // 防连点：probing 置位前可能积压多次同步调用（React 批处理下 disabled
    // 还没渲染出来，真机连点 3 次实测发 3 个请求）——先查 ref 闸门
    if (probingRef.current) return;
    probingRef.current = true;
    setProbing(true);
    setProbeNote(null);
    try {
      const r = await api.credentialModels(credential.id);
      setFound(r.models ?? []);
      if (r.ok && (r.models?.length ?? 0) > 0) {
        setProbeNote(`✓ 探测到 ${r.models.length} 个模型，点一下选用`);
      } else if (r.suggested?.length) {
        // 探测不到就退回 provider 的推荐清单，用户仍可一键选
        setFound(r.suggested);
        setProbeNote(
          `未能从服务商取到清单${r.error ? `（${r.error}）` : ""}，下面是推荐的模型名，可直接选或手填。`,
        );
      } else {
        setProbeNote("没取到清单，请手填模型名");
      }
    } catch (e) {
      setProbeNote(`探测失败：${e instanceof Error ? e.message : String(e)}，请手动填写。`);
    } finally {
      probingRef.current = false;
      setProbing(false);
    }
  };

  /** 按**手填**的模型名做一次真实连通性测试（后端 /test 支持带 model ✓，max_tokens=1 ✓ 几乎不花钱） */
  const testModel = async () => {
    // 没选模型也能自检：用这条配置里存的默认模型，再不行用该家第一个推荐模型。
    // 以前按钮直接置灰，用户以为"编辑时不能测、必须重填密钥"（验收报的）
    const target = model.trim() || credential.default_model || meta?.models?.[0] || "";
    if (!target) {
      setProbeNote("这条配置没有默认模型，先选一个再测");
      return;
    }
    setBusy(true);
    setProbeNote("测试中…");
    try {
      const r = await api.testCredential(credential.id, target);
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
    <div className={DLG_BACKDROP}>
      <div className={`${DLG_CARD} max-w-lg p-5`}>
        <h2 className="text-[16px] font-medium mb-1">编辑配置「{credential.name}」</h2>
        <p className="text-[length:var(--fs-sm)] text-[var(--color-muted)] mb-4">
          API Key 留空表示不修改。其它字段改完保存即生效。
        </p>

        <div className="space-y-3.5">
          <div>
            <label className="label">Provider</label>
            <Select
              ariaLabel="Provider"
              value={provider}
              placeholder="选一家"
              options={providers.filter(isLlmProvider).map((p) => ({
                value: p.name,
                label: p.display_name,
                hint: p.requires_key ? undefined : "无需 Key",
              }))}
              onChange={(v) => {
                setProvider(v);
                setFound([]);
                setProbeNote(null);
                // 切 Provider 联动 Base URL —— 但**不清空已保存的值**：
                // 用户存的 /api/plan/v3 切走再切回来就没了，静默丢数据（真机复现过：
                // 火山 Agent Plan 的端点是它唯一能通的写法，一保存生产凭据就断）。
                // 规约：切 option 只过滤显示，值还在；只有新 Provider 明确不允许
                // 自定义端点（allows_base_url=false）才重置，否则原值原样保留。
                const nextMeta = providers.find((p) => p.name === v);
                if (nextMeta?.allows_base_url === false) setBaseUrl("");
              }}
            />
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
              {/* 与助手配置页、备用模型、新建向导用同一个选择器：
                  搜索 / 大小写不敏感 / 多词 / :batch 与 ~ 别名去重 / 单价并排 /
                  最近使用置顶 —— 以前这里是 462 个 chip 平铺，翻不动也选不准 */}
              <div className="min-w-0 flex-1">
                <ModelPicker
                  providers={providers}
                  provider={provider}
                  credentialId={credential.id}
                  value={model}
                  onChange={(v) => {
                    setModel(v);
                    setProbeNote(null);
                  }}
                />
              </div>
              <button
                className="btn shrink-0"
                disabled={busy}
                title="用这条配置里已保存的密钥发一次极小调用（几乎不花钱）"
                onClick={() => void testModel()}
              >
                {busy ? "自检中…" : "自检"}
              </button>
            </div>
            {model.trim() === "" && (
              <p className="text-[length:var(--fs-sm)] text-[var(--color-muted)] mt-1.5">
                未选择时，模型由使用它的助手决定（在助手的模型设置里选）。
              </p>
            )}
          </div>

          {err && <div className="text-[length:var(--fs-sm)] text-[var(--color-err)]">{err}</div>}
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
