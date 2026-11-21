"use client";

/**
 * 模型选择器 —— 一个**看得见的下拉框**。
 *
 * 为什么要专门做个组件
 * --------------------
 * 原来两处（助手详情页、新建助手弹窗）都是：
 *
 *     <input list="m-options" />  +  <datalist id="m-options">…</datalist>
 *
 * ``<datalist>`` 是浏览器原生特性，**没有下拉箭头、点击也不展开**，只在你
 * 手动敲字时才浮出候选 —— 看起来就是个普通文本框。用户真实反馈：
 * 「选择 Provider，但没有模型下拉框的选择」。
 *
 * 候选来源原来也是 provider 的**静态清单**（代码里写死的两三条），跟账号里
 * 真实可用的模型对不上。现在改成**真去探测选中的那条凭据**。
 *
 * 关于「手动填写」这个口子
 * ----------------------
 * 有些服务商的模型名是按账号来的、探测不到（典型：火山引擎方舟的接入点
 * ``ep-xxxxxxxx``）。全锁死会让这些情况彻底无解，所以保留一个显式的
 * 「手动填写…」入口 —— 是**主动选择**进入，而不是糊在一个看不出能选的框里。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Provider } from "@/lib/types";
import { isImeEvent } from "@/lib/ime";

/** 探测结果缓存：同一条凭据不重复打网络（探测要 1-2 秒） */
const probeCache = new Map<string, string[]>();
/** 该缓存是否来自服务商真实返回 */
const probeCacheReal = new Map<string, boolean>();

