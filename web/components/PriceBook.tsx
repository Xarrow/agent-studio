"use client";

/**
 * 单价（算钱用）—— 把「用了多少 token」变成「花了多少钱」的唯一输入。
 *
 * 产品判断（为什么是这么个形态）
 * ------------------------------
 * · **不内置价目表**：各家价格/折扣/汇率都不一样，内置一份只会很快过期，
 *   还会让人以为算出来的数是对的。→ 只列「你用过的模型」，让用户填两个数。
 * · **让用户选择而不是输入**：币种是下拉；单位固定「每百万 token」（与官网报价同一量纲）。
 * · **留空 = 不算钱**（不是 0 元）：界面显式说明，免得把"不知道"错当成"免费"。
 * · 信息默认可见：每个模型旁边直接显示**已经用了多少 token** ——
 *   一眼看出该先填哪个（用得多的先填，收益最大）。
 */

import { useCallback, useEffect, useState } from "react";

import { api } from "@/lib/api";
import { fmt } from "@/lib/api";
import { useFeedback } from "@/components/ui/feedback";

type Row = {
  model: string;
  in_per_mtok: number;
  out_per_mtok: number;
  tokens_in: number;
  tokens_out: number;
  calls: number;
  priced: boolean;
};

const CURRENCIES = ["¥", "$", "€", "元"];

export function PriceBook() {
  const fb = useFeedback();
  const [rows, setRows] = useState<Row[]>([]);
  const [currency, setCurrency] = useState("¥");
  const [draft, setDraft] = useState<Record<string, { i: string; o: string }>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const book = await api.prices();
      setRows(book.items as Row[]);
      setCurrency(book.currency || "¥");
      setDraft(
        Object.fromEntries(
          (book.items as Row[]).map((r) => [
            r.model,
            { i: r.in_per_mtok ? String(r.in_per_mtok) : "", o: r.out_per_mtok ? String(r.out_per_mtok) : "" },
          ]),
        ),
      );
    } catch (e) {
      fb.error("加载单价失败", e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const items = rows.map((r) => ({
        model: r.model,
        in_per_mtok: Number(draft[r.model]?.i || 0),
        out_per_mtok: Number(draft[r.model]?.o || 0),
      }));
      const res = await api.savePrices({ currency, items });
      fb.success(`已保存 ${res.saved} 个模型的单价${res.cleared ? `，清掉 ${res.cleared} 个` : ""}`);
      await load();
    } catch (e) {
      fb.error("保存失败", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const used = (r: Row) => r.tokens_in + r.tokens_out;

  return (
    <section id="prices">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-medium">单价（算钱用）</h2>
        <select
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          title="金额用哪个币种显示"
          className="rounded-[6px] border px-1.5 py-0.5 text-[12.5px]"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
        >
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
          每百万 token 的价格 —— 填了才在运行记录里显示金额；留空 = 不算钱（显示「—」）
        </span>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="ml-auto rounded-[8px] px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-50"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-fg)" }}
        >
          {saving ? "保存中…" : "保存单价"}
        </button>
      </div>

      {loading ? (
        <div className="card p-4 text-[13px]" style={{ color: "var(--color-muted)" }}>
          读取中…
        </div>
      ) : rows.length === 0 ? (
        <div className="card p-4 text-[13px]" style={{ color: "var(--color-muted)" }}>
          还没有用过的模型 —— 跑一次助手或聊一句，这里就会出现模型名。
        </div>
      ) : (
        <div className="card overflow-hidden p-0">
          <table className="w-full text-[13px]">
            <thead className="bg-[var(--color-surface-2)] text-[var(--color-muted)]">
              <tr>
                <th className="px-3 py-2 text-left font-medium">模型</th>
                <th className="px-3 py-2 text-right font-medium w-40">已用 tokens</th>
                <th className="px-3 py-2 text-right font-medium w-44">输入 / 百万</th>
                <th className="px-3 py-2 text-right font-medium w-44">输出 / 百万</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.model} className="border-t" style={{ borderColor: "var(--color-border)" }}>
                  <td className="px-3 py-2">
                    <div className="mono truncate max-w-[260px]">{r.model}</div>
                    <div className="text-[11px]" style={{ color: "var(--color-muted)" }}>
                      {r.calls ? `${r.calls} 次调用` : "还没跑过"}
                      {used(r) ? ` · 输入 ${fmt.num(r.tokens_in)} / 输出 ${fmt.num(r.tokens_out)}` : ""}
                      {r.priced ? " · 已填单价" : ""}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right" style={{ color: "var(--color-muted)" }}>
                    {used(r) ? fmt.num(used(r)) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      inputMode="decimal"
                      value={draft[r.model]?.i ?? ""}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, [r.model]: { i: e.target.value, o: d[r.model]?.o ?? "" } }))
                      }
                      placeholder="例如 1"
                      className="w-24 rounded-[6px] border px-2 py-1 text-right text-[13px]"
                      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      inputMode="decimal"
                      value={draft[r.model]?.o ?? ""}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, [r.model]: { i: d[r.model]?.i ?? "", o: e.target.value } }))
                      }
                      placeholder="例如 2"
                      className="w-24 rounded-[6px] border px-2 py-1 text-right text-[13px]"
                      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
