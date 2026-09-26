"use client";

/**
 * 历史版本 —— 「改坏了能退回去」。
 *
 * 产品判断
 * --------
 * · 用户的真实恐惧是**改坏**：没有历史，每改一次提示词都在赌。有了它，改动变成可逆动作。
 * · 显示的是**一句人话**（「改了提示词」「步骤 3 → 4」），不是一串版本号 ——
 *   用户不用逐字段对比就知道哪一版是他要的。
 * · **回滚也是前进**：退回去会新增一版（后端保证），所以这里不需要吓人的二次确认弹窗，
 *   但仍然做成"点两下"（第一下亮红问一次，4 秒内有效）—— 与全站破坏性操作同一套手感。
 * · 就地展开：列表点开才显示这一版的内容摘要，不跳页、不常驻。
 */

import { useCallback, useEffect, useState } from "react";

import { api, fmt } from "@/lib/api";
import { useFeedback } from "@/components/ui/feedback";

type Rev = {
  id: string;
  version: number;
  label: string;
  created_at: number;
  current: boolean;
  payload?: Record<string, unknown>;
};

export function RevisionHistory({
  kind,
  targetId,
  onRestored,
  title = "历史版本",
}: {
  kind: "agent" | "workflow";
  targetId: string;
  onRestored?: () => void;
  title?: string;
}) {
  const fb = useFeedback();
  const [items, setItems] = useState<Rev[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [armId, setArmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.revisions(kind, targetId);
      setItems(res.items);
    } catch (e) {
      fb.error("读取历史版本失败", e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [kind, targetId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (rev: Rev) => {
    if (armId !== rev.id) {
      setArmId(rev.id); // 两步确认（4 秒内有效），不用原生弹窗
      setTimeout(() => setArmId((cur) => (cur === rev.id ? null : cur)), 4000);
      return;
    }
    setArmId(null);
    setBusy(true);
    try {
      const res = (await api.restoreRevision(rev.id)) as { restored_from: number; version: number };
      fb.success(`已回到第 ${res.restored_from} 版`, "退回也算一次改动，历史里多了一条「回滚」记录");
      await load();
      onRestored?.();
    } catch (e) {
      fb.error("回滚失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const preview = (rev: Rev) => {
    const p = (rev.payload || {}) as Record<string, unknown>;
    const def = (p.definition || {}) as Record<string, unknown>;
    if (kind === "agent") {
      return {
        prompt: String(def.system_prompt || "").slice(0, 160),
        model: String(((def.model || {}) as Record<string, unknown>).name || "—"),
        tools: Array.isArray(p.tool_names) ? (p.tool_names as string[]).join("、") : "",
      };
    }
    const g = (p.graph || {}) as Record<string, unknown>;
    const nodes = Array.isArray(g.nodes) ? (g.nodes as unknown[]) : [];
    const edges = Array.isArray(g.edges) ? (g.edges as unknown[]) : [];
    return { prompt: `${nodes.length} 步 · ${edges.length} 条连线`, model: "", tools: "" };
  };

  return (
    <section className="card p-4" id="revisions">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[14px] font-medium">{title}</h2>
        <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
          每次改动自动记一版（内容没变不记）；随时能退回去
        </span>
      </div>

      {loading ? (
        <div className="text-[12.5px]" style={{ color: "var(--color-muted)" }}>
          读取中…
        </div>
      ) : items.length === 0 ? (
        <div className="text-[12.5px]" style={{ color: "var(--color-muted)" }}>
          还没有历史 —— 改一次就会出现在这里。
        </div>
      ) : (
        <div className="divide-y" style={{ borderColor: "var(--color-border)" }}>
          {items.map((rev) => {
            const pv = preview(rev);
            const expanded = openId === rev.id;
            return (
              <div key={rev.id} className="py-2" style={{ borderColor: "var(--color-border)" }}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="mono text-[12.5px] font-medium">v{rev.version}</span>
                  {rev.current && (
                    <span
                      className="rounded px-1.5 py-0.5 text-[11px]"
                      style={{ background: "color-mix(in srgb, var(--color-ok) 14%, transparent)", color: "var(--color-ok)" }}
                    >
                      当前
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{rev.label}</span>
                  <span className="text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                    {fmt.time(rev.created_at)}
                  </span>
                  <button
                    type="button"
                    className="rounded-[6px] border px-2 py-0.5 text-[11.5px]"
                    style={{ borderColor: "var(--color-border)" }}
                    onClick={() => setOpenId(expanded ? null : rev.id)}
                  >
                    {expanded ? "收起" : "看看这版"}
                  </button>
                  {!rev.current && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void restore(rev)}
                      className="rounded-[6px] border px-2 py-0.5 text-[11.5px] disabled:opacity-50"
                      style={{
                        borderColor: armId === rev.id ? "var(--color-err)" : "var(--color-border)",
                        color: armId === rev.id ? "var(--color-err)" : undefined,
                      }}
                      title="回到这一版（会新增一条记录，不改写历史）"
                    >
                      {armId === rev.id ? "再点一次就退回" : "回到这一版"}
                    </button>
                  )}
                </div>
                {expanded && (
                  <div
                    className="mt-1.5 rounded-[8px] px-2.5 py-2 text-[12px]"
                    style={{ background: "var(--color-surface-2)", color: "var(--color-muted)" }}
                  >
                    {kind === "agent" ? (
                      <>
                        <div>模型：{pv.model}</div>
                        {pv.tools ? <div>工具：{pv.tools}</div> : <div>工具：（无）</div>}
                        <div className="mt-1 whitespace-pre-wrap break-words" style={{ color: "var(--color-text)" }}>
                          {pv.prompt || "（没有提示词）"}
                        </div>
                      </>
                    ) : (
                      <div>{pv.prompt}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