export function ModelPicker({
  providers,
  provider,
  credentialId,
  value,
  onChange,
}: {
  providers: Provider[];
  provider: string;
  credentialId?: string | null;
  value: string;
  onChange: (v: string) => void;
}) {
  const [probed, setProbed] = useState<string[]>([]);
  /** 探测到的清单是否来自服务商真实返回（false = 只是本地推荐清单） */
  const [probedIsReal, setProbedIsReal] = useState(false);
  const [probing, setProbing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** 换服务商时"模型被换掉"的说明（静默改值是更糟的体验） */
  const [switchNote, setSwitchNote] = useState<string | null>(null);
  /** 下拉展开 / 过滤词 / 键盘高亮项 */
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const [manual, setManual] = useState(false);
  const probedFor = useRef<string | null>(null);

  const meta = useMemo(() => providers.find((p) => p.name === provider), [providers, provider]);

/** 探测回来的清单去重：OpenRouter 这类会同时给 foo、foo:batch、~foo 三种壳，
    平铺出来就是 462 个芯片墙，还容易选到"批量档"。规则：
    ① 有基础名的，丢掉 `:batch` 档；② 有非 `~` 版本的，丢掉 `~` 别名；③ 其余按原样去重。 */
function dedupeModels(list: string[]): string[] {
  const names = list.map((x) => String(x || "").trim()).filter(Boolean);
  const lower = new Set(names.map((n) => n.toLowerCase()));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    const base = n.replace(/:batch$/i, "");
    const bare = base.replace(/^~/, "");
    if (/:batch$/i.test(n) && lower.has(base.toLowerCase())) continue;
    if (base.startsWith("~") && lower.has(bare.toLowerCase())) continue;
    const k = bare.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

  const doProbe = useCallback(
    async (force = false) => {
      if (!credentialId) return;
      const key = credentialId;
      probedFor.current = key;
      if (!force && probeCache.has(key)) {
        setProbed(probeCache.get(key)!);
        setProbedIsReal(probeCacheReal.get(key) ?? false);
        setNote(null);
        return;
      }
      setProbing(true);
      setNote(null);
      try {
        const r = await api.credentialModels(credentialId);
        // 优先用真实清单；探测不到就用该服务商的推荐清单兜底
        const isReal = (r.models?.length ?? 0) > 0;
        const list = dedupeModels((isReal ? r.models : (r.suggested ?? [])) || []);
        probeCache.set(key, list);
        probeCacheReal.set(key, isReal);
        setProbed(list);
        setProbedIsReal(isReal);
        if (r.models?.length) {
          setNote(
            `✓ 探测到 ${r.models.length} 个，去掉重复档后 ${list.length} 个可选`,
          );
        } else if (r.suggested?.length) {
          setNote("该服务商不列模型，下面是推荐清单");
        } else {
          setNote("没能取到模型清单，可用「手动填写」");
        }
      } catch (e) {
        setNote(`探测失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setProbing(false);
      }
    },
    [credentialId],
  );

  // 换服务商 / 换凭据 → 重新探测
  useEffect(() => {
    if (!credentialId) {
      probedFor.current = null;
      setProbed([]);
      setNote(null);
      return;
    }
    if (probedFor.current !== credentialId) void doProbe();
  }, [credentialId, doProbe]);

  // 选项构造：
  //   · 探测到真实清单 → 只用真清单 + 当前值（**不掺** provider 静态清单 ——
  //     那几条是代码里写死的，账号里未必存在，混进来只会让人选错）
  //   · 探测不到       → 退回 provider 推荐清单 + 当前值
  //   · 无论如何都带上当前值，保证已有配置不会被悄悄改掉
  /** 挂载时是哪家：只有在"没换过服务商"时才保留原值，换过就不该把旧家的模型带过来 */
  const providerAtMount = useRef(provider);
  const candidates = useMemo(() => {
    const out: string[] = [];
    const push = (v?: string | null) => {
      const k = (v ?? "").trim();
      if (k && !out.includes(k)) out.push(k);
    };
    probed.forEach(push);
    if (!probedIsReal) (meta?.models ?? []).forEach(push);
    return out;
  }, [probed, probedIsReal, meta]);

  const options = useMemo(() => {
    const out = [...candidates];
    const cur = (value ?? "").trim();
    // 当前值只有在"属于这家"或"用户根本没换过服务商"时才进候选 ——
    // 否则会出现 openai 的下拉里躺着 deepseek-flash，选下去就是一个必然 400 的组合
    const belongs = candidates.includes(cur);
    if (cur && (belongs || provider === providerAtMount.current) && !out.includes(cur)) out.push(cur);
    return out;
  }, [candidates, value, provider]);

  /** 输入即过滤：大小写不敏感，去空格（" GPT " 也能命中） */
  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return options;
    return options.filter((m) => m.toLowerCase().includes(k));
  }, [options, q]);

  /* 换了服务商：旧的模型名必须换掉，并说清楚换成了什么（不能静默改值） */
  const prevProvider = useRef(provider);
  useEffect(() => {
    if (prevProvider.current === provider) return;
    prevProvider.current = provider;
    // 换服务商：上一家的探测结果立刻作废（它属于上一条凭据，留着只会选错）
    setProbed([]);
    setProbedIsReal(false);
    setNote(null);
    probedFor.current = null;
    if (!value) return;
    // 只用**新这家**的静态清单挑默认值，绝不拿旧候选（旧候选此刻还是上一家的）
    const statics = meta?.models ?? [];
    if (statics.includes(value)) return;
    const next = statics[0] ?? "";
    if (next) {
      onChange(next);
      setSwitchNote(`已换成 ${next}（原模型属于上一家服务商）`);
    } else {
      onChange("");
      setSwitchNote("这家还没有可用清单，请手动填写模型名");
      setManual(true);
    }
  }, [provider, meta, value, onChange]);

  // 探测不到任何候选 → 直接进手填模式，别让用户对着空下拉框发呆
  useEffect(() => {
    if (!probing && options.length === 0) setManual(true);
  }, [probing, options.length]);

  if (manual) {
    return (
      <div>
        <div className="flex gap-2">
          <input
            className="input mono flex-1"
            value={value}
            placeholder={provider === "volcengine" ? "如 ep-2026xxxx 或模型名" : "模型名"}
            onChange={(e) => onChange(e.target.value)}
          />
          {options.length > 0 && (
            <button className="btn shrink-0" type="button" onClick={() => setManual(false)}>
              从清单选
            </button>
          )}
        </div>
        <p className="text-[12px] text-[var(--color-muted)] mt-1.5">
          手动填写 —— 服务商探测不到（如方舟的接入点 ID）或**清单里没有你要的模型**时，都直接填 ✓
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex gap-2">
        {/* 可搜索的下拉：清单长的时候（OpenAI 30+、OpenRouter 100+）原生 select
            只能一路滚，还没有"没有匹配"这个状态。这里手写一个零依赖 combobox：
            输入即过滤、键盘上下选、Enter 确认、Esc 关掉、底部保留手填入口。 */}
        <div className="relative flex-1">
          <input
            className="input mono w-full"
            value={open ? q : value}
            placeholder={open ? "输入关键字过滤…" : "选择模型"}
            aria-label="模型"
            aria-expanded={open}
            role="combobox"
            aria-controls="model-options"
            autoComplete="off"
            disabled={probing}
            onFocus={() => {
              setOpen(true);
              setQ("");
              setHi(0);
            }}
            onBlur={() => window.setTimeout(() => setOpen(false), 140)}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
              setHi(0);
            }}
            onKeyDown={(e) => {
              if (isImeEvent(e)) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setOpen(true);
                setHi((i) => Math.min(i + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHi((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const pick = filtered[hi];
                if (pick) {
                  onChange(pick);
                  setOpen(false);
                }
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
          />
          {open && (
            <div
              id="model-options"
              role="listbox"
              className="absolute left-0 right-0 z-30 mt-1 max-h-[240px] overflow-y-auto rounded-[10px] border shadow-lg"
              style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
            >
              {filtered.length === 0 ? (
                <div className="px-3 py-2 text-[12px]" style={{ color: "var(--color-text-3)" }}>
                  {probing ? "正在探测…" : "没有匹配的模型"}
                </div>
              ) : (
                filtered.map((m, i) => (
                  <button
                    key={m}
                    type="button"
                    role="option"
                    aria-selected={m === value}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onChange(m);
                      setOpen(false);
                    }}
                    className="flex min-h-[38px] w-full items-center px-3 text-left text-[12.5px] mono"
                    style={{
                      background: i === hi ? "var(--color-surface-2)" : "transparent",
                      color: m === value ? "var(--color-accent)" : undefined,
                    }}
                  >
                    {m}
                  </button>
                ))
              )}
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setManual(true);
                  setOpen(false);
                }}
                className="flex min-h-[38px] w-full items-center border-t px-3 text-left text-[12.5px]"
                style={{ borderColor: "var(--color-border)", color: "var(--color-text-2)" }}
              >
                ✎ 手动填写…
              </button>
            </div>
          )}
        </div>
        {credentialId && (
          <button
            className="btn shrink-0"
            type="button"
            disabled={probing}
            title="重新探测可用模型"
            onClick={() => void doProbe(true)}
          >
            {probing ? "…" : "重新探测"}
          </button>
        )}
      </div>
      {switchNote && (
        <p className="text-[12px] mt-1.5" style={{ color: "var(--color-warn)" }}>{switchNote}</p>
      )}
      {note && (
        <p className="text-[12px] text-[var(--color-muted)] mt-1.5">{note}</p>
      )}
      {!credentialId && (
        <p className="text-[12px] text-[var(--color-muted)] mt-1.5">
          先在下面选好「LLM 配置」，就能自动探测它可用的模型。
        </p>
      )}
    </div>
  );
}
