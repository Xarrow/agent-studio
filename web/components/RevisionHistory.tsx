"use client";

/**
 * 历史版本：列表 / 看差异 / 回退 / 删除
 * ====================================
 *
 * 产品判断
 * --------
 * · 用户的真实恐惧是**改坏**：没有历史，每改一次提示词都在赌。有了它，改动变成可逆动作。
 * · 列表给的是**一句人话**（「改了提示词」），不是一串版本号。
 * · 「看差异」是这次补的核心：以前点开只能看"这一版长什么样"，
 *   看不出"和上一版差在哪"，等于让人拿两段提示词用眼睛对。
 * · 「一行一对象，点行就地展开」，动作常驻可见：回到这一版 / 删除（红字靠右），
 *   不塞进「⋯」；破坏性动作走"点两下"（第一下亮红，4 秒内有效），不用原生弹窗。
 * · **回滚也是前进**（后端新建一版），所以退回不需要吓人的二次确认。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { api, fmt } from "@/lib/api";
import { useFeedback } from "@/components/ui/feedback";
import { clip, diffRows, type RevChange, type RevRow } from "@/lib/revision-diff";

type Rev = {
  id: string;
  version: number;
  label: string;
  created_at: number;
  current: boolean;
};

type DiffState = {
  loading: boolean;
  summary: string;
  rows: RevRow[];
  againstLabel: string;
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
  const [against, setAgainst] = useState<"prev" | "current">("prev");
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
  const [armRestore, setArmRestore] = useState<string | null>(null);
  const [armDelete, setArmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fullKey, setFullKey] = useState<string | null>(null);

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

  const loadDiff = useCallback(
    async (rev: Rev, mode: "prev" | "current") => {
      const key = `${rev.id}:${mode}`;
      setDiffs((d) => ({ ...d, [key]: { loading: true, summary: "", rows: [], againstLabel: "" } }));
      try {
        const res = await api.revisionDiff(rev.id, mode);
        setDiffs((d) => ({
          ...d,
          [key]: {
            loading: false,
            summary: res.summary,
            rows: diffRows((res.changes || []) as RevChange[]),
            againstLabel: res.against_label,
          },
        }));
      } catch (e) {
        setDiffs((d) => ({ ...d, [key]: { loading: false, summary: "读取差异失败", rows: [], againstLabel: "" } }));
        fb.error("读取差异失败", e instanceof Error ? e.message : String(e));
      }
    },
    [fb],
  );

  const toggle = (rev: Rev) => {
    const next = openId === rev.id ? null : rev.id;
    setOpenId(next);
    setArmRestore(null);
    setArmDelete(null);
    setFullKey(null);
    if (next && !diffs[`${rev.id}:${against}`]) void loadDiff(rev, against);
  };

  const switchAgainst = (mode: "prev" | "current") => {
    setAgainst(mode);
    const rev = items.find((r) => r.id === openId);
    if (rev && !diffs[`${rev.id}:${mode}`]) void loadDiff(rev, mode);
  };

  const restore = async (rev: Rev) => {
    if (armRestore !== rev.id) {
      setArmRestore(rev.id); // 两步确认（4 秒内有效），不用原生弹窗
      setArmDelete(null);
      setTimeout(() => setArmRestore((cur) => (cur === rev.id ? null : cur)), 4000);
      return;
    }
    setArmRestore(null);
    setBusy(rev.id);
    try {
      const res = await api.restoreRevision(rev.id);
      fb.success(`已回到第 ${res.restored_from} 版`, "退回也是一次改动，会记成新的一版");
      await load();
      onRestored?.();
    } catch (e) {
      fb.error("回滚失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (rev: Rev) => {
    if (armDelete !== rev.id) {
      setArmDelete(rev.id);
      setArmRestore(null);
      setTimeout(() => setArmDelete((cur) => (cur === rev.id ? null : cur)), 4000);
      return;
    }
    setArmDelete(null);
    setBusy(rev.id);
    try {
      await api.deleteRevision(rev.id);
      fb.success(`已删除 v${rev.version} 的记录`, "当前配置不受影响");
      if (openId === rev.id) setOpenId(null);
      await load();
    } catch (e) {
      fb.error("删除失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const latest = items.length ? items[0].version : 0;
  const subtitle = useMemo(
    () => (items.length ? `共 ${items.length} 版 · 当前 v${latest}` : "每次改动自动记一版（内容没变不记）"),
    [items.length, latest],
  );

  return (
    <section className="card p-4" id="revisions">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="text-[14px] font-medium">{title}</h2>
        <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
          {subtitle}
        </span>
        <button
          type="button"
          className="ml-auto rounded-[6px] border px-2 py-0.5 text-[12px] transition-colors hover:bg-[var(--color-surface-2)]"
          style={{ borderColor: "var(--color-border)" }}
          onClick={() => void load()}
          title="重新读一遍历史"
        >
          刷新
        </button>
      </div>

      {loading ? (
        <div className="text-[12px]" style={{ color: "var(--color-muted)" }}>
          读取中…
        </div>
      ) : items.length === 0 ? (
        <div className="text-[12px]" style={{ color: "var(--color-muted)" }}>
          还没有历史 —— 改一次就会出现在这里。
        </div>
      ) : (
        <div className="divide-y" style={{ borderColor: "var(--color-border)" }}>
          {items.map((rev) => {
            const expanded = openId === rev.id;
            const diff = diffs[`${rev.id}:${against}`];
            return (
              <div key={rev.id} className="py-2" style={{ borderColor: "var(--color-border)" }}>
                {/* ── 行：版本号 · 改了什么 · 时间 · 动作（常驻可见） ── */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <button
                    type="button"
                    onClick={() => toggle(rev)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    aria-expanded={expanded}
                    title="点开看这一版改了什么"
                  >
                    <span className="mono text-[12px] font-medium">v{rev.version}</span>
                    {rev.current && (
                      <span
                        className="rounded px-1.5 py-0.5 text-[12px]"
                        style={{ background: "color-mix(in srgb, var(--color-ok) 14%, transparent)", color: "var(--color-ok)" }}
                      >
                        当前
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[12px]">{rev.label}</span>
                    <span className="shrink-0 text-[12px]" style={{ color: "var(--color-muted)" }}>
                      {fmt.time(rev.created_at)}
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      className="rounded-[6px] border px-2 py-0.5 text-[12px] transition-colors hover:bg-[var(--color-surface-2)]"
                      style={{ borderColor: "var(--color-border)" }}
                      onClick={() => toggle(rev)}
                    >
                      {expanded ? "收起" : "看差异"}
                    </button>
                    {!rev.current && (
                      <button
                        type="button"
                        disabled={busy === rev.id}
                        onClick={() => void restore(rev)}
                        className="rounded-[6px] border px-2 py-0.5 text-[12px] disabled:opacity-50"
                        style={{
                          borderColor: armRestore === rev.id ? "var(--color-err)" : "var(--color-border)",
                          color: armRestore === rev.id ? "var(--color-err)" : undefined,
                        }}
                        title="把配置退回到这一版（会新增一条记录）"
                      >
                        {armRestore === rev.id ? "再点一次就退回" : "回到这一版"}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy === rev.id}
                      onClick={() => void remove(rev)}
                      className="rounded-[6px] border px-2 py-0.5 text-[12px] disabled:opacity-50"
                      style={{
                        borderColor: armDelete === rev.id ? "var(--color-err)" : "var(--color-border)",
                        color: "var(--color-err)",
                      }}
                      title="删掉这条历史（不改当前配置）"
                    >
                      {armDelete === rev.id ? "再点一次就删除" : "删除"}
                    </button>
                  </div>
                </div>

                {/* ── 展开：差异 ── */}
                {expanded && (
                  <div className="mt-2 rounded-[8px] p-2.5" style={{ background: "var(--color-surface-2)" }}>
                    <div className="mb-2 flex flex-wrap items-center gap-1.5">
                      <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                        对比
                      </span>
                      <Seg active={against === "prev"} onClick={() => switchAgainst("prev")} label="上一版" title="和上一版比（默认）" />
                      <Seg active={against === "current"} onClick={() => switchAgainst("current")} label="当前" title="和现在的配置比" />
                      <span className="ml-auto text-[12px]" style={{ color: "var(--color-muted)" }}>
                        {diff?.summary || ""}
                      </span>
                    </div>

                    {diff?.loading ? (
                      <div className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                        读取差异…
                      </div>
                    ) : !diff || diff.rows.length === 0 ? (
                      <div className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                        这一版和{diff?.againstLabel || "对照版"}内容一致（没有字段级差异）。
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {diff.rows.map((r, i) => {
                          const k = `${rev.id}:${i}`;
                          const long = r.before.length > 240 || r.after.length > 240;
                          const showFull = fullKey === k;
                          return (
                            <div key={k} className="rounded-[7px] border p-2" style={{ borderColor: "var(--color-border)" }}>
                              <div className="mb-1 flex flex-wrap items-center gap-2">
                                <span className="text-[12px] font-medium">{r.label}</span>
                                {r.added?.length ? (
                                  <span className="text-[12px]" style={{ color: "var(--color-ok)" }}>
                                    +{r.added.join("、")}
                                  </span>
                                ) : null}
                                {r.removed?.length ? (
                                  <span className="text-[12px]" style={{ color: "var(--color-err)" }}>
                                    −{r.removed.join("、")}
                                  </span>
                                ) : null}
                                {long && (
                                  <button
                                    type="button"
                                    className="ml-auto text-[12px] underline"
                                    style={{ color: "var(--color-muted)" }}
                                    onClick={() => setFullKey(showFull ? null : k)}
                                  >
                                    {showFull ? "收起全文" : "看全文"}
                                  </button>
                                )}
                              </div>
                              <div className="grid gap-1.5 md:grid-cols-2">
                                <Value label={diff.againstLabel || "旧"} text={showFull ? r.before : clip(r.before)} muted />
                                <Value label={`v${rev.version}`} text={showFull ? r.after : clip(r.after)} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
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

function Seg({ active, onClick, label, title }: { active: boolean; onClick: () => void; label: string; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="rounded-[6px] border px-2 py-0.5 text-[12px] transition-colors"
      style={{
        borderColor: active ? "var(--color-accent)" : "var(--color-border)",
        color: active ? "var(--color-accent)" : "var(--color-muted)",
        background: active ? "color-mix(in srgb, var(--color-accent) 10%, transparent)" : undefined,
      }}
    >
      {label}
    </button>
  );
}

function Value({ label, text, muted }: { label: string; text: string; muted?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px]" style={{ color: "var(--color-muted)" }}>
        {label}
      </div>
      <div
        className="mono whitespace-pre-wrap break-words rounded-[6px] px-1.5 py-1 text-[12px]"
        style={{ background: "var(--color-surface)", color: muted ? "var(--color-muted)" : "var(--color-text)" }}
      >
        {text}
      </div>
    </div>
  );
}
