"use client";

/**
 * 助手详情页里的「评测」：用例集 + 跑一次 + 逐例看结果 + 两版对比。
 *
 * 为什么放在这里（而不是新开一个「评测」导航）：
 * 评测是**这个助手**的事 —— 控件归属其对象；而且用户明确不要新 tab / 新导航项。
 *
 * 设计取舍：
 * · 用例只有两个字段：**输入** 和 **必须包含**（多个词用 | 分隔）。
 *   不搞"评分要点 + AI 裁判"当主路径 —— 裁判只在该例**没写关键词**时才兜底，
 *   因为硬判据可复现、免费、而且"到底差在哪"一眼看得出。
 * · 结果里每一例都能就地展开看产出与命中情况（不跳页）。
 * · 对比只列**同一用例集**的两次：退步的例排最前并标红（用户真正要看的是"哪几条被我改坏了"）。
 */

import { useCallback, useEffect, useState } from "react";

import { useFeedback } from "@/components/ui/feedback";
import { api, fmt } from "@/lib/api";
import type {
  EvalCompareRead,
  EvalRunDetail,
  EvalRunRead,
  EvalSuiteRead,
} from "@/lib/types";

type CaseDraft = { input: string; must_include: string; rubric: string };

const EMPTY: CaseDraft = { input: "", must_include: "", rubric: "" };

