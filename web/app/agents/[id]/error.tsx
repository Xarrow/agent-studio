"use client";

/**
 * 助手详情的错误边界。
 *
 * 为什么需要它：之前这个路由一旦出错，用户看到的只有 Next 内置的
 * "This page couldn't load / Reload to try again" —— 没有原因、没有上下文、
 * 也没法把问题反馈出来。出错时至少要说清"哪里断了"，并给一条能走的路。
 */

import { useEffect } from "react";

export default function AgentDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 控制台留一份完整堆栈，方便排查
    console.error("[agent-detail] 渲染出错:", error);
  }, [error]);

  return (
    <div className="p-4 md:p-6 lg:p-7 max-w-2xl">
      <div className="card p-5">
        <h1 className="text-[16px] font-medium mb-2">这个页面没能加载出来</h1>
        <p className="text-[13px] text-[var(--color-muted)] mb-3">
          助手配置页在渲染时出错了。下面是可以带走排查的信息：
        </p>
        <pre className="rounded-md p-3 bg-[var(--color-surface-2)] text-[11.5px] whitespace-pre-wrap break-all mb-4">
          {error.message || String(error)}
          {error.digest ? `\n\ndigest: ${error.digest}` : ""}
        </pre>
        <div className="flex items-center gap-2 flex-wrap">
          <button className="btn btn-primary" onClick={reset}>
            重试
          </button>
          <button className="btn" onClick={() => window.location.reload()}>
            重新加载页面
          </button>
          <a className="text-[12px] text-[var(--color-accent)]" href="/agents">
            返回助手列表 →
          </a>
        </div>
      </div>
    </div>
  );
}
