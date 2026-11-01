"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useImeGuard } from "@/lib/ime";
import type { RouteDecision, RouteRule } from "@/lib/types";
import { useFeedback } from "@/components/ui/feedback";

/** 正则引擎的英文报错 → 人话（用户看 "unterminated character set at position 5" 只会骂街） */
function whyRegex(msg: string): string {
  const m = msg || "";
  if (/unterminated character set/i.test(m)) return "方括号 [ ] 没闭合";
  if (/missing \)|unterminated subpattern/i.test(m)) return "括号 ( ) 没闭合";
  if (/nothing to repeat/i.test(m)) return "量词（* + ?）前面没有东西";
  if (/bad escape/i.test(m)) return "转义写错了（反斜杠后面跟的字符不认）";
  if (/bad character range/i.test(m)) return "范围写反了（如 [z-a]）";
  return m.length > 40 ? `${m.slice(0, 40)}…` : m;
}

/** 置信度 → 一句人话 + 颜色（不要给用户看 "confidence=low" 这种） */
const CONF: Record<
  RouteDecision["confidence"],
  { label: string; color: string }
> = {
  explicit: { label: "你指名的", color: "var(--color-muted)" },
  rule: { label: "命中规则", color: "var(--color-ok)" },
  high: { label: "够明确了", color: "var(--color-ok)" },
  low: { label: "拿不准", color: "var(--color-warn)" },
  fallback: { label: "先给当前助手", color: "var(--color-muted)" },
  unknown: { label: "认不出", color: "var(--color-warn)" },
};

/**
 * 「收这些话」—— 路由的第一层，挂在助手自己的配置页里。
 *
 * 两件事在同一节：写规则（这些话归它）+ 试一句（这句话会交给谁）。
 * 之所以要「试」：人写规则时想的是"这样写就一定分给它"，但真实的话不会照着
 * 你写的样子说 —— 能先撞一句，才敢把规则留在那儿。
 */
export function RouteRules({ agentId }: { agentId: string }) {
  const fb = useFeedback();
  // 中文输入法组字期间 Enter 是「选字」不是「提交」—— 两个输入框都要挡
  const addIme = useImeGuard();
  const probeIme = useImeGuard();
  const [rules, setRules] = useState<RouteRule[]>([]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState("");
  const [decision, setDecision] = useState<RouteDecision | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.routes(agentId);
      setRules(d.items);
    } catch {
      // 读不到就当没有规则（这一节不该把整页搞崩）
      setRules([]);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 只打逗号/分号等于没写 —— 按钮也该是灰的（实测过：", , ，" 也能点亮「添加」）
  const draftParts = draft
    .split(/[,，;；\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const add = async () => {
    const parts = draftParts;
    if (!parts.length) return;
    setBusy(true);
    try {
      for (const raw of parts) {
        const isRegex = raw.startsWith("re:");
        const pattern = isRegex ? raw.slice(3).trim() : raw;
        if (!pattern) continue;
        await api.addRoute({
          agent_id: agentId,
          pattern,
          kind: isRegex ? "regex" : "keyword",
        });
      }
      setDraft("");
      await load();
      fb.success("已记下", "以后这些话会先看看这个助手");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      fb.error("没加上", whyRegex(msg));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: RouteRule) => {
    try {
      await api.delRoute(r.id);
      setRules((prev) => prev.filter((x) => x.id !== r.id));
    } catch (e) {
      fb.error("没删掉", e instanceof Error ? e.message : String(e));
    }
  };

  const preview = async () => {
    const text = probe.trim();
    if (!text) return;
    try {
      setDecision(await api.routePreview({ text, default_agent_id: agentId }));
    } catch (e) {
      fb.error("试算失败", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="card mb-4 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <span className="text-[14px] font-medium">收这些话</span>
        <span className="truncate text-[12px]" style={{ color: "var(--color-muted)" }}>
          {rules.length ? `${rules.length} 条规则` : "没配 —— 靠名字和能力去猜"}
        </span>
        <span className="ml-auto shrink-0 text-[12px]" style={{ color: "var(--color-accent)" }}>
          {open ? "收起" : "展开"}
        </span>
      </button>

      {open && (
        <div className="border-t px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input h-[32px] min-w-0 flex-1 max-md:h-[44px]"
              placeholder="这些话交给它，逗号分隔（如：周报，复盘，会议纪要）"
              value={draft}
              {...addIme.props}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !addIme.blocked(e)) void add();
              }}
            />
            <button
              type="button"
              className="btn h-[32px] shrink-0 max-md:h-[44px]"
              disabled={busy || draftParts.length === 0}
              onClick={() => void add()}
            >
              添加
            </button>
          </div>
          <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: "var(--color-muted)" }}>
            命中其中任意一个词，这句话就归它；以 <span className="mono">re:</span> 开头按正则处理
            （如 <span className="mono">re:第\d+周</span>）。
          </p>

          {rules.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {rules.map((r) => (
                <span
                  key={r.id}
                  className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[12px]"
                  style={{ borderColor: "var(--color-border)", background: "var(--color-bg)" }}
                >
                  {r.kind === "regex" && (
                    <span className="text-[10px]" style={{ color: "var(--color-muted)" }}>
                      正则
                    </span>
                  )}
                  <span className="mono max-w-[180px] truncate" title={r.pattern}>
                    {r.pattern}
                  </span>
                  <button
                    type="button"
                    title="删掉这条"
                    onClick={() => void remove(r)}
                    className="px-0.5 text-[13px] leading-none"
                    style={{ color: "var(--color-muted)" }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* 试一句：规则写对了没有，撞一下就知道 */}
          <div className="mt-3 border-t pt-2.5" style={{ borderColor: "var(--color-border)" }}>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="input h-[32px] min-w-0 flex-1 max-md:h-[44px]"
                placeholder="拿一句话试试：这句话会交给谁？"
                value={probe}
                {...probeIme.props}
                onChange={(e) => setProbe(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !probeIme.blocked(e)) void preview();
                }}
              />
              <button
                type="button"
                className="btn h-[32px] shrink-0 max-md:h-[44px]"
                disabled={!probe.trim()}
                onClick={() => void preview()}
              >
                试算
              </button>
            </div>

            {decision && (
              <div className="mt-2 text-[12px] leading-relaxed">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[11px]"
                    style={{ color: CONF[decision.confidence].color, background: "var(--color-bg)" }}
                  >
                    {CONF[decision.confidence].label}
                  </span>
                  <b style={{ color: "var(--color-text)" }}>
                    {decision.agent_id ? decision.agent_name || decision.agent_id : "需要你选一个"}
                  </b>
                  {decision.confidence === "low" && (
                    <span style={{ color: "var(--color-warn)" }}>分不够，会先问你</span>
                  )}
                  <span className="tabular-nums" style={{ color: "var(--color-muted)" }}>
                    {decision.score} 分 · 第 {decision.layer + 1} 层
                  </span>
                </div>
                <div style={{ color: "var(--color-muted)" }}>{decision.reason}</div>
                {decision.alternatives.length > 0 && (
                  <div className="mt-1" style={{ color: "var(--color-muted)" }}>
                    {decision.confidence === "unknown" ? "可以交给：" : "其他候选："}
                    {decision.alternatives
                      .map((a) =>
                        decision.confidence === "unknown"
                          ? a.name || a.agent_id
                          : `${a.name || a.agent_id} ${a.score} 分`,
                      )
                      .join("、")}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
