"use client";

/**
 * 「模型请求」区块 —— 每次模型调用的元数据表 + 按需看**完整请求/响应原文**。
 *
 * 为什么要抽成共享组件：记录页有两处渲染同一个东西（管理页的就地展开、执行页
 * 点 run 号弹的详情），各写一份必然走样（第一版就只加在了弹窗里 —— 用户在
 * 管理页点开记录**看不到**，等于没做）。
 *
 * 两处口径：
 *   · 列表只带元数据（次数/模型/延迟/tokens），**原文按需拉** —— 一次 ReAct
 *     循环的请求动辄几十 KB，全带上会让"看记录"变慢；
 *   · 没有原文的老数据显示「—」而不是给个点了必然空的入口。
 *
 * 移动端：7 列数字表在 390px 上只能横着滚（等于看不了）→ <1024px 换成
 * 「一行一次调用」的卡片：模型与状态一行，首字/耗时/tokens 折到第二行，
 * 「看原文」独占一行走 .btn（≤767px 44px / ≤1023px 36px 的点按区）。
 */

import React from "react";

import { api, fmt } from "@/lib/api";
import type { LlmCall, LlmCallPayload, ModelTestRecord } from "@/lib/types";
import { JsonBlock } from "@/components/DataBlocks";

const STATUS_COLOR: Record<string, string> = {
  ok: "var(--color-ok)",
  error: "var(--color-err)",
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

  if (err) {
    return (
      <p className="text-[12px]" style={{ color: "var(--color-err)" }}>
        原文读取失败：{err}
      </p>
    );
  }
  if (!data) {
    return (
      <p className="text-[12px]" style={{ color: "var(--color-muted)" }}>
        正在读原文…
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {data.truncated ? (
        <p className="text-[12px]" style={{ color: "var(--color-muted)" }}>
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
            className="whitespace-pre-wrap break-all rounded-md p-2 text-[12px]"
            style={{ background: "var(--color-surface-2)", color: "var(--color-err)" }}
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
        <span className="text-[12px] font-medium" style={{ color: "var(--color-muted)" }}>
          {title ?? `模型请求（${calls.length} 次）`}
        </span>
      </div>

      {/* 桌面（≥1024）：表格，数值成列好对比 */}
      <div className="hidden overflow-x-auto px-2.5 py-2 lg:block">
        <table className="w-full text-[12px]">
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
                  <td className="py-1" style={{ color: "var(--color-muted)" }}>
                    {c.iteration}
                  </td>
                  <td className="py-1 mono">{c.model ?? "—"}</td>
                  <td className="py-1 text-right">{fmt.ms(c.ttft_ms)}</td>
                  <td className="py-1 text-right">{fmt.ms(c.duration_ms)}</td>
                  <td className="py-1 text-right">
                    {c.tokens_in}/{c.tokens_out}
                  </td>
                  <td className="py-1 pl-3 mono" style={{ color: STATUS_COLOR[c.status] ?? "" }}>
                    {c.status}
                  </td>
                  <td className="py-1 text-right">
                    {c.has_payload ? (
                      <button
                        type="button"
                        data-tap
                        className="rounded px-1.5 text-[11px]"
                        style={{ color: "var(--color-accent)" }}
                        onClick={() => setOpenCall((cur) => (cur === c.id ? null : c.id))}
                      >
                        {openCall === c.id ? "收起" : "看原文"}
                      </button>
                    ) : (
                      <span
                        className="text-[11px]"
                        style={{ color: "var(--color-muted)" }}
                        title="这条执行早于「原文记录」上线（2026-09-28 06:08 起留存），没有存过原文"
                      >
                        —
                      </span>
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

      {/* 手机/平板（<1024）：一行一次调用，数值折到第二行，按钮独占一行给足点按区 */}
      <div className="space-y-1.5 px-2.5 py-2 lg:hidden">
        {calls.map((c) => (
          <div
            key={c.id}
            className="rounded-[8px] border px-2.5 py-2"
            style={{ borderColor: "var(--color-border)", background: "var(--color-surface-2)" }}
          >
            <div className="flex items-center gap-2">
              <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                #{c.iteration}
              </span>
              <span className="mono truncate text-[12px]">{c.model ?? "—"}</span>
              <span
                className="ml-auto mono text-[12px]"
                style={{ color: STATUS_COLOR[c.status] ?? "" }}
              >
                {c.status}
              </span>
            </div>
            <div
              className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px]"
              style={{ color: "var(--color-muted)" }}
            >
              <span>首字 {fmt.ms(c.ttft_ms)}</span>
              <span>耗时 {fmt.ms(c.duration_ms)}</span>
              <span>
                tokens {c.tokens_in}/{c.tokens_out}
              </span>
            </div>
            {c.has_payload ? (
              <button
                type="button"
                className="btn mt-1.5 w-full"
                onClick={() => setOpenCall((cur) => (cur === c.id ? null : c.id))}
              >
                {openCall === c.id ? "收起原文" : "看原文"}
              </button>
            ) : (
              <p className="mt-1 text-[12px]" style={{ color: "var(--color-muted)" }}>
                这次调用早于「原文记录」上线（09-28 06:08 起留存），没有存过原文
              </p>
            )}
            {openCall === c.id ? (
              <div className="mt-2">
                <LlmCallPayloadView runId={runId} callId={c.id} />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 「LLM 配置」里那次对话测试的详情：对话 + **完整请求与原始响应**。
 *
 * 为什么单独做：对话测试不经过助手（没有模型调用中间件），它的原文存在
 * ``model_test`` 表里、由 `/api/runs/model-tests/{id}/payload` 解出来。
 * 以前这里只有一句"没有执行过程可看"—— 用户要的恰恰是"每次原始的请求和响应"。
 */
export function ModelTestDetail({ testId, hasPayload }: { testId: string; hasPayload?: boolean | null }) {
  const [rec, setRec] = React.useState<ModelTestRecord | null>(null);
  const [raw, setRaw] = React.useState<LlmCallPayload | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [showRaw, setShowRaw] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const got = await api.modelTest(testId);
        if (alive) setRec(got);
        if (hasPayload !== false) {
          const payload = await api.modelTestPayload(testId).catch(() => null);
          if (alive) setRaw(payload);
        }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [testId, hasPayload]);

  if (err) {
    return (
      <p className="text-[12px]" style={{ color: "var(--color-err)" }}>
        记录读取失败：{err}
      </p>
    );
  }
  if (!rec) {
    return (
      <p className="text-[12px]" style={{ color: "var(--color-muted)" }}>
        正在读取…
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {/* 对话：人看得懂的部分 */}
      <div className="space-y-1">
        {rec.messages.map((m, i) => (
          <div key={i} className="flex gap-2 text-[12px]">
            <span className="shrink-0" style={{ color: "var(--color-muted)", minWidth: 44 }}>
              {m.role === "user" ? "我" : m.role}
            </span>
            <span className="break-all whitespace-pre-wrap">{m.content}</span>
          </div>
        ))}
        {rec.reply ? (
          <div className="flex gap-2 text-[12px]">
            <span className="shrink-0" style={{ color: "var(--color-muted)", minWidth: 44 }}>
              模型
            </span>
            <span className="break-all whitespace-pre-wrap">{rec.reply}</span>
          </div>
        ) : null}
        {rec.error ? (
          <p className="text-[12px]" style={{ color: "var(--color-err)" }}>
            报错：{rec.error}
          </p>
        ) : null}
      </div>

      {/* 原文：排障要看的部分（默认收起，点了才展开 —— 内容可能几十 KB） */}
      {raw ? (
        <div>
          <button type="button" className="btn w-full" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? "收起原始请求/响应" : "看原始请求与响应"}
          </button>
          {showRaw ? (
            <div className="mt-2 space-y-2">
              {raw.truncated ? (
                <p className="text-[12px]" style={{ color: "var(--color-muted)" }}>
                  体积超过上限，只保留了前段。
                </p>
              ) : null}
              <div>
                <p className="mb-1 text-[12px] font-medium">发给模型的请求</p>
                <JsonBlock code={JSON.stringify(raw.request ?? {}, null, 1)} />
              </div>
              <div>
                <p className="mb-1 text-[12px] font-medium">模型返回（原始）</p>
                <JsonBlock code={JSON.stringify(raw.response ?? {}, null, 1)} />
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-[12px]" style={{ color: "var(--color-muted)" }}>
          这条测试早于「原文记录」上线（2026-09-28 06:08 起才开始留存），只能在上面看到当时的对话。
        </p>
      )}
    </div>
  );
}
