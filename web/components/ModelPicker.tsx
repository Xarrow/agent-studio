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
  const [manual, setManual] = useState(false);
  const probedFor = useRef<string | null>(null);

  const meta = useMemo(() => providers.find((p) => p.name === provider), [providers, provider]);

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
        const list = (isReal ? r.models : (r.suggested ?? [])) || [];
        probeCache.set(key, list);
        probeCacheReal.set(key, isReal);
        setProbed(list);
        setProbedIsReal(isReal);
        if (r.models?.length) {
          setNote(`✓ 探测到 ${r.models.length} 个可用模型`);
        } else if (r.suggested?.length) {
          setNote("该服务商不支持列出模型，下面是推荐清单，可先选一个试跑");
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
  const options = useMemo(() => {
    const out: string[] = [];
    const push = (v?: string | null) => {
      const k = (v ?? "").trim();
      if (k && !out.includes(k)) out.push(k);
    };
    if (probedIsReal) {
      probed.forEach(push);
    } else {
      probed.forEach(push);
      (meta?.models ?? []).forEach(push);
    }
    push(value);
    return out;
  }, [probed, probedIsReal, meta, value]);

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
        <p className="text-[11.5px] text-[var(--color-muted)] mt-1.5">
          手动填写 —— 服务商探测不到（如方舟的接入点 ID）或**清单里没有你要的模型**时，都直接填 ✓
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex gap-2">
        <select
          className="input mono flex-1"
          value={value}
          disabled={probing}
          onChange={(e) => {
            if (e.target.value === "__manual__") {
              setManual(true);
              return;
            }
            onChange(e.target.value);
          }}
        >
          {probing && <option value={value}>探测中…</option>}
          {!probing && !value && <option value="">— 请选择模型 —</option>}
          {!probing &&
            options.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          <option value="__manual__">✎ 手动填写…</option>
        </select>
        {credentialId && (
          <button
            className="btn shrink-0"
            type="button"
            disabled={probing}
            title="重新探测该配置下可用的模型"
            onClick={() => void doProbe(true)}
          >
            {probing ? "…" : "重新探测"}
          </button>
        )}
      </div>
      {note && (
        <p className="text-[11.5px] text-[var(--color-muted)] mt-1.5">{note}</p>
      )}
      {!credentialId && (
        <p className="text-[11.5px] text-[var(--color-muted)] mt-1.5">
          先在下面选好「LLM 配置」，就能自动探测它可用的模型。
        </p>
      )}
    </div>
  );
}
