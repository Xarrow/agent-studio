"use client";

/**
 * 「对外接入 · AG-UI」 —— 把平台暴露成 AG-UI 协议端点，任何 AG-UI 客户端都能驱动这些助手。
 *
 * 为什么单列一块：
 *   · 用户会问"支持 AG-UI 吗"——答案应该在界面上看得见，而不是只存在于代码里；
 *   · 协议接入方需要三样东西：**端点、协议版本、用哪个助手**，外加一段能直接粘贴的示例。
 *
 * 口径：只读展示（改配置没有意义，端点固定）。示例里带真实助手 id，复制即可跑。
 */

import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import { useFeedback } from "@/components/ui/feedback";

type AguiInfo = {
  protocol: string;
  version: string;
  endpoint: string;
  agents: { id: string; name: string; description: string }[];
  notes: string;
  example: Record<string, unknown>;
};

export function AguiCard() {
  const fb = useFeedback();
  const [info, setInfo] = useState<AguiInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const got = (await api.aguiInfo()) as unknown as AguiInfo;
        if (alive) setInfo(got);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const curl = info
    ? `curl -N -X POST http://192.168.2.11:8848${info.endpoint} \\\n` +
      `  -H 'Content-Type: application/json' \\\n` +
      `  -d '${JSON.stringify(info.example)}'`
    : "";

  return (
    <div className="space-y-2">
      {err ? (
        <p className="text-[12.5px]" style={{ color: "var(--color-muted)" }}>
          读取失败：{err}
        </p>
      ) : !info ? (
        <p className="text-[12.5px]" style={{ color: "var(--color-muted)" }}>
          读取中…
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="rounded px-1.5 py-0.5 text-[11px]"
              style={{
                background: "color-mix(in srgb, var(--color-ok) 14%, transparent)",
                color: "var(--color-ok)",
              }}
            >
              已启用
            </span>
            <span className="mono text-[12.5px]">POST {info.endpoint}</span>
            <span className="text-[12px]" style={{ color: "var(--color-muted)" }}>
              ag-ui v{info.version} · SSE 传输 · 可用助手 {info.agents.length} 个
            </span>
          </div>
          <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--color-muted)" }}>
            {info.notes}
          </p>
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[12px] font-medium">调用示例</span>
              <button
                type="button"
                data-tap
                className="rounded px-1.5 text-[11px]"
                style={{ color: "var(--color-accent)" }}
                onClick={() => {
                  void navigator.clipboard?.writeText(curl);
                  fb.success("已复制示例");
                }}
              >
                复制
              </button>
            </div>
            <pre
              className="mono overflow-x-auto whitespace-pre-wrap break-all rounded p-2 text-[12px] leading-relaxed"
              style={{ background: "var(--color-surface-2)", color: "var(--color-muted)" }}
            >
              {curl}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}
