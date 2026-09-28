"use client";

/**
 * 「模型请求」区块 —— 每次模型调用的元数据表 + 按需看**完整请求/响应原文**。
 *
 * 为什么要抽成共享组件：记录页有两处渲染同一个东西（管理页的就地展开、执行页
 * 点 run 号弹的详情），各写一份必然走样（第一版就只加在了弹窗里 —— 用户在
 * 管理页点开记录**看不到**，等于没做）。
 *
 * 两个口径：
 *   · 列表只带元数据（次数/模型/延迟/tokens），**原文按需拉** —— 一次 ReAct
 *     循环的请求动辄几十 KB，全带上会让"看记录"变慢；
 *   · 没有原文的老数据显示「—」而不是给个点了必然空的入口。
 */

import React from "react";

import { api, fmt } from "@/lib/api";
import type { LlmCall, LlmCallPayload } from "@/lib/types";
import { JsonBlock } from "@/components/DataBlocks";

const STATUS_COLOR: Record<string, string> = {
  ok: "var(--color-ok)",
  error: "var(--color-danger)",
};

/** 一次模型调用的完整请求与响应（按需拉取 + 折叠展示） */
export function LlmCallPayloadView({ runId, callId }: { runId: string; callId: number }) {
  const [data, setData] = React.useState<LlmCallPayload | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const got = await api.llmCallPayload(runId, callId);
        if (alive) setData(got);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [runId, callId]);

  if (err) return <p className="text-[12px]" style={{ color: "var(--color-danger)" }}>原文读取失败：{err}</p>;
  if (!data) return <p className="text-[12px]" style={{ color: "var(--color-muted)" }}>正在读原文…</p>;

  return (
    <div className="space-y-2">
      {data.truncated ? (
        <p className="text-[11.5px]" style={{ color: "var(--color-muted)" }}>
          体积超过上限，下面只保留了前段（完整内容没有被保存）。
        </p>
      ) : null}
      <div>
        <p className="mb-1 text-[12px] font-medium">
          发给模型的请求
          <span className="ml-2 font-normal" style={{ color: "var(--color-muted)" }}>
            {data.model ?? "—"} · 进 {data.tokens_in} tokens
            {data.tokens_cache_read ? `（命中缓存 ${data.tokens_cache_read}）` : ""}
          </span>
        </p>
        <JsonBlock code={JSON.stringify(data.request ?? {}, null, 1)} />
      </div>
      <div>
        <p className="mb-1 text-[12px] font-medium">
          模型返回
          <span className="ml-2 font-normal" style={{ color: "var(--color-muted)" }}>
            出 {data.tokens_out} tokens · {data.duration_ms ?? "—"}ms
          </span>
        </p>
        {data.error ? (
          <pre
            className="whitespace-pre-wrap rounded-md p-2 text-[11.5px]"
            style={{ background: "var(--color-surface-2)", color: "var(--color-danger)" }}
          >
            {data.error}
          </pre>
        ) : (
          <JsonBlock code={JSON.stringify(data.response ?? {}, null, 1)} />
        )}
      </div>
    </div>
  );
}

export function LlmCallsPanel({
  runId,
  calls,
  title,
}: {
  runId: string;
  calls?: LlmCall[] | null;
  /** 默认「模型请求（N 次）」 */
  title?: string;
}) {
  //: 一次只展开一条原文 —— 同时铺开几十 KB × N 没法看
  const [openCall, setOpenCall] = React.useState<number | null>(null);
  if (!calls || calls.length === 0) return null;

  return (
    <div
      className="rounded-[8px] border"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <div className="border-b px-2.5 py-1.5" style={{ borderColor: "var(--color-border)" }}>
        <span className="text-[11.5px] font-medium" style={{ color: "var(--color-muted)" }}>
          {title ?? `模型请求（${calls.length} 次）`}
        </span>
      </div>
      <div className="overflow-x-auto px-2.5 py-2">
        <table className="w-full min-w-[420px] text-[12px]">
          <thead style={{ color: "var(--color-muted)" }}>
            <tr>
              <th className="py-1 font-normal text-left">#</th>
              <th className="py-1 font-normal text-left">模型</th>
              <th className="py-1 font-normal text-right">首字</th>
              <th className="py-1 font-normal text-right">耗时</th>
              <th className="py-1 font-normal text-right">tokens</th>
              <th className="py-1 pl-3 font-normal text-left">状态</th>
              <th className="py-1 font-normal text-right">原文</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <React.Fragment key={c.id}>
                <tr className="border-t" style={{ borderColor: "var(--color-border)" }}>
                  <td className="py-1" style={{ color: "var(--color-muted)" }}>{c.iteration}</td>
                  <td className="py-1 mono">{c.model ?? "—"}</td>
                  <td className="py-1 text-right">{fmt.ms(c.ttft_ms)}</td>
                  <td className="py-1 text-right">{fmt.ms(c.duration_ms)}</td>
                  <td className="py-1 text-right">{c.tokens_in}/{c.tokens_out}</td>
                  <td
                    className="py-1 pl-3 mono"
                    style={{ color: STATUS_COLOR[c.status] ?? "" }}
                  >
                    {c.status}
                  </td>
                  <td className="py-1 text-right">
                    {c.has_payload ? (
                      <button
                        type="button"
                        className="min-h-[28px] rounded px-1.5 text-[11px]"
                        style={{ color: "var(--color-accent)" }}
                        onClick={() => setOpenCall((cur) => (cur === c.id ? null : c.id))}
                      >
                        {openCall === c.id ? "收起" : "看原文"}
                      </button>
                    ) : (
                      <span className="text-[11px]" style={{ color: "var(--color-muted)" }}>—</span>
                    )}
                  </td>
                </tr>
                {openCall === c.id ? (
                  <tr className="border-t" style={{ borderColor: "var(--color-border)" }}>
                    <td colSpan={7} className="py-2">
                      <LlmCallPayloadView runId={runId} callId={c.id} />
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