export function AgentEvalPanel({ agentId, disabled }: { agentId: string; disabled?: boolean }) {
  const fb = useFeedback();
  const [suites, setSuites] = useState<EvalSuiteRead[]>([]);
  const [suiteId, setSuiteId] = useState<string>("");
  const [runs, setRuns] = useState<EvalRunRead[]>([]);
  const [detail, setDetail] = useState<EvalRunDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("默认用例集");
  const [cases, setCases] = useState<CaseDraft[]>([{ ...EMPTY }]);
  const [label, setLabel] = useState("");
  const [openCase, setOpenCase] = useState<number | null>(null);
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [cmp, setCmp] = useState<EvalCompareRead | null>(null);
  const [busy, setBusy] = useState(false);
  /** 删用例集要两下（第一下变红问一句）——与全站一致，不做误触 */
  const [armDelete, setArmDelete] = useState(false);

  const suite = suites.find((s) => s.id === suiteId) ?? null;

  const loadSuites = useCallback(async () => {
    try {
      const list = await api.evalSuites(agentId);
      setSuites(list);
      setSuiteId((cur) => cur || list[0]?.id || "");
    } catch {
      setSuites([]);
    }
  }, [agentId]);

  const loadRuns = useCallback(async (sid: string) => {
    if (!sid) {
      setRuns([]);
      return;
    }
    try {
      setRuns(await api.evalRuns(sid));
    } catch {
      setRuns([]);
    }
  }, []);

  useEffect(() => {
    void loadSuites();
  }, [loadSuites]);

  useEffect(() => {
    void loadRuns(suiteId);
  }, [suiteId, loadRuns]);

  /** 跑完后端会自己收口；这里轮询到"不再是 running"就把结果拉回来 */
  const poll = async (id: string) => {
    for (let i = 0; i < 150; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      const d = await api.evalRun(id);
      setDetail(d);
      if (d.status !== "running") {
        await loadRuns(suiteId);
        return d;
      }
    }
    return null;
  };

  const runNow = async () => {
    if (!suite) return;
    setBusy(true);
    try {
      const started = await api.evalRunSuite(suite.id, label.trim());
      // 跑完就清空：不清空的话下一次会把新名字**拼在旧名字后面**（实测看到"基线改提示词之后"）
      setLabel("");
      setDetail(started);
      fb.success("评测已开始", `${suite.cases.length} 例会各自真跑一次（计入用量）`);
      await poll(started.id);
    } catch (e) {
      fb.error("没能开始评测", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveSuite = async () => {
    const clean = cases.filter((c) => c.input.trim());
    if (!clean.length) {
      fb.error("至少要有一条用例", "每行填「问什么」——「必须包含」可以留空（那就会请模型当裁判）");
      return;
    }
    setBusy(true);
    try {
      if (suite && editing) {
        const upd = await api.evalSaveSuite(suite.id, {
          agent_id: agentId,
          name: name.trim() || suite.name,
          cases: clean,
        });
        setSuites((cur) => cur.map((s) => (s.id === upd.id ? upd : s)));
      } else {
        const made = await api.evalCreateSuite({
          agent_id: agentId,
          name: name.trim() || "默认用例集",
          cases: clean,
        });
        setSuites((cur) => [made, ...cur]);
        setSuiteId(made.id);
      }
      setEditing(false);
      fb.success("用例集已保存", `${clean.length} 条用例`);
    } catch (e) {
      fb.error("保存失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = () => {
    if (suite) {
      setName(suite.name);
      setCases(
        suite.cases.length
          ? suite.cases.map((c) => ({
              input: c.input,
              must_include: c.must_include,
              rubric: c.rubric,
            }))
          : [{ ...EMPTY }],
      );
    } else {
      setName("默认用例集");
      setCases([{ ...EMPTY }]);
    }
    setEditing(true);
  };

  const deltaColor = (d: number | null) =>
    d === null ? "var(--color-muted)" : d < 0 ? "var(--color-err)" : d > 0 ? "var(--color-ok)" : "var(--color-muted)";

  return (
    <div className="p-3.5">
      {/* ── 用例集：选一个 / 改 / 新建 ──────────────────────────────── */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {suites.length > 0 ? (
          <select
            className="rounded-[8px] border px-2 py-1.5 text-[12.5px]"
            style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
            value={suiteId}
            onChange={(e) => {
              setSuiteId(e.target.value);
              setDetail(null);
              setCmp(null);
            }}
          >
            {suites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}（{s.cases.length} 例）
              </option>
            ))}
          </select>
        ) : (
          <span className="text-[12.5px]" style={{ color: "var(--color-muted)" }}>
            还没有用例集 —— 先写几条"这助手必须答对什么"
          </span>
        )}
        <button
          type="button"
          onClick={startEdit}
          className="rounded-[8px] border px-2.5 py-1.5 text-[12.5px]"
          style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}
        >
          {suite ? "改用例" : "新建用例集"}
        </button>
        {suite && (
          <button
            type="button"
            title={armDelete ? "再点一次就删掉这个用例集（历史评测记录会保留）" : "删掉这个用例集"}
            onClick={() => {
              if (!armDelete) {
                setArmDelete(true);
                return;
              }
              void (async () => {
                try {
                  await api.evalDeleteSuite(suite.id);
                  fb.success("用例集已删除", "历史评测记录保留着（那是证据）");
                  setArmDelete(false);
                  setDetail(null);
                  setCmp(null);
                  setSuiteId("");
                  await loadSuites();
                } catch (e) {
                  fb.error("删除失败", e instanceof Error ? e.message : String(e));
                }
              })();
            }}
            className="rounded-[8px] border px-2.5 py-1.5 text-[12.5px]"
            style={{
              borderColor: armDelete ? "var(--color-err)" : "var(--color-border)",
              color: armDelete ? "var(--color-err)" : "var(--color-muted)",
            }}
          >
            {armDelete ? "确认删除？" : "删除用例集"}
          </button>
        )}
        {suite && (
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => void runNow()}
            className="rounded-[8px] border px-2.5 py-1.5 text-[12.5px] disabled:opacity-50"
            style={{ borderColor: "var(--color-accent)", color: "var(--color-accent)" }}
            title={disabled ? "先把这个助手的配置保存好" : "每一例都会真跑一次（算进用量与额度）"}
          >
            跑一次评测
          </button>
        )}
        {suite && (
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="这次叫什么（可选，如「改提示词前」）"
            className="w-[190px] rounded-[8px] border px-2 py-1.5 text-[12.5px] outline-none"
            style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
          />
        )}
      </div>

      {/* ── 编辑器：每行两个框（输入 / 必须包含），不让人手打分隔符语法 ── */}
      {editing && (
        <div className="mb-3 rounded-[10px] border p-3" style={{ borderColor: "var(--color-border)" }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="用例集名字"
            className="mb-2 w-[240px] rounded-[8px] border px-2 py-1.5 text-[12.5px] outline-none"
            style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
          />
          {cases.map((c, i) => (
            <div key={i} className="mb-1.5 flex items-center gap-1.5">
              <span className="w-[26px] shrink-0 text-center text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                {i + 1}
              </span>
              <input
                value={c.input}
                onChange={(e) =>
                  setCases((cur) => cur.map((x, j) => (j === i ? { ...x, input: e.target.value } : x)))
                }
                placeholder="问它什么"
                className="min-w-0 flex-1 rounded-[8px] border px-2 py-1.5 text-[12.5px] outline-none"
                style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
              />
              <input
                value={c.must_include}
                onChange={(e) =>
                  setCases((cur) =>
                    cur.map((x, j) => (j === i ? { ...x, must_include: e.target.value } : x)),
                  )
                }
                placeholder="必须包含哪些词（多个用 | 分隔；留空则请模型当裁判）"
                className="min-w-0 flex-1 rounded-[8px] border px-2 py-1.5 text-[12.5px] outline-none"
                style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
              />
              <button
                type="button"
                title="删掉这一例"
                onClick={() => setCases((cur) => (cur.length > 1 ? cur.filter((_, j) => j !== i) : [{ ...EMPTY }]))}
                className="shrink-0 rounded-[7px] border px-1.5 py-1 text-[12px]"
                style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCases((cur) => [...cur, { ...EMPTY }])}
              className="rounded-[8px] border px-2.5 py-1.5 text-[12.5px]"
              style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}
            >
              ＋ 再加一例
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void saveSuite()}
              className="rounded-[8px] border px-2.5 py-1.5 text-[12.5px] disabled:opacity-50"
              style={{ borderColor: "var(--color-accent)", color: "var(--color-accent)" }}
            >
              保存用例集
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-[8px] border px-2.5 py-1.5 text-[12.5px]"
              style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* ── 本次结果 ─────────────────────────────────────────────── */}
      {detail && (
        <div className="mb-3 rounded-[10px] border" style={{ borderColor: "var(--color-border)" }}>
          <div
            className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2"
            style={{ borderColor: "var(--color-border)" }}
          >
            <div className="text-[12.5px]">
              <span className="font-semibold">
                {detail.status === "running" ? "正在评测…" : `总分 ${detail.score ?? "—"}`}
              </span>
              {detail.label && (
                <span className="ml-2" style={{ color: "var(--color-muted)" }}>
                  {detail.label}
                </span>
              )}
            </div>
            <div className="text-[11.5px]" style={{ color: "var(--color-muted)" }}>
              {detail.results.length} 例 · {fmt.relative(detail.created_at)}
            </div>
          </div>
          {(detail.results || []).map((r) => (
            <div key={r.index} className="border-b last:border-b-0" style={{ borderColor: "var(--color-border)" }}>
              <button
                type="button"
                onClick={() => setOpenCase(openCase === r.index ? null : r.index)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
              >
                <span
                  className="w-[38px] shrink-0 text-center text-[12px] font-semibold tabular-nums"
                  style={{
                    color:
                      r.score === null
                        ? "var(--color-muted)"
                        : r.score >= 100
                          ? "var(--color-ok)"
                          : r.score > 0
                            ? "var(--color-warn)"
                            : "var(--color-err)",
                  }}
                >
                  {r.status === "pending" || r.status === "running" ? "…" : (r.score ?? "—")}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{r.input}</span>
                {r.status !== "ok" && r.status !== "pending" && r.status !== "running" && (
                  <span className="shrink-0 text-[11.5px]" style={{ color: "var(--color-err)" }}>
                    {r.status}
                  </span>
                )}
                <span className="shrink-0 text-[11px]" style={{ color: "var(--color-muted)" }}>
                  {openCase === r.index ? "收起" : "看产出"}
                </span>
              </button>
              {openCase === r.index && (
                <div className="px-3 pb-3">
                  {r.checks.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {r.checks.map((c) => (
                        <span
                          key={c.keyword}
                          className="rounded-[6px] px-1.5 py-[2px] text-[11.5px]"
                          style={{
                            color: c.hit ? "var(--color-ok)" : "var(--color-err)",
                            background: `color-mix(in srgb, var(${c.hit ? "--color-ok" : "--color-err"}) 10%, transparent)`,
                          }}
                        >
                          {c.hit ? "✓" : "✕"} {c.keyword}
                        </span>
                      ))}
                    </div>
                  )}
                  {r.judge && (
                    <div className="mb-2 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                      裁判：{r.judge.reason}
                    </div>
                  )}
                  {r.note && (
                    <div className="mb-2 text-[11.5px]" style={{ color: "var(--color-muted)" }}>
                      {r.note}
                    </div>
                  )}
                  {r.error && (
                    <div className="mb-2 text-[11.5px]" style={{ color: "var(--color-err)" }}>
                      {r.error}
                    </div>
                  )}
                  <pre
                    className="max-h-[240px] overflow-auto whitespace-pre-wrap rounded-[8px] border p-2 text-[12px]"
                    style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
                  >
                    {r.output || "（没有产出）"}
                  </pre>
                  <div className="mt-1 text-[11px]" style={{ color: "var(--color-muted)" }}>
                    {r.tokens ? `${fmt.int(r.tokens)} token · ` : ""}
                    {r.run_id ? `执行 ${r.run_id}` : ""}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── 对比：同一用例集两次，退步的排最前 ───────────────────── */}
      {runs.length >= 2 && (
        <div className="rounded-[10px] border p-3" style={{ borderColor: "var(--color-border)" }}>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[12.5px]">
            <span className="font-semibold">两版对比</span>
            <select
              className="rounded-[8px] border px-2 py-1.5 text-[12px]"
              style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
              value={left}
              onChange={(e) => setLeft(e.target.value)}
            >
              <option value="">基准（改之前）…</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label || "未命名"} · {fmt.relative(r.created_at)} · {r.score ?? "—"}
                </option>
              ))}
            </select>
            <select
              className="rounded-[8px] border px-2 py-1.5 text-[12px]"
              style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
              value={right}
              onChange={(e) => setRight(e.target.value)}
            >
              <option value="">对比（改之后）…</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label || "未命名"} · {fmt.relative(r.created_at)} · {r.score ?? "—"}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!left || !right || left === right}
              onClick={() =>
                void (async () => {
                  try {
                    setCmp(await api.evalCompare(left, right));
                  } catch (e) {
                    fb.error("对比失败", e instanceof Error ? e.message : String(e));
                  }
                })()
              }
              className="rounded-[8px] border px-2.5 py-1.5 text-[12px] disabled:opacity-50"
              style={{ borderColor: "var(--color-accent)", color: "var(--color-accent)" }}
            >
              对比
            </button>
            {cmp && (
              <span
                className="ml-auto text-[12.5px] font-semibold tabular-nums"
                style={{ color: deltaColor(cmp.total_delta) }}
              >
                总分 {cmp.left.score ?? "—"} → {cmp.right.score ?? "—"}
                {cmp.total_delta !== null && `（${cmp.total_delta > 0 ? "+" : ""}${cmp.total_delta}）`}
              </span>
            )}
          </div>
          {cmp && (
            <div className="max-h-[280px] overflow-auto">
              {cmp.items.map((x) => (
                <div
                  key={x.index}
                  className="flex items-center gap-2 border-t py-1.5 text-[12px]"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  <span className="min-w-0 flex-1 truncate">{x.input}</span>
                  <span className="shrink-0 tabular-nums" style={{ color: "var(--color-muted)" }}>
                    {x.left.score ?? "—"} → {x.right.score ?? "—"}
                  </span>
                  <span className="w-[52px] shrink-0 text-right tabular-nums" style={{ color: deltaColor(x.delta) }}>
                    {x.delta === null ? "—" : `${x.delta > 0 ? "+" : ""}${x.delta}`}
                  </span>
                </div>
              ))}
              <div className="mt-1 text-[11px]" style={{ color: "var(--color-muted)" }}>
                退步的例排在前面 —— 先看这些就够判断这次改动值不值。
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
