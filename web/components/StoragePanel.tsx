"use client";

/**
 * 存储体检 —— 「事件表在长，但长成什么样、要不要整理」得看得见。
 *
 * 为什么要有这块
 * ------------
 * 一次执行大约写 390 行事件，其中 98% 是模型吐字的碎片（逐字片段）。
 * 不整理，库就只增不减：备份越来越慢、老记录回放越来越卡。
 * 但"整理"这件事如果不给数字，用户既不知道有没有用、也不敢点 ——
 * 所以这里把**整理前后的行数与占用**直接摆出来，并说清归档会失去什么。
 *
 * 归档的语义（界面必须说清，不能让用户以为数据没了）：
 *   7 天以内的执行：一行不动；更早的：逐字片段折叠成一条"归档行"、超大结果截断。
 *   **最终产出、结论、轮次、工具调用、耗时都还在**，丢的只是"逐字过程"。
 */

import { useCallback, useEffect, useState } from "react";

import { api, fmt } from "@/lib/api";
import { useFeedback } from "@/components/ui/feedback";

type Storage = {
  event_rows: number;
  stream_rows: number;
  event_payload_bytes: number;
  runs: number;
  runs_archived: number;
  last_archived_at?: number | null;
  last_auto_run_at?: number | null;
  keep_days: number;
  preview_bytes: number;
  enabled: boolean;
  db_bytes?: number | null;
};

function bytes(n?: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function StoragePanel() {
  const fb = useFeedback();
  const [data, setData] = useState<Storage | null>(null);
  const [loading, setLoading] = useState(true);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.storage());
    } catch (e) {
      fb.error("读取存储信息失败", e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
  }, [load]);

  const compact = async () => {
    if (!armed) {
      setArmed(true); // 两步确认（不弹原生 confirm）
      setTimeout(() => setArmed(false), 5000);
      return;
    }
    setArmed(false);
    setBusy(true);
    try {
      const res = (await api.compactEvents()) as {
        ok: boolean;
        runs_archived?: number;
        rows_removed?: number;
        bytes_before?: number;
        bytes_after?: number;
        reason?: string;
      };
      if (!res.ok) {
        fb.error("没有整理", res.reason || "自动归档已关闭");
      } else if (!res.runs_archived) {
        fb.success("没有需要整理的记录", `${data?.keep_days ?? 7} 天以内的一行都没动`);
      } else {
        const saved = Math.max((res.bytes_before ?? 0) - (res.bytes_after ?? 0), 0);
        fb.success(
          `整理完成：${res.runs_archived} 条老记录`,
          `折叠 ${res.rows_removed ?? 0} 行逐字片段，明细省下 ${bytes(saved)}`,
        );
      }
      await load();
    } catch (e) {
      fb.error("整理失败", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card p-4">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[14px] font-medium">存储</h2>
        <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
          事件会随执行累积；自动整理每小时最多跑一次，也可手动
        </span>
      </div>

      {loading && !data ? (
        <div className="text-[12.5px]" style={{ color: "var(--color-muted)" }}>
          读取中…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12.5px] sm:grid-cols-3">
            <div>
              <span style={{ color: "var(--color-muted)" }}>库文件</span>{" "}
              <span className="mono">{bytes(data?.db_bytes)}</span>
            </div>
            <div>
              <span style={{ color: "var(--color-muted)" }}>事件行数</span>{" "}
              <span className="mono">{fmt.int(data?.event_rows ?? 0)}</span>
            </div>
            <div>
              <span style={{ color: "var(--color-muted)" }}>其中逐字片段</span>{" "}
              <span className="mono">{fmt.int(data?.stream_rows ?? 0)}</span>
            </div>
            <div>
              <span style={{ color: "var(--color-muted)" }}>事件明细占用</span>{" "}
              <span className="mono">{bytes(data?.event_payload_bytes)}</span>
            </div>
            <div>
              <span style={{ color: "var(--color-muted)" }}>已归档的执行</span>{" "}
              <span className="mono">
                {fmt.int(data?.runs_archived ?? 0)} / {fmt.int(data?.runs ?? 0)}
              </span>
            </div>
            <div>
              <span style={{ color: "var(--color-muted)" }}>上次整理</span>{" "}
              {data?.last_archived_at ? fmt.time(data.last_archived_at) : "还没整理过"}
            </div>
          </div>

          <p className="mt-2.5 text-[12px]" style={{ color: "var(--color-muted)" }}>
            规则：最近 <b>{data?.keep_days ?? 7} 天</b>
            的执行一行不动；更早的只把「逐字片段」折叠成一条归档行、超大工具结果截断到{" "}
            {bytes(data?.preview_bytes)}。
            <b style={{ color: "var(--color-text)" }}>
              最终产出、结论、轮次、工具调用、耗时都还在
            </b>
            ，丢掉的只是逐字过程。
          </p>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void compact()}
              className="rounded-[8px] border px-3 py-1.5 text-[12.5px] disabled:opacity-50"
              style={{
                borderColor: armed ? "var(--color-err)" : "var(--color-border)",
                color: armed ? "var(--color-err)" : undefined,
              }}
            >
              {busy ? "整理中…" : armed ? "再点一次就开始整理" : "立即整理一次"}
            </button>
            <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
              {armed ? "只影响老记录，7 天内的不动" : "不影响正在跑的执行"}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
